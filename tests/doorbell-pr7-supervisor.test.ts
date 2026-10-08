// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 7 (plan §v6; architect ruling 7224605e (2)(3)): the doorbell as the WATCH SUPERVISOR. The
 * real job (in-process, for its clock), a real bound window (a live child process), and a REAL
 * `relay watch --until-wake` (a separate process: the lock probe must never run in the holder's process).
 *   - a live watch → NO intent (the watch is the wake), no board case;
 *   - mail the watch already woke the agent for, still undelivered after H → undelivered_with_watch;
 *   - no watch → no_driver(watch_absent), and PR 1-6's intent stays (ruling (3): only watch-armed agents lose it);
 *   - a held lock with an old heartbeat → no_driver(watch_stale).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { openWindow, within, type TestWindow } from "./helpers/watch-window.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO, "bin", "relay");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-pr7-sup-")));
const DB = path.join(ROOT, "inst", "relay.db");
const LOGP = path.join(ROOT, "inst", "doorbell", "actuation.jsonl");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const db = await import("../src/db.js");
const R = await import("../src/doorbell-run.js");
const C = await import("../src/doorbell-core.js");
const W = await import("../src/watch-wake.js");
const { getOwnHostId, processStartedAt } = await import("../src/liveness.js");
const OWN = getOwnHostId();

const windows: TestWindow[] = [];
afterAll(async () => {
  for (const w of windows) await w.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
const bindWindow = (agent: string, pid: number) =>
  db.upsertAgentBinding(db.getDb(), { hostId: OWN as string, windowPid: pid, windowPidStart: processStartedAt(pid) as string, agentName: agent, agentClass: null, conversationId: `conv-${pid}`, conversationTitle: null, cwd: ROOT, boundVia: "launch-intent" });
const recs = () => (fs.existsSync(LOGP) ? fs.readFileSync(LOGP, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const intents = () => recs().filter((r) => r.type === "intent").length;
const boards = () => recs().filter((r) => r.type === "board").map((r) => [r.case, r.state, r.why ?? null]);
let mono = 1_000_000;
async function lifetime(wall: number): Promise<number> {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    mono += 120_000;
    const c = { wall, mono, wallMs: () => c.wall, monoMs: () => c.mono };
    return await R.runDoorbell(["--once", "--window-s", "10", "--horizon-s", "60"], { clock: c }); // supervision ON (the default)
  } finally {
    spy.mockRestore();
  }
}
const env = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: path.join(ROOT, "home"), RELAY_DB_PATH: DB, RELAY_FILESYSTEM_MARKERS: "0" });
let win: TestWindow;
/** The agent arms its watch: a DESCENDANT of its bound window (ruling ffcaf608 D1). */
const startWatch = (agent: string) => win.runRelayWatch([agent, "--until-wake", "--interval", "1"]);
const lockStatus = (agent: string) => spawnSync("node", [RELAY_BIN, "watch", agent, "--lock-status"], { env: env(), encoding: "utf-8" }).stdout.trim();
async function untilLive(agent: string): Promise<void> {
  for (let i = 0; i < 75 && lockStatus(agent) !== "live"; i++) await new Promise((r) => setTimeout(r, 200));
  expect(lockStatus(agent)).toBe("live");
}

describe.skipIf(!OWN)("PR 7: the doorbell supervises the watch (the real job, a real window, a real watch)", () => {
  beforeEach(async () => {
    // No process survives its test: a watch from the last test would hold its lock.
    for (const w of windows.splice(0)) await w.close();
    db.closeDb();
    fs.rmSync(path.join(ROOT, "inst"), { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, "inst"), { recursive: true });
    process.env.RELAY_DB_PATH = DB;
    db.getDb();
    db.registerAgent("s7-sender", "s", []);
    db.registerAgent("s7-alice", "r", []);
    win = openWindow(path.join(ROOT, `win-${Date.now()}`), env());
    windows.push(win);
    bindWindow("s7-alice", win.pid);
  });

  it("HARM (ruling 1a8fc7c4 (1)): an UNARMED agent with mail across MORE than K x H → ZERO intents, ZERO escalations, ONE no_driver(watch_absent) case; status shows it", async () => {
    db.sendMessage("s7-sender", "s7-alice", "x", "normal");
    const t0 = Date.now();
    const H = 60_000; // --horizon-s 60
    const cycles = (C.ESCALATE_AFTER + 2) * 2; // every H/2, past (K + 1) x H
    for (let i = 0; i <= cycles; i++) expect(await lifetime(t0 + (i * H) / 2)).toBe(0);
    expect(intents()).toBe(0);
    expect(recs().filter((r) => r.type === "escalation")).toEqual([]);
    expect(boards()).toEqual([["no_driver", "open", "watch_absent"]]); // A3.2: written once per state change
    // `relay doorbell status --json` shows it, with its why.
    const { readDoorbellStatus } = await import("../src/cli/doorbell.js");
    const st = (await readDoorbellStatus(DB, null)) as unknown as { open_board_cases: Array<{ agent_name: string; case: string; why?: string }> };
    expect(st.open_board_cases.map((c) => [c.agent_name, c.case, c.why])).toEqual([["s7-alice", "no_driver", "watch_absent"]]);
  }, 60_000);

  it("twin (the seam stays): WITH an actuating driver that fits, an unarmed agent IS intended, and no no_driver case is opened", async () => {
    db.sendMessage("s7-sender", "s7-alice", "x", "normal");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      mono += 120_000;
      const c = { wall: Date.now(), mono, wallMs: () => c.wall, monoMs: () => c.mono };
      expect(await R.runDoorbell(["--once", "--window-s", "10", "--horizon-s", "60"], { clock: c, actuator: { fits: () => true } })).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(intents()).toBe(1);
    expect(boards()).toEqual([]);
  }, 30_000);

  it("HARM: a LIVE watch → NO intent at all (the watch is the wake); the open no_driver case closes", async () => {
    expect(await lifetime(Date.now())).toBe(0); // no mail yet
    db.sendMessage("s7-sender", "s7-alice", "x", "normal");
    expect(await lifetime(Date.now())).toBe(0);
    expect(boards()).toEqual([["no_driver", "open", "watch_absent"]]);
    const before = intents();
    // The agent arms its watch: it wakes for the pending id, then the RE-ARMED watch stays live (already woken).
    expect(await within(startWatch("s7-alice").exited, 20_000)).toBe(0);
    const rearmed = startWatch("s7-alice");
    await untilLive("s7-alice");
    db.sendMessage("s7-sender", "s7-alice", "y", "normal"); // new mail: the doorbell must still NOT intend it
    expect(await within(rearmed.exited, 20_000)).toBe(0); // the watch wakes for it
    startWatch("s7-alice");
    await untilLive("s7-alice");
    expect(await lifetime(Date.now())).toBe(0);
    expect(intents()).toBe(before);
    expect(boards()).toEqual([
      ["no_driver", "open", "watch_absent"],
      ["no_driver", "closed", "watch_absent"],
    ]);
  }, 90_000);

  it("woken-for mail still undelivered after H → undelivered_with_watch (shown, never rung); within H → nothing", async () => {
    db.sendMessage("s7-sender", "s7-alice", "x", "normal");
    expect(await within(startWatch("s7-alice").exited, 20_000)).toBe(0); // woken for it
    startWatch("s7-alice");
    await untilLive("s7-alice");
    expect(await lifetime(Date.now())).toBe(0);
    expect(boards()).toEqual([]);
    expect(await lifetime(Date.now() + 61_000)).toBe(0); // past H = 60 s, heartbeat still fresh
    expect(boards()).toEqual([["undelivered_with_watch", "open", null]]);
    expect(intents()).toBe(0);
  }, 60_000);

  it.skipIf(W.awakeNowMs() === null)("a HUNG watch (lock held, its own heartbeat older than the stale bound on the AWAKE clock) → no_driver(watch_stale)", async () => {
    db.sendMessage("s7-sender", "s7-alice", "x", "normal");
    expect(await within(startWatch("s7-alice").exited, 20_000)).toBe(0);
    startWatch("s7-alice");
    await untilLive("s7-alice");
    // Staleness is AWAKE time (Codex R2 (c)): moving the job's wall clock proves nothing; age the holder's own stamp.
    const dir = W.watchWindowDir(DB, "s7-alice", { pid: win.pid, start: processStartedAt(win.pid) as string });
    const h = JSON.parse(fs.readFileSync(path.join(dir, W.watchHolderFile(0)), "utf-8"));
    W.writeHeartbeat(dir, { pid: h.pid, gen: 0, at: new Date().toISOString(), awake_ms: (W.awakeNowMs() as number) - W.HEARTBEAT_STALE_MS - 60_000 });
    expect(await lifetime(Date.now())).toBe(0);
    expect(boards()).toEqual([["no_driver", "open", "watch_stale"]]);
  }, 60_000);
});
