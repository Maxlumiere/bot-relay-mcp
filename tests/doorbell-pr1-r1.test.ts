// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #300 Codex round 1 (doorbell PR 1), the log's DETAIL fixes:
 *   #2  the log is never written THROUGH a symlink (O_NOFOLLOW on every open, lstat, an
 *       identity check), and recovery validates before it truncates anything;
 *   #3  a short write is completed (or fails loudly); only a provably complete line counts;
 *   #7  the header is a CLOSED schema too: nested build and resolution, typed and bounded;
 *   #8  message_ids is a canonical SET (unique, sorted) at the writer and on replay.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const L = await import("../src/doorbell-log.js");
const C = await import("../src/doorbell-core.js");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-r1-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const RS = "1".repeat(64);
const intent = (ids: string[]) => ({
  v: 1 as const,
  type: "intent" as const,
  at: "2026-10-02T05:00:00.000Z",
  mono_ms: 0,
  intent: { intent_id: "00000000-0000-4000-8000-000000000001", agent_name: "alice", binding_id: "b", during_escalation: false },
  covers: { reading_session: RS, message_ids: ids, kinds: ids.map(() => "new" as const) },
});
const BUILD = { build_id: "c".repeat(64), commit: "abcdef1", dirty: false, built_at: "2026-10-01T10:00:00.000Z", deps_id: "d".repeat(64), deps_state: "known", node: "v22.0.0" };
const RES = { kind: "explicit-db", db_path: "/x/relay.db", exists: true, containment: "strict", basis: "RELAY_DB_PATH" };
const header = (over: Record<string, unknown> = {}) => ({ v: 1, type: "header", at: "2026-10-02T05:00:00.000Z", pid: 42, build: BUILD, install_dir: "/opt/relay", resolution: RES, ...over });

describe("#2: never through a symlink; validate before truncating", () => {
  it("HARM: actuation.jsonl as a SYMLINK to a decoy relay.db is refused, and the decoy is byte-identical (never truncated)", () => {
    const dir = path.join(ROOT, "sym", "doorbell");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const decoy = path.join(ROOT, "sym", "relay.db");
    fs.writeFileSync(decoy, "SQLite format 3\u0000 not newline terminated", { mode: 0o600 });
    const before = fs.readFileSync(decoy);
    fs.symlinkSync(decoy, path.join(dir, L.LOG_FILENAME));
    expect(() => L.openLog(dir)).toThrow(/not a regular file|ELOOP/);
    expect(fs.readFileSync(decoy).equals(before)).toBe(true);
  });
  it("HARM: a symlinked STATE DIR is refused", () => {
    const real = path.join(ROOT, "realdir");
    fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(ROOT, "linkdir");
    fs.symlinkSync(real, link);
    expect(() => L.openLog(link)).toThrow(/not a real directory/);
  });
  it("HARM: a non-regular file (a directory) at the log path is refused", () => {
    const dir = path.join(ROOT, "nonreg");
    fs.mkdirSync(path.join(dir, L.LOG_FILENAME), { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    expect(() => L.openLog(dir)).toThrow(/not a regular file/);
  });
  it("HARM: an invalid COMPLETE line with a torn tail is refused WITHOUT truncating anything", () => {
    const dir = path.join(ROOT, "validate-first");
    const o = L.openLog(dir);
    L.closeLog(o.handle);
    fs.appendFileSync(o.handle.path, '{"v":1,"type":"intent"}\n{"torn');
    const before = fs.readFileSync(o.handle.path);
    expect(() => L.openLog(dir)).toThrow(/line 1 is not a valid doorbell record/);
    expect(fs.readFileSync(o.handle.path).equals(before)).toBe(true);
  });
  it("readers open the log no-follow too", () => {
    const dir = path.join(ROOT, "reader");
    fs.mkdirSync(dir, { mode: 0o700 });
    const target = path.join(ROOT, "reader-target");
    fs.writeFileSync(target, "");
    fs.symlinkSync(target, path.join(dir, L.LOG_FILENAME));
    expect(() => L.readLogState(path.join(dir, L.LOG_FILENAME))).toThrow();
  });
});

describe("#3: only a provably complete line counts", () => {
  const ioWith = (writeSync: import("../src/doorbell-log.js").LogIo["writeSync"], fstatLies = false): import("../src/doorbell-log.js").LogIo => ({
    ...L.realLogIo,
    writeSync,
    fstatSync: (fd) => {
      const st = fs.fstatSync(fd);
      return fstatLies ? ({ ...st, size: 0, isFile: () => true } as unknown as fs.Stats) : st;
    },
  });
  it("a SHORT write is continued until the whole line is on disk", () => {
    const dir = path.join(ROOT, "short");
    const o = L.openLog(dir, ioWith((fd, buf, off, len) => fs.writeSync(fd, buf, off, Math.min(len, 7))));
    L.appendRecord(o.handle, intent(["m1"]));
    L.closeLog(o.handle);
    expect([...L.readLogState(o.handle.path).rung]).toEqual([L.rungKey(RS, "m1")]);
  });
  it("HARM: a write that makes NO progress is a LogWriteError (never a silent success)", () => {
    const o = L.openLog(path.join(ROOT, "noprogress"), ioWith(() => 0));
    expect(() => L.appendRecord(o.handle, intent(["m1"]))).toThrow(L.LogWriteError);
    L.closeLog(o.handle);
    expect(L.readLogState(o.handle.path).rung.size).toBe(0);
  });
  it("HARM: a file that did not grow by exactly the line is a LogWriteError", () => {
    const o = L.openLog(path.join(ROOT, "nogrow"), ioWith((fd, buf, off, len) => fs.writeSync(fd, buf, off, len), true));
    expect(() => L.appendRecord(o.handle, intent(["m1"]))).toThrow(/grew by/);
    L.closeLog(o.handle);
  });
  it("HARM: a failed fsync is a LogWriteError", () => {
    const io = { ...L.realLogIo, fsyncSync: () => { throw new Error("EIO"); } };
    const o = L.openLog(path.join(ROOT, "fsync"), io);
    expect(() => L.appendRecord(o.handle, intent(["m1"]))).toThrow(L.LogWriteError);
    L.closeLog(o.handle);
  });
});

describe("#7: the header is a closed schema too", () => {
  it("twin: a header shaped like LOADED_BUILD + serializeResolution is valid", () => {
    expect(L.recordFault(header())).toBeNull();
    expect(L.recordFault(header({ resolution: { kind: "instance", id: "abc", db_path: "/x/relay.db", exists: true, containment: "roots-only", basis: "active-instance" } }))).toBeNull();
    expect(L.recordFault(header({ resolution: { kind: "flat", db_path: "/x/relay.db", exists: true, containment: "strict", warning: "a flat DB" } }))).toBeNull();
  });
  it("HARM (MEASURED): arbitrary text smuggled through build or resolution is refused", () => {
    expect(L.recordFault(header({ build: { ...BUILD, token: "SECRET" } }))).toMatch(/build has exactly/);
    expect(L.recordFault(header({ resolution: { ...RES, content: "MESSAGE BODY" } }))).toMatch(/resolution .* has exactly/);
  });
  it("HARM: wrong types and unbounded or multi-line values are refused", () => {
    expect(L.recordFault(header({ build: { ...BUILD, commit: "hello world" } }))).toMatch(/commit/);
    expect(L.recordFault(header({ build: { ...BUILD, node: "v22.0.0 and a long story about it" } }))).toMatch(/node/);
    expect(L.recordFault(header({ install_dir: "/opt/relay\nINJECTED" }))).toMatch(/install_dir/);
    expect(L.recordFault(header({ resolution: { ...RES, db_path: "x".repeat(5000) } }))).toMatch(/db_path/);
    expect(L.recordFault(header({ resolution: { kind: "error", reason: "x" } }))).toMatch(/kind/);
  });
});

describe("#8: message_ids is a canonical set", () => {
  it("HARM: the validator refuses duplicates and non-sorted ids (writer AND replay)", () => {
    expect(L.recordFault(intent(["m2", "m1"]))).toMatch(/unique and sorted/);
    expect(L.recordFault(intent(["m1", "m1"]))).toMatch(/unique and sorted/);
    expect(L.recordFault(intent(["m1", "m2"]))).toBeNull();
    const dir = path.join(ROOT, "replay");
    const o = L.openLog(dir);
    L.closeLog(o.handle);
    fs.appendFileSync(o.handle.path, JSON.stringify(intent(["m2", "m1"])) + "\n");
    expect(() => L.openLog(dir)).toThrow(/unique and sorted/);
  });
  it("the planner emits a canonical set from duplicated input", () => {
    const p = C.planCycle({
      bindings: [{ binding_id: "b", agent_name: "alice", host_id: "H" }],
      ownHostId: "H",
      pending: () => ({ registered: true, reading_session: RS, ids: ["m2", "m1", "m1"] }),
      rung: new Set(),
      ringMono: new Map(),
      nowMono: 0,
      budgetExhausted: new Set(),
      windowMs: C.DEFAULT_WINDOW_MS,
      budgetPerHour: C.DEFAULT_BUDGET_PER_HOUR,
      horizonMs: C.DEFAULT_HORIZON_MS,
      newIntentId: () => "00000000-0000-4000-8000-000000000009",
      now: () => "2026-10-02T05:00:00.000Z",
    });
    expect(p.intents[0].covers.message_ids).toEqual(["m1", "m2"]);
    expect(L.recordFault(p.intents[0])).toBeNull();
  });
});
