// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 slice 2a: the DB FILE'S HEADER decides which driver may open it (application_id, bytes 68-71, read with a
 * plain file read before any open).
 * - A native init stamps a legacy (0) or new DB "RLYN" and checkpoints, so the stamp is in the MAIN file.
 * - The wasm driver on a native-stamped DB is REFUSED when native loads in this process ("run native" is then a real
 *   remedy); when native cannot load here, wasm proceeds as before, with a loud named warning.
 * - A wasm-stamped DB ("RLYW", the single owner of a later slice) is refused by every opener in this slice, by path too.
 * - A foreign application_id is refused by name, never opened, migrated or stamped.
 * - A legacy DB under the wasm driver opens as before (slice 1's warning), unstamped; an export never stamps.
 * Every assertion reads the file's own bytes, not the relay's view of them.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import Database from "better-sqlite3";
import * as compat from "../src/sqlite-compat.js";
import * as db from "../src/db.js";
import * as header from "../src/db-header.js";
import { openRawRelayDb } from "../src/cli/_instance-db.js";
import { exportRelayState, importRelayState } from "../src/backup.js";
import { log } from "../src/logger.js";

const NATIVE = 0x524c594e;
const WASM = 0x524c5957;
const FOREIGN = 0x12345678;
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "db-header-")));
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
  (header as unknown as { _resetHeaderWarningsForTests?: () => void })._resetHeaderWarningsForTests?.();
});
afterEach(() => {
  db.closeDb();
  compat.closeInitializedDb();
  (header as unknown as { _setNativeProbeForTests?: (fn: null) => void })._setNativeProbeForTests?.(null);
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/**
 * The application_id in the MAIN file's header, read as bytes (never through SQLite), by ANOTHER process: a read in
 * this process would open and close a descriptor to the file, which drops this process's SQLite locks on it.
 */
const READ_APP_ID = path.join(ROOT, "read-app-id.cjs");
fs.writeFileSync(READ_APP_ID, `process.stdout.write(String(require("fs").readFileSync(process.argv[2]).readInt32BE(68)));\n`);
/** A file's SHA-256 computed by ANOTHER process (this one may hold a native handle on it). */
const READ_SHA = path.join(ROOT, "read-sha.cjs");
fs.writeFileSync(READ_SHA, `process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[2])).digest("hex"));\n`);
const shaElsewhere = (file: string) => spawnSync(process.execPath, [READ_SHA, file], { encoding: "utf8" }).stdout;
const appIdOf = (file: string) => {
  const r = spawnSync(process.execPath, [READ_APP_ID, file], { encoding: "utf8" });
  expect(r.status, `the header read: ${r.stderr}`).toBe(0);
  return Number(r.stdout);
};
/**
 * From ANOTHER process: can it take an exclusive POSIX lock on SQLite's SHARED byte range of the file? A native
 * connection holds a read lock there for its whole life; while it does, the answer must be no ("DENIED").
 */
const TRY_LOCK = path.join(ROOT, "try-lock.py");
fs.writeFileSync(
  TRY_LOCK,
  [
    "import fcntl, os, sys",
    "fd = os.open(sys.argv[1], os.O_RDWR)",
    "start, length = int(sys.argv[2]), int(sys.argv[3])",
    "try:",
    "    fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, length, start, os.SEEK_SET)",
    "    print('GRANTED')",
    "except OSError:",
    "    print('DENIED')",
    "",
  ].join("\n")
);
/** SQLite's SHARED range on the main file (PENDING_BYTE + 2, 510 bytes), and its -shm dead-man-switch byte (128). */
const MAIN_SHARED: [number, number] = [0x40000002, 510];
const SHM_DMS: [number, number] = [128, 1];
const otherProcessCanLockExclusive = (file: string, [start, length]: [number, number] = MAIN_SHARED) => {
  const r = spawnSync("python3", ["-I", TRY_LOCK, file, String(start), String(length)], { encoding: "utf8" });
  expect(r.status, `the lock probe ran (python3): ${r.stderr}`).toBe(0);
  return r.stdout.trim();
};
const sha = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
/** A rollback-journal SQLite file with one row, stamped `appId` (0 = legacy), made without the relay. */
function makeDb(file: string, appId: number): void {
  const d = new Database(file);
  d.pragma("journal_mode = DELETE");
  if (appId !== 0) d.pragma(`application_id = ${appId}`);
  d.exec("CREATE TABLE kept (v TEXT); INSERT INTO kept VALUES ('row-1');");
  d.close();
  expect(appIdOf(file)).toBe(appId);
}
/** The same, in WAL mode: a connection to it then holds SQLite's SHARED lock on the main file for its whole life. */
function makeWalDb(file: string, appId: number): void {
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  if (appId !== 0) d.pragma(`application_id = ${appId}`);
  d.exec("CREATE TABLE kept (v TEXT); INSERT INTO kept VALUES ('row-1');");
  d.close();
}
const POSIX = process.platform !== "win32";
const sideFiles = (file: string) => ["-wal", "-shm", "-journal"].filter((s) => fs.existsSync(file + s));
const warnings = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((c) => c.map(String).join(" "));

describe("INV-DB-01 slice 2a: the DB header decides the driver", () => {
  it("a native init of a NEW DB stamps RLYN in its MAIN file (read as bytes while the connection is still open)", async () => {
    await db.initializeDb();
    expect(appIdOf(dbPath), "the stamp is in the main file, not only in the WAL").toBe(NATIVE);
  });

  it("a native init stamps a LEGACY (0) DB in its main file and keeps its data", async () => {
    makeDb(dbPath, 0);
    await db.initializeDb();
    expect(appIdOf(dbPath)).toBe(NATIVE);
    expect(db.getDb().prepare("SELECT v FROM kept").get()).toEqual({ v: "row-1" });
  });

  it("the getDb() synchronous native fallback stamps too", () => {
    makeDb(dbPath, 0);
    db.getDb();
    expect(appIdOf(dbPath)).toBe(NATIVE);
  });

  it("wasm on a native-stamped DB is REFUSED when native loads here, with BOTH remedies (run native, or convert), and the file is untouched (slice 4: the message names relay convert-journal)", async () => {
    makeDb(dbPath, NATIVE);
    const before = sha(dbPath);
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    await expect(compat.initializeDb(dbPath)).rejects.toThrow(
      /REFUSING the wasm driver .*native relay database \(RLYN\).*never adopts[\s\S]*unset RELAY_SQLITE_DRIVER[\s\S]*relay convert-journal --to wasm/
    );
    await expect(db.initializeDb()).rejects.toThrow(/relay convert-journal --to wasm/);
    expect(sha(dbPath), "the refused file is byte-identical").toBe(before);
  });

  it("two processes declaring different things about one file both follow its header (in-process, one after the other)", async () => {
    // The first declares nothing (native) through one config path; the second declares wasm through another.
    process.env.RELAY_CONFIG_PATH = path.join(caseDir, "a", "config.json");
    await db.initializeDb();
    db.closeDb();
    compat.closeInitializedDb();
    expect(appIdOf(dbPath)).toBe(NATIVE);
    process.env.RELAY_CONFIG_PATH = path.join(caseDir, "b", "config.json");
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    await expect(db.initializeDb()).rejects.toThrow(/native relay database \(RLYN\)[\s\S]*relay convert-journal/); // slice 4 wording
  });

  it("wasm BY PATH on a native-stamped DB (a cold wasm export source) is refused too", async () => {
    makeDb(dbPath, NATIVE);
    await expect(compat.openExportSource(dbPath, "wasm")).rejects.toThrow(/REFUSING the wasm driver/);
  });

  it("slice 4 (BREAKING 5.0.0): native cannot load here: wasm on a native-stamped DB is REFUSED too, naming relay convert-journal, and the file is untouched (before: opened, with ONE loud warning)", async () => {
    makeDb(dbPath, NATIVE);
    const before = sha(dbPath);
    header._setNativeProbeForTests(() => ({ ok: false, reason: "Could not locate the bindings file" }));
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    await expect(compat.initializeDb(dbPath)).rejects.toThrow(/REFUSING the wasm driver .*native relay database \(RLYN\).*never adopts[\s\S]*unset RELAY_SQLITE_DRIVER[\s\S]*relay convert-journal --to wasm/);
    expect(sha(dbPath), "the refused file is byte-identical").toBe(before);
  });

  it("slice 2b-ii: a WASM-stamped DB refuses every NATIVE-only opener (by path too, with the HTTP client config), untouched; the initializer opens it as its owner (the header decides)", async () => {
    makeDb(dbPath, WASM);
    const before = sha(dbPath);
    const owned = /owned by the wasm driver's single owner .*"type": "http"/;
    expect(() => db.getDb(), "the sync native fallback").toThrow(owned);
    await expect(openRawRelayDb(dbPath, { readonly: true }), "a raw CLI open").rejects.toThrow(owned);
    await expect(compat.openExportSource(dbPath, "native"), "a native export source").rejects.toThrow(owned);
    await expect(compat.openReadOnly(dbPath, "native"), "a native read-only probe").rejects.toThrow(owned);
    expect(sha(dbPath)).toBe(before);
    expect(sideFiles(dbPath)).toEqual([]);
    await db.initializeDb(); // declarations native: the RLYW header decides (wasm, the single owner)
    expect(compat.getActiveDriver()).toBe("wasm");
  });

  it("a FOREIGN application_id is refused by name: never opened, migrated or stamped", async () => {
    makeDb(dbPath, FOREIGN);
    const before = sha(dbPath);
    await expect(db.initializeDb()).rejects.toThrow(/application_id is 0x12345678, which is not the relay's/);
    expect(() => db.getDb()).toThrow(/not the relay's/);
    await expect(openRawRelayDb(dbPath, { readonly: false })).rejects.toThrow(/not the relay's/);
    expect(sha(dbPath)).toBe(before);
    expect(sideFiles(dbPath)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("a native init keeps this process's SQLite lock on the DB file: another process cannot take it exclusively (stamping never re-reads the open file)", async () => {
    makeDb(dbPath, 0);
    await db.initializeDb();
    expect(appIdOf(dbPath), "stamped").toBe(NATIVE);
    expect(otherProcessCanLockExclusive(dbPath), "the connection's SHARED lock is still held").toBe("DENIED");
  });

  it.skipIf(process.platform === "win32")("the same for getDb()'s synchronous native fallback", () => {
    makeDb(dbPath, 0);
    db.getDb();
    expect(otherProcessCanLockExclusive(dbPath)).toBe("DENIED");
  });

  it("a header read of a DB this process holds natively goes THROUGH the held connection (no fs open, the lock kept); after the close, one fs read", async () => {
    await db.initializeDb();
    // 2b-i: read THROUGH the held connection (source 1), never by an fs open; after the close, by one fs read.
    expect(header.nativeHandleCount(dbPath)).toBe(1);
    expect(header.readDriverHeader(dbPath)).toEqual({ kind: "native" });
    if (POSIX) expect(otherProcessCanLockExclusive(dbPath), "the connection's lock").toBe("DENIED");
    db.closeDb();
    expect(header.nativeHandleCount(dbPath)).toBe(0);
    expect(header.readDriverHeader(dbPath)).toEqual({ kind: "native" });
  });

  it("the same while a raw CLI handle is open, and again after it is closed", async () => {
    makeDb(dbPath, NATIVE);
    const raw = await openRawRelayDb(dbPath, { readonly: true });
    expect(header.nativeHandleCount(dbPath)).toBe(1);
    expect(header.readDriverHeader(dbPath)).toEqual({ kind: "native" });
    raw.close();
    expect(header.nativeHandleCount(dbPath)).toBe(0);
    expect(header.readDriverHeader(dbPath)).toEqual({ kind: "native" });
  });

  it.skipIf(process.platform === "win32")("a SYMLINK alias of a DB this process holds natively is the same file: counted, and its header comes through the held connection", async () => {
    await db.initializeDb();
    const alias = path.join(caseDir, "alias.db");
    fs.symlinkSync(dbPath, alias);
    expect(header.nativeHandleCount(alias)).toBe(1);
    expect(header.readDriverHeader(alias)).toEqual({ kind: "native" });
    expect(otherProcessCanLockExclusive(dbPath)).toBe("DENIED");
  });

  it("a HARD-LINK alias of a held DB is the same file: counted, its header comes through the held connection, and a wasm read of it is refused", async () => {
    makeDb(dbPath, 0);
    const raw = await openRawRelayDb(dbPath, { readonly: true });
    try {
      const alias = path.join(caseDir, "hard.db");
      fs.linkSync(dbPath, alias);
      expect(header.nativeHandleCount(alias), "counted by identity").toBe(1);
      expect(header.readDriverHeader(alias), "the header read").toEqual({ kind: "legacy" });
      await expect(compat.openExportSource(alias, "wasm"), "a wasm read of the source").rejects.toThrow(/already holds a native connection to that file/);
    } finally {
      raw.close();
    }
  });

  it("a SECOND native connection in the same process opens (the doorbell's case): judged at the first open, never re-read; a wasm open of it is refused by name", async () => {
    await db.initializeDb();
    const second = await openRawRelayDb(dbPath, { readonly: true });
    try {
      expect(second.prepare("SELECT count(*) AS n FROM agents").get()).toEqual({ n: 0 });
      if (process.platform !== "win32") expect(otherProcessCanLockExclusive(dbPath), "both connections' locks held").toBe("DENIED");
    } finally {
      second.close();
    }
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    await expect(compat.openExportSource(dbPath, "wasm")).rejects.toThrow(
      /REFUSING the wasm driver .*this process already holds a native connection to that file/
    );
  });

  describe("Codex #380 R1", () => {
    it.each([
      ["openReadOnly (native)", () => compat.openReadOnly(dbPath, "native")],
      ["openExportSource (native)", async () => (await compat.openExportSource(dbPath, "native")).db],
      ["the compat initializer", () => compat.initializeDb(dbPath)],
    ] as const)("P1-1: a native handle from %s is counted from its construction: the header comes through it and the lock stays", async (_name, open) => {
      makeWalDb(dbPath, NATIVE);
      const h = await open();
      try {
        expect(h.prepare("SELECT v FROM kept").get()).toEqual({ v: "row-1" });
        expect(header.nativeHandleCount(dbPath)).toBe(1);
        expect(header.readDriverHeader(dbPath)).toEqual({ kind: "native" });
        if (POSIX) expect(otherProcessCanLockExclusive(dbPath)).toBe("DENIED");
      } finally {
        h.close();
      }
      expect(header.nativeHandleCount(dbPath), "released by its close").toBe(0);
    });

    it("P1-2: a restore whose archive path is the live DB, or its -shm, is refused by name (identity), and the locks stay", async () => {
      await db.initializeDb();
      db.getDb().prepare("SELECT count(*) FROM agents").get();
      expect(fs.existsSync(dbPath + "-shm"), "precondition: a -shm").toBe(true);
      await expect(importRelayState(dbPath, { force: true })).rejects.toThrow(/backup archive refused: .* is the live relay database/);
      await expect(importRelayState(dbPath + "-shm", { force: true })).rejects.toThrow(/backup archive refused: .* is the live relay database/);
      if (POSIX) expect(otherProcessCanLockExclusive(dbPath), "the connection's lock").toBe("DENIED");
      if (POSIX) expect(otherProcessCanLockExclusive(dbPath + "-shm", SHM_DMS), "its -shm lock byte").toBe("DENIED");
    });

    it("P1-3: a close that FAILS (a busy iterator) keeps the handle counted; the close that succeeds releases it", async () => {
      makeWalDb(dbPath, NATIVE);
      const raw = await openRawRelayDb(dbPath, { readonly: true });
      const it = raw.prepare("SELECT v FROM kept").iterate() as IterableIterator<unknown>;
      it.next();
      expect(() => raw.close(), "better-sqlite3 refuses to close a busy connection").toThrow(/busy/);
      expect(header.nativeHandleCount(dbPath), "still counted").toBe(1);
      if (POSIX) expect(otherProcessCanLockExclusive(dbPath)).toBe("DENIED");
      it.return?.();
      raw.close();
      expect(header.nativeHandleCount(dbPath)).toBe(0);
    });

    it("P1-3 (db.ts): a failed closeDb() keeps the handle counted too", async () => {
      makeWalDb(dbPath, NATIVE);
      await db.initializeDb();
      const it = db.getDb().prepare("SELECT v FROM kept").iterate() as IterableIterator<unknown>;
      it.next();
      expect(() => db.closeDb()).toThrow(/busy/);
      expect(header.nativeHandleCount(dbPath)).toBe(1);
      it.return?.();
    });

    it("P2-4: concurrent initializeDb() registers ONE hold: after closeDb() the header reads again, and a wasm open is judged by the header, not as a mix", async () => {
      await Promise.all([db.initializeDb(), db.initializeDb()]);
      db.closeDb();
      expect(header.readDriverHeader(dbPath)).toEqual({ kind: "native" });
      await expect(compat.openExportSource(dbPath, "wasm")).rejects.toThrow(/its header says it is a native relay database/);
    });

    it("P2-5: a held LEGACY file is still stamped by a native init (the hold keeps the first open's verdict)", async () => {
      makeWalDb(dbPath, 0);
      const raw = await openRawRelayDb(dbPath, { readonly: true });
      await db.initializeDb();
      raw.close();
      db.closeDb();
      expect(appIdOf(dbPath)).toBe(NATIVE);
    });

    it("P2-6: a refused compat init is not cached: a retry with the driver fixed re-evaluates", async () => {
      makeDb(dbPath, NATIVE);
      process.env.RELAY_SQLITE_DRIVER = "wasm";
      await expect(compat.initializeDb(dbPath)).rejects.toThrow(/relay convert-journal --to wasm/); // slice 4 wording
      delete process.env.RELAY_SQLITE_DRIVER;
      const opened = await compat.initializeDb(dbPath);
      expect(compat.driverOf(opened)).toBe("native");
    });

    // Slice 2b-ii: a cold export of an RLYW DB with no owner live now RUNS (under the owner's lock), so the refused
    // case here is a FOREIGN header.
    it("a refused cold export creates NOTHING (the header is checked before the backups directory is made)", async () => {
      makeDb(dbPath, FOREIGN);
      await expect(exportRelayState({ destinationPath: path.join(caseDir, "x.tar.gz") })).rejects.toThrow(/not the relay's/);
      expect(fs.existsSync(path.join(caseDir, "backups")), "no backups directory").toBe(false);
    });

    it("a restore while ANOTHER native handle on the live DB is open in this process is refused by name; the live DB is untouched", async () => {
      await db.initializeDb();
      db.registerAgent("before-restore", "r", []);
      const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "a.tar.gz") })).archive_path;
      const raw = await openRawRelayDb(dbPath, { readonly: true });
      try {
        db.closeDb();
        // Hashed by ANOTHER process: this one still holds the raw handle (the suite-wide spy enforces it).
        const before = shaElsewhere(dbPath);
        await expect(importRelayState(archive, { force: true })).rejects.toThrow(/restore refused: this process still holds a native connection/);
        expect(shaElsewhere(dbPath)).toBe(before);
      } finally {
        raw.close();
      }
    });

    it("the probe seam is test-only: outside a test runner it throws", () => {
      const saved = process.env.VITEST;
      delete process.env.VITEST;
      try {
        expect(() => header._setNativeProbeForTests(() => ({ ok: true }))).toThrow(/test-only/);
      } finally {
        process.env.VITEST = saved;
        header._setNativeProbeForTests(null);
      }
    });
  });

  describe("Codex #380 R2", () => {
    it("P1: a DB whose own NAME ends in -wal keeps its real sidecar protected (no suffix is stripped from the main path)", async () => {
      const p = path.join(caseDir, "suffix-wal");
      makeWalDb(p, NATIVE);
      const raw = await openRawRelayDb(p, { readonly: true });
      try {
        raw.prepare("SELECT v FROM kept").get();
        expect(fs.existsSync(p + "-shm"), "precondition: its -shm").toBe(true);
        expect(header.readDriverHeader(p), "its header, through the held connection").toEqual({ kind: "native" });
        if (POSIX) expect(otherProcessCanLockExclusive(p + "-shm", SHM_DMS), "its -shm lock byte").toBe("DENIED");
      } finally {
        raw.close();
      }
    });

    it("P1: two unrelated DBs named x-wal and x-shm are NOT one family: the second is judged by its own header", async () => {
      const a = path.join(caseDir, "unrelated-wal");
      const b = path.join(caseDir, "unrelated-shm");
      makeWalDb(a, NATIVE);
      makeDb(b, FOREIGN);
      const raw = await openRawRelayDb(a, { readonly: true });
      try {
        await expect(compat.openReadOnly(b, "native")).rejects.toThrow(/application_id is 0x12345678, which is not the relay's/);
      } finally {
        raw.close();
      }
    });

    it("P2: a failed closeDb() keeps its reference, so a retry closes the handle and releases the hold", async () => {
      makeWalDb(dbPath, NATIVE);
      await db.initializeDb();
      const it = db.getDb().prepare("SELECT v FROM kept").iterate() as IterableIterator<unknown>;
      it.next();
      expect(() => db.closeDb()).toThrow(/busy/);
      it.return?.();
      db.closeDb();
      expect(header.nativeHandleCount(dbPath), "released by the retry").toBe(0);
    });

    it.skipIf(!POSIX)("P2: an ABANDONED native handle is kept alive by its hold (never GC-closed while counted): still held, still locked", async () => {
      makeWalDb(dbPath, NATIVE);
      const v8 = await import("v8");
      const vm = await import("vm");
      v8.setFlagsFromString("--expose_gc");
      const gc = vm.runInNewContext("gc") as () => void;
      let ref: WeakRef<object>;
      await (async () => {
        const h = await compat.openReadOnly(dbPath, "native");
        h.prepare("SELECT v FROM kept").get();
        ref = new WeakRef(h);
      })();
      for (let i = 0; i < 5; i++) {
        gc();
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(header.nativeHandleCount(dbPath), "still counted").toBe(1);
      expect(otherProcessCanLockExclusive(dbPath), "the abandoned handle's lock is still held").toBe("DENIED");
      (ref!.deref() as { close?: () => void } | undefined)?.close?.();
    });

    it("P3: a restore counts handles across ALIASES of the live DB: a raw handle through a hard link is refused BEFORE the safety backup and closeDb()", async () => {
      await db.initializeDb();
      db.registerAgent("before-restore", "r", []);
      const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "a.tar.gz") })).archive_path;
      const alias = path.join(caseDir, "alias.db");
      fs.linkSync(dbPath, alias);
      const raw = await openRawRelayDb(alias, { readonly: true });
      try {
        await expect(importRelayState(archive, { force: true })).rejects.toThrow(/restore refused: this process still holds a native connection/);
        const backups = path.join(caseDir, "backups");
        const pre = fs.existsSync(backups) ? fs.readdirSync(backups).filter((f) => f.startsWith("pre-restore-")) : [];
        expect(pre, "no safety backup was made").toEqual([]);
        expect(db.peekDb(), "the relay's own connection was not closed").not.toBeNull();
      } finally {
        raw.close();
      }
    });
  });

  it("slice 4 (BREAKING 5.0.0) twin: a LEGACY DB under the wasm driver is REFUSED by name, naming relay convert-journal, and is NOT stamped (before: opened, slice 1's warning)", async () => {
    makeDb(dbPath, 0);
    const before = sha(dbPath);
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    await expect(db.initializeDb()).rejects.toThrow(/legacy \(unstamped\) relay database[\s\S]*relay convert-journal --to wasm/);
    expect(appIdOf(dbPath), "never stamped").toBe(0);
    expect(sha(dbPath)).toBe(before);
  });

  it("twin: a cold export of a legacy DB never stamps it (nor changes a byte)", async () => {
    makeDb(dbPath, 0);
    const before = sha(dbPath);
    await exportRelayState({ destinationPath: path.join(caseDir, "cold.tar.gz") });
    expect(appIdOf(dbPath)).toBe(0);
    expect(sha(dbPath)).toBe(before);
  });

  it("twin: an already-stamped native DB opens natively, and its header stays RLYN", async () => {
    makeDb(dbPath, NATIVE);
    await db.initializeDb();
    expect(appIdOf(dbPath)).toBe(NATIVE);
    expect(compat.getActiveDriver()).toBe("native");
  });

  it.skipIf(process.platform === "win32")("a FIFO at the DB path never blocks the header read (it is not a SQLite file)", async () => {
    const fifo = path.join(caseDir, "relay.fifo");
    const mk = await new Promise<number | null>((res) => spawn("mkfifo", [fifo]).on("exit", res));
    expect(mk, "mkfifo").toBe(0);
    const script = path.join(caseDir, "fifo.mjs");
    const dist = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "db-header.js")).href;
    fs.writeFileSync(
      script,
      `const h = await import(${JSON.stringify(dist)});\n` +
        `process.stdout.write(JSON.stringify(h.readDriverHeader(${JSON.stringify(fifo)})) + "\\n");\n` +
        `process.exit(0);\n`
    );
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    const finished = await new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), 10_000);
      child.on("close", () => {
        clearTimeout(t);
        res(true);
      });
    });
    if (!finished) child.kill("SIGKILL");
    expect(finished, "the header read returned").toBe(true);
    expect(JSON.parse(out)).toEqual({ kind: "unrecognised", reason: "not a regular file" });
  }, 30_000);
});
