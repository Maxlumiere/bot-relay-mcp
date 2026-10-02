// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #301 Codex R1 P1 + architect ruling 622689ba — the window and the budget survive WALL-CLOCK JUMPS.
 *   (1) Within a lifetime, all window and budget arithmetic is MONOTONIC; each intent carries its
 *       wall time AND its monotonic offset since the lifetime's header.
 *   (2) Across a restart, a previous lifetime's ring counts iff its wall age < 1 h, or that age is
 *       IMPLAUSIBLE (negative, or the log's last header is ahead of now: fail safe). A forward jump
 *       entirely inside the restart gap is a documented known limit.
 *   (3) Compaction keeps each agent's last N intents regardless of wall age, as EVIDENCE only.
 *   (4) An in-lifetime jump (|wall Δ − mono Δ| > 5 s) writes a closed `clock` record.
 * The job runs IN-PROCESS with a fake clock (a test seam the command line cannot reach).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-clock-")));
const DB = path.join(ROOT, "inst", "relay.db");
const LOGP = path.join(ROOT, "inst", "doorbell", "actuation.jsonl");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const C = await import("../src/doorbell-core.js");
const L = await import("../src/doorbell-log.js");
const db = await import("../src/db.js");
const { runDoorbell } = await import("../src/doorbell-run.js");
const { getOwnHostId, processStartedAt } = await import("../src/liveness.js");

const HOST = getOwnHostId();
const T = Date.parse("2026-10-02T08:00:00.000Z");
const H = 3_600_000;
const recs = () => (fs.existsSync(LOGP) ? fs.readFileSync(LOGP, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const intents = () => recs().filter((r) => r.type === "intent");
const send = () => db.sendMessage("ck-sender", "ck-alice", "x", "normal").id;
const resolveAll = () => void db.getDb().prepare("UPDATE messages SET resolved_at = ? WHERE to_agent = 'ck-alice'").run(new Date().toISOString());

/** A fake clock the test moves. */
function fakeClock(wall: number, mono = 1_000_000) {
  const c = { wall, mono, wallMs: () => c.wall, monoMs: () => c.mono };
  return c;
}
async function job(argv: string[], opts: import("../src/doorbell-run.js").DoorbellOptions): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((ch: unknown) => ((stderr += String(ch)), true));
  try {
    return { code: await runDoorbell(argv, opts), stderr };
  } finally {
    spy.mockRestore();
  }
}
/** One LIFETIME that rings whatever is new, at a given wall time. */
const lifetime = (wall: number, extra: string[] = []) => job(["--once", "--window-s", "10", ...extra], { clock: fakeClock(wall) });

beforeEach(() => {
  db.closeDb();
  fs.rmSync(path.join(ROOT, "inst"), { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, "inst"), { recursive: true });
  process.env.RELAY_DB_PATH = DB;
  db.getDb();
  db.registerAgent("ck-sender", "s", []);
  db.registerAgent("ck-alice", "r", []);
  db.upsertAgentBinding(db.getDb(), {
    hostId: HOST as string,
    windowPid: process.pid,
    windowPidStart: processStartedAt(process.pid) as string,
    agentName: "ck-alice",
    agentClass: null,
    conversationId: "conv-ck",
    conversationTitle: null,
    cwd: ROOT,
    boundVia: "launch-intent",
  });
});

describe("effectiveRingMono: a previous lifetime's rings on this lifetime's clock (rule 2)", () => {
  it("plausible rings sit at minus their wall age; a negative age, or a log header AHEAD of now, counts as 'just now' (fail safe)", () => {
    const walls = new Map([["a", [T - 10_000, T - 3 * 24 * H, T + 5000]]]);
    expect(C.effectiveRingMono(walls, T - 20_000, T).get("a")).toEqual([-10_000, -3 * 24 * H, 0]);
    expect(C.effectiveRingMono(walls, T + H, T).get("a")).toEqual([0, 0, 0]); // the last header is ahead: a backward jump
  });
});

describe.skipIf(!HOST)("the job across wall-clock jumps (ruling 622689ba)", () => {
  it("Codex 1 (MEASURED): 6 rings, then the wall jumps +1 h inside the lifetime → NO 7th; the jump is recorded", async () => {
    const clock = fakeClock(T);
    const p = job(["--interval-ms", "1000", "--window-s", "10"], {
      clock,
      beforeCycle: (n) => {
        if (n > 0) clock.mono += 11_000;
        clock.wall += n > 0 ? 11_000 : 0;
        if (n === 6) clock.wall += H; // the jump
        if (n <= 6) send();
        if (n === 7) process.emit("SIGTERM");
      },
    });
    const r = await p;
    expect(r.code).toBe(0);
    expect(intents()).toHaveLength(6);
    expect(recs().filter((x) => x.type === "budget").map((x) => x.state)).toEqual(["exhausted"]);
    expect(recs().filter((x) => x.type === "clock")).toMatchObject([{ wall_delta_ms: 11_000 + H, mono_delta_ms: 11_000 }]);
  }, 30_000);

  it("Codex 2 (MEASURED): the wall jumps −1 h → the 60 s hold stays 60 s MONOTONIC (the next mail rings at +61 s)", async () => {
    const clock = fakeClock(T);
    const r = await job(["--interval-ms", "1000"], {
      clock,
      beforeCycle: (n) => {
        if (n === 0) send();
        if (n === 1) {
          clock.wall -= H;
          clock.mono += 61_000;
          send();
        }
        if (n === 2) process.emit("SIGTERM");
      },
    });
    expect(r.code).toBe(0);
    expect(intents()).toHaveLength(2);
    expect(intents().map((i) => i.mono_ms)).toEqual([0, 61_000]);
  }, 30_000);

  it("Codex 3 (MEASURED): forward jump + compaction + correction → NO extra ring (the last N survive as evidence)", async () => {
    for (let i = 0; i < 6; i++) {
      send();
      expect((await lifetime(T + i * 11_000)).code).toBe(0);
    }
    expect(intents()).toHaveLength(6);
    resolveAll(); // none pending: only rule (3) keeps them
    expect((await lifetime(T + 2 * H)).code).toBe(0); // a lifetime under a forward-jumped clock: its compaction must keep them
    expect(intents()).toHaveLength(6);
    send();
    expect((await lifetime(T + 120_000)).code).toBe(0); // corrected clock: the six are counted again
    expect(intents()).toHaveLength(6);
  }, 60_000);

  it("NEW: an agent rung N times DAYS ago, then a restart → a FULL budget (retention is not counting)", async () => {
    for (let i = 0; i < 6; i++) {
      send();
      expect((await lifetime(T - 3 * 24 * H + i * 11_000)).code).toBe(0);
    }
    send();
    const r = await lifetime(T);
    expect(r.code).toBe(0);
    expect(intents()).toHaveLength(7);
    expect(recs().filter((x) => x.type === "budget")).toEqual([]);
  }, 60_000);

  it("NEW: a BACKWARD jump across a restart → the previous rings still count (no 7th)", async () => {
    for (let i = 0; i < 6; i++) {
      send();
      expect((await lifetime(T + i * 11_000)).code).toBe(0);
    }
    send();
    expect((await lifetime(T - 2 * H)).code).toBe(0); // the clock went back two hours across the restart
    expect(intents()).toHaveLength(6);
  }, 60_000);
});

describe.skipIf(!HOST)("rule 2's header test, isolated", () => {
  it("a later lifetime's header AHEAD of now (a backward jump) → rings with a PLAUSIBLE 2 h age still count (fail safe)", async () => {
    for (let i = 0; i < 6; i++) {
      send();
      expect((await lifetime(T + i * 11_000)).code).toBe(0);
    }
    expect((await lifetime(T + 5 * H)).code).toBe(0); // a lifetime whose header says T+5h
    send();
    expect((await lifetime(T + 2 * H)).code).toBe(0); // now T+2h: the six are a plausible 2 h old, but the last header is ahead
    expect(intents()).toHaveLength(6);
  }, 60_000);
});

describe("rule 4: the clock record is closed and bounded", () => {
  it("a valid clock record passes; an extra key or an unbounded field is refused", () => {
    const good = { v: 1, type: "clock", at: "2026-10-02T08:00:00.000Z", mono_ms: 1000, wall_delta_ms: -3_600_000, mono_delta_ms: 1000 };
    expect(L.recordFault(good)).toBeNull();
    expect(L.recordFault({ ...good, note: "x" })).toMatch(/exactly/);
    expect(L.recordFault({ ...good, mono_delta_ms: 1.5 })).toMatch(/bounded/);
    expect(L.recordFault({ ...good, wall_delta_ms: 1e20 })).toMatch(/bounded/);
  });
});
