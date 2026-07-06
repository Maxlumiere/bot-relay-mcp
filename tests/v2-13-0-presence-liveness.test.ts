// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.13.0 — presence liveness contract tests.
 *
 * The bug: the relay couldn't tell ALIVE-AND-IDLE from CLOSED. last_seen only
 * advances on activity (observation isn't liveness, v1.3), so an open terminal
 * sitting idle aged out to stale -> offline -> closed. The fix adds a positive
 * liveness signal: a SAME-HOST probe of the agent's OWN process (agent_pid —
 * NOT the host_shell_pids ancestry chain, whose shell/terminal ancestors
 * outlive the agent) stamps `last_alive`, which both presence derivations honor.
 *
 * Contract (covers the codex re-audit findings):
 *   1. HEADLINE — an idle agent (stale last_seen, even a stale stored 'closed')
 *      with a LIVE agent process reads alive/idle, NOT closed/offline.
 *   2. (HIGH #1) a real close CLEARS the anchor → getAgents() immediately reads
 *      closed + alive=false (liveness can't mask a current teardown).
 *   3. (HIGH #2) we probe agent_pid, NOT the chain — a dead agent_pid reads
 *      dead even when host_shell_pids contains a live ancestor.
 *   4. (MED #3) dead same-host rows are negative-cached → not re-probed in-window.
 *   5. AGNOSTIC PROOF — a non-Claude agent (codex) reads alive-when-idle, and
 *      the ancestry walk identifies codex as readily as claude.
 *   6. PID-reuse guard — a recycled PID (different start-time) reads dead.
 *   7. cross-host fallback + back-compat + machine-GUID parsers.
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
delete process.env.RELAY_AGENT_ALIVE_WINDOW_SEC; // 120s default
process.env.RELAY_HTTP_PORT = "54994";

const {
  closeDb,
  getDb,
  registerAgent,
  getAgents,
  getHealthSnapshot,
  setAgentLivenessAnchor,
  setAgentStatus,
  closeAgentSession,
  getAgentSessionId,
  deriveAgentStatus,
  _resetLivenessProbeCacheForTests,
  _getLivenessProbeCountForTests,
} = await import("../src/db.js");
const {
  isPidAlive,
  isAgentProcessAlive,
  processStartedAt,
  parseProcessTable,
  findAgentProcess,
  detectAgentProcess,
  resolveAgentPattern,
  processIdentityIsAgent,
  DEFAULT_AGENT_PATTERN,
  parseDarwinMachineGuid,
  parseLinuxMachineId,
  parseWindowsMachineGuid,
  _resetOwnHostIdForTests,
} = await import("../src/liveness.js");

const OWN_HOST = "test-own-host-guid";
const LIVE_PID = process.pid; // this vitest process — guaranteed alive
const DEAD_PID = 2_147_483_646;

function cleanup() {
  closeDb();
  _resetOwnHostIdForTests(undefined);
  _resetLivenessProbeCacheForTests();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

/** Make `name` look idle-for-an-hour with an optional stale stored status. */
function ageOut(name: string, storedStatus = "idle") {
  const oldIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  getDb()
    .prepare("UPDATE agents SET last_seen = ?, agent_status = ? WHERE name = ?")
    .run(oldIso, storedStatus, name);
}

function findAgent(name: string) {
  return getAgents().find((a) => a.name === name)!;
}

beforeEach(() => {
  cleanup();
  _resetOwnHostIdForTests(OWN_HOST);
});
afterEach(() => cleanup());

// --- 1. HEADLINE regression ---

describe("v2.13.0 — (1) alive-and-idle reads alive, not closed", () => {
  it("an idle same-host agent with a LIVE process is alive/idle even with a stale stored 'closed'", () => {
    registerAgent("idler", "builder", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("idler", LIVE_PID, null); // PID-liveness only (no start token)
    ageOut("idler", "closed"); // prior-session SIGINT marker + idle silence

    const a = findAgent("idler");
    expect(a.alive).toBe(true);
    expect(a.last_alive).not.toBeNull();
    expect(["closed", "offline", "abandoned", "stale"]).not.toContain(a.agent_status);
    expect(a.agent_status).toBe("idle");
  });

  it("health_check counts the alive agent in agent_count_alive", () => {
    registerAgent("idler", "builder", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("idler", LIVE_PID, null);
    ageOut("idler", "closed");
    const snap = getHealthSnapshot();
    expect(snap.agent_count).toBe(1);
    expect(snap.agent_count_alive).toBe(1);
  });
});

// --- 2. HIGH #1 — a real close clears the anchor; liveness can't mask it ---

describe("v2.13.0 — (2) a current-session close wins over liveness", () => {
  it("closeAgentSession clears the anchor → getAgents() immediately reads closed + alive=false", () => {
    const { agent } = registerAgent("closer", "builder", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("closer", LIVE_PID, null);
    ageOut("closer", "idle");

    // Fresh live anchor → alive.
    expect(findAgent("closer").alive).toBe(true);

    // The agent's terminal is closed (SIGINT) for THIS session.
    const sid = agent.session_id ?? getAgentSessionId("closer")!;
    const res = closeAgentSession("closer", sid, "SIGINT");
    expect(res.changed).toBe(true);

    // Immediately: the close is NOT masked by the (now-cleared) liveness.
    const a = findAgent("closer");
    expect(a.alive).toBe(false);
    expect(a.last_alive).toBeNull();
    expect(a.agent_status).toBe("closed");
  });
});

// --- 3. HIGH #2 — probe the agent process, NOT the ancestry chain ---

describe("v2.13.0 — (3) a live shell ancestor does NOT keep a dead agent alive", () => {
  it("dead agent_pid reads dead even though host_shell_pids has a live PID", () => {
    // host_shell_pids carries a LIVE pid (a shell/terminal ancestor), but the
    // AGENT's own process (agent_pid) is dead — the exact false-alive codex flagged.
    registerAgent("crashed", "builder", [], { host_id: OWN_HOST, host_shell_pids: [LIVE_PID] });
    setAgentLivenessAnchor("crashed", DEAD_PID, null); // agent process is gone
    ageOut("crashed", "idle");

    const a = findAgent("crashed");
    expect(a.alive).toBe(false);
    expect(a.liveness).toBe("dead"); // agent_pid present + process confirmed gone = POSITIVE dead
    expect(a.last_alive).toBeNull();
    expect(a.agent_status).toBe("closed"); // v2.15.0: dead probe → closed (a crash), NOT an age guess
  });
});

// --- 4. MED #3 — negative-probe cache ---

describe("v2.13.0 — (4) dead rows are not re-probed within the cache window", () => {
  it("a second read within the window does not re-probe the dead agent", () => {
    registerAgent("ghost", "builder", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("ghost", DEAD_PID, null);
    ageOut("ghost", "idle");
    _resetLivenessProbeCacheForTests();

    getAgents(); // first read → probes once, caches the dead verdict
    expect(_getLivenessProbeCountForTests()).toBe(1);
    getAgents(); // second read in-window → cache hit, no re-probe
    expect(_getLivenessProbeCountForTests()).toBe(1);
  });
});

// --- 5. AGNOSTIC PROOF — codex (a non-Claude agent) ---

describe("v2.13.0 — (5) universality: a non-Claude agent reads alive-when-idle", () => {
  it("an idle non-Claude (codex) agent with a live process reads alive (probe is agent-agnostic)", () => {
    registerAgent("codex-agent", "auditor", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("codex-agent", LIVE_PID, null);
    ageOut("codex-agent", "closed");
    const a = findAgent("codex-agent");
    expect(a.alive).toBe(true);
    expect(a.agent_status).toBe("idle");
  });

  it("the ancestry walk identifies codex as readily as claude (capture is agent-agnostic)", () => {
    // Synthetic ancestry: relay stdio server (self) <- codex <- shell <- terminal.
    const lstart = "Mon Jan  1 00:00:00 2020";
    const ps =
      `  100   90 ${lstart} node /usr/local/bin/codex serve\n` + // the codex CLI (ancestor)
      `  200  100 ${lstart} node /path/to/bot-relay/dist/index.js\n` + // relay stdio server (self)
      `   90    1 ${lstart} -zsh\n`; // controlling shell
    const table = parseProcessTable(ps);
    const found = findAgentProcess(200, table);
    expect(found?.pid).toBe(100); // codex, not the shell (90) or self (200)

    // And claude in the same shape.
    const psClaude = ps.replace("codex serve", "claude --resume");
    const foundClaude = findAgentProcess(200, parseProcessTable(psClaude));
    expect(foundClaude?.pid).toBe(100);
  });

  it("matches the agent by IDENTITY (exe/script basename), NOT a full-command substring", () => {
    // Real positives — executable basename or runtime-hosted script basename.
    expect(processIdentityIsAgent("node /usr/local/bin/claude", "node")).toBe(true);
    expect(processIdentityIsAgent("node /usr/local/bin/codex serve", "node")).toBe(true);
    expect(processIdentityIsAgent("node /usr/local/bin/claude --resume", "node")).toBe(true);
    expect(processIdentityIsAgent("/opt/codex/codex serve", "codex")).toBe(true);
    expect(processIdentityIsAgent("claude --resume", "claude")).toBe(true);
    expect(processIdentityIsAgent("codex serve", "codex")).toBe(true);
    // comm may be unset (hand-built tables) → argv[0] basename fallback.
    expect(processIdentityIsAgent("/opt/codex/codex serve", undefined)).toBe(true);

    // The reported HIGH — a NON-agent process whose PATH merely contains
    // "claude"/"codex" (a directory) must NOT match. These are codex's exact
    // reproduction cases; the old full-command regex false-matched all three.
    expect(processIdentityIsAgent("node /home/dev/Claude AI/not-agent-wrapper.js", "node")).toBe(false);
    expect(processIdentityIsAgent("node /tmp/codex-notes/not-agent.js", "node")).toBe(false);
    expect(processIdentityIsAgent("node /home/x/notes.js claude-notes.md", "node")).toBe(false);
    expect(processIdentityIsAgent("cat /home/x/Claude AI/readme.md", "cat")).toBe(false);

    // 2nd audit HIGH: a path-VALUED ARGUMENT after the real script must never
    // control identity — only argv[1] can be the script. (Reproduction cases.)
    expect(processIdentityIsAgent("node /tmp/runner.js /tmp/codex", "node")).toBe(false);
    expect(processIdentityIsAgent("node /tmp/runner.js /tmp/claude", "node")).toBe(false);
    expect(processIdentityIsAgent("python /tmp/runner.py /tmp/codex", "python")).toBe(false);
    // A no-extension script with a path-like positional arg is AMBIGUOUS →
    // decline (safety over a false-alive), even though the arg basename is "codex".
    expect(processIdentityIsAgent("node /opt/tool /var/codex", "node")).toBe(false);
    // Options after a bare script are fine — they don't make it ambiguous.
    expect(processIdentityIsAgent("node /usr/local/bin/codex --flag /some/path", "node")).toBe(true);

    // Plain shells / logins never match.
    expect(processIdentityIsAgent("-zsh", "zsh")).toBe(false);
    expect(processIdentityIsAgent("/usr/bin/login", "login")).toBe(false);
    expect(DEFAULT_AGENT_PATTERN.test("claude")).toBe(true); // the matcher is exact-basename
    expect(DEFAULT_AGENT_PATTERN.test("claude-notes.md")).toBe(false);
  });

  it("findAgentProcess does NOT bind to a non-agent wrapper under a 'Claude' path (the HIGH, end to end)", () => {
    // Ancestry: relay self (200) <- a non-agent node wrapper (100) whose script
    // lives under '/Users/.../Claude AI/' <- shell (90). The wrapper must be
    // rejected → null → age-based fallback, NOT stamped as the agent.
    const lstart = "Mon Jan  1 00:00:00 2020";
    const table = parseProcessTable(
      `  100   90 ${lstart} node /home/dev/Claude AI/not-agent-wrapper.js\n` +
      `  200  100 ${lstart} node /path/to/bot-relay/dist/index.js\n` +
      `   90    1 ${lstart} -zsh\n`,
    );
    expect(findAgentProcess(200, table)).toBeNull();
  });

  it("findAgentProcess returns null when no agent ancestor exists (→ age-based fallback)", () => {
    const ps = `  200  90 x x x x x node /path/to/bot-relay/dist/index.js\n   90   1 x x x x x -zsh\n`;
    expect(findAgentProcess(200, parseProcessTable(ps))).toBeNull();
  });
});

// --- 5b. Explicit offline declaration is NOT overridden by liveness ---

describe("v2.13.0 — (5b) explicit set_status('offline') wins over liveness", () => {
  it("a live same-host agent that DECLARED offline reads offline + alive=false", () => {
    registerAgent("declared", "builder", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("declared", LIVE_PID, null); // process is genuinely up
    setAgentStatus("declared", "offline"); // operator/agent declares unavailable

    const a = findAgent("declared"); // the getAgents probe WILL find the live pid
    expect(a.agent_status).toBe("offline"); // declaration wins over fresh liveness
    expect(a.alive).toBe(false); // alive stays consistent with the surfaced status
  });

  it("any path that stores 'offline' (e.g. force token rotation) is respected over a live anchor", () => {
    // Path-independent: the fix lives in the derivation, so any writer that
    // stores agent_status='offline' (set_status, force-rotation) is honored.
    registerAgent("rotated", "builder", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("rotated", LIVE_PID, null);
    getDb().prepare("UPDATE agents SET agent_status = 'offline' WHERE name = ?").run("rotated");
    expect(findAgent("rotated").agent_status).toBe("offline");
  });

  it("aged-into-offline (stored 'idle', stale last_seen) IS still overridden by liveness", () => {
    // Contrast: an agent that DIDN'T declare offline but merely went quiet must
    // still read alive when its process is up — the whole point of the fix.
    registerAgent("quiet", "builder", [], { host_id: OWN_HOST });
    setAgentLivenessAnchor("quiet", LIVE_PID, null);
    ageOut("quiet", "idle"); // stored idle, 1h silent → would derive offline by age
    expect(findAgent("quiet").agent_status).toBe("idle"); // liveness overrides age
  });
});

// --- 5c. Matcher is extensible (RELAY_AGENT_PROCESS_PATTERN) ---

describe("v2.13.0 — (5c) agent matcher extensibility", () => {
  it("default matches claude/codex only; env broadens it (by basename); invalid regex → default", () => {
    expect(resolveAgentPattern({}).source).toBe(DEFAULT_AGENT_PATTERN.source);
    const broadened = resolveAgentPattern({ RELAY_AGENT_PROCESS_PATTERN: "aider|my-cli" });
    // The matcher is applied to a BASENAME (exe or hosted script), so it tests
    // against identity tokens, not full commands.
    expect(processIdentityIsAgent("python -m aider", "python", broadened)).toBe(true);
    expect(processIdentityIsAgent("/opt/my-cli run", "my-cli", broadened)).toBe(true);
    expect(processIdentityIsAgent("node /usr/local/bin/claude", "node", broadened)).toBe(true); // default still in
    // Still anchored — a broadened alternation can't match a mid-path segment.
    expect(processIdentityIsAgent("node /Users/x/my-cli-notes/thing.js", "node", broadened)).toBe(false);
    // A malformed pattern is ignored (never crashes the startup walk).
    expect(resolveAgentPattern({ RELAY_AGENT_PROCESS_PATTERN: "(" }).source).toBe(
      DEFAULT_AGENT_PATTERN.source,
    );
  });
});

// --- 5d. Resume: a re-registered agent comes back available ---

describe("v2.13.0 — (5d) re-register resets terminal states (resume)", () => {
  it("an OFFLINE agent that re-registers resumes as idle (the resume-stuck-offline fix)", () => {
    registerAgent("resumer", "researcher", [], { host_id: OWN_HOST });
    setAgentStatus("resumer", "offline"); // went offline
    expect(findAgent("resumer").agent_status).toBe("offline");

    registerAgent("resumer", "researcher", []); // relaunch / re-register with token
    // statusAfterReregister resets the offline DECLARATION → it is no longer
    // STUCK offline. Without a live anchor yet it reads 'unknown' (not dead)...
    expect(findAgent("resumer").agent_status).toBe("unknown");
    // ...and once the hook captures its live agent_pid, it's fully idle.
    setAgentLivenessAnchor("resumer", LIVE_PID, null);
    expect(findAgent("resumer").agent_status).toBe("idle");
  });

  it("a CLOSED/abandoned/stale agent likewise resumes idle on re-register (with a live anchor)", () => {
    for (const terminal of ["closed", "abandoned", "stale"]) {
      registerAgent("res2", "r", [], { host_id: OWN_HOST });
      getDb().prepare("UPDATE agents SET agent_status = ? WHERE name = ?").run(terminal, "res2");
      registerAgent("res2", "r", []);
      setAgentLivenessAnchor("res2", LIVE_PID, null); // hook captures the live anchor
      expect(findAgent("res2").agent_status, `terminal=${terminal}`).toBe("idle");
      closeDb();
      _resetOwnHostIdForTests(OWN_HOST);
    }
  });

  it("an ACTIVE declared state (working) is PRESERVED across re-register", () => {
    registerAgent("worker", "builder", [], { host_id: OWN_HOST });
    setAgentStatus("worker", "working");
    registerAgent("worker", "builder", []); // re-register
    setAgentLivenessAnchor("worker", LIVE_PID, null); // live anchor → verdict alive
    expect(findAgent("worker").agent_status).toBe("working"); // current intent preserved
  });
});

// --- 5e. CANONICAL PRECEDENCE TABLE (single source of truth) ---

describe("v2.15.0 — (5e) deriveAgentStatus AGE-FREE precedence table (stored × verdict)", () => {
  // The WHOLE table — every stored × verdict cell pinned. AGE is not an input:
  // staleness alone can NEVER produce closed/offline/abandoned. Only a
  // declaration (R1 offline / R4 closed) or a positive dead probe (R3) can.
  // [stored, verdict, expected]
  const CELLS: Array<[string, "alive" | "dead" | "unknown", string]> = [
    // active declared states: alive→that state, dead→closed (crash), unknown→unknown
    ["idle", "alive", "idle"], ["idle", "dead", "closed"], ["idle", "unknown", "unknown"],
    ["working", "alive", "working"], ["working", "dead", "closed"], ["working", "unknown", "unknown"],
    ["blocked", "alive", "blocked"], ["blocked", "dead", "closed"], ["blocked", "unknown", "unknown"],
    ["waiting_user", "alive", "waiting_user"], ["waiting_user", "dead", "closed"], ["waiting_user", "unknown", "unknown"],
    // offline DECLARATION (R1) wins over everything, even a live PID; never 'closed'.
    ["offline", "alive", "offline"], ["offline", "dead", "offline"], ["offline", "unknown", "offline"],
    // closed: a live process overrides a stale 'closed' (R2 → idle, never closed-when-alive);
    // dead→closed; unknown→closed (the clean-SIGINT close DECLARATION, R4).
    ["closed", "alive", "idle"], ["closed", "dead", "closed"], ["closed", "unknown", "closed"],
    // abandoned / stale are age-artifacts, NEVER declarations → alive→idle, dead→closed, unknown→unknown.
    ["abandoned", "alive", "idle"], ["abandoned", "dead", "closed"], ["abandoned", "unknown", "unknown"],
    ["stale", "alive", "idle"], ["stale", "dead", "closed"], ["stale", "unknown", "unknown"],
    // legacy stored aliases normalize (online→idle) then follow the table.
    ["online", "alive", "idle"], ["online", "unknown", "unknown"],
  ];
  it.each(CELLS)("stored=%s verdict=%s → %s", (stored, verdict, expected) => {
    expect(deriveAgentStatus(stored, verdict)).toBe(expected);
  });
});

// --- 6. PID-reuse guard ---

describe("v2.13.0 — (6) start-time reuse guard", () => {
  it("a recycled PID (different start-time) reads dead", () => {
    // process.pid is alive, but the stored start-time doesn't match → reused → dead.
    expect(isAgentProcessAlive(LIVE_PID, "Mon Jan  1 00:00:00 2020")).toBe(false);
  });
  it("a matching start-time reads alive", () => {
    const real = processStartedAt(LIVE_PID);
    expect(real).not.toBeNull();
    expect(isAgentProcessAlive(LIVE_PID, real)).toBe(true);
  });
  it("a null start-time falls back to PID-liveness alone", () => {
    expect(isAgentProcessAlive(LIVE_PID, null)).toBe(true);
    expect(isAgentProcessAlive(DEAD_PID, null)).toBe(false);
  });
});

// --- 7. cross-host fallback + back-compat + errno + GUID parsers ---

describe("v2.13.0 — (7) host-scope, back-compat, errno, parsers", () => {
  it("a DIFFERENT-host agent is NOT probed even if agent_pid is locally alive", () => {
    registerAgent("remote", "builder", [], { host_id: "some-other-machine" });
    setAgentLivenessAnchor("remote", LIVE_PID, null); // COALESCE keeps the other host_id
    ageOut("remote", "idle");
    const a = findAgent("remote");
    expect(a.alive).toBe(false);
    // v2.15.0: a cross-host agent_pid can't be probed (a PID is meaningless on
    // another host) → verdict 'unknown', NEVER a stale-age 'offline'/'dead'.
    expect(a.liveness).toBe("unknown");
    expect(a.agent_status).toBe("unknown");
  });

  it("when the relay's own host id is unknown, NO agent is probed", () => {
    _resetOwnHostIdForTests(null);
    registerAgent("idler", "builder", [], { host_id: OWN_HOST });
    // setAgentLivenessAnchor still records agent_pid; the probe is what's gated.
    getDb().prepare("UPDATE agents SET agent_pid = ? WHERE name = ?").run(LIVE_PID, "idler");
    ageOut("idler", "idle");
    expect(findAgent("idler").alive).toBe(false);
  });

  it("an agent with no agent_pid (old/pre-anchor session) derives 'unknown', NEVER a stale-age 'offline'", () => {
    registerAgent("legacy", "builder", []);
    ageOut("legacy", "idle"); // 1h stale last_seen — the OLD code guessed 'offline'
    const a = findAgent("legacy");
    expect(a.last_alive).toBeNull();
    expect(a.liveness).toBe("unknown"); // no probe-able anchor → we don't know
    expect(a.alive).toBe(false); // not confirmed alive...
    expect(a.agent_status).toBe("unknown"); // ...but NOT dead — absence of data != death
  });

  const throwing = (code: string) => () => {
    const e = new Error(code) as NodeJS.ErrnoException;
    e.code = code;
    throw e;
  };
  it("isPidAlive: success/EPERM alive, ESRCH dead, bad pid dead", () => {
    expect(isPidAlive(123, () => undefined)).toBe(true);
    expect(isPidAlive(123, throwing("EPERM"))).toBe(true);
    expect(isPidAlive(123, throwing("ESRCH"))).toBe(false);
    expect(isPidAlive(0)).toBe(false);
  });

  it("machineGuid parsers", () => {
    expect(parseDarwinMachineGuid('"IOPlatformUUID" = "564D-ABCD"')).toBe("564D-ABCD");
    expect(parseLinuxMachineId("0123456789abcdef0123456789abcdef\n")).toBe("0123456789abcdef0123456789abcdef");
    expect(parseLinuxMachineId("nope")).toBeNull();
    expect(parseWindowsMachineGuid("    MachineGuid    REG_SZ    abcd-1234")).toBe("abcd-1234");
  });

  it("detectAgentProcess returns null in a non-agent ancestry (e.g. the daemon)", () => {
    const run = () => `  ${process.pid}  90 x x x x x node /path/bot-relay/dist/index.js\n   90  1 x x x x x launchd\n`;
    expect(detectAgentProcess(process.pid, run)).toBeNull();
  });
});
