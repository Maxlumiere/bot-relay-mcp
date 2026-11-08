// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 slice 4: `relay convert-journal`, the ONE way to move an instance's DB between the native and the wasm
 * driver, offline. Ruled order:
 * - native→wasm: the pre-checks (the single-owner lock; no opener live: a bare checkpoint, then every side file
 *   absent; one link) → journal_mode=DELETE OUTSIDE a transaction (SQLite refuses that change inside one) → a
 *   transaction stamping RLYW → the instance config's sqlite_driver "wasm" → verify after close.
 * - wasm→native: the same pre-checks (an RLYW file with any side file is an anomaly) → a transaction stamping RLYN
 *   FIRST → journal_mode=WAL → sqlite_driver "native" → verify.
 * Every intermediate state is consistent (the header decides: a DELETE-mode RLYN/0 file is native, an RLYW file is
 * wasm) and a re-run finishes what remains (idempotent): it reads the header, the journal bytes and the declaration
 * and does only the missing steps.
 *
 * This module holds the relay's ONLY native construction that may open an RLYW file (openForConversion), and only
 * while this process holds that file's single-owner lock. It is never openNativeDb's general route.
 * A legacy wasm process (an older relay) holds no lock and cannot be detected: the operator is told to close every
 * terminal and relay process first.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";
import { readDriverHeader, nativeDriverLoads, RELAY_APP_ID_NATIVE, RELAY_APP_ID_WASM, JOURNAL_BYTES_DELETE, JOURNAL_BYTES_WAL } from "./db-header.js";
import { holdOwnerForMaintenance, checkpointBeforeRestoreSwap, loadSqlJs } from "./sqlite-compat.js";
import type { OwnerLock } from "./db-owner-lock.js";
import { readSqliteDriverAt, configPathOverride, getConfigPath } from "./config.js";
import { colocatedConfigPathFor } from "./instance.js";
import { getDbPath, assertStillContained } from "./db.js";

export type ConvertTarget = "wasm" | "native";
export interface ConvertReport {
  converted: boolean;
  to: ConvertTarget;
  dbPath: string;
  configPath: string;
  /** Read back after the connection is closed. */
  header: string;
  journal: string;
  integrity: string;
  config: string;
  /** Which converter ran: the native one, or the sql.js one (a host where the native driver does not load). */
  via: "native" | "sqljs";
  /** The sql.js converter's safety copy of the original bytes (it replaces the whole file). */
  safetyCopy?: string;
}
type Step = "journal" | "stamp" | "config";
export interface ConvertOptions {
  to: ConvertTarget;
  dbPath?: string;
  /** Test-only: throw right after this step (the crash-consistency rows). */
  _failAfterForTests?: Step;
  /** Test-only (sql.js converter): run after the image is read, before the identity re-check. */
  _beforeReplaceForTests?: () => void;
  /** Test-only (sql.js converter): replaces the rename of the temp file onto the DB. */
  _renameForTests?: (from: string, to: string) => void;
}

export const CLOSE_EVERYTHING_FIRST =
  "Close every terminal and relay process that uses this instance first (an older relay running the legacy wasm mode " +
  "holds no lock, so it cannot be detected), then run this once.";

class ConvertRefusal extends Error {
  constructor(message: string) {
    super(`convert-journal refused: ${message}`);
    this.name = "ConvertRefusal";
  }
}

/**
 * The ONE sanctioned native construction of a file that may be RLYW: only under its single-owner lock (see above).
 * Like every relay DB open (ADR-0048), the path's containment is re-checked AFTER the open; a failure closes it.
 */
function openForConversion(file: string, readonly: boolean): BetterSqlite3.Database {
  const D = createRequire(import.meta.url)("better-sqlite3") as typeof BetterSqlite3;
  const db = new D(file, { readonly, fileMustExist: true });
  try {
    assertStillContained(file);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

const journalBytes = (file: string): string => {
  const b = Buffer.alloc(100);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, b, 0, 100, 0);
  } finally {
    fs.closeSync(fd);
  }
  return `${b[18]}/${b[19]}`;
};

/** Every side file beside `file`, by lstat only (none may exist while converting). */
function sideFiles(file: string): string[] {
  const out: string[] = [];
  for (const s of ["-wal", "-shm", "-journal"]) {
    try {
      out.push(`${file}${s} (${fs.lstatSync(file + s).size} bytes)`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") out.push(`${file}${s} (could not be checked: ${(err as Error).message})`);
    }
  }
  return out;
}

/**
 * The config file convert-journal writes: the DB's own instance config (its directory's config.json) when the DB has
 * an instance, else the caller's config. RELAY_CONFIG_PATH naming a DIFFERENT file from the DB's own is refused (the
 * two would then disagree).
 */
function targetConfigPath(dbPath: string): string {
  const own = colocatedConfigPathFor(dbPath);
  const pinned = configPathOverride();
  if (own !== null) {
    if (pinned !== undefined && realOrResolved(pinned) !== realOrResolved(own)) {
      throw new ConvertRefusal(
        `RELAY_CONFIG_PATH (${pinned}) names a different file from the DB's own instance config (${own}). Unset ` +
          `RELAY_CONFIG_PATH, or point it at that file, then retry. Nothing was changed.`
      );
    }
    return own;
  }
  return getConfigPath();
}
const realOrResolved = (p: string): string => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * Write sqlite_driver into the config at its CANONICAL referent (a symlinked config stays a link): every other field
 * kept, 0600, atomically (a temp file in the referent's directory, then a rename onto it).
 */
function writeDriverDeclaration(configPath: string, to: ConvertTarget): void {
  const target = fs.existsSync(configPath) ? fs.realpathSync.native(configPath) : configPath;
  let obj: Record<string, unknown> = {};
  if (fs.existsSync(target)) {
    const read = readSqliteDriverAt(target);
    if (read.unreadable !== undefined) {
      throw new ConvertRefusal(`the instance config ${target} could not be read (${read.unreadable}). Fix or remove that config.json, then retry.`);
    }
    obj = JSON.parse(fs.readFileSync(target, "utf-8")) as Record<string, unknown>;
  }
  obj.sqlite_driver = to;
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.convert.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try {
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export async function convertJournal(opts: ConvertOptions): Promise<ConvertReport> {
  const to = opts.to;
  if (to !== "wasm" && to !== "native") throw new ConvertRefusal(`--to must be "wasm" or "native" (got ${JSON.stringify(to)}).`);
  const dbPath = opts.dbPath ?? getDbPath();
  if (!fs.existsSync(dbPath)) throw new ConvertRefusal(`there is no relay database at ${dbPath}. Nothing to convert.`);
  const configPath = targetConfigPath(dbPath);
  const fail = (step: Step) => {
    if (opts._failAfterForTests === step) throw new Error(`injected failure after the ${step} step`);
  };

  const native = nativeDriverLoads();
  if (!native.ok && to === "native") {
    throw new ConvertRefusal(`converting to native needs the native driver, which does not load here (${native.reason}). Nothing was changed.`);
  }

  // The single-owner lock BEFORE any read: refused while a wasm owner is live, and kept for the whole conversion. It
  // also refuses a DB with more than one hard link (each name would be its own key).
  const lock = await holdOwnerForMaintenance(dbPath, "convert-journal");
  try {
    if (!native.ok) return await convertViaSqlJs(dbPath, configPath, lock, opts);
    const before = readDriverHeader(dbPath); // this process holds no handle on it: one fs read
    if (before.kind === "foreign" || before.kind === "unrecognised") {
      throw new ConvertRefusal(`the file at ${dbPath} is not a relay database (${before.kind}). Nothing was changed.`);
    }
    if (before.kind === "absent") throw new ConvertRefusal(`the DB at ${dbPath} is empty. Nothing to convert.`);
    if (before.kind === "wasm") {
      // An RLYW file has no side file while no owner runs (DELETE mode, a clean close): any is an anomaly.
      const sides = sideFiles(dbPath);
      if (sides.length > 0) {
        throw new ConvertRefusal(`side files are beside the wasm-owned DB: ${sides.join(", ")}. Something else has it open. Nothing was changed.`);
      }
    } else {
      // A native or legacy file: the bare checkpoint removes the side files a clean last close would; any left means
      // another process has the DB open.
      try {
        checkpointBeforeRestoreSwap(dbPath);
      } catch (err) {
        throw new ConvertRefusal(`${(err as Error).message.replace(/^restore refused: /, "")} ${CLOSE_EVERYTHING_FIRST}`);
      }
      const sides = sideFiles(dbPath);
      if (sides.length > 0) {
        throw new ConvertRefusal(
          `SQLite side files are beside the DB: ${sides.join(", ")}. Another process has it open. ${CLOSE_EVERYTHING_FIRST} Nothing was changed.`
        );
      }
    }

    let converted = false;
    if (to === "wasm") {
      if (before.kind !== "wasm") {
        if (journalBytes(dbPath) !== JOURNAL_BYTES_DELETE) {
          const db = openForConversion(dbPath, false);
          try {
            db.pragma("journal_mode = DELETE"); // outside a transaction
          } finally {
            db.close();
          }
          converted = true;
        }
        fail("journal");
        const db = openForConversion(dbPath, false);
        try {
          db.exec("BEGIN IMMEDIATE");
          db.pragma(`application_id = ${RELAY_APP_ID_WASM}`);
          db.exec("COMMIT");
        } finally {
          db.close();
        }
        converted = true;
      } else if (journalBytes(dbPath) !== JOURNAL_BYTES_DELETE) {
        // An RLYW file is always DELETE-mode; a WAL bit here is an anomaly this conversion does not guess at.
        throw new ConvertRefusal(`the wasm-owned DB at ${dbPath} is not in DELETE journal mode (${journalBytes(dbPath)}). Nothing was changed.`);
      }
      fail("stamp");
    } else {
      if (before.kind !== "native") {
        const db = openForConversion(dbPath, false);
        try {
          db.exec("BEGIN IMMEDIATE");
          db.pragma(`application_id = ${RELAY_APP_ID_NATIVE}`); // the stamp FIRST: never a W+WAL file
          db.exec("COMMIT");
        } finally {
          db.close();
        }
        converted = true;
      }
      fail("stamp");
      if (journalBytes(dbPath) !== JOURNAL_BYTES_WAL) {
        const db = openForConversion(dbPath, false);
        try {
          db.pragma("journal_mode = WAL");
        } finally {
          db.close();
        }
        converted = true;
      }
      fail("journal");
    }

    const declared = fs.existsSync(configPath) ? readSqliteDriverAt(fs.realpathSync.native(configPath)).value : undefined;
    if (declared !== to) {
      writeDriverDeclaration(configPath, to);
      converted = true;
    }
    fail("config");

    // Verify after CLOSE: the header kind and journal bytes from the file, integrity through a read-only connection,
    // and the config read back.
    const after = readDriverHeader(dbPath);
    const journal = journalBytes(dbPath);
    const v = openForConversion(dbPath, true);
    let integrity: string;
    try {
      integrity = String(v.pragma("integrity_check", { simple: true }));
    } finally {
      v.close();
    }
    const config = String(readSqliteDriverAt(fs.realpathSync.native(configPath)).value);
    const want = { header: to, journal: to === "wasm" ? JOURNAL_BYTES_DELETE : JOURNAL_BYTES_WAL, integrity: "ok", config: to };
    if (after.kind !== want.header || journal !== want.journal || integrity !== "ok" || config !== to) {
      throw new ConvertRefusal(
        `the conversion did not verify: header ${after.kind} (want ${want.header}), journal ${journal} (want ${want.journal}), ` +
          `integrity ${integrity}, config ${config}. Run it again; if this repeats, restore the safety backup.`
      );
    }
    return { converted, to, dbPath, configPath, header: after.kind, journal, integrity, config, via: "native" };
  } finally {
    lock.release();
  }
}

// --- The wasm-only converter (sql.js, native→wasm only; the slice-4 wasm-only ruling) ---

/** The ONE sql.js construction here: the image load, and the fresh verify load. */
function loadImage(SQL: any, bytes: Uint8Array): any {
  return new SQL.Database(bytes);
}
/** integrity_check and every table's row count, on a loaded image. */
function inventory(img: any): { integrity: string; counts: Record<string, number> } {
  const integrity = String(img.exec("PRAGMA integrity_check")[0]?.values[0]?.[0]);
  const counts: Record<string, number> = {};
  const tables = img.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")[0];
  for (const [name] of (tables?.values ?? []) as [string][]) {
    counts[name] = Number(img.exec(`SELECT count(*) FROM "${name.replace(/"/g, '""')}"`)[0].values[0][0]);
  }
  return { integrity, counts };
}
/** The main file's identity: size, mtime (ns) and a content hash, from one read. */
function identityOf(file: string): { id: string; bytes: Buffer } {
  const st = fs.statSync(file, { bigint: true });
  const bytes = fs.readFileSync(file);
  return { id: `${st.size}:${st.mtimeNs}:${crypto.createHash("sha256").update(bytes).digest("hex")}`, bytes };
}

/**
 * native→wasm where the native driver does not load: the whole file is REPLACED by a re-serialised sql.js image, so a
 * safety copy of the original bytes is written first. Ruled order: (the lock is held) → refuse on ANY side file (sql.js
 * would not replay a hot WAL: refused, never dropped) or a header other than N/0 (W: already converted, the config
 * checked) → identity + read + load + integrity + row counts → the safety copy → DELETE + RLYW on the image, exported →
 * identity and side files re-checked → a dotfile temp in the referent's directory, fsync, rename onto the referent,
 * directory fsync (a failed rename is refused, the temp named; never a copy over in place) → the config → verify from
 * a fresh load.
 */
async function convertViaSqlJs(dbPath: string, configPath: string, lock: OwnerLock, opts: ConvertOptions): Promise<ConvertReport> {
  const sides = sideFiles(dbPath);
  if (sides.length > 0) {
    throw new ConvertRefusal(
      `SQLite side files are beside the DB: ${sides.join(", ")}. Without the native driver the conversion cannot replay ` +
        `or checkpoint them, and it never drops them. ${CLOSE_EVERYTHING_FIRST} If one remains, checkpoint it once with ` +
        `any SQLite 3, e.g. \`sqlite3 '${dbPath}' 'PRAGMA wal_checkpoint(TRUNCATE);'\`, then retry. Nothing was changed.`
    );
  }
  const head = readDriverHeader(dbPath);
  const SQL = await loadSqlJs();
  if (head.kind === "wasm") {
    // Already converted (a run interrupted after the replace): only the declaration may remain.
    const declared = readSqliteDriverAt(realOrResolved(configPath)).value;
    if (declared !== "wasm") writeDriverDeclaration(configPath, "wasm");
    return verifySqlJs(SQL, dbPath, configPath, null, declared !== "wasm", undefined);
  }
  if (head.kind !== "native" && head.kind !== "legacy") {
    throw new ConvertRefusal(`the DB at ${dbPath} is ${head.kind}: only a native (RLYN) or legacy (unstamped) relay DB converts. Nothing was changed.`);
  }

  const first = identityOf(dbPath);
  // sql.js may ADOPT the array it is given (its in-memory file then IS that array), so the image is loaded from a COPY:
  // `first.bytes` must stay the original, byte for byte, for the safety copy (measured on sql.js 1.14.2: with the array
  // passed directly, the DELETE + RLYW edits changed it, so the "safety copy" was the edited image).
  const img = loadImage(SQL, Uint8Array.from(first.bytes));
  let image: Uint8Array;
  let counts: Record<string, number>;
  let safetyCopy: string;
  try {
    const inv = inventory(img);
    if (inv.integrity !== "ok") throw new ConvertRefusal(`the DB at ${dbPath} fails integrity_check (${inv.integrity}). Nothing was changed.`);
    counts = inv.counts;

    // The safety copy of the ORIGINAL bytes, BEFORE any edit (this path replaces the whole file).
    safetyCopy = writeSafetyCopy(dbPath, first.bytes);

    img.exec("PRAGMA journal_mode = DELETE");
    img.exec(`PRAGMA application_id = ${RELAY_APP_ID_WASM}`);
    image = img.export();
  } finally {
    img.close();
  }

  opts._beforeReplaceForTests?.();
  const now = sideFiles(dbPath);
  if (identityOf(dbPath).id !== first.id || now.length > 0) {
    throw new ConvertRefusal(
      `the DB at ${dbPath} changed while it was being converted (another process wrote it${now.length ? `; side files: ${now.join(", ")}` : ""}). ` +
        `${CLOSE_EVERYTHING_FIRST} Nothing was replaced (a safety copy is at ${safetyCopy}).`
    );
  }

  const target = fs.realpathSync.native(dbPath);
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.convert`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, image);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  lock.assertIntact(); // immediately before the rename: this acquisition, its lock file still at its name
  assertStillContained(dbPath); // ADR-0048: the path is still inside the relay's roots
  try {
    (opts._renameForTests ?? fs.renameSync)(tmp, target);
  } catch (err) {
    throw new ConvertRefusal(
      `the converted image could not be renamed onto ${target} (${(err as Error).message}). The original is unchanged; the ` +
        `converted image is at ${tmp} (remove it, or retry). Nothing was copied over in place.`
    );
  }
  if (process.platform !== "win32") {
    const dfd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  }
  writeDriverDeclaration(configPath, "wasm");
  return verifySqlJs(SQL, dbPath, configPath, counts, true, safetyCopy);
}

/** The safety copy: a NEW file (exclusive, 0600) in the backups directory beside the DB, the original bytes exactly. */
function writeSafetyCopy(dbPath: string, original: Buffer): string {
  const backups = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  const file = path.join(backups, `${path.basename(dbPath)}.pre-convert-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.bak`);
  fs.writeFileSync(file, original, { mode: 0o600, flag: "wx" });
  return file;
}

function verifySqlJs(
  SQL: any,
  dbPath: string,
  configPath: string,
  counts: Record<string, number> | null,
  converted: boolean,
  safetyCopy: string | undefined
): ConvertReport {
  const bytes = fs.readFileSync(dbPath);
  const journal = `${bytes[18]}/${bytes[19]}`;
  const id = bytes.length >= 72 ? bytes.readUInt32BE(68) : 0;
  const img = loadImage(SQL, bytes);
  let inv: { integrity: string; counts: Record<string, number> };
  try {
    inv = inventory(img);
  } finally {
    img.close();
  }
  const config = String(readSqliteDriverAt(realOrResolved(configPath)).value);
  const countsOk = counts === null || JSON.stringify(inv.counts) === JSON.stringify(counts);
  if (id !== RELAY_APP_ID_WASM || journal !== JOURNAL_BYTES_DELETE || inv.integrity !== "ok" || !countsOk || config !== "wasm") {
    throw new ConvertRefusal(
      `the conversion did not verify: application_id 0x${id.toString(16)}, journal ${journal}, integrity ${inv.integrity}, ` +
        `row counts ${countsOk ? "equal" : `${JSON.stringify(inv.counts)} (want ${JSON.stringify(counts)})`}, config ${config}.` +
        (safetyCopy ? ` The original bytes are at ${safetyCopy}.` : "")
    );
  }
  return { converted, to: "wasm", dbPath, configPath, header: "wasm", journal, integrity: inv.integrity, config, via: "sqljs", ...(safetyCopy ? { safetyCopy } : {}) };
}
