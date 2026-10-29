// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-BACKUP-01: an export NEVER MUTATES its source DB.
 *
 * With no DB connection open in the process (a cold `relay backup`), the export opens the source READ-ONLY: no
 * initializeDb(), so no migration, backfill or permission change ever runs on it. The manifest records the SOURCE's
 * schema version. The bar is the LOGICAL content (every table's rows, the schema, schema_info), not a byte-identical
 * directory: a native read-only open of a WAL DB still writes its -shm side file (MEASURED).
 *
 * - A native read-only open needs to create -shm when there is none, so in a read-only directory it is refused by name.
 * - The wasm driver reads only the main file, so it refuses a WAL-mode DB (header bytes 18-19 = 2) or any -wal / -shm
 *   beside it, before and after the snapshot, and it never writes the source back.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const ENV = ["RELAY_DB_PATH", "RELAY_CONFIG_PATH", "RELAY_HTTP_PORT", "RELAY_SQLITE_DRIVER", "RELAY_ENCRYPTION_KEYRING", "RELAY_ENCRYPTION_KEYRING_PATH", "RELAY_ENCRYPTION_KEY"] as const;
const WIN = process.platform === "win32";
const ROOT_USER = typeof process.getuid === "function" && process.getuid() === 0;

let saved: Record<string, string | undefined>;
let root: string;
let dbPath: string;
beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inv-backup-01-")));
  fs.mkdirSync(path.join(root, "db"), { mode: 0o700 });
  dbPath = path.join(root, "db", "relay.db");
  process.env.RELAY_DB_PATH = dbPath;
  process.env.RELAY_CONFIG_PATH = path.join(root, "db", "config.json");
  process.env.RELAY_HTTP_PORT = "1";
  (await import("../src/db.js")).closeDb();
  (await import("../src/encryption.js"))._resetKeyringCacheForTests();
});
afterEach(async () => {
  (await import("../src/db.js")).closeDb();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  (await import("../src/encryption.js"))._resetKeyringCacheForTests();
  try {
    fs.chmodSync(path.join(root, "db"), 0o700);
  } catch {
    /* already writable */
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** A relay DB at dbPath, built by the relay itself, then CLOSED: no connection is left open in the process. */
async function makeSourceDb(opts: { webhookSecret?: string } = {}): Promise<void> {
  const db = await import("../src/db.js");
  await db.initializeDb();
  db.registerAgent("alpha", "r", []);
  db.registerAgent("beta", "r", []);
  db.sendMessage("alpha", "beta", "hello", "normal");
  if (opts.webhookSecret) db.registerWebhook("https://example.com/hook", "message.sent", undefined, opts.webhookSecret);
  db.closeDb();
}

/** The LOGICAL content of a DB file, read through sql.js from the main file's bytes (no side file is touched). */
async function logicalDump(file: string): Promise<string> {
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(file));
  try {
    const out: string[] = [];
    const master = db.exec("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
    for (const row of master[0]?.values ?? []) out.push(JSON.stringify(row));
    for (const row of master[0]?.values ?? []) {
      if (row[0] !== "table") continue;
      const t = String(row[1]).replace(/"/g, '""');
      const r = db.exec(`SELECT * FROM "${t}"`);
      const rows = (r[0]?.values ?? []).map((v: unknown) => JSON.stringify(v)).sort();
      out.push(`${row[1]}: ${rows.join("|")}`);
    }
    return out.join("\n");
  } finally {
    db.close();
  }
}
const statOf = (f: string) => ({ bytes: crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"), mtimeMs: fs.statSync(f).mtimeMs });
/** The DB's journal mode as its header records it: bytes 18-19 are 2 in WAL mode, 1 in a rollback-journal mode. */
const headerMode = (f: string) => {
  const b = fs.readFileSync(f).subarray(18, 20);
  return b[0] === 2 && b[1] === 2 ? "wal" : "rollback";
};
/** A CONTENT change to the main file that keeps it a valid DB: the header's file change counter (bytes 24-27) + 1. */
function bumpChangeCounter(file: string): void {
  const fd = fs.openSync(file, "r+");
  try {
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 24);
    b.writeUInt32BE((b.readUInt32BE(0) + 1) >>> 0, 0);
    fs.writeSync(fd, b, 0, 4, 24);
  } finally {
    fs.closeSync(fd);
  }
}
async function setSchemaVersion(v: number): Promise<void> {
  const Database = (await import("better-sqlite3")).default;
  const raw = new Database(dbPath);
  raw.prepare("UPDATE schema_info SET version = ? WHERE id = 1").run(v);
  raw.close();
}
async function toRollbackJournal(): Promise<void> {
  const Database = (await import("better-sqlite3")).default;
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = DELETE");
  raw.close();
}

describe("INV-BACKUP-01: an export never mutates its source DB", () => {
  it("(1) a COLD export with a plaintext webhook secret under a BROKEN keyring succeeds (no migration runs on the source)", async () => {
    await makeSourceDb({ webhookSecret: "plain-secret-1" });
    process.env.RELAY_ENCRYPTION_KEYRING = "{ not json";
    (await import("../src/encryption.js"))._resetKeyringCacheForTests();
    const { exportRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState({ destinationPath: path.join(root, "cold.tar.gz") });
    expect(fs.existsSync(exp.archive_path)).toBe(true);
    expect(exp.webhook_secrets?.plaintext).toBe(1);
  });

  it("(2) the source's LOGICAL content is identical before and after a cold export", async () => {
    await makeSourceDb({ webhookSecret: "plain-secret-2" });
    const before = await logicalDump(dbPath);
    const { exportRelayState } = await import("../src/backup.js");
    await exportRelayState({ destinationPath: path.join(root, "a.tar.gz") });
    expect(await logicalDump(dbPath)).toBe(before);
  });

  it("(2) with an OLDER schema version: no migration runs, the source is unchanged, and the manifest records the SOURCE's version", async () => {
    await makeSourceDb();
    const { CURRENT_SCHEMA_VERSION } = await import("../src/db.js");
    await setSchemaVersion(CURRENT_SCHEMA_VERSION - 1);
    const before = await logicalDump(dbPath);
    const { exportRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState({ destinationPath: path.join(root, "old.tar.gz") });
    expect(await logicalDump(dbPath), "the source is unchanged").toBe(before);
    expect(exp.schema_version, "the manifest records the source's schema version").toBe(CURRENT_SCHEMA_VERSION - 1);
  });

  it("(2) the WARM path too: with the connection open, the export runs no migration or write (the logical content is identical before and after)", async () => {
    await makeSourceDb({ webhookSecret: "plain-secret-warm" });
    const db = await import("../src/db.js");
    await db.initializeDb(); // the connection's own open (and its migrations) happen HERE, before the export
    // The dump reads the main file only, so the TEST checkpoints the WAL into it first (its own write, not the export's).
    const checkpoint = () => db.getDb().pragma("wal_checkpoint(TRUNCATE)");
    checkpoint();
    const before = await logicalDump(dbPath);
    const { exportRelayState } = await import("../src/backup.js");
    await exportRelayState({ destinationPath: path.join(root, "warm-only.tar.gz") });
    checkpoint();
    expect(await logicalDump(dbPath)).toBe(before);
  });

  it("(3) WARM = COLD: the same DB exported with its connection open and then closed gives the same archived content", async () => {
    await makeSourceDb({ webhookSecret: "plain-secret-3" });
    const db = await import("../src/db.js");
    const { exportRelayState } = await import("../src/backup.js");
    const { gunzipToFile, extractBackupTar } = await import("../src/backup-archive.js");
    const unpack = async (archive: string, tag: string) => {
      const plain = path.join(root, `${tag}.tar`);
      await gunzipToFile(archive, plain);
      const dir = path.join(root, tag);
      fs.mkdirSync(dir);
      extractBackupTar(plain, dir);
      const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));
      delete m.created_at;
      return { dump: await logicalDump(path.join(dir, "relay.db")), manifest: m };
    };
    await db.initializeDb();
    const warm = await exportRelayState({ destinationPath: path.join(root, "warm.tar.gz") });
    db.closeDb();
    const cold = await exportRelayState({ destinationPath: path.join(root, "cold.tar.gz") });
    const w = await unpack(warm.archive_path, "w");
    const c = await unpack(cold.archive_path, "c");
    expect(c.dump).toBe(w.dump);
    expect(c.manifest).toEqual(w.manifest);
  });

  it("(4) the daemon's startup still FAILS CLOSED on a broken keyring (only the export path is read-only)", async () => {
    await makeSourceDb({ webhookSecret: "plain-secret-4" });
    process.env.RELAY_ENCRYPTION_KEYRING = "{ not json";
    const enc = await import("../src/encryption.js");
    enc._resetKeyringCacheForTests();
    expect(() => enc.validateKeyringStrict()).toThrow(/malformed JSON/);
    const db = await import("../src/db.js");
    await expect(db.initializeDb()).rejects.toThrow();
  });

  it.skipIf(WIN || ROOT_USER)("a cold native export from a READ-ONLY directory with no -shm is REFUSED by name (a read-only open must create -shm), and nothing is written", async () => {
    await makeSourceDb();
    expect(fs.existsSync(dbPath + "-shm"), "precondition: no -shm").toBe(false);
    const before = statOf(dbPath);
    fs.chmodSync(path.join(root, "db"), 0o500);
    const { exportRelayState } = await import("../src/backup.js");
    await expect(exportRelayState({ destinationPath: path.join(root, "ro.tar.gz") })).rejects.toThrow(/read-only directory/);
    fs.chmodSync(path.join(root, "db"), 0o700);
    expect(statOf(dbPath)).toEqual(before);
    expect(fs.existsSync(path.join(root, "ro.tar.gz"))).toBe(false);
  });
});

describe("INV-BACKUP-01: the wasm export refuses what it cannot read completely, and never writes the source", () => {
  afterEach(async () => {
    // Optional: before the hook existed (the RED baseline), its absence must not fail every row here.
    (await import("../src/backup.js") as { _setExportReadHookForTests?: (f: null) => void })._setExportReadHookForTests?.(null);
  });

  it("a cleanly CLOSED native DB (a WAL header, no side files) exports under wasm: the main file holds every commit (ruled: the header alone is no refusal)", async () => {
    await makeSourceDb({ webhookSecret: "plain-secret-6" });
    expect(headerMode(dbPath), "precondition: a WAL header").toBe("wal");
    for (const s of ["-wal", "-shm"]) expect(fs.existsSync(dbPath + s), `precondition: no ${s}`).toBe(false);
    const before = statOf(dbPath);
    const dump = await logicalDump(dbPath);
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const { exportRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState({ destinationPath: path.join(root, "clean-wal.tar.gz") });
    expect(fs.existsSync(exp.archive_path)).toBe(true);
    expect(statOf(dbPath), "bytes and mtime unchanged").toEqual(before);
    expect(await logicalDump(dbPath)).toBe(dump);
  });

  it.each([
    ["-wal", "a WAL header"],
    ["-shm", "a WAL header"],
    ["-wal", "a rollback-journal header"],
    ["-shm", "a rollback-journal header"],
  ])("a %s file beside the DB (even empty; %s) is REFUSED by name before any read; the source is untouched", async (side, mode) => {
    await makeSourceDb();
    if (mode === "a rollback-journal header") await toRollbackJournal();
    fs.writeFileSync(dbPath + side, "");
    const before = statOf(dbPath);
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const { exportRelayState } = await import("../src/backup.js");
    await expect(exportRelayState({ destinationPath: path.join(root, "s.tar.gz") })).rejects.toThrow(new RegExp(`a ${side} file is beside the DB`));
    expect(statOf(dbPath)).toEqual(before);
  });

  it("a NATIVE open during the snapshot (it creates -shm) is caught by the AFTER-check: refused, and no archive is written", async () => {
    await makeSourceDb();
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const { exportRelayState, _setExportReadHookForTests } = await import("../src/backup.js");
    const Database = (await import("better-sqlite3")).default;
    let opener: { close(): void } | null = null;
    _setExportReadHookForTests(() => {
      opener = new Database(dbPath);
      (opener as unknown as { prepare(s: string): { get(): unknown } }).prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
    });
    const dest = path.join(root, "during.tar.gz");
    try {
      await expect(exportRelayState({ destinationPath: dest })).rejects.toThrow(/a -(wal|shm) file is beside the DB/);
    } finally {
      (opener as { close(): void } | null)?.close();
    }
    expect(fs.existsSync(dest), "no archive").toBe(false);
  });

  it("the MAIN file's CONTENT changed during the read (its hash) is refused after ONE retry; no archive is written", async () => {
    await makeSourceDb();
    await toRollbackJournal();
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const { exportRelayState, _setExportReadHookForTests } = await import("../src/backup.js");
    let calls = 0;
    _setExportReadHookForTests(() => {
      calls++;
      bumpChangeCounter(dbPath);
    });
    const dest = path.join(root, "torn.tar.gz");
    await expect(exportRelayState({ destinationPath: dest })).rejects.toThrow(/changed while it was being read/);
    expect(calls, "read twice: the first read and ONE retry").toBe(2);
    expect(fs.existsSync(dest), "no archive").toBe(false);
  });

  it("known-good twin: the main file changed during the FIRST read only → the retry reads it whole and the export succeeds", async () => {
    await makeSourceDb();
    await toRollbackJournal();
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const { exportRelayState, _setExportReadHookForTests } = await import("../src/backup.js");
    let calls = 0;
    _setExportReadHookForTests(() => {
      calls++;
      if (calls === 1) bumpChangeCounter(dbPath);
    });
    const exp = await exportRelayState({ destinationPath: path.join(root, "retry.tar.gz") });
    expect(fs.existsSync(exp.archive_path)).toBe(true);
    expect(calls).toBe(2);
  });

  it("Codex R1: an mtime-only change with the SAME bytes is NOT a torn read (the guard hashes content): the export succeeds on the first read", async () => {
    await makeSourceDb();
    await toRollbackJournal();
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const { exportRelayState, _setExportReadHookForTests } = await import("../src/backup.js");
    let calls = 0;
    _setExportReadHookForTests(() => {
      calls++;
      const t = new Date(Date.now() + calls * 5000);
      fs.utimesSync(dbPath, t, t);
    });
    const exp = await exportRelayState({ destinationPath: path.join(root, "mtime-only.tar.gz") });
    expect(fs.existsSync(exp.archive_path)).toBe(true);
    expect(calls, "one read, no retry").toBe(1);
  });

  it("Codex R1: a WARM wasm image that fails integrity_check is refused too (not only a cold read)", async () => {
    await makeSourceDb();
    await toRollbackJournal();
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const db = await import("../src/db.js");
    await db.initializeDb();
    // Corrupt the LIVE image through SQL: messages' root page points nowhere.
    db.getDb().exec("PRAGMA writable_schema = ON; UPDATE sqlite_master SET rootpage = 999999 WHERE name = 'messages'; PRAGMA writable_schema = OFF;");
    const { exportRelayState } = await import("../src/backup.js");
    const dest = path.join(root, "warm-corrupt.tar.gz");
    await expect(exportRelayState({ destinationPath: dest })).rejects.toThrow(/fails PRAGMA integrity_check/);
    expect(fs.existsSync(dest), "no archive").toBe(false);
  });

  it("the loaded image FAILS integrity_check → refused before archiving; no archive is written", async () => {
    await makeSourceDb();
    await toRollbackJournal();
    // Corrupt pages 2-6 at their b-tree page-type byte (page 1, the header and the schema root, stays valid, so the file
    // still opens): an invalid page type that integrity_check must report.
    const pageSize = (() => { const h = fs.readFileSync(dbPath).subarray(16, 18); const v = h.readUInt16BE(0); return v === 1 ? 65536 : v; })();
    const pages = Math.floor(fs.statSync(dbPath).size / pageSize);
    expect(pages, "precondition: pages to corrupt").toBeGreaterThan(2);
    const fd = fs.openSync(dbPath, "r+");
    for (let p = 2; p <= Math.min(6, pages); p++) fs.writeSync(fd, Buffer.from([0x5a]), 0, 1, (p - 1) * pageSize);
    fs.closeSync(fd);
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const { exportRelayState } = await import("../src/backup.js");
    const dest = path.join(root, "corrupt.tar.gz");
    await expect(exportRelayState({ destinationPath: dest })).rejects.toThrow(/fails PRAGMA integrity_check/);
    expect(fs.existsSync(dest), "no archive").toBe(false);
  });

  it("known-good twin: a rollback-journal DB with no side file exports under wasm, and the source's bytes AND mtime are unchanged (no write-back)", async () => {
    await makeSourceDb({ webhookSecret: "plain-secret-5" });
    await toRollbackJournal();
    for (const s of ["-wal", "-shm", "-journal"]) expect(fs.existsSync(dbPath + s), `precondition: no ${s}`).toBe(false);
    const before = statOf(dbPath);
    const dump = await logicalDump(dbPath);
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const { exportRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState({ destinationPath: path.join(root, "ok.tar.gz") });
    expect(fs.existsSync(exp.archive_path)).toBe(true);
    expect(statOf(dbPath), "bytes and mtime unchanged").toEqual(before);
    expect(await logicalDump(dbPath)).toBe(dump);
  });
});

describe("Codex R1 (ruled): the archive's destination is never the source DB, a name SQLite would take as one of its files, or an existing file", () => {
  it.each([
    ["the DB itself", () => dbPath],
    ["a symlink to the DB", () => { const l = path.join(root, "link.tar.gz"); fs.symlinkSync(dbPath, l); return l; }],
    ["a hardlink to the DB", () => { const h = path.join(root, "hard.tar.gz"); fs.linkSync(dbPath, h); return h; }],
    ["an unrelated existing file", () => { const e = path.join(root, "existing.tar.gz"); fs.writeFileSync(e, "do not truncate me"); return e; }],
  ])("REFUSED (it exists, never truncated): --output is %s; the source is untouched", async (label, make) => {
    if (WIN && label === "a symlink to the DB") return;
    await makeSourceDb();
    const dest = make();
    const before = statOf(dbPath);
    const destBefore = fs.readFileSync(dest);
    const { exportRelayState } = await import("../src/backup.js");
    await expect(exportRelayState({ destinationPath: dest })).rejects.toThrow(/already exists/);
    expect(statOf(dbPath)).toEqual(before);
    expect(fs.readFileSync(dest)).toEqual(destBefore);
  });

  it.each(["relay.db-wal", "relay.db-shm", "relay.db-journal", "relay.db-mj1A2B3C", "RELAY.DB-wal", "Relay.Db-Journal"])(
    "REFUSED: a NEW file named %s beside the DB (a name SQLite would treat as the DB's own file); nothing is created",
    async (name) => {
      await makeSourceDb();
      for (const s of ["-wal", "-shm", "-journal"]) expect(fs.existsSync(dbPath + s), `precondition: no ${s}`).toBe(false);
      const dest = path.join(root, "db", name);
      const { exportRelayState } = await import("../src/backup.js");
      await expect(exportRelayState({ destinationPath: dest })).rejects.toThrow(/a name SQLite would treat as one of the database's own files/);
      expect(fs.existsSync(dest), "nothing created").toBe(false);
    }
  );

  it.skipIf(WIN)("REFUSED: relay.db-wal beside the DB reached through a SYMLINKED alias of the DB's directory", async () => {
    await makeSourceDb();
    const alias = path.join(root, "alias-dir");
    fs.symlinkSync(path.join(root, "db"), alias);
    const { exportRelayState } = await import("../src/backup.js");
    await expect(exportRelayState({ destinationPath: path.join(alias, "relay.db-wal") })).rejects.toThrow(/a name SQLite would treat/);
    expect(fs.existsSync(dbPath + "-wal")).toBe(false);
  });

  it("ALLOWED: relay-backup.tgz beside the DB (not a name SQLite takes)", async () => {
    await makeSourceDb();
    const { exportRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState({ destinationPath: path.join(root, "db", "relay-backup.tgz") });
    expect(fs.existsSync(exp.archive_path)).toBe(true);
  });

  it("Codex R2 (ruled, directory-INDEPENDENT): relay.db-wal is refused in ANY directory, so a parent swapped for a link to the DB's directory later cannot turn it into the DB's own file", async () => {
    await makeSourceDb();
    fs.mkdirSync(path.join(root, "elsewhere"));
    const { exportRelayState } = await import("../src/backup.js");
    await expect(exportRelayState({ destinationPath: path.join(root, "elsewhere", "relay.db-wal") })).rejects.toThrow(/starts with the database's name/);
    expect(fs.existsSync(path.join(root, "elsewhere", "relay.db-wal"))).toBe(false);
  });

  it.skipIf(WIN)("Codex R2: the SOURCE is a symlink (alias.db -> actual/relay.db): a dest named after the RESOLVED name (relay.db-journal) is refused in any directory", async () => {
    await makeSourceDb();
    const alias = path.join(root, "db", "alias.db");
    fs.symlinkSync(dbPath, alias);
    process.env.RELAY_DB_PATH = alias;
    fs.mkdirSync(path.join(root, "out"));
    const { exportRelayState } = await import("../src/backup.js");
    await expect(exportRelayState({ destinationPath: path.join(root, "out", "relay.db-journal") })).rejects.toThrow(/starts with the database's name/);
    await expect(exportRelayState({ destinationPath: path.join(root, "out", "alias.db-journal") }), "the configured name too").rejects.toThrow(/starts with the database's name/);
  });

  it("Codex R2: the DEFAULT archive name does not collide: relay backup with no --output writes", async () => {
    await makeSourceDb();
    const { exportRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState();
    expect(path.basename(exp.archive_path)).toMatch(/^relay-backup-/);
    expect(fs.existsSync(exp.archive_path)).toBe(true);
  });

  it("Codex R2, the stated cost: a CUSTOM DB basename ('data') refuses 'data-x.tgz' anywhere, with a named message suggesting another name", async () => {
    const custom = path.join(root, "db", "data");
    process.env.RELAY_DB_PATH = custom;
    const db = await import("../src/db.js");
    await db.initializeDb();
    db.closeDb();
    fs.mkdirSync(path.join(root, "out"));
    const { exportRelayState } = await import("../src/backup.js");
    await expect(exportRelayState({ destinationPath: path.join(root, "out", "data-x.tgz") })).rejects.toThrow(/starts with the database's name \(data\).*choose another name/i);
  });

  it.skipIf(WIN)("Codex R2: the SOURCE retargeted between validation and the archive's open (a symlinked DB re-pointed during the snapshot) is refused, and nothing is written", async () => {
    await makeSourceDb();
    const other = path.join(root, "db", "other.sqlite");
    fs.copyFileSync(dbPath, other);
    const alias = path.join(root, "db", "alias.db");
    fs.symlinkSync(dbPath, alias);
    process.env.RELAY_DB_PATH = alias;
    const { exportRelayState, _setExportReadHookForTests } = await import("../src/backup.js");
    _setExportReadHookForTests(() => {
      fs.unlinkSync(alias);
      fs.symlinkSync(other, alias); // now resolves to other.sqlite: a different resolved basename
    });
    const dest = path.join(root, "retarget.tar.gz");
    try {
      await expect(exportRelayState({ destinationPath: dest })).rejects.toThrow(/source changed/);
    } finally {
      _setExportReadHookForTests(null);
    }
    expect(fs.existsSync(dest), "nothing written").toBe(false);
  });

  it("the STATED COST: RELAY.DB-backup.tgz beside the DB is refused (the widen-only fold's prefix match)", async () => {
    await makeSourceDb();
    const { exportRelayState } = await import("../src/backup.js");
    await expect(exportRelayState({ destinationPath: path.join(root, "db", "RELAY.DB-backup.tgz") })).rejects.toThrow(/a name SQLite would treat/);
  });

  it("PROPERTY: the fold only ever WIDENS refusal: every name refused on its raw spelling is refused, for any DB name (incl. a combining mark NFKC would compose)", async () => {
    const { _namesASideFileForTests: refuses } = (await import("../src/backup.js")) as { _namesASideFileForTests: (dest: string, db: string) => boolean };
    const dbNames = ["relay.db", "café", "cafe\u0301", "ﬁle.db", "Straße.db", "ΣΊΣΥΦΟΣ.db", "x"];
    const suffixes = ["", "-wal", "-shm", "-journal", "-mjABC", "\u0301", "\u0301-wal", "ß", "-backup.tgz", "\u0130", "ς"];
    let checked = 0;
    for (const d of dbNames) for (const sfx of suffixes) {
      const name = d + sfx; // raw-prefixed by construction: it MUST be refused
      expect(refuses(name, d), `${JSON.stringify(name)} vs ${JSON.stringify(d)}`).toBe(true);
      checked++;
    }
    expect(checked).toBe(dbNames.length * suffixes.length);
    expect(refuses("relay-backup.tgz", "relay.db"), "twin: an unrelated name is allowed").toBe(false);
  });

  it("Codex R2 P3: the fold IS exercised: FOLDED-ONLY pairs (no raw prefix) are refused", async () => {
    const { _namesASideFileForTests: refuses } = (await import("../src/backup.js")) as { _namesASideFileForTests: (dest: string, db: string) => boolean };
    const pairs: Array<[string, string]> = [
      ["RELAY.DB-wal", "relay.db"],
      ["\uff32\uff25\uff2c\uff21\uff39.db-journal", "relay.db"], // fullwidth RELAY: NFKC
      ["STRASSE.DB-wal", "Straße.db"], // ß ↔ SS
      ["\ufb01le.db-shm", "file.db"], // the ﬁ ligature: NFKC
    ];
    for (const [dest, db] of pairs) {
      expect(dest.startsWith(db), `precondition: ${JSON.stringify(dest)} has NO raw prefix`).toBe(false);
      expect(refuses(dest, db), `${JSON.stringify(dest)} vs ${JSON.stringify(db)}`).toBe(true);
    }
  });

  it("Codex R2 P3: a FOLD-ONLY rule would LOSE the combining-mark case, which raw-OR-folded keeps", async () => {
    const { _foldForRefusalForTests: fold, _namesASideFileForTests: refuses } = (await import("../src/backup.js")) as {
      _foldForRefusalForTests: (s: string) => string;
      _namesASideFileForTests: (dest: string, db: string) => boolean;
    };
    const db = "cafe";
    const dest = "cafe\u0301-wal"; // raw-prefixed by "cafe"; NFKC composes e + U+0301 into é
    const foldOnly = fold(dest).startsWith(fold(db));
    expect(foldOnly, "a fold-only implementation would ALLOW it").toBe(false);
    expect(refuses(dest, db), "raw OR folded refuses it").toBe(true);
  });
});
