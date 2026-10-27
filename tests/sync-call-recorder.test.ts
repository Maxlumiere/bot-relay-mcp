// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * tests/_helpers/sync-call-recorder.ts, the timing bars' RELAY_TIMING_DIAG instrument: it must SEE the kinds of
 * synchronous call it claims to see (a slow SQLite statement, a slow transaction COMMIT path, a slow fs *Sync, a slow
 * sync child process, an ESM named import of fs), must NOT record a fast call, must place each on the caller's clock
 * so a breach interval finds it, and must pass every call through unchanged and restore everything on uninstall.
 * A diagnostic that cannot see what it is pointed at would report "no recorded call overlaps" for the wrong reason.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import childProcess from "child_process";
import { readFileSync as namedReadFileSync } from "fs";
import Database from "better-sqlite3";
import { installSyncRecorder, type SyncRecorder } from "./_helpers/sync-call-recorder.js";

const now = () => performance.timeOrigin + performance.now();
const THRESHOLD = 40;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sync-rec-"));
let rec: SyncRecorder | null = null;
afterEach(() => {
  rec?.uninstall();
  rec = null;
});

/** A query that burns ~ms of CPU inside SQLite (a recursive CTE), so a Statement call really is slow. */
const SLOW_SQL = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c";
function slowCount(handle: Database.Database, minMs: number): number {
  for (let n = 200_000; ; n *= 2) {
    const t = now();
    handle.prepare(SLOW_SQL).get(n);
    if (now() - t >= minMs) return n;
  }
}

describe("sync-call-recorder (the RELAY_TIMING_DIAG instrument)", () => {
  it("records a SLOW SQLite statement and a slow TRANSACTION, on the caller's clock; a fast statement is not recorded", () => {
    const handle = new Database(path.join(TMP, "a.db"));
    const n = slowCount(handle, THRESHOLD * 2); // measured BEFORE the recorder: this size takes >= 2x the threshold here
    rec = installSyncRecorder({ now, thresholdMs: THRESHOLD, databaseProto: Object.getPrototypeOf(handle), statementProto: Object.getPrototypeOf(handle.prepare("SELECT 1")) });
    handle.prepare("SELECT 1").get(); // fast: never recorded
    const from = now();
    const row = handle.prepare(SLOW_SQL).get(n) as { n: number };
    const tx = handle.transaction(() => handle.prepare(SLOW_SQL).get(n));
    tx();
    const to = now();
    expect(row.n, "the call's result is passed through unchanged").toBe(n);
    const seen = rec.overlapping(from, to);
    expect(seen.map((c) => c.what)).toEqual(expect.arrayContaining(["sqlite Statement#get", "sqlite transaction (body + COMMIT)"]));
    expect(seen.find((c) => c.what === "sqlite Statement#get")!.detail).toMatch(/^WITH RECURSIVE c\(x\)/);
    for (const c of seen) {
      expect(c.to - c.from).toBeGreaterThanOrEqual(THRESHOLD);
      expect(c.from).toBeGreaterThanOrEqual(from);
      expect(c.to).toBeLessThanOrEqual(to);
      expect(c.stack, "the caller's stack, without the recorder's frames").toMatch(/sync-call-recorder\.test/);
    }
    expect(seen.some((c) => c.detail === "SELECT 1"), "the fast `SELECT 1` was not recorded").toBe(false);
    handle.close();
  });

  it.skipIf(process.platform === "win32")("records a slow SYNC child process and a slow fs *Sync (via fs.* AND an ESM named import); a window that misses them finds nothing", () => {
    // A slow fs call, deterministically: reading a FIFO blocks until a SEPARATE writer process writes it ~100 ms later.
    const fifoRead = (file: string, read: (p: string) => unknown) => {
      childProcess.execFileSync("mkfifo", [file]);
      childProcess.spawn("sh", ["-c", `sleep 0.1; printf x > '${file}'`], { stdio: "ignore" });
      return read(file);
    };
    rec = installSyncRecorder({ now, thresholdMs: THRESHOLD });
    const before = now();
    childProcess.spawnSync("sleep", ["0.1"]);
    expect(String(fifoRead(path.join(TMP, "f1"), (p) => fs.readFileSync(p))), "passed through unchanged").toBe("x");
    expect(String(fifoRead(path.join(TMP, "f2"), (p) => namedReadFileSync(p)))).toBe("x");
    const to = now();
    const seen = rec.overlapping(before, to);
    expect(seen.map((c) => c.what)).toEqual(expect.arrayContaining(["child_process.spawnSync", "fs.readFileSync"]));
    expect(seen.filter((c) => c.what === "fs.readFileSync").length, "BOTH the fs.* call and the ESM named import were seen").toBe(2);
    expect(seen.find((c) => c.what === "fs.readFileSync")!.detail).toMatch(/f1$/);
    expect(rec.overlapping(before - 10_000, before - 5_000), "a window before every call finds nothing").toEqual([]);
  });

  it("uninstall restores every wrapped function (fs, child_process, the SQLite prototypes)", () => {
    const handle = new Database(path.join(TMP, "b.db"));
    const dbProto = Object.getPrototypeOf(handle);
    const stProto = Object.getPrototypeOf(handle.prepare("SELECT 1"));
    const originals = { w: fs.writeFileSync, s: childProcess.spawnSync, get: stProto.get, tx: dbProto.transaction };
    const r = installSyncRecorder({ now, thresholdMs: THRESHOLD, databaseProto: dbProto, statementProto: stProto });
    expect(fs.writeFileSync).not.toBe(originals.w);
    expect(stProto.get).not.toBe(originals.get);
    r.uninstall();
    expect(fs.writeFileSync).toBe(originals.w);
    expect(childProcess.spawnSync).toBe(originals.s);
    expect(stProto.get).toBe(originals.get);
    expect(dbProto.transaction).toBe(originals.tx);
    handle.close();
  });
});
