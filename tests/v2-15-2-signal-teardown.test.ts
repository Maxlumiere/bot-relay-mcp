// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.15.2 — signal-handler hardening regressions (a–g).
 *
 * ROOT CAUSE: a SIGHUP/SIGINT/SIGTERM hits the agent's MCP-SERVER process, not
 * the agent (claude/codex, tracked by agent_pid). The agent can survive a
 * reflow / VS Code reload and relaunch. The pre-v2.15.2 signal path stamped a
 * terminal status that stuck on TWO surfaces:
 *   - getAgents: deriveAgentStatus R1 — a stored 'offline' wins even over a
 *     confirmed-alive probe → phantom-offline that never self-heals.
 *   - dashboard: deriveDashboardState returned 'closed' from signal_received_at
 *     alone, and the stamp was NOT cleared on re-register → a fresh no-anchor
 *     session (valid: no ancestor match / cross-host) read 'closed' from the
 *     stale stamp.
 *
 * THE FIX (three coordinated parts):
 *   1a. endAgentSessionOnSignal — clear the anchor, store NO terminal status
 *       (agent_status='idle'), stamp forensics only. No markAgentOffline fallback.
 *   1b. deriveDashboardState — a confirmed-alive probe SUPPRESSES the
 *       signal-derived close.
 *   1c. registerAgent clears signal_received_at/signal_kind on re-register, so
 *       the stamp is session-scoped and can't outlive its session.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v2152-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_ALLOW_LEGACY;

const {
  closeDb,
  getDb,
  registerAgent,
  getAgents,
  setAgentLivenessAnchor,
  setAgentStatus,
  markAgentOffline,
  endAgentSessionOnSignal,
  getAgentSessionId,
  getDashboardAgentSnapshots,
  _resetLivenessProbeCacheForTests,
} = await import("../src/db.js");
const { processStartedAt, _resetOwnHostIdForTests } = await import("../src/liveness.js");
const { deriveDashboardState } = await import("../src/agent-state-machine.js");

const OWN_HOST = "v2152-own-host";
const LIVE_PID = process.pid;
const DEAD_PID = 2_147_483_646;
const REAL_START = processStartedAt(LIVE_PID);

const PENDING_WINDOW_MS = 5 * 60 * 1000;

function cleanup() {
  closeDb();
  _resetOwnHostIdForTests(undefined);
  _resetLivenessProbeCacheForTests();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
function fresh() {
  _resetLivenessProbeCacheForTests();
}
function find(name: string) {
  return getAgents().find((a) => a.name === name)!;
}
function rawRow(name: string) {
  return getDb().prepare("SELECT * FROM agents WHERE name = ?").get(name) as Record<string, unknown>;
}
/** Drive the SHIPPED dashboard path: getDashboardAgentSnapshots → deriveDashboardState. */
function dashState(name: string): string {
  fresh();
  const now = Date.now();
  const snap = getDashboardAgentSnapshots(PENDING_WINDOW_MS, now).find((s) => s.name === name)!;
  return deriveDashboardState(snap.inputs, now);
}

beforeEach(() => {
  cleanup();
  _resetOwnHostIdForTests(OWN_HOST);
});
afterEach(() => cleanup());

describe("v2.15.2 — signal teardown does not phantom a surviving/relaunched agent", () => {
  it("(a) signal teardown + re-register (fresh alive anchor) → idle, NEVER offline/closed", () => {
    registerAgent("a-agent", "builder", [], { host_id: OWN_HOST });
    const sid = getAgentSessionId("a-agent")!;
    setAgentLivenessAnchor("a-agent", LIVE_PID, REAL_START);

    // Signal teardown: stored 'idle' (neutral), NOT a sticky 'offline'/'closed'.
    const r = endAgentSessionOnSignal("a-agent", sid, "SIGHUP");
    expect(r.changed).toBe(true);
    expect(rawRow("a-agent").agent_status).toBe("idle");
    expect(rawRow("a-agent").agent_status).not.toBe("offline"); // the R1 phantom class
    expect(rawRow("a-agent").agent_status).not.toBe("closed");

    // Agent relaunches its MCP server → re-registers + re-stamps a live anchor.
    registerAgent("a-agent", "builder", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("a-agent", LIVE_PID, REAL_START);
    fresh();
    const agent = find("a-agent");
    expect(agent.liveness).toBe("alive");
    expect(agent.agent_status).toBe("idle"); // NOT phantom offline/closed
    expect(dashState("a-agent")).not.toBe("closed");
  });

  it("(b) signal teardown, agent gone (anchor cleared, no re-register) → unknown, NOT offline/closed", () => {
    registerAgent("b-agent", "builder", [], { host_id: OWN_HOST });
    const sid = getAgentSessionId("b-agent")!;
    setAgentLivenessAnchor("b-agent", LIVE_PID, REAL_START);
    endAgentSessionOnSignal("b-agent", sid, "SIGTERM");

    const raw = rawRow("b-agent");
    expect(raw.agent_status).toBe("idle"); // stored neutral
    expect(raw.agent_pid).toBeNull(); // anchor cleared
    expect(raw.agent_pid_start).toBeNull();
    expect(raw.last_alive).toBeNull();

    fresh();
    const agent = find("b-agent");
    expect(agent.liveness).toBe("unknown");
    expect(agent.agent_status).toBe("unknown"); // derived from absence, NOT offline/closed
  });

  it("(c) a GENUINE set_status('offline') STILL persists over a live probe (R1 boundary intact)", () => {
    registerAgent("c-agent", "builder", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("c-agent", LIVE_PID, REAL_START); // confirmed alive
    setAgentStatus("c-agent", "offline"); // deliberate operator/agent declaration
    fresh();
    const agent = find("c-agent");
    // The signal-path change must NOT weaken the declaration path: R1 wins.
    expect(agent.agent_status).toBe("offline");
    expect(agent.liveness).toBe("alive"); // the probe still says alive; the declaration governs the status
  });

  it("(d) spawn's markAgentOffline pre-register is UNCHANGED (still stores 'offline')", () => {
    registerAgent("d-agent", "builder", []);
    const sid = getAgentSessionId("d-agent")!;
    const r = markAgentOffline("d-agent", sid);
    expect(r.changed).toBe(true);
    // The deliberate spawn offline-pre-register keeps its 'offline' semantics —
    // only the signal path changed.
    expect(rawRow("d-agent").agent_status).toBe("offline");
  });

  it("(e) LOAD-BEARING — signal teardown → re-register with NO anchor → dashboard NOT 'closed' (stamp cleared)", () => {
    registerAgent("e-agent", "builder", [], { host_id: OWN_HOST });
    const sid = getAgentSessionId("e-agent")!;
    endAgentSessionOnSignal("e-agent", sid, "SIGHUP");

    // The stamp is set, anchor cleared → liveness 'unknown'. WITHOUT 1c the
    // dashboard would read 'closed' from this stamp. Prove the pre-condition:
    expect(rawRow("e-agent").signal_received_at).not.toBeNull();
    expect(dashState("e-agent")).toBe("closed"); // session genuinely ended, no live probe → closed (forensic)

    // Fresh session re-registers with NO probe-able anchor (valid: ancestry
    // no-match / cross-host / missing host_id) → liveness stays 'unknown'.
    registerAgent("e-agent", "builder", [], { host_id: OWN_HOST }); // NO setAgentLivenessAnchor
    const after = rawRow("e-agent");
    // 1c: re-register cleared the signal stamp in the same UPDATE.
    expect(after.signal_received_at).toBeNull();
    expect(after.signal_kind).toBeNull();
    // So the FRESH session does NOT read 'closed' from the stale stamp, even
    // though liveness is 'unknown' (no anchor) — 1b's alive-gate alone could
    // not have covered this; 1c is what closes it.
    fresh();
    expect(find("e-agent").liveness).toBe("unknown");
    expect(dashState("e-agent")).not.toBe("closed");
  });

  it("(f) 1b — a live probe suppresses the signal-derived close; dead/unknown + stamp reads closed", () => {
    const now = Date.now();
    const base = {
      lastSeen: new Date(now).toISOString(),
      signalReceivedAt: now - 1000, // signal stamp present
      signalKind: "SIGHUP",
      unregisteredAt: null,
      pendingCount: 0,
      lastDispatchedAt: null,
    };
    // liveness 'alive' → SUPPRESSED (not closed).
    expect(deriveDashboardState({ ...base, liveness: "alive" }, now)).not.toBe("closed");
    // liveness 'dead' + stamp → closed.
    expect(deriveDashboardState({ ...base, liveness: "dead" }, now)).toBe("closed");
    // liveness 'unknown' + stamp (current session, not yet re-registered) → closed.
    expect(deriveDashboardState({ ...base, liveness: "unknown" }, now)).toBe("closed");
    // an explicit unregisteredAt is NOT gated by liveness — still closed even alive.
    expect(
      deriveDashboardState({ ...base, signalReceivedAt: null, unregisteredAt: now - 1000, liveness: "alive" }, now),
    ).toBe("closed");
  });

  it("(g) endAgentSessionOnSignal is CAS-guarded + idempotent + writes no terminal status on mismatch", () => {
    registerAgent("g-agent", "builder", []);
    const sid = getAgentSessionId("g-agent")!;

    // CAS mismatch (wrong session) → no-op, row untouched.
    const wrong = endAgentSessionOnSignal("g-agent", "not-the-session", "SIGINT");
    expect(wrong.changed).toBe(false);
    expect(rawRow("g-agent").session_id).toBe(sid); // still live

    // Correct CAS → ends the session (idle + anchor cleared + stamp).
    const ok = endAgentSessionOnSignal("g-agent", sid, "SIGINT");
    expect(ok.changed).toBe(true);
    expect(rawRow("g-agent").session_id).toBeNull();

    // Idempotent: a second call with the now-consumed session → no-op.
    const again = endAgentSessionOnSignal("g-agent", sid, "SIGINT");
    expect(again.changed).toBe(false);
  });
});
