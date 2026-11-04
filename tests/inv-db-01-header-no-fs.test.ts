// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 slice 2b-i (rulings 7657ad36, e6e1b44e): a native process never fs-opens a DB-family file.
 * - The header comes, in order, from (1) PRAGMA application_id on a native handle this process holds, else (3) ONE
 *   synchronous fs read of the main file, only when this process holds no native handle on it. (2), a pre-open
 *   read-only SQLite open, was MEASURED out: it creates a -wal on every WAL file.
 * - The hold registry is retired; a minimal in-process native-handle COUNT stays, for the header source and restore.
 * - A native open of a file this process holds through a WRITABLE wasm connection is refused (the reverse in-process
 *   mix: the wasm write-back's close would drop the native handle's locks).
 * - The restore archive reader refuses a member of the live DB's family, by identity.
 * Lock assertions use another process (POSIX fcntl, or a SQLite BEGIN EXCLUSIVE); byte reads of a held DB likewise.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import * as compat from "../src/sqlite-compat.js";
import * as db from "../src/db.js";
import * as header from "../src/db-header.js";
import { openRawRelayDb } from "../src/cli/_instance-db.js";
import { exportRelayState, importRelayState } from "../src/backup.js";
import { _takeFsSpyViolations } from "./_setup/no-fs-on-held-db.js";

const NATIVE = 0x524c594e;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "s2bi-")));
const KEYS = ["HOME", "USERPROFILE", "RELAY_CONFIG_PATH", "RELAY_INSTANCE_ID", "RELAY_SQLITE_DRIVER", "RELAY_DB_PATH"] as const;
let saved: Record<string, string | undefined>;
let caseDir: string;
let dbPath: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  caseDir = fs.mkdtempSync(path.join(ROOT, "case-"));
  dbPath = path.join(caseDir, "relay.db");
  process.env.HOME = caseDir;
  process.env.USERPROFILE = caseDir;
  delete process.env.RELAY_INSTANCE_ID;
  delete process.env.RELAY_SQLITE_DRIVER;
  process.env.RELAY_DB_PATH = dbPath;
  process.env.RELAY_CONFIG_PATH = path.join(caseDir, "config.json");
  db.closeDb();
  compat.closeInitializedDb();
  compat._resetDriverWarningForTests();
});
afterEach(() => {
  db.closeDb();
  compat.closeInitializedDb();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function makeWalDb(file: string, appId: number): void {
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  if (appId !== 0) d.pragma(`application_id = ${appId}`);
  d.exec("CREATE TABLE kept (v TEXT); INSERT INTO kept VALUES ('row-1');");
  d.close();
}
const family = (p: string) => [p, `${p}-wal`, `${p}-shm`, `${p}-journal`];
/** Every fs open/read of a DB-family path made while `fn` runs (a spy on the descriptor-opening functions). */
async function familyOpensDuringAsync<T>(p: string, fn: () => Promise<T>): Promise<string[]> {
  const opens: string[] = [];
  const restore = spyFamily(p, opens);
  try {
    await fn();
  } finally {
    restore();
  }
  return opens;
}
function spyFamily(p: string, opens: string[]): () => void {
  const members = new Set(family(p));
  const spies = (["openSync", "readFileSync", "createReadStream"] as const).map((name) => {
    const orig = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!;
    return vi.spyOn(fs as unknown as Record<string, (...a: unknown[]) => unknown>, name).mockImplementation(function (this: unknown, ...a: unknown[]) {
      if (typeof a[0] === "string" && members.has(a[0])) opens.push(`${name}(${a[0]})`);
      return orig.apply(this, a);
    });
  });
  return () => {
    for (const s of spies) s.mockRestore();
  };
}
function familyOpensDuring<T>(p: string, fn: () => T): { result: T; opens: string[] } {
  const members = new Set(family(p));
  const opens: string[] = [];
  const spies = (["openSync", "readFileSync", "createReadStream"] as const).map((name) => {
    const orig = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!;
    return vi.spyOn(fs as unknown as Record<string, (...a: unknown[]) => unknown>, name).mockImplementation(function (this: unknown, ...a: unknown[]) {
      if (typeof a[0] === "string" && members.has(a[0])) opens.push(`${name}(${a[0]})`);
      return orig.apply(this, a);
    });
  });
  try {
    return { result: fn(), opens };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}
/** In ANOTHER process: can a SQLite connection take the DB exclusively? (BUSY while this process holds a lock.) */
function otherProcessBeginExclusive(file: string): string {
  const script = path.join(ROOT, "begin-exclusive.cjs");
  if (!fs.existsSync(script)) {
    fs.writeFileSync(
      script,
      `const D = require(require("module").createRequire(${JSON.stringify(path.join(REPO, "package.json"))}).resolve("better-sqlite3"));\n` +
        `const d = new D(process.argv[2], { timeout: 0 });\n` +
        `try { d.exec("BEGIN EXCLUSIVE"); d.exec("ROLLBACK"); process.stdout.write("GRANTED"); } catch (e) { process.stdout.write(e.code || String(e)); } finally { d.close(); }\n`
    );
  }
  const r = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  return r.stdout.trim() || `exit ${r.status}: ${r.stderr}`;
}

describe("INV-DB-01 2b-i: a native process never fs-opens a DB-family file", () => {
  it("HOLDING a write lock, the header is read through the held connection: no fs open of the family, and the lock is still held", async () => {
    makeWalDb(dbPath, NATIVE);
    await db.initializeDb();
    db.getDb().exec("BEGIN IMMEDIATE");
    try {
      const { result, opens } = familyOpensDuring(dbPath, () => header.readDriverHeader(dbPath));
      expect(result).toEqual({ kind: "native" });
      expect(opens, "no fs open of the DB family").toEqual([]);
      expect(otherProcessBeginExclusive(dbPath), "another process cannot take it").toBe("SQLITE_BUSY");
    } finally {
      db.getDb().exec("ROLLBACK");
    }
  });

  it("twin: with NO native handle held, the header is ONE synchronous fs read of the main file (source 3)", () => {
    makeWalDb(dbPath, NATIVE);
    const { result, opens } = familyOpensDuring(dbPath, () => header.readDriverHeader(dbPath));
    expect(result).toEqual({ kind: "native" });
    expect(result instanceof Promise, "synchronous").toBe(false);
    expect(opens).toEqual([`openSync(${dbPath})`]);
  });

  it("a native open of a file this process holds through a WRITABLE wasm connection is refused by name (the reverse in-process mix)", async () => {
    makeWalDb(dbPath, 0);
    fs.rmSync(dbPath + "-wal", { force: true });
    fs.rmSync(dbPath + "-shm", { force: true });
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    await compat.initializeDb(dbPath);
    await expect(openRawRelayDb(dbPath, { readonly: true })).rejects.toThrow(
      /REFUSING the native driver on the DB at .*this process holds a writable wasm connection to that file/
    );
  });

  it("the restore archive reader refuses a member of the live DB's family by identity: the DB, its -shm, a hard link to it", async () => {
    await db.initializeDb();
    db.getDb().prepare("SELECT count(*) FROM agents").get();
    const alias = path.join(caseDir, "alias.db");
    fs.linkSync(dbPath, alias);
    for (const p of [dbPath, `${dbPath}-shm`, alias]) {
      await expect(importRelayState(p, { force: true }), p).rejects.toThrow(/backup archive refused: .* is the live relay database \(or one of its side files\)/);
    }
  });

  it("twin (7657ad36): a native cold export opens no DB-family file through fs (SQLite reads it; any hash is of the snapshot)", async () => {
    makeWalDb(dbPath, NATIVE);
    const opens = await familyOpensDuringAsync(dbPath, () => exportRelayState({ destinationPath: path.join(caseDir, "cold.tar.gz") }));
    expect(opens.filter((o) => !o.startsWith("openSync(")), "no read of the live file's bytes").toEqual([]);
  });

  it("the suite-wide spy records an fs read of a DB this process holds natively (and this row clears it)", async () => {
    makeWalDb(dbPath, NATIVE);
    await db.initializeDb();
    _takeFsSpyViolations();
    fs.readFileSync(dbPath); // the hazard itself, on purpose: the lock is lost for this row only
    const seen = _takeFsSpyViolations();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/fs\.readFileSync\(.*relay\.db\) while this process holds a native handle on that DB/);
  });
});
