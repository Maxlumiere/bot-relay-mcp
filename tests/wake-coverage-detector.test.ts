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

const { getDb, registerAgent, sendMessage, getMessages, closeDb } = await import("../src/db.js");
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
/** Set the agent's DURABLE last-drain marker (what the detector reads — NOT the
 *  7-day inbox_events stream). The agent must already be registered so its row exists. */
function seedDrain(agent: string, hoursAgo: number): void {
  getDb().prepare("UPDATE agents SET last_drain_at = ? WHERE name = ?").run(isoAgo(hoursAgo), agent);
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
    // FINDING 2: render the EFFECTIVE threshold, never the bare word "bound".
    expect(line).toContain(">= 48.0h");
    expect(line).not.toContain(">= bound");
    expect(line).toMatch(/first check whether regressed has drained anything since, then check its wake path/);
  });

  it("FINDING 2: the rendered threshold is bound+margin (the value USED), never 'bound' or either input alone", () => {
    registerAgent("regressed2", "r", []);
    seedDrain("regressed2", 72);
    seedPending("regressed2", "stuck-f2", 20); // 20h > 15h effective (10+5)
    const customOpts = { nowMs: NOW, boundMs: 10 * HOUR, antiFlapMarginMs: 5 * HOUR }; // effective = 15h
    const f = classifyWakeCoverage(getDb(), customOpts).find((x) => x.agent === "regressed2");
    expect(f, "20h > 15h effective threshold").toBeTruthy();
    expect(f!.thresholdMs).toBe(15 * HOUR);
    const [line] = formatWakeCoverageFindings([f!]);
    expect(line).toContain(">= 15.0h"); // bound + margin, the value actually applied
    expect(line).not.toContain(">= bound"); // never the variable name
    expect(line).not.toContain(">= 10.0h"); // never the bound alone (what "bound" would have named)
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
    // FINDING 3: state what is KNOWN and OFFER causes NON-EXHAUSTIVELY; assert NEITHER a
    // behaviour NOR a closed dichotomy. A NULL marker has >= 3 causes (codex #202).
    expect(line).toContain("no MCP drain is recorded for this identity");
    expect(line).toContain("several causes"); // non-exhaustive signal, not "either X or Y"
    expect(line).toContain("reads out-of-band"); // cause 1 offered
    expect(line).toContain("re-created (unregister / reap)"); // cause 2 offered
    expect(line).toContain("predate the marker"); // cause 3 (migration-transitional) offered
    expect(line).not.toContain("has never drained via MCP"); // no behaviour asserted from a NULL marker
    // FINDING 2: render the EFFECTIVE threshold (48h), never the bare word "bound".
    expect(line).toContain(">= 48.0h");
    expect(line).not.toContain(">= bound");
    expect(line).toContain("does NOT"); // explicitly not rendered as uncovered
    // The two verdicts must never render the same way.
    expect(line).not.toContain("UNCOVERED");
  });

  it("FINDING 3 (codex #202): a pre-existing identity with EXPIRED history reads UNOBSERVABLE with the SAME non-exhaustive line — no false dichotomy", () => {
    // The migration-transitional cause: an identity already dark past inbox_events
    // retention when last_drain_at was introduced has no reconstructable drains and
    // stays NULL until its next drain. It is neither re-created nor necessarily
    // out-of-band, so a two-way "either/or" line would be false for it.
    registerAgent("legacy", "r", []);
    // NULL marker + NO inbox_events (expired history) — the migration case, seeded.
    seedPending("legacy", "stuck-legacy", 60);
    const f = classifyWakeCoverage(getDb(), OPTS).find((x) => x.agent === "legacy");
    expect(f!.verdict).toBe("unobservable");
    const [line] = formatWakeCoverageFindings([f!]);
    // The migration cause is offered, and the phrasing is non-exhaustive (so a fourth
    // cause would not reopen the defect) — it does NOT claim an exhaustive either/or.
    expect(line).toContain("predate the marker and could not be reconstructed from expired history");
    expect(line).toContain("several causes");
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

  it("DURABILITY (codex #200): a drained agent whose inbox_events were PURGED still reads UNCOVERED — the verdict never depends on the expiring event stream", () => {
    registerAgent("long-dark", "r", []);
    // Drained 10 DAYS ago (durable marker set); its message_read events would have
    // been purged at the 7d retention. Simulate the purge: seed then DELETE them.
    seedDrain("long-dark", 10 * 24); // agents.last_drain_at = 10d ago (durable)
    getDb().prepare("INSERT INTO inbox_events (agent_name, reason, created_at, source_pid) VALUES ('long-dark','message_read',?,1)").run(isoAgo(10 * 24));
    getDb().prepare("DELETE FROM inbox_events WHERE agent_name = 'long-dark'").run(); // the 7-day purge
    expect((getDb().prepare("SELECT COUNT(*) c FROM inbox_events WHERE agent_name='long-dark'").get() as { c: number }).c).toBe(0);
    seedPending("long-dark", "stuck-dark", 50); // still-pending 50h message

    const f = classifyWakeCoverage(getDb(), OPTS).find((x) => x.agent === "long-dark");
    // Pre-fix this read UNOBSERVABLE (no inbox_events) and SILENCED the alarm for the
    // longest outage; the durable marker keeps it UNCOVERED — regression preserved.
    expect(f?.verdict).toBe("uncovered");
  });

  it("DRAIN PATH: a real !peek get_messages drain sets the durable agents.last_drain_at", () => {
    registerAgent("sender", "r", []);
    registerAgent("drainer", "r", []);
    getDb().prepare("UPDATE agents SET session_id = 's1' WHERE name = 'drainer'").run();
    expect((getDb().prepare("SELECT last_drain_at FROM agents WHERE name='drainer'").get() as { last_drain_at: string | null }).last_drain_at).toBeNull();
    sendMessage("sender", "drainer", "hi", "normal");
    getMessages("drainer", "pending", 20); // real drain (non-peek) marks read + sets the marker
    const after = (getDb().prepare("SELECT last_drain_at FROM agents WHERE name='drainer'").get() as { last_drain_at: string | null }).last_drain_at;
    expect(after).not.toBeNull();
  });

  it("ATOMICITY (codex #200): the marker commits IN THE SAME tx as the drain — a failure at the marker rolls the WHOLE drain back", () => {
    registerAgent("sender", "r", []);
    registerAgent("atomic", "r", []);
    const db = getDb();
    db.prepare("UPDATE agents SET session_id = 's1' WHERE name = 'atomic'").run();
    const msg = sendMessage("sender", "atomic", "hi", "normal");
    // Inject a failure at the marker write: a trigger that ABORTs any last_drain_at UPDATE.
    // Because the marker write is INSIDE the drain tx, the abort throws out of the tx
    // callback and better-sqlite3 rolls back the ENTIRE drain. With a post-tx marker
    // (the bug), the drain would have committed FIRST, leaving a message_read event with
    // a NULL marker → UNOBSERVABLE → suppressed — so this test bites on that regression.
    db.exec("CREATE TEMP TRIGGER wake_atomic_inject BEFORE UPDATE OF last_drain_at ON agents BEGIN SELECT RAISE(ABORT, 'inject-marker-failure'); END");
    let threw = false;
    try { getMessages("atomic", "pending", 20); } catch { threw = true; }
    db.exec("DROP TRIGGER wake_atomic_inject");
    expect(threw).toBe(true); // the drain tx aborted at the marker write

    // ATOMIC: the whole drain rolled back — message STILL pending, no message_read event, marker unset.
    expect((db.prepare("SELECT read_by_session FROM messages WHERE id = ?").get(msg.id) as { read_by_session: string | null }).read_by_session).toBeNull();
    expect((db.prepare("SELECT COUNT(*) c FROM inbox_events WHERE agent_name = 'atomic' AND reason = 'message_read'").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT last_drain_at FROM agents WHERE name = 'atomic'").get() as { last_drain_at: string | null }).last_drain_at).toBeNull();

    // With the injection removed, a normal drain marks read AND stamps the marker together.
    getMessages("atomic", "pending", 20);
    const ok = db.prepare("SELECT m.read_by_session AS rbs, a.last_drain_at AS lda FROM messages m, agents a WHERE m.id = ? AND a.name = 'atomic'").get(msg.id) as { rbs: string | null; lda: string | null };
    expect(ok.rbs).not.toBeNull();
    expect(ok.lda).not.toBeNull();
  });

  it("PEEK does not stamp last_drain_at (observation is not a drain)", () => {
    registerAgent("sender", "r", []);
    registerAgent("peeker", "r", []);
    getDb().prepare("UPDATE agents SET session_id = 's1' WHERE name = 'peeker'").run();
    sendMessage("sender", "peeker", "hi", "normal");
    getMessages("peeker", "pending", 20, /* peek */ true);
    expect((getDb().prepare("SELECT last_drain_at FROM agents WHERE name='peeker'").get() as { last_drain_at: string | null }).last_drain_at).toBeNull();
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
