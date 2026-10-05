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
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
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
    starts: 1, starts_since: "2026-10-05T08:00:00.000Z", cycles: 1, interval_ms: 5000, condition: "ok", condition_since: "2026-10-05T08:00:00.000Z", consecutive_failures: 0, cycle_failures: 0, last_failure: null,
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

// ---------------------------------------------------------------------------------------------
// #304 Codex R1 (rulings b556c011 and the detail items): F1–F5, F7, F8b
// ---------------------------------------------------------------------------------------------
const L5 = await import("../src/doorbell-log.js");
const LK = await import("../src/doorbell-lock.js");
const STATE = path.join(ROOT, "inst", "doorbell");
/** Heartbeat renames at the FILESYSTEM boundary (F8b): never trust the callback alone. */
function countHeartbeatRenames() {
  const spy = vi.spyOn(fs, "renameSync");
  return {
    count: () => spy.mock.calls.filter(([, dest]) => String(dest).endsWith(HBM.HEARTBEAT_FILENAME)).length,
    restore: () => spy.mockRestore(),
  };
}

describe.skipIf(!HOST)("#304 R1 F8b: once per attempt, counted at the FILESYSTEM boundary", () => {
  it("HARM: 3 attempts → exactly 3 heartbeat renames (a duplicated write would show here, not in the callback)", async () => {
    const c = countHeartbeatRenames();
    try {
      const r = await loop(3);
      expect(r.writes).toHaveLength(3);
      expect(c.count()).toBe(3);
    } finally {
      c.restore();
    }
  }, 20_000);
});

describe.skipIf(!HOST)("#304 R1 F2: the fail-stop path writes its heartbeat too (kind log-write)", () => {
  it("HARM: a LogWriteError on cycle 1 → exactly ONE heartbeat write, recording log-write, then the stop", async () => {
    send();
    const io = { ...L5.realLogIo, writeSync: (fd: number, buf: Buffer, off: number, len: number) => (buf.toString("utf-8").includes('"type":"intent"') ? 0 : fs.writeSync(fd, buf, off, len)) };
    const c = countHeartbeatRenames();
    try {
      const r = await job(["--once"], { clock: fakeClock(T), logIo: io });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/DOORBELL_FAILED/);
      expect(c.count()).toBe(1);
      expect([onDisk()?.cycles, onDisk()?.last_failure?.kind, onDisk()?.consecutive_failures]).toEqual([1, "log-write", 1]);
    } finally {
      c.restore();
    }
  });
});

describe.skipIf(!HOST)("#304 R1 F3: the failure streak spans restarts", () => {
  const failing = { beforeCycle: () => { throw new Error("injected"); } };
  it("HARM: three --once runs, each failing → 1, 2, 3 → FAILING (last_failure carried)", async () => {
    const seen: Array<[number | undefined, string | undefined]> = [];
    for (let k = 0; k < 3; k++) {
      await job(["--once"], { clock: fakeClock(T + k * 60_000), ...failing });
      seen.push([onDisk()?.consecutive_failures, onDisk()?.condition]);
    }
    expect(seen).toEqual([[1, "ok"], [2, "ok"], [3, "failing"]]);
    expect(onDisk()?.starts).toBe(3);
  });
  it("a success resets it; an UNREADABLE previous heartbeat resets it to 0 (visibly: starts_since moves)", async () => {
    await job(["--once"], { clock: fakeClock(T), ...failing });
    await job(["--once"], { clock: fakeClock(T + 60_000) });
    expect(onDisk()?.consecutive_failures).toBe(0);
    await job(["--once"], { clock: fakeClock(T + 120_000), ...failing });
    fs.writeFileSync(HB, "{junk");
    const r = await job(["--once"], { clock: fakeClock(T + 180_000), ...failing });
    expect(r.stderr).toMatch(/unreadable/);
    expect([onDisk()?.consecutive_failures, onDisk()?.starts, onDisk()?.starts_since]).toEqual([1, 1, new Date(T + 180_000).toISOString()]);
  });
});

describe.skipIf(!HOST)("#304 R1 F4: cycle_failures, this lifetime's total", () => {
  it("HARM: failures at attempts 1 and 3, successes otherwise → the total is kept while the streak resets", async () => {
    let n = 0;
    const r = await loop(5, { beforeCycle: () => { n++; if (n === 1 || n === 3) throw new Error("injected"); } });
    expect(r.writes.map((w) => [w.cycle_failures, w.consecutive_failures])).toEqual([[1, 1], [1, 0], [2, 1], [2, 0], [2, 0]]);
  }, 20_000);
});

describe.skipIf(!HOST)("#304 R1 F1: condition_since", () => {
  it("is carried across a restart while the condition is unchanged, and moves when it changes", async () => {
    db.closeDb(); // no WAL sidecars → waiting-for-writer
    await job(["--once"], { clock: fakeClock(T) });
    await job(["--once"], { clock: fakeClock(T + 120_000) });
    expect([onDisk()?.condition, onDisk()?.condition_since]).toEqual(["waiting-for-writer", new Date(T).toISOString()]); // carried
    db.getDb(); // a writer appears
    await job(["--once"], { clock: fakeClock(T + 180_000) });
    expect([onDisk()?.condition, onDisk()?.condition_since]).toEqual(["ok", new Date(T + 180_000).toISOString()]); // moved
  });
  it("HARM (#304 R2 #4): a BACKWARD clock jump never leaves condition_since in the FUTURE: beyond the 5 s tolerance it resets to now (within it, it is kept)", async () => {
    db.closeDb(); // no WAL sidecars → waiting-for-writer
    await job(["--once"], { clock: fakeClock(T) });
    await job(["--once"], { clock: fakeClock(T - HBM.FUTURE_TOLERANCE_MS + 1000) }); // back 4 s: within the tolerance
    expect(onDisk()?.condition_since).toBe(new Date(T).toISOString()); // kept
    await job(["--once"], { clock: fakeClock(T - 3_600_000) }); // back an hour
    expect([onDisk()?.condition, onDisk()?.condition_since]).toEqual(["waiting-for-writer", new Date(T - 3_600_000).toISOString()]); // reset to now
    await job(["--once"], { clock: fakeClock(T - 3_600_000 + 120_000) }); // 2 min later, still waiting
    const hb = onDisk()!;
    expect(Date.parse(hb.at) - Date.parse(hb.condition_since)).toBe(120_000); // so its age is real again: past the 60 s grace
  });
});

describe.skipIf(!HOST)("#304 R1 F7: every counter stays inside what its reader accepts", () => {
  it("HARM: starts at the bound → the next start writes a VALID heartbeat, the count restarting visibly", async () => {
    await job(["--once"], { clock: fakeClock(T) });
    fs.writeFileSync(HB, JSON.stringify({ ...onDisk(), starts: HBM.MAX_COUNT }));
    expect(HBM.heartbeatFault(onDisk())).toBeNull(); // precondition: the seeded value is accepted
    const r = await job(["--once"], { clock: fakeClock(T + 60_000) });
    expect(r.stderr).toMatch(/start count reached its bound/);
    expect(HBM.heartbeatFault(onDisk())).toBeNull();
    expect([onDisk()?.starts, onDisk()?.starts_since]).toEqual([1, new Date(T + 60_000).toISOString()]);
  });
  it("failure counters saturate at the bound, never past it", () => {
    expect([HBM.saturatingInc(HBM.MAX_COUNT), HBM.saturatingInc(HBM.MAX_COUNT - 1)]).toEqual([HBM.MAX_COUNT, HBM.MAX_COUNT]);
  });
});

const LOCK_DIST = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "dist", "doorbell-lock.js");
/**
 * A child PROCESS that tries the instance lock and prints "held" or "busy", then stays alive for
 * `holdMs` (0 = exit at once; -1 = until killed). It keeps NO reference to the handle and forces a
 * garbage collection: the lock module itself must pin a held connection (MEASURED: an unreferenced,
 * collected connection silently dropped the lock in 15 of 20 racing rounds before the pin).
 */
function lockChildScript(dir: string, holdMs: number): string {
  return `import { acquireInstanceLock } from ${JSON.stringify(LOCK_DIST)};
process.stdout.write(acquireInstanceLock(${JSON.stringify(dir)}, { pid: process.pid, proc_start: null, host_id: null }).ok ? "held\\n" : "busy\\n");
if (globalThis.gc) { gc(); gc(); }
${holdMs < 0 ? "setInterval(() => {}, 1000);" : `setTimeout(() => process.exit(0), ${holdMs});`}`;
}
const LOCKFILE = () => path.join(STATE, LK.LOCK_DB_FILENAME);
/** Every child a lock test spawns: ALWAYS killed after the test, so a failure can never leave one holding the worker open. */
const children = new Set<import("child_process").ChildProcess>();
afterEach(async () => {
  await Promise.all(
    [...children].map((c) => new Promise<void>((res) => {
      if (c.exitCode !== null || c.signalCode !== null) return res();
      c.once("exit", () => res());
      c.kill("SIGKILL");
    })),
  );
  children.clear();
});

describe.skipIf(!HOST)("#304 F5 (ruling ecf50062): the KERNEL-held instance lock", () => {
  it("HARM: a LIVE holder → exit 4, loud, naming the holder from its sidecar — and nothing touched the state dir: a temp file survives", async () => {
    fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
    const held = LK.acquireInstanceLock(STATE, { pid: 4242, proc_start: null, host_id: HOST });
    expect(held.ok).toBe(true);
    const tmp = path.join(STATE, ".state-file.tmp-heartbeat.json.99999");
    fs.writeFileSync(tmp, "in flight");
    try {
      const r = await job(["--once"], { clock: fakeClock(T) });
      expect(r.code).toBe(LK.EXIT_ALREADY_RUNNING);
      expect(r.stderr).toMatch(/DOORBELL_ALREADY_RUNNING: another doorbell holds this instance's lock \(held by pid 4242/);
      expect(fs.existsSync(tmp)).toBe(true); // openLog's cleanup never ran
    } finally {
      if (held.ok) LK.releaseInstanceLock(held.handle);
      fs.rmSync(tmp, { force: true });
    }
  });
  it("HARM: another PROCESS holds it → exit 4; kill -9 that process → the very next start takes over (no judging, no stale state)", async () => {
    const { spawn } = await import("child_process");
    fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, ["--expose-gc", "--input-type=module", "-e", lockChildScript(STATE, -1)], { stdio: ["ignore", "pipe", "inherit"] });
    children.add(child);
    await new Promise<void>((res, rej) => {
      child.stdout!.on("data", (d: Buffer) => (String(d).includes("held") ? res() : rej(new Error(String(d)))));
      child.on("exit", (code) => rej(new Error(`the holder child exited (${code}) before saying held`)));
    });
    expect((await job(["--once"], { clock: fakeClock(T) })).code).toBe(LK.EXIT_ALREADY_RUNNING);
    child.kill("SIGKILL");
    await new Promise((res) => child.on("exit", res));
    const r = await job(["--once"], { clock: fakeClock(T + 1000) });
    expect(r.code).toBe(0);
  }, 30_000);
  it("HARM: N racers on one instance → EXACTLY ONE holder, every round (8 processes × 8 rounds; every holder still ALIVE when counted, after a forced GC)", async () => {
    const { spawn } = await import("child_process");
    fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
    for (let round = 0; round < 8; round++) {
      const kids: Array<import("child_process").ChildProcess> = [];
      const outs = await Promise.all(
        Array.from({ length: 8 }, () =>
          new Promise<string>((res) => {
            const c = spawn(process.execPath, ["--expose-gc", "--input-type=module", "-e", lockChildScript(STATE, -1)], { stdio: ["ignore", "pipe", "inherit"] });
            kids.push(c);
            children.add(c);
            let out = "";
            c.stdout!.on("data", (d: Buffer) => {
              out += String(d);
              if (out.includes("\n")) res(out.trim());
            });
            c.on("exit", (code) => res(out.trim() || `crashed(${code})`)); // a crash FAILS the count, never hangs
          }),
        ),
      );
      // All eight answered while all are alive: two "held" here would be SIMULTANEOUS holders.
      expect(outs.filter((o) => o === "held"), `round ${round}: ${outs.join(",")}`).toHaveLength(1);
      expect(outs.filter((o) => o === "busy")).toHaveLength(7);
      await Promise.all(kids.map((c) => new Promise((r) => (c.on("exit", r), c.kill("SIGKILL")))));
    }
  }, 180_000);
  it("HARM (the POSIX pitfall): mid-run, the lock is STILL held against another process, and the job never opened the lock file a second time", async () => {
    const { spawnSync } = await import("child_process");
    const opens = vi.spyOn(fs, "openSync");
    const seenByOther: string[] = [];
    let heldFrom = -1; // the openSync calls made while the lock is HELD (the first cycle runs after acquisition)
    try {
      await loop(3, {
        beforeCycle: (k) => {
          if (k === 0) heldFrom = opens.mock.calls.length;
          if (k === 1) seenByOther.push(spawnSync(process.execPath, ["--input-type=module", "-e", lockChildScript(STATE, 0)], { encoding: "utf-8" }).stdout.trim());
        },
      });
      expect(seenByOther).toEqual(["busy"]); // after cleanup, compaction and heartbeats: still ours
      expect(heldFrom).toBeGreaterThanOrEqual(0); // precondition: the job reached its first cycle
      expect(opens.mock.calls.slice(heldFrom).filter(([p]) => String(p).endsWith(LK.LOCK_DB_FILENAME))).toEqual([]);
    } finally {
      opens.mockRestore();
    }
  }, 30_000);
  it("HARM (the TRAP, ruling ecf50062): BEGIN EXCLUSIVE is the connection's FIRST statement — no pragma, no read, nothing before it", async () => {
    // Deterministic, because the race cannot be: with locking_mode=EXCLUSIVE and a read first, every
    // racer keeps its SHARED lock and NONE wins (measured by the architect), but only when the reads
    // are truly simultaneous; staggered process starts let the first one win anyway (measured here:
    // the race test stays green under that mutation). So the rule itself is pinned.
    const { default: Database } = await import("better-sqlite3");
    const calls: string[] = [];
    // Record every statement-issuing call on ANY connection, in order (the originals still run).
    const orig = { exec: Database.prototype.exec, pragma: Database.prototype.pragma, prepare: Database.prototype.prepare };
    for (const m of ["exec", "pragma", "prepare"] as const) {
      (Database.prototype as unknown as Record<string, unknown>)[m] = function (this: unknown, ...args: unknown[]) {
        calls.push(`${m}:${String(args[0])}`);
        return (orig[m] as (...a: unknown[]) => unknown).apply(this, args);
      };
    }
    try {
      fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
      const r = LK.acquireInstanceLock(STATE, { pid: process.pid, proc_start: null, host_id: HOST });
      expect(r.ok).toBe(true);
      expect(calls).toEqual(["exec:BEGIN EXCLUSIVE"]);
      if (r.ok) LK.releaseInstanceLock(r.handle);
    } finally {
      Object.assign(Database.prototype, orig);
    }
  });
  it("HARM (#304 R2 #2): the path REPLACED between the driver's open and the identity check → the start REFUSES (it never records an inode it did not lock)", async () => {
    const { default: Database } = await import("better-sqlite3");
    const orig = Database.prototype.exec;
    for (const preExisting of [false, true]) {
      fs.rmSync(STATE, { recursive: true, force: true });
      fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
      if (preExisting) fs.writeFileSync(LOCKFILE(), "", { mode: 0o600 });
      let replaced = false;
      // Right after BEGIN EXCLUSIVE locks the opened file, a new file is renamed over the path.
      Database.prototype.exec = function (this: InstanceType<typeof Database>, sql: string) {
        const r = orig.call(this, sql);
        if (sql === "BEGIN EXCLUSIVE" && !replaced) {
          replaced = true;
          const other = path.join(STATE, "other.db");
          fs.writeFileSync(other, "", { mode: 0o600 });
          fs.renameSync(other, LOCKFILE());
        }
        return r;
      } as typeof orig;
      let threw: unknown = null;
      let res: ReturnType<typeof LK.acquireInstanceLock> | null = null;
      try {
        res = LK.acquireInstanceLock(STATE, { pid: process.pid, proc_start: null, host_id: HOST });
      } catch (err) {
        threw = err;
      } finally {
        Database.prototype.exec = orig;
      }
      if (res?.ok) LK.releaseInstanceLock(res.handle);
      expect(replaced, `preExisting=${preExisting}`).toBe(true); // precondition: the replace happened
      expect(String(threw), `preExisting=${preExisting}: a start that "holds" a lock on a path another job can lock`).toMatch(/replaced while it was being locked/);
    }
  });
  it("HARM (#304 R2 #3): a link planted at the holder sidecar's temp name never writes through to the lock DB: the DB is untouched and the lock is still held", async () => {
    const crypto = (await import("crypto")).default;
    fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
    fs.writeFileSync(LOCKFILE(), "", { mode: 0o600 });
    const fixed = Buffer.alloc(8, 7);
    const rb = vi.spyOn(crypto, "randomBytes").mockImplementation(((n: number) => (n === 8 ? fixed : Buffer.alloc(n, 7))) as typeof crypto.randomBytes);
    // Both spellings a sidecar temp has had: the pid-based one and the random one.
    for (const name of [`.holder-tmp-${process.pid}`, `.holder-tmp-${fixed.toString("hex")}`]) fs.symlinkSync(LOCKFILE(), path.join(STATE, name));
    try {
      const r = LK.acquireInstanceLock(STATE, { pid: process.pid, proc_start: null, host_id: HOST });
      expect(r.ok).toBe(true);
      try {
        // stat, never a read: opening and closing the lock DB in THIS process would itself drop the lock.
        expect(fs.statSync(LOCKFILE()).size, "the lock DB was written through the planted link").toBe(0);
        const { spawnSync } = await import("child_process");
        expect(spawnSync(process.execPath, ["--input-type=module", "-e", lockChildScript(STATE, 0)], { encoding: "utf-8" }).stdout.trim()).toBe("busy"); // still held
      } finally {
        if (r.ok) LK.releaseInstanceLock(r.handle);
      }
    } finally {
      rb.mockRestore();
    }
  });
  it("HARM: the lock FILE removed under a running job → it stops before its next attempt (a new starter could lock a new file)", async () => {
    const r = await loop(10, {
      beforeCycle: (k) => {
        if (k === 0) fs.unlinkSync(LOCKFILE());
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/the instance lock file was removed or replaced/);
    expect(r.writes).toHaveLength(1);
  }, 20_000);
  it("the holder SIDECAR is display-only: garbage in it never stops a start (correctness never reads it)", async () => {
    fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(STATE, LK.HOLDER_FILENAME), "{garbage");
    expect((await job(["--once"], { clock: fakeClock(T) })).code).toBe(0);
    expect(LK.readHolderInfo(STATE)?.pid).toBe(process.pid); // rewritten by the start that took the lock
  });
  it("the lock lives in the RESOLVED instance's state dir (stateDirFor(the resolver's dbPath)): a holder there refuses; a holder in ANOTHER instance does not", async () => {
    // A second, real instance B. The job resolves B (RELAY_DB_PATH) and must lock B's state dir, never A's.
    const dbB = path.join(ROOT, "instB", "relay.db");
    const stateB = path.join(ROOT, "instB", "doorbell");
    fs.rmSync(path.join(ROOT, "instB"), { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, "instB"), { recursive: true });
    db.closeDb();
    process.env.RELAY_DB_PATH = dbB;
    db.getDb();
    db.closeDb();
    fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
    fs.mkdirSync(stateB, { recursive: true, mode: 0o700 });
    const heldA = LK.acquireInstanceLock(STATE, { pid: 4242, proc_start: null, host_id: HOST });
    expect(heldA.ok).toBe(true);
    try {
      expect((await job(["--once"], { clock: fakeClock(T) })).code).toBe(0); // A's holder does not stop B's job
      expect(LK.readHolderInfo(stateB)?.pid).toBe(process.pid); // ...which took B's lock
      const heldB = LK.acquireInstanceLock(stateB, { pid: 4343, proc_start: null, host_id: HOST });
      expect(heldB.ok).toBe(true);
      try {
        const r = await job(["--once"], { clock: fakeClock(T) });
        expect(r.code).toBe(LK.EXIT_ALREADY_RUNNING); // B's holder does
        expect(r.stderr).toMatch(/held by pid 4343/);
      } finally {
        if (heldB.ok) LK.releaseInstanceLock(heldB.handle);
      }
    } finally {
      if (heldA.ok) LK.releaseInstanceLock(heldA.handle);
      process.env.RELAY_DB_PATH = DB;
    }
  });
});
