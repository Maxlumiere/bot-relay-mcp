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
import { lockKey, type OwnerLock } from "./db-owner-lock.js";
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
  /** The sql.js converter's safety copy of the original bytes (written before its first header write). */
  safetyCopy?: string;
}
type Step = "journal" | "stamp" | "config";
export interface ConvertOptions {
  to: ConvertTarget;
  dbPath?: string;
  /** Test-only: throw right after this step (the crash-consistency rows). */
  _failAfterForTests?: Step;
  /** Test-only (sql.js converter): run after the image is read, before the final pre-patch check. */
  _beforeReplaceForTests?: () => void;
  /** Test-only (sql.js converter): after the final pre-patch check, immediately before the first header write. */
  _beforePatchForTests?: () => void;
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
  const db = new D(file, { readonly, fileMustExist: true, timeout: 0 }); // never wait: a busy DB is refused by name
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
 * Codex #401 R1 P1-1/P1-2: the conversion's target is PINNED once, after the lock: the DB's canonical file. Every check
 * and every write uses it, and before each step it is re-bound to the acquired lock: the path still resolves to it,
 * its lock key is the lock's own, it has one link, and the lock file is still the one taken.
 */
interface Pinned {
  dbPath: string;
  target: string;
  lock: OwnerLock;
}
function pinTarget(dbPath: string, lock: OwnerLock): Pinned {
  const p = { dbPath, target: fs.realpathSync.native(dbPath), lock };
  assertBound(p);
  return p;
}
function assertBound(p: Pinned): void {
  let now: string;
  try {
    now = fs.realpathSync.native(p.dbPath);
  } catch (err) {
    throw new ConvertRefusal(`the DB at ${p.dbPath} is gone (${(err as NodeJS.ErrnoException).code}). Nothing more was changed.`);
  }
  if (now !== p.target) {
    throw new ConvertRefusal(`the DB path ${p.dbPath} now resolves to ${now}, not to ${p.target}, the file this conversion locked. Nothing more was changed.`);
  }
  if (lockKey(p.target) !== p.lock.key) {
    throw new ConvertRefusal(`the DB file ${p.target} is no longer the one this conversion's lock was taken for. Nothing more was changed.`);
  }
  const n = fs.statSync(p.target).nlink;
  if (n > 1) {
    throw new ConvertRefusal(`the DB file ${p.target} has ${n} hard links now: another name could be converted beside this one. Remove the extra links, then retry. Nothing more was changed.`);
  }
  try {
    p.lock.assertIntact();
  } catch (err) {
    throw new ConvertRefusal(`${(err as Error).message} Nothing more was changed.`);
  }
}
/** The side files beside BOTH names of the DB (the path and its canonical file), each listed once. */
function sideFilesOf(p: Pinned): string[] {
  const names = p.dbPath === p.target ? [p.target] : [p.dbPath, p.target];
  return [...new Set(names.flatMap((n) => sideFiles(n)))];
}
/** A SQLITE_BUSY from SQLite (another connection holds a lock), as a named refusal. */
function busyRefusal(err: unknown, target: string): never {
  const code = (err as { code?: string }).code ?? "";
  if (/^SQLITE_BUSY|^SQLITE_LOCKED/.test(code) || /database is locked/i.test((err as Error).message)) {
    throw new ConvertRefusal(`the DB at ${target} is in use by another process (SQLite: ${(err as Error).message}). ${CLOSE_EVERYTHING_FIRST} Nothing was changed.`);
  }
  throw err;
}

/**
 * The config file convert-journal writes: the DB's own instance config (its directory's config.json) when the DB has
 * an instance, else the caller's config. RELAY_CONFIG_PATH naming a DIFFERENT file from the DB's own is refused (the
 * two would then disagree).
 */
function targetConfigPath(dbPath: string): string {
  const chosen = chooseConfigPath(dbPath);
  // Codex #401 R1 P2-7: a DANGLING symlink config is refused BEFORE anything changes (its link is never replaced by a
  // regular file, and its intended referent is not guessed at).
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(chosen);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink() && !fs.existsSync(chosen)) {
    throw new ConvertRefusal(
      `the instance config ${chosen} is a symlink to ${fs.readlinkSync(chosen)}, which does not exist (a dangling link). ` +
        `Restore its target or replace the link, then retry. Nothing was changed.`
    );
  }
  return chosen;
}
function chooseConfigPath(dbPath: string): string {
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
/** The canonical spelling of `p`: its realpath, or (an absent leaf) its EXISTING parent's realpath + its name (Codex #401 R1 P2-7). */
const realOrResolved = (p: string): string => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    const abs = path.resolve(p);
    try {
      return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
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
  // also refuses a DB with more than one hard link (each name would be its own key). Native openers refuse while it is
  // held (the ruling on Codex #401 R1 P1-3 (a)).
  const lock = await holdOwnerForMaintenance(dbPath, "convert-journal");
  try {
    const p = pinTarget(dbPath, lock);
    if (!native.ok) return await convertViaSqlJs(p, configPath, opts);
    const target = p.target;
    recoverHotJournal(p); // P2-8: a crashed converter's journal is rolled back by SQLite; a live writer's is refused
    const before = readDriverHeader(target); // this process holds no handle on it: one fs read
    if (before.kind === "foreign" || before.kind === "unrecognised") {
      throw new ConvertRefusal(`the file at ${dbPath} is not a relay database (${before.kind}). Nothing was changed.`);
    }
    if (before.kind === "absent") throw new ConvertRefusal(`the DB at ${dbPath} is empty. Nothing to convert.`);
    if (before.kind === "wasm") {
      // An RLYW file has no side file while no owner runs (DELETE mode, a clean close): any is an anomaly.
      const sides = sideFilesOf(p);
      if (sides.length > 0) {
        throw new ConvertRefusal(`side files are beside the wasm-owned DB: ${sides.join(", ")}. Something else has it open. Nothing was changed.`);
      }
    } else {
      // A native or legacy file: the bare checkpoint removes the side files a clean last close would; any left means
      // another process has the DB open.
      try {
        checkpointBeforeRestoreSwap(target);
      } catch (err) {
        throw new ConvertRefusal(`${(err as Error).message.replace(/^restore refused: /, "")} ${CLOSE_EVERYTHING_FIRST}`);
      }
      const sides = sideFilesOf(p);
      if (sides.length > 0) {
        throw new ConvertRefusal(
          `SQLite side files are beside the DB: ${sides.join(", ")}. Another process has it open. ${CLOSE_EVERYTHING_FIRST} Nothing was changed.`
        );
      }
    }

    /** One step on the pinned target, re-bound to the lock first; a busy DB is a named refusal. */
    const step = (fn: (db: BetterSqlite3.Database) => void): void => {
      assertBound(p);
      const db = openForConversion(target, false);
      try {
        fn(db);
      } catch (err) {
        busyRefusal(err, target);
      } finally {
        db.close();
      }
    };
    /** The stamp: BEGIN EXCLUSIVE (the ruling on P1-3 (b)): no other connection may hold even a read lock across it. */
    const stamp = (id: number) =>
      step((db) => {
        db.exec("BEGIN EXCLUSIVE");
        try {
          db.pragma(`application_id = ${id}`);
          db.exec("COMMIT");
        } catch (err) {
          if (db.inTransaction) db.exec("ROLLBACK");
          throw err;
        }
      });

    let converted = false;
    if (to === "wasm") {
      if (before.kind !== "wasm") {
        if (journalBytes(target) !== JOURNAL_BYTES_DELETE) {
          step((db) => db.pragma("journal_mode = DELETE")); // outside a transaction; leaving WAL is exclusive in SQLite
          converted = true;
        }
        fail("journal");
        stamp(RELAY_APP_ID_WASM);
        converted = true;
      } else if (journalBytes(target) !== JOURNAL_BYTES_DELETE) {
        // An RLYW file is always DELETE-mode; a WAL bit here is an anomaly this conversion does not guess at.
        throw new ConvertRefusal(`the wasm-owned DB at ${dbPath} is not in DELETE journal mode (${journalBytes(target)}). Nothing was changed.`);
      }
      fail("stamp");
    } else {
      if (before.kind !== "native") {
        stamp(RELAY_APP_ID_NATIVE); // the stamp FIRST: never a W+WAL file
        converted = true;
      }
      fail("stamp");
      if (journalBytes(target) !== JOURNAL_BYTES_WAL) {
        step((db) => db.pragma("journal_mode = WAL"));
        converted = true;
      }
      fail("journal");
    }

    assertBound(p);
    const declared = fs.existsSync(configPath) ? readSqliteDriverAt(fs.realpathSync.native(configPath)).value : undefined;
    if (declared !== to) {
      writeDriverDeclaration(configPath, to);
      converted = true;
    }
    fail("config");

    // Verify after CLOSE: the header kind and journal bytes from the file, integrity through a read-only connection,
    // and the config read back.
    assertBound(p);
    const after = readDriverHeader(target);
    const journal = journalBytes(target);
    const v = openForConversion(target, true);
    let integrity: string;
    try {
      integrity = String(v.pragma("integrity_check", { simple: true }));
    } finally {
      v.close();
    }
    const config = String(readSqliteDriverAt(fs.realpathSync.native(configPath)).value);
    const want = { header: to, journal: to === "wasm" ? JOURNAL_BYTES_DELETE : JOURNAL_BYTES_WAL, integrity: "ok", config: to };
    // A DELETE-mode (wasm) file has no side file after its last close; a WAL one legitimately has -wal/-shm after the
    // read-only verify open (it cannot remove them), so only the wasm target is checked for them.
    const leftover = to === "wasm" ? sideFilesOf(p) : [];
    if (after.kind !== want.header || journal !== want.journal || integrity !== "ok" || config !== to || leftover.length > 0) {
      throw new ConvertRefusal(
        `the conversion did not verify: header ${after.kind} (want ${want.header}), journal ${journal} (want ${want.journal}), ` +
          `integrity ${integrity}, config ${config}, side files [${leftover.join(", ")}]. Run it again; if this repeats, restore the safety backup.`
      );
    }
    return { converted, to, dbPath, configPath, header: after.kind, journal, integrity, config, via: "native" };
  } finally {
    lock.release();
  }
}

/**
 * The ruling on Codex #401 R1 P2-8: a rollback journal beside the DB is RECOVERED natively. SQLite's own hot-journal
 * test decides: a crashed converter's (or any crashed writer's) journal is hot and rolled back when the connection
 * takes its first lock; a LIVE writer's is not hot (its RESERVED lock is held), so SQLite reports BUSY: refused by name.
 * Only -journal takes this path (-wal/-shm beside an RLYW file stay anomalies, refused by the checks after it).
 */
function recoverHotJournal(p: Pinned): void {
  const journals = [p.target, p.dbPath].map((n) => `${n}-journal`).filter((j) => fs.existsSync(j));
  if (journals.length === 0) return;
  assertBound(p);
  const db = openForConversion(p.target, false);
  try {
    db.exec("BEGIN EXCLUSIVE"); // takes SHARED first: a hot journal is rolled back here; a live writer's lock is BUSY
    db.exec("ROLLBACK");
  } catch (err) {
    busyRefusal(err, p.target);
  } finally {
    db.close();
  }
  const left = [p.target, p.dbPath].map((n) => `${n}-journal`).filter((j) => fs.existsSync(j));
  if (left.length > 0) {
    throw new ConvertRefusal(`a rollback journal is still beside the DB after recovery (${left.join(", ")}). ${CLOSE_EVERYTHING_FIRST} Nothing was changed.`);
  }
}

// --- The wasm-only converter (sql.js, native→wasm only; the slice-4 wasm-only ruling) ---

/**
 * The ONE sql.js construction here: the image load, and the fresh verify load. sql.js ADOPTS the array it is given (its
 * edits change it), so it is given a COPY: the caller's bytes stay exactly what was read.
 */
function loadImage(SQL: any, bytes: Uint8Array): any {
  return new SQL.Database(Uint8Array.from(bytes));
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

/**
 * native→wasm where the native driver does not load, as ruled (Codex #401 R2 P1): the HEADER is patched in place, the
 * page data never rewritten. Order: (the lock is held) → refuse on ANY side file (sql.js would not replay a hot WAL:
 * refused, never dropped) or a header other than N/0 (W: already converted, the config checked) → a read-only sql.js
 * load: integrity + row counts + the full file's hash (H0) → the safety copy → the final pre-patch check → bytes 18-19
 * (DELETE) fsync'd → bytes 68-71 (RLYW) fsync'd → the config → verify from a fresh read-only load (every unpatched byte
 * still H0's, no side file). A foreign write in any window is a FAILURE, never overwritten.
 */
async function convertViaSqlJs(p: Pinned, configPath: string, opts: ConvertOptions): Promise<ConvertReport> {
  const { dbPath, target } = p;
  const sides = sideFilesOf(p); // Codex #401 R1 P1-1: beside the path AND its canonical file
  if (sides.some((x) => x.includes("-journal"))) {
    // The ruling on P2-8: without the native driver a rollback journal cannot be recovered here (sql.js does not).
    throw new ConvertRefusal(
      `a rollback journal is beside the DB: ${sides.join(", ")}. Without the native driver it cannot be recovered here. ` +
        `With every relay process stopped, let any SQLite 3 recover it, e.g. \`sqlite3 '${target}' 'PRAGMA integrity_check;'\` ` +
        `with every relay process stopped, then retry. Nothing was changed.`
    );
  }
  if (sides.length > 0) {
    throw new ConvertRefusal(
      `SQLite side files are beside the DB: ${sides.join(", ")}. Without the native driver the conversion cannot replay ` +
        `or checkpoint them, and it never drops them. ${CLOSE_EVERYTHING_FIRST} If one remains, checkpoint it once with ` +
        `any SQLite 3, e.g. \`sqlite3 '${target}' 'PRAGMA wal_checkpoint(TRUNCATE);'\`, then retry. Nothing was changed.`
    );
  }
  const head = readDriverHeader(target);
  const SQL = await loadSqlJs();
  if (head.kind === "wasm") {
    // Already converted (a run interrupted after the header): only the declaration may remain.
    const declared = readSqliteDriverAt(realOrResolved(configPath)).value;
    if (declared !== "wasm") writeDriverDeclaration(configPath, "wasm");
    return verifySqlJs(SQL, p, configPath, null, declared !== "wasm", undefined, null);
  }
  if (head.kind !== "native" && head.kind !== "legacy") {
    throw new ConvertRefusal(`the DB at ${dbPath} is ${head.kind}: only a native (RLYN) or legacy (unstamped) relay DB converts. Nothing was changed.`);
  }

  // Codex #401 R2 P1, as ruled: the header is PATCHED IN PLACE (no whole-file replace, no rename, no temp file), so a
  // foreign commit in any window is never overwritten: it shows as a mismatch, a FAILURE with no data lost. With no
  // side file, native→wasm changes only header fields: bytes 18-19 (2/2 → 1/1, what journal_mode=DELETE writes once no
  // WAL exists) and 68-71 (application_id), each with the change counter (24-27) stepped and version-valid-for
  // (92-95) set to it, as SQLite does (measured: the native path changes exactly 18, 19, 27, 95, then 27, 71, 95).
  assertStillContained(dbPath); // ADR-0048: the path is still inside the relay's roots, before any write
  const fd = fs.openSync(target, "r+");
  try {
    const first = identityOfFd(fd); // H0: the full file, its hash
    // `first.bytes` stays the original, byte for byte, for the safety copy: loadImage copies it (sql.js adopts arrays).
    const img = loadImage(SQL, first.bytes);
    let counts: Record<string, number>;
    try {
      const inv = inventory(img);
      if (inv.integrity !== "ok") throw new ConvertRefusal(`the DB at ${dbPath} fails integrity_check (${inv.integrity}). Nothing was changed.`);
      counts = inv.counts;
    } finally {
      img.close(); // read-only: never exported, never written back
    }
    const safetyCopy = writeSafetyCopy(target, first.bytes, "pre-convert"); // BEFORE the first header write

    opts._beforeReplaceForTests?.();
    assertBound(p); // P1-2: the same file, its lock key the lock's, one link
    const now = sideFilesOf(p);
    if (identityOfFd(fd).id !== first.id || now.length > 0) {
      throw new ConvertRefusal(
        `the DB at ${dbPath} changed while it was being converted (another process wrote it${now.length ? `; side files: ${now.join(", ")}` : ""}). ` +
          `${CLOSE_EVERYTHING_FIRST} Nothing was changed (a safety copy is at ${safetyCopy}).`
      );
    }
    opts._beforePatchForTests?.();
    const fail = (step: Step) => {
      if (opts._failAfterForTests === step) throw new Error(`injected failure after the ${step} step`);
    };
    // Step 5: DELETE mode first (W ⇒ DELETE at every crash point), then step 6: the RLYW stamp. Each is fsync'd.
    const patched = new Set<number>();
    if (first.bytes[18] !== 1 || first.bytes[19] !== 1) {
      patchHeader(fd, [[18, Buffer.from([1, 1])]], patched);
    }
    fail("journal");
    const stamp = Buffer.alloc(4);
    stamp.writeUInt32BE(RELAY_APP_ID_WASM >>> 0, 0);
    patchHeader(fd, [[68, stamp]], patched);
    fail("stamp");
    writeDriverDeclaration(configPath, "wasm");
    return verifySqlJs(SQL, p, configPath, counts, true, safetyCopy, { original: first.bytes, patched });
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write `edits` into the header of the open DB `fd` in place, with the change counter (24-27) stepped from its CURRENT
 * value and version-valid-for (92-95) set to it, as SQLite does on a commit; then fsync. Only the changed ranges are
 * written. Every offset written is recorded in `patched` (the verify compares every other byte to the original).
 */
function patchHeader(fd: number, edits: Array<[number, Buffer]>, patched: Set<number>): void {
  const cur = Buffer.alloc(4);
  fs.readSync(fd, cur, 0, 4, 24);
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE((cur.readUInt32BE(0) + 1) >>> 0, 0);
  for (const [off, bytes] of [...edits, [24, counter] as [number, Buffer], [92, counter] as [number, Buffer]]) {
    fs.writeSync(fd, bytes, 0, bytes.length, off);
    for (let i = 0; i < bytes.length; i++) patched.add(off + i);
  }
  fs.fsyncSync(fd);
}

/** The identity (size, mtime ns, content hash) and the bytes of the open file `fd`, read through it (its inode). */
function identityOfFd(fd: number): { id: string; bytes: Buffer } {
  const st = fs.fstatSync(fd, { bigint: true });
  const bytes = Buffer.alloc(Number(st.size));
  let off = 0;
  while (off < bytes.length) {
    const n = fs.readSync(fd, bytes, off, bytes.length - off, off);
    if (n === 0) break;
    off += n;
  }
  return { id: `${st.size}:${st.mtimeNs}:${crypto.createHash("sha256").update(bytes).digest("hex")}`, bytes };
}

/** The safety copy: a NEW file (exclusive, 0600) in the backups directory beside the DB, the original bytes exactly. */
function writeSafetyCopy(dbPath: string, original: Buffer, label: "pre-convert"): string {
  const backups = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  const file = path.join(backups, `${path.basename(dbPath)}.${label}-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.bak`);
  fs.writeFileSync(file, original, { mode: 0o600, flag: "wx" });
  return file;
}

function verifySqlJs(
  SQL: any,
  p: Pinned,
  configPath: string,
  counts: Record<string, number> | null,
  converted: boolean,
  safetyCopy: string | undefined,
  inPlace: { original: Buffer; patched: Set<number> } | null
): ConvertReport {
  const dbPath = p.dbPath;
  assertBound(p);
  const bytes = fs.readFileSync(p.target);
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
  // The ruled check of an in-place patch: every byte but the patched ones equals the original (H0), and no side file
  // appeared. A foreign commit during the conversion shows here, and is a FAILURE, never a success.
  let foreign = "";
  if (inPlace) {
    if (bytes.length !== inPlace.original.length) foreign = `its size changed (${inPlace.original.length} → ${bytes.length} bytes)`;
    else {
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== inPlace.original[i] && !inPlace.patched.has(i)) {
          foreign = `byte ${i} changed outside the patched header fields`;
          break;
        }
      }
    }
  }
  const sides = sideFilesOf(p);
  if (foreign || sides.length > 0) {
    throw new ConvertRefusal(
      `FAILED: another process wrote the DB while it was being converted (${foreign || `side files: ${sides.join(", ")}`}). ` +
        `Its write is in the file: nothing was overwritten, but the DB is now stamped for the wasm driver and holds that ` +
        `write. Stop every relay process; then keep it as it is (\`relay convert-journal --to wasm\` again verifies it), or ` +
        `restore the pre-conversion bytes from ${safetyCopy} (they lack that write).`
    );
  }
  if (id !== RELAY_APP_ID_WASM || journal !== JOURNAL_BYTES_DELETE || inv.integrity !== "ok" || !countsOk || config !== "wasm") {
    throw new ConvertRefusal(
      `the conversion did not verify: application_id 0x${id.toString(16)}, journal ${journal}, integrity ${inv.integrity}, ` +
        `row counts ${countsOk ? "equal" : `${JSON.stringify(inv.counts)} (want ${JSON.stringify(counts)})`}, config ${config}.` +
        (safetyCopy ? ` The original bytes are at ${safetyCopy}.` : "")
    );
  }
  return { converted, to: "wasm", dbPath, configPath, header: "wasm", journal, integrity: inv.integrity, config, via: "sqljs", ...(safetyCopy ? { safetyCopy } : {}) };
}
