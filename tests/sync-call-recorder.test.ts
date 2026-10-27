// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * tests/_helpers/sync-call-recorder.ts, the timing bars' RELAY_TIMING_DIAG instrument: it must SEE the kinds of
 * synchronous call it claims to see (a slow SQLite statement, the rows of an iterate(), a transaction with its
 * variants, a slow fs *Sync via fs.* and an ESM named import, a slow sync child process), must NOT record a fast call,
 * must place each on the caller's clock, and must leave nothing behind: an all-or-nothing install, an idempotent
 * uninstall that restores every function and ESM binding, and retained wrappers that stop recording.
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
const protosOf = (handle: Database.Database) => ({ databaseProto: Object.getPrototypeOf(handle), statementProto: Object.getPrototypeOf(handle.prepare("SELECT 1")) });

/** A query that burns CPU inside SQLite (a recursive CTE), so a call really is slow. */
const SLOW_SQL = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c";
function slowCount(handle: Database.Database, minMs: number): number {
  for (let n = 200_000; ; n *= 2) {
    const t = now();
    handle.prepare(SLOW_SQL).get(n);
    if (now() - t >= minMs) return n;
  }
}

describe("sync-call-recorder (the RELAY_TIMING_DIAG instrument)", () => {
  it("records a SLOW statement and a slow TRANSACTION on the caller's clock; a FAST statement INSIDE the same window is not recorded", () => {
    const handle = new Database(path.join(TMP, "a.db"));
    const n = slowCount(handle, THRESHOLD * 2); // measured BEFORE the recorder: this size takes >= 2x the threshold here
    rec = installSyncRecorder({ now, thresholdMs: THRESHOLD, ...protosOf(handle) });
    const from = now(); // the window opens BEFORE the fast call, so its absence below is a real check
    handle.prepare("SELECT 1").get();
    const row = handle.prepare(SLOW_SQL).get(n) as { n: number };
    handle.transaction(() => handle.prepare(SLOW_SQL).get(n))();
    const to = now();
    expect(row.n, "the call's result is passed through unchanged").toBe(n);
    const seen = rec.overlapping(from, to);
    expect(seen.map((c) => c.what)).toEqual(expect.arrayContaining(["sqlite Statement#get", "sqlite transaction (body + COMMIT)"]));
    expect(seen.find((c) => c.what === "sqlite Statement#get")!.detail).toMatch(/^WITH RECURSIVE c\(x\)/);
    expect(seen.some((c) => c.detail === "SELECT 1"), "the fast `SELECT 1`, inside the window, was not recorded").toBe(false);
    for (const c of seen) {
      expect(c.to - c.from).toBeGreaterThanOrEqual(THRESHOLD);
      expect(c.from).toBeGreaterThanOrEqual(from);
      expect(c.to).toBeLessThanOrEqual(to);
      expect(c.stack, "the caller's stack, without the recorder's frames").toMatch(/sync-call-recorder\.test/);
    }
    handle.close();
  });

  it("iterate(): the ROWS are timed (each next()), where a slow query consumed by iteration spends its time", () => {
    const handle = new Database(path.join(TMP, "it.db"));
    const n = slowCount(handle, THRESHOLD * 2);
    rec = installSyncRecorder({ now, thresholdMs: THRESHOLD, ...protosOf(handle) });
    const from = now();
    const rows = [...(handle.prepare(SLOW_SQL).iterate(n) as Iterable<{ n: number }>)];
    const to = now();
    expect(rows.map((r) => r.n), "rows passed through").toEqual([n]);
    expect(rec.overlapping(from, to).map((c) => c.what)).toContain("sqlite Statement#iterate next()");
    handle.close();
  });

  it("a transaction keeps its WHOLE property graph (.database, .default/.deferred/.immediate/.exclusive), each variant is timed, and one RETAINED after uninstall stops recording but still works", () => {
    const handle = new Database(path.join(TMP, "tx.db"));
    const n = slowCount(handle, THRESHOLD * 2);
    const plain = handle.transaction(() => 1) as unknown as Record<string, unknown>;
    rec = installSyncRecorder({ now, thresholdMs: THRESHOLD, ...protosOf(handle) });
    const tx = handle.transaction(() => (handle.prepare(SLOW_SQL).get(n) as { n: number }).n) as unknown as ((...a: unknown[]) => number) & Record<string, unknown>;
    // better-sqlite3 (lib/methods/transaction.js) RETURNS the `default` variant itself (tx.default === tx), and gives all
    // four variants the same non-configurable links plus `.database`. The wrapped graph must have the SAME shape.
    const VARIANTS = ["default", "deferred", "immediate", "exclusive"] as const;
    const keysOf = (o: object) => Reflect.ownKeys(o).map(String).filter((k) => k !== "length" && k !== "name" && k !== "prototype").sort();
    const attrs = (o: object, k: string) => { const d = Object.getOwnPropertyDescriptor(o, k)!; return { enumerable: d.enumerable, configurable: d.configurable, writable: d.writable }; };
    for (const v of VARIANTS) {
      const w = tx[v] as Record<string, unknown>;
      const p = plain[v] as Record<string, unknown>;
      expect(keysOf(w), `${v}: the same own keys (Reflect.ownKeys)`).toEqual(keysOf(p));
      for (const k of keysOf(p)) expect(attrs(w, k), `${v}.${k}: the same descriptor attributes`).toEqual(attrs(p, k));
      for (const link of VARIANTS) expect(w[link], `${v}.${link} links to the wrapped ${link}`).toBe(tx[link]);
      expect(w.database, `${v}.database is the handle`).toBe(handle);
    }
    expect(tx.default, "the self-link kept: tx.default is the (timed) transaction itself").toBe(tx);
    expect(plain.default, "as in the library").toBe(plain);
    for (const v of ["default", "deferred", "immediate", "exclusive"]) {
      const from = now();
      expect((tx[v] as () => number)(), `${v} runs the body`).toBe(n);
      const label = v === "default" ? "sqlite transaction (body + COMMIT)" : `sqlite transaction.${v} (body + COMMIT)`;
      expect(rec.overlapping(from, now()).map((c) => c.what), `${v} is timed`).toContain(label);
    }
    // Retained wrappers of every kind (a transaction, a statement method, an iterator) work and stay SILENT after uninstall.
    const st = handle.prepare(SLOW_SQL);
    const retainedGet = st.get; // the wrapped prototype method, captured while installed
    const iter = handle.prepare(SLOW_SQL).iterate(n) as Iterator<{ n: number }>; // next() wrapped while installed
    const counted = rec.count();
    rec.uninstall();
    // An open iterator makes the whole CONNECTION busy (better-sqlite3), so it is stepped and closed first.
    expect(iter.next().value?.n, "a retained iterator's next() still works").toBe(n);
    iter.return?.();
    expect(tx(), "the retained transaction still works after uninstall").toBe(n);
    expect((retainedGet.call(st, n) as { n: number }).n, "a retained statement method still works").toBe(n);
    expect(rec.count(), "and none of them records anything any more").toBe(counted);
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

  it("uninstall restores every function AND the ESM named binding, idempotently", () => {
    const handle = new Database(path.join(TMP, "b.db"));
    const { databaseProto: dbProto, statementProto: stProto } = protosOf(handle);
    const originals = { w: fs.writeFileSync, r: fs.readFileSync, named: namedReadFileSync, s: childProcess.spawnSync, get: stProto.get, it: stProto.iterate, tx: dbProto.transaction };
    const r = installSyncRecorder({ now, thresholdMs: THRESHOLD, databaseProto: dbProto, statementProto: stProto });
    expect(fs.writeFileSync).not.toBe(originals.w);
    expect(namedReadFileSync, "the ESM named binding follows while installed").not.toBe(originals.named);
    r.uninstall();
    r.uninstall();
    expect(fs.writeFileSync).toBe(originals.w);
    expect(fs.readFileSync).toBe(originals.r);
    expect(namedReadFileSync, "the ESM named binding is the original again").toBe(originals.named);
    expect(childProcess.spawnSync).toBe(originals.s);
    expect(stProto.get).toBe(originals.get);
    expect(stProto.iterate).toBe(originals.it);
    expect(dbProto.transaction).toBe(originals.tx);
    handle.close();
  });

  it("ONE recorder per process: a second install while one is active THROWS (overlapping installs can never restore out of order); after uninstall, install works again", () => {
    rec = installSyncRecorder({ now, thresholdMs: THRESHOLD });
    const wrapped = fs.readFileSync;
    expect(() => installSyncRecorder({ now, thresholdMs: THRESHOLD })).toThrow(/a recorder is already active in this process/);
    expect(fs.readFileSync, "the refused install changed nothing").toBe(wrapped);
    rec.uninstall();
    rec = installSyncRecorder({ now, thresholdMs: THRESHOLD });
    expect(fs.readFileSync).not.toBe(wrapped);
  });

  it("install is ALL-OR-NOTHING: a failure part-way restores what was already patched and rethrows", () => {
    const f = () => 1;
    const fakeDb: Record<string, unknown> = { prepare: f, exec: f, pragma: f, transaction: f };
    const fakeSt: Record<string, unknown> = {};
    Object.defineProperty(fakeSt, "run", { get: () => { throw new Error("planted: run is unreadable"); }, enumerable: true });
    const before = { ...fakeDb, w: fs.writeFileSync, named: namedReadFileSync };
    expect(() => installSyncRecorder({ now, thresholdMs: THRESHOLD, databaseProto: fakeDb, statementProto: fakeSt })).toThrow("planted: run is unreadable");
    for (const k of ["prepare", "exec", "pragma", "transaction"]) expect(fakeDb[k], `${k} rolled back`).toBe(before[k as keyof typeof before]);
    expect(fs.writeFileSync, "fs never left patched").toBe(before.w);
    expect(namedReadFileSync, "nor the ESM binding").toBe(before.named);
  });
});
