// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 5 — the HEARTBEAT, written by the job (plan v3 PR 5; architect ruling 9987c113).
 * The job runs IN-PROCESS on a real relay DB with a fake clock.
 *   - Q1 (i) STRUCTURAL: written ONLY by the cycle path, ONCE per cycle ATTEMPT, `cycles` = the
 *     attempt number in the same write; nothing writes it before the first attempt or between two.
 *   - Q2: `condition` = ok | waiting-for-writer | log-full | failing (3 failed attempts in a row).
 *   - Q4: `starts` / `starts_since`; an unreadable previous heartbeat resets visibly.
 *   - Q5: `last_failure.kind` is a CLOSED enum: pending-read | db-open | record-refused | other.
 *   - proc_start comes from the ONE UTC producer: equal under every TZ (#296 metamorphic).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-pr5-hb-")));
const DB = path.join(ROOT, "inst", "relay.db");
const HB = path.join(ROOT, "inst", "doorbell", "heartbeat.json");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const db = await import("../src/db.js");
const HBM = await import("../src/doorbell-heartbeat.js");
const { runDoorbell } = await import("../src/doorbell-run.js");
const { getOwnHostId, processStartedAt, isUtcStartToken } = await import("../src/liveness.js");
type Heartbeat = import("../src/doorbell-heartbeat.js").Heartbeat;

const HOST = getOwnHostId();
const T = Date.parse("2026-10-05T08:00:00.000Z");
const onDisk = (): Heartbeat | null => (fs.existsSync(HB) ? (JSON.parse(fs.readFileSync(HB, "utf-8")) as Heartbeat) : null);
const send = () => db.sendMessage("p5-sender", "p5-alice", "x", "normal").id;

function fakeClock(wall: number, mono = 1_000_000) {
  const c = { wall, mono, wallMs: () => c.wall, monoMs: () => c.mono };
  return c;
}
async function job(argv: string[], opts: import("../src/doorbell-run.js").DoorbellOptions = {}): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((ch: unknown) => ((stderr += String(ch)), true));
  try {
    return { code: await runDoorbell(argv, opts), stderr };
  } finally {
    spy.mockRestore();
  }
}
/** A LOOP run of exactly `n` attempts (fake clock advancing 1 s per attempt), with every heartbeat write observed. */
async function loop(n: number, opts: import("../src/doorbell-run.js").DoorbellOptions = {}) {
  const clock = fakeClock(T);
  const writes: Heartbeat[] = [];
  const r = await job(["--interval-ms", "1000"], {
    clock,
    ...opts,
    onHeartbeat: (hb) => {
      writes.push(hb);
      clock.wall += 1000;
      clock.mono += 1000;
      if (writes.length >= n) process.emit("SIGTERM");
    },
  });
  return { ...r, writes };
}

beforeEach(() => {
  db.closeDb();
  fs.rmSync(path.join(ROOT, "inst"), { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, "inst"), { recursive: true });
  process.env.RELAY_DB_PATH = DB;
  db.getDb();
  db.registerAgent("p5-sender", "s", []);
  db.registerAgent("p5-alice", "r", []);
  if (!HOST) return;
  db.upsertAgentBinding(db.getDb(), {
    hostId: HOST,
    windowPid: process.pid,
    windowPidStart: processStartedAt(process.pid) as string,
    agentName: "p5-alice",
    agentClass: null,
    conversationId: "conv-p5",
    conversationTitle: null,
    cwd: ROOT,
    boundVia: "launch-intent",
  });
});

describe.skipIf(!HOST)("Q1 (i): the heartbeat is written ONLY by the cycle path, once per ATTEMPT", () => {
  it("HARM: cycles = 1..N, one write per attempt, NOTHING before the first attempt, NOTHING between two (the file on disk at the start of attempt n+1 is attempt n's write)", async () => {
    const seenAtCycleStart: Array<Heartbeat | null> = [];
    const r = await loop(3, { beforeCycle: () => seenAtCycleStart.push(onDisk()) });
    expect(r.code).toBe(0);
    expect(r.writes.map((w) => w.cycles)).toEqual([1, 2, 3]);
    expect(seenAtCycleStart[0]).toBeNull(); // nothing written at start-up
    expect(seenAtCycleStart.slice(1)).toEqual(r.writes.slice(0, 2)); // between two attempts: exactly the previous attempt's write
    expect(onDisk()).toEqual(r.writes[2]);
    expect(HBM.heartbeatFault(onDisk())).toBeNull();
  }, 20_000);
  it("the heartbeat carries this lifetime's facts: pid, the UTC start token, started_at, interval, build, install, resolution", async () => {
    await job(["--once"], { clock: fakeClock(T) });
    const h = onDisk() as Heartbeat;
    expect([h.pid, h.interval_ms, h.started_at, h.at, h.condition, h.consecutive_failures, h.last_failure]).toEqual([process.pid, 5000, new Date(T).toISOString(), new Date(T).toISOString(), "ok", 0, null]);
    expect(h.proc_start).toBe(processStartedAt(process.pid));
    expect(isUtcStartToken(h.proc_start as string)).toBe(true);
    expect((h.resolution as { db_path: string }).db_path).toBe(DB);
  });
});

describe.skipIf(!HOST)("Q2: condition, never merged into the liveness states", () => {
  it("waiting-for-writer: no WAL sidecars → the attempt is counted, condition waiting-for-writer (not a failure)", async () => {
    db.closeDb(); // a clean close removes -wal and -shm
    expect(fs.existsSync(`${DB}-wal`)).toBe(false); // precondition
    const r = await job(["--once"], { clock: fakeClock(T) });
    expect(r.code).toBe(0);
    expect([onDisk()?.cycles, onDisk()?.condition, onDisk()?.consecutive_failures]).toEqual([1, "waiting-for-writer", 0]);
  });
  it("log-full: over the cap → condition log-full", async () => {
    send();
    await job(["--once"], { clock: fakeClock(T), logCapBytes: 1 });
    expect(onDisk()?.condition).toBe("log-full");
  });
  it("HARM: three failed attempts in a row → failing; a success resets the count (last_failure is kept)", async () => {
    let n = 0;
    const r = await loop(5, {
      beforeCycle: () => {
        if (n++ < 3) throw new Error("injected");
      },
    });
    expect(r.writes.map((w) => [w.consecutive_failures, w.condition])).toEqual([[1, "ok"], [2, "ok"], [3, "failing"], [0, "ok"], [0, "ok"]]);
    expect(r.writes.at(-1)?.last_failure?.kind).toBe("other");
  }, 20_000);
});

describe.skipIf(!HOST)("Q5: the failure kind is a CLOSED enum, by phase", () => {
  it("db-open: the relay DB cannot be opened for reading (a schema gap: no messages table)", async () => {
    db.getDb().exec("ALTER TABLE messages RENAME TO messages_moved");
    const r = await job(["--once"], { clock: fakeClock(T) });
    expect(r.code).toBe(1);
    expect(onDisk()?.last_failure?.kind).toBe("db-open");
  });
  it("pending-read: the cycle's own reads fail after the DB was opened (the bindings read)", async () => {
    const r = await loop(2, {
      beforeCycle: (k) => {
        if (k === 1) db.getDb().exec("ALTER TABLE agent_bindings DROP COLUMN conversation_title");
      },
    });
    expect(r.writes.map((w) => w.last_failure?.kind ?? null)).toEqual([null, "pending-read"]);
  }, 20_000);
  it("HARM (record-refused): the writer refuses a planned record → kind record-refused, nothing written to the log", async () => {
    send();
    const r = await job(["--once"], {
      clock: fakeClock(T),
      mutatePlan: (plan) => {
        for (const rec of plan.records) if (rec.type === "intent") (rec.intent as { agent_name: string }).agent_name = "not a valid name!";
      },
    });
    expect(r.code).toBe(1);
    expect(onDisk()?.last_failure?.kind).toBe("record-refused");
    expect(fs.readFileSync(path.join(ROOT, "inst", "doorbell", "actuation.jsonl"), "utf-8")).not.toContain("not a valid name!");
  });
  it("the kind is never free text: an error message never reaches the heartbeat", async () => {
    let n = 0;
    await loop(1, {
      beforeCycle: () => {
        if (n++ === 0) throw new Error("SECRET-PATH /Users/someone/.ssh/id_rsa");
      },
    });
    expect(fs.readFileSync(HB, "utf-8")).not.toContain("SECRET-PATH");
  }, 20_000);
});

describe.skipIf(!HOST)("Q4: starts / starts_since across restarts", () => {
  it("each start adds one; starts_since stays; an UNREADABLE previous heartbeat resets to 1 and moves starts_since (visible)", async () => {
    await job(["--once"], { clock: fakeClock(T) });
    await job(["--once"], { clock: fakeClock(T + 60_000) });
    expect([onDisk()?.starts, onDisk()?.starts_since]).toEqual([2, new Date(T).toISOString()]);
    fs.writeFileSync(HB, "{not json");
    const r = await job(["--once"], { clock: fakeClock(T + 120_000) });
    expect(r.stderr).toMatch(/previous heartbeat is unreadable/);
    expect([onDisk()?.starts, onDisk()?.starts_since]).toEqual([1, new Date(T + 120_000).toISOString()]);
  });
});

describe.skipIf(!HOST)("proc_start: the ONE UTC producer (#296), metamorphic under TZ", () => {
  it("HARM: the same process under two time zones writes the SAME start token", async () => {
    const tz = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      await job(["--once"], { clock: fakeClock(T) });
      const a = onDisk()?.proc_start;
      process.env.TZ = "Asia/Singapore";
      await job(["--once"], { clock: fakeClock(T + 1000) });
      const b = onDisk()?.proc_start;
      expect(a).toBe(b);
      expect(isUtcStartToken(a as string)).toBe(true);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe("the heartbeat's closed schema (pure)", () => {
  const good = (): Heartbeat => ({
    v: 1, at: "2026-10-05T08:00:00.000Z", pid: 42, proc_start: "Mon Oct  5 08:00:00 2026 UTC", started_at: "2026-10-05T08:00:00.000Z",
    starts: 1, starts_since: "2026-10-05T08:00:00.000Z", cycles: 1, interval_ms: 5000, condition: "ok", consecutive_failures: 0, last_failure: null,
    build: { build_id: "unbuilt", commit: null, dirty: null, built_at: null, deps_id: null, deps_state: "unknown", node: "v22.0.0" },
    install_dir: "/opt/relay", resolution: { kind: "explicit-db", db_path: "/x/relay.db", exists: true, containment: "strict", basis: "RELAY_DB_PATH" },
  });
  it("valid; and an extra key, a free-text kind, or a non-enum condition is refused", () => {
    expect(HBM.heartbeatFault(good())).toBeNull();
    expect(HBM.heartbeatFault({ ...good(), note: "x" })).toMatch(/exactly/);
    expect(HBM.heartbeatFault({ ...good(), last_failure: { at: "2026-10-05T08:00:00.000Z", kind: "ENOENT on /secret" } })).toMatch(/never free text/);
    expect(HBM.heartbeatFault({ ...good(), condition: "fine" })).toMatch(/condition must be one of/);
  });
});
