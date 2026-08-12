// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #60 — S2 wake-coverage detector. The evidence victra required is INJECTED, not
 * harvested from history: we plant the S2 harm — an agent that drained before,
 * then mail piles up and it stops draining across two evaluations — and prove the
 * detector REPORTS it as UNCOVERED with the exact wording it would emit. (Once
 * #198 landed, conduit's message becomes deliverable and the only historical true
 * positive disappears; that is the fix working, and it is why the positive control
 * must be injected.) The other two verdicts and the anti-flap margin are
 * pinned alongside so the three-verdict distinction cannot silently collapse.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-wake-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;

const { getDb, registerAgent, closeDb } = await import("../src/db.js");
const { log } = await import("../src/logger.js");
const { classifyWakeCoverage, formatWakeCoverageFindings, startWakeCoverageSweep, wakeConfigFromEnv } =
  await import("../src/wake-coverage-detector.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(cleanup);
afterEach(cleanup);

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-08-12T00:00:00.000Z").getTime(); // fixed eval clock
const OPTS = { nowMs: NOW, boundMs: 24 * HOUR, antiFlapMarginMs: 24 * HOUR }; // effective threshold = 48h
const isoAgo = (h: number) => new Date(NOW - h * HOUR).toISOString();

/** Plant a pending-global message (never observed) with an explicit created_at. */
function seedPending(to: string, id: string, hoursAgo: number): void {
  getDb()
    .prepare(
      "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, 'x', ?, 'm', 'normal', 'pending', ?)",
    )
    .run(id, to, isoAgo(hoursAgo));
}
/** Plant an observed-drain event (what get_messages emits) at an explicit time. */
function seedDrain(agent: string, hoursAgo: number): void {
  getDb()
    .prepare(
      "INSERT INTO inbox_events (agent_name, reason, created_at, source_pid) VALUES (?, 'message_read', ?, 1)",
    )
    .run(agent, isoAgo(hoursAgo));
}

describe("#60 — wake-coverage detector: injected S2 harm + three verdicts + anti-flap margin", () => {
  it("INJECTED POSITIVE CONTROL: an agent that drained before and then went dark past the effective threshold reports UNCOVERED, with the exact wording", () => {
    registerAgent("regressed", "r", []);
    seedDrain("regressed", 72); // was being woken 3 days ago
    seedPending("regressed", "stuck-1", 50); // 50h > 48h fire threshold, no drain since

    const findings = classifyWakeCoverage(getDb(), OPTS);
    const f = findings.find((x) => x.agent === "regressed");
    expect(f, "the injected S2 harm must be detected").toBeTruthy();
    expect(f!.verdict).toBe("uncovered");
    expect(f!.pendingCount).toBe(1);

    const [line] = formatWakeCoverageFindings([f!]);
    expect(line).toContain("[wake-coverage] UNCOVERED — regressed");
    expect(line).toContain("has drained before");
    expect(line).toMatch(/first check whether regressed has drained anything since, then check its wake path/);
  });

  it("UNOBSERVABLE: an agent that has NEVER drained is reported unobservable, NEVER uncovered, and the line names why", () => {
    registerAgent("muted", "r", []);
    // No drain events ever — drains out-of-band (like the orchestrator).
    seedPending("muted", "stuck-2", 50);

    const findings = classifyWakeCoverage(getDb(), OPTS);
    const f = findings.find((x) => x.agent === "muted");
    expect(f!.verdict).toBe("unobservable");
    expect(f!.verdict).not.toBe("uncovered");

    const [line] = formatWakeCoverageFindings([f!]);
    expect(line).toContain("[wake-coverage] UNOBSERVABLE — muted");
    expect(line).toContain("has never emitted a drain event");
    expect(line).toContain("does NOT"); // explicitly not rendered as uncovered
    // The two verdicts must never render the same way.
    expect(line).not.toContain("UNCOVERED");
  });

  it("COVERED: an agent that drained SINCE the stuck mail arrived is NOT reported (awake; the sitting message is a routing question)", () => {
    registerAgent("awake", "r", []);
    seedPending("awake", "stuck-3", 50);
    seedDrain("awake", 10); // drained 10h ago — after the mail arrived

    const findings = classifyWakeCoverage(getDb(), OPTS);
    expect(findings.find((x) => x.agent === "awake")).toBeUndefined();
  });

  it("ANTI-FLAP MARGIN: mail past the 24h bound but NOT past the effective threshold (bound+margin=48h) does not fire yet", () => {
    registerAgent("slow", "r", []);
    seedDrain("slow", 72);
    seedPending("slow", "stuck-4", 30); // 30h: past the 24h bound, under the 48h effective threshold

    const findings = classifyWakeCoverage(getDb(), OPTS);
    expect(findings.find((x) => x.agent === "slow"), "must not fire before it crosses the effective threshold (bound + anti-flap margin)").toBeUndefined();

    // ...and once it crosses the 48h effective threshold it fires (same agent, aged the message).
    getDb().prepare("UPDATE messages SET created_at = ? WHERE id = 'stuck-4'").run(isoAgo(50));
    const after = classifyWakeCoverage(getDb(), OPTS);
    expect(after.find((x) => x.agent === "slow")?.verdict).toBe("uncovered");
  });

  it("a resolved or drained message is not pending-global, so it never fires (SSOT predicate)", () => {
    registerAgent("clean", "r", []);
    seedDrain("clean", 72);
    seedPending("clean", "stuck-5", 50);
    // Mark it read by a session AND resolved → leaves pending-global.
    getDb().prepare("UPDATE messages SET read_by_session = 's', resolved_at = ? WHERE id = 'stuck-5'").run(isoAgo(1));

    const findings = classifyWakeCoverage(getDb(), OPTS);
    expect(findings.find((x) => x.agent === "clean")).toBeUndefined();
  });
});

describe("#60 — detector wiring + lifecycle", () => {
  const WAKE_ENV = ["RELAY_WAKE_DETECTOR", "RELAY_WAKE_DETECTOR_INTERVAL_MS", "RELAY_WAKE_BOUND_MS", "RELAY_WAKE_ANTI_FLAP_MARGIN_MS"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => WAKE_ENV.forEach((k) => (saved[k] = process.env[k])));
  afterEach(() => WAKE_ENV.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]!))));

  it("wakeConfigFromEnv: DEFAULT-ON; RELAY_WAKE_DETECTOR=0 disables; knobs parse with defaults", () => {
    delete process.env.RELAY_WAKE_DETECTOR;
    expect(wakeConfigFromEnv().enabled).toBe(true); // default-on, not opt-in
    process.env.RELAY_WAKE_DETECTOR = "0";
    expect(wakeConfigFromEnv().enabled).toBe(false);

    process.env.RELAY_WAKE_DETECTOR = "1";
    process.env.RELAY_WAKE_DETECTOR_INTERVAL_MS = "5000";
    process.env.RELAY_WAKE_BOUND_MS = "1000";
    process.env.RELAY_WAKE_ANTI_FLAP_MARGIN_MS = "2000";
    expect(wakeConfigFromEnv()).toMatchObject({ enabled: true, intervalMs: 5000, boundMs: 1000, antiFlapMarginMs: 2000 });
  });

  it("disabled → schedules NO timer and stop() is a safe no-op", () => {
    process.env.RELAY_WAKE_DETECTOR = "0";
    let scheduled = 0;
    const scheduler = { setInterval: () => { scheduled++; return { stop: () => {} }; } };
    const handle = startWakeCoverageSweep(getDb(), { scheduler });
    expect(scheduled).toBe(0);
    expect(() => handle.stop()).not.toThrow();
  });

  it("enabled → schedules exactly one interval at the configured cadence, runs a sweep IMMEDIATELY, and stop() clears it", () => {
    delete process.env.RELAY_WAKE_DETECTOR; // default-on
    process.env.RELAY_WAKE_DETECTOR_INTERVAL_MS = "12345";
    // A standing UNCOVERED regression at the fixed eval clock.
    registerAgent("regressed", "r", []);
    seedDrain("regressed", 72);
    seedPending("regressed", "stuck-x", 50);

    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    let calls = 0, capturedMs = -1, stopped = false;
    const scheduler = {
      setInterval: (_cb: () => void, ms: number) => { calls++; capturedMs = ms; return { stop: () => { stopped = true; } }; },
    };
    const handle = startWakeCoverageSweep(getDb(), { scheduler, now: () => NOW });

    expect(calls).toBe(1); // exactly one timer
    expect(capturedMs).toBe(12345); // at the configured cadence
    // the IMMEDIATE startup sweep emitted the standing regression (not one interval later)
    const emitted = warnSpy.mock.calls.flat().map(String).join("\n");
    expect(emitted).toContain("[wake-coverage] UNCOVERED — regressed");

    handle.stop();
    expect(stopped).toBe(true);
    warnSpy.mockRestore();
  });
});
