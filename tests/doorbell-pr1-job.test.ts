// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 1 — the JOB, as a real process: `node dist/doorbell.js` against a scratch
 * relay DB found through the ONE resolver (RELAY_DB_PATH). Plan v3 PR 1 red tests:
 *   - V4: a restart never re-rings (reading session, id); the rescue twin rings again;
 *     a NULL session is never a target;
 *   - scrambling seq / epoch changes no intent (the ADR-0046 metamorphic shape);
 *   - a foreign-edge row colliding on the name is never a candidate;
 *   - V1: the relay DB is byte-identical after cycles, and its file is held READ-ONLY;
 *   - no listening socket (no network fd at all); SIGTERM stops it cleanly;
 *   - a resolver fault, a missing DB or a corrupt log refuse the start (exit 1);
 *   - the provenance header carries LOADED_BUILD, the install and the resolution;
 *   - the connector classifier reads the job's real argv as NOT relay (the deploy check
 *     never fails on it), and dist/doorbell.js loads the deps snapshot FIRST.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(REPO_ROOT, "dist", "doorbell.js");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-pr1-job-")));
const DB = path.join(ROOT, "inst", "relay.db");
const LOG = path.join(ROOT, "inst", "doorbell", "actuation.jsonl");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const db = await import("../src/db.js");
const { getOwnHostId, processStartedAt } = await import("../src/liveness.js");
const { realSystemDeps } = await import("../src/fleet-system.js");
const { classifyProcess } = await import("../src/fleet-verdicts.js");
const { runDoorbell } = await import("../src/doorbell-run.js");
const L = await import("../src/doorbell-log.js");
/** Run the job IN-PROCESS (for its test seams) and capture what it says on stderr. */
async function inProcess(argv: string[], opts: import("../src/doorbell-run.js").DoorbellOptions = {}): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => ((stderr += String(chunk)), true));
  try {
    return { code: await runDoorbell(argv, opts), stderr };
  } finally {
    spy.mockRestore();
  }
}

const HOST = getOwnHostId();
const env = (over: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? "", HOME: path.join(ROOT, "home"), RELAY_DB_PATH: DB, ...over });
function once(over: Record<string, string> = {}, extra: string[] = []) {
  const r = spawnSync(process.execPath, [ENTRY, "--once", ...extra], { encoding: "utf-8", env: env(over), timeout: 30_000 });
  return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}
type Rec = { type: string; covers?: { reading_session: string; message_ids: string[] }; intent?: { agent_name: string }; build?: { build_id: string }; install_dir?: string; resolution?: { kind: string } };
const records = (): Rec[] => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const intents = () => records().filter((r) => r.type === "intent");
/** Time passing, as the log records it: every intent moved `ms` into the past (still a valid record). */
function ageLog(ms: number): void {
  const lines = fs.readFileSync(LOG, "utf-8").split("\n").filter(Boolean).map((l) => {
    const r = JSON.parse(l);
    if (r.type === "intent") r.at = new Date(Date.parse(r.at) - ms).toISOString();
    return JSON.stringify(r);
  });
  fs.writeFileSync(LOG, lines.join("\n") + "\n");
}
const send = (to: string) => db.sendMessage("db-sender", to, "content that must never reach the log", "normal").id;
const setSession = (name: string, s: string | null) => void db.getDb().prepare("UPDATE agents SET session_id = ? WHERE name = ?").run(s, name);
function bindHere(agent: string, conv: string): void {
  db.upsertAgentBinding(db.getDb(), {
    hostId: HOST as string,
    windowPid: process.pid,
    windowPidStart: processStartedAt(process.pid) as string,
    agentName: agent,
    agentClass: null,
    conversationId: conv,
    conversationTitle: null,
    cwd: ROOT,
    boundVia: "launch-intent",
  });
}

beforeEach(() => {
  db.closeDb();
  fs.rmSync(path.join(ROOT, "inst"), { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, "inst"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "home"), { recursive: true });
  process.env.RELAY_DB_PATH = DB;
  db.getDb();
  db.registerAgent("db-sender", "s", []);
  db.registerAgent("db-alice", "r", []);
  bindHere("db-alice", "conv-alice");
});

describe.skipIf(!HOST)("the doorbell job, a real process (plan v3 PR 1)", () => {
  it("one intent for new mail, content-free; the header carries LOADED_BUILD, the install and the resolution; the relay DB is byte-identical", () => {
    const m1 = send("db-alice");
    // The test's own connection stays open: the WAL sidecars exist (ruling 8c83e4ce D-1).
    const before = fs.readFileSync(DB);
    const walBefore = fs.readFileSync(`${DB}-wal`);
    const r = once();
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(DB).equals(before)).toBe(true); // V1 restated: the main file is never written
    expect(fs.readFileSync(`${DB}-wal`).equals(walBefore)).toBe(true); // ...and neither is -wal
    const recs = records();
    expect(recs[0]).toMatchObject({ type: "header", install_dir: fs.realpathSync(REPO_ROOT), resolution: { kind: "explicit-db" } });
    expect(recs[0].build?.build_id).toMatch(/^([0-9a-f]{64}|unbuilt)$/);
    expect(intents().map((i) => [i.intent?.agent_name, i.covers?.message_ids])).toEqual([["db-alice", [m1]]]);
    expect(fs.readFileSync(LOG, "utf-8")).not.toContain("content that must never reach the log");
  });

  it("HARM (V4): a RESTART after a ring does not re-ring the same (reading session, id)", () => {
    send("db-alice");
    expect(once().status).toBe(0);
    expect(once().status).toBe(0);
    expect(intents()).toHaveLength(1);
  });

  it("HARM (V4 rescue twin): the same id re-pended to a NEW reading session (a re-registration) DOES ring", () => {
    const m1 = send("db-alice");
    expect(once().status).toBe(0);
    const first = intents()[0].covers?.reading_session;
    setSession("db-alice", "a-later-window-session");
    ageLog(120_000); // past the coalescing window (PR 2), so only V4 decides
    expect(once().status).toBe(0);
    // The LAST intent is the new ring: the same id, under the new session. (Whether the old
    // one survives the start's compaction depends on its age: PR 2 keeps the last hour.)
    const last = intents().at(-1)?.covers;
    expect(last?.message_ids).toEqual([m1]);
    expect(last?.reading_session).toMatch(/^[0-9a-f]{64}$/);
    expect(last?.reading_session).not.toBe(first);
  });

  it("PR 2 (Q3), real process: new mail after a RESTART inside the window is held (ring times come back from the log); past W it rings once", () => {
    send("db-alice");
    expect(once().status).toBe(0);
    const m2 = send("db-alice");
    expect(once().status).toBe(0); // a fresh process, < 60 s after the first ring
    expect(intents()).toHaveLength(1);
    ageLog(120_000);
    expect(once().status).toBe(0);
    expect(intents().map((i) => i.covers?.message_ids)).toEqual([expect.any(Array), [m2]]);
  });

  it("PR 2 x D-2: the start's compaction keeps the last hour's rings, so a restart never UNDERCOUNTS the budget", () => {
    for (let i = 0; i < 6; i++) {
      send("db-alice");
      expect(once({}, ["--window-s", "10"]).status).toBe(0);
      ageLog(11_000); // past the 10 s window, still well inside the hour
    }
    expect(intents()).toHaveLength(6);
    db.getDb().prepare("UPDATE messages SET resolved_at = ? WHERE to_agent = 'db-alice'").run(new Date().toISOString()); // none pending now
    send("db-alice");
    const r = once({}, ["--window-s", "10"]); // compacts first: the six rings are NOT pending, but inside the hour
    expect(r.status, r.stderr).toBe(0);
    expect(intents()).toHaveLength(6); // the 7th is refused
    expect(records().filter((x) => x.type === "budget").map((x) => (x as { state?: string }).state)).toEqual(["exhausted"]);
  });

  it("HARM (V4): a NULL-session agent with pending mail produces NO intent", () => {
    send("db-alice");
    setSession("db-alice", null);
    expect(once().status).toBe(0);
    expect(intents()).toEqual([]);
  });

  it("HARM (ADR-0046 metamorphic): scrambling seq and epoch changes no intent (two mails in the SAME millisecond: the CI shape)", () => {
    send("db-alice");
    send("db-alice");
    db.getDb().prepare("UPDATE messages SET created_at = ? WHERE to_agent = ?").run(new Date().toISOString(), "db-alice");
    expect(once().status).toBe(0);
    const first = intents().map((i) => i.covers);
    fs.rmSync(path.join(ROOT, "inst", "doorbell"), { recursive: true });
    db.getDb().prepare("UPDATE messages SET seq = abs(random()) % 100000, epoch = lower(hex(randomblob(8)))").run();
    expect(once().status).toBe(0);
    expect(intents().map((i) => i.covers)).toEqual(first);
  });

  it("HARM: a FOREIGN-edge row (planted past the trigger) colliding on the name is never a candidate", () => {
    db.registerAgent("db-remote", "r", []);
    send("db-remote");
    const d = db.getDb();
    d.exec("DROP TRIGGER agent_bindings_local_edge_insert");
    const local = d.prepare("SELECT * FROM agent_bindings WHERE agent_name = 'db-alice'").get() as Record<string, unknown>;
    const cols = Object.keys(local);
    const foreign = { ...local, edge_id: "11111111-1111-4111-8111-111111111111", binding_id: "foreign-binding", agent_name: "db-remote", conversation_id: "conv-remote" };
    d.prepare(`INSERT INTO agent_bindings (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => foreign[c as keyof typeof foreign]));
    expect(once().status).toBe(0);
    expect(intents().map((i) => i.intent?.agent_name)).toEqual([]);
  });

  it("D-1 (ruling 8c83e4ce): NO WAL sidecars → the DB is not opened, WAITING-FOR-WRITER (exit 0), and no sidecar is created", () => {
    send("db-alice");
    db.closeDb(); // the last connection: SQLite checkpoints and removes -wal and -shm
    expect([fs.existsSync(`${DB}-wal`), fs.existsSync(`${DB}-shm`)]).toEqual([false, false]); // precondition
    const r = once();
    expect([r.status, r.stderr]).toEqual([0, expect.stringMatching(/WAITING-FOR-WRITER: the relay DB has no -wal and -shm yet/)]);
    expect([fs.existsSync(`${DB}-wal`), fs.existsSync(`${DB}-shm`)]).toEqual([false, false]);
    expect(intents()).toEqual([]);
  });

  it("D-1: a sidecar REPLACED while the DB was being opened → the handle is closed at once, waiting; no intent", async () => {
    send("db-alice");
    const r = await inProcess(["--once"], {
      afterDbOpen: () => {
        const shm = `${DB}-shm`;
        fs.copyFileSync(shm, `${shm}.swap`);
        fs.renameSync(`${shm}.swap`, shm); // same bytes, a NEW inode
      },
    });
    expect([r.code, r.stderr]).toEqual([0, expect.stringMatching(/a WAL sidecar changed while the relay DB was being opened/)]);
    expect(intents()).toEqual([]);
  });

  it("HARM (#4): an fsync failure after a complete write STOPS the job (exit 1, no retry); a restart adds NO duplicate", async () => {
    send("db-alice");
    // Fail the fsync of the first INTENT append (the header's and a compaction's fsyncs pass).
    let lastWrite = "";
    let failed = false;
    const io = {
      ...L.realLogIo,
      writeSync: (fd: number, buf: Buffer, off: number, len: number) => ((lastWrite = buf.toString("utf-8")), fs.writeSync(fd, buf, off, len)),
      fsyncSync: (fd: number) => {
        if (!failed && lastWrite.includes('"type":"intent"')) {
          failed = true;
          throw new Error("EIO (injected)");
        }
        fs.fsyncSync(fd);
      },
    };
    const r = await inProcess(["--interval-ms", "1000"], { logIo: io }); // a LOOP, which would otherwise retry
    expect([r.code, r.stderr]).toEqual([1, expect.stringMatching(/DOORBELL_FAILED: the doorbell log write did not complete .*stopping/)]);
    expect(intents()).toHaveLength(1); // the line was written; only its fsync failed
    expect(once().status).toBe(0); // the restart rebuilds rung memory from the log
    expect(intents()).toHaveLength(1);
  });

  it("a resolver fault, or a missing DB, refuses the start (exit 1) and creates no state dir", () => {
    db.closeDb();
    const fault = once({ RELAY_DB_PATH: "", RELAY_INSTANCE_ID: "../escape" });
    expect([fault.status, fault.stderr]).toEqual([1, expect.stringMatching(/DOORBELL_FAILED: the relay DB cannot be resolved/)]);
    const missing = once({ RELAY_DB_PATH: path.join(ROOT, "nowhere", "relay.db") });
    expect([missing.status, missing.stderr]).toEqual([1, expect.stringMatching(/DOORBELL_FAILED: no relay DB/)]);
    expect(fs.existsSync(path.join(ROOT, "nowhere"))).toBe(false);
  });

  it("a corrupt log refuses the start (exit 1): no cycle on a rung memory it cannot trust", () => {
    expect(once().status).toBe(0);
    fs.appendFileSync(LOG, '{"v":1,"type":"intent"}\n');
    const r = once();
    expect([r.status, r.stderr]).toEqual([1, expect.stringMatching(/not a valid doorbell record/)]);
  });

  it("a LIVE job: no network fd at all; the relay DB held read-only; the classifier reads it NOT relay; SIGTERM stops it cleanly", async () => {
    const child = spawn(process.execPath, [ENTRY, "--interval-ms", "1000"], { env: env(), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += String(b)));
    try {
      for (let t0 = Date.now(); !fs.existsSync(LOG) || !fs.readFileSync(LOG, "utf-8").includes('"header"'); ) {
        if (Date.now() - t0 > 15_000) throw new Error(`the job never wrote its header: ${stderr}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      const pid = child.pid as number;
      for (let t0 = Date.now(); !spawnSync("lsof", ["-nP", "-p", String(pid)], { encoding: "utf-8" }).stdout.includes(DB); ) {
        if (Date.now() - t0 > 10_000) throw new Error(`the job never opened the relay DB: ${stderr}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      const net = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-i"], { encoding: "utf-8" });
      expect(net.stdout.trim(), "the job holds a network socket").toBe("");
      const files = spawnSync("lsof", ["-nP", "-p", String(pid)], { encoding: "utf-8" }).stdout.split("\n");
      const dbFds = files.filter((l) => l.endsWith(DB));
      expect(dbFds.length, files.join("\n")).toBeGreaterThan(0);
      // lsof's FD column is the fd, then the access MODE (r / w / u), then an optional
      // lock flag ("20rr" on Linux = fd 20, mode r, read lock): the mode must be r.
      for (const l of dbFds) expect(l.split(/\s+/)[3], l).toMatch(/^\d+r/);
      const e = realSystemDeps.processTable().get(pid);
      expect(e, "the job is in the process table").toBeTruthy();
      const view = { pid, ppid: e!.ppid, start: e!.startedAt, command: e!.command, comm: e!.comm, cwd: realSystemDeps.cwds([pid]).get(pid) ?? null, argv: realSystemDeps.exactArgv(pid) };
      expect(classifyProcess(view, new Set())).toMatchObject({ kind: "not-relay" });
    } finally {
      child.kill("SIGTERM");
    }
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    expect(code, stderr).toBe(0);
  }, 40_000);
});

describe("the entry", () => {
  it("dist/doorbell.js imports the deps snapshot FIRST (ADR-0047: the build it reports is the one it loaded)", () => {
    const imports = fs.readFileSync(ENTRY, "utf-8").split("\n").filter((l) => /^\s*import[\s{"']/.test(l));
    expect(imports[0]).toMatch(/^import\s+["']\.\/deps-snapshot\.js["'];?$/);
  });
  it("--help exits 0 on stderr; a bad interval is a usage error (2)", () => {
    const h = spawnSync(process.execPath, [ENTRY, "--help"], { encoding: "utf-8", env: env() });
    expect([h.status, h.stdout]).toEqual([0, ""]);
    expect(h.stderr).toMatch(/Usage: node dist\/doorbell\.js/);
    expect(spawnSync(process.execPath, [ENTRY, "--interval-ms", "5"], { encoding: "utf-8", env: env() }).status).toBe(2);
  });
});
