// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 7 (plan §v6; architect rulings 23e9b281, 7224605e, 323f69d5, 1a8fc7c4, ffcaf608):
 * `relay watch <agent> --until-wake`, the ZERO-TOKEN wake. The pure trigger and state first, then the
 * REAL CLI. Every watch runs INSIDE a bound test window (tests/helpers/watch-window.ts): a real bash
 * process that the agent is bound to, so ownership (D1) is proven by real process ancestry. Holders,
 * probes and dead holders are separate processes (a second descriptor on a lock file inside the
 * holder's process would drop its POSIX lock).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { openWindow, within, type TestWindow } from "./helpers/watch-window.js";
import { startToken } from "./helpers/start-token.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO, "bin", "relay");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-pr7-watch-")));
const DB = path.join(ROOT, "inst", "relay.db");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const W = await import("../src/watch-wake.js");
const db = await import("../src/db.js");
const { getOwnHostId, processStartedAt, startOrNull } = await import("../src/liveness.js");
const OWN = getOwnHostId();

const RS1 = "1".repeat(64);
const RS2 = "2".repeat(64);
const read = (ids: string[], rs: string | null = RS1, from: Record<string, string> = {}) => ({
  registered: true,
  reading_session: rs,
  ids,
  meta: new Map(ids.map((id) => [id, { from: from[id] ?? "alice", lane: "direct" as const }])),
});

describe("the trigger (pure): each id wakes a session at most ONCE", () => {
  it("nothing woken yet → every pending id wakes, in canonical order", () => {
    expect(W.decideWake(read(["m2", "m1"]), "bob", null, 0).wake).toEqual(["m1", "m2"]);
  });
  it("HARM (the spin trap): ids already woken for in THIS session never wake it again; only new mail does", () => {
    const woken = W.recordWake(null, RS1, ["m1", "m2"], ["m1", "m2"], ["alice"], 0);
    expect(W.decideWake(read(["m1", "m2"]), "bob", woken, 1).wake).toEqual([]);
    expect(W.decideWake(read(["m1", "m2", "m3"]), "bob", woken, 1).wake).toEqual(["m3"]);
  });
  it("V4: a NEW reading session is woken ONCE for its re-pended backlog (the old session's woken set does not apply)", () => {
    const woken = W.recordWake(null, RS1, ["m1"], ["m1"], ["alice"], 0);
    expect(W.decideWake(read(["m1"], RS2), "bob", woken, 1).wake).toEqual(["m1"]);
  });
  it("a NULL reading session is a HOLD: no wake YET (the watch keeps waiting)", () => {
    expect(W.decideWake(read(["m1"], null), "bob", null, 0)).toMatchObject({ wake: [], hold: true });
  });
  it("an unregistered agent wakes nobody", () => {
    expect(W.decideWake({ registered: false, reading_session: RS1, ids: ["m1"] }, "bob", null, 0).wake).toEqual([]);
  });
  it("STANDING: a refused sender's mail never wakes (it stays pending), counted by kind; the default allows all", () => {
    const standing: import("../src/watch-wake.js").StandingCheck = (x) => (x.sender === "mallory" ? { refused: "no_standing" } : "allowed");
    const d = W.decideWake(read(["m1", "m2"], RS1, { m1: "mallory", m2: "alice" }), "bob", null, 0, { standing });
    expect(d.wake).toEqual(["m2"]);
    expect(d.refused).toEqual({ no_standing: 1 });
    expect(W.decideWake(read(["m1"], RS1, { m1: "mallory" }), "bob", null, 0).wake).toEqual(["m1"]);
  });
  it("THE PER-PAIR RATE: a sender that already woke this recipient N times this hour is capped; ANOTHER pair is not (the control)", () => {
    let woken: import("../src/watch-wake.js").WokenState | null = null;
    for (let k = 0; k < W.DEFAULT_PAIR_WAKES_PER_HOUR; k++) woken = W.recordWake(woken, RS1, [`f${k}`], [`f${k}`], ["flooder"], k * 1000);
    const d = W.decideWake(read(["flood-next", "calm"], RS1, { "flood-next": "flooder", calm: "carol" }), "bob", woken, 10_000);
    expect(d.wake).toEqual(["calm"]);
    expect(d.pairCapped).toBe(1);
    // an hour later the pair is free again
    expect(W.decideWake(read(["flood-next"], RS1, { "flood-next": "flooder" }), "bob", woken, W.PAIR_WINDOW_MS + 10_000).wake).toEqual(["flood-next"]);
  });
  it("an all-dot agent name (valid, but a path escape) has NO watch dir; a normal name maps under <db dir>/watch/", () => {
    for (const bad of [".", "..", "...", "a/b", ""]) expect(() => W.watchAgentDir("/i/relay.db", bad)).toThrow(/no watch for this agent name/);
    expect(W.watchAgentDir("/i/relay.db", "a.b")).toBe("/i/watch/a.b");
  });
  it("the persisted set stays BOUNDED: drained ids leave it, and wakes older than an hour are dropped", () => {
    const a = W.recordWake(null, RS1, ["m1", "m2"], ["m1", "m2"], ["alice"], 0);
    const b = W.recordWake(a, RS1, ["m3"], ["m2", "m3"], ["carol"], W.PAIR_WINDOW_MS + 1);
    expect(b.ids).toEqual(["m2", "m3"]);
    expect(b.wakes.map((w) => w.senders)).toEqual([["carol"]]);
  });
});


describe("the watch's state (pure): generations, awake time, the current holder", () => {
  const tmp = () => fs.mkdtempSync(path.join(ROOT, "st-"));
  it("D2: advancing a generation is an O_EXCL create: exactly ONE creator per generation; a later one supersedes, and pruning never un-supersedes", () => {
    const d = tmp();
    expect(W.currentGen(d)).toBe(0);
    expect([W.advanceGen(d, 0), W.advanceGen(d, 0)]).toEqual([true, false]); // two takers of the same N: one wins
    expect(W.currentGen(d)).toBe(1);
    expect(W.superseded(d, 0)).toBe(true);
    expect(W.superseded(d, 1)).toBe(false);
    expect(W.advanceGen(d, 1)).toBe(true);
    W.pruneGenerations(d, 2);
    expect(fs.readdirSync(d).filter((n) => n.startsWith("gen-"))).toEqual(["gen-2"]);
    expect(W.superseded(d, 0)).toBe(true); // gen-1 was pruned, yet generation 0 is still superseded
  });
  it("ruling 1e72ed63: pruning NEVER deletes the highest gen file, even when asked to prune past it", () => {
    const d = tmp();
    W.advanceGen(d, 0);
    W.advanceGen(d, 1); // gen-1, gen-2
    for (const g of [0, 1, 2, 3, 99]) {
      W.pruneGenerations(d, g);
      expect(fs.existsSync(path.join(d, "gen-2")), `prune(${g})`).toBe(true);
      expect(W.currentGen(d)).toBe(2);
    }
    expect(W.superseded(d, 1)).toBe(true);
  });
  it("Codex R2 (c): the AWAKE clock excludes sleep, so awake time ACCUMULATES across any number of sleeps (darwin: mach_absolute_time via sysctl; linux: CLOCK_MONOTONIC)", () => {
    // darwin parse: kern.monotonicclock_usecs = "<usecs> <mach ticks>", hw.tbfrequency = ticks per second
    expect(W.awakeNowMs(() => "116051418370361 2585647162959\n24000000\n", "darwin")).toBe(Math.floor((2585647162959 / 24_000_000) * 1000));
    expect(W.awakeNowMs(() => "garbage\n", "darwin")).toBeNull(); // unreadable → null (never a false stale)
    expect(W.awakeNowMs(() => { throw new Error("no sysctl"); }, "darwin")).toBeNull();
    expect(W.awakeNowMs(() => "", "win32")).toBeNull();
    expect(typeof W.awakeNowMs(() => "", "linux")).toBe("number");
  });
  it("the REAL awake clock on this machine: darwin equals CLOCK_UPTIME_RAW (python) within 2 s, and is below wall time since boot when the host has slept", () => {
    const a = W.awakeNowMs();
    if (process.platform !== "darwin") return void expect(a === null || typeof a === "number").toBe(true);
    const py = spawnSync("python3", ["-c", "import time; print(time.clock_gettime(time.CLOCK_UPTIME_RAW))"], { encoding: "utf-8" });
    if (py.status !== 0) return; // no python here: the parse test above still pins the reading
    expect(Math.abs((a as number) - Number(py.stdout) * 1000)).toBeLessThan(2_000);
  });
  it("a heartbeat counts only for the CURRENT holder (its pid AND its generation): a predecessor's never makes a newborn stale", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, W.watchHolderFile(1)), JSON.stringify({ pid: 42, proc_start: null, host_id: null, since: new Date().toISOString() }));
    W.writeHeartbeat(d, { pid: 41, gen: 0, at: new Date(Date.now() - 3_600_000).toISOString(), awake_ms: -3_600_000 }); // the predecessor's, an hour old
    const s = W.holderBeat(d, 1);
    expect(s.holder?.pid).toBe(42);
    expect(s.beat).toBeNull(); // not this holder's: never judged by it (a holder without its own beat reads live)
  });
});

const O = await import("../src/watch-owner.js");
describe("ownership (pure; ruling ffcaf608 D1): the window a watch descends from, every hop verified", () => {
  // self 300 → shell 200 → window 100 → launchd 1
  const table = (over: Record<number, Partial<{ ppid: number; startedAt: string }>> = {}) =>
    new Map(
      [
        { pid: 300, ppid: 200, startedAt: "S300", command: "node" },
        { pid: 200, ppid: 100, startedAt: "S200", command: "zsh" },
        { pid: 100, ppid: 1, startedAt: "S100", command: "claude" },
      ].map((e) => [e.pid, { ...e, ...(over[e.pid] ?? {}) }]),
    );
  /** A readable start (liveness.ProcessStart). */
  const st = (start: string) => ({ kind: "start" as const, start });
  const bnd = (id: string, pid: number, start: string, agent = "bob", host = "H") => ({ binding_id: id, agent_name: agent, host_id: host, window_pid: pid, window_pid_start: start });
  const deps = (o: Partial<import("../src/watch-owner.js").OwnerDeps> = {}): import("../src/watch-owner.js").OwnerDeps => ({
    table: () => table(),
    startNow: (pid) => st(`S${pid}`),
    sameProcess: (pid, stored) => stored === `S${pid}`,
    liveness: (b) => (b.window_pid === 100 ? "alive" : "dead"),
    ...o,
  });
  it("the bound ancestor window that is the agent's ONE live window → owned, keyed by its pid + start", () => {
    expect(O.resolveOwnership(300, [bnd("b1", 100, "S100")], "H", deps())).toEqual({ ok: true, window: { pid: 100, start: "S100" } }); // the KERNEL's start (the snapshot's), never the stored token
  });
  it("(i) a binding naming the window's pid with ANOTHER start (a recycled pid) is not this window → refused", () => {
    expect(O.resolveOwnership(300, [bnd("b1", 100, "S-OLD")], "H", deps())).toEqual({ ok: false, why: "no_bound_ancestor" });
  });
  it("(i) a hop whose start changed since the snapshot (it is another process now) is never matched", () => {
    expect(O.resolveOwnership(300, [bnd("b1", 100, "S100")], "H", deps({ startNow: (pid) => st(pid === 100 ? "S-NEW" : `S${pid}`) }))).toEqual({ ok: false, why: "no_bound_ancestor" });
  });
  it("(ii) a reparented watch (its parent is init) is refused before anything else", () => {
    expect(O.resolveOwnership(300, [bnd("b1", 100, "S100")], "H", deps({ table: () => table({ 300: { ppid: 1 } }) }))).toEqual({ ok: false, why: "reparented" });
  });
  it("another host's binding with the same pid never matches (the window is judged on its own host only)", () => {
    expect(O.resolveOwnership(300, [bnd("b1", 100, "S100", "bob", "OTHER")], "H", deps())).toEqual({ ok: false, why: "no_bound_ancestor" });
  });
  it("(iii) the ancestor is bound, but a SECOND live window exists → ambiguous; another window is the live one → not_this_window", () => {
    expect(O.resolveOwnership(300, [bnd("b1", 100, "S100"), bnd("b2", 900, "S900")], "H", deps({ liveness: () => "alive" }))).toEqual({ ok: false, why: "ambiguous_binding" });
    const sDeps = { liveness: () => "alive" as const, startNow: (pid: number) => st(`S${pid}`) };
    expect(O.stillOwner({ pid: 100, start: "S100" }, [bnd("b2", 900, "S900")], "H", sDeps, new Set())).toEqual({ ok: false, why: "not_this_window" });
    // the window process itself gone (its pid now runs another start) → window_gone: the watch EXITS (silently)
    expect(O.stillOwner({ pid: 100, start: "S100" }, [bnd("b1", 100, "S100")], "H", { ...sDeps, startNow: () => st("S-OTHER") }, new Set())).toEqual({ ok: false, why: "window_gone" });
    // Codex R2 (b): the SAME window under a migrated token (same binding, another spelling) is still the owner
    expect(O.stillOwner({ pid: 100, start: "S100" }, [bnd("b1", 100, "legacy-spelling-of-S100")], "H", sDeps, new Set())).toEqual({ ok: true, window: "same" });
  });
  it("stillOwner caches a DEAD verdict (dead is permanent for a pid + start) and re-reads every other one", () => {
    const calls: number[] = [];
    const live = (b: { window_pid?: number | null }) => {
      calls.push(b.window_pid as number);
      return b.window_pid === 100 ? ("alive" as const) : ("dead" as const);
    };
    const cache = new Set<string>();
    const bs = [bnd("b1", 100, "S100"), bnd("b0", 50, "S50")];
    const sd = { liveness: live, startNow: (pid: number) => st(`S${pid}`) };
    O.stillOwner({ pid: 100, start: "S100" }, bs, "H", sd, cache);
    O.stillOwner({ pid: 100, start: "S100" }, bs, "H", sd, cache);
    expect(calls).toEqual([100, 50, 100]); // 50 judged once (dead, cached); 100 judged every time
  });
});

// ---------------------------------------------------------------------------------------------------
// The REAL CLI, inside real bound windows. THE INVARIANT (ruling 9becb599): a watch exits only to
// deliver a wake, or (silently) because its window is gone; every other terminal state is DORMANT.

const env = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: path.join(ROOT, "home"), RELAY_DB_PATH: DB, RELAY_FILESYSTEM_MARKERS: "0" });
const WATCH = (agent = "w-bob") => [agent, "--until-wake", "--interval", "1", "--dormant-check-s", "1"];
const ARM_CHECK = (agent = "w-bob") => [agent, "--arm-check"];
const lockStatus = (agent = "w-bob") => spawnSync("node", [RELAY_BIN, "watch", agent, "--lock-status"], { env: env(), encoding: "utf-8" }).stdout.trim();
const send = (to = "w-bob") => db.sendMessage("w-alice", to, "hello", "normal").id;
const relaySnapshot = () => JSON.stringify([db.getDb().prepare("SELECT * FROM messages ORDER BY id").all(), db.getDb().prepare("SELECT * FROM agents ORDER BY name").all()]);
const bind = (agent: string, w: { pid: number }, conv = `conv-${w.pid}`) =>
  db.upsertAgentBinding(db.getDb(), { hostId: OWN as string, windowPid: w.pid, windowPidStart: startToken(w.pid), agentName: agent, agentClass: null, conversationId: conv, conversationTitle: null, cwd: ROOT, boundVia: "launch-intent" });
const winDir = (w: { pid: number }, agent = "w-bob") => W.watchWindowDir(DB, agent, { pid: w.pid, start: startToken(w.pid) });
async function untilStatus(want: string, agent = "w-bob"): Promise<void> {
  for (let i = 0; i < 100 && lockStatus(agent) !== want; i++) await new Promise((r) => setTimeout(r, 150));
  expect(lockStatus(agent)).toBe(want);
}
/** Age the CURRENT holder of `gen`: its own heartbeat, stamped HEARTBEAT_STALE_MS + 1 min ago on the AWAKE clock. */
function ageHolder(dir: string, gen = 0): void {
  const h = JSON.parse(fs.readFileSync(path.join(dir, W.watchHolderFile(gen)), "utf-8"));
  const now = W.awakeNowMs() as number;
  W.writeHeartbeat(dir, { pid: h.pid, gen, at: new Date().toISOString(), awake_ms: now - W.HEARTBEAT_STALE_MS - 60_000 });
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/**
 * ONE read of the dormant RECORDS under `dir`/dormant/. Record names only: the writer's atomic temp
 * (writeJsonAtomic's ".tmp-<hex>", complete once fsynced, renamed after) lives in the same dir and is
 * skipped. An entry that vanishes or cannot be parsed between the listing and its read is skipped
 * ALONE and reported in `skipped`. Flake B: CI OBSERVED "no dormant record" after 770 ms with the record
 * on disk (job 114637509429, attempt 1); a deterministic REPLAY reproduces that triple (found, then
 * empty, then found) via the old helper's one catch around the whole list: the poll accepts the
 * complete TEMP as the record, and the next read, racing its rename, gets ENOENT and returns empty.
 */
function dormantRead(dir: string): { records: Array<{ pid?: unknown; reason?: unknown }>; skipped: Array<{ name: string; error: string }> } {
  const d = path.join(dir, W.DORMANT_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(d);
  } catch (err) {
    return { records: [], skipped: [{ name: "(the dormant dir)", error: err instanceof Error ? err.message : String(err) }] };
  }
  const records: Array<{ pid?: unknown; reason?: unknown }> = [];
  const skipped: Array<{ name: string; error: string }> = [];
  for (const name of names) {
    if (name.startsWith(".")) continue; // the writer's temp: not a record yet
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(d, name), "utf-8")));
    } catch (err) {
      skipped.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { records, skipped };
}
const dormantRecords = (dir: string) => dormantRead(dir).records;

describe("the harness's own dormant reader (flake B): one bad entry never blanks a whole read", () => {
  const mk = () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "dr-"));
    fs.mkdirSync(path.join(dir, W.DORMANT_DIR));
    return dir;
  };
  const rec = (pid: number) => JSON.stringify({ v: 1, pid, proc_start: "x", reason: "r", at: "2026-10-12T00:00:00.000Z" });
  it("the writer's COMPLETE temp (fsynced, not yet renamed) is not a record: skipped, never parsed as one", () => {
    const dir = mk();
    fs.writeFileSync(path.join(dir, W.DORMANT_DIR, ".tmp-0123456789abcdef"), rec(7));
    expect(dormantRecords(dir)).toEqual([]);
  });
  it("HARM: an entry that VANISHES between the listing and its read (ENOENT: a rename racing the read) is skipped ALONE and reported; the other records are still read", () => {
    const dir = mk();
    for (const pid of [7, 8]) fs.writeFileSync(path.join(dir, W.DORMANT_DIR, `${pid}-abc`), rec(pid));
    const real = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((f: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(f).endsWith(`${path.sep}7-abc`)) throw Object.assign(new Error("ENOENT: renamed away"), { code: "ENOENT" });
      return (real as (...a: unknown[]) => unknown)(f, ...rest);
    }) as typeof fs.readFileSync);
    try {
      const r = dormantRead(dir);
      expect(r.records.map((x) => x.pid)).toEqual([8]);
      expect(r.skipped).toEqual([{ name: "7-abc", error: "ENOENT: renamed away" }]);
    } finally {
      spy.mockRestore();
    }
  });
});
const awakeReadable = W.awakeNowMs() !== null;
/**
 * INV-LIVE-01: a PATH seam for `ps`, scoped to THE WATCH's own command (the test's probes read the real
 * ps). Every read takes > 1 s (still under the runner's 2 s timeout, so arming works), and while the
 * STALL flag exists a read sleeps 3 s more: it TIMES OUT and reads empty, deterministically, even for a
 * read already in flight (the flag is checked after the first sleep). Unreadable, while the process lives.
 */
/** POSIX single-quoting, for the shell text of the ps SEAMS this file writes (never for a window command: those are typed). */
const sq = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
const REAL_PS = spawnSync("sh", ["-c", "command -v ps"], { encoding: "utf-8" }).stdout.trim();
const SLOW_PS_DIR = path.join(ROOT, "slow-ps");
const PS_STALL = path.join(SLOW_PS_DIR, "stall");
fs.mkdirSync(SLOW_PS_DIR, { recursive: true });
fs.writeFileSync(path.join(SLOW_PS_DIR, "ps"), `#!/bin/sh\nsleep 1\n[ -e ${sq(PS_STALL)} ] && sleep 3\nexec ${sq(REAL_PS)} "$@"\n`, { mode: 0o755 });
const stallPs = (on: boolean) => (on ? fs.writeFileSync(PS_STALL, "") : fs.rmSync(PS_STALL, { force: true }));
/** The env that puts the slow seam first on the watch's PATH (the window's own PATH is this process's). */
const SLOW_ENV = { PATH: `${SLOW_PS_DIR}:${process.env.PATH ?? ""}` };
/**
 * INV-LIVE-01 R2: a FAST-failing seam for the bound tests. A `ps -o lstart= -p <the window's pid>` exits 1
 * with no output at once (no 2 s timeouts, so timing is deterministic) while the FLAG file exists, or
 * after AFTER such reads. Every other ps (other pids, the process table) is the real one.
 */
const FAIL_PS_DIR = path.join(ROOT, "fail-ps");
fs.mkdirSync(FAIL_PS_DIR, { recursive: true });
fs.writeFileSync(
  path.join(FAIL_PS_DIR, "ps"),
  `#!/bin/sh\ncase " $* " in\n  *" -p $PS_TARGET "*)\n    n=$(cat "$PS_COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$PS_COUNT"\n    if [ -e "$PS_FLAG" ] || [ "$n" -gt "$PS_AFTER" ]; then exit 1; fi ;;\nesac\nexec ${sq(REAL_PS)} "$@"\n`,
  { mode: 0o755 },
);
let failSeq = 0;
/** A watch (bound 3 s of awake time, 1 s checks) whose reads of window `w`'s start fail while `flag` exists, or after `after` of them. */
function failWatch(w: { pid: number }, o: { after?: number; flags?: string[]; env?: Record<string, string> } = {}): { args: string[]; env: Record<string, string>; flag: string; reads: () => number } {
  const n = ++failSeq;
  const flag = path.join(FAIL_PS_DIR, `flag-${n}`);
  const count = path.join(FAIL_PS_DIR, `count-${n}`);
  const env = { PS_TARGET: String(w.pid), PS_FLAG: flag, PS_COUNT: count, PS_AFTER: String(o.after ?? 1_000_000), ...(o.env ?? {}), PATH: `${FAIL_PS_DIR}:${process.env.PATH ?? ""}` };
  const args = ["w-bob", "--until-wake", ...(o.flags ?? ["--interval", "1", "--dormant-check-s", "1", "--anchor-unknown-bound-s", "3"])];
  return { args, env, flag, reads: () => Number(fs.existsSync(count) ? fs.readFileSync(count, "utf-8").trim() : 0) };
}
const on = (flag: string) => fs.writeFileSync(flag, "");
const off = (flag: string) => fs.rmSync(flag, { force: true });
/** The exact blind reason (R2 N5): built from the CAPTURED window anchor, whatever the watch was doing. */
const blindReason = (w: { pid: number }, base: string, boundS = 3) => `${W.ANCHOR_UNOBSERVED_PREFIX} its window (pid ${w.pid}, start ${startToken(w.pid)}) could not be observed for ${boundS} s of awake time in a row (the bound): it is not judged gone and is never re-anchored; dormant because: ${base}`;
const STOPPED_AT_BOUND = "it stopped watching at the bound";

describe.skipIf(!OWN)("the CLI: `relay watch <agent> --until-wake` (zero tokens; inside a bound window)", () => {
  const windows: TestWindow[] = [];
  let win: TestWindow;
  const openWin = (agent: string | null = "w-bob") => {
    const w = openWindow(path.join(ROOT, `win-${windows.length}-${Date.now()}`), env());
    windows.push(w);
    if (agent) bind(agent, w);
    return w;
  };
  beforeEach(async () => {
    for (const w of windows.splice(0)) await w.close();
    db.closeDb();
    fs.rmSync(path.join(ROOT, "inst"), { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, "inst"), { recursive: true });
    db.getDb();
    db.registerAgent("w-alice", "s", []);
    db.registerAgent("w-bob", "r", []);
    win = openWin();
  });
  afterAll(async () => {
    for (const w of windows) await w.close();
  });
  /** THE INVARIANT's second half: a dormant watch is ALIVE while its window lives, and exits SILENTLY (no line) once the window's anchor process dies. */
  async function expectDormantThenSilentExit(r: import("./helpers/watch-window.js").WindowRun, w: TestWindow, reason: RegExp, recordDir: string, anchor: "window" | "parent" = "window"): Promise<void> {
    const pid = await r.pid();
    // ONE read decides: the record is taken from the read that ended the poll, never read a second time.
    const t0 = Date.now();
    let polls = 1;
    let read = dormantRead(recordDir);
    for (; polls < 100 && !read.records.some((x) => x.pid === pid); polls++) {
      await new Promise((res) => setTimeout(res, 100));
      read = dormantRead(recordDir);
    }
    const rec = read.records.find((x) => x.pid === pid) as { reason: string } | undefined;
    // A missing record must say WHY (CI 37729106710 lost it: a bare undefined carried no stderr): the
    // process state, its exit code, the generation, the dir, and the watch's own stderr.
    if (!rec) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(recordDir);
      } catch (err) {
        names = [`(unreadable: ${err instanceof Error ? err.message : String(err)})`];
      }
      expect.fail(`no dormant record for pid ${pid} after ${Date.now() - t0} ms (${polls} reads): skipped=${JSON.stringify(read.skipped)} alive=${alive(pid)} exit=${await within(r.exited, 50)} currentGen=${W.currentGen(recordDir)} dir=[${names.join(", ")}] records_now=${JSON.stringify(dormantRecords(recordDir))}\n--- its stderr ---\n${r.err()}\n--- its stdout ---\n${r.out()}`);
    }
    expect(rec!.reason, r.err()).toMatch(reason);
    expect(await within(r.exited, 2_500)).toBe("timeout"); // NOT exited: dormant
    expect(alive(pid)).toBe(true);
    // The anchor dies: the window (a watch that proved its window), or, for a watch that never did, the
    // process that launched it (its parent).
    const anchorPid = anchor === "window" ? w.pid : Number(spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf-8" }).stdout.trim());
    expect(anchorPid).toBeGreaterThan(1);
    process.kill(anchorPid, "SIGKILL");
    if (anchor === "window") expect(await within(r.exited, 15_000), r.err()).toBe(0);
    else {
      // The parent recorded the exit code; it is gone, so watch the process itself end.
      for (let i = 0; i < 150 && alive(pid); i++) await new Promise((res) => setTimeout(res, 100));
      expect(alive(pid), r.err()).toBe(false);
    }
    expect(r.out()).toBe(""); // silent: no session left to notify
    expect(dormantRecords(recordDir).some((x) => x.pid === pid)).toBe(false); // its record removed on the way out
  }

  it("mail already pending → exits 0 at once with ONE wake line (with the re-arm steps); the relay DB is unchanged (read-only)", async () => {
    send();
    const before = relaySnapshot();
    const r = win.runRelayWatch(WATCH());
    expect(await within(r.exited, 20_000), r.err()).toBe(0);
    expect(r.out().trim().split("\n")).toEqual([expect.stringMatching(/^relay mail pending for w-bob: 1 new message\(s\)\. Call get_messages, then re-arm: run RELAY_DB_PATH='[^']+' '[^']+\/bin\/relay' watch w-bob --arm-check and, if it says arm, the command it gives in the background\.$/)]);
    expect(relaySnapshot()).toBe(before);
  }, 30_000);

  it("HARM (no wake loop): re-armed with the SAME undrained mail it does NOT exit; new mail then wakes it once", async () => {
    send();
    expect(await within(win.runRelayWatch(WATCH()).exited, 20_000)).toBe(0);
    const again = win.runRelayWatch(WATCH());
    expect(await within(again.exited, 3_000)).toBe("timeout");
    send();
    expect(await within(again.exited, 20_000), again.err()).toBe(0);
    expect(again.out()).toMatch(/1 new message\(s\)/);
  }, 40_000);

  it("architect 323f69d5: armed with a NULL session it KEEPS WAITING; the session binds and mail arrives → exactly one wake", async () => {
    db.getDb().prepare("UPDATE agents SET session_id = NULL WHERE name = 'w-bob'").run();
    send();
    const r = win.runRelayWatch(WATCH());
    expect(await within(r.exited, 3_000)).toBe("timeout");
    db.registerAgent("w-bob", "r", []);
    expect(await within(r.exited, 20_000), r.err()).toBe(0);
    expect(r.out().trim().split("\n")).toHaveLength(1);
  }, 40_000);

  it("(b) the window is GONE while a watch waits → it exits SILENTLY (exit 0, no line)", async () => {
    const r = win.runRelayWatch(WATCH());
    await untilStatus("live");
    process.kill(win.pid, "SIGKILL");
    expect(await within(r.exited, 15_000), r.err()).toBe(0);
    expect(r.out()).toBe("");
  }, 40_000);

  it("HARM (the invariant; a mutant exiting on this path → RED): the LOST RACE goes DORMANT, never exits while its window lives; the holder keeps watching", async () => {
    const first = win.runRelayWatch(WATCH());
    await untilStatus("live");
    const second = win.runRelayWatch(WATCH());
    await expectDormantThenSilentExit(second, win, /^already watched/, winDir(win));
    expect(await first.exited).toBe(0); // the holder ended with the window too (silently)
  }, 60_000);

  it("a DEAD holder (SIGKILL) frees the lock by kernel fact: the next watch takes it and wakes", async () => {
    const first = win.runRelayWatch(WATCH());
    await untilStatus("live");
    process.kill(await first.pid(), "SIGKILL");
    await first.exited;
    expect(lockStatus()).toBe("absent");
    send();
    expect(await within(win.runRelayWatch(WATCH()).exited, 20_000)).toBe(0);
  }, 40_000);

  // --- --arm-check: every arm-time refusal, decided in the FOREGROUND ----------------------------------
  it("--arm-check: arm (with the background command), then live once a watch runs", async () => {
    const a = win.runRelayWatch(ARM_CHECK());
    expect(await within(a.exited, 20_000), a.err()).toBe(0);
    expect(a.out().trim()).toMatch(/^arm: start it now as a BACKGROUND task \(run_in_background\), once: RELAY_DB_PATH='[^']+' '[^']+\/bin\/relay' watch w-bob --until-wake$/);
    win.runRelayWatch(WATCH());
    await untilStatus("live");
    const b = win.runRelayWatch(ARM_CHECK());
    expect(await within(b.exited, 20_000)).toBe(0);
    expect(b.out().trim()).toMatch(/^live: a watch for w-bob is already running in this window\. Nothing to do\.$/);
  }, 40_000);

  it("HARM (D1) --arm-check refuses each arm-time case with its why (exit 2): no_bound_ancestor (outside any window, or another agent's), reparented, ambiguous_binding", async () => {
    const direct = spawnSync("node", [RELAY_BIN, "watch", "w-bob", "--arm-check"], { env: env(), encoding: "utf-8", timeout: 30_000 });
    expect([direct.status, direct.stdout.trim()]).toEqual([2, expect.stringMatching(/^no-mail: refused \(no_bound_ancestor\): /)]);
    const alicesWin = openWin("w-alice");
    const inAlice = alicesWin.runRelayWatch(ARM_CHECK("w-bob"));
    expect(await within(inAlice.exited, 20_000)).toBe(2);
    expect(inAlice.out().trim()).toMatch(/^no-mail: refused \(no_bound_ancestor\)/);
    const O2 = path.join(ROOT, "reparented-arm.out");
    win.runRelayWatchOrphaned(ARM_CHECK(), O2);
    let out = "";
    for (let i = 0; i < 200 && !/no-mail|arm:/.test(out); i++) {
      await new Promise((r) => setTimeout(r, 100));
      out = fs.existsSync(O2) ? fs.readFileSync(O2, "utf-8") : "";
    }
    // darwin: the orphan's parent is launchd (pid 1). linux may use a SUBREAPER: its chain holds no bound window.
    expect(out.trim()).toMatch(process.platform === "darwin" ? /^no-mail: refused \(reparented\): / : /^no-mail: refused \((reparented|no_bound_ancestor)\): /);
    openWin("w-bob"); // a second live window
    const amb = win.runRelayWatch(ARM_CHECK());
    expect(await within(amb.exited, 20_000)).toBe(2);
    expect(amb.out().trim()).toMatch(/^no-mail: refused \(ambiguous_binding\)/);
  }, 60_000);

  it("a refusal discovered AFTER launch (no arm-check run) → DORMANT under its launching shell, never an exit while that shell lives", async () => {
    const shell = openWin(null); // a shell bound to NOBODY
    const r = shell.runRelayWatch(WATCH());
    await expectDormantThenSilentExit(r, shell, /^refused \(no_bound_ancestor\)/, W.watchAgentDir(DB, "w-bob"), "parent");
  }, 60_000);

  // --- D1 while running: the binding moves → dormant; the new window arms its own --------------------
  it("D1 (iii): a second live window binds while the watch runs → DORMANT (binding moved), silent exit with its window", async () => {
    const r = win.runRelayWatch(WATCH());
    await untilStatus("live");
    openWin("w-bob");
    await expectDormantThenSilentExit(r, win, /^binding moved \(ambiguous_binding\)/, winDir(win));
  }, 60_000);

  // --- THE REBIND (Codex R1 #1 on #313; flake d; architect ruling 0d16ef24): production rebinds in TWO separate
  // commits, one per window (relay bind upserts only its own window), so A's watch can observe any of three
  // intermediate states. Each is TRUE at the instant A reads it, and each is made DETERMINISTIC here by
  // controlling when A's check runs. THE CONTRACT, in every order: A goes DORMANT (the exact reason for that
  // order), A never wakes for mail now owned by B, and B arms its own watch and wakes. No grace window.
  /** Production's rebind of window `w` AWAY from w-bob: its OWN upsert (one commit), a new conversation, no agent. */
  const rebindAway = (w: { pid: number }) =>
    db.upsertAgentBinding(db.getDb(), { hostId: OWN as string, windowPid: w.pid, windowPidStart: startToken(w.pid), agentName: null, agentClass: null, conversationId: `conv-${w.pid}-next`, conversationTitle: null, cwd: ROOT, boundVia: "launch-intent" });
  const MOVED = {
    no_live_window: "binding moved (no_live_window): the agent has no live bound window",
    not_this_window: "binding moved (not_this_window): the agent's live window is another one (this one is not the agent's current window)",
    ambiguous_binding: "binding moved (ambiguous_binding): the agent has two or more windows not proven closed (never guessed)",
  } as const;
  const dormantOf = (dir: string, pid: number) => dormantRecords(dir).find((x) => x.pid === pid);
  /** A's dormant record, once it exists; THROWS after 10 s (a timeout must never let a scenario cross its barrier). */
  async function untilDormant(dir: string, pid: number): Promise<{ reason?: unknown }> {
    for (let i = 0; i < 100; i++) {
      const r = dormantOf(dir, pid);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error(`no dormant record for pid ${pid} in ${dir} after 10 s`);
  }
  /**
   * A process's identity for signalling (Codex R2 P2 on #331): its start token, parent pid and command. Captured
   * when the watch starts, verified again right before each signal; a mismatch (the pid reused) refuses.
   * RESIDUAL (stated): a check-to-signal race remains, microseconds wide; a parent-controlled signalling
   * mechanism (no reaping during the operation) is out of scope for a test fix.
   */
  const identityOf = (pid: number): string => {
    const r = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf-8" });
    return `${startOrNull(processStartedAt(pid)) ?? "(no start)"} | ${r.stdout.trim().replace(/\s+/g, " ")}`;
  };
  const stateOf = (pid: number): string => spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf-8" }).stdout.trim();
  async function pollUntil(cond: () => boolean, ms: number): Promise<boolean> {
    for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
      if (cond()) return true;
      await new Promise((res) => setTimeout(res, 20));
    }
    return cond();
  }
  /** Signal the RECORDED watch pid only after re-verifying it is the same process (pid > 1, identity unchanged). */
  const signalVerified = (pid: number, identity: string, sig: NodeJS.Signals): void => {
    expect(pid).toBeGreaterThan(1); // a single process, never a group
    const now = identityOf(pid);
    if (now !== identity) throw new Error(`refusing to send ${sig} to pid ${pid}: it is not the watch any more (was "${identity}", now "${now}")`);
    process.kill(pid, sig);
  };
  /** The contract after A's dormancy: A's exact reason, A alive and never woken, B arms and wakes for the mail. */
  async function rebindContract(a: import("./helpers/watch-window.js").WindowRun, aPid: number, aDir: string, winB: TestWindow, reason: string): Promise<void> {
    expect((await untilDormant(aDir, aPid)).reason, a.err()).toBe(reason);
    expect(alive(aPid)).toBe(true);
    const b = winB.runRelayWatch(WATCH());
    await untilStatus("live");
    send();
    expect(await within(b.exited, 20_000), b.err()).toBe(0);
    expect(b.out()).toMatch(/^relay mail pending for w-bob: 1 new message/);
    expect(await within(a.exited, 1_000)).toBe("timeout"); // A never woke for B's mail: still dormant
    expect(a.out()).toBe("");
  }

  it("HARM (rebind, order a): A rebinds away, A's check runs BETWEEN the two commits, then B binds → A dormant with exactly no_live_window; A never wakes for B's mail; B arms and wakes", async () => {
    const a = win.runRelayWatch(WATCH());
    await untilStatus("live");
    const aDir = winDir(win);
    const aPid = await a.pid();
    const winB = openWin(null); // the slow window-open first, unbound
    rebindAway(win); // commit 1: w-bob has NO current binding now
    const seen = await untilDormant(aDir, aPid); // A's check runs here, between the commits (or this throws)
    expect(seen.reason, a.err()).toBe(MOVED.no_live_window); // OBSERVED before commit 2
    bind("w-bob", winB); // commit 2
    await rebindContract(a, aPid, aDir, winB, MOVED.no_live_window);
  }, 60_000);

  it("HARM (rebind, order b): A rebinds away and B binds, A's check runs only AFTER both commits → A dormant with exactly not_this_window; A never wakes for B's mail; B arms and wakes", async () => {
    const a = win.runRelayWatch(WATCH());
    await untilStatus("live");
    const aDir = winDir(win);
    const aPid = await a.pid();
    expect(aPid).toBeGreaterThan(1); // a RECORDED pid, never a group: signalled below
    const aId = identityOf(aPid); // captured while the watch is known to run (it is live)
    const winB = openWin(null); // the slow window-open first, unbound
    // A's checks are held for the two commits, so its next check sees both. SIGSTOP/SIGCONT only this test's
    // own watch process, identity-verified. BARRIER (Codex R2 P2): no write before ps reports A STOPPED.
    signalVerified(aPid, aId, "SIGSTOP");
    try {
      if (!(await pollUntil(() => stateOf(aPid).startsWith("T"), 2_000))) {
        throw new Error(`pid ${aPid} never reported stopped (ps stat "${stateOf(aPid)}"): no write was made`);
      }
      rebindAway(win); // commit 1
      bind("w-bob", winB); // commit 2
    } finally {
      signalVerified(aPid, aId, "SIGCONT");
    }
    expect(await pollUntil(() => !stateOf(aPid).startsWith("T"), 2_000), `pid ${aPid} still stopped after SIGCONT`).toBe(true);
    await rebindContract(a, aPid, aDir, winB, MOVED.not_this_window);
  }, 60_000);

  it("HARM (rebind, order c): B binds while A is STILL w-bob, A's check runs then, then A rebinds away → A dormant with exactly ambiguous_binding; A never wakes for B's mail; B arms and wakes", async () => {
    const a = win.runRelayWatch(WATCH());
    await untilStatus("live");
    const aDir = winDir(win);
    const aPid = await a.pid();
    const winB = openWin(null);
    bind("w-bob", winB); // commit 1: two windows for w-bob, neither proven closed
    const seen = await untilDormant(aDir, aPid); // A's check runs here (or this throws)
    expect(seen.reason, a.err()).toBe(MOVED.ambiguous_binding); // OBSERVED before commit 2
    rebindAway(win); // commit 2: B is now w-bob's one live window
    await rebindContract(a, aPid, aDir, winB, MOVED.ambiguous_binding);
  }, 60_000);

  it("HARM (Codex R2 (b)): the binding's start token is MIGRATED to the legacy form under the same binding → the SAME watch stays the owner and the status still sees it (no second watch)", async () => {
    const r = win.runRelayWatch(WATCH());
    await untilStatus("live");
    const legacy = startToken(win.pid, "legacy");
    expect(legacy).not.toBe(startToken(win.pid)); // precondition: two different spellings
    db.getDb().prepare("UPDATE agent_bindings SET window_pid_start = ? WHERE window_pid = ?").run(legacy, win.pid);
    await new Promise((res) => setTimeout(res, 2_500)); // a few checks
    expect(lockStatus()).toBe("live"); // the status keys the same dir
    const again = win.runRelayWatch(ARM_CHECK());
    expect(await within(again.exited, 20_000)).toBe(0);
    expect(again.out()).toMatch(/^live: /); // no second watch would be armed
    expect(await within(r.exited, 500)).toBe("timeout");
    expect(dormantRecords(winDir(win))).toEqual([]); // the holder never went dormant
    send();
    expect(await within(r.exited, 20_000), r.err()).toBe(0); // and it still wakes
  }, 60_000);

  // --- D2: a hung holder is ABANDONED by generation, never signalled; the abandoned one goes dormant ----
  it.skipIf(!awakeReadable)("HARM (D2): a HUNG holder (SIGSTOP'd, stale on the AWAKE clock) is abandoned: the re-arm takes generation 1 and wakes; the hung process is NEVER signalled; resumed, it goes DORMANT (superseded)", async () => {
    const hung = win.runRelayWatch(WATCH());
    await untilStatus("live");
    const hungPid = await hung.pid();
    process.kill(hungPid, "SIGSTOP");
    ageHolder(winDir(win));
    expect(lockStatus()).toBe("stale");
    const next = win.runRelayWatch(WATCH());
    await untilStatus("live");
    expect(W.currentGen(winDir(win))).toBe(1);
    expect(next.err()).toMatch(/generation 0\) is hung: abandoned it; contesting generation 1 \(nothing is signalled\)/);
    expect(alive(hungPid)).toBe(true);
    send();
    expect(await within(next.exited, 20_000), next.err()).toBe(0);
    process.kill(hungPid, "SIGCONT"); // only the TEST resumes it
    await expectDormantThenSilentExit(hung, win, /^superseded: /, winDir(win));
  }, 90_000);

  // --- INV-LIVE-01 (rulings 476e65f1 + fedac068): UNREADABLE IS NOT GONE --------------------------------
  it.skipIf(!REAL_PS)("HARM (INV-LIVE-01, the PIN): a ps OUTAGE (every read times out, the window alive) never ends a watch; once ps answers again, it still delivers the wake", async () => {
    const r = win.runRelayWatch(WATCH(), { env: SLOW_ENV });
    await untilStatus("live");
    const pid = await r.pid();
    try {
      stallPs(true);
      // ~2 checks of two timed-out reads each: before the fix the FIRST read ended the watch (window_gone, silent)
      expect(await within(r.exited, 9_000), r.err()).toBe("timeout");
      expect(alive(pid)).toBe(true);
      expect(r.out()).toBe("");
    } finally {
      stallPs(false);
    }
    send();
    expect(await within(r.exited, 20_000), r.err()).toBe(0);
    expect(r.out()).toMatch(/^relay mail pending for w-bob: 1 new message\(s\)/);
  }, 60_000);

  // SCENARIO coverage, NOT the red-on-revert evidence (the PIN above is: 3/3 red on main adbe4ae). On the
  // pre-fix code this goes red only when the stop lands in the WINDOW's own read (MEASURED 1/3 on
  // adbe4ae): a stop in the binding read was already unreadable-safe, and the next check sees superseded first.
  it.skipIf(!awakeReadable || !REAL_PS)("HARM (INV-LIVE-01, the D2 signature):a hung holder stopped MID-READ, its read timing out on resume, goes DORMANT (superseded), never a silent exit", async () => {
    const hung = win.runRelayWatch(WATCH(), { env: SLOW_ENV });
    await untilStatus("live");
    const hungPid = await hung.pid();
    expect(hungPid).toBeGreaterThan(1);
    try {
      await new Promise((res) => setTimeout(res, 1_500)); // inside its check loop: ~all of it is synchronous ps time
      process.kill(hungPid, "SIGSTOP");
      stallPs(true); // the read in flight now sleeps past its 2 s timeout: it times out when the holder resumes
      ageHolder(winDir(win));
      expect(lockStatus()).toBe("stale");
      const next = win.runRelayWatch(WATCH());
      await untilStatus("live");
      expect(W.currentGen(winDir(win))).toBe(1);
      send();
      expect(await within(next.exited, 20_000), next.err()).toBe(0);
      process.kill(hungPid, "SIGCONT"); // only the TEST resumes it
      await expectDormantThenSilentExit(hung, win, /^superseded: /, winDir(win));
    } finally {
      stallPs(false);
    }
  }, 120_000);

  it.skipIf(!REAL_PS)("the TWIN (INV-LIVE-01): DURING the same ps outage, a REALLY closed window still ends its watch silently, within a bound (the fix cannot make a watch immortal)", async () => {
    const r = win.runRelayWatch(WATCH(), { env: SLOW_ENV });
    await untilStatus("live");
    try {
      stallPs(true);
      const t0 = Date.now();
      process.kill(win.pid, "SIGKILL");
      expect(await within(r.exited, 15_000), r.err()).toBe(0); // gone is the KERNEL's answer (ESRCH): no ps needed
      expect(r.out()).toBe("");
      expect(Date.now() - t0).toBeLessThan(15_000);
    } finally {
      stallPs(false);
    }
  }, 60_000);

  // --- BOUNDEDNESS (architect ruling a98ec836; Codex R2 N1/N4/N5): a window unobservable for the whole
  // bound (3 s of AWAKE time here) is LOUD, never silent, never early. Reads fail FAST (failWatch).
  const mineIn = (dir: string, pid: number) => dormantRecords(dir).filter((x) => x.pid === pid);
  async function until(cond: () => boolean, ms: number): Promise<boolean> {
    for (const t0 = Date.now(); Date.now() - t0 < ms; ) {
      if (cond()) return true;
      await new Promise((res) => setTimeout(res, 50));
    }
    return cond();
  }

  it.skipIf(!REAL_PS)("HARM (BOUNDEDNESS, the PIN): its window unobservable for the WHOLE bound → DORMANT with a cannot_observe(anchor) record naming the captured anchor (never window_gone, never re-anchored), alive; relay doctor names it; readable again → quiet; the window closing still ends it", async () => {
    const f = failWatch(win);
    const r = win.runRelayWatch(f.args, { env: f.env });
    await untilStatus("live");
    const pid = await r.pid();
    const { checkBlindWatches } = await import("../src/cli/doctor.js");
    const t0 = Date.now();
    on(f.flag);
    try {
      expect(await until(() => mineIn(winDir(win), pid).length > 0, 20_000), r.err()).toBe(true);
      const rec = mineIn(winDir(win), pid)[0] as { reason: string; at: string; anchor?: unknown };
      expect(rec.reason).toBe(blindReason(win, STOPPED_AT_BOUND));
      expect(rec.anchor).toEqual({ pid: win.pid, start: startToken(win.pid) });
      expect(Date.parse(rec.at) - t0, "never early: the bound is 3 s of awake time").toBeGreaterThanOrEqual(2_950);
      expect(await within(r.exited, 500)).toBe("timeout"); // DORMANT, not exited
      expect((await checkBlindWatches(DB)).status).toBe("WARN");
    } finally {
      off(f.flag);
    }
    expect(await until(() => mineIn(winDir(win), pid)[0]?.reason === STOPPED_AT_BOUND, 10_000), r.err()).toBe(true);
    expect((await checkBlindWatches(DB)).status).toBe("PASS");
    process.kill(win.pid, "SIGKILL");
    expect(await within(r.exited, 15_000), r.err()).toBe(0);
    expect(r.out()).toBe("");
  }, 60_000);

  it.skipIf(!REAL_PS)("HARM (R2 N1): a BURST of event-triggered checks (marker traffic) and fast failures never bring the bound EARLY: no record before 3 s of awake time", async () => {
    const markers = fs.mkdtempSync(path.join(ROOT, "markers-"));
    const f = failWatch(win, { env: { RELAY_FILESYSTEM_MARKERS: "1", RELAY_MARKER_DIR: markers } });
    const r = win.runRelayWatch(f.args, { env: f.env });
    await untilStatus("live");
    const pid = await r.pid();
    const t0 = Date.now();
    on(f.flag);
    try {
      // ~250 events in 2.5 s: another agent's marker traffic. Each one triggers a check.
      for (let i = 0; Date.now() - t0 < 2_500; i++) {
        fs.writeFileSync(path.join(markers, `other-${i % 7}.touch`), String(i));
        await new Promise((res) => setTimeout(res, 10));
      }
      expect(mineIn(winDir(win), pid), `no record within 2.5 s (reads so far: ${f.reads()})`).toEqual([]);
      expect(f.reads()).toBeGreaterThan(20); // the burst really drove many failing checks
      expect(await until(() => mineIn(winDir(win), pid).length > 0, 15_000), r.err()).toBe(true);
      expect(Date.parse(String(mineIn(winDir(win), pid)[0].at)) - t0).toBeGreaterThanOrEqual(2_950);
    } finally {
      off(f.flag);
    }
  }, 60_000);

  it.skipIf(!REAL_PS)("HARM (R2 N1): the IMMEDIATE first check never earns credit: --interval 7200 with a 2 h bound and every read failing from that check on → still watching (it read the window as unknown and did not go dormant)", async () => {
    const f = failWatch(win, { after: 3, flags: ["--interval", "7200", "--dormant-check-s", "1", "--anchor-unknown-bound-s", "7200"] }); // ownership reads the window 3 times
    const r = win.runRelayWatch(f.args, { env: f.env });
    const pid = await r.pid();
    await new Promise((res) => setTimeout(res, 6_000)); // arming + the immediate check + seconds of dormant-tick time
    expect(f.reads(), "the first check's read did fail").toBeGreaterThan(3);
    expect(dormantRecords(winDir(win)).filter((x) => x.pid === pid), r.err()).toEqual([]);
    expect(lockStatus()).toBe("live");
    expect(await within(r.exited, 100)).toBe("timeout");
  }, 30_000);

  it.skipIf(!REAL_PS)("the TWIN (BOUNDEDNESS): two outages, each SHORTER than the bound, with readable checks between → it resets, never goes dormant, and still wakes (without the reset: 5+ s of unknown ≥ 3 s)", async () => {
    const f = failWatch(win);
    const r = win.runRelayWatch(f.args, { env: f.env });
    await untilStatus("live");
    const pid = await r.pid();
    try {
      for (let round = 0; round < 2; round++) {
        on(f.flag);
        await new Promise((res) => setTimeout(res, 2_000));
        off(f.flag);
        await new Promise((res) => setTimeout(res, 3_000));
      }
    } finally {
      off(f.flag);
    }
    expect(mineIn(winDir(win), pid), r.err()).toEqual([]);
    send();
    expect(await within(r.exited, 20_000), r.err()).toBe(0);
    expect(r.out()).toMatch(/^relay mail pending for w-bob: 1 new message\(s\)/);
  }, 60_000);

  it.skipIf(!REAL_PS)("HARM (BOUNDEDNESS, dormant; R2 N5): a watch ALREADY dormant (the lost race) blind for the bound → its record names the CAPTURED anchor (pid + start) and why it was dormant; readable again → quiet; it never exits on it", async () => {
    win.runRelayWatch(WATCH());
    await untilStatus("live");
    const f = failWatch(win);
    const loser = win.runRelayWatch(f.args, { env: f.env });
    const pid = await loser.pid();
    const base = "already watched: a watch for this agent is already live in this window";
    expect(await until(() => mineIn(winDir(win), pid).length > 0, 10_000), loser.err()).toBe(true);
    expect(mineIn(winDir(win), pid)[0].reason).toBe(base);
    on(f.flag);
    try {
      expect(await until(() => mineIn(winDir(win), pid)[0]?.reason !== base, 15_000), loser.err()).toBe(true);
      expect(mineIn(winDir(win), pid)[0].reason).toBe(blindReason(win, base));
      expect(await within(loser.exited, 300)).toBe("timeout");
    } finally {
      off(f.flag);
    }
    expect(await until(() => mineIn(winDir(win), pid)[0]?.reason === base, 10_000), loser.err()).toBe(true);
    expect(alive(pid)).toBe(true);
  }, 60_000);

  // R2 N4: durable loudness survives a failed write. chmod runs only on this test's own temp dir (under
  // ROOT, a mkdtemp; HOME is sandboxed by env()), and is restored in `finally`.
  async function withDormantDirLocked<T>(dir: string, fn: (unlock: () => void) => Promise<T>): Promise<T> {
    const d = path.join(dir, W.DORMANT_DIR);
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.chmodSync(d, 0o500);
    const unlock = () => fs.chmodSync(d, 0o700);
    try {
      return await fn(unlock);
    } finally {
      unlock();
    }
  }

  it.skipIf(!REAL_PS || process.getuid?.() === 0)("HARM (R2 N4): the blind record's FIRST write fails (dormant/ unwritable) → retried on later ticks: written once the dir is writable again", async () => {
    const f = failWatch(win);
    const r = win.runRelayWatch(f.args, { env: f.env });
    await untilStatus("live");
    const pid = await r.pid();
    await withDormantDirLocked(winDir(win), async (unlock) => {
      on(f.flag);
      try {
        expect(await until(() => lockStatus() === "absent", 20_000), r.err()).toBe(true); // dormant: its lock is released
        expect(r.err()).toMatch(/DEGRADED: the dormant record for w-bob could not be written/);
        expect(mineIn(winDir(win), pid)).toEqual([]);
        unlock();
        expect(await until(() => mineIn(winDir(win), pid).length > 0, 10_000), r.err()).toBe(true);
        expect(String(mineIn(winDir(win), pid)[0].reason).startsWith(W.ANCHOR_UNOBSERVED_PREFIX)).toBe(true);
      } finally {
        off(f.flag);
      }
    });
  }, 60_000);

  it.skipIf(!REAL_PS || process.getuid?.() === 0)("HARM (R2 N4): the RECOVERY write fails (dormant/ unwritable) → retried: the record goes quiet once the dir is writable, never left blind", async () => {
    const f = failWatch(win);
    const r = win.runRelayWatch(f.args, { env: f.env });
    await untilStatus("live");
    const pid = await r.pid();
    const isBlind = () => String(mineIn(winDir(win), pid)[0]?.reason).startsWith(W.ANCHOR_UNOBSERVED_PREFIX);
    on(f.flag);
    expect(await until(isBlind, 20_000), r.err()).toBe(true);
    await withDormantDirLocked(winDir(win), async (unlock) => {
      off(f.flag); // readable again: the quiet rewrite is attempted and fails
      await new Promise((res) => setTimeout(res, 3_000));
      expect(isBlind(), "still blind: the quiet write could not land").toBe(true);
      unlock();
      expect(await until(() => mineIn(winDir(win), pid).length > 0 && !isBlind(), 10_000), r.err()).toBe(true);
    });
  }, 60_000);

  it.skipIf(!REAL_PS)("HARM (R2 N4, recordDir=null path): the watch dir unusable at arming (a planted symlink) → DORMANT, and its record is written once the dir is a real one (retried, never silently skipped); the symlink's target is never written", async () => {
    const agentDir = W.watchAgentDir(DB, "w-bob");
    const target = fs.mkdtempSync(path.join(ROOT, "elsewhere-"));
    fs.mkdirSync(path.dirname(agentDir), { recursive: true, mode: 0o700 });
    fs.symlinkSync(target, agentDir);
    const r = win.runRelayWatch(WATCH());
    const pid = await r.pid();
    try {
      expect(await until(() => /DORMANT \(the watch dir is unusable\)/.test(r.err()), 10_000), r.err()).toBe(true);
      expect(fs.readdirSync(target)).toEqual([]);
      fs.unlinkSync(agentDir); // the link itself (rmSync would follow it)
      fs.mkdirSync(agentDir, { mode: 0o700 });
      expect(await until(() => mineIn(winDir(win), pid).length > 0, 10_000), r.err()).toBe(true);
      expect(mineIn(winDir(win), pid)[0].reason).toBe("the watch dir is unusable");
      expect(fs.readdirSync(target)).toEqual([]);
    } finally {
      try {
        if (fs.lstatSync(agentDir).isSymbolicLink()) fs.unlinkSync(agentDir);
      } catch {
        /* gone */
      }
    }
  }, 40_000);

  // INV-LIVE-01 plan P1 (TAKEOVER class): the reader's awake clock UNREADABLE → no takeover. Bar: an aged
  // holder reads stale with the clock and live without it. (The `awakeNow === null` clause is belt: JS
  // `null - n` is negative, so a mutant deleting it alone stays green; one judging null stale goes red.)
  it.skipIf(!awakeReadable)("P1 (INV-LIVE-01): an aged holder is stale on a readable awake clock, and LIVE when the reader's awake clock is unreadable (never a takeover on it)", async () => {
    win.runRelayWatch(WATCH());
    await untilStatus("live");
    ageHolder(winDir(win));
    expect(W.watchStatus(winDir(win))).toBe("stale");
    expect(W.watchStatus(winDir(win), null)).toBe("live");
  }, 40_000);

  it("a LIVE holder is never abandoned, even with a PREDECESSOR's ancient heartbeat (it counts only its own)", async () => {
    const first = win.runRelayWatch(WATCH());
    await untilStatus("live");
    W.writeHeartbeat(winDir(win), { pid: 999_999, gen: 0, at: new Date().toISOString(), awake_ms: -10_000_000 });
    expect(lockStatus()).toBe("live");
    expect(W.currentGen(winDir(win))).toBe(0);
    expect(alive(await first.pid())).toBe(true);
  }, 40_000);

  it("Codex R2 (c): a holder with NO readable awake stamp is never judged stale (no false takeover after a long sleep)", async () => {
    win.runRelayWatch(WATCH());
    await untilStatus("live");
    const dir = winDir(win);
    const h = JSON.parse(fs.readFileSync(path.join(dir, W.watchHolderFile(0)), "utf-8"));
    W.writeHeartbeat(dir, { pid: h.pid, gen: 0, at: new Date(Date.now() - 86_400_000).toISOString(), awake_ms: null }); // a day of WALL time, no awake stamp
    expect(lockStatus()).toBe("live");
  }, 40_000);

  // --- Codex R1 #3: emit first, persist after ---------------------------------------------------------
  it("HARM (Codex R1 #3): the wake is EMITTED even when recording it fails; the next watch wakes AGAIN for the same mail (a duplicate, never a missed wake)", async () => {
    send();
    const dir = winDir(win);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dir, W.WOKEN_FILE));
    const r = win.runRelayWatch(WATCH());
    expect(await within(r.exited, 20_000), r.err()).toBe(0);
    expect(r.out()).toMatch(/^relay mail pending for w-bob: 1 new message/);
    expect(r.err()).toMatch(/could not record what it woke for/);
    const again = win.runRelayWatch(WATCH());
    expect(await within(again.exited, 20_000), again.err()).toBe(0);
    expect(again.out()).toMatch(/^relay mail pending for w-bob: 1 new message/);
  }, 40_000);

  it("its lock file REMOVED under it (the dir deleted) → DORMANT (lock lost), never a second watch beside it; silent exit with its window", async () => {
    const r = win.runRelayWatch(WATCH());
    await untilStatus("live");
    fs.rmSync(W.watchAgentDir(DB, "w-bob"), { recursive: true, force: true });
    await expectDormantThenSilentExit(r, win, /^lock lost: /, winDir(win));
  }, 60_000);

  it("the agent UNREGISTERED while watching → DORMANT (unregistered)", async () => {
    const r = win.runRelayWatch(WATCH());
    await untilStatus("live");
    db.getDb().prepare("DELETE FROM agents WHERE name = 'w-bob'").run();
    await expectDormantThenSilentExit(r, win, /^unregistered: /, winDir(win));
  }, 60_000);

  it("a signal (a deliberate TaskStop) exits with a no-mail line", async () => {
    const r = win.runRelayWatch(WATCH());
    await untilStatus("live");
    process.kill(await r.pid(), "SIGTERM");
    expect(await within(r.exited, 10_000)).toBe(0);
    expect(r.out().trim()).toMatch(/^no-mail: stopped \(signal\)/);
  }, 30_000);

  it("the commands it prints are RUNNABLE: they name this DB and this CLI, quoted (the path has spaces in production)", async () => {
    const { rearmCommand, armCheckCommand, shq } = await import("../src/cli/watch-until-wake.js");
    expect(shq("/a b/it's")).toBe("'/a b/it'\\''s'");
    for (const [cmd, last] of [[rearmCommand("w-bob", "/x y/relay.db", "/Claude AI/bin/relay"), "--until-wake"], [armCheckCommand("w-bob", "/x y/relay.db", "/Claude AI/bin/relay"), "--arm-check"]] as const) {
      expect(spawnSync("bash", ["-c", `set -- ${cmd.replace(/^RELAY_DB_PATH=/, "")}; printf '%s\\n' "$@"`], { encoding: "utf-8" }).stdout).toBe(`/x y/relay.db\n/Claude AI/bin/relay\nwatch\nw-bob\n${last}\n`);
    }
  });

  it("--lock-status for an agent that never armed → never; with no single live window → no_window", async () => {
    expect(lockStatus()).toBe("never");
    fs.mkdirSync(W.watchAgentDir(DB, "w-bob"), { recursive: true });
    expect(lockStatus()).toBe("absent");
    openWin("w-bob");
    expect(lockStatus()).toBe("no_window");
  }, 30_000);

  it("`relay doorbell status` counts the LIVE dormant watches per agent", async () => {
    win.runRelayWatch(WATCH());
    await untilStatus("live");
    const loser = win.runRelayWatch(WATCH());
    const lpid = await loser.pid();
    for (let i = 0; i < 100 && !dormantRecords(winDir(win)).some((x) => x.pid === lpid); i++) await new Promise((res) => setTimeout(res, 100));
    const { readDoorbellStatus } = await import("../src/cli/doorbell.js");
    expect(((await readDoorbellStatus(DB, null)) as unknown as { dormant_watches: Record<string, number> }).dormant_watches).toEqual({ "w-bob": 1 });
  }, 40_000);
});
