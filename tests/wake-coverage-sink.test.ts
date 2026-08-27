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

describe("ADR-0026 item 1 — wake-coverage findings reach a durable, fail-independent sink", () => {
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
    const status = { generatedAt: new Date(NOW).toISOString(), thresholdMs: 1, uncoveredCount: 0, findings: [] };
    // This is the structural stop for the mistake that poisoned the live sink — a convention you
    // must remember is a bug (victra). Under vitest, the default path is refused, loudly.
    expect(() => writeWakeCoverageStatus(defaultWakeCoverageStatusPath(), status as StatusArg as never)).toThrow(
      /DEFAULT live status path/,
    );
  });

  it("STALE reader: the exact poison shape (15-day-old generatedAt + fictional uncovered) reads UNKNOWN, NOT a live alert", () => {
    const ancient = {
      generatedAt: "2026-08-12T00:00:00.000Z",
      thresholdMs: 172_800_000,
      uncoveredCount: 1,
      findings: [{ agent: "regressed", verdict: "uncovered" }],
    };
    const nowLater = Date.parse("2026-08-27T00:00:00.000Z"); // 15 days after generatedAt
    const line = formatWakeCoverageStatusLine(ancient as StatusArg, nowLater, 3 * HOUR);
    expect(line).toMatch(/UNKNOWN|STALE/);
    expect(line, "a stale/poisoned finding must NOT be presented as a live alert").not.toMatch(/regressed/);
  });

  it("FRESH reader: a FRESH uncovered finding IS surfaced loudly (the reader isn't just always-UNKNOWN)", () => {
    const fresh = {
      generatedAt: new Date(NOW).toISOString(),
      thresholdMs: 172_800_000,
      uncoveredCount: 1,
      findings: [{ agent: "realagent", verdict: "uncovered" }],
    };
    const line = formatWakeCoverageStatusLine(fresh as StatusArg, NOW + 60_000, 3 * HOUR); // 1 min old = fresh
    expect(line).toMatch(/UNCOVERED/);
    expect(line).toMatch(/realagent/);
  });

  it("MISSING reader: null status → UNKNOWN, never healthy (silence-as-failure)", () => {
    expect(formatWakeCoverageStatusLine(null, NOW, 3 * HOUR)).toMatch(/UNKNOWN/);
  });
});
