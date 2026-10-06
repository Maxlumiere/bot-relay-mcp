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
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { openWindow, within, type TestWindow } from "./helpers/watch-window.js";

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
const { getOwnHostId, processStartedAt } = await import("../src/liveness.js");
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
  const bnd = (id: string, pid: number, start: string, agent = "bob", host = "H") => ({ binding_id: id, agent_name: agent, host_id: host, window_pid: pid, window_pid_start: start });
  const deps = (o: Partial<import("../src/watch-owner.js").OwnerDeps> = {}): import("../src/watch-owner.js").OwnerDeps => ({
    table: () => table(),
    startNow: (pid) => `S${pid}`,
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
    expect(O.resolveOwnership(300, [bnd("b1", 100, "S100")], "H", deps({ startNow: (pid) => (pid === 100 ? "S-NEW" : `S${pid}`) }))).toEqual({ ok: false, why: "no_bound_ancestor" });
  });
  it("(ii) a reparented watch (its parent is init) is refused before anything else", () => {
    expect(O.resolveOwnership(300, [bnd("b1", 100, "S100")], "H", deps({ table: () => table({ 300: { ppid: 1 } }) }))).toEqual({ ok: false, why: "reparented" });
  });
  it("another host's binding with the same pid never matches (the window is judged on its own host only)", () => {
    expect(O.resolveOwnership(300, [bnd("b1", 100, "S100", "bob", "OTHER")], "H", deps())).toEqual({ ok: false, why: "no_bound_ancestor" });
  });
  it("(iii) the ancestor is bound, but a SECOND live window exists → ambiguous; another window is the live one → not_this_window", () => {
    expect(O.resolveOwnership(300, [bnd("b1", 100, "S100"), bnd("b2", 900, "S900")], "H", deps({ liveness: () => "alive" }))).toEqual({ ok: false, why: "ambiguous_binding" });
    const sDeps = { liveness: () => "alive" as const, startNow: (pid: number) => `S${pid}` };
    expect(O.stillOwner({ pid: 100, start: "S100" }, [bnd("b2", 900, "S900")], "H", sDeps, new Set())).toEqual({ ok: false, why: "not_this_window" });
    // the window process itself gone (its pid now runs another start) → window_gone: the watch EXITS (silently)
    expect(O.stillOwner({ pid: 100, start: "S100" }, [bnd("b1", 100, "S100")], "H", { ...sDeps, startNow: () => "S-OTHER" }, new Set())).toEqual({ ok: false, why: "window_gone" });
    // Codex R2 (b): the SAME window under a migrated token (same binding, another spelling) is still the owner
    expect(O.stillOwner({ pid: 100, start: "S100" }, [bnd("b1", 100, "legacy-spelling-of-S100")], "H", sDeps, new Set())).toEqual({ ok: true });
  });
  it("stillOwner caches a DEAD verdict (dead is permanent for a pid + start) and re-reads every other one", () => {
    const calls: number[] = [];
    const live = (b: { window_pid?: number | null }) => {
      calls.push(b.window_pid as number);
      return b.window_pid === 100 ? ("alive" as const) : ("dead" as const);
    };
    const cache = new Set<string>();
    const bs = [bnd("b1", 100, "S100"), bnd("b0", 50, "S50")];
    const sd = { liveness: live, startNow: (pid: number) => `S${pid}` };
    O.stillOwner({ pid: 100, start: "S100" }, bs, "H", sd, cache);
    O.stillOwner({ pid: 100, start: "S100" }, bs, "H", sd, cache);
    expect(calls).toEqual([100, 50, 100]); // 50 judged once (dead, cached); 100 judged every time
  });
});

// ---------------------------------------------------------------------------------------------------
// The REAL CLI, inside real bound windows. THE INVARIANT (ruling 9becb599): a watch exits only to
// deliver a wake, or (silently) because its window is gone; every other terminal state is DORMANT.

const env = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: path.join(ROOT, "home"), RELAY_DB_PATH: DB, RELAY_FILESYSTEM_MARKERS: "0" });
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const WATCH = (agent = "w-bob") => `node ${sq(RELAY_BIN)} watch ${agent} --until-wake --interval 1 --dormant-check-s 1`;
const ARM_CHECK = (agent = "w-bob") => `node ${sq(RELAY_BIN)} watch ${agent} --arm-check`;
const lockStatus = (agent = "w-bob") => spawnSync("node", [RELAY_BIN, "watch", agent, "--lock-status"], { env: env(), encoding: "utf-8" }).stdout.trim();
const send = (to = "w-bob") => db.sendMessage("w-alice", to, "hello", "normal").id;
const relaySnapshot = () => JSON.stringify([db.getDb().prepare("SELECT * FROM messages ORDER BY id").all(), db.getDb().prepare("SELECT * FROM agents ORDER BY name").all()]);
const bind = (agent: string, w: { pid: number }, conv = `conv-${w.pid}`) =>
  db.upsertAgentBinding(db.getDb(), { hostId: OWN as string, windowPid: w.pid, windowPidStart: processStartedAt(w.pid) as string, agentName: agent, agentClass: null, conversationId: conv, conversationTitle: null, cwd: ROOT, boundVia: "launch-intent" });
const winDir = (w: { pid: number }, agent = "w-bob") => W.watchWindowDir(DB, agent, { pid: w.pid, start: processStartedAt(w.pid) as string });
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
const dormantRecords = (dir: string) => {
  try {
    return fs.readdirSync(path.join(dir, W.DORMANT_DIR)).map((n) => JSON.parse(fs.readFileSync(path.join(dir, W.DORMANT_DIR, n), "utf-8")));
  } catch {
    return [];
  }
};
const awakeReadable = W.awakeNowMs() !== null;

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
    for (let i = 0; i < 100 && !dormantRecords(recordDir).some((x) => x.pid === pid); i++) await new Promise((res) => setTimeout(res, 100));
    expect(dormantRecords(recordDir).find((x) => x.pid === pid)?.reason, r.err()).toMatch(reason);
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
    const r = win.run(WATCH());
    expect(await within(r.exited, 20_000), r.err()).toBe(0);
    expect(r.out().trim().split("\n")).toEqual([expect.stringMatching(/^relay mail pending for w-bob: 1 new message\(s\)\. Call get_messages, then re-arm: run RELAY_DB_PATH='[^']+' '[^']+\/bin\/relay' watch w-bob --arm-check and, if it says arm, the command it gives in the background\.$/)]);
    expect(relaySnapshot()).toBe(before);
  }, 30_000);

  it("HARM (no wake loop): re-armed with the SAME undrained mail it does NOT exit; new mail then wakes it once", async () => {
    send();
    expect(await within(win.run(WATCH()).exited, 20_000)).toBe(0);
    const again = win.run(WATCH());
    expect(await within(again.exited, 3_000)).toBe("timeout");
    send();
    expect(await within(again.exited, 20_000), again.err()).toBe(0);
    expect(again.out()).toMatch(/1 new message\(s\)/);
  }, 40_000);

  it("architect 323f69d5: armed with a NULL session it KEEPS WAITING; the session binds and mail arrives → exactly one wake", async () => {
    db.getDb().prepare("UPDATE agents SET session_id = NULL WHERE name = 'w-bob'").run();
    send();
    const r = win.run(WATCH());
    expect(await within(r.exited, 3_000)).toBe("timeout");
    db.registerAgent("w-bob", "r", []);
    expect(await within(r.exited, 20_000), r.err()).toBe(0);
    expect(r.out().trim().split("\n")).toHaveLength(1);
  }, 40_000);

  it("(b) the window is GONE while a watch waits → it exits SILENTLY (exit 0, no line)", async () => {
    const r = win.run(WATCH());
    await untilStatus("live");
    process.kill(win.pid, "SIGKILL");
    expect(await within(r.exited, 15_000), r.err()).toBe(0);
    expect(r.out()).toBe("");
  }, 40_000);

  it("HARM (the invariant; a mutant exiting on this path → RED): the LOST RACE goes DORMANT, never exits while its window lives; the holder keeps watching", async () => {
    const first = win.run(WATCH());
    await untilStatus("live");
    const second = win.run(WATCH());
    await expectDormantThenSilentExit(second, win, /^already watched/, winDir(win));
    expect(await first.exited).toBe(0); // the holder ended with the window too (silently)
  }, 60_000);

  it("a DEAD holder (SIGKILL) frees the lock by kernel fact: the next watch takes it and wakes", async () => {
    const first = win.run(WATCH());
    await untilStatus("live");
    process.kill(await first.pid(), "SIGKILL");
    await first.exited;
    expect(lockStatus()).toBe("absent");
    send();
    expect(await within(win.run(WATCH()).exited, 20_000)).toBe(0);
  }, 40_000);

  // --- --arm-check: every arm-time refusal, decided in the FOREGROUND ----------------------------------
  it("--arm-check: arm (with the background command), then live once a watch runs", async () => {
    const a = win.run(ARM_CHECK());
    expect(await within(a.exited, 20_000), a.err()).toBe(0);
    expect(a.out().trim()).toMatch(/^arm: start it now as a BACKGROUND task \(run_in_background\), once: RELAY_DB_PATH='[^']+' '[^']+\/bin\/relay' watch w-bob --until-wake$/);
    win.run(WATCH());
    await untilStatus("live");
    const b = win.run(ARM_CHECK());
    expect(await within(b.exited, 20_000)).toBe(0);
    expect(b.out().trim()).toMatch(/^live: a watch for w-bob is already running in this window\. Nothing to do\.$/);
  }, 40_000);

  it("HARM (D1) --arm-check refuses each arm-time case with its why (exit 2): no_bound_ancestor (outside any window, or another agent's), reparented, ambiguous_binding", async () => {
    const direct = spawnSync("node", [RELAY_BIN, "watch", "w-bob", "--arm-check"], { env: env(), encoding: "utf-8", timeout: 30_000 });
    expect([direct.status, direct.stdout.trim()]).toEqual([2, expect.stringMatching(/^no-mail: refused \(no_bound_ancestor\): /)]);
    const alicesWin = openWin("w-alice");
    const inAlice = alicesWin.run(ARM_CHECK("w-bob"));
    expect(await within(inAlice.exited, 20_000)).toBe(2);
    expect(inAlice.out().trim()).toMatch(/^no-mail: refused \(no_bound_ancestor\)/);
    const O2 = path.join(ROOT, "reparented-arm.out");
    win.run(`bash -c ${sq(`${ARM_CHECK()} > ${sq(O2)} 2>&1 & disown; exit 0`)}`);
    let out = "";
    for (let i = 0; i < 200 && !/no-mail|arm:/.test(out); i++) {
      await new Promise((r) => setTimeout(r, 100));
      out = fs.existsSync(O2) ? fs.readFileSync(O2, "utf-8") : "";
    }
    // darwin: the orphan's parent is launchd (pid 1). linux may use a SUBREAPER: its chain holds no bound window.
    expect(out.trim()).toMatch(process.platform === "darwin" ? /^no-mail: refused \(reparented\): / : /^no-mail: refused \((reparented|no_bound_ancestor)\): /);
    openWin("w-bob"); // a second live window
    const amb = win.run(ARM_CHECK());
    expect(await within(amb.exited, 20_000)).toBe(2);
    expect(amb.out().trim()).toMatch(/^no-mail: refused \(ambiguous_binding\)/);
  }, 60_000);

  it("a refusal discovered AFTER launch (no arm-check run) → DORMANT under its launching shell, never an exit while that shell lives", async () => {
    const shell = openWin(null); // a shell bound to NOBODY
    const r = shell.run(WATCH());
    await expectDormantThenSilentExit(r, shell, /^refused \(no_bound_ancestor\)/, W.watchAgentDir(DB, "w-bob"), "parent");
  }, 60_000);

  // --- D1 while running: the binding moves → dormant; the new window arms its own --------------------
  it("D1 (iii): a second live window binds while the watch runs → DORMANT (binding moved), silent exit with its window", async () => {
    const r = win.run(WATCH());
    await untilStatus("live");
    openWin("w-bob");
    await expectDormantThenSilentExit(r, win, /^binding moved \(ambiguous_binding\)/, winDir(win));
  }, 60_000);

  it("HARM (Codex R1 #1): the agent REBINDS to window B while A's watch runs → A goes DORMANT; B arms its OWN watch (never blocked by A's) and B's mail wakes B", async () => {
    const a = win.run(WATCH());
    await untilStatus("live");
    const aDir = winDir(win);
    db.getDb().prepare("UPDATE agent_bindings SET superseded_at = ? WHERE window_pid = ?").run(new Date().toISOString(), win.pid);
    const winB = openWin("w-bob");
    const aPid = await a.pid();
    for (let i = 0; i < 100 && !dormantRecords(aDir).some((x) => x.pid === aPid); i++) await new Promise((res) => setTimeout(res, 100));
    expect(dormantRecords(aDir).find((x) => x.pid === aPid)?.reason).toMatch(/^binding moved \(not_this_window\)/);
    expect(alive(aPid)).toBe(true);
    const b = winB.run(WATCH());
    await untilStatus("live");
    send();
    expect(await within(b.exited, 20_000), b.err()).toBe(0);
    expect(b.out()).toMatch(/^relay mail pending for w-bob: 1 new message/);
    expect(await within(a.exited, 1_000)).toBe("timeout"); // A never woke for B's mail: still dormant
  }, 60_000);

  it("HARM (Codex R2 (b)): the binding's start token is MIGRATED to the legacy form under the same binding → the SAME watch stays the owner and the status still sees it (no second watch)", async () => {
    const r = win.run(WATCH());
    await untilStatus("live");
    const legacy = processStartedAt(win.pid, undefined, "legacy") as string;
    expect(legacy).not.toBe(processStartedAt(win.pid)); // precondition: two different spellings
    db.getDb().prepare("UPDATE agent_bindings SET window_pid_start = ? WHERE window_pid = ?").run(legacy, win.pid);
    await new Promise((res) => setTimeout(res, 2_500)); // a few checks
    expect(lockStatus()).toBe("live"); // the status keys the same dir
    const again = win.run(ARM_CHECK());
    expect(await within(again.exited, 20_000)).toBe(0);
    expect(again.out()).toMatch(/^live: /); // no second watch would be armed
    expect(await within(r.exited, 500)).toBe("timeout");
    expect(dormantRecords(winDir(win))).toEqual([]); // the holder never went dormant
    send();
    expect(await within(r.exited, 20_000), r.err()).toBe(0); // and it still wakes
  }, 60_000);

  // --- D2: a hung holder is ABANDONED by generation, never signalled; the abandoned one goes dormant ----
  it.skipIf(!awakeReadable)("HARM (D2): a HUNG holder (SIGSTOP'd, stale on the AWAKE clock) is abandoned: the re-arm takes generation 1 and wakes; the hung process is NEVER signalled; resumed, it goes DORMANT (superseded)", async () => {
    const hung = win.run(WATCH());
    await untilStatus("live");
    const hungPid = await hung.pid();
    process.kill(hungPid, "SIGSTOP");
    ageHolder(winDir(win));
    expect(lockStatus()).toBe("stale");
    const next = win.run(WATCH());
    await untilStatus("live");
    expect(W.currentGen(winDir(win))).toBe(1);
    expect(next.err()).toMatch(/generation 0\) is hung: abandoned it; contesting generation 1 \(nothing is signalled\)/);
    expect(alive(hungPid)).toBe(true);
    send();
    expect(await within(next.exited, 20_000), next.err()).toBe(0);
    process.kill(hungPid, "SIGCONT"); // only the TEST resumes it
    await expectDormantThenSilentExit(hung, win, /^superseded: /, winDir(win));
  }, 90_000);

  it("a LIVE holder is never abandoned, even with a PREDECESSOR's ancient heartbeat (it counts only its own)", async () => {
    const first = win.run(WATCH());
    await untilStatus("live");
    W.writeHeartbeat(winDir(win), { pid: 999_999, gen: 0, at: new Date().toISOString(), awake_ms: -10_000_000 });
    expect(lockStatus()).toBe("live");
    expect(W.currentGen(winDir(win))).toBe(0);
    expect(alive(await first.pid())).toBe(true);
  }, 40_000);

  it("Codex R2 (c): a holder with NO readable awake stamp is never judged stale (no false takeover after a long sleep)", async () => {
    win.run(WATCH());
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
    const r = win.run(WATCH());
    expect(await within(r.exited, 20_000), r.err()).toBe(0);
    expect(r.out()).toMatch(/^relay mail pending for w-bob: 1 new message/);
    expect(r.err()).toMatch(/could not record what it woke for/);
    const again = win.run(WATCH());
    expect(await within(again.exited, 20_000), again.err()).toBe(0);
    expect(again.out()).toMatch(/^relay mail pending for w-bob: 1 new message/);
  }, 40_000);

  it("its lock file REMOVED under it (the dir deleted) → DORMANT (lock lost), never a second watch beside it; silent exit with its window", async () => {
    const r = win.run(WATCH());
    await untilStatus("live");
    fs.rmSync(W.watchAgentDir(DB, "w-bob"), { recursive: true, force: true });
    await expectDormantThenSilentExit(r, win, /^lock lost: /, winDir(win));
  }, 60_000);

  it("the agent UNREGISTERED while watching → DORMANT (unregistered)", async () => {
    const r = win.run(WATCH());
    await untilStatus("live");
    db.getDb().prepare("DELETE FROM agents WHERE name = 'w-bob'").run();
    await expectDormantThenSilentExit(r, win, /^unregistered: /, winDir(win));
  }, 60_000);

  it("a signal (a deliberate TaskStop) exits with a no-mail line", async () => {
    const r = win.run(WATCH());
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
    win.run(WATCH());
    await untilStatus("live");
    const loser = win.run(WATCH());
    const lpid = await loser.pid();
    for (let i = 0; i < 100 && !dormantRecords(winDir(win)).some((x) => x.pid === lpid); i++) await new Promise((res) => setTimeout(res, 100));
    const { readDoorbellStatus } = await import("../src/cli/doorbell.js");
    expect(((await readDoorbellStatus(DB, null)) as unknown as { dormant_watches: Record<string, number> }).dormant_watches).toEqual({ "w-bob": 1 });
  }, 40_000);
});
