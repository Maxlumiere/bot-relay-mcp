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
      const rows = (r[0]?.values ?? []).map((v) => JSON.stringify(v)).sort();
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
  it("a WAL-mode DB (header bytes 18-19 = 2) is REFUSED by name, before any read; the source is untouched", async () => {
    await makeSourceDb();
    expect(headerMode(dbPath), "precondition: the relay made a WAL DB").toBe("wal");
    for (const s of ["-wal", "-shm"]) expect(fs.existsSync(dbPath + s), `precondition: no ${s}`).toBe(false);
    const before = statOf(dbPath);
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const { exportRelayState } = await import("../src/backup.js");
    await expect(exportRelayState({ destinationPath: path.join(root, "w.tar.gz") })).rejects.toThrow(/WAL mode/);
    expect(statOf(dbPath)).toEqual(before);
  });

  it.each(["-wal", "-shm"])("a rollback-journal DB with a %s file beside it (even empty) is REFUSED by name; the source is untouched", async (side) => {
    await makeSourceDb();
    await toRollbackJournal();
    expect(headerMode(dbPath), "precondition: a rollback-journal header").toBe("rollback");
    fs.writeFileSync(dbPath + side, "");
    const before = statOf(dbPath);
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const { exportRelayState } = await import("../src/backup.js");
    await expect(exportRelayState({ destinationPath: path.join(root, "s.tar.gz") })).rejects.toThrow(new RegExp(`${side}`));
    expect(statOf(dbPath)).toEqual(before);
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
