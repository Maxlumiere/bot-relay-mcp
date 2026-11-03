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
 * natively is therefore refused, and the stamp is decided from the header read before the open. The config and the env are declarations only: where they disagree with a stamped header, the
 * header wins or the open is refused, never silently mixed.
 */
import fs from "fs";
import { createRequire } from "module";
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
  /** This process already holds a native connection to the file: judged when that one opened, never re-read. */
  | { kind: "held" };

/**
 * The DB files this process holds a native SQLite connection to, keyed by the FILE (device + inode, from a stat, which
 * opens no descriptor), so a symlink or a hard link to a held file is recognised too. The count is per open handle.
 */
const nativeOpen = new Map<string, number>();
function fileKey(p: string): string | null {
  try {
    const st = fs.statSync(p, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}
/** Record that this process opened a native connection to `dbPath`. Returns the hold, for noteNativeClosed. */
export function noteNativeOpen(dbPath: string): string | null {
  const k = fileKey(dbPath);
  if (k !== null) nativeOpen.set(k, (nativeOpen.get(k) ?? 0) + 1);
  return k;
}
/** Record that the native connection behind `hold` (from noteNativeOpen) was closed. */
export function noteNativeClosed(hold: string | null): void {
  if (hold === null) return;
  const n = (nativeOpen.get(hold) ?? 0) - 1;
  if (n > 0) nativeOpen.set(hold, n);
  else nativeOpen.delete(hold);
}
/**
 * Throw when this process holds a native connection to the file at `p` (by any name): an fs open of it here, and the
 * close that follows, would drop that connection's POSIX locks. Every fs read or write of a DB file goes through it.
 */
function heldNatively(p: string): boolean {
  if (nativeOpen.size === 0) return false;
  const k = fileKey(p);
  return k !== null && nativeOpen.has(k);
}
export function assertNotHeldNatively(p: string, doing: string): void {
  if (heldNatively(p)) {
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
/** Test-only: replace the native-driver probe (null restores the real one). */
export function _setNativeProbeForTests(fn: (() => { ok: true } | { ok: false; reason: string }) | null): void {
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
  if (heldNatively(dbPath)) {
    if (driver === "native") return { kind: "held" };
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
 * `before` is the header read BEFORE the open: the file is never read again here, since this process now holds a
 * native connection to it (see the module comment). A DB stamped before the open is not written at all. Never on a
 * wasm connection, never on a read-only one, never by an export. When another connection keeps the checkpoint from
 * completing (SQLite reports it busy), the stamp stays in the WAL until a later checkpoint carries it: warned, not fatal.
 */
export function stampNativeHeader(db: CompatDatabase, dbPath: string, before: DriverHeader): void {
  if (before.kind !== "legacy" && before.kind !== "absent") return;
  db.pragma(`application_id = ${RELAY_APP_ID_NATIVE}`);
  const rows = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy?: number }> | undefined;
  if (Array.isArray(rows) && rows[0] && rows[0].busy !== 0) {
    log.warn(
      `[db] stamped the DB at '${dbPath}' as native, but the stamp is not in its main file yet (another connection ` +
        `kept the checkpoint from completing). A later checkpoint carries it; until then its header reads as legacy.`
    );
  }
}
