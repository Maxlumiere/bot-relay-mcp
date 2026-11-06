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

/** A connection (or a wasm claim) this process holds on a DB file: its canonical path, device + inode then, handle. */
interface Held {
  main: string;
  key: string | null;
  /** A STRONG reference: a counted handle is never garbage-collected (and closed by its finalizer) while counted. */
  handle: { pragma(source: string, options?: { simple?: boolean }): unknown } | null;
}
/**
 * The registry lives on globalThis (one per process), so every copy of this module (a test's vi.resetModules(), a
 * second import path) registers and reads the SAME handles.
 */
const REGISTRY = Symbol.for("bot-relay.inv-db-01.handles");
const registry: { native: Set<Held>; wasm: Set<Held> } = ((globalThis as Record<symbol, unknown>)[REGISTRY] ??= {
  native: new Set<Held>(),
  wasm: new Set<Held>(),
}) as { native: Set<Held>; wasm: Set<Held> };
const SIDECARS = ["-wal", "-shm", "-journal"] as const;
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
/** Is `p` a SIDE FILE (-wal / -shm / -journal) of `h`'s DB: by the name SQLite appends, or as an alias of one? */
function sideFileOf(p: string, h: Held): boolean {
  const c = canonical(p);
  const k = fileKey(p);
  return SIDECARS.some((s) => c === h.main + s || (k !== null && fileKey(h.main + s) === k));
}
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
/** A held handle that cannot run a statement now: better-sqlite3's "busy executing a query", or SQLITE_BUSY. */
function isBusy(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "SQLITE_BUSY" || /busy executing a query/i.test(String(e?.message ?? ""));
}
/**
 * Is `p` a member of the family of any DB this process has CLAIMED: held natively, or with a wasm use recorded (the
 * DB itself, or one of its side files, by name or by identity)? For a native construction outside openNativeDb (the
 * doorbell's lock DB), which must never open such a file.
 */
export function isInClaimedFamily(p: string): boolean {
  if (registry.native.size === 0 && registry.wasm.size === 0) return false;
  return [...registry.native, ...registry.wasm].some((h) => sameFile(p, h) || sideFileOf(p, h));
}

/** Is `p` a member of the family of ANY DB this process holds natively (the DB itself, or one of its side files)? */
export function isInHeldNativeFamily(p: string): boolean {
  if (registry.native.size === 0) return false;
  return [...registry.native].some((h) => sameFile(p, h) || sideFileOf(p, h));
}

/** How many native handles this process holds on the DB at `p` (by any name of the same file). */
export function nativeHandleCount(p: string): number {
  return heldIn(registry.native, p).length;
}
/** An opaque registration, for noteNativeHandleClosed / endWasmUse. */
export type HandleToken = object;
/** The one native construction (sqlite-compat.ts openNativeDb) records a handle it opened. */
export function noteNativeHandleOpened(dbPath: string, handle: NonNullable<Held["handle"]>): HandleToken {
  const h: Held = { main: canonical(dbPath), key: fileKey(dbPath), handle };
  registry.native.add(h);
  return h;
}
/** ...and its successful close. Idempotent. */
export function noteNativeHandleClosed(token: HandleToken): void {
  registry.native.delete(token as Held);
}
/**
 * A wasm use of a file: a writable wasm connection, or a wasm init or cold export still between its awaits. While it
 * is recorded, a native open of that file in this process is refused (a wasm read or write-back would drop the
 * native handle's locks). Recorded BEFORE the first await; ended once its last fs operation is done (or it failed).
 */
export function beginWasmUse(dbPath: string): HandleToken {
  const h: Held = { main: canonical(dbPath), key: fileKey(dbPath), handle: null };
  registry.wasm.add(h);
  return h;
}
export function endWasmUse(token: HandleToken): void {
  registry.wasm.delete(token as Held);
}
/** A wasm use of `dbPath` is recorded in this process. */
export function wasmUseRecorded(dbPath: string): boolean {
  return heldIn(registry.wasm, dbPath).length > 0;
}
export const WASM_USE_REFUSAL = (dbPath: string) =>
  `REFUSING the native driver on the DB at '${dbPath}': a wasm connection to that file is open, or opening, in this ` +
  `process, and mixing the two drivers on one file loses commits (a wasm read or write-back would drop the native ` +
  `handle's locks).`;
/**
 * The synchronous re-check a wasm use makes AFTER its awaits, right before its fs read: a native handle opened in
 * this process meanwhile (an opener that does not go through the header check) refuses it by name.
 */
export function assertNoNativeHandle(dbPath: string): void {
  if (nativeHandleCount(dbPath) > 0 || isInHeldNativeFamily(dbPath)) {
    throw new DbHeaderRefusedError(
      `REFUSING the wasm driver on the DB at '${dbPath}': this process opened a native connection to that file ` +
        `while the wasm open was loading, and mixing the two drivers on one file loses commits.`
    );
  }
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
  // A side file of a DB this process holds natively is never a database, and an fs read of it would drop locks.
  const owner = [...registry.native].find((h) => !sameFile(dbPath, h) && sideFileOf(dbPath, h));
  if (owner) {
    throw new DbHeaderRefusedError(
      `REFUSING '${dbPath}' as a database: it is a side file of a database this process holds natively ` +
        `('${owner.main}'), never a database itself, and opening it here would drop that connection's locks.`
    );
  }
  const held = heldIn(registry.native, dbPath);
  if (held.length > 0) {
    // Source (1): the first held handle that answers. A BUSY one (an open iterator, or SQLITE_BUSY) is skipped; when
    // every one is busy, the header cannot be read without an fs open, so the read is refused (retryable). Any other
    // failure (e.g. SQLITE_NOTADB: the file is not a database) is the answer itself and is rethrown, never "busy".
    let other: unknown = null;
    for (const h of held) {
      try {
        return classify(Number(h.handle!.pragma("application_id", { simple: true })) | 0);
      } catch (err) {
        if (!isBusy(err)) other ??= err;
      }
    }
    if (other) throw other;
    throw new DbHeaderBusyError(
      `the header of the DB at '${dbPath}' cannot be read now: every native connection this process holds on it is ` +
        `busy (an open statement), and reading the file directly would drop their locks. Close or finish the open ` +
        `statement, then retry.`
    );
  }
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

/**
 * A copy-pasteable MCP client config for the relay daemon (the wasm owner): `"type": "http"` and its URL (the port
 * from RELAY_HTTP_PORT, default 3777).
 */
export function httpClientHint(): string {
  const port = Number(process.env.RELAY_HTTP_PORT) || 3777;
  return `{ "type": "http", "url": "http://127.0.0.1:${port}/mcp" }`;
}

export class DbHeaderRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbHeaderRefusedError";
  }
}
/** The header could not be read because every held native handle is busy: retry once the open statement is done. */
export class DbHeaderBusyError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "DbHeaderBusyError";
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
      // Slice 2b-ii: an OWNED DB. A native open would bypass its single owner (and the owner's rename persist would
      // leave it on an old inode): refused, pointing at the owner. A wasm open follows the owner protocol (the lock).
      if (driver === "wasm") return null;
      return {
        refuse:
          `REFUSING the native driver on the DB at '${dbPath}': its header says it is owned by the wasm driver's single ` +
          `owner (a relay daemon). Reach it through that daemon over HTTP; an MCP client config for it: ` +
          `${httpClientHint()}. If no daemon runs, start one (the instance declares sqlite_driver "wasm").`,
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
  if (driver === "native" && wasmUseRecorded(dbPath)) throw new DbHeaderRefusedError(WASM_USE_REFUSAL(dbPath));
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
