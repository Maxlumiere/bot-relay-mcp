// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 7 (plan §v6; architect rulings 23e9b281, 7224605e, 323f69d5): `relay watch <agent>
 * --until-wake`, the ZERO-TOKEN wake. The pure trigger first, then the REAL CLI in separate processes:
 * two watches, the lock probe and a dead holder MUST be separate processes (a second descriptor on the
 * lock file inside the holder's process would drop its POSIX lock).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";

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
    for (const bad of [".", "..", "...", "a/b", ""]) expect(() => W.watchDirFor("/i/relay.db", bad)).toThrow(/no watch for this agent name/);
    expect(W.watchDirFor("/i/relay.db", "a.b")).toBe("/i/watch/a.b");
  });
  it("the persisted set stays BOUNDED: drained ids leave it, and wakes older than an hour are dropped", () => {
    const a = W.recordWake(null, RS1, ["m1", "m2"], ["m1", "m2"], ["alice"], 0);
    const b = W.recordWake(a, RS1, ["m3"], ["m2", "m3"], ["carol"], W.PAIR_WINDOW_MS + 1);
    expect(b.ids).toEqual(["m2", "m3"]);
    expect(b.wakes.map((w) => w.senders)).toEqual([["carol"]]);
  });
});

// ---------------------------------------------------------------------------------------------------
// The REAL CLI, in separate processes.

const env = () => ({ ...process.env, RELAY_DB_PATH: DB, RELAY_FILESYSTEM_MARKERS: "0" });
interface Watch { child: ChildProcess; out: () => string; err: () => string; exited: Promise<number | null> }
function startWatch(agent: string): Watch {
  const child = spawn("node", [RELAY_BIN, "watch", agent, "--until-wake", "--interval", "1"], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (err += d));
  const exited = new Promise<number | null>((r) => child.on("close", (c) => r(c)));
  return { child, out: () => out, err: () => err, exited };
}
const lockStatus = (agent: string) => spawnSync("node", [RELAY_BIN, "watch", agent, "--lock-status"], { env: env(), encoding: "utf-8" }).stdout.trim();
const within = <T>(p: Promise<T>, ms: number): Promise<T | "timeout"> => Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);
const send = (to = "w-bob") => db.sendMessage("w-alice", to, "hello", "normal").id;
const sessionOf = (name: string) => (db.getDb().prepare("SELECT session_id FROM agents WHERE name = ?").get(name) as { session_id: string | null }).session_id;
const relaySnapshot = () => JSON.stringify([db.getDb().prepare("SELECT * FROM messages ORDER BY id").all(), db.getDb().prepare("SELECT * FROM agents ORDER BY name").all()]);

describe("the CLI: `relay watch <agent> --until-wake` (zero tokens; separate processes)", () => {
  const live: Watch[] = [];
  beforeEach(async () => {
    for (const w of live.splice(0)) {
      w.child.kill("SIGKILL");
      await w.exited;
    }
    db.closeDb();
    fs.rmSync(path.join(ROOT, "inst"), { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, "inst"), { recursive: true });
    db.getDb();
    db.registerAgent("w-alice", "s", []);
    db.registerAgent("w-bob", "r", []);
  });
  afterAll(async () => {
    for (const w of live) w.child.kill("SIGKILL");
  });
  const watch = (agent = "w-bob") => {
    const w = startWatch(agent);
    live.push(w);
    return w;
  };

  it("mail already pending → exits 0 at once with ONE wake line; the relay DB is unchanged (read-only)", async () => {
    send();
    const before = relaySnapshot();
    const w = watch();
    expect(await within(w.exited, 20_000)).toBe(0);
    expect(w.out().trim().split("\n")).toEqual([expect.stringMatching(/^relay mail pending for w-bob: 1 new message\(s\)\. Call get_messages, then re-arm in the background: RELAY_DB_PATH='[^']+' '[^']+\/bin\/relay' watch w-bob --until-wake$/)]);
    expect(relaySnapshot()).toBe(before);
  }, 30_000);

  it("HARM (no wake loop): re-armed with the SAME undrained mail it does NOT exit; new mail then wakes it once", async () => {
    send();
    expect(await within(watch().exited, 20_000)).toBe(0);
    const again = watch();
    expect(await within(again.exited, 3_000)).toBe("timeout"); // still waiting: the same id never wakes twice
    send();
    expect(await within(again.exited, 20_000)).toBe(0);
    expect(again.out()).toMatch(/1 new message\(s\)/);
  }, 40_000);

  it("architect 323f69d5: armed with a NULL session it KEEPS WAITING; the session binds and mail arrives → exactly one wake", async () => {
    expect(db.markAgentOffline("w-bob", sessionOf("w-bob") as string).changed).toBe(true);
    expect(sessionOf("w-bob")).toBeNull();
    send();
    const w = watch();
    expect(await within(w.exited, 3_000)).toBe("timeout"); // no session: no wake yet, and NOT dead
    db.registerAgent("w-bob", "r", []); // the session binds
    expect(sessionOf("w-bob")).toBeTruthy();
    expect(await within(w.exited, 20_000)).toBe(0);
    expect(w.out().trim().split("\n")).toHaveLength(1);
  }, 40_000);

  it("ONE watch per agent, OLDEST wins: a second exits 0 at once and quietly; --lock-status says live, then absent once it ends", async () => {
    const first = watch();
    for (let i = 0; i < 50 && lockStatus("w-bob") !== "live"; i++) await new Promise((r) => setTimeout(r, 200));
    expect(lockStatus("w-bob")).toBe("live");
    const second = watch();
    expect(await within(second.exited, 15_000)).toBe(0);
    expect(second.out()).toMatch(/already live/);
    expect(await within(first.exited, 1_000)).toBe("timeout"); // the first still holds it
    send();
    expect(await within(first.exited, 20_000)).toBe(0);
    expect(lockStatus("w-bob")).toBe("absent");
  }, 60_000);

  it("a DEAD holder (SIGKILL) frees the lock by kernel fact: the next watch takes it and wakes", async () => {
    const first = watch();
    for (let i = 0; i < 50 && lockStatus("w-bob") !== "live"; i++) await new Promise((r) => setTimeout(r, 200));
    first.child.kill("SIGKILL");
    await first.exited;
    expect(lockStatus("w-bob")).toBe("absent");
    send();
    const next = watch();
    expect(await within(next.exited, 20_000)).toBe(0);
  }, 40_000);

  it("its lock file REMOVED under it (the dir deleted) → it stops with exit 1 and a re-arm line; it never runs beside a new watch", async () => {
    const w = watch();
    for (let i = 0; i < 50 && lockStatus("w-bob") !== "live"; i++) await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(W.watchDirFor(DB, "w-bob"), { recursive: true, force: true });
    expect(await within(w.exited, 10_000)).toBe(1);
    expect(w.out()).toMatch(/removed or replaced under this watch: it stopped\. Re-arm in the background: RELAY_DB_PATH='[^']+' '[^']+\/bin\/relay' watch w-bob --until-wake/);
  }, 30_000);

  it("the re-arm line is a RUNNABLE command: it names this DB and this CLI, quoted (the path has spaces in production)", async () => {
    const { rearmCommand, shq } = await import("../src/cli/watch-until-wake.js");
    expect(shq("/a b/it's")).toBe("'/a b/it'\\''s'");
    const cmd = rearmCommand("w-bob", "/x y/relay.db", "/Claude AI/bin/relay");
    expect(spawnSync("bash", ["-c", `set -- ${cmd.replace(/^RELAY_DB_PATH=/, "")}; printf '%s\\n' "$@"`], { encoding: "utf-8" }).stdout).toBe("/x y/relay.db\n/Claude AI/bin/relay\nwatch\nw-bob\n--until-wake\n");
  });

  // Ruling 1a8fc7c4 (2): a STALE holder is taken over; a live one is not; an unverifiable one is never signalled.
  const OLD = () => new Date(Date.now() - W.HEARTBEAT_STALE_MS - 60_000).toISOString();
  /** Age the CURRENT holder past the stale bound (its sidecar's since AND its own heartbeat): real time cannot pass 5 min. */
  function ageHolder(over: Partial<{ pid: number; proc_start: string }> = {}): void {
    const dir = W.watchDirFor(DB, "w-bob");
    const f = path.join(dir, W.WATCH_HOLDER_FILE);
    const h = JSON.parse(fs.readFileSync(f, "utf-8"));
    fs.writeFileSync(f, JSON.stringify({ ...h, ...over, since: OLD() }));
    W.writeHeartbeat(dir, over.pid ?? h.pid, OLD());
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("HARM: a HUNG holder (SIGSTOP'd, stale) is TAKEN OVER by the next re-arm, in one attempt; the new watch then wakes", async () => {
    const hung = watch();
    for (let i = 0; i < 50 && lockStatus("w-bob") !== "live"; i++) await new Promise((r) => setTimeout(r, 200));
    hung.child.kill("SIGSTOP");
    ageHolder();
    expect(lockStatus("w-bob")).toBe("stale");
    const next = watch();
    expect(await within(hung.exited, 15_000)).not.toBe("timeout"); // the hung one is gone
    for (let i = 0; i < 50 && lockStatus("w-bob") !== "live"; i++) await new Promise((r) => setTimeout(r, 200));
    expect(lockStatus("w-bob")).toBe("live");
    expect(W.holderLastSign(W.watchDirFor(DB, "w-bob")).holder?.pid).toBe(next.child.pid);
    expect(next.err()).toMatch(/is hung \(pid \d+, .*\): taking over/);
    send();
    expect(await within(next.exited, 20_000)).toBe(0);
  }, 60_000);

  it("a LIVE holder is never taken over (oldest wins): the re-arm exits 'already live', the holder survives", async () => {
    const first = watch();
    for (let i = 0; i < 50 && lockStatus("w-bob") !== "live"; i++) await new Promise((r) => setTimeout(r, 200));
    const second = watch();
    expect(await within(second.exited, 15_000)).toBe(0);
    expect(second.out()).toMatch(/already live/);
    expect(alive(first.child.pid as number)).toBe(true);
  }, 30_000);

  it("HARM: a stale holder record naming a RECYCLED pid (wrong start time) → NO signal to that pid; the lock is taken only once the kernel frees it", async () => {
    const real = watch();
    for (let i = 0; i < 50 && lockStatus("w-bob") !== "live"; i++) await new Promise((r) => setTimeout(r, 200));
    real.child.kill("SIGSTOP");
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      ageHolder({ pid: bystander.pid as number, proc_start: "Thu Jan  1 00:00:00 1970" });
      const next = watch();
      expect(await within(next.exited, 15_000)).toBe(0);
      expect(next.out()).toMatch(/already live/); // the kernel lock is still held: not taken
      expect(next.err()).toMatch(/cannot be verified \(pid \d+\): not signalled/);
      expect(alive(bystander.pid as number)).toBe(true); // the stranger was never signalled
      expect(alive(real.child.pid as number)).toBe(true); // nor was the unnamed real holder
      // The kernel frees the lock when the real holder dies: then a re-arm takes it.
      real.child.kill("SIGKILL");
      await real.exited;
      const after = watch();
      for (let i = 0; i < 50 && lockStatus("w-bob") !== "live"; i++) await new Promise((r) => setTimeout(r, 200));
      expect(W.holderLastSign(W.watchDirFor(DB, "w-bob")).holder?.pid).toBe(after.child.pid);
    } finally {
      bystander.kill("SIGKILL");
    }
  }, 60_000);

  it("a just-started holder is NEVER judged stale by its predecessor's old heartbeat (it would be killed for it)", async () => {
    const w = watch();
    for (let i = 0; i < 50 && lockStatus("w-bob") !== "live"; i++) await new Promise((r) => setTimeout(r, 200));
    W.writeHeartbeat(W.watchDirFor(DB, "w-bob"), 999_999, OLD()); // a predecessor's heartbeat: another pid
    expect(lockStatus("w-bob")).toBe("live");
    expect(await within(w.exited, 500)).toBe("timeout");
  }, 30_000);

  it("the signal sequence: SIGTERM + SIGCONT, then RE-VERIFY before SIGKILL (a pid that moved on is never SIGKILLed)", async () => {
    const { takeOverIfStale } = await import("../src/cli/watch-until-wake.js");
    const held = watch();
    for (let i = 0; i < 50 && lockStatus("w-bob") !== "live"; i++) await new Promise((r) => setTimeout(r, 200));
    held.child.kill("SIGSTOP");
    ageHolder();
    const dir = W.watchDirFor(DB, "w-bob");
    const never = () => ({ ok: false as const, reason: "held", holder: null });
    for (const [verdicts, expected] of [
      [["alive", "alive"], ["SIGTERM", "SIGCONT", "SIGKILL"]],
      [["alive", "dead"], ["SIGTERM", "SIGCONT"]],
      [["unverifiable"], []],
    ] as const) {
      const sent: string[] = [];
      const v = [...verdicts];
      const r = await takeOverIfStale(dir, never, () => Date.now(), () => {}, "w-bob", { kill: (_p, sig) => void sent.push(sig), verify: () => (v.shift() ?? "dead") as "alive", graceMs: 200 });
      expect(r).toBeNull(); // the (fake) lock never frees here
      expect(sent).toEqual(expected);
    }
  }, 30_000);

  it("a HUNG watch shows as stale: the lock is held but the heartbeat is old", async () => {
    const w = watch();
    for (let i = 0; i < 50 && lockStatus("w-bob") !== "live"; i++) await new Promise((r) => setTimeout(r, 200));
    const dir = W.watchDirFor(DB, "w-bob");
    expect(W.watchStatus(dir, Date.now() + W.HEARTBEAT_STALE_MS + 1_000)).toBe("stale");
    expect(await within(w.exited, 500)).toBe("timeout");
  }, 30_000);
});
