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
 * - an ErrnoError from the FINAL export propagates (close reports the loss); one from an earlier export is a warning
 *   that never claims the data is safe.
 * Each row reads the FILE before closing where it matters: a close writes back too, and would hide a dropped one.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import * as db from "../src/db.js";
import * as compat from "../src/sqlite-compat.js";
import { log } from "../src/logger.js";

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
  compat._setWasmExportHookForTests(null);
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
const errnoOnExport = () =>
  compat._setWasmExportHookForTests(() => {
    throw Object.assign(new Error("FS error (injected)"), { name: "ErrnoError" });
  });
function rowsOnDisk(): string[] {
  const ro = new Database(dbPath, { readonly: true });
  try {
    return (ro.prepare("SELECT v FROM probe ORDER BY rowid").all() as Array<{ v: string }>).map((r) => r.v);
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

  it("an ErrnoError from the FINAL export propagates: close reports the loss", async () => {
    const { ins } = await openWithTable();
    ins.run("kept");
    refuseWrite();
    expect(() => ins.run("lost")).toThrow();
    compat._setWasmPersistWriteForTests(null);
    errnoOnExport();
    expect(() => db.closeDb(), "an export ErrnoError at close is a reported loss, not a silent return").toThrow(
      /final write-back was refused, so 1 row change\(s\) since the last successful write-back were LOST/
    );
    compat._setWasmExportHookForTests(null);
    expect(rowsOnDisk()).toEqual(["kept"]);
  });

  it("an ErrnoError from an EARLIER export is a warning that never claims the data is safe; the next write-back writes it", async () => {
    const { ins } = await openWithTable();
    ins.run("kept");
    const warn = vi.spyOn(log, "warn");
    errnoOnExport();
    ins.run("pending"); // the warning path: no throw
    compat._setWasmExportHookForTests(null);
    const said = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(said, "the warning was emitted").toMatch(/export\(\)/);
    expect(said, "it never claims the data is safe").not.toMatch(/safe in memory/);
    expect(said, "it says what is at stake").toMatch(/lost if the process exits first/);
    ins.run("after");
    expect(rowsOnDisk()).toEqual(["kept", "pending", "after"]);
  });
});
