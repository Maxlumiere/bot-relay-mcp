// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The process START TOKEN (the PID-reuse guard) has ONE spelling:
 * `TZ=UTC LC_ALL=C ps -o lstart= -p PID`, trimmed, plus the provenance suffix
 * " UTC". `lstart` is a wall-clock date, so a token read under one TZ never
 * matches the same process read under another: a connector and the daemon with
 * different TZ values would read a live process dead (Codex, #295 round 1,
 * MEASURED 15:59:41 UTC vs 23:59:41 SGT).
 *
 * GUARD (metamorphic): the same live pid, read with the reader's TZ set to UTC,
 * Asia/Singapore, America/New_York and unset, gives ONE byte-identical token from
 * every producer: TS processStartedAt, the TS process-table read (the detection
 * path), and the bash relay_pid_start. Un-pinning TZ in any producer turns it red.
 *
 * PROVENANCE (architect ruling, Codex #296 R1 #1): a bare lstart cannot say which
 * zone printed it, so readers DISPATCH on the suffix: suffixed → the UTC form
 * only; unsuffixed → the legacy form only. A cross-form match is impossible.
 *
 * MIGRATION: tokens written before this change are unsuffixed and carry the
 * writer's local time (TZ unset, so /etc/localtime). Readers accept that form,
 * recomputed with TZ REMOVED, never with the reader's inherited TZ, so no live
 * anchor reads dead after the deploy. `relay doctor` counts the live rows still
 * in that form, and never certifies a zero it could not read.
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

const {
  processStartedAt,
  buildProcessTable,
  isAgentProcessAlive,
  anchorLivenessVerdict,
  observeStartTokenForm,
  startTokenEnv,
  START_TOKEN_UTC_SUFFIX,
  readLegacyStartProbe,
  _resetOwnHostIdForTests,
} = await import("../src/liveness.js");
type CommandRunner = import("../src/liveness.js").CommandRunner;
const { closeDb, getDb, registerAgent, getLocalEdgeId, countLegacyStartTokens, upsertAgentBinding, endAgentBinding } = await import(
  "../src/db.js"
);
const { legacyStartTokenCheck } = await import("../src/cli/doctor.js");

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

function psLstart(pid: number, env: NodeJS.ProcessEnv): string {
  return spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", env }).stdout.trim();
}

/** The legacy token a pre-change writer stored (TZ unset → /etc/localtime, no suffix), produced independently of the code under test. */
function legacyReference(pid: number): string {
  const env = { ...process.env, LC_ALL: "C" };
  delete env.TZ;
  return psLstart(pid, env);
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
      // Positive: a real token, the UTC lstart plus the suffix (not merely self-consistent).
      expect(token).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4} UTC$/);
      expect(token).toBe(psLstart(pid, { ...process.env, TZ: "UTC", LC_ALL: "C" }) + " UTC");
    }
  });

  it("the suffix is ONE literal: the bash RELAY_START_TOKEN_UTC_SUFFIX equals the TS START_TOKEN_UTC_SUFFIX", () => {
    expect(START_TOKEN_UTC_SUFFIX).toBe(" UTC");
    const r = spawnSync("bash", ["-c", '. "$1"; printf "%s" "$RELAY_START_TOKEN_UTC_SUFFIX"', "bash", HELPER], { encoding: "utf-8" });
    expect(r.stdout).toBe(START_TOKEN_UTC_SUFFIX);
  });

  it("startTokenEnv pins TZ=UTC and LC_ALL=C over any inherited value; the legacy form REMOVES TZ", () => {
    const base = { TZ: "America/New_York", LC_ALL: "fr_FR.UTF-8", KEEP: "1" };
    expect(startTokenEnv(base)).toEqual({ TZ: "UTC", LC_ALL: "C", KEEP: "1" });
    const legacy = startTokenEnv(base, "legacy");
    expect(legacy).toEqual({ LC_ALL: "C", KEEP: "1" });
    expect("TZ" in legacy).toBe(false);
    expect(base.TZ).toBe("America/New_York"); // the caller's env is not mutated
  });

  it("the legacy recompute is UNSUFFIXED and ignores the reader's inherited TZ (TS and bash both equal the TZ-removed form)", () => {
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
 * A runner whose two forms DIFFER (as on any non-UTC host), so the dispatch is
 * exercised everywhere, including a CI host whose /etc/localtime is UTC. It
 * returns RAW lstart; processStartedAt adds the suffix to the UTC form.
 */
function twoFormRunner(utc: string | null, legacy: string | null, calls?: string[]): CommandRunner {
  return (cmd, args, opts) => {
    if (cmd !== "ps" || !args.includes("lstart=")) return "";
    const form = opts?.startTokenForm ?? "utc";
    calls?.push(form);
    const v = form === "legacy" ? legacy : utc;
    return v === null ? "" : `${v}  \n`;
  };
}
const UTC_RAW = "Thu Oct  1 07:37:33 2026";
const UTC_T = UTC_RAW + " UTC"; // a stored UTC token
const LEGACY_T = "Thu Oct  1 15:37:33 2026"; // the same process, stored before the pin (SGT)
const OTHER_T = "Mon Jan  1 00:00:00 2020";
const alive = () => true;

describe("readers dispatch on the suffix; the legacy form is accepted only unsuffixed", () => {
  const rows: Array<[string, string, string | null, string | null, boolean, string]> = [
    // [label, stored, utc read (raw), legacy read, expected alive, expected observation]
    ["a suffixed token matching the UTC read → alive", UTC_T, UTC_RAW, LEGACY_T, true, "utc"],
    ["an unsuffixed token matching the legacy read → alive (no binding reads dead after the deploy)", LEGACY_T, UTC_RAW, LEGACY_T, true, "legacy"],
    ["a suffixed token matching neither → dead (PID reuse)", OTHER_T + " UTC", UTC_RAW, LEGACY_T, false, "mismatch"],
    ["an unsuffixed token matching neither → dead (PID reuse)", OTHER_T, UTC_RAW, LEGACY_T, false, "mismatch"],
    ["an unsuffixed token equal to the RAW UTC read → dead (never compared across forms)", UTC_RAW, UTC_RAW, LEGACY_T, false, "mismatch"],
    ["a suffixed token, UTC read unreadable → alive (cannot validate → trust the PID, as before)", UTC_T, null, LEGACY_T, true, "unreadable"],
    ["an unsuffixed token, legacy read unreadable → alive (cannot validate → trust the PID)", LEGACY_T, UTC_RAW, null, true, "unreadable"],
  ];
  for (const [label, stored, utcRead, legacyRead, expected, obs] of rows) {
    it(`TS: ${label}`, () => {
      const run = twoFormRunner(utcRead, legacyRead);
      expect(observeStartTokenForm(4242, stored, run)).toBe(obs);
      expect(isAgentProcessAlive(4242, stored, run, alive as never)).toBe(expected);
    });
    it(`bash relay_anchor_liveness agrees: ${label}`, () => {
      // Override only the two PRODUCERS (the verdict logic is the shipped one);
      // the pid is this live process so relay_pid_alive passes for real.
      const prelude =
        `relay_pid_start() { [ -n '${utcRead ?? ""}' ] && printf '%s%s' '${utcRead ?? ""}' "$RELAY_START_TOKEN_UTC_SUFFIX"; }; ` +
        `relay_pid_start_legacy() { printf '%s' '${legacyRead ?? ""}'; }; `;
      const verdict = bash("relay_anchor_liveness", [String(process.pid), stored, "H", "H"], null, prelude);
      expect(verdict).toBe(expected ? "alive" : "dead");
    });
  }

  it("the binder's legacy probe: a token when readable, and an EXPLICIT unreadable (never a silent no-probe) when not", () => {
    expect(readLegacyStartProbe(4242, twoFormRunner(UTC_RAW, LEGACY_T))).toEqual({ start: LEGACY_T });
    expect(readLegacyStartProbe(4242, twoFormRunner(UTC_RAW, null))).toEqual({ unreadable: true });
  });

  it("ONE read per probe: a suffixed token reads only the UTC form, an unsuffixed one only the legacy form", () => {
    const calls: string[] = [];
    observeStartTokenForm(4242, UTC_T, twoFormRunner(UTC_RAW, LEGACY_T, calls));
    expect(calls).toEqual(["utc"]);
    calls.length = 0;
    observeStartTokenForm(4242, LEGACY_T, twoFormRunner(UTC_RAW, LEGACY_T, calls));
    expect(calls).toEqual(["legacy"]);
  });

  // Codex #296 R1 #1, the injection as measured: a New York host (UTC-4). A started
  // at 07:37:33 UTC and stored its token; B reuses the pid at 11:37:33 UTC, so B's
  // LEGACY (local) lstart is 07:37:33, exactly A's UTC lstart.
  const runB = twoFormRunner("Thu Oct  1 11:37:33 2026", "Thu Oct  1 07:37:33 2026");
  const A_TOKEN = "Thu Oct  1 07:37:33 2026 UTC";
  it("Codex R1 #1: a pid reused exactly the zone offset later reads DEAD for the first process's token (TS and bash)", () => {
    expect(isAgentProcessAlive(4242, A_TOKEN, runB, alive as never)).toBe(false);
    const prelude =
      `relay_pid_start() { printf '%s%s' 'Thu Oct  1 11:37:33 2026' "$RELAY_START_TOKEN_UTC_SUFFIX"; }; ` +
      `relay_pid_start_legacy() { printf '%s' 'Thu Oct  1 07:37:33 2026'; }; `;
    expect(bash("relay_anchor_liveness", [String(process.pid), A_TOKEN, "H", "H"], null, prelude)).toBe("dead");
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

function cleanupDb() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

describe("the legacy count is measurable, and never a false zero (gates deleting legacy acceptance)", () => {
  const OWN = "own-host-guid";
  beforeEach(() => {
    cleanupDb();
    _resetOwnHostIdForTests(OWN);
  });
  afterEach(() => {
    cleanupDb();
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
  const LIVE = process.pid;
  const DEAD = 2_147_483_646;

  it("counts only live, same-host, CURRENT, UNSUFFIXED anchors whose token matches the legacy form", () => {
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
    const c = countLegacyStartTokens(twoFormRunner(UTC_RAW, LEGACY_T));
    // b-legacy + b-utc on one window IS the both-forms state, so the anomaly is reported too.
    expect(c).toEqual({
      ownHostKnown: true,
      agents: 1,
      bindings: 1,
      total: 2,
      unreadable: 0,
      duplicateWindows: [{ host_id: OWN, window_pid: LIVE, rows: 2 }],
    });
    expect(legacyStartTokenCheck(c).status).toBe("WARN");
  });

  it("Codex R1 #3: an unreadable ps is cannot-judge, never a certified zero (doctor WARNs, never PASS)", () => {
    anchor("a-legacy", LIVE, LEGACY_T, OWN);
    anchor("a-utc", LIVE, UTC_T, OWN); // a migrated row is not part of the question
    const c = countLegacyStartTokens(twoFormRunner(null, null));
    expect(c).toEqual({ ownHostKnown: true, agents: 0, bindings: 0, total: 0, unreadable: 1, duplicateWindows: [] });
    const check = legacyStartTokenCheck(c);
    expect(check.status).toBe("WARN");
    expect(check.detail).toMatch(/could not be read: cannot judge/);
  });

  it("PASS only on a certified zero", () => {
    anchor("a-utc", LIVE, UTC_T, OWN);
    const c = countLegacyStartTokens(twoFormRunner(UTC_RAW, LEGACY_T));
    expect(c).toEqual({ ownHostKnown: true, agents: 0, bindings: 0, total: 0, unreadable: 0, duplicateWindows: [] });
    expect(legacyStartTokenCheck(c).status).toBe("PASS");
  });

  it("architect 1250296a (b): a window with MORE THAN ONE current binding is reported as an anomaly, listed", () => {
    binding("b-1", LIVE, LEGACY_T, OWN);
    binding("b-2", LIVE, UTC_T, OWN); // the both-forms state: the unique index cannot stop it
    binding("b-other", LIVE + 1, UTC_T, OWN);
    const c = countLegacyStartTokens(twoFormRunner(UTC_RAW, LEGACY_T));
    expect(c.duplicateWindows).toEqual([{ host_id: OWN, window_pid: LIVE, rows: 2 }]);
    const check = legacyStartTokenCheck(c);
    expect(check.status).toBe("WARN");
    expect(check.detail).toContain(`more than one current binding: ${OWN} pid ${LIVE} (2 rows)`);
  });

  it("an unknown own host counts nothing and says so (never a false zero)", () => {
    _resetOwnHostIdForTests(null);
    anchor("a-legacy", LIVE, LEGACY_T, OWN);
    const c = countLegacyStartTokens(twoFormRunner(UTC_RAW, LEGACY_T));
    expect(c).toEqual({ ownHostKnown: false, agents: 0, bindings: 0, total: 0, unreadable: 0, duplicateWindows: [] });
    expect(legacyStartTokenCheck(c).status).toBe("WARN");
  });
});

describe("migration: a window bound in the legacy form keeps ONE current binding", () => {
  const HOST = "own-host-guid";
  const PID = 4242;
  beforeEach(() => cleanupDb());
  afterEach(() => cleanupDb());

  const write = (start: string, agentName = "w", conversationId = "conv-1") => ({
    hostId: HOST,
    windowPid: PID,
    windowPidStart: start,
    agentName,
    agentClass: null,
    conversationId,
    conversationTitle: null,
    cwd: null,
    boundVia: "test",
  });
  const UTC_ANCHOR = { hostId: HOST, windowPid: PID, windowPidStart: UTC_T };
  const current = () =>
    getDb()
      .prepare("SELECT binding_id, agent_name, window_pid_start, conversation_id, end_reason FROM agent_bindings WHERE superseded_at IS NULL")
      .all() as Array<{ binding_id: string; agent_name: string; window_pid_start: string; conversation_id: string; end_reason: string | null }>;

  it("a re-bind after the pin REFRESHES the legacy row (moved onto the UTC anchor in the same transaction), never a second current row", () => {
    const db = getDb();
    const legacyRow = upsertAgentBinding(db, write(LEGACY_T));
    const r = upsertAgentBinding(db, write(UTC_T), { legacy: { start: LEGACY_T } });
    expect(r.action).toBe("refreshed");
    expect(current()).toEqual([
      { binding_id: legacyRow.bindingId, agent_name: "w", window_pid_start: UTC_T, conversation_id: "conv-1", end_reason: null },
    ]);
  });

  it("an end after the pin is recorded on the legacy row", () => {
    const db = getDb();
    upsertAgentBinding(db, write(LEGACY_T));
    expect(endAgentBinding(db, UTC_ANCHOR, "logout", { start: LEGACY_T })).toBe(true);
    expect(current().map((c) => [c.window_pid_start, c.end_reason])).toEqual([[UTC_T, "logout"]]);
  });

  it("Codex R1 #1: B reusing A's pid at the zone offset does NOT inherit A's binding (A's UTC row never moves)", () => {
    const db = getDb();
    // New York: A's UTC token; B's legacy lstart equals A's raw UTC lstart.
    upsertAgentBinding(db, write("Thu Oct  1 07:37:33 2026 UTC", "A"));
    const B = "Thu Oct  1 11:37:33 2026 UTC";
    const r = upsertAgentBinding(db, write(B, "B"), { legacy: { start: "Thu Oct  1 07:37:33 2026" } });
    expect(r.action).toBe("created");
    expect(current().filter((c) => c.window_pid_start === B).map((c) => c.agent_name)).toEqual(["B"]);
    expect(current().find((c) => c.agent_name === "A")?.window_pid_start).toBe("Thu Oct  1 07:37:33 2026 UTC");
  });

  /** The DB, with the FIRST run of the migration statement failing SQLITE_BUSY (another window holding the lock). */
  function busyOnce(real: ReturnType<typeof getDb>, failures = 1) {
    let left = failures;
    return new Proxy(real, {
      get(t, p) {
        if (p === "prepare") {
          return (sql: string) => {
            const st = (t as unknown as { prepare(s: string): unknown }).prepare(sql);
            if (!sql.startsWith("UPDATE agent_bindings SET window_pid_start")) return st;
            return {
              run: (...a: unknown[]) => {
                if (left-- > 0) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
                return (st as { run(...x: unknown[]): unknown }).run(...a);
              },
            };
          };
        }
        const v = (t as unknown as Record<string | symbol, unknown>)[p];
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
  }

  it("Codex R1 #2: a BUSY migration is RETRIED with its upsert, never swallowed into a second current row", () => {
    const real = getDb();
    const legacyRow = upsertAgentBinding(real, write(LEGACY_T));
    const r = upsertAgentBinding(busyOnce(real) as never, write(UTC_T), { legacy: { start: LEGACY_T } });
    expect(r.action).toBe("refreshed");
    expect(current().map((c) => [c.binding_id, c.window_pid_start])).toEqual([[legacyRow.bindingId, UTC_T]]);
  });

  it("Codex R1 #2: contention past the budget FAILS the bind loudly and writes nothing", () => {
    const real = getDb();
    upsertAgentBinding(real, write(LEGACY_T));
    expect(() => upsertAgentBinding(busyOnce(real, 1_000_000) as never, write(UTC_T), { legacy: { start: LEGACY_T }, budgetMs: 300 })).toThrow(
      /bind deadline exceeded/,
    );
    expect(current().map((c) => c.window_pid_start)).toEqual([LEGACY_T]);
  });

  it("Codex R1 #2: a BUSY migration on the end path throws (loud), and ends nothing", () => {
    const real = getDb();
    upsertAgentBinding(real, write(LEGACY_T));
    expect(() => endAgentBinding(busyOnce(real) as never, UTC_ANCHOR, "logout", { start: LEGACY_T })).toThrow(/locked/);
    expect(current().map((c) => [c.window_pid_start, c.end_reason])).toEqual([[LEGACY_T, null]]);
  });

  it("both forms already current for one window: the bind refreshes the UTC row and does not fail on the index", () => {
    const db = getDb();
    upsertAgentBinding(db, write(UTC_T));
    db.prepare("UPDATE agent_bindings SET window_pid_start = ? WHERE window_pid_start = ?").run(LEGACY_T, UTC_T);
    upsertAgentBinding(db, write(UTC_T, "w", "conv-2"));
    expect(current()).toHaveLength(2);
    const r = upsertAgentBinding(db, write(UTC_T, "w", "conv-2"), { legacy: { start: LEGACY_T }, budgetMs: 300 });
    expect(r.action).toBe("refreshed");
  });

  it("Codex R2 #1: an UNREADABLE legacy probe with a pre-UTC current binding for this window REFUSES the bind (loud, nothing written)", () => {
    const db = getDb();
    upsertAgentBinding(db, write(LEGACY_T));
    expect(() => upsertAgentBinding(db, write(UTC_T), { legacy: { unreadable: true }, budgetMs: 300 })).toThrow(
      /start time in the pre-UTC form could not be read/,
    );
    expect(current().map((c) => c.window_pid_start)).toEqual([LEGACY_T]);
    expect(() => endAgentBinding(db, UTC_ANCHOR, "logout", { unreadable: true })).toThrow(/could not be read/);
    expect(current().map((c) => [c.window_pid_start, c.end_reason])).toEqual([[LEGACY_T, null]]);
  });

  it("an unreadable legacy probe with NO pre-UTC current binding for this window binds normally", () => {
    const db = getDb();
    upsertAgentBinding(db, { ...write(LEGACY_T), windowPid: PID + 1 }); // another window's legacy row
    upsertAgentBinding(db, write("Wed Sep 30 01:00:00 2026 UTC", "old", "conv-0")); // this pid, CURRENT, UTC form only
    const r = upsertAgentBinding(db, write(UTC_T), { legacy: { unreadable: true } });
    expect(r.action).toBe("created");
  });

  it("Codex R2 #1: both forms current for one window CONVERGE: the bind supersedes the legacy row by the UTC one", () => {
    const db = getDb();
    const utcRow = upsertAgentBinding(db, write(UTC_T));
    db.prepare(
      "INSERT INTO agent_bindings (binding_id, edge_id, agent_name, conversation_id, host_id, window_pid, window_pid_start, bound_via, bound_at) " +
        "VALUES ('legacy-dup', ?, 'w', 'conv-1', ?, ?, ?, 'test', '2026-09-30T00:00:00Z')",
    ).run(getLocalEdgeId(db), HOST, PID, LEGACY_T);
    expect(current()).toHaveLength(2);
    const r = upsertAgentBinding(db, write(UTC_T), { legacy: { start: LEGACY_T } });
    expect(r.action).toBe("refreshed");
    expect(current().map((c) => c.binding_id)).toEqual([utcRow.bindingId]);
    const legacy = db.prepare("SELECT superseded_by, supersede_reason FROM agent_bindings WHERE binding_id = 'legacy-dup'").get();
    expect(legacy).toEqual({ superseded_by: utcRow.bindingId, supersede_reason: "start-token-migration" });
  });

  it("never moves another window's row (pid and host are part of the match)", () => {
    const db = getDb();
    upsertAgentBinding(db, { ...write(LEGACY_T), windowPid: PID + 1 });
    upsertAgentBinding(db, { ...write(LEGACY_T), hostId: "other-host" });
    const r = upsertAgentBinding(db, write(UTC_T), { legacy: { start: LEGACY_T } });
    expect(r.action).toBe("created");
    expect(current().filter((c) => c.window_pid_start === LEGACY_T)).toHaveLength(2);
  });
});
