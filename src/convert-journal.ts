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
    // Already converted (a run interrupted after the replace): only the declaration may remain.
    const declared = readSqliteDriverAt(realOrResolved(configPath)).value;
    if (declared !== "wasm") writeDriverDeclaration(configPath, "wasm");
    return verifySqlJs(SQL, p, configPath, null, declared !== "wasm", undefined);
  }
  if (head.kind !== "native" && head.kind !== "legacy") {
    throw new ConvertRefusal(`the DB at ${dbPath} is ${head.kind}: only a native (RLYN) or legacy (unstamped) relay DB converts. Nothing was changed.`);
  }

  // The ruling on P1-3 (d): an fd on the ORIGINAL inode is kept through the rename, so a write that lands on it after
  // every check (an idle native handle opened before the conversion) is seen afterwards, never reported as a success.
  let orig: number | null = fs.openSync(target, "r");
  const closeOrig = () => {
    if (orig !== null) fs.closeSync(orig);
    orig = null;
  };
  try {
    const first = identityOfFd(orig!);
    // `first.bytes` must stay the original, byte for byte, for the safety copy: loadImage copies it (measured on sql.js
    // 1.14.2: with the array passed directly, the DELETE + RLYW edits changed it, so the "safety copy" was the edited image).
    const img = loadImage(SQL, first.bytes);
    let image: Uint8Array;
    let counts: Record<string, number>;
    let safetyCopy: string;
    try {
      const inv = inventory(img);
      if (inv.integrity !== "ok") throw new ConvertRefusal(`the DB at ${dbPath} fails integrity_check (${inv.integrity}). Nothing was changed.`);
      counts = inv.counts;

      // The safety copy of the ORIGINAL bytes, BEFORE any edit (this path replaces the whole file).
      safetyCopy = writeSafetyCopy(target, first.bytes, "pre-convert");

      img.exec("PRAGMA journal_mode = DELETE");
      img.exec(`PRAGMA application_id = ${RELAY_APP_ID_WASM}`);
      image = img.export();
    } finally {
      img.close();
    }

    opts._beforeReplaceForTests?.();
    assertBound(p); // P1-2: the same file, its lock key the lock's, one link
    const now = sideFilesOf(p);
    if (identityOfFd(orig!).id !== first.id || identityOf(target).id !== first.id || now.length > 0) {
      throw new ConvertRefusal(
        `the DB at ${dbPath} changed while it was being converted (another process wrote it${now.length ? `; side files: ${now.join(", ")}` : ""}). ` +
          `${CLOSE_EVERYTHING_FIRST} Nothing was replaced (a safety copy is at ${safetyCopy}).`
      );
    }

    const dir = path.dirname(target);
    const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.convert`);
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeSync(fd, image);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    assertBound(p); // immediately before the rename
    assertStillContained(dbPath); // ADR-0048: the path is still inside the relay's roots
    if (process.platform === "win32") {
      // Windows refuses to rename onto a file a handle is open on (EPERM, measured on #401), so there the original is
      // re-checked through the fd and the fd closed IMMEDIATELY before the rename. Stated residual: on Windows a write
      // landing in that instant, between this check and the rename, is not detected.
      if (identityOfFd(orig!).id !== first.id) {
        throw new ConvertRefusal(
          `the DB at ${dbPath} changed while it was being converted (another process wrote it). ${CLOSE_EVERYTHING_FIRST} ` +
            `Nothing was replaced (a safety copy is at ${safetyCopy}).`
        );
      }
      closeOrig();
    }
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
    // P1-3 (d): the ORIGINAL inode, re-read through the kept fd: a write that landed on it since the read is LOST from
    // the converted DB. That is a FAILURE: its bytes are saved beside the safety copy, and the remedy named.
    const late = orig === null ? first : identityOfFd(orig); // on Windows the fd was closed before the rename (above)
    if (late.id !== first.id) {
      const saved = writeSafetyCopy(target, late.bytes, "late-write");
      throw new ConvertRefusal(
        `FAILED: another process wrote the DB while it was being replaced (the original file changed after its last check), ` +
          `so the converted DB at ${target} does not hold that write. The original file as it ended is saved at ${saved} (the ` +
          `pre-conversion bytes at ${safetyCopy}). Stop every relay process, then restore the one you need (e.g. \`relay restore\` ` +
          `from a backup, or copy ${saved} over the DB and run \`relay convert-journal --to wasm\` again).`
      );
    }
    writeDriverDeclaration(configPath, "wasm");
    return verifySqlJs(SQL, p, configPath, counts, true, safetyCopy);
  } finally {
    closeOrig();
  }
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
function writeSafetyCopy(dbPath: string, original: Buffer, label: "pre-convert" | "late-write"): string {
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
  safetyCopy: string | undefined
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
  if (id !== RELAY_APP_ID_WASM || journal !== JOURNAL_BYTES_DELETE || inv.integrity !== "ok" || !countsOk || config !== "wasm") {
    throw new ConvertRefusal(
      `the conversion did not verify: application_id 0x${id.toString(16)}, journal ${journal}, integrity ${inv.integrity}, ` +
        `row counts ${countsOk ? "equal" : `${JSON.stringify(inv.counts)} (want ${JSON.stringify(counts)})`}, config ${config}.` +
        (safetyCopy ? ` The original bytes are at ${safetyCopy}.` : "")
    );
  }
  return { converted, to: "wasm", dbPath, configPath, header: "wasm", journal, integrity: inv.integrity, config, via: "sqljs", ...(safetyCopy ? { safetyCopy } : {}) };
}
