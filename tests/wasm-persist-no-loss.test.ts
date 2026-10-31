// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The wasm driver's write-back loses no committed write silently.
 *
 * Through test seams in src/sqlite-compat.ts (a write-back write that fails, like a full disk; an Emscripten ErrnoError
 * from export()), on every OS:
 * - a refused write-back keeps the change in memory, and the NEXT write-back writes it (a single statement, and a
 *   transaction: a refused write-back inside a transaction used to leave every later write unwritten until close);
 * - a write-back refused at close() is reported by name with the number of ROW CHANGES lost (0 for a SELECT-only
 *   transaction), and the handle is cleared, so a fresh open works and holds only what was written;
 * - an export that fails after sql.js closed the database (its export() closes SQLite before reading the in-memory
 *   file) is never a success: a named error, every later use refused by name, and close reports the loss;
 * - serialize() keeps the loss count; a ROLLBACK that failed subtracts nothing; a nested SAVEPOINT that fails leaves the
 *   depth right; a script or statement that fails after committing rows still writes them back.
 * Each row reads the FILE before closing where it matters: a close writes back too, and would hide a dropped one.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import * as db from "../src/db.js";
import * as compat from "../src/sqlite-compat.js";

const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wasm-persist-")));
const KEYS = ["RELAY_DB_PATH", "RELAY_SQLITE_DRIVER", "RELAY_CONFIG_PATH"] as const;
let saved: Record<string, string | undefined>;
let dbPath: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const dir = fs.mkdtempSync(path.join(ROOT, "case-"));
  dbPath = path.join(dir, "relay.db");
  process.env.RELAY_DB_PATH = dbPath;
  process.env.RELAY_SQLITE_DRIVER = "wasm";
  process.env.RELAY_CONFIG_PATH = path.join(dir, "config.json");
  db.closeDb();
});
afterEach(() => {
  compat._setWasmPersistWriteForTests(null);
  compat._setWasmExportForTests(null);
  try {
    db.closeDb();
  } catch {
    /* a row that leaves a refused close behind has already asserted it */
  }
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const refuseWrite = () =>
  compat._setWasmPersistWriteForTests(() => {
    throw Object.assign(new Error("ENOSPC: no space left on device, write (injected)"), { code: "ENOSPC" });
  });
// sql.js's export() closes SQLite BEFORE it reads the in-memory file, so a real export failure leaves the handle CLOSED.
// This emulates that state: the raw handle is closed, then the export throws an Emscripten ErrnoError.
const exportFailsAfterClose = () =>
  compat._setWasmExportForTests((raw) => {
    raw.close();
    throw Object.assign(new Error("FS error (injected after sql.js closed the database)"), { name: "ErrnoError" });
  });
function rowsOnDisk(table = "probe"): string[] {
  const ro = new Database(dbPath, { readonly: true });
  try {
    return (ro.prepare(`SELECT v FROM ${table} ORDER BY rowid`).all() as Array<{ v: string }>).map((r) => r.v);
  } finally {
    ro.close();
  }
}
async function openWithTable() {
  await db.initializeDb();
  const h = db.getDb();
  h.exec("CREATE TABLE IF NOT EXISTS probe (v TEXT)");
  const ins = h.prepare("INSERT INTO probe (v) VALUES (?)");
  return { h, ins };
}

describe("the wasm write-back loses no committed write silently", () => {
  it.each(["a single statement", "a transaction"])("a refused write-back (%s) keeps the change, and the NEXT write-back writes it", async (kind) => {
    const { h, ins } = await openWithTable();
    const write = (v: string) => (kind === "a transaction" ? h.transaction(() => ins.run(v))() : ins.run(v));
    write("before");
    refuseWrite();
    expect(() => write("during"), "the refused write-back is reported").toThrow();
    compat._setWasmPersistWriteForTests(null);
    write("after");
    expect(rowsOnDisk(), "the next write-back wrote the earlier change too (read before close)").toEqual(["before", "during", "after"]);
  });

  it("a write-back refused at CLOSE is reported by name with the row changes lost, and the handle is cleared", async () => {
    const { ins } = await openWithTable();
    ins.run("kept");
    refuseWrite();
    expect(() => ins.run("lost")).toThrow();
    expect(() => db.closeDb(), "a refused final write-back is reported, never silent").toThrow(
      /final write-back was refused, so 1 row change\(s\) since the last successful write-back were LOST/
    );
    compat._setWasmPersistWriteForTests(null);
    await db.initializeDb(); // the handle was cleared: a fresh open works
    expect((db.getDb().prepare("SELECT v FROM probe ORDER BY rowid").all() as Array<{ v: string }>).map((r) => r.v)).toEqual(["kept"]);
  });

  it("a SELECT-only transaction refused at close reports 0 row changes lost (the count is of committed changes, not of write-back attempts)", async () => {
    const { h, ins } = await openWithTable();
    ins.run("kept");
    refuseWrite();
    expect(() => h.transaction(() => h.prepare("SELECT v FROM probe").all())()).toThrow();
    expect(() => db.closeDb()).toThrow(/final write-back was refused, so 0 row change\(s\)/);
  });

  it("changes a transaction ROLLED BACK are not counted as lost; the committed one is", async () => {
    const { h, ins } = await openWithTable();
    ins.run("kept");
    refuseWrite();
    expect(() =>
      h.transaction(() => {
        ins.run("rolled-back-1");
        ins.run("rolled-back-2");
        throw new Error("abort the transaction");
      })()
    ).toThrow(/abort the transaction/);
    expect(() => ins.run("committed")).toThrow();
    expect(() => db.closeDb()).toThrow(/final write-back was refused, so 1 row change\(s\)/);
  });

  it("an export that fails AFTER sql.js closed the database is never a success: a named error, then every use refused by name (a SUSPENDED iterator too), and close reports the loss", async () => {
    const { h, ins } = await openWithTable();
    ins.run("kept");
    const suspended = h.prepare("SELECT v FROM probe").iterate();
    expect(suspended.next().value).toEqual({ v: "kept" }); // a read in progress when the handle dies
    exportFailsAfterClose();
    expect(() => ins.run("lost"), "the failed export is reported, never a silent return").toThrow(/export failed after sql\.js had closed the database/);
    compat._setWasmExportForTests(null);
    expect(() => ins.run("later"), "a dead handle refuses by name, not with a raw sqlite error").toThrow(/handle is unusable/);
    expect(() => suspended.next(), "a suspended iterator resuming on a dead handle refuses by name too").toThrow(/handle is unusable/);
    let closeErr: Error | null = null;
    try {
      db.closeDb();
    } catch (e) {
      closeErr = e as Error;
    }
    expect(closeErr?.message, "close reports the loss by name; a cleanup error never replaces it").toMatch(/1 row change\(s\) since the last successful write-back were LOST/);
    expect(rowsOnDisk()).toEqual(["kept"]);
    await db.initializeDb(); // the handle was cleared: a fresh open works, from the file
    expect((db.getDb().prepare("SELECT v FROM probe ORDER BY rowid").all() as Array<{ v: string }>).map((r) => r.v)).toEqual(["kept"]);
  });

  it("an export that fails after close AT CLOSE is reported by name with the count, never as a raw cleanup error", async () => {
    const { ins } = await openWithTable();
    ins.run("kept");
    refuseWrite();
    expect(() => ins.run("lost")).toThrow();
    compat._setWasmPersistWriteForTests(null);
    exportFailsAfterClose();
    expect(() => db.closeDb()).toThrow(/final write-back was refused, so 1 row change\(s\) since the last successful write-back were LOST/);
    compat._setWasmExportForTests(null);
    expect(rowsOnDisk()).toEqual(["kept"]);
  });

  it("serialize() (the snapshot path) keeps the loss count: a later refused close still counts the change", async () => {
    const { h, ins } = await openWithTable();
    ins.run("kept");
    // An export that fails BEFORE sql.js closes the handle (the handle stays open, the change stays in SQLite's counter),
    // then serialize()'s own export, which resets that counter.
    compat._setWasmExportForTests(() => {
      throw new Error("export refused (injected, before any close)");
    });
    expect(() => ins.run("pending")).toThrow();
    compat._setWasmExportForTests(null);
    compat.snapshotToFile(h, path.join(path.dirname(dbPath), "snap.db"));
    refuseWrite();
    expect(() => db.closeDb()).toThrow(/final write-back was refused, so 1 row change\(s\)/);
  });

  it("a ROLLBACK that FAILED subtracts nothing: a row committed inside it is still counted as lost", async () => {
    const { h, ins } = await openWithTable();
    ins.run("kept");
    refuseWrite();
    // pragma() writes back (an export closes and reopens sql.js's database, ending the transaction), so the insert after
    // it commits on its own and the ROLLBACK then fails.
    expect(() =>
      h.transaction(() => {
        h.pragma("user_version = 1");
        ins.run("committed-after-pragma");
        throw new Error("abort the transaction");
      })()
    ).toThrow(/abort the transaction/);
    expect(() => db.closeDb()).toThrow(/final write-back was refused, so [1-9]\d* row change\(s\)/);
  });

  it("a NESTED transaction whose SAVEPOINT fails leaves the depth right: the outer commit and a later write reach the file", async () => {
    const { h, ins } = await openWithTable();
    h.transaction(() => {
      const it = h.prepare("INSERT INTO probe (v) VALUES ('a'), ('b') RETURNING v").iterate();
      it.next(); // a statement is in progress: SQLite refuses a SAVEPOINT now
      expect(() => h.transaction(() => ins.run("inner"))()).toThrow();
      for (const _ of it) {
        /* finish the statement */
      }
    })();
    ins.run("after");
    expect(rowsOnDisk(), "the outer commit and the later write were written back (read before close)").toEqual(["a", "b", "after"]);
  });

  it("Codex R2: a suspended iterator survives a commit made through get(), and the close count never undercounts", async () => {
    const { h } = await openWithTable();
    const it = h.prepare("INSERT INTO probe (v) VALUES ('a'), ('b') RETURNING v").iterate();
    expect(it.next().value).toEqual({ v: "a" });
    refuseWrite();
    expect(h.prepare("INSERT INTO probe (v) VALUES ('c') RETURNING v").get()).toEqual({ v: "c" });
    expect([...it].map((row: { v: string }) => row.v), "the suspended iterator finishes (never a raw 'Statement closed')").toEqual(["b"]);
    expect(() => db.closeDb(), "all 3 committed rows are counted").toThrow(/final write-back was refused, so 3 row change\(s\)/);
  });

  it("a commit made through a read API (get on INSERT … RETURNING) is written back at the NEXT write (the stated residual)", async () => {
    const { h, ins } = await openWithTable();
    expect(h.prepare("INSERT INTO probe (v) VALUES ('returned') RETURNING v").get()).toEqual({ v: "returned" });
    ins.run("next-write");
    expect(rowsOnDisk(), "the next write wrote the read-API commit back too (read before close)").toEqual(["returned", "next-write"]);
  });

  it("a consumer exception inside an iterator of INSERT … RETURNING: the consumer's error escapes, and close counts the rows", async () => {
    const { h } = await openWithTable();
    refuseWrite();
    expect(() => {
      for (const _row of h.prepare("INSERT INTO probe (v) VALUES ('x'), ('y') RETURNING v").iterate()) {
        throw new Error("consumer error");
      }
    }).toThrow(/consumer error/);
    expect(() => db.closeDb(), "never silent: close reports both rows").toThrow(/final write-back was refused, so 2 row change\(s\)/);
  });

  it.each([
    ["exec(): a multi-statement script that fails after a committed INSERT", "probe", ["committed"]],
    ["run(): an INSERT OR FAIL that commits rows before failing", "uniq", ["committed", "also"]],
  ] as const)("%s: the SQL error is the one thrown, and the committed rows are written back", async (label, table, want) => {
    const { h } = await openWithTable();
    h.exec("CREATE TABLE IF NOT EXISTS uniq (v TEXT UNIQUE)");
    const act = label.startsWith("exec")
      ? () => h.exec("INSERT INTO probe (v) VALUES ('committed'); SELECT * FROM missing_table")
      : () => h.prepare("INSERT OR FAIL INTO uniq (v) VALUES ('committed'), ('also'), ('committed')").run();
    expect(act).toThrow(/missing_table|UNIQUE/);
    expect(rowsOnDisk(table), "the committed rows reached the file (read before close)").toEqual([...want]);
  });
});
