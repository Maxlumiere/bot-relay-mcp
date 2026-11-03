// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 slice 2a: the DB FILE'S HEADER decides which SQLite driver may open it.
 *
 * SQLite's header holds a 4-byte `application_id` (bytes 68-71, big-endian). The relay stamps it:
 * - "RLYN" (0x524C594E): a native relay DB. A native init stamps it, then checkpoints so the stamp is in the MAIN file
 *   (a process that reads the header with a plain file read, before any open, sees it).
 * - "RLYW" (0x524C5957): a wasm relay DB, owned by one process (the wasm single owner, a later slice).
 * - 0: a DB written before the stamp existed (legacy). The declarations (the instance config, the env) decide, as before.
 * Any other value belongs to another application, and the relay refuses to open (and stamp) it.
 *
 * The header is read BEFORE any open, with one non-blocking descriptor (a FIFO or a device at the DB path never
 * blocks the read). NEVER while this process holds a native connection to the file: closing ANY descriptor to a file
 * drops every POSIX lock the process holds on it (SQLite's documented hazard), so the connection would lose the
 * SHARED lock that keeps another process from checkpointing and deleting the WAL under it (MEASURED: an fcntl probe
 * from another process is DENIED before such a close and GRANTED after). A read on a path this process holds open
 * natively is therefore refused, and the stamp is decided from the header read before the open. A hold covers the
 * DB's whole FILE FAMILY (the main file, -wal, -shm, -journal: SQLite keeps its WAL locks in -shm), is registered where
 * the native handle is CONSTRUCTED (openNativeDb, the one place), and is released only by a close that succeeded.
 *
 * The config and the env are declarations only: where they disagree with a stamped header, the header wins or the
 * open is refused, never silently mixed.
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";
import type { CompatDatabase, SqliteDriver } from "./sqlite-compat.js";
import { log } from "./logger.js";

export const RELAY_APP_ID_NATIVE = 0x524c594e; // "RLYN"
export const RELAY_APP_ID_WASM = 0x524c5957; // "RLYW"

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
const HEADER_BYTES = 100;
const APP_ID_OFFSET = 68;

export type DriverHeader =
  /** No file, or an empty one (SQLite treats an empty file as a new database). */
  | { kind: "absent" }
  /** A SQLite database with application_id 0: written before the stamp existed. */
  | { kind: "legacy" }
  | { kind: "native" }
  | { kind: "wasm" }
  /** A SQLite database whose application_id is not the relay's. */
  | { kind: "foreign"; id: number }
  /** Not readable as a SQLite header (not a regular file, too short, no SQLite magic, or unreadable): SQLite decides. */
  | { kind: "unrecognised"; reason: string }
  /** This process already holds a native connection to the file: `verdict` is what the FIRST open read; never re-read. */
  | { kind: "held"; verdict: DriverHeader };

/** One native handle's hold on a DB's file family. */
interface Hold {
  /** The canonical path of the main file (its sidecars are this plus -wal, -shm, -journal). */
  base: string;
  /** The main file's device + inode when the handle opened (an alias of the old file after a swap still matches). */
  mainKey: string | null;
  /** The header the FIRST open of this family read (a later open in this process inherits it). */
  verdict: DriverHeader;
}
const holds = new Set<Hold>();
const SIDECARS = ["-wal", "-shm", "-journal"] as const;
/** device + inode from a stat (which opens no descriptor), or null. */
function fileKey(p: string): string | null {
  try {
    const st = fs.statSync(p, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}
/** The canonical path: the file's realpath, else its directory's realpath plus its name (a file not created yet). */
function canonical(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
    } catch {
      return path.resolve(p);
    }
  }
}
/** The main file a path belongs to: itself, or the DB whose sidecar it names. */
function familyBase(p: string): string {
  const c = canonical(p);
  for (const s of SIDECARS) if (c.endsWith(s)) return c.slice(0, -s.length);
  return c;
}
/** The hold whose family `p` belongs to (by name, or as an alias of any member that exists), or null. */
function heldBy(p: string): Hold | null {
  if (holds.size === 0) return null;
  const base = familyBase(p);
  const k = fileKey(p);
  for (const h of holds) {
    if (h.base === base) return h;
    if (k === null) continue;
    if (k === h.mainKey || k === fileKey(h.base)) return h;
    for (const s of SIDECARS) if (fileKey(h.base + s) === k) return h;
  }
  return null;
}
/** How many native handles this process holds on the family of `p`. */
export function nativeHoldCount(p: string): number {
  if (holds.size === 0) return 0;
  const first = heldBy(p);
  if (!first) return 0;
  let n = 0;
  for (const h of holds) if (h.base === first.base) n++;
  return n;
}

/**
 * THE one construction of a native handle on a relay DB: opens it, registers its hold, and releases the hold only when
 * a close actually closed it (better-sqlite3 refuses to close a busy connection, and that handle stays open and held).
 * `verdict` is the header read before the open (a "held" verdict passes on the first open's).
 */
export function openNativeDb(dbPath: string, options: BetterSqlite3.Options, verdict: DriverHeader): BetterSqlite3.Database {
  const Database = createRequire(import.meta.url)("better-sqlite3") as typeof BetterSqlite3;
  const db = new Database(dbPath, options);
  const hold: Hold = {
    base: familyBase(dbPath),
    mainKey: fileKey(dbPath),
    verdict: verdict.kind === "held" ? verdict.verdict : verdict,
  };
  holds.add(hold);
  const close = db.close.bind(db);
  db.close = () => {
    try {
      return close();
    } finally {
      if (!db.open) holds.delete(hold);
    }
  };
  return db;
}

/**
 * Throw when this process holds a native connection to the family of `p` (the DB, a sidecar, or an alias of one): an
 * fs open of it here, and the close that follows, would drop that connection's POSIX locks.
 */
export function assertNotHeldNatively(p: string, doing: string): void {
  if (heldBy(p)) {
    throw new Error(
      `internal: refusing to ${doing} '${p}' through a new descriptor while this process holds a native ` +
        `SQLite connection to that file: closing that descriptor would drop the connection's POSIX locks.`
    );
  }
}

/**
 * Read the driver stamp from the main file of the DB at `dbPath`, before any open. Never blocks. Throws only when this
 * process holds a native connection to that file (see the module comment): that is a bug in the caller, never a
 * verdict about the file.
 */
export function readDriverHeader(dbPath: string): DriverHeader {
  assertNotHeldNatively(dbPath, "read the header of");
  let fd: number;
  try {
    fd = fs.openSync(dbPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "unrecognised", reason: code ?? (err as Error).message };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { kind: "unrecognised", reason: "not a regular file" };
    if (st.size === 0) return { kind: "absent" };
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
    if (n < HEADER_BYTES || !buf.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
      return { kind: "unrecognised", reason: "no SQLite header" };
    }
    const id = buf.readInt32BE(APP_ID_OFFSET);
    if (id === 0) return { kind: "legacy" };
    if (id === RELAY_APP_ID_NATIVE) return { kind: "native" };
    if (id === RELAY_APP_ID_WASM) return { kind: "wasm" };
    return { kind: "foreign", id };
  } catch (err) {
    return { kind: "unrecognised", reason: (err as NodeJS.ErrnoException).code ?? (err as Error).message };
  } finally {
    fs.closeSync(fd);
  }
}

export class DbHeaderRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbHeaderRefusedError";
  }
}

/**
 * Can THIS process load the native driver? An in-memory open, closed at once: it never touches a DB file. Run only on
 * the native-header + wasm path, where it decides whether "run native" is a remedy this process can follow.
 */
function nativeDriverLoads(): { ok: true } | { ok: false; reason: string } {
  try {
    const Database = createRequire(import.meta.url)("better-sqlite3");
    new Database(":memory:").close();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message.split("\n")[0] };
  }
}
let nativeProbe: () => { ok: true } | { ok: false; reason: string } = nativeDriverLoads;
/** Test-only: replace the native-driver probe (null restores the real one). Throws outside a test runner (VITEST). */
export function _setNativeProbeForTests(fn: (() => { ok: true } | { ok: false; reason: string }) | null): void {
  if (!process.env.VITEST) throw new Error("_setNativeProbeForTests is test-only: VITEST is not set");
  nativeProbe = fn ?? nativeDriverLoads;
}

export type HeaderVerdict = { refuse: string } | { warn: string } | null;

/** What the header of the DB at `dbPath` says about an open with `driver`: refuse it, warn about it, or allow it. */
export function driverHeaderVerdict(dbPath: string, header: DriverHeader, driver: SqliteDriver): HeaderVerdict {
  switch (header.kind) {
    case "foreign":
      return {
        refuse:
          `REFUSING the DB at '${dbPath}': its SQLite application_id is 0x${(header.id >>> 0).toString(16).padStart(8, "0")}, ` +
          `which is not the relay's, so the file belongs to another application. The relay neither opens nor stamps it. ` +
          `Point RELAY_DB_PATH (or the instance) at the relay's own database.`,
      };
    case "native": {
      if (driver === "native") return null;
      // The refusal names a remedy ("run native"), so it is made only where that remedy is real: native loads here.
      // Where it cannot (the case the wasm driver exists for), wasm proceeds as before the stamp existed, named.
      const probe = nativeProbe();
      if (probe.ok) {
        return {
          refuse:
            `REFUSING the wasm driver on the DB at '${dbPath}': its header says it is a native relay database, and mixing ` +
            `the two drivers on one file loses commits. Unset RELAY_SQLITE_DRIVER (and remove any sqlite_driver "wasm" ` +
            `from the instance's config.json) and run native: the file is native.`,
        };
      }
      return {
        warn:
          `[db] WARNING: the DB at '${dbPath}' is stamped native, but the native driver cannot load in this process ` +
          `(${probe.reason}), so the wasm driver opens it, as before the stamp existed. AT RISK: another install with a ` +
          `working native driver writing this same file at the same time loses commits (the two drivers must never ` +
          `share a file). Run only wasm processes on it; a later release adds \`relay db convert-journal\` to convert it.`,
      };
    }
    case "wasm":
      // Slice 2a: nothing in this release creates a wasm-stamped DB, and this release has no wasm single owner, so
      // it refuses the file with EITHER driver (a native open would bypass the owner; a wasm open would race it).
      return {
        refuse:
          `REFUSING the DB at '${dbPath}': its header says it is owned by the wasm driver's single owner, which a later ` +
          `relay release provides and this one does not. Neither driver may open it here: run the relay release that ` +
          `created it.`,
      };
    default:
      return null;
  }
}

const warnedPaths = new Set<string>();
/** Test-only: forget which DBs this process already warned about. */
export function _resetHeaderWarningsForTests(): void {
  warnedPaths.clear();
}

/**
 * Read the header of the DB at `dbPath`; throw (named) when it refuses `driver`, warn once when it warns. When this
 * process already holds a native connection to the file, the header was judged when that connection opened and is
 * NOT re-read (that would drop the connection's locks): another native connection is allowed (SQLite shares lock
 * state between connections in one process), and a wasm one is a driver mix, refused by name.
 */
export function assertDriverHeaderAllows(dbPath: string, driver: SqliteDriver): DriverHeader {
  const held = heldBy(dbPath);
  if (held) {
    if (driver === "native") return { kind: "held", verdict: held.verdict };
    throw new DbHeaderRefusedError(
      `REFUSING the wasm driver on the DB at '${dbPath}': this process already holds a native connection to that file, ` +
        `and mixing the two drivers on one file loses commits.`
    );
  }
  const header = readDriverHeader(dbPath);
  const verdict = driverHeaderVerdict(dbPath, header, driver);
  if (verdict && "refuse" in verdict) throw new DbHeaderRefusedError(verdict.refuse);
  if (verdict && "warn" in verdict && !warnedPaths.has(dbPath)) {
    warnedPaths.add(dbPath);
    log.warn(verdict.warn);
  }
  return header;
}

/**
 * A native init stamps a legacy (0) or new DB "RLYN", then checkpoints (TRUNCATE) so the stamp is in the main file.
 * `before` is the header read BEFORE the open (or, for a file this process already held, the first open's): the file
 * is never read again here, since this process now holds a native connection to it (see the module comment). A DB
 * stamped before the open is not written at all. Never on a
 * wasm connection, never on a read-only one, never by an export. When another connection keeps the checkpoint from
 * completing (SQLite reports it busy), the stamp stays in the WAL until a later checkpoint carries it: warned, not fatal.
 */
export function stampNativeHeader(db: CompatDatabase, dbPath: string, before: DriverHeader): void {
  const was = before.kind === "held" ? before.verdict : before;
  if (was.kind !== "legacy" && was.kind !== "absent") return;
  db.pragma(`application_id = ${RELAY_APP_ID_NATIVE}`);
  const rows = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy?: number }> | undefined;
  const landed = !(Array.isArray(rows) && rows[0] && rows[0].busy !== 0);
  if (landed) {
    // Every hold on this family now knows the file is native (a later open in this process does not stamp again).
    const base = familyBase(dbPath);
    for (const h of holds) if (h.base === base) h.verdict = { kind: "native" };
  } else {
    log.warn(
      `[db] stamped the DB at '${dbPath}' as native, but the stamp is not in its main file yet (another connection ` +
        `kept the checkpoint from completing). A later checkpoint carries it; until then its header reads as legacy.`
    );
  }
}
