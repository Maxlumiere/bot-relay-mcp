// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #300 ruling 8c83e4ce D-2 — the log is bounded:
 *   - COMPACTED at the first successful DB open: an intent is kept while any of its
 *     (reading session, id) is still pending in ONE snapshot, plus the last few headers;
 *     crash-safe (temp + fsync + atomic rename + dir fsync; a crashed temp is discarded);
 *   - a TAILER following by path survives a compaction: nothing lost, nothing repeated;
 *   - a SIZE CAP checked every cycle: over it, no ring, LOG-FULL, said once per change.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-d2-")));
const DB = path.join(ROOT, "inst", "relay.db");
const LOGP = path.join(ROOT, "inst", "doorbell", "actuation.jsonl");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const L = await import("../src/doorbell-log.js");
const db = await import("../src/db.js");
const { runDoorbell } = await import("../src/doorbell-run.js");
const { getOwnHostId, processStartedAt } = await import("../src/liveness.js");
const { handleGetMessages } = await import("../src/tools/messaging.js");
const { GetMessagesSchema } = await import("../src/types.js");

const RS = "1".repeat(64);
let n = 0;
const intent = (ids: string[], agent = "alice") => ({
  v: 1 as const,
  type: "intent" as const,
  at: "2026-10-02T05:00:00.000Z",
  mono_ms: 0,
  intent: { intent_id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, agent_name: agent, binding_id: "b", during_escalation: false },
  covers: { reading_session: RS, message_ids: ids, kinds: ids.map(() => "new" as const) },
});
const header = () => ({
  v: 1 as const,
  type: "header" as const,
  at: "2026-10-02T05:00:00.000Z",
  pid: 42,
  build: { build_id: "unbuilt", commit: null, dirty: null, built_at: null, deps_id: null, deps_state: "unknown" as const, node: "v22.0.0" },
  install_dir: "/opt/relay",
  resolution: { kind: "explicit-db", db_path: "/x/relay.db", exists: true, containment: "strict", basis: "RELAY_DB_PATH" },
});
const linesOf = (p: string) => fs.readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("compactLog: keep what still matters, crash-safe", () => {
  it("keeps the intents the rule keeps and the last 5 headers, rewritten UNCHANGED; drops the rest", () => {
    const dir = path.join(ROOT, "c1");
    let { handle } = L.openLog(dir);
    for (let i = 0; i < 7; i++) L.appendRecord(handle, header());
    const a = intent(["m1"]);
    const b = intent(["m2"]);
    L.appendRecord(handle, a);
    L.appendRecord(handle, b);
    const c = L.compactLog(handle, (r) => r.intent.intent_id === b.intent.intent_id);
    handle = c.handle;
    const recs = linesOf(handle.path);
    expect(recs.filter((r) => r.type === "header")).toHaveLength(L.COMPACT_KEEP_HEADERS);
    expect(recs.filter((r) => r.type === "intent")).toEqual([b]);
    expect(c.afterBytes).toBeLessThan(c.beforeBytes);
    expect([...c.state.rung]).toEqual([L.rungKey(RS, "m2")]);
    expect(fs.statSync(handle.path).mode & 0o777).toBe(0o600);
    L.closeLog(handle);
  });
  it("a compaction that CRASHED before its rename left a temp: the next open discards it and the log is intact", () => {
    const dir = path.join(ROOT, "crash");
    const o = L.openLog(dir);
    L.appendRecord(o.handle, intent(["m1"]));
    L.closeLog(o.handle);
    fs.writeFileSync(path.join(dir, ".actuation.jsonl.compact-999"), "half a compaction", { mode: 0o600 });
    const again = L.openLog(dir);
    expect(fs.readdirSync(dir)).toEqual([L.LOG_FILENAME]);
    expect([...again.state.rung]).toEqual([L.rungKey(RS, "m1")]);
    L.closeLog(again.handle);
  });
  it("a planted temp SYMLINK is removed as a link: its target is untouched", () => {
    const dir = path.join(ROOT, "tmplink");
    L.closeLog(L.openLog(dir).handle);
    const target = path.join(ROOT, "tmplink-target");
    fs.writeFileSync(target, "precious");
    fs.symlinkSync(target, path.join(dir, ".actuation.jsonl.compact-1"));
    L.closeLog(L.openLog(dir).handle);
    expect(fs.readFileSync(target, "utf-8")).toBe("precious");
  });
});

describe("a TAILER following by path survives a compaction", () => {
  it("no lost and no duplicated intent across a compaction (including one it had not read yet)", () => {
    const dir = path.join(ROOT, "tail");
    let { handle } = L.openLog(dir);
    const i1 = intent(["m1"]);
    const i2 = intent(["m2"]);
    L.appendRecord(handle, i1);
    L.appendRecord(handle, i2);
    const t = new L.LogTailer(handle.path);
    expect(t.poll().map((r) => r.intent.intent_id)).toEqual([i1.intent.intent_id, i2.intent.intent_id]);
    const unread = intent(["m3"]); // appended to the OLD file, not yet polled, and DROPPED by the compaction
    L.appendRecord(handle, unread);
    const c = L.compactLog(handle, (r) => r.intent.intent_id === i1.intent.intent_id); // keeps i1 only
    handle = c.handle;
    const i4 = intent(["m4"]);
    L.appendRecord(handle, i4);
    expect(t.poll().map((r) => r.intent.intent_id)).toEqual([unread.intent.intent_id, i4.intent.intent_id]);
    expect(t.poll()).toEqual([]);
    t.close();
    L.closeLog(handle);
  });
});

// --- the job: compaction on start, and the cap ---------------------------------
const HOST = getOwnHostId();
async function job(argv: string[], opts: import("../src/doorbell-run.js").DoorbellOptions = {}): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => ((stderr += String(c)), true));
  try {
    return { code: await runDoorbell(argv, { watchFit: false, actuator: { fits: () => true }, ...opts }), stderr };
  } finally {
    spy.mockRestore();
  }
}
const intentsInLog = () => linesOf(LOGP).filter((r) => r.type === "intent");
/** Time passing: every intent moved `ms` into the past (still valid). PR 2 keeps the last hour's. */
const ageLog = (ms: number) =>
  fs.writeFileSync(LOGP, linesOf(LOGP).map((r) => JSON.stringify(r.type === "intent" ? { ...r, at: new Date(Date.parse(r.at) - ms).toISOString() } : r)).join("\n") + "\n");
const TWO_HOURS = 7_200_000;
const send = () => db.sendMessage("d2-sender", "d2-alice", "x", "normal").id;
const drain = () => {
  const input = GetMessagesSchema.parse({ agent_name: "d2-alice", status: "pending", peek: false, limit: 100, since: "all" });
  handleGetMessages(input as never);
};

beforeEach(() => {
  db.closeDb();
  fs.rmSync(path.join(ROOT, "inst"), { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, "inst"), { recursive: true });
  process.env.RELAY_DB_PATH = DB;
  db.getDb();
  db.registerAgent("d2-sender", "s", []);
  db.registerAgent("d2-alice", "r", []);
  db.upsertAgentBinding(db.getDb(), {
    hostId: HOST as string,
    windowPid: process.pid,
    windowPidStart: processStartedAt(process.pid) as string,
    agentName: "d2-alice",
    agentClass: null,
    conversationId: "conv-d2",
    conversationTitle: null,
    cwd: ROOT,
    boundVia: "launch-intent",
  });
});

describe.skipIf(!HOST)("the job: compaction at the first DB open, and the size cap", () => {
  it("an intent whose ids all LEFT pending is dropped at the next start; a still-pending one is KEPT (so no re-ring)", async () => {
    // Budget 1 = only each agent's LAST intent is kept as evidence regardless of age (ruling
    // 622689ba (3)), so the pending rule decides for every older one.
    const B = ["--once", "--budget-per-hour", "1"];
    const m1 = send();
    expect((await job(B)).code).toBe(0);
    drain(); // m1 leaves the reading session's pending set
    ageLog(TWO_HOURS);
    const m2 = send();
    expect((await job(B)).code).toBe(0); // rings m2; m1 survives this compaction only as the LAST intent
    ageLog(TWO_HOURS);
    const m3 = send();
    expect((await job(B)).code).toBe(0); // compacts: m1 is neither the last nor pending → DROPPED; then rings m3
    // Each id's kinds across the log. PR 3: m2, still pending 2 h (> H) after its ring, is
    // RE-RUNG as still_pending; it is never rung as "new" again (its intent was KEPT).
    const kindsOf = (id: string) => intentsInLog().flatMap((r) => r.covers.message_ids.flatMap((x: string, i: number) => (x === id ? [r.covers.kinds[i]] : [])));
    expect([kindsOf(m1), kindsOf(m2), kindsOf(m3)]).toEqual([[], ["new", "still_pending"], ["new"]]);
    const ids = intentsInLog().map((r) => r.intent.intent_id);
    ageLog(TWO_HOURS);
    expect((await job(B)).code).toBe(0); // m2 is not the last, but still PENDING → KEPT, so never "new" again
    // The SAME intents (by id) are still there: a dropped-then-re-rung one would carry a new id.
    expect(intentsInLog().map((r) => r.intent.intent_id).slice(0, ids.length)).toEqual(ids);
    expect([kindsOf(m2).filter((k) => k === "new"), kindsOf(m3).filter((k) => k === "new")]).toEqual([["new"], ["new"]]);
    expect(m1).not.toBe(m2);
  });
  it("#300 R2 #1 (MEASURED): the start's compaction failing after its rename STOPS the job (exit 1); no cycle runs on the old fd", async () => {
    send();
    const io = { ...L.realLogIo, fsyncSync: (fd: number) => { if (fs.fstatSync(fd).isDirectory()) throw new Error("EIO (injected, dir)"); fs.fsyncSync(fd); } };
    const r = await job(["--interval-ms", "1000"], { logIo: io }); // a LOOP: it must not continue
    expect([r.code, r.stderr]).toEqual([1, expect.stringMatching(/DOORBELL_FAILED: the compaction did not complete .*stopping/)]);
    expect(intentsInLog()).toEqual([]);
  });

  it("over the cap: no ring, LOG-FULL said ONCE across cycles, never a silent drop", async () => {
    send();
    const p = job(["--interval-ms", "1000"], { logCapBytes: 1 });
    await new Promise((r) => setTimeout(r, 2600)); // three cycles
    process.emit("SIGTERM");
    const r = await p;
    expect(r.code).toBe(0);
    expect(r.stderr.match(/LOG-FULL/g)).toHaveLength(1);
    expect(intentsInLog()).toEqual([]);
  });
  it("twin: under the cap, it rings", async () => {
    send();
    const r = await job(["--once"], { logCapBytes: 1 << 20 });
    expect([r.code, intentsInLog().length]).toEqual([0, 1]);
  });
});
