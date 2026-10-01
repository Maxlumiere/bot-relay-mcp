// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The process START TOKEN (the PID-reuse guard) has ONE spelling:
 * `TZ=UTC LC_ALL=C ps -o lstart= -p PID`, trimmed. `lstart` is a wall-clock
 * date, so a token read under one TZ never matches the same process read under
 * another: a connector and the daemon with different TZ values would read a live
 * process dead (Codex, #295 round 1, MEASURED 15:59:41 UTC vs 23:59:41 SGT).
 *
 * GUARD (metamorphic): the same live pid, read with the reader's TZ set to UTC,
 * Asia/Singapore, America/New_York and unset, gives ONE byte-identical token from
 * every producer: TS processStartedAt, the TS process-table read (the detection
 * path), and the bash relay_pid_start. Un-pinning TZ in any producer turns it red.
 *
 * MIGRATION: tokens written before this change carry the writer's local time
 * (TZ unset, so /etc/localtime). Readers also accept that form, recomputed with
 * TZ REMOVED, never with the reader's inherited TZ, so no live anchor reads dead
 * after the deploy. `relay doctor` counts the live rows still in that form.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-start-token-utc-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;

const liveness = await import("../src/liveness.js");
const { processStartedAt, buildProcessTable, isAgentProcessAlive, anchorLivenessVerdict, observeStartTokenForm, startTokenEnv, _resetOwnHostIdForTests } =
  liveness;
type CommandRunner = import("../src/liveness.js").CommandRunner;
const { closeDb, getDb, registerAgent, getLocalEdgeId, countLegacyStartTokens, migrateLegacyBindingAnchor, upsertAgentBinding, endAgentBinding } =
  await import("../src/db.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(__dirname, "..", "hooks", "_vault-helpers.sh");

/** The reader TZ values: a UTC reader, two non-UTC ones, and none set. */
const TZ_VALUES: Array<string | null> = ["UTC", "Asia/Singapore", "America/New_York", null];

function withTz<T>(tz: string | null, fn: () => T): T {
  const saved = process.env.TZ;
  if (tz === null) delete process.env.TZ;
  else process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

function envWithTz(tz: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (tz === null) delete env.TZ;
  else env.TZ = tz;
  return env;
}

/** Call a _vault-helpers.sh function exactly as the hooks do, with the given TZ in its environment. */
function bash(fnCall: string, args: string[], tz: string | null, prelude = ""): string {
  // Consumed through command substitution, exactly as every hook reads it.
  const script = `. "$1"; shift; ${prelude}out=$(${fnCall} "$@"); printf '%s' "$out"`;
  const r = spawnSync("bash", ["-c", script, "bash", HELPER, ...args], {
    encoding: "utf-8",
    env: envWithTz(tz),
  });
  if (r.status !== 0) throw new Error(`bash ${fnCall} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

/** The legacy token a pre-change writer stored (TZ unset → /etc/localtime), produced independently of the code under test. */
function legacyReference(pid: number): string {
  const env = { ...process.env, LC_ALL: "C" };
  delete env.TZ;
  return spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", env }).stdout.trim();
}

let child: ChildProcess;
let PIDS: number[];

beforeAll(() => {
  child = spawn("sleep", ["300"], { stdio: "ignore" });
  PIDS = [process.pid, child.pid as number];
});
afterAll(() => {
  child.kill("SIGKILL");
});

describe("the start token: one spelling, independent of the reader's TZ", () => {
  it("TS processStartedAt, the TS process table and bash relay_pid_start give ONE byte-identical token under every reader TZ", () => {
    for (const pid of PIDS) {
      const seen = new Map<string, string>();
      for (const tz of TZ_VALUES) {
        const label = tz ?? "unset";
        withTz(tz, () => {
          seen.set(`ts(${label})`, String(processStartedAt(pid)));
          seen.set(`table(${label})`, String(buildProcessTable().get(pid)?.startedAt));
        });
        seen.set(`bash(${label})`, bash("relay_pid_start", [String(pid)], tz));
      }
      const distinct = new Set(seen.values());
      expect(distinct.size, `pid ${pid}: ${JSON.stringify(Object.fromEntries(seen), null, 1)}`).toBe(1);
      const token = [...distinct][0];
      // Positive: a real token, and it is the UTC form (not merely self-consistent).
      expect(token).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
      const utc = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf-8",
        env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      }).stdout.trim();
      expect(token).toBe(utc);
    }
  });

  it("startTokenEnv pins TZ=UTC and LC_ALL=C over any inherited value; the legacy form REMOVES TZ", () => {
    const base = { TZ: "America/New_York", LC_ALL: "fr_FR.UTF-8", KEEP: "1" };
    expect(startTokenEnv(base)).toEqual({ TZ: "UTC", LC_ALL: "C", KEEP: "1" });
    const legacy = startTokenEnv(base, "legacy");
    expect(legacy).toEqual({ LC_ALL: "C", KEEP: "1" });
    expect("TZ" in legacy).toBe(false);
    expect(base.TZ).toBe("America/New_York"); // the caller's env is not mutated
  });

  it("the legacy recompute ignores the reader's inherited TZ (TS and bash both equal the TZ-removed form)", () => {
    const pid = process.pid;
    const ref = legacyReference(pid);
    expect(ref.length).toBeGreaterThan(0);
    for (const tz of TZ_VALUES) {
      withTz(tz, () => expect(processStartedAt(pid, undefined, "legacy"), `ts legacy under ${tz}`).toBe(ref));
      expect(bash("relay_pid_start_legacy", [String(pid)], tz), `bash legacy under ${tz}`).toBe(ref);
    }
  });
});

/**
 * A runner whose two forms DIFFER (as on any non-UTC host), so legacy acceptance
 * is exercised everywhere, including a CI host whose /etc/localtime is UTC.
 */
function twoFormRunner(utc: string | null, legacy: string | null): CommandRunner {
  return (cmd, args, opts) => {
    if (cmd !== "ps" || !args.includes("lstart=")) return "";
    const v = opts?.startTokenForm === "legacy" ? legacy : utc;
    return v === null ? "" : `${v}  \n`;
  };
}
const UTC_T = "Thu Oct  1 07:37:33 2026";
const LEGACY_T = "Thu Oct  1 15:37:33 2026";
const OTHER_T = "Mon Jan  1 00:00:00 2020";
const alive = () => true;

describe("migration: readers accept the legacy local-time form", () => {
  const rows: Array<[string, string | null, string | null, boolean, string]> = [
    // [label, stored, legacy read, expected alive, expected observation]
    ["stored UTC form → alive", UTC_T, LEGACY_T, true, "utc"],
    ["stored legacy form → alive (no binding reads dead after the deploy)", LEGACY_T, LEGACY_T, true, "legacy"],
    ["stored neither form (PID reuse) → dead", OTHER_T, LEGACY_T, false, "mismatch"],
    ["legacy form unreadable → alive (cannot validate → trust the PID, as before)", OTHER_T, null, true, "unreadable"],
  ];
  for (const [label, stored, legacyRead, expected, obs] of rows) {
    it(`TS: ${label}`, () => {
      const run = twoFormRunner(UTC_T, legacyRead);
      expect(observeStartTokenForm(4242, stored as string, run)).toBe(obs);
      expect(isAgentProcessAlive(4242, stored, run, alive as never)).toBe(expected);
    });
    it(`bash relay_anchor_liveness agrees: ${label}`, () => {
      // Override only the two PRODUCERS (the verdict logic is the shipped one);
      // the pid is this live process so relay_pid_alive passes for real.
      const prelude =
        `relay_pid_start() { printf '%s' '${UTC_T}'; }; ` +
        `relay_pid_start_legacy() { printf '%s' '${legacyRead ?? ""}'; }; `;
      const verdict = bash("relay_anchor_liveness", [String(process.pid), stored as string, "H", "H"], null, prelude);
      expect(verdict).toBe(expected ? "alive" : "dead");
    });
  }

  it("a UTC read that already matches never runs the legacy read", () => {
    const calls: string[] = [];
    const run: CommandRunner = (cmd, args, opts) => {
      calls.push(opts?.startTokenForm ?? "utc");
      return UTC_T;
    };
    expect(isAgentProcessAlive(4242, UTC_T, run, alive as never)).toBe(true);
    expect(calls).toEqual(["utc"]);
  });

  it("real ps: a live anchor stored in the legacy form reads alive in TS and bash (the conformance pair)", () => {
    _resetOwnHostIdForTests("own-host");
    try {
      const stored = legacyReference(process.pid);
      const row = { host_id: "own-host", agent_pid: process.pid, agent_pid_start: stored };
      expect(anchorLivenessVerdict(row)).toBe("alive");
      expect(bash("relay_anchor_liveness", [String(process.pid), stored, "own-host", "own-host"], "America/New_York")).toBe("alive");
    } finally {
      _resetOwnHostIdForTests();
    }
  });
});

describe("the legacy count is measurable (gates deleting legacy acceptance)", () => {
  const OWN = "own-host-guid";
  function cleanup() {
    closeDb();
    if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
  beforeEach(() => {
    cleanup();
    _resetOwnHostIdForTests(OWN);
  });
  afterEach(() => {
    cleanup();
    _resetOwnHostIdForTests();
  });

  function anchor(name: string, pid: number | null, start: string | null, host: string | null) {
    registerAgent(name, "user", []);
    getDb().prepare("UPDATE agents SET agent_pid = ?, agent_pid_start = ?, host_id = ? WHERE name = ?").run(pid, start, host, name);
  }
  function binding(id: string, pid: number, start: string, host: string, superseded = false) {
    const db = getDb();
    db.prepare(
      "INSERT INTO agent_bindings (binding_id, edge_id, agent_name, conversation_id, host_id, window_pid, window_pid_start, bound_via, bound_at, superseded_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'test', '2026-10-01T00:00:00Z', ?)",
    ).run(id, getLocalEdgeId(db), id, "conv-" + id, host, pid, start, superseded ? "2026-10-01T01:00:00Z" : null);
  }

  it("counts only live, same-host, CURRENT anchors whose token matches the legacy form alone", () => {
    const LIVE = process.pid;
    const DEAD = 2_147_483_646;
    anchor("a-legacy", LIVE, LEGACY_T, OWN); // counted
    anchor("a-utc", LIVE, UTC_T, OWN); // migrated
    anchor("a-dead", DEAD, LEGACY_T, OWN); // not live
    anchor("a-foreign", LIVE, LEGACY_T, "other-host"); // not probe-able here
    anchor("a-null-host", LIVE, LEGACY_T, null); // unknown host: never assumed ours
    anchor("a-no-start", LIVE, null, OWN); // no token at all
    anchor("a-reused", LIVE, OTHER_T, OWN); // neither form: a reused pid, not a legacy row
    binding("b-legacy", LIVE, LEGACY_T, OWN); // counted
    binding("b-utc", LIVE, UTC_T, OWN);
    binding("b-superseded", LIVE, LEGACY_T, OWN, true); // not current
    binding("b-foreign", LIVE, LEGACY_T, "other-host"); // another host's window
    const c = countLegacyStartTokens(twoFormRunner(UTC_T, LEGACY_T));
    expect(c).toEqual({ ownHostKnown: true, agents: 1, bindings: 1, total: 2 });
  });

  it("an unknown own host counts nothing and says so (never a false zero)", () => {
    _resetOwnHostIdForTests(null);
    anchor("a-legacy", process.pid, LEGACY_T, OWN);
    expect(countLegacyStartTokens(twoFormRunner(UTC_T, LEGACY_T))).toEqual({ ownHostKnown: false, agents: 0, bindings: 0, total: 0 });
  });
});

describe("migration: a window bound in the legacy form keeps ONE current binding", () => {
  const HOST = "own-host-guid";
  const PID = 4242;
  function cleanup() {
    closeDb();
    if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  const write = (start: string, conversationId = "conv-1") => ({
    hostId: HOST,
    windowPid: PID,
    windowPidStart: start,
    agentName: "w",
    agentClass: null,
    conversationId,
    conversationTitle: null,
    cwd: null,
    boundVia: "test",
  });
  const current = () =>
    getDb()
      .prepare("SELECT binding_id, window_pid_start, conversation_id, end_reason FROM agent_bindings WHERE superseded_at IS NULL")
      .all() as Array<{ binding_id: string; window_pid_start: string; conversation_id: string; end_reason: string | null }>;

  it("a re-bind after the pin REFRESHES the legacy row (moved onto the UTC anchor), never a second current row", () => {
    const db = getDb();
    const legacyRow = upsertAgentBinding(db, write(LEGACY_T));
    const anchor = { hostId: HOST, windowPid: PID, windowPidStart: UTC_T };
    expect(migrateLegacyBindingAnchor(db, anchor, LEGACY_T)).toBe(true);
    const r = upsertAgentBinding(db, write(UTC_T));
    expect(r.action).toBe("refreshed");
    expect(current()).toEqual([{ binding_id: legacyRow.bindingId, window_pid_start: UTC_T, conversation_id: "conv-1", end_reason: null }]);
  });

  it("an end after the pin is recorded on the legacy row", () => {
    const db = getDb();
    upsertAgentBinding(db, write(LEGACY_T));
    const anchor = { hostId: HOST, windowPid: PID, windowPidStart: UTC_T };
    migrateLegacyBindingAnchor(db, anchor, LEGACY_T);
    expect(endAgentBinding(db, anchor, "logout")).toBe(true);
  });

  it("moves nothing when a current row already holds the UTC anchor, or when the forms are equal or unread", () => {
    const db = getDb();
    upsertAgentBinding(db, write(UTC_T));
    const anchor = { hostId: HOST, windowPid: PID, windowPidStart: UTC_T };
    expect(migrateLegacyBindingAnchor(db, anchor, UTC_T)).toBe(false);
    expect(migrateLegacyBindingAnchor(db, anchor, null)).toBe(false);
    // A legacy current row for the same window while the UTC row is current: the unique index refuses
    // the move, and that refusal is false, never a thrown constraint error.
    db.prepare("UPDATE agent_bindings SET window_pid_start = ? WHERE window_pid_start = ?").run(LEGACY_T, UTC_T);
    upsertAgentBinding(db, write(UTC_T, "conv-2"));
    expect(current()).toHaveLength(2);
    expect(migrateLegacyBindingAnchor(db, anchor, LEGACY_T)).toBe(false);
  });

  it("never moves another window's row (pid and host are part of the match)", () => {
    const db = getDb();
    upsertAgentBinding(db, { ...write(LEGACY_T), windowPid: PID + 1 });
    upsertAgentBinding(db, { ...write(LEGACY_T), hostId: "other-host" });
    expect(migrateLegacyBindingAnchor(db, { hostId: HOST, windowPid: PID, windowPidStart: UTC_T }, LEGACY_T)).toBe(false);
  });
});
