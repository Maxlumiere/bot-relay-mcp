// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0026 item 1 — SINK REROUTE. The wake-coverage detector has computed correct
 * findings for weeks but emitted them ONLY to daemon stderr (/tmp/relay-3777.log) —
 * a TRACE that fails WITH the daemon and that no consumer reads. The fix reroutes the
 * findings to a DURABLE status file that fails INDEPENDENTLY of the wake path it watches.
 *
 * These two tests RED on current code (no status file is ever written), which is the
 * whole point: a check that could not fail is why this survived. The second is the
 * MANDATORY silence-the-sink test — silence the stderr trace, prove the finding still
 * reaches a consumer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-wake-sink-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
// MANDATORY (ADR-0026 seq 925): point the sink at a TMP path so a test NEVER writes the live
// default (~/.bot-relay/wake-coverage-status.json). The env seam is the make-impossible; the
// writeWakeCoverageStatus guard hard-errors if any test still resolves the default under vitest.
process.env.RELAY_WAKE_COVERAGE_STATUS_PATH = path.join(TEST_DB_DIR, "wake-coverage-status.json");
delete process.env.RELAY_AGENT_TOKEN;

const { getDb, registerAgent, closeDb } = await import("../src/db.js");
const { log } = await import("../src/logger.js");
const {
  runWakeCoverageSweep,
  writeWakeCoverageStatus,
  readWakeCoverageStatus,
  defaultWakeCoverageStatusPath,
  formatWakeCoverageStatusLine,
} = await import("../src/wake-coverage-detector.js");

interface WakeStatus {
  generatedAt: string;
  findings: Array<{ agent: string; verdict: string }>;
}
const readStatus = (p: string): WakeStatus => JSON.parse(fs.readFileSync(p, "utf-8")) as WakeStatus;

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(cleanup);
afterEach(cleanup);

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-08-12T00:00:00.000Z").getTime();
const isoAgo = (h: number) => new Date(NOW - h * HOUR).toISOString();
const OPTS = { nowMs: NOW, boundMs: 24 * HOUR, antiFlapMarginMs: 24 * HOUR }; // effective 48h

function seedUncovered(agent: string): void {
  registerAgent(agent, "r", []);
  getDb().prepare("UPDATE agents SET last_drain_at = ? WHERE name = ?").run(isoAgo(72), agent); // drained 3d ago
  getDb()
    .prepare(
      "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, 'x', ?, 'm', 'normal', 'pending', ?)",
    )
    .run("stuck-1", agent, isoAgo(50)); // 50h > 48h, no drain since → UNCOVERED
}

function seedUnobservable(agent: string): void {
  registerAgent(agent, "r", []);
  // NO drain marker → the detector cannot judge coverage → verdict "unobservable" (detector: lastDrainAt===null).
  getDb().prepare("UPDATE agents SET last_drain_at = NULL WHERE name = ?").run(agent);
  getDb()
    .prepare(
      "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, 'x', ?, 'm', 'normal', 'pending', ?)",
    )
    .run("stuck-unobs", agent, isoAgo(50)); // 50h > 48h stuck, no drain marker → UNOBSERVABLE
}

function seedCovered(agent: string): void {
  registerAgent(agent, "r", []);
  // Stuck mail (50h old) BUT drained SINCE it arrived (10h ago >= 50h ago) → the detector's
  // drainSinceArrival check EXCLUDES it from findings (COVERED — awake, a still-sitting message is a
  // routing question, not a wake one). This is the ONE verdict the writer never puts in findings.
  getDb().prepare("UPDATE agents SET last_drain_at = ? WHERE name = ?").run(isoAgo(10), agent);
  getDb()
    .prepare(
      "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, 'x', ?, 'm', 'normal', 'pending', ?)",
    )
    .run("stuck-cov", agent, isoAgo(50));
}

describe("ADR-0026 item 1 — wake-coverage findings reach a durable, fail-independent sink", () => {
  it("E2E writer→sink→formatter: a stuck agent with NO drain marker (UNOBSERVABLE) VALIDATES and reads UNKNOWN, never OK", () => {
    // codex #6: the SHIPPED writer emits this NORMAL state (no last_drain_at → 'unobservable'). Its own
    // output must pass validation (no over-strict false UNKNOWN) AND must not collapse into OK — the
    // founding defect of this PR was exactly UNOBSERVABLE being lost. Only an EMPTY findings list is healthy.
    seedUnobservable("cannot-judge");
    const statusPath = path.join(TEST_DB_DIR, "wake-coverage-status.json");
    runWakeCoverageSweep(getDb(), { ...OPTS, statusPath });
    const parsed = readWakeCoverageStatus(statusPath);
    expect(parsed, "the shipped writer's own output must pass isValidWakeCoverageStatus").not.toBeNull();
    const line = formatWakeCoverageStatusLine(parsed, NOW + 60_000, 3 * HOUR); // fresh read
    expect(line, "unjudgeable stuck mail is NOT checked-and-healthy").not.toMatch(/wake-coverage: OK/);
    expect(line).toMatch(/UNOBSERVABLE|UNKNOWN/);
    expect(line).toMatch(/cannot-judge/);
  });

  // ENUMERATION (victra): every verdict the writer can emit gets a defined display state AND an
  // end-to-end writer→sink→read→formatter test. classifyWakeCoverage emits exactly two into findings
  // (uncovered, unobservable); covered is excluded (continue at detector.ts:249). One e2e per verdict:
  //   uncovered   → UNCOVERED (alarm, named)       [this test]
  //   unobservable→ UNKNOWN (unjudgeable, named)    [the test above]
  //   covered     → excluded from findings → OK     [the test below]
  it("E2E writer→sink→read→formatter: an UNCOVERED agent VALIDATES and formats UNCOVERED, never OK/UNKNOWN (alarm path)", () => {
    // codex r5: the alarm path had only a writer→sink assertion, never a full read+format regression —
    // a future writer/wire drift could slip through unnoticed. This closes it end-to-end.
    seedUncovered("regressed-e2e");
    const statusPath = path.join(TEST_DB_DIR, "wake-coverage-status.json");
    runWakeCoverageSweep(getDb(), { ...OPTS, statusPath });
    const parsed = readWakeCoverageStatus(statusPath);
    expect(parsed, "the shipped writer's ALARM-path output must pass validation").not.toBeNull();
    const line = formatWakeCoverageStatusLine(parsed, NOW + 60_000, 3 * HOUR);
    expect(line).toMatch(/UNCOVERED/);
    expect(line).toMatch(/regressed-e2e/);
    expect(line).not.toMatch(/wake-coverage: OK/);
  });

  it("E2E writer→sink→read→formatter: a COVERED agent is EXCLUDED from findings → OK (the healthy path is writer-driven, not assumed)", () => {
    seedCovered("drained-since");
    const statusPath = path.join(TEST_DB_DIR, "wake-coverage-status.json");
    runWakeCoverageSweep(getDb(), { ...OPTS, statusPath });
    const parsed = readWakeCoverageStatus(statusPath);
    expect(parsed).not.toBeNull();
    expect(parsed!.findings.length, "a covered agent must never appear in findings").toBe(0);
    const line = formatWakeCoverageStatusLine(parsed, NOW + 60_000, 3 * HOUR);
    expect(line).toMatch(/wake-coverage: OK/);
    expect(line).not.toMatch(/UNKNOWN|UNCOVERED/);
  });

  it("WRITER normalizes thresholdMs to an integer — even FLOAT options cannot produce a record the strict reader rejects (make-impossible)", () => {
    // The env path parseInt's bound/margin (integers); a float is reachable only by a programmatic
    // caller of the exported sweep. The writer Math.round-normalizes, so the on-disk v:1 contract is
    // always integer and the strict reader never false-alarms on the writer's OWN output (victra 3rd option).
    seedUncovered("norm-agent");
    const statusPath = path.join(TEST_DB_DIR, "wake-coverage-status.json");
    runWakeCoverageSweep(getDb(), { nowMs: NOW, boundMs: 24 * HOUR + 0.5, antiFlapMarginMs: 24 * HOUR + 0.25, statusPath });
    const parsed = readWakeCoverageStatus(statusPath);
    expect(parsed, "the writer's output must ALWAYS validate, float options or not").not.toBeNull();
    expect(Number.isInteger(parsed!.thresholdMs), "on-disk thresholdMs must be an integer").toBe(true);
  });

  it("SINK: runWakeCoverageSweep writes the UNCOVERED finding to a durable status file a consumer can read", () => {
    seedUncovered("regressed");
    const statusPath = path.join(TEST_DB_DIR, "wake-coverage-status.json");
    runWakeCoverageSweep(getDb(), { ...OPTS, statusPath });
    expect(fs.existsSync(statusPath), "the sink must write a DURABLE file, not only stderr").toBe(true);
    const status = readStatus(statusPath);
    expect(status, "status file must be readable/parseable").toBeTruthy();
    expect(
      status!.findings.some((f) => f.agent === "regressed" && f.verdict === "uncovered"),
      "the UNCOVERED finding must be in the durable sink",
    ).toBe(true);
    expect(typeof status!.generatedAt).toBe("string");
  });

  it("SILENCE THE SINK (mandatory): with the stderr trace silenced, the finding STILL reaches the status file", () => {
    seedUncovered("regressed");
    const statusPath = path.join(TEST_DB_DIR, "wake-coverage-status.json");
    // Silence the log.warn TRACE entirely — the sink doctrine says the finding must
    // survive its trace going dark. A stderr-only design fails this by construction.
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      runWakeCoverageSweep(getDb(), { ...OPTS, statusPath });
    } finally {
      warnSpy.mockRestore();
    }
    expect(fs.existsSync(statusPath), "finding must reach a consumer even with the trace silenced").toBe(true);
    const status = readStatus(statusPath);
    expect(status!.findings.some((f) => f.agent === "regressed")).toBe(true);
  });
});

type StatusArg = Parameters<typeof formatWakeCoverageStatusLine>[0];

describe("ADR-0026 item 1 — poison prevention: default-path guard + staleness-enforcing reader", () => {
  it("GUARD (make-impossible, not a convention): writing the DEFAULT live path from a test harness HARD-ERRORS", () => {
    const status = { v: 1, generatedAt: new Date(NOW).toISOString(), thresholdMs: 1, findings: [] };
    // This is the structural stop for the mistake that poisoned the live sink — a convention you
    // must remember is a bug (victra). Under vitest, the default path is refused, loudly.
    expect(() => writeWakeCoverageStatus(defaultWakeCoverageStatusPath(), status as StatusArg as never)).toThrow(
      /DEFAULT live status path/,
    );
  });

  it("STALE reader: the exact poison shape (15-day-old generatedAt + fictional uncovered) reads UNKNOWN, NOT a live alert", () => {
    const ancient = {
      v: 1,
      generatedAt: "2026-08-12T00:00:00.000Z",
      thresholdMs: 172_800_000,
      findings: [{ agent: "regressed", verdict: "uncovered" }],
    };
    const nowLater = Date.parse("2026-08-27T00:00:00.000Z"); // 15 days after generatedAt
    const line = formatWakeCoverageStatusLine(ancient as StatusArg, nowLater, 3 * HOUR);
    expect(line).toMatch(/UNKNOWN|STALE/);
    expect(line, "a stale/poisoned finding must NOT be presented as a live alert").not.toMatch(/regressed/);
  });

  it("FRESH reader: a FRESH uncovered finding IS surfaced loudly (the reader isn't just always-UNKNOWN)", () => {
    const fresh = {
      v: 1,
      generatedAt: new Date(NOW).toISOString(),
      thresholdMs: 172_800_000,
      findings: [{ agent: "realagent", verdict: "uncovered" }],
    };
    const line = formatWakeCoverageStatusLine(fresh as StatusArg, NOW + 60_000, 3 * HOUR); // 1 min old = fresh
    expect(line).toMatch(/UNCOVERED/);
    expect(line).toMatch(/realagent/);
  });

  it("OK line carries a PRECISE age (as of Nm) — a bare/hour-rounded OK hides a sweep that has stopped", () => {
    // victra Q1 ruling: a sink that speaks only on failure is indistinguishable from a dead sink;
    // ALWAYS emit OK, and CARRY THE AGE so a drifting age (detector stopped but still 'OK') is
    // visible in the line, not buried in a log. Sub-hour granularity is the point — "0h ago"
    // hides a 4m vs 55m difference. RED on the pre-refinement hour-rounded line.
    const fresh = {
      v: 1,
      generatedAt: new Date(NOW).toISOString(),
      thresholdMs: 172_800_000,
      findings: [],
    };
    const line = formatWakeCoverageStatusLine(fresh as StatusArg, NOW + 2 * 60 * 1000, 3 * HOUR); // 2 min old
    expect(line).toMatch(/wake-coverage: OK/);
    expect(line, "the OK line must show a precise sub-hour age").toMatch(/as of 2m/);
  });

  it("MISSING reader: null status → UNKNOWN, never healthy (silence-as-failure)", () => {
    expect(formatWakeCoverageStatusLine(null, NOW, 3 * HOUR)).toMatch(/UNKNOWN/);
  });
});
