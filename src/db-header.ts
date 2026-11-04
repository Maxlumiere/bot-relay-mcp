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
 * Slice 2b-i: a NATIVE process never fs-opens a DB-family file. Closing ANY descriptor to a file drops every POSIX lock
 * the process holds on it (SQLite's documented hazard), so a native connection would lose the SHARED lock that keeps
 * another process from checkpointing and deleting the WAL under it (MEASURED in #380). The header therefore comes,
 * in order, from:
 *   (1) PRAGMA application_id on a native handle this process holds on the file (SQLite shares per-inode lock state
 *       between connections in one process: MEASURED, an outside fcntl probe stays DENIED);
 *   (3) otherwise ONE synchronous fs read of the main file's first 100 bytes, here, with no await between the check
 *       that no handle is held and the read (a non-blocking descriptor: a FIFO or a device never blocks it).
 * (2), a pre-open read-only SQLite open, was MEASURED out: it creates a -wal on every WAL file.
 * The in-process native-handle COUNT (canonical path + device/inode) is changed only by the one native construction
 * (sqlite-compat.ts openNativeDb), on a successful open and a successful close. It picks the header source and backs
 * restore's refusal; it guards no fs read. This module loads no driver itself (the ADR-0048 tripwire): the
 * construction and the in-memory probe live in the driver layer, which installs the probe here.
 *
 * The config and the env are declarations only: where they disagree with a stamped header, the header wins or the
 * open is refused, never silently mixed.
 */
import fs from "fs";
import path from "path";
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
  | { kind: "unrecognised"; reason: string };

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

/** A connection this process holds on a DB file: its canonical path, its device + inode then, and the handle. */
interface Held {
  main: string;
  key: string | null;
  /** A STRONG reference: a counted handle is never garbage-collected (and closed by its finalizer) while counted. */
  handle: { pragma(source: string, options?: { simple?: boolean }): unknown };
}
const nativeHandles = new Set<Held>();
const wasmWriters = new Set<Held>();
/** Is `p` the file `h` was opened on (its canonical path, or its device + inode then or now)? */
function sameFile(p: string, h: Held): boolean {
  if (canonical(p) === h.main) return true;
  const k = fileKey(p);
  return k !== null && (k === h.key || k === fileKey(h.main));
}
function heldIn(set: Set<Held>, p: string): Held[] {
  if (set.size === 0) return [];
  return [...set].filter((h) => sameFile(p, h));
}
const SIDECARS = ["-wal", "-shm", "-journal"] as const;
/**
 * Is `candidate` a member of the family of the DB at `dbPath` (the DB, -wal, -shm, -journal: by canonical name, or as
 * a device + inode alias of a member that exists)? Stats only, no descriptor. A suffix is never stripped from the
 * candidate (a DB may be named "x-wal").
 */
export function isDbFamilyMember(candidate: string, dbPath: string): boolean {
  const main = canonical(dbPath);
  const members = [main, ...SIDECARS.map((s) => main + s)];
  if (members.includes(canonical(candidate))) return true;
  const k = fileKey(candidate);
  return k !== null && members.some((m) => fileKey(m) === k);
}

/** How many native handles this process holds on the DB at `p` (by any name of the same file). */
export function nativeHandleCount(p: string): number {
  return heldIn(nativeHandles, p).length;
}
/** An opaque registration, for noteNativeHandleClosed / noteWasmWriterClosed. */
export type HandleToken = object;
/** The one native construction (sqlite-compat.ts openNativeDb) records a handle it opened. */
export function noteNativeHandleOpened(dbPath: string, handle: Held["handle"]): HandleToken {
  const h: Held = { main: canonical(dbPath), key: fileKey(dbPath), handle };
  nativeHandles.add(h);
  return h;
}
/** ...and its successful close. Idempotent. */
export function noteNativeHandleClosed(token: HandleToken): void {
  nativeHandles.delete(token as Held);
}
/** A writable wasm connection (the compat initializer's) records itself, so a native open of its file is refused. */
export function noteWasmWriterOpened(dbPath: string, handle: Held["handle"]): HandleToken {
  const h: Held = { main: canonical(dbPath), key: fileKey(dbPath), handle };
  wasmWriters.add(h);
  return h;
}
export function noteWasmWriterClosed(token: HandleToken): void {
  wasmWriters.delete(token as Held);
}

function classify(id: number): DriverHeader {
  if (id === 0) return { kind: "legacy" };
  if (id === RELAY_APP_ID_NATIVE) return { kind: "native" };
  if (id === RELAY_APP_ID_WASM) return { kind: "wasm" };
  return { kind: "foreign", id };
}

/**
 * The DB's driver stamp. (1) A native handle this process holds on the file → its PRAGMA application_id (no fs open);
 * (3) none → one synchronous fs read of the main file (readHeaderBytes). Never blocks.
 */
export function readDriverHeader(dbPath: string): DriverHeader {
  const held = heldIn(nativeHandles, dbPath)[0];
  if (held) return classify(Number(held.handle.pragma("application_id", { simple: true })) | 0);
  return readHeaderBytes(dbPath);
}

/**
 * Source (3), THE one fs read of a DB-family file outside the wasm driver: only when this process holds no native
 * handle on it (readDriverHeader checked, synchronously, just before). One non-blocking descriptor.
 */
function readHeaderBytes(dbPath: string): DriverHeader {
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
    return classify(buf.readInt32BE(APP_ID_OFFSET));
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

type ProbeResult = { ok: true } | { ok: false; reason: string };
/**
 * Can THIS process load the native driver? Installed by the driver layer (an in-memory open, closed at once: it never
 * touches a DB file). Run only on the native-header + wasm path, where it decides whether "run native" is a remedy
 * this process can follow.
 */
let installedProbe: (() => ProbeResult) | null = null;
let testProbe: (() => ProbeResult) | null = null;
export function _installNativeProbe(fn: () => ProbeResult): void {
  installedProbe = fn;
}
/** Test-only: replace the native-driver probe (null restores the real one). Throws outside a test runner (VITEST). */
export function _setNativeProbeForTests(fn: (() => ProbeResult) | null): void {
  if (!process.env.VITEST) throw new Error("_setNativeProbeForTests is test-only: VITEST is not set");
  testProbe = fn;
}
function nativeProbe(): ProbeResult {
  const fn = testProbe ?? installedProbe;
  if (!fn) throw new Error("internal: no native-driver probe is installed (src/sqlite-compat.ts installs it when loaded)");
  return fn();
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
 * Read the header of the DB at `dbPath`; throw (named) when it refuses `driver`, warn once when it warns. Two
 * in-process driver mixes are refused by name first: a wasm open of a file this process holds natively, and a native
 * open of a file it holds through a writable wasm connection. Another native connection is allowed (SQLite shares
 * lock state between connections in one process), and its header comes through the held one (source 1).
 */
export function assertDriverHeaderAllows(dbPath: string, driver: SqliteDriver): DriverHeader {
  if (driver === "wasm" && nativeHandleCount(dbPath) > 0) {
    throw new DbHeaderRefusedError(
      `REFUSING the wasm driver on the DB at '${dbPath}': this process already holds a native connection to that file, ` +
        `and mixing the two drivers on one file loses commits.`
    );
  }
  if (driver === "native" && heldIn(wasmWriters, dbPath).length > 0) {
    throw new DbHeaderRefusedError(
      `REFUSING the native driver on the DB at '${dbPath}': this process holds a writable wasm connection to that file, ` +
        `and mixing the two drivers on one file loses commits (the wasm write-back would drop the native handle's locks).`
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
 * A native init stamps a legacy (0) or new DB "RLYN", then checkpoints (TRUNCATE) so the stamp is in the main file
 * (where a wasm reader, and the unheld fs read, look). `before` is the header read before the open, from either
 * source: a held legacy file reads 0 through its connection and is stamped too. A DB already stamped is not written
 * at all. Never on a wasm connection, never on a read-only one, never by an export. When another connection keeps the
 * checkpoint from completing (SQLite reports it busy), the stamp stays in the WAL until a later checkpoint carries it:
 * warned, not fatal.
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
