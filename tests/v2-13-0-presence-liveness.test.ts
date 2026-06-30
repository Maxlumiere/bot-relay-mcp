// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.13.0 — presence liveness contract tests.
 *
 * The bug: the relay couldn't tell ALIVE-AND-IDLE from CLOSED. An open
 * terminal that's just waiting stops bumping last_seen (observation isn't
 * liveness, v1.3), so the age-based derivations promoted it to offline/closed
 * even though its process was alive. The fix adds a positive liveness signal:
 * a SAME-HOST PID probe of the agent's host_shell_pids chain stamps
 * `last_alive`, which both presence derivations honor.
 *
 * Contract:
 *   1. HEADLINE regression — an idle agent (stale last_seen, even a stale
 *      stored 'closed') with a LIVE same-host PID reads alive/idle, NOT
 *      closed/offline.
 *   2. dead PID → no liveness → age-based closed/offline (unchanged).
 *   3. cross-host (host_id mismatch) → NO probe (PID could collide) → age-based.
 *   4. cross-platform errno — isPidAlive: success/EPERM alive, ESRCH dead.
 *   5. back-compat — last_alive NULL → byte-identical age-based derivation.
 *   6. deriveDashboardState — fresh last_alive suppresses session-timeout
 *      closed; an intentional teardown signal still wins.
 *   7. machine-GUID parse fns (the host-scoping source of truth).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v2130-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_AGENT_ALIVE_WINDOW_SEC; // use the 120s default
process.env.RELAY_HTTP_PORT = "54994";

const { closeDb, getDb, registerAgent, getAgents, getHealthSnapshot } =
  await import("../src/db.js");
const {
  isPidAlive,
  isAnyPidAlive,
  parseDarwinMachineGuid,
  parseLinuxMachineId,
  parseWindowsMachineGuid,
  machineGuid,
  _resetOwnHostIdForTests,
} = await import("../src/liveness.js");
const { deriveDashboardState, DEFAULT_THRESHOLDS } = await import("../src/agent-state-machine.js");

const OWN_HOST = "test-own-host-guid";
const LIVE_PID = process.pid; // this vitest process — guaranteed alive
const DEAD_PID = 2_147_483_646; // astronomically unlikely to exist

function cleanup() {
  closeDb();
  _resetOwnHostIdForTests(undefined);
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

/** Make `name` look idle-for-an-hour with an optional stale stored status. */
function ageOut(name: string, storedStatus = "idle") {
  const oldIso = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
  getDb()
    .prepare("UPDATE agents SET last_seen = ?, agent_status = ? WHERE name = ?")
    .run(oldIso, storedStatus, name);
}

function findAgent(name: string) {
  return getAgents().find((a) => a.name === name)!;
}

beforeEach(() => {
  cleanup();
  // Pin the relay's own host id deterministically so host-scoping is testable
  // without depending on the CI machine's real GUID extraction.
  _resetOwnHostIdForTests(OWN_HOST);
});
afterEach(() => cleanup());

// --- 1. HEADLINE regression ---

describe("v2.13.0 — (1) alive-and-idle reads alive, not closed", () => {
  it("an idle same-host agent with a LIVE PID is alive/idle even with a stale stored 'closed'", () => {
    registerAgent("idler", "builder", [], { host_id: OWN_HOST, host_shell_pids: [LIVE_PID] });
    ageOut("idler", "closed"); // simulate a prior-session SIGINT marker + idle silence

    const a = findAgent("idler");
    expect(a.alive).toBe(true); // the trustworthy answer
    expect(a.last_alive).not.toBeNull();
    // The exact bug: it must NOT read closed/offline/abandoned/stale.
    expect(["closed", "offline", "abandoned", "stale"]).not.toContain(a.agent_status);
    expect(a.agent_status).toBe("idle");
  });

  it("preserves a declared active state (working) when alive", () => {
    registerAgent("worker", "builder", [], { host_id: OWN_HOST, host_shell_pids: [LIVE_PID] });
    ageOut("worker", "working");
    expect(findAgent("worker").agent_status).toBe("working");
  });

  it("health_check counts the alive agent in agent_count_alive", () => {
    registerAgent("idler", "builder", [], { host_id: OWN_HOST, host_shell_pids: [LIVE_PID] });
    ageOut("idler", "closed");
    const snap = getHealthSnapshot();
    expect(snap.agent_count).toBe(1);
    expect(snap.agent_count_alive).toBe(1);
  });
});

// --- 2. dead PID → age-based closed/offline ---

describe("v2.13.0 — (2) dead PID → no liveness", () => {
  it("an idle same-host agent whose PID is dead reads its stored 'closed' (no false-alive)", () => {
    registerAgent("ghost", "builder", [], { host_id: OWN_HOST, host_shell_pids: [DEAD_PID] });
    ageOut("ghost", "closed");
    const a = findAgent("ghost");
    expect(a.alive).toBe(false);
    expect(a.last_alive).toBeNull();
    expect(a.agent_status).toBe("closed");
  });
});

// --- 3. cross-host fallback (no PID collision false-alive) ---

describe("v2.13.0 — (3) cross-host fallback", () => {
  it("a DIFFERENT-host agent is NOT probed even if its PID is locally alive", () => {
    // host_shell_pids includes a locally-live PID, but host_id != our host —
    // probing it would false-match an unrelated local process. Must skip.
    registerAgent("remote", "builder", [], { host_id: "some-other-machine", host_shell_pids: [LIVE_PID] });
    ageOut("remote", "idle");
    const a = findAgent("remote");
    expect(a.alive).toBe(false);
    expect(a.last_alive).toBeNull();
    // Age-based: idle + 1h silence → offline.
    expect(a.agent_status).toBe("offline");
  });

  it("when the relay's own host id is unknown, NO agent is probed", () => {
    _resetOwnHostIdForTests(null); // GUID extraction failed
    registerAgent("idler", "builder", [], { host_id: OWN_HOST, host_shell_pids: [LIVE_PID] });
    ageOut("idler", "idle");
    const a = findAgent("idler");
    expect(a.alive).toBe(false);
    expect(a.agent_status).toBe("offline"); // pure age-based fallback
  });
});

// --- 4. cross-platform errno handling (pure probe) ---

describe("v2.13.0 — (4) isPidAlive errno handling", () => {
  const throwing = (code: string) => () => {
    const e = new Error(code) as NodeJS.ErrnoException;
    e.code = code;
    throw e;
  };
  it("success → alive", () => expect(isPidAlive(123, () => undefined)).toBe(true));
  it("EPERM (cross-user) → alive", () => expect(isPidAlive(123, throwing("EPERM"))).toBe(true));
  it("ESRCH (no such process) → dead", () => expect(isPidAlive(123, throwing("ESRCH"))).toBe(false));
  it("non-positive / non-integer pid → dead", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });
  it("isAnyPidAlive: true if any pid alive; false for empty/null", () => {
    expect(isAnyPidAlive([DEAD_PID, LIVE_PID])).toBe(true);
    expect(isAnyPidAlive([])).toBe(false);
    expect(isAnyPidAlive(null)).toBe(false);
  });
});

// --- 5. back-compat: no liveness signal → unchanged age-based derivation ---

describe("v2.13.0 — (5) back-compat when no liveness signal", () => {
  it("an agent with no host_shell_pids derives exactly as pre-v2.13 (age-based)", () => {
    registerAgent("legacy", "builder", []); // no host_id, no pids
    ageOut("legacy", "idle");
    const a = findAgent("legacy");
    expect(a.last_alive).toBeNull();
    expect(a.alive).toBe(false);
    expect(a.agent_status).toBe("offline"); // 1h idle → offline, unchanged
  });

  it("a fresh agent (recent last_seen, no liveness) still reads idle", () => {
    registerAgent("fresh", "builder", []);
    const a = findAgent("fresh");
    expect(a.alive).toBe(false); // no positive signal
    expect(a.agent_status).toBe("idle"); // recent last_seen
  });
});

// --- 6. deriveDashboardState honors lastAlive ---

describe("v2.13.0 — (6) deriveDashboardState + lastAlive", () => {
  const NOW = 1_900_000_000_000;
  const longAgo = new Date(NOW - 60 * 60 * 1000).toISOString(); // 1h ago > sessionTimeout
  const base = {
    signalReceivedAt: null,
    signalKind: null,
    unregisteredAt: null,
    pendingCount: 0,
    lastDispatchedAt: null,
  };

  it("fresh lastAlive suppresses the session-timeout closed → waiting", () => {
    const inputs = { ...base, lastSeen: longAgo, lastAlive: new Date(NOW - 1000).toISOString() };
    expect(deriveDashboardState(inputs, NOW, DEFAULT_THRESHOLDS)).toBe("waiting");
  });

  it("without lastAlive, the same idle agent is closed (the old behavior)", () => {
    const inputs = { ...base, lastSeen: longAgo, lastAlive: null };
    expect(deriveDashboardState(inputs, NOW, DEFAULT_THRESHOLDS)).toBe("closed");
  });

  it("an intentional teardown signal still wins over fresh lastAlive", () => {
    const inputs = { ...base, lastSeen: longAgo, lastAlive: new Date(NOW - 1000).toISOString(), signalReceivedAt: NOW - 2000 };
    expect(deriveDashboardState(inputs, NOW, DEFAULT_THRESHOLDS)).toBe("closed");
  });

  it("a STALE lastAlive (older than the window) does not suppress closed", () => {
    const inputs = { ...base, lastSeen: longAgo, lastAlive: longAgo };
    expect(deriveDashboardState(inputs, NOW, DEFAULT_THRESHOLDS)).toBe("closed");
  });
});

// --- 7. machine-GUID parse functions (host-scoping source of truth) ---

describe("v2.13.0 — (7) machineGuid extraction", () => {
  it("parses macOS IOPlatformUUID", () => {
    const out = '    "IOPlatformUUID" = "564D1234-ABCD-5678-90EF-1234567890AB"';
    expect(parseDarwinMachineGuid(out)).toBe("564D1234-ABCD-5678-90EF-1234567890AB");
  });
  it("parses Linux /etc/machine-id (32 hex)", () => {
    expect(parseLinuxMachineId("0123456789abcdef0123456789abcdef\n")).toBe("0123456789abcdef0123456789abcdef");
    expect(parseLinuxMachineId("not-a-machine-id")).toBeNull();
  });
  it("parses Windows MachineGuid", () => {
    const out = "    MachineGuid    REG_SZ    abcd1234-5678-90ef-ghij-klmnopqrstuv";
    expect(parseWindowsMachineGuid(out)).toBe("abcd1234-5678-90ef-ghij-klmnopqrstuv");
  });
  it("machineGuid uses the right OS source per platform (injected runner)", () => {
    const calls: string[] = [];
    const run = (cmd: string) => {
      calls.push(cmd);
      return cmd === "ioreg" ? '"IOPlatformUUID" = "AAAA"' : "";
    };
    expect(machineGuid("darwin", run)).toBe("AAAA");
    expect(calls).toContain("ioreg");
    expect(machineGuid("freebsd" as any, run)).toBeNull(); // unsupported → null
  });
});
