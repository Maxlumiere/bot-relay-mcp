// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #300 Codex round 2 (the last) and architect ruling 00e3f6dd:
 *   #1  a compaction that does not complete STOPS the job (never resumes on the old fd);
 *   #2  compaction is anchored to the VERIFIED state dir: a dir swapped for a symlink
 *       before the temp is created, or before the rename, is refused, and nothing lands
 *       in the other directory;
 *   #3  the tailer detects a replacement FIRST, then drains the old inode;
 *   #4  (00e3f6dd) THREE compactions between two polls: every still-pending intent is
 *       delivered, none twice, and every dropped one belongs to mail no longer pending;
 *   #5  every header and record field is bounded.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const L = await import("../src/doorbell-log.js");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-r2-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const RS = "1".repeat(64);
let n = 0;
const intent = (ids: string[]) => ({
  v: 1 as const,
  type: "intent" as const,
  at: "2026-10-02T05:00:00.000Z",
  mono_ms: 0,
  intent: { intent_id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, agent_name: "alice", binding_id: "b", reason: "new_mail" as const },
  covers: { reading_session: RS, message_ids: ids },
});
const BUILD = { build_id: "c".repeat(64), commit: "abcdef1", dirty: false, built_at: "2026-10-01T10:00:00.000Z", deps_id: "d".repeat(64), deps_state: "known", node: "v22.0.0" };
const header = (over: Record<string, unknown> = {}) => ({
  v: 1,
  type: "header",
  at: "2026-10-02T05:00:00.000Z",
  pid: 42,
  build: BUILD,
  install_dir: "/opt/relay",
  resolution: { kind: "explicit-db", db_path: "/x/relay.db", exists: true, containment: "strict", basis: "RELAY_DB_PATH" },
  ...over,
});
const isDirFd = (fd: number) => fs.fstatSync(fd).isDirectory();

describe("#1: an incomplete compaction is a LogWriteError (the job fail-stops on it)", () => {
  it("HARM (MEASURED): the dir fsync failing AFTER the rename → LogWriteError, never a silent continue", () => {
    const io = { ...L.realLogIo, fsyncSync: (fd: number) => { if (isDirFd(fd)) throw new Error("EIO (injected, dir)"); fs.fsyncSync(fd); } };
    const o = L.openLog(path.join(ROOT, "dirfsync"), io);
    L.appendRecord(o.handle, intent(["m1"]));
    expect(() => L.compactLog(o.handle, () => true)).toThrow(L.LogWriteError);
  });
});

describe("#2: compaction is anchored to the VERIFIED state dir", () => {
  const setup = (tag: string) => {
    const stateDir = path.join(ROOT, tag, "doorbell");
    const o = L.openLog(stateDir);
    L.appendRecord(o.handle, intent(["m1"]));
    const decoyDir = path.join(ROOT, tag, "decoy");
    fs.mkdirSync(decoyDir, { mode: 0o700 });
    const decoy = path.join(decoyDir, L.LOG_FILENAME);
    fs.writeFileSync(decoy, "ANOTHER DIRECTORY'S LOG\n", { mode: 0o600 });
    const swap = () => {
      fs.renameSync(stateDir, `${stateDir}.moved`);
      fs.symlinkSync(decoyDir, stateDir);
    };
    return { o, decoy, swap };
  };
  it("HARM (MEASURED): the dir swapped for a symlink BEFORE the compaction → refused; the other dir is untouched", () => {
    const { o, decoy, swap } = setup("swap-before");
    swap();
    expect(() => L.compactLog(o.handle, () => true)).toThrow(/was replaced before the compaction's temp file was created/);
    expect(fs.readFileSync(decoy, "utf-8")).toBe("ANOTHER DIRECTORY'S LOG\n");
    expect(fs.readdirSync(path.dirname(decoy))).toEqual([L.LOG_FILENAME]); // no temp landed there either
  });
  it("HARM: the dir swapped DURING the compaction (after the temp, before the rename) → refused; the other dir is untouched", () => {
    const { o, decoy, swap } = setup("swap-during");
    let swapped = false;
    o.handle.io = { ...L.realLogIo, writeSync: (fd, buf, off, len) => { const w = fs.writeSync(fd, buf, off, len); if (!swapped && !isDirFd(fd)) { swapped = true; swap(); } return w; } };
    expect(() => L.compactLog(o.handle, () => true)).toThrow(/was replaced before the compaction's rename/);
    expect(fs.readFileSync(decoy, "utf-8")).toBe("ANOTHER DIRECTORY'S LOG\n");
  });
});

describe("#3: the tailer detects a replacement BEFORE its last drain of the old inode", () => {
  it("HARM (MEASURED interleaving): an intent appended after detection, then compacted away, is still delivered", () => {
    const dir = path.join(ROOT, "tail-order");
    let { handle } = L.openLog(dir);
    const i1 = intent(["m1"]);
    L.appendRecord(handle, i1);
    const late = intent(["m2"]);
    let fired = false;
    const t = new L.LogTailer(handle.path, {
      afterDetect: () => {
        if (fired) return;
        fired = true;
        L.appendRecord(handle, late); // lands in the OLD inode...
        handle = L.compactLog(handle, (r) => r.intent.intent_id === i1.intent.intent_id).handle; // ...which a compaction then drops
      },
    });
    const got = [...t.poll(), ...t.poll()].map((r) => r.intent.intent_id);
    expect(got).toContain(late.intent.intent_id);
    expect(new Set(got).size).toBe(got.length);
    t.close();
    L.closeLog(handle);
  });
});

describe("#4 (ruling 00e3f6dd): retention semantics across several compactions", () => {
  it("THREE compactions between two polls: every still-pending intent delivered, none twice, every dropped one is no longer pending", () => {
    const dir = path.join(ROOT, "three");
    let { handle } = L.openLog(dir);
    const t = new L.LogTailer(handle.path);
    const pending = new Set<string>();
    const all: Array<ReturnType<typeof intent>> = [];
    const ring = (id: string) => {
      const r = intent([id]);
      all.push(r);
      pending.add(id);
      L.appendRecord(handle, r);
    };
    ring("m0");
    expect(t.poll()).toHaveLength(1);
    // Three "restarts" between the polls: each rings new mail, some mail is consumed, then a compaction.
    for (let gen = 1; gen <= 3; gen++) {
      ring(`m${gen}a`);
      ring(`m${gen}b`);
      pending.delete(`m${gen}a`); // consumed before the next compaction
      handle = L.compactLog(handle, (r) => r.covers.message_ids.some((id) => pending.has(id))).handle;
    }
    const delivered = [...t.poll(), ...t.poll()].map((r) => r.intent.intent_id);
    const stillPending = all.filter((r) => pending.has(r.covers.message_ids[0])).map((r) => r.intent.intent_id);
    expect(delivered.filter((id) => !stillPending.includes(id)).every((id) => all.some((r) => r.intent.intent_id === id))).toBe(true);
    for (const id of stillPending.filter((x) => x !== all[0].intent.intent_id)) expect(delivered).toContain(id); // every still-pending one (m0 was already delivered)
    expect(new Set(delivered).size).toBe(delivered.length); // none twice
    const dropped = all.filter((r) => !delivered.includes(r.intent.intent_id) && r !== all[0]);
    for (const r of dropped) expect(pending.has(r.covers.message_ids[0])).toBe(false); // only mail no longer pending
    t.close();
    L.closeLog(handle);
  });
});

describe("#5: every field is bounded", () => {
  it("HARM (MEASURED): a 1,000,021-character built_at, and 10+ fractional digits anywhere, are refused", () => {
    expect(L.recordFault(header({ build: { ...BUILD, built_at: `2026-10-01T10:00:00.${"1".repeat(1_000_000)}Z` } }))).toMatch(/built_at/);
    expect(L.recordFault(header({ at: "2026-10-02T05:00:00.1234567890Z" }))).toMatch(/at is not/);
    expect(L.recordFault({ ...intent(["m1"]), at: "2026-10-02T05:00:00.1234567890Z" })).toMatch(/at is not/);
  });
  it("HARM: unbounded node version components, an oversized pid, too many ids are refused; twins pass", () => {
    expect(L.recordFault(header({ build: { ...BUILD, node: "v123456789.0.0" } }))).toMatch(/node/);
    expect(L.recordFault(header({ build: { ...BUILD, node: "v22.11.0-nightly20260101" } }))).toBeNull();
    expect(L.recordFault(header({ pid: 2 ** 40 }))).toMatch(/pid/);
    const many = Array.from({ length: L.MAX_IDS_PER_INTENT + 1 }, (_, i) => `m${String(i).padStart(6, "0")}`);
    expect(L.recordFault(intent(many))).toMatch(/at most/);
    expect(L.recordFault(intent(many.slice(0, 10)))).toBeNull();
  });
});
