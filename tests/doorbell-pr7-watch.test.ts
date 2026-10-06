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
  it("awake time (MEASURED: node hrtime on macOS includes sleep): darwin counts from the later of the sign and the last WAKE; linux takes the smaller of wall and monotonic; else wall", () => {
    const sign = { wallMs: 1_000_000, monoNs: 5_000_000_000n };
    // darwin: slept 10 min after the sign, woke 1 min ago → 1 min awake, never stale
    expect(W.awakeMsSince(sign, { wallMs: 1_000_000 + 11 * 60_000, monoNs: 0n, lastWakeMs: 1_000_000 + 10 * 60_000, platform: "darwin" })).toBe(60_000);
    // darwin: no sleep since the sign → wall
    expect(W.awakeMsSince(sign, { wallMs: 1_000_000 + 6 * 60_000, monoNs: 0n, lastWakeMs: 500_000, platform: "darwin" })).toBe(6 * 60_000);
    // linux: suspend excluded by CLOCK_MONOTONIC (2 min of it awake, 11 min of wall)
    expect(W.awakeMsSince(sign, { wallMs: 1_000_000 + 11 * 60_000, monoNs: 5_000_000_000n + 120_000_000_000n, lastWakeMs: null, platform: "linux" })).toBe(120_000);
    // darwin with the wake time unreadable → wall (a hung watch is still caught)
    expect(W.awakeMsSince(sign, { wallMs: 1_000_000 + 6 * 60_000, monoNs: 0n, lastWakeMs: null, platform: "darwin" })).toBe(6 * 60_000);
  });
  it("the real wake time reads on this machine (darwin), and is in the past", () => {
    const w = W.lastWakeMs();
    if (process.platform === "darwin") {
      expect(w).not.toBeNull();
      expect(w as number).toBeLessThanOrEqual(Date.now());
    } else expect(w).toBeNull();
  });
  it("a heartbeat counts only for the CURRENT holder (its pid AND its generation): a predecessor's never makes a newborn stale", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, W.watchHolderFile(1)), JSON.stringify({ pid: 42, proc_start: null, host_id: null, since: new Date().toISOString() }));
    W.writeHeartbeat(d, { pid: 41, gen: 0, at: new Date(Date.now() - 3_600_000).toISOString() }); // the predecessor's, an hour old
    const s = W.holderLastSign(d, 1);
    expect(s.holder?.pid).toBe(42);
    expect(Date.now() - (s.sign as { wallMs: number }).wallMs).toBeLessThan(5_000); // its since, not the old heartbeat
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
    expect(O.resolveOwnership(300, [bnd("b1", 100, "S100")], "H", deps())).toEqual({ ok: true, window: { binding_id: "b1", pid: 100, start: "S100" } });
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
    const stillOwner = O.stillOwner({ binding_id: "b1" }, [bnd("b2", 900, "S900")], "H", () => "alive", new Set());
    expect(stillOwner).toEqual({ ok: false, why: "not_this_window" });
  });
  it("stillOwner caches a DEAD verdict (dead is permanent for a pid + start) and re-reads every other one", () => {
    const calls: number[] = [];
    const live = (b: { window_pid?: number | null }) => {
      calls.push(b.window_pid as number);
      return b.window_pid === 100 ? ("alive" as const) : ("dead" as const);
    };
    const cache = new Set<string>();
    const bs = [bnd("b1", 100, "S100"), bnd("b0", 50, "S50")];
    O.stillOwner({ binding_id: "b1" }, bs, "H", live, cache);
    O.stillOwner({ binding_id: "b1" }, bs, "H", live, cache);
    expect(calls).toEqual([100, 50, 100]); // 50 judged once (dead, cached); 100 judged every time
  });
});

// ---------------------------------------------------------------------------------------------------
// The REAL CLI, inside real bound windows.

const env = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: path.join(ROOT, "home"), RELAY_DB_PATH: DB, RELAY_FILESYSTEM_MARKERS: "0" });
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const WATCH = (agent = "w-bob") => `node ${sq(RELAY_BIN)} watch ${agent} --until-wake --interval 1`;
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
/** Age the CURRENT holder of `gen` past the stale bound (its since AND its own heartbeat): real time cannot pass 5 min. */
function ageHolder(dir: string, gen = 0): void {
  const f = path.join(dir, W.watchHolderFile(gen));
  const h = JSON.parse(fs.readFileSync(f, "utf-8"));
  const old = new Date(Date.now() - W.HEARTBEAT_STALE_MS - 60_000).toISOString();
  fs.writeFileSync(f, JSON.stringify({ ...h, since: old }));
  // No heartbeat: the sign is then the sidecar's wall-clock since. A fake monotonic stamp cannot be
  // aged past the uptime of a freshly booted CI runner (linux judges awake time by CLOCK_MONOTONIC).
  fs.rmSync(path.join(dir, W.HEARTBEAT_FILE), { force: true });
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

  it("mail already pending → exits 0 at once with ONE wake line (a runnable re-arm command); the relay DB is unchanged (read-only)", async () => {
    send();
    const before = relaySnapshot();
    const r = win.run(WATCH());
    expect(await within(r.exited, 20_000), r.err()).toBe(0);
    expect(r.out().trim().split("\n")).toEqual([expect.stringMatching(/^relay mail pending for w-bob: 1 new message\(s\)\. Call get_messages, then re-arm in the background: RELAY_DB_PATH='[^']+' '[^']+\/bin\/relay' watch w-bob --until-wake$/)]);
    expect(relaySnapshot()).toBe(before);
  }, 30_000);

  it("HARM (no wake loop): re-armed with the SAME undrained mail it does NOT exit; new mail then wakes it once", async () => {
    send();
    expect(await within(win.run(WATCH()).exited, 20_000)).toBe(0);
    const again = win.run(WATCH());
    expect(await within(again.exited, 3_000)).toBe("timeout"); // still waiting: the same id never wakes twice
    send();
    expect(await within(again.exited, 20_000), again.err()).toBe(0);
    expect(again.out()).toMatch(/1 new message\(s\)/);
  }, 40_000);

  it("architect 323f69d5: armed with a NULL session it KEEPS WAITING; the session binds and mail arrives → exactly one wake", async () => {
    db.getDb().prepare("UPDATE agents SET session_id = NULL WHERE name = 'w-bob'").run();
    send();
    const r = win.run(WATCH());
    expect(await within(r.exited, 3_000)).toBe("timeout"); // no session: no wake yet, and NOT dead
    db.registerAgent("w-bob", "r", []); // the session binds
    expect(await within(r.exited, 20_000), r.err()).toBe(0);
    expect(r.out().trim().split("\n")).toHaveLength(1);
  }, 40_000);

  it("ONE watch per window, OLDEST wins: a second exits 0 with 'no-mail: already watched'; --lock-status says live, then absent once it ends", async () => {
    const first = win.run(WATCH());
    await untilStatus("live");
    const second = win.run(WATCH());
    expect(await within(second.exited, 15_000), second.err()).toBe(0);
    expect(second.out().trim()).toMatch(/^no-mail: already watched: /);
    expect(await within(first.exited, 1_000)).toBe("timeout"); // the first still holds it
    send();
    expect(await within(first.exited, 20_000), first.err()).toBe(0);
    expect(lockStatus()).toBe("absent");
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

  // --- D1: ownership by process ancestry (ruling ffcaf608) -------------------------------------------
  it("HARM (D1): a watch NOT inside any window of this agent (started directly) REFUSES to arm (exit 2, a no-mail line) and creates no watch dir", async () => {
    const r = spawnSync("node", [RELAY_BIN, "watch", "w-bob", "--until-wake", "--interval", "1"], { env: env(), encoding: "utf-8", timeout: 30_000 });
    expect(r.status).toBe(2);
    expect(r.stdout.trim()).toMatch(/^no-mail: refused \(no_bound_ancestor\): /);
    expect(fs.existsSync(W.watchAgentDir(DB, "w-bob"))).toBe(false);
  }, 40_000);

  it("HARM (D1): a watch for w-bob inside ALICE's window (another agent's process claiming the name) is refused", async () => {
    const alicesWin = openWin("w-alice");
    const r = alicesWin.run(WATCH("w-bob"));
    expect(await within(r.exited, 20_000), r.err()).toBe(2);
    expect(r.out().trim()).toMatch(/^no-mail: refused \(no_bound_ancestor\)/);
  }, 40_000);

  it("D1 (ii): a REPARENTED watch (detached: its parent shell is gone) refuses to arm", async () => {
    const O = path.join(ROOT, "reparented.out");
    // The shell starts it in the background and exits at once: the watch's parent is init/launchd.
    win.run(`bash -c ${sq(`${WATCH()} > ${sq(O)} 2>&1 & disown; exit 0`)}`);
    let out = "";
    for (let i = 0; i < 200 && !/no-mail/.test(out); i++) {
      await new Promise((r) => setTimeout(r, 100));
      out = fs.existsSync(O) ? fs.readFileSync(O, "utf-8") : "";
    }
    // Refused either way. On darwin the orphan's parent is launchd (pid 1): "reparented". On linux it may
    // be a SUBREAPER (systemd --user, not pid 1); its chain then holds no bound window: still refused.
    expect(out.trim()).toMatch(process.platform === "darwin" ? /^no-mail: refused \(reparented\): / : /^no-mail: refused \((reparented|no_bound_ancestor)\): /);
  }, 40_000);

  it("D1 (iii): two live windows for w-bob (ambiguous) → refused; and the RUNNING watch stops with 'binding moved' when a second live window binds", async () => {
    const r = win.run(WATCH());
    await untilStatus("live");
    const second = openWin("w-bob"); // a second live window: never guess
    expect(await within(r.exited, 20_000), r.err()).toBe(0);
    expect(r.out().trim()).toMatch(/^no-mail: binding moved \(ambiguous_binding\): /);
    const again = second.run(WATCH());
    expect(await within(again.exited, 20_000), again.err()).toBe(2);
    expect(again.out().trim()).toMatch(/^no-mail: refused \(ambiguous_binding\)/);
  }, 60_000);

  it("HARM (Codex R1 #1): the agent REBINDS to window B while A's watch runs → A's watch stops ('binding moved'); B arms its OWN watch (never blocked by A's) and B's mail wakes B", async () => {
    const a = win.run(WATCH());
    await untilStatus("live");
    db.getDb().prepare("UPDATE agent_bindings SET superseded_at = ? WHERE window_pid = ?").run(new Date().toISOString(), win.pid); // the agent moved off A
    const winB = openWin("w-bob");
    expect(await within(a.exited, 20_000), a.err()).toBe(0);
    expect(a.out().trim()).toMatch(/^no-mail: binding moved \(not_this_window\): /);
    const b = winB.run(WATCH());
    await untilStatus("live");
    expect(fs.existsSync(winDir(winB))).toBe(true);
    send();
    expect(await within(b.exited, 20_000), b.err()).toBe(0);
    expect(b.out()).toMatch(/^relay mail pending for w-bob: 1 new message/);
  }, 60_000);

  // --- D2: a hung holder is ABANDONED by generation, never signalled -----------------------------------
  it("HARM (D2): a HUNG holder (SIGSTOP'd, stale) is abandoned: the re-arm takes generation 1 and wakes; the hung process is NEVER signalled; resumed, it stops as superseded", async () => {
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
    expect(alive(hungPid)).toBe(true); // never signalled: still there, still stopped
    send();
    expect(await within(next.exited, 20_000), next.err()).toBe(0);
    expect(next.out()).toMatch(/^relay mail pending for w-bob/);
    process.kill(hungPid, "SIGCONT"); // only the TEST resumes it
    expect(await within(hung.exited, 20_000), hung.err()).toBe(0);
    expect(hung.out().trim()).toMatch(/^no-mail: superseded: /);
  }, 60_000);

  it("D2: a holder record naming ANOTHER live process (with its real start token) changes nothing: no process is ever signalled", async () => {
    const holder = win.run(WATCH());
    await untilStatus("live");
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      const dir = winDir(win);
      const f = path.join(dir, W.watchHolderFile(0));
      const h = JSON.parse(fs.readFileSync(f, "utf-8"));
      fs.writeFileSync(f, JSON.stringify({ ...h, pid: bystander.pid, proc_start: processStartedAt(bystander.pid as number) }));
      ageHolder(dir);
      const next = win.run(WATCH());
      await untilStatus("live");
      expect(alive(bystander.pid as number)).toBe(true); // the bystander lives: nothing reads a file to kill
      expect(alive(await holder.pid())).toBe(true); // nor was the real holder signalled
      expect(await within(holder.exited, 20_000), holder.err()).toBe(0); // it sees the later generation and stops itself
      expect(holder.out().trim()).toMatch(/^no-mail: superseded/);
      send();
      expect(await within(next.exited, 20_000), next.err()).toBe(0);
    } finally {
      bystander.kill("SIGKILL");
    }
  }, 60_000);

  it("a LIVE holder is never abandoned (oldest wins), even right after it started (a predecessor's old heartbeat never counts)", async () => {
    const first = win.run(WATCH());
    await untilStatus("live");
    W.writeHeartbeat(winDir(win), { pid: 999_999, gen: 0, at: new Date(Date.now() - 3_600_000).toISOString(), mono_ns: "0" });
    expect(lockStatus()).toBe("live");
    const second = win.run(WATCH());
    expect(await within(second.exited, 15_000), second.err()).toBe(0);
    expect(second.out()).toMatch(/^no-mail: already watched/);
    expect(W.currentGen(winDir(win))).toBe(0);
    expect(alive(await first.pid())).toBe(true);
  }, 40_000);

  // --- Codex R1 #3: emit first, persist after ---------------------------------------------------------
  it("HARM (Codex R1 #3): the wake is EMITTED even when recording it fails; the next watch wakes AGAIN for the same mail (a duplicate, never a missed wake)", async () => {
    const m = send();
    const dir = winDir(win);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); // private, as the watch requires of its own dirs
    fs.mkdirSync(path.join(dir, W.WOKEN_FILE)); // the record cannot be written (a directory at its name)
    const r = win.run(WATCH());
    expect(await within(r.exited, 20_000), r.err()).toBe(0);
    expect(r.out()).toMatch(/^relay mail pending for w-bob: 1 new message/);
    expect(r.err()).toMatch(/could not record what it woke for/);
    const again = win.run(WATCH());
    expect(await within(again.exited, 20_000), again.err()).toBe(0); // woken again for m: at-least-once
    expect(again.out()).toMatch(/^relay mail pending for w-bob: 1 new message/);
    expect(m).toBeTruthy();
  }, 40_000);

  it("its lock file REMOVED under it (the dir deleted) → it stops with exit 1 and a no-mail re-arm line; it never runs beside a new watch", async () => {
    const r = win.run(WATCH());
    await untilStatus("live");
    fs.rmSync(W.watchAgentDir(DB, "w-bob"), { recursive: true, force: true });
    expect(await within(r.exited, 10_000), r.err()).toBe(1);
    expect(r.out()).toMatch(/^no-mail: lock lost: .* Re-arm in the background: RELAY_DB_PATH='[^']+' '[^']+\/bin\/relay' watch w-bob --until-wake/);
  }, 30_000);

  it("the re-arm line is a RUNNABLE command: it names this DB and this CLI, quoted (the path has spaces in production)", async () => {
    const { rearmCommand, shq } = await import("../src/cli/watch-until-wake.js");
    expect(shq("/a b/it's")).toBe("'/a b/it'\\''s'");
    const cmd = rearmCommand("w-bob", "/x y/relay.db", "/Claude AI/bin/relay");
    expect(spawnSync("bash", ["-c", `set -- ${cmd.replace(/^RELAY_DB_PATH=/, "")}; printf '%s\\n' "$@"`], { encoding: "utf-8" }).stdout).toBe("/x y/relay.db\n/Claude AI/bin/relay\nwatch\nw-bob\n--until-wake\n");
  });

  it("--lock-status for an agent that never armed → never; with no single live window → no_window", async () => {
    expect(lockStatus()).toBe("never");
    fs.mkdirSync(W.watchAgentDir(DB, "w-bob"), { recursive: true });
    expect(lockStatus()).toBe("absent");
    openWin("w-bob");
    expect(lockStatus()).toBe("no_window"); // two live windows: never guessed
  }, 30_000);
});
