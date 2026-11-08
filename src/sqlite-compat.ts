// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SQLite compatibility adapter (v1.11).
 *
 * Wraps sql.js (WebAssembly SQLite) behind a better-sqlite3-compatible API
 * so src/db.ts queries work identically on both drivers. The native driver
 * (better-sqlite3) passes through — it already has the right API shape.
 *
 * Driver selection: RELAY_SQLITE_DRIVER=native|wasm (default: native).
 * Switch happens ONCE at startup and is immutable for the process lifetime.
 *
 * CRITICAL LIMITATION: the wasm driver is single-process only. Two processes
 * sharing the same DB file will overwrite each other's changes. Use native
 * for multi-terminal stdio setups. See docs/sqlite-wasm-driver.md.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { log } from "./logger.js";
import { checkPrivatePath } from "./approved-roots.js";
import { InvalidConfigError, instanceSqliteDriverProblem, readInstanceSqliteDriver, readSqliteDriverAt, getConfigPath } from "./config.js";
import { colocatedConfigPathFor } from "./instance.js";
import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";
import { acquireOwnerLock, assertSingleLink, canonicalReplaceTarget, holdsOwnerLock, lockKey, probeOwnerLock, OwnerLockError, type OwnerLock } from "./db-owner-lock.js";
import {
  assertDriverHeaderAllows,
  noteNativeHandleOpened,
  noteNativeHandleClosed,
  beginWasmUse,
  endWasmUse,
  wasmUseRecorded,
  assertNoNativeHandle,
  WASM_USE_REFUSAL,
  DbHeaderRefusedError,
  nativeHandleCount,
  readDriverHeader,
  driverHeaderVerdict,
  RELAY_APP_ID_WASM,
  RELAY_APP_ID_NATIVE,
  JOURNAL_BYTES_DELETE,
  httpClientHint,
  _installNativeProbe,
  type DriverHeader,
} from "./db-header.js";

// Type subset of better-sqlite3 that src/db.ts actually uses.
export interface CompatStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
  /** Rows one at a time, never all held at once (better-sqlite3's own; the wasm adapter steps sql.js). */
  iterate(...params: any[]): IterableIterator<any>;
}

export interface CompatDatabase {
  prepare(sql: string): CompatStatement;
  exec(sql: string): this;
  pragma(source: string, options?: any): any;
  transaction<T>(fn: () => T): () => T;
  close(): void;
  /**
   * #171: atomic in-memory serialization of the DB image (wasm driver). Present
   * on the wasm adapter; better-sqlite3 also exposes a compatible `serialize()`.
   * Used by `snapshotToFile` for a tear-proof backup snapshot.
   */
  serialize?(): Uint8Array;
}

export type SqliteDriver = "native" | "wasm";

/**
 * The REQUESTED driver (RELAY_SQLITE_DRIVER env). DELIBERATELY NOT EXPORTED
 * (#190/codex): its only legitimate use is driver SELECTION at init (below). The
 * env is mutable and can diverge from the live connection, so branching on it at
 * a DISPATCH site is the read-the-state-not-the-request defect (#172/#190 class).
 * Dispatch sites must import getActiveDriver() (the ACTUAL instantiated driver)
 * instead — keeping this module-private makes the wrong primitive unreachable
 * from them by construction, not by remembering to avoid it.
 */
/**
 * INV-DB-01 slices 1 and 4: the INSTANCE's driver (its config's `sqlite_driver`) comes first; an invalid value is
 * refused by name before any file is opened or created. A RELAY_SQLITE_DRIVER that contradicts an explicit declaration
 * is refused (slice 4); on a silent instance it decides. `relay convert-journal` changes a DB's driver.
 */
let driverUnreadableWarned = false;
/** Test-only: forget that this process already warned about the driver. */
export function _resetDriverWarningForTests(): void {
  driverUnreadableWarned = false;
  headerDecidesWarned = false;
}
/** What the declarations say: the driver, and whether the INSTANCE declared it (owner mode needs that). */
interface Declared {
  driver: SqliteDriver;
  /** The instance's explicit sqlite_driver, or null when the instance is silent (the default). */
  instance: SqliteDriver | null;
}
/**
 * The declarations (INV-DB-01 slices 1, 2b-ii and 4): an EXPLICIT instance sqlite_driver is the driver, and an env
 * override that contradicts it is REFUSED (slice 4). A silent instance takes the env, else native. RELAY_SQLITE_DRIVER=
 * wasm on a silent instance is a wasm declaration: the single owner (the legacy no-owner mode is retired).
 */
function declaredDriver(): Declared {
  const { value, configPath, unreadable } = readInstanceSqliteDriver();
  const problem = instanceSqliteDriverProblem(value, configPath);
  if (problem) throw new InvalidConfigError(problem);
  const instance: SqliteDriver | null = value === "wasm" ? "wasm" : value === "native" ? "native" : null;
  const raw = process.env.RELAY_SQLITE_DRIVER;
  const envDriver: SqliteDriver | null = !raw ? null : raw === "wasm" ? "wasm" : "native";
  const driver: SqliteDriver = instance ?? envDriver ?? "native";
  if (unreadable !== undefined && !driverUnreadableWarned) {
    driverUnreadableWarned = true;
    log.warn(
      `[db] could not read this instance's sqlite_driver from ${configPath} (${unreadable}); using ${driver}, as ` +
        `before this setting existed. Fix or remove that config.json.`
    );
  }
  // INV-DB-01 slice 4 (BREAKING 5.0.0): an env override that CONTRADICTS the instance's declaration is refused (it used
  // to warn, the instance winning). On a SILENT instance the env still decides, as published: instance > env > native.
  if (envDriver !== null && instance !== null && envDriver !== instance) {
    throw new InvalidConfigError(
      `RELAY_SQLITE_DRIVER=${raw} contradicts this instance's sqlite_driver "${instance}" (in ${configPath}). Remove ` +
        `(unset) RELAY_SQLITE_DRIVER: the instance's declaration is its driver. To change the driver, run \`relay ` +
        `convert-journal --to ${envDriver}\` once, with every relay process stopped.`
    );
  }
  return { driver, instance };
}
function getDriverType(): SqliteDriver {
  return declaredDriver().driver;
}

/**
 * INV-DB-01 slice 3 (Codex #391 R2, as ruled): set by EVERY relay SERVER entrypoint (src/index.ts main(): the
 * HTTP daemon AND the stdio MCP server every connector runs) before it opens its own DB. Only a server keeps
 * declaredDriver()'s warn on an unreadable config (it reads its own file, so no reader disagrees with it, and refusing
 * would turn one corrupt config.json into a fleet-wide outage). Every other native opener, every CLI verb included,
 * runs the one fail-closed predicate (nativeOpenVerdict).
 */
let instanceServer = false;
export function markInstanceServer(): void {
  instanceServer = true;
}
/**
 * The ruling on Codex #401 R1 (3), amending 2b-ii: a STDIO server may be its wasm DB's single owner when it takes the
 * owner lock (exclusion is the lock's job; the transport was only a proxy for it). Set by src/index.ts for stdio, so
 * the refusal when another process owns the DB names the single-process rule, not an HTTP daemon that may not exist.
 */
let stdioServer = false;
export function markStdioServer(): void {
  stdioServer = true;
}
/** Test-only: run as (or stop running as) an instance server. */
export function _setInstanceServerForTests(on: boolean): void {
  instanceServer = on;
}

/**
 * How a DB is reached: natively, by its wasm single OWNER, or (a READ only: a backup's or a restore's read of a file
 * it never writes) through wasm on a file no owner owns (RLYN or legacy). Slice 4 retired the legacy no-owner open.
 */
export type OpenMode = "native" | "owner" | "unowned-read";
export interface ResolvedOpen {
  driver: SqliteDriver;
  mode: OpenMode;
  header: DriverHeader;
}
let headerDecidesWarned = false;
/**
 * INV-DB-01 slice 2b-ii: the declarations, then the DB FILE'S HEADER (ruling 5aa0c030, cd11ffa7). The header is read
 * through source (1) or (3) (db-header.ts), never by a fresh fs open while a native handle is live.
 * - RLYW: OWNER mode, whatever the declarations or the env (a contradicting declaration warns);
 * - absent: wasm (the instance's or a silent instance's env) is OWNER mode: the new DB is born RLYW;
 * - legacy (0) and RLYN: native only; a wasm declaration on one is refused by name (`relay convert-journal`, slice 4);
 * - RLYN, foreign, and the in-process driver mixes: as in 2a/2b-i (refused or warned by name).
 */
export function resolveOpen(dbPath: string, purpose: "open" | "read"): ResolvedOpen {
  const d = declaredDriver();
  const peek = readDriverHeaderForDriver(dbPath, d.driver);
  if (peek.kind === "wasm") {
    if (d.driver === "native" && !headerDecidesWarned) {
      headerDecidesWarned = true;
      log.warn(
        `[db] the DB at '${dbPath}' is stamped for the wasm driver's single owner (RLYW), but the declarations say ` +
          `native: the header decides (wasm, owner mode).`
      );
    }
    assertDriverHeaderAllows(dbPath, "wasm"); // the in-process mixes (a native handle counted) are refused by name
    return { driver: "wasm", mode: "owner", header: peek };
  }
  // INV-DB-01 slice 4 (BREAKING 5.0.0): a wasm OPEN (always its single owner) of an existing native (RLYN) or legacy
  // (unstamped) DB is refused by name, whatever declared wasm: an owner never adopts a file it did not stamp, and the
  // legacy no-owner mode is retired. A READ (configuredDriver: a backup's or a restore's driver pick for a file it
  // only reads) keeps db-header's verdict, as before.
  if (purpose === "open" && d.driver === "wasm" && (peek.kind === "legacy" || peek.kind === "native")) {
    const kind = peek.kind === "native" ? "a native relay database (RLYN)" : "a legacy (unstamped) relay database";
    // The conversion works where the native driver does not load too (its sql.js converter), so the remedy is real here.
    throw new DbHeaderRefusedError(
      `REFUSING the wasm driver on the DB at '${dbPath}': its header says it is ${kind}, and a wasm owner never adopts ` +
        `a file it did not stamp. Either run native (unset RELAY_SQLITE_DRIVER and remove any sqlite_driver "wasm" from ` +
        `the instance's config.json), or convert it once, with every relay process stopped: \`relay convert-journal --to wasm\`.`
    );
  }
  if (d.driver === "native") {
    if (instanceServer) {
      // INV-DB-01 slice 3 (P2-3): the server reads its own config with declaredDriver()'s warn; a DB of ANOTHER instance
      // (its own config.json is not the caller's) is opened natively only when that instance's declaration allows it.
      const { configPath } = readInstanceSqliteDriver();
      const other = dbHomeDeclaration(dbPath, { value: undefined, configPath });
      const r = (other ? declarationRefusal(dbPath, "a native open", other) : null) ?? ownerLockedRefusal(dbPath, "a native open");
      if (r) throw new DbHeaderRefusedError(r.message);
    } else {
      // Codex #391 R2: a non-server native open (a CLI verb's initializeDb) runs the one fail-closed predicate.
      const v = nativeOpenVerdict(dbPath, "a native open (a relay CLI verb)");
      if (!v.ok) throw new DbHeaderRefusedError(v.message);
    }
  }
  const header = assertDriverHeaderAllows(dbPath, d.driver);
  if (d.driver === "native") return { driver: "native", mode: "native", header };
  // INV-DB-01 slice 4: wasm is ALWAYS its single owner. A NEW DB is created stamped for it (whether the instance or the
  // env declared wasm); an RLYN or legacy header was refused above (an owner never adopts one).
  // An RLYW header HERE (the peek above saw no file, and another process materialized its owned DB since: a birth race)
  // is owner mode too: the owner protocol then refuses this process by name while that owner holds the lock.
  if (header.kind === "absent" || header.kind === "wasm") return { driver: "wasm", mode: "owner", header };
  // A READ of an unowned file is never an owner open (no owner exists for it): db-header's verdict decided above.
  if (purpose === "read") return { driver: "wasm", mode: "unowned-read", header };
  throw new DbHeaderRefusedError(
    `REFUSING the wasm driver on the DB at '${dbPath}': its header (${header.kind}) is not one a wasm owner may open. ` +
      `Convert it once, with every relay process stopped: \`relay convert-journal --to wasm\`.`
  );
}
/**
 * INV-DB-01 slice 4 (Q5): the driver kind a restore's staged copy must carry: the instance's declaration (its
 * sqlite_driver, else RELAY_SQLITE_DRIVER on a silent instance) ?? the live DB's header kind ?? native. A live RLYW DB
 * is wasm whatever the declarations (the header decides, as in resolveOpen). A wasm declaration on a live RLYN or
 * legacy DB is refused by name (the instance could not open its own DB).
 */
export function restoreTargetDriver(srcDbPath: string): SqliteDriver {
  const d = declaredDriver(); // a contradicting env override is refused here
  const declared: SqliteDriver | null = d.instance ?? (process.env.RELAY_SQLITE_DRIVER ? d.driver : null);
  const live = fs.existsSync(srcDbPath) ? readDriverHeader(srcDbPath) : null;
  const liveKind: SqliteDriver | null =
    live === null ? null : live.kind === "wasm" ? "wasm" : live.kind === "native" || live.kind === "legacy" ? "native" : null;
  // Codex #401 R1 P2-6: symmetric. An EXPLICIT instance declaration that disagrees with the live header refuses, either
  // way. As designed: an env-only RELAY_SQLITE_DRIVER on a SILENT instance is not one over a live RLYW DB, whose header
  // decides (as in resolveOpen).
  if (liveKind === "wasm" && d.instance === "native") {
    throw new Error(
      `restore refused: this instance declares sqlite_driver "native" but its live DB at '${srcDbPath}' is wasm (RLYW): ` +
        `the two disagree, so the instance could not open its own DB. Convert the DB first (\`relay convert-journal ` +
        `--to native\`) or correct the declaration, then retry. Nothing was replaced.`
    );
  }
  if (liveKind === "wasm") return "wasm"; // the header decides
  if (declared === "wasm" && liveKind === "native") {
    throw new Error(
      `restore refused: this instance declares sqlite_driver "${declared}" but its live DB at '${srcDbPath}' is ` +
        `${live?.kind}: the two disagree, so the instance could not open its own DB. Convert the DB first ` +
        `(\`relay convert-journal --to ${declared}\`) or correct the declaration, then retry. Nothing was replaced.`
    );
  }
  return declared ?? liveKind ?? "native";
}

/**
 * INV-DB-01 slice 4 (Q5): RE-STAMP restore's PRIVATE staged copy to `kind` with the instance's own driver, so a backup
 * made before a conversion still restores. wasm: its image gets journal_mode=DELETE and the RLYW stamp (sql.js, so a
 * wasm-only install can do it); native: the RLYN stamp only. Then the header is re-validated. The staged copy lives in
 * restore's private staging directory: no other process can have it open.
 */
export async function restampStagedCopy(file: string, kind: SqliteDriver): Promise<void> {
  // Codex #401 R1 P2-5: the ORIGINAL staged header is judged FIRST: only a relay DB (legacy, RLYN or RLYW) is re-stamped.
  // A foreign or unrecognised one gets the existing refusal, never a relay stamp over it.
  const original = readDriverHeader(file);
  if (original.kind !== "legacy" && original.kind !== "native" && original.kind !== "wasm") {
    const verdict = driverHeaderVerdict(file, original, kind);
    throw new Error(
      `restore refused: the archive's database is not a relay database (${original.kind}). ` +
        (verdict && "refuse" in verdict ? verdict.refuse : `It is not the relay's.`) + ` Nothing was replaced.`
    );
  }
  const bytes = fs.readFileSync(file);
  const id = bytes.length >= 72 ? bytes.readUInt32BE(68) : 0;
  const journal = bytes.length >= 20 ? `${bytes[18]}/${bytes[19]}` : "";
  if (kind === "wasm") {
    if (id === RELAY_APP_ID_WASM && journal === JOURNAL_BYTES_DELETE) return;
    const SQL = await loadSqlJs();
    const db = new SQL.Database(Uint8Array.from(bytes)); // a copy: sql.js adopts the array it is given
    let image: Uint8Array;
    try {
      db.exec("PRAGMA journal_mode = DELETE");
      db.exec(`PRAGMA application_id = ${RELAY_APP_ID_WASM}`);
      image = db.export();
    } finally {
      db.close();
    }
    fs.writeFileSync(file, image);
  } else {
    if (id === RELAY_APP_ID_NATIVE) return;
    const db = openNativeDb(file, { fileMustExist: true }, readDriverHeader(file));
    try {
      db.exec("BEGIN IMMEDIATE");
      db.pragma(`application_id = ${RELAY_APP_ID_NATIVE}`);
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  }
  const after = fs.readFileSync(file);
  const okId = after.readUInt32BE(68) === (kind === "wasm" ? RELAY_APP_ID_WASM : RELAY_APP_ID_NATIVE);
  const okJournal = kind !== "wasm" || `${after[18]}/${after[19]}` === JOURNAL_BYTES_DELETE;
  if (!okId || !okJournal) {
    throw new Error(`restore refused: the staged copy could not be re-stamped for the ${kind} driver (header or journal bytes wrong). Nothing was replaced.`);
  }
}

/**
 * Whether the DB at `dbPath` is OWNED (stamped RLYW), for maintenance that must take the owner's lock. It only READS
 * the header (the held native handle, else one fs read when none is held): it decides no driver, so it never refuses
 * a live connection of either driver the way resolveOpen's declared-driver check would.
 */
export function isOwnedDb(dbPath: string): boolean {
  return readDriverHeader(dbPath).kind === "wasm";
}
/** One instance declaration as read from its config.json (ENOENT = no declaration; any other failure = unreadable). */
type Declaration = { value: unknown; configPath: string; unreadable?: string };
const sameConfigFile = (a: string, b: string): boolean => {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
};
/**
 * The declaration of the instance whose directory HOLDS the DB (instance.ts colocatedConfigPathFor), when it is a
 * DIFFERENT file from the caller's: a DB of one instance reached from another instance's process (RELAY_DB_PATH,
 * --db-path, RELAY_CONFIG_PATH). Null when the DB has no instance association, or the file is the caller's own.
 */
function dbHomeDeclaration(dbPath: string, caller: Declaration | null): Declaration | null {
  const own = colocatedConfigPathFor(dbPath);
  if (own === null || (caller !== null && sameConfigFile(own, caller.configPath))) return null;
  return readSqliteDriverAt(own);
}
/**
 * The caller's declaration FILE. When the caller's config path cannot be resolved, the resolver's fault is classified
 * by the typed errno of its OWN syscall (never by message text):
 * - PROVEN ABSENT (ENOENT, ENOTDIR: no instance or config can exist there, e.g. the relay home is a file) → no caller
 *   declaration (null); the DB's own instance is still consulted;
 * - anything else, including a fault with no code (an invalid instance id, an ambiguous resolution) → CANNOT JUDGE:
 *   unreadable, fail closed (an instance marker this process cannot read might name a wasm instance).
 */
function callerDeclaration(): Declaration | null {
  let configPath: string;
  try {
    configPath = getConfigPath();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return {
      value: undefined,
      configPath: "(the instance config path could not be resolved)",
      unreadable: typeof code === "string" ? `${(err as Error).message}` : `${(err as Error).message} (no errno: not provably absent)`,
    };
  }
  return readSqliteDriverAt(configPath);
}
/** Why `d` forbids a NON-OWNER native open, or null when it allows one. */
function declarationRefusal(dbPath: string, what: string, d: Declaration): { kind: "declared-wasm" | "unreadable"; message: string } | null {
  if (d.unreadable !== undefined) {
    return {
      kind: "unreadable",
      message:
        `REFUSING ${what} of the DB at '${dbPath}': the instance declaration at ${d.configPath} could not be read ` +
        `(${d.unreadable}), so whether this DB may be opened natively is unknown. Fix or remove that config.json. ` +
        `Nothing was created or opened.`,
    };
  }
  const problem = instanceSqliteDriverProblem(d.value, d.configPath);
  if (problem) return { kind: "unreadable", message: `REFUSING ${what} of the DB at '${dbPath}': ${problem} Nothing was created or opened.` };
  if (d.value === "wasm") {
    return {
      kind: "declared-wasm",
      message:
        `REFUSING ${what} of the DB at '${dbPath}': its instance declares sqlite_driver "wasm" (in ${d.configPath}), ` +
        `so the DB has ONE opener, its wasm single owner, and this native open would be a second one. Reach the owner ` +
        `over HTTP (MCP client config: ${httpClientHint()}). If this instance should be native, set sqlite_driver to ` +
        `"native" in that file. Nothing was created or opened.`,
    };
  }
  return null;
}
export type NativeOpenVerdict = { ok: true } | { ok: false; kind: "declared-wasm" | "unreadable" | "owner-locked"; message: string };
/** Why a native open must wait: ANOTHER process holds the DB's single-owner lock (a live wasm owner, or a conversion). */
function ownerLockedRefusal(dbPath: string, what: string): { kind: "owner-locked"; message: string } | null {
  const probe = probeOwnerLock(dbPath);
  if (probe.state === "free") return null;
  if (probe.state === "undecidable") {
    // Codex #401 R2, residual (b): name the actual cause (a missing flock cannot be fixed by waiting).
    return {
      kind: "owner-locked",
      message:
        `REFUSING ${what} of the DB at '${dbPath}': whether another relay process holds its single-owner lock cannot ` +
        `be checked here: ${probe.reason}. Fix that, then retry. Nothing was created or opened.`,
    };
  }
  return {
    kind: "owner-locked",
    message:
      `REFUSING ${what} of the DB at '${dbPath}': another relay process holds its single-owner lock (a wasm owner, or ` +
        `\`relay convert-journal\` running), and a native open beside it could write the file mid-conversion. Wait for ` +
        `it to finish, or stop that process, then retry. Nothing was created or opened.`,
  };
}
/**
 * INV-DB-01 slice 3, the ONE native-open predicate for every NON-OWNER native opener (the by-path openers, getDb()'s
 * fallback, a cold native export, restore's pre-swap step, and the hooks' verdict): it consults the CALLER's declaration
 * (RELAY_CONFIG_PATH or the resolved config) AND the declaration of the instance that holds the DB. A native open is
 * allowed only when neither declares wasm and neither is unreadable (widen-only: neither alone can allow). The header is
 * checked separately (assertDriverHeaderAllows). The instance's own server keeps declaredDriver()'s warn on an
 * unreadable config (it reads its own file, so no reader disagrees with it).
 */
export function nativeOpenVerdict(dbPath: string, what: string): NativeOpenVerdict {
  const caller = callerDeclaration();
  const other = dbHomeDeclaration(dbPath, caller);
  for (const d of [caller, other]) {
    if (d === null) continue;
    const r = declarationRefusal(dbPath, what, d);
    if (r) return { ok: false, ...r };
  }
  // INV-DB-01 slice 4 (the ruling on Codex #401 R1 P1-3 (a)): the owner lock also excludes native openers.
  const locked = ownerLockedRefusal(dbPath, what);
  if (locked) return { ok: false, ...locked };
  return { ok: true };
}
/**
 * INV-DB-01 slice 3: a NATIVE-ONLY opener that reaches the DB by its PATH (getDb()'s synchronous fallback, the CLI
 * verbs' raw open, a cold native export) is refused by name, BEFORE anything is created or opened, unless
 * nativeOpenVerdict allows it; then the header decides, as in 2a. Returns the header verdict for the open's stamping.
 */
export function assertNativeByPathAllowed(dbPath: string, what: string): DriverHeader {
  const v = nativeOpenVerdict(dbPath, what);
  if (!v.ok) throw new DbHeaderRefusedError(v.message);
  return assertDriverHeaderAllows(dbPath, "native");
}
/** The header, read through the same sources (and refusals) as an open with `driver` would use. */
function readDriverHeaderForDriver(dbPath: string, driver: SqliteDriver): DriverHeader {
  if (driver === "wasm" && nativeHandleCount(dbPath) > 0) return assertDriverHeaderAllows(dbPath, "wasm"); // refuses
  return readDriverHeader(dbPath);
}

// --- Native driver (better-sqlite3 passthrough) ---

const loadNative = () => createRequire(import.meta.url)("better-sqlite3") as typeof BetterSqlite3;

/**
 * INV-DB-01 slices 2a/2b-i: THE one construction of a native handle on a relay DB (the compat initializer, openReadOnly
 * and the export source, getDb()'s fallback, the raw CLI open). It is the only code that changes the in-process
 * native-handle COUNT (db-header.ts): +1 on a successful open, -1 when a close actually closed the handle
 * (better-sqlite3 refuses to close a busy connection, and that handle stays open and counted). The count keeps a
 * strong reference, so a counted handle is never garbage-collected. `_verdict` is the header read before the open.
 */
export function openNativeDb(dbPath: string, options: BetterSqlite3.Options, _verdict: DriverHeader): BetterSqlite3.Database {
  // The one construction enforces the in-process mix itself (Codex #383 R1): a wasm use of this file, open or still
  // between its awaits, refuses it by name.
  if (wasmUseRecorded(dbPath)) throw new DbHeaderRefusedError(WASM_USE_REFUSAL(dbPath));
  const db = new (loadNative())(dbPath, options);
  const token = noteNativeHandleOpened(dbPath, db);
  const close = db.close.bind(db);
  db.close = () => {
    try {
      return close();
    } finally {
      if (!db.open) noteNativeHandleClosed(token);
    }
  };
  return db;
}

/**
 * INV-DB-01 slice 3, Q2 AMENDED: restore's step right before its side-file check. The safety backup's
 * READ-ONLY open creates -wal/-shm on a WAL-mode DB and cannot remove them, so restore would refuse the very files it
 * planted. On a native (RLYN) or legacy (0) DB, when the native driver loads here: ONE bare writable connection (no
 * initializeDb, no migration, no stamp, no journal_mode change), the application_id re-checked, a TRUNCATE checkpoint
 * (refused by name when it reports busy), then close. SQLite removes the side files only when the LAST connection
 * closes, so another process's live connection still leaves them, and the absence check refuses. It writes only pages
 * already committed, after the safety backup, onto a file the swap then replaces. Run only after closeDb() and the
 * second assertNoOtherNativeHold (this process holds no handle on the file). On an owned (RLYW) DB, a foreign or
 * unreadable header, or without a native driver, it opens nothing and the absence check decides.
 */
export function checkpointBeforeRestoreSwap(dbPath: string): { ran: boolean; why?: string } {
  if (!fs.existsSync(dbPath)) return { ran: false, why: "no DB at the path" };
  // Codex #391 R1 P1-2: the same predicate as every non-owner native opener (a declared-wasm instance, or an unreadable
  // declaration, opens nothing natively here).
  const verdict = nativeOpenVerdict(dbPath, "restore's pre-swap checkpoint");
  if (!verdict.ok) return { ran: false, why: verdict.message };
  const header = readDriverHeader(dbPath); // no native handle here: source (3), one fs read
  if (header.kind !== "native" && header.kind !== "legacy") return { ran: false, why: `its header is ${header.kind}` };
  let loads = true;
  try {
    new (loadNative())(":memory:").close();
  } catch {
    loads = false;
  }
  if (!loads) return { ran: false, why: "the native driver does not load in this process" };
  const expected = header.kind === "native" ? RELAY_APP_ID_NATIVE : 0;
  const db = openNativeDb(dbPath, { fileMustExist: true }, header);
  try {
    const id = (Number(db.pragma("application_id", { simple: true })) >>> 0);
    if (id !== expected >>> 0) {
      throw new Error(
        `restore refused: the DB at '${dbPath}' changed while it was being restored (its application_id is now ` +
          `0x${id.toString(16).padStart(8, "0")}, not 0x${(expected >>> 0).toString(16).padStart(8, "0")}). Nothing was replaced.`
      );
    }
    const rows = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; log: number; checkpointed: number }>;
    const busy = rows[0]?.busy ?? 0;
    if (busy !== 0) {
      throw new Error(
        `restore refused: the DB at '${dbPath}' is in use by another process (its WAL checkpoint reported busy). Stop ` +
          `the other opener, then retry. Nothing was replaced.`
      );
    }
  } finally {
    db.close();
  }
  return { ran: true };
}

// The header check's "can native load HERE" probe: an in-memory open, closed at once (never a DB file).
function nativeLoadsHere(): { ok: true } | { ok: false; reason: string } {
  try {
    new (loadNative())(":memory:").close();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message.split("\n")[0] };
  }
}
_installNativeProbe(nativeLoadsHere);

async function createNativeDb(dbPath: string, verdict: DriverHeader): Promise<CompatDatabase> {
  return openNativeDb(dbPath, {}, verdict) as unknown as CompatDatabase; // held from construction
}

// --- Wasm driver (sql.js adapter) ---

/** SQLite's total_changes() on a raw sql.js handle: row changes since it was opened (or since its last export). */
function totalChangesOf(rawDb: any): number {
  try {
    const r = rawDb.exec("SELECT total_changes()");
    return Number(r[0]?.values?.[0]?.[0] ?? 0);
  } catch {
    return 0;
  }
}

class WasmStatement implements CompatStatement {
  constructor(private db: any, private sql: string) {}

  /** Free a statement best-effort: a dead handle's statements are already finalized, and freeing must not replace the error. */
  private static freeQuietly(stmt: any): void {
    try {
      stmt.free();
    } catch {
      /* already finalized */
    }
  }

  /** A handle whose export failed after sql.js closed it refuses every use by name (never a raw sqlite error). */
  private assertAlive(): void {
    const dead = (this.db as any).__dead;
    if (dead) throw dead;
  }

  /**
   * A run() that changed rows writes them back even when it then FAILED (a multi-row INSERT OR FAIL commits the rows
   * before the failing one). The SQL error stays the one thrown; a write-back that fails as well is logged by name.
   * The read APIs (get/all/iterate) never write back: a write-back runs sql.js's export(), which FINALIZES every other
   * statement of the handle, so a suspended iterator would break (Codex R2). A commit made through a read API (an
   * INSERT … RETURNING) goes out with the next write or at close.
   */
  private writeBackIfChanged(changesBefore: number, sqlErr: unknown): void {
    if (totalChangesOf(this.db) === changesBefore) return;
    if (sqlErr === undefined) {
      this._flush();
      return;
    }
    try {
      this._flush();
    } catch (flushErr) {
      log.warn(
        `[db-wasm] a statement failed after changing rows, and writing them back failed too (${(flushErr as Error).message}); ` +
          `they stay in memory and go out with the next successful write-back (lost if the process exits first).`
      );
    }
  }

  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint } {
    this.assertAlive();
    const before = totalChangesOf(this.db);
    const stmt = this.db.prepare(this.sql);
    try {
      if (params.length > 0) {
        stmt.bind(params);
      }
      stmt.step();
    } catch (err) {
      WasmStatement.freeQuietly(stmt);
      this.writeBackIfChanged(before, err);
      throw err;
    }
    WasmStatement.freeQuietly(stmt);
    // v1.11.1: capture lastInsertRowid BEFORE flush (which may trigger
    // Emscripten FS operations that could interfere with the db state query).
    const changes = this.db.getRowsModified();
    let lastId: number | bigint = 0;
    try {
      const stmt2 = this.db.prepare("SELECT last_insert_rowid()");
      if (stmt2.step()) {
        const row = stmt2.get();
        if (row && row.length > 0) lastId = row[0] as number;
      }
      stmt2.free();
    } catch { /* non-critical — our codebase uses uuidv4 not autoincrement */ }
    this._flush();
    return { changes, lastInsertRowid: lastId };
  }

  get(...params: any[]): any {
    this.assertAlive();
    const stmt = this.db.prepare(this.sql);
    try {
      if (params.length > 0) {
        stmt.bind(params);
      }
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return undefined;
    } finally {
      WasmStatement.freeQuietly(stmt);
    }
  }

  all(...params: any[]): any[] {
    this.assertAlive();
    const stmt = this.db.prepare(this.sql);
    try {
      if (params.length > 0) {
        stmt.bind(params);
      }
      const results: any[] = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      return results;
    } finally {
      WasmStatement.freeQuietly(stmt);
    }
  }

  /** Rows one at a time: the sql.js statement is stepped and each row yielded, never collected; freed when the loop ends or breaks. */
  *iterate(...params: any[]): IterableIterator<any> {
    this.assertAlive();
    const stmt = this.db.prepare(this.sql);
    try {
      if (params.length > 0) {
        stmt.bind(params);
      }
      for (;;) {
        // A suspended iterator resumes here: refuse by name if the handle died meanwhile (not a raw "Statement closed").
        this.assertAlive();
        if (!stmt.step()) break;
        yield stmt.getAsObject();
      }
    } finally {
      WasmStatement.freeQuietly(stmt);
    }
  }

  private _flush(): void {
    // Delegate to WasmDatabase's flush via a tag on the raw db handle.
    if (typeof (this.db as any).__flush === "function") {
      (this.db as any).__flush();
    }
  }
}

/** The wasm write-back. Never of a file this process holds natively (the write's close would drop that handle's locks). */
const persistWrite = (dbPath: string, bytes: Buffer) => {
  fs.writeFileSync(dbPath, bytes);
};
let wasmPersistWrite: (dbPath: string, bytes: Buffer) => void = persistWrite;
/** Set only by the test seam below: replaces the OWNER persist's temp-file write too (slice 4: every wasm writer is one). */
let ownerTempWriteForTests: ((file: string, bytes: Buffer) => void) | null = null;
/** Test-only: replaces the wasm write-back's file write (e.g. with one that fails, like a full disk), owner or not. */
export function _setWasmPersistWriteForTests(fn: ((dbPath: string, bytes: Buffer) => void) | null): void {
  wasmPersistWrite = fn ?? persistWrite;
  ownerTempWriteForTests = fn;
}
let wasmExport: (rawDb: any) => Uint8Array = (rawDb) => rawDb.export();
/**
 * Test-only: replaces sql.js's export() for the wasm write-back and serialize(). sql.js's export() CLOSES the database
 * before reading its in-memory file, so a test that emulates a failed export closes the raw handle and then throws.
 */
export function _setWasmExportForTests(fn: ((rawDb: any) => Uint8Array) | null): void {
  wasmExport = fn ?? ((rawDb) => rawDb.export());
}

class WasmDatabase implements CompatDatabase {
  /** Set by the writable open (createWasmDb): releases its in-process record once the handle is closed. */
  onClosed: (() => void) | null = null;
  /** INV-DB-01 2b-ii: an OWNED DB's single-owner lock (null in the legacy wasm mode); released when it is retired. */
  ownerLock: OwnerLock | null = null;
  /** The name every owner persist replaces: the caller's directory, the DB's CANONICAL basename (the lock's key). */
  canonicalPath: string | null = null;
  /** The main file's device + inode after this owner's last write: a persist onto a file replaced since is refused. */
  lastIdentity: string | null = null;
  /** Set when the owner's lock file was found removed or replaced: no later persist of this connection is attempted. */
  ownerLost = false;
  private db: any;
  private dbPath: string;
  private txDepth = 0;
  /**
   * Committed row changes not yet written back. sql.js's export() closes and reopens the database, which resets
   * SQLite's total_changes() (MEASURED), so total_changes() read just BEFORE an export is the changes since the previous
   * export: every export (a write-back's or serialize()'s) adds it, minus what a ROLLBACK that SUCCEEDED undid since,
   * and only a successful write-back clears the tally. Schema changes are not counted by total_changes().
   */
  private unwrittenChanges = 0;
  private rolledBackSinceExport = 0;
  /** Bumped by every export attempt: a rollback undid this transaction's changes only if no export ended it first. */
  private exportEpoch = 0;
  /** The committed changes a write-back that just failed left unwritten (what a refused final write-back loses). */
  private unwrittenAtFailure = 0;
  /** Set when an export failed after sql.js had closed the database: the handle is unusable from then on. */
  private dead: Error | null = null;
  private closed = false;

  constructor(rawDb: any, dbPath: string) {
    this.db = rawDb;
    this.dbPath = dbPath;
    // Attach conditional flush so WasmStatement can call it.
    // Skips actual flush when inside a transaction (depth > 0) — the
    // transaction() wrapper handles flushing at COMMIT/ROLLBACK.
    (this.db as any).__flush = () => {
      if (this.txDepth === 0) this.flush();
    };
  }

  private assertAlive(): void {
    if (this.dead) throw this.dead;
  }

  prepare(sql: string): CompatStatement {
    this.assertAlive();
    return new WasmStatement(this.db, sql);
  }

  exec(sql: string): this {
    this.assertAlive();
    const before = this.totalChanges();
    try {
      this.db.run(sql);
    } catch (err) {
      // A script can commit statements before the one that fails: write those back, and keep the SQL error.
      if (this.txDepth === 0 && this.totalChanges() !== before) {
        try {
          this.flush();
        } catch (flushErr) {
          log.warn(
            `[db-wasm] a script failed after changing rows, and writing them back failed too (${(flushErr as Error).message}); ` +
              `they stay in memory and go out with the next successful write-back (lost if the process exits first).`
          );
        }
      }
      throw err;
    }
    // v2.0 beta: respect txDepth so exec() inside a transaction doesn't flush
    // mid-way. Calling export() between DDL statements inside an open
    // transaction loses the in-memory state that hasn't yet been committed.
    if (this.txDepth === 0) this.flush();
    return this;
  }

  pragma(source: string, _options?: any): any {
    this.assertAlive();
    // Intercept WAL mode — wasm operates in-memory with write-back. WAL,
    // DELETE, and other journal modes that touch the filesystem are meaningless
    // (and may error on Emscripten's virtual FS). Simply no-op and return the
    // current mode.
    if (/journal_mode/i.test(source)) {
      log.info("[db-wasm] journal_mode pragma skipped on wasm driver (in-memory + write-back).");
      return "memory";
    }
    // busy_timeout has no effect on in-memory wasm (single-process, no locking).
    if (/busy_timeout/i.test(source)) {
      return;
    }
    try {
      const result = this.db.exec(`PRAGMA ${source}`);
      this.flush();
      if (result.length > 0 && result[0].values.length > 0) {
        return result[0].values[0][0];
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  // v1.11.1: nested transaction support via SAVEPOINT/RELEASE. The outermost
  // call uses BEGIN/COMMIT. Inner calls use SAVEPOINT sp_N / RELEASE sp_N.
  // Matches better-sqlite3's nested transaction behavior. Dual-model audit
  // (Codex/GPT) surfaced: inner BEGIN errors on SQLite ("cannot start a
  // transaction within a transaction").
  transaction<T>(fn: () => T): () => T {
    return () => {
      this.assertAlive();
      const isOutermost = this.txDepth === 0;
      const spName = `sp_${this.txDepth}`;
      // The depth counts a level only once its BEGIN/SAVEPOINT SUCCEEDED (a SAVEPOINT refused while a statement is in
      // progress used to leave the depth one too high, so nothing was written back again).
      if (isOutermost) {
        this.db.run("BEGIN TRANSACTION");
      } else {
        this.db.run(`SAVEPOINT ${spName}`);
      }
      this.txDepth++;
      const changesAtStart = isOutermost ? this.totalChanges() : 0;
      const epochAtStart = this.exportEpoch;
      let result: T;
      try {
        result = fn();
        if (isOutermost) {
          this.db.run("COMMIT");
        } else {
          this.db.run(`RELEASE ${spName}`);
        }
      } catch (err) {
        this.txDepth--;
        let rolledBack = false;
        try {
          if (isOutermost) {
            this.db.run("ROLLBACK");
          } else {
            this.db.run(`ROLLBACK TO ${spName}`);
          }
          rolledBack = true;
        } catch {
          // Transaction/savepoint may already be finalized.
        }
        // Subtract only what a ROLLBACK actually undid: it succeeded, and no export ended the transaction first (an
        // export closes and reopens sql.js's database). Otherwise subtract nothing: an overcount, never an undercount.
        if (isOutermost && rolledBack && this.exportEpoch === epochAtStart) {
          this.rolledBackSinceExport += Math.max(0, this.totalChanges() - changesAtStart);
        }
        if (this.txDepth === 0) {
          try {
            this.flush();
          } catch {
            // The rolled-back image changes nothing that was committed; the original error is the one to report.
          }
        }
        throw err;
      }
      // The write-back runs AFTER the try: a refused write-back used to fall into the catch above, decrementing txDepth a
      // second time (to -1), so no later write was written back until close. The commit stays in memory, and goes out
      // with the next successful write-back.
      this.txDepth--;
      if (this.txDepth === 0) this.flush();
      return result;
    };
  }

  /** SQLite's total_changes(): row changes made through this connection since it opened, or since its last export. */
  private totalChanges(): number {
    return totalChangesOf(this.db);
  }

  close(): void {
    if (this.closed) return;
    let first: Error | null = null;
    try {
      this.flush("close");
    } catch (err) {
      // Nothing is left to retry it: the committed changes not yet on disk are lost. Say so, loudly and by name.
      const msg =
        `wasm close: the final write-back was refused, so ${this.unwrittenAtFailure} row change(s) since the last ` +
        `successful write-back were LOST (schema changes are not counted): ${(err as Error).message}`;
      log.error(`[db-wasm] ${msg}`);
      first = new Error(msg);
    }
    // The cleanup never throws OVER the loss: its error is attached to the first one.
    try {
      this.db.close();
    } catch (cleanupErr) {
      if (first) first.message += ` (closing the handle failed too: ${(cleanupErr as Error).message})`;
      else first = cleanupErr as Error;
    } finally {
      this.retire();
    }
    if (first) throw first;
  }

  /**
   * After a close or discard, whatever the underlying close did (it may close and then throw): the handle is DEAD
   * (no further write-back or use), and its in-process wasm claim is released (Codex #383 R2), so a stranded claim
   * never refuses a legitimate native open.
   */
  private retire(): void {
    this.closed = true;
    if (!this.dead) this.dead = new Error("this wasm connection was closed: it can no longer be used");
    (this.db as any).__dead = this.dead;
    this.onClosed?.();
    this.onClosed = null;
    const lock = this.ownerLock;
    this.ownerLock = null;
    lock?.release();
  }

  /**
   * Release the handle WITHOUT flushing the in-memory image. For a refused DB
   * (ADR-0048: the path escaped the approved roots after it was opened): a
   * close() would export() and write the image THROUGH the escaped path.
   */
  discard(): void {
    if (this.closed) return;
    try {
      this.db.close();
    } finally {
      this.retire();
    }
  }

  /**
   * #171: atomic in-memory serialization — the whole DB image as bytes, produced
   * synchronously from memory with no filesystem touch. Tear-proof by
   * construction (unlike copying the write-back file, whose flush is a bare
   * non-atomic fs.writeFileSync). Backs `snapshotToFile` on the wasm driver.
   * Its export resets SQLite's change counter, so it goes through the same tally as a write-back.
   */
  serialize(): Uint8Array {
    this.assertAlive();
    return this.exportTallied();
  }

  /**
   * sql.js's export(), with the loss tally kept across its counter reset. sql.js closes SQLite BEFORE it reads the
   * in-memory file, so an export that fails can leave the handle CLOSED: then it is marked dead (every later use
   * refused by name) and the failure is named with the changes lost. Reopening from the in-memory file needs sql.js
   * internals it does not expose (a stated residual). Never a silent success.
   */
  private exportTallied(): Uint8Array {
    this.assertAlive();
    const sinceExport = Math.max(0, this.totalChanges() - this.rolledBackSinceExport);
    this.exportEpoch++;
    let data: Uint8Array;
    try {
      data = wasmExport(this.db);
    } catch (err) {
      // An export that throws may not have reset the counter: its changes join the count only here, on failure.
      this.unwrittenAtFailure = this.unwrittenChanges + sinceExport;
      let alive = true;
      try {
        this.db.exec("SELECT 1");
      } catch {
        alive = false;
      }
      if (!alive) {
        this.dead = new Error(
          `wasm DB handle is unusable: an export failed after sql.js had closed the database (${(err as Error).message}); ` +
            `${this.unwrittenAtFailure} row change(s) since the last successful write-back were LOST. Reopen the database ` +
            `(restart the relay) to continue from its file.`
        );
        (this.db as any).__dead = this.dead;
        log.error(`[db-wasm] ${this.dead.message}`);
        throw this.dead;
      }
      throw new Error(
        `wasm write-back failed: export() failed (${(err as Error).message}), so nothing was written; the change stays ` +
          `in memory and is written with the next successful write-back (it is lost if the process exits first).`
      );
    }
    this.unwrittenChanges += sinceExport;
    this.rolledBackSinceExport = 0;
    return data;
  }

  // flush propagates every failure (fail-closed): a disk write (ENOSPC, permissions) and an export alike. An export
  // error used to be swallowed as "data safe in memory", but sql.js's export() closes SQLite before reading its
  // in-memory file, so a failed export can leave the handle closed: nothing about it was safe.
  private flush(cause: "write" | "close" = "write"): void {
    void cause;
    const data = this.exportTallied();
    this.unwrittenAtFailure = this.unwrittenChanges;
    if (this.ownerLock) {
      ownerPersist(this, Buffer.from(data));
      this.unwrittenChanges = 0;
      return;
    }
    // INV-DB-01 2b-ii (Codex #385 R1 P1-1): a legacy (unowned) wasm connection NEVER writes onto an OWNED file: one an
    // owner materialized after this connection opened. Its write would replace the owner's database unlocked.
    if (readDriverHeader(this.dbPath).kind === "wasm") {
      throw new Error(
        `wasm write-back refused: the DB at ${this.dbPath} is now owned by the wasm driver's single owner (stamped RLYW ` +
          `since this legacy connection opened), so this connection does not write it. Nothing was written; reach it ` +
          `through its owner over HTTP (${httpClientHint()}).`
      );
    }
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // THIS write-to-disk failure IS propagated (disk full, permissions, etc.)
    try {
      wasmPersistWrite(this.dbPath, Buffer.from(data));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      throw new Error(
        `wasm write-back failed: could not write ${this.dbPath} (${code}). The change stays in memory and is written ` +
          `with the next successful write-back (it is lost if the process exits first); the file may be partially ` +
          `written (an in-place write is not atomic).`
      );
    }
    this.unwrittenChanges = 0;
  }
}

let persistRename: (from: string, to: string) => void = (from, to) => fs.renameSync(from, to);
/** Test-only: replaces the owner persist's rename (e.g. with one that is refused). */
export function _setPersistRenameForTests(fn: ((from: string, to: string) => void) | null): void {
  persistRename = fn ?? ((from, to) => fs.renameSync(from, to));
}
const WINDOWS_OPEN_FILE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
/** The atomic replace: Windows cannot replace a file another process holds open, so a short bounded retry, then named. */
function replaceWithRetry(tmp: string, target: string): void {
  const waits = process.platform === "win32" ? [25, 50, 100, 200] : [];
  for (let i = 0; ; i++) {
    try {
      persistRename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      const openOnWindows = process.platform === "win32" && WINDOWS_OPEN_FILE_CODES.has(code);
      if (openOnWindows && i < waits.length) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waits[i]);
        continue;
      }
      const why = openOnWindows ? "another process has the DB file open; Windows cannot replace it" : `the DB file could not be replaced (${code || (err as Error).message})`;
      throw new Error(
        `wasm persist refused: ${why}; nothing was written to ${target}. The change stays in memory and is written ` +
          `with the next successful persist (it is lost if the process exits first).`
      );
    }
  }
}
/**
 * The DB file's identity for the owner's per-persist check: more than dev+ino, which misses another writer that
 * rewrites the file IN PLACE (the same inode) and a replacement landing on a REUSED inode number (ext4 reuses a freed
 * one at once). Size and the nanosecond mtime change with any such write; the owner reads it right after its own
 * rename. NOT ctime: a metadata change is not a write, and the relay itself chmods (and, on Windows, re-ACLs) its DB
 * after every open (db.ts ensureSecureFile), which would refuse its own next persist. On a coarse-timestamp filesystem
 * (HFS+ 1 s, FAT/exFAT 2 s) a same-size in-place rewrite within the granularity is not seen.
 */
const identityFrom = (st: fs.BigIntStats): string => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;
const identityOf = (p: string): string | null => {
  try {
    return identityFrom(fs.statSync(p, { bigint: true }));
  } catch {
    return null;
  }
};
/**
 * INV-DB-01 2b-ii: an OWNED DB's persist. Only under this process's single-owner lock, never onto a hard-linked DB,
 * never onto a file another writer replaced since this owner's last write (its identity) or that is no longer
 * RLYW, and ATOMICALLY: a fresh temp file beside the DB, then renamed over it. Each refusal is named; nothing is
 * written, and the change stays in memory for the next persist.
 */
function ownerPersist(w: WasmDatabase, data: Buffer): void {
  const lock = w.ownerLock!;
  const target = w.canonicalPath!;
  if (w.ownerLost || !holdsOwnerLock(target) || lockKey(target) !== lock.key) {
    throw new OwnerLockError(
      `wasm persist refused: this process no longer holds the single-owner lock for ${target}, so another process may ` +
        `own it. Nothing was written.`
    );
  }
  assertSingleLink(target);
  if (identityOf(target) !== w.lastIdentity) {
    throw new OwnerLockError(
      `wasm persist refused: the DB file at ${target} was replaced or changed by another process since this owner's ` +
        `last write (its identity changed: inode, size or mtime), so another writer may have ` +
        `touched it. Nothing was written; stop the other writer and restart this process.`
    );
  }
  const now = readDriverHeader(target);
  if (now.kind !== "wasm") {
    throw new OwnerLockError(`wasm persist refused: the DB file at ${target} is no longer stamped RLYW (${now.kind}). Nothing was written.`);
  }
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let wrote: string;
  try {
    if (ownerTempWriteForTests) ownerTempWriteForTests(tmp, data);
    else fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    // Codex #385 R1 P1-4: the identity of the file THIS persist wrote (a rename keeps its inode, size and mtime), never
    // whatever sits at the name after the rename (another writer's replacement would be adopted as the owner's own).
    // Read after the write is closed (a filesystem may settle timestamps at close).
    wrote = identityFrom(fs.statSync(tmp, { bigint: true }));
    try {
      lock.assertIntact(); // immediately before the rename: THIS acquisition, its lock file still the file at its name
    } catch (err) {
      log.error(`[db-wasm] ${(err as Error).message}`);
      w.ownerLost = true;
      throw err;
    }
    replaceWithRetry(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  w.lastIdentity = wrote;
}

/** sql.js, loaded (a named refusal when it is not installed). */
export async function loadSqlJs(): Promise<any> {
  let initSqlJs: any;
  try {
    initSqlJs = (await import("sql.js")).default;
  } catch {
    throw new Error("sql.js is not installed. RELAY_SQLITE_DRIVER=wasm requires sql.js. Install it with: npm install sql.js");
  }
  return initSqlJs();
}

/**
 * INV-DB-01 2b-ii: open an OWNED DB as its single owner. The wasm claim first (before any await: a native open of the
 * file in this process meanwhile is refused); a NEW DB is materialized already stamped RLYW (it appears complete, by a
 * link); then the lock (another owner → a named refusal). After the lock the file must still be RLYW: a file another
 * process created first (legacy 0, RLYN, foreign) is NOT adopted: refused by name (slice 4: no legacy mode remains).
 */
async function createOwnedWasmDb(dbPath: string, header: DriverHeader): Promise<CompatDatabase> {
  const token = beginWasmUse(dbPath);
  try {
    const SQL = await loadSqlJs();
    await afterSqlJsLoadHook?.(dbPath);
    let initialBytes: Uint8Array | undefined;
    if (header.kind === "absent") {
      const fresh = new SQL.Database();
      fresh.exec(`PRAGMA application_id = ${RELAY_APP_ID_WASM}`);
      initialBytes = fresh.export();
      fresh.close();
    }
    let lock: OwnerLock;
    try {
      lock = await acquireOwnerLock(dbPath, { initialBytes, ...(containmentCheck ? { beforeCreate: containmentCheck } : {}) });
    } catch (err) {
      if (err instanceof OwnerLockError && /could not be locked/.test(err.message)) {
        // The ruling on Codex #401 R1 (3): a STDIO server may be the owner; one that cannot take the lock says so
        // without an HTTP hint (that would imply a daemon exists).
        if (stdioServer) {
          throw new OwnerLockError(
            `the DB at ${dbPath}: another relay process owns this wasm DB; wasm is single-process: close it, or run one ` +
              `HTTP daemon and point every client at it.`
          );
        }
        throw new OwnerLockError(
          `the DB at ${dbPath} is owned by another relay process (its wasm single owner), so this process does not open ` +
            `it. Reach it through that process over HTTP (an MCP client config for it: ${httpClientHint()}), or stop it.`
        );
      }
      throw err;
    }
    try {
      // ONE synchronous sequence from here: the re-checks, the read, the construction.
      const now = readDriverHeader(dbPath);
      if (now.kind !== "wasm") {
        lock.release();
        // Codex #385 R1 P1-3: ONLY a true legacy (0) file falls back to the legacy mode; anything else that appeared
        // here (a native-stamped or a foreign DB, a file gone) gets the SAME verdict as any wasm open, by name.
        const verdict = assertDriverHeaderAllows(dbPath, "wasm");
        // INV-DB-01 slice 4: the legacy no-owner mode is retired; an owner never adopts a file it did not stamp.
        throw new OwnerLockError(
          `the DB at ${dbPath} changed while its owner lock was taken (${verdict.kind}); not opened. ` +
            `If it is a legacy DB, convert it once: \`relay convert-journal --to wasm\`.`
        );
      }
      assertWasmSourceReadable(dbPath, "wasm open refused");
      try {
        assertSingleLink(dbPath); // after the lock, before the first write (and before the read)
      } catch (err) {
        if (err instanceof OwnerLockError) throw new OwnerLockError(`wasm open refused: ${err.message}`);
        throw err;
      }
      assertNoNativeHandle(dbPath);
      // Codex #385 R1 P1-4: the bytes and the identity come from ONE open file (its fstat), never a later path lookup.
      const canonical = canonicalReplaceTarget(dbPath);
      const fd = fs.openSync(canonical, "r");
      let bytes: Buffer;
      let readIdentity: string;
      try {
        readIdentity = identityFrom(fs.fstatSync(fd, { bigint: true }));
        bytes = fs.readFileSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (bytes.length < 72 || bytes.readUInt32BE(68) !== RELAY_APP_ID_WASM) {
        throw new OwnerLockError(`the DB at ${dbPath} changed while it was being opened (it is no longer stamped RLYW); not opened.`);
      }
      const w = new WasmDatabase(new SQL.Database(Uint8Array.from(bytes)), dbPath); // a copy: sql.js adopts its array
      w.ownerLock = lock;
      w.canonicalPath = canonical;
      w.lastIdentity = readIdentity;
      w.onClosed = () => endWasmUse(token);
      return w;
    } catch (err) {
      lock.release();
      throw err;
    }
  } catch (err) {
    endWasmUse(token);
    throw err;
  }
}

/**
 * INV-DB-01 2b-ii: maintenance (a cold export, a restore) on an OWNED DB takes its single-owner lock for the duration:
 * with no owner live it runs under the lock; with one live in another process it is refused by name (a short
 * budget, never a wait for the owner to exit). In the owner's own process the lock is re-entrant.
 */
export async function holdOwnerForMaintenance(dbPath: string, what: string): Promise<OwnerLock> {
  // INV-DB-01 slice 3 (Codex #377 R1 P2-4): the lock is keyed by the canonical NAME, so a hard link (a second name of
  // the same file) would be a second key: maintenance through it would run beside a live owner. A wasm DB with more
  // than one link is refused by every opener, before the lock and again once it is held.
  assertMaintenanceSingleLink(dbPath, what);
  let lock: OwnerLock;
  try {
    lock = await acquireOwnerLock(dbPath, { budgetMs: 300 });
  } catch (err) {
    if (err instanceof OwnerLockError && /could not be locked/.test(err.message)) {
      throw new OwnerLockError(
        `${what} refused: the DB at ${dbPath} is owned by a live relay process (its wasm single owner). Stop that ` +
          `process first (its data is safe in it meanwhile).`
      );
    }
    throw err;
  }
  try {
    assertMaintenanceSingleLink(dbPath, what); // a link made while the lock was being taken
  } catch (err) {
    lock.release();
    throw err;
  }
  return lock;
}
/** Maintenance on an owned DB refuses a file with more than one hard link (each name would be its own lock key). */
export function assertMaintenanceSingleLink(dbPath: string, what: string): void {
  if (!fs.existsSync(dbPath)) return;
  const n = fs.statSync(dbPath).nlink;
  if (n > 1) {
    throw new OwnerLockError(
      `${what} refused: the DB at ${dbPath} has ${n} hard links. Its single-owner lock is keyed by the file's name, so ` +
        `another name could be locked and used by another process at the same time. Remove the extra links (find ` +
        `them by the file's inode), then retry.`
    );
  }
}

/**
 * INV-DB-01 slice 4 (ADR-0048): db.ts installs its containment re-check (assertStillContained) here, so the owner's
 * creation of a NEW DB runs it before writing (this module cannot import db.ts: db.ts imports it).
 */
let containmentCheck: ((dbPath: string) => void) | null = null;
export function _installContainmentCheck(fn: (dbPath: string) => void): void {
  containmentCheck = fn;
}

/** Test-only: awaited in a wasm open right after sql.js loads (another process may own or create the file meanwhile). */
let afterSqlJsLoadHook: ((dbPath: string) => void | Promise<void>) | null = null;
export function _setAfterSqlJsLoadForTests(fn: ((dbPath: string) => void | Promise<void>) | null): void {
  afterSqlJsLoadHook = fn;
}

// --- #171: driver-aware DB-file operations for backup/restore ---

/**
 * Write a consistent point-in-time snapshot of `db` to `destPath`, driver-aware.
 * - native: `VACUUM INTO` — a live-consistent online copy, safe even while the
 *   daemon writes.
 * - wasm: serialize the in-memory image atomically (`serialize()` → sql.js
 *   `.export()`) and write the bytes. TEAR-PROOF regardless of caller. A plain
 *   copy of the write-back file would NOT be: the wasm flush is a bare
 *   `fs.writeFileSync` (no temp-and-rename, no lock), so a concurrent reader can
 *   observe it half-written — and a torn backup fails silently at restore.
 *
 * Branches on the ACTUAL db object handed in (`db instanceof WasmDatabase`), the
 * truest read-the-state: no env, no global, no captured driver that could go
 * stale — just the live connection. This also sidesteps the getActiveDriver()
 * gap where db.getDb()'s synchronous native fallback sets db.ts `_db` directly
 * and never registers a driver (#190 r2): the object itself is unambiguous.
 */
export function snapshotToFile(db: CompatDatabase, destPath: string): void {
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (db instanceof WasmDatabase) {
    fs.writeFileSync(destPath, Buffer.from(db.serialize()));
  } else {
    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  }
}

/**
 * Open an EXISTING SQLite file read-only, driver-aware. Backs the backup manifest
 * row-count read and the restore `PRAGMA integrity_check` — so both work under
 * the wasm driver, where the native better-sqlite3 binary is absent (the exact
 * npm-12 scripts-off scenario the wasm driver works around).
 * - native: better-sqlite3 `{ readonly: true }`.
 * - wasm: load the file bytes into a fresh sql.js instance. (Probe-only; close()
 *   re-writes the identical bytes, which is a harmless no-op on a temp file.)
 *
 * The `driver` is an EXPLICIT PARAMETER, never inferred (#190 r3 ruling). Restore
 * deliberately closes the live DB before probing the archive, so there is NO live
 * state to read in that window — "read the state" has no answer once the state is
 * destroyed on purpose. The caller captures the driver identity WHILE the
 * connection is live (driverOf(db)) and passes it, or uses configuredDriver() in
 * the truly-fresh no-connection path. You cannot call this without having decided
 * — the same make-impossible property as keeping getDriverType private. Opens the
 * GIVEN file; does NOT create or init the main DB, so validating a corrupt archive
 * manufactures no state.
 *
 * ADR-0048: every caller opens a STAGED file (backup/restore staging under
 * $TMPDIR), so after the open the path must still be PRIVATE (approved-roots
 * checkPrivatePath: the StrictModes rule on every traversed component). On a
 * refusal the handle is released without any write.
 */
export async function openReadOnly(dbPath: string, driver: SqliteDriver): Promise<CompatDatabase> {
  const db = await openReadOnlyUnchecked(dbPath, driver);
  const c = checkPrivatePath(dbPath);
  if (!c.ok) {
    try {
      if (db instanceof WasmDatabase) db.discard();
      else db.close();
    } catch {
      /* releasing a refused handle is best-effort */
    }
    throw new Error(`REFUSING the staged DB after opening it: ${c.reason}`);
  }
  return db;
}

async function openReadOnlyUnchecked(dbPath: string, driver: SqliteDriver): Promise<CompatDatabase> {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`openReadOnly: file not found at '${dbPath}'`);
  }
  const header = assertDriverHeaderAllows(dbPath, driver); // INV-DB-01 slice 2a: by path too
  if (driver === "wasm") {
    const w = (await openWasmFromBytes(fs.readFileSync(dbPath), dbPath)) as WasmDatabase;
    // A READ-ONLY open never writes the file: its close discards the image (a write-back could clobber a file that
    // another connection changed meanwhile, or drop a native handle's locks on it).
    w.close = () => w.discard();
    return w;
  }
  return openNativeDb(dbPath, { readonly: true }, header) as unknown as CompatDatabase; // held from construction
}

/**
 * INV-BACKUP-01: open an export's SOURCE DB read-only, WITHOUT initializeDb(): no migration, backfill or permission
 * change runs on it. `release()` closes it without ever writing it back (wasm: discard(), never close(), which would
 * rewrite the file). Refusals are named:
 * - native: a read-only open of a WAL DB must create -shm when there is none, so in a read-only directory it fails;
 *   that is refused as "a read-only directory" (MEASURED, SQLITE_READONLY_DIRECTORY).
 * - wasm reads only the main file, so the caller must first refuse a WAL DB or side files (assertWasmSourceReadable).
 */
export async function openExportSource(
  dbPath: string,
  driver: SqliteDriver
): Promise<{ db: CompatDatabase; release: () => void; loadedSha256: string | null }> {
  assertDriverHeaderAllows(dbPath, driver); // INV-DB-01 slice 2a: the source's header decides, before any read
  if (driver === "wasm") assertWasmSourceReadable(dbPath);
  let db: CompatDatabase | null = null;
  let loadedSha256: string | null = null;
  try {
    if (driver === "wasm") {
      // The EXACT bytes the image is built from, hashed, so the caller can tell a read that raced a writer.
      const bytes = fs.readFileSync(dbPath);
      loadedSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      db = await openWasmFromBytes(bytes, dbPath);
    } else {
      db = await openReadOnlyUnchecked(dbPath, driver);
    }
    db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get(); // a native read-only open fails here, not at open
  } catch (err) {
    // Never leak the handle a failed probe opened (Codex #372 R1 P3); the error is kept.
    if (db) {
      try {
        if (db instanceof WasmDatabase) db.discard();
        else db.close();
      } catch {
        /* best-effort */
      }
    }
    const code = (err as { code?: string }).code ?? "";
    if (code === "SQLITE_READONLY_DIRECTORY" || /readonly database|read-only/i.test(String((err as Error).message))) {
      throw new Error(
        `backup refused: the DB at '${dbPath}' is in a read-only directory and has no -shm file, which a read-only open ` +
          `must create. Make the directory writable, or back up while the relay has the DB open.`
      );
    }
    throw err;
  }
  const opened = db as CompatDatabase;
  const release = () => {
    try {
      if (opened instanceof WasmDatabase) opened.discard();
      else opened.close();
    } catch {
      /* releasing a read-only handle is best-effort */
    }
  };
  return { db: opened, release, loadedSha256 };
}

/** The SHA-256 of a file's current bytes (the torn-read guard's after-read). */
export function fileSha256(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/**
 * The wasm driver reads ONLY a DB's main file (sql.js loads its bytes). A -wal or -shm beside it (even empty) means
 * another process may have it open or commits may sit outside the main file (MEASURED: the wasm read silently missed
 * them); a -journal means a rollback may be pending. Each is refused by name. The WAL header alone is NOT (ruled): a
 * native DB whose last connection closed cleanly holds every commit in its main file (MEASURED).
 */
export function assertWasmSourceReadable(dbPath: string, what = "backup refused (wasm driver)"): void {
  for (const side of ["-wal", "-shm", "-journal"]) {
    if (fs.existsSync(dbPath + side)) {
      throw new Error(
        `${what}: a ${side} file is beside the DB at '${dbPath}', so another process may have it open ` +
          `or its last transaction is not in the main file, and the wasm driver reads only the main file. Back up with ` +
          `the native driver, or once no other process has the DB open.`
      );
    }
  }
}

/** A wasm (sql.js) database over the given bytes, tied to `dbPath` (whose write-back a caller must never trigger on a source). */
async function openWasmFromBytes(bytes: Buffer, dbPath: string): Promise<CompatDatabase> {
  let initSqlJs: any;
  try {
    const mod = await import("sql.js");
    initSqlJs = mod.default;
  } catch {
    throw new Error(
      "sql.js is not installed. RELAY_SQLITE_DRIVER=wasm requires sql.js. " +
      "Install it with: npm install sql.js",
    );
  }
  const SQL = await initSqlJs();
  return new WasmDatabase(new SQL.Database(Uint8Array.from(bytes)), dbPath); // a copy: sql.js adopts the array
}

// --- Public API ---

let _initializedDb: CompatDatabase | null = null;
let _driverUsed: SqliteDriver | null = null;
// v1.11.1: cache the init promise so concurrent callers share one instance.
// Dual-model audit (Codex/GPT) surfaced: two concurrent initializeDb() calls
// could create two independent in-memory wasm DBs, last-writer-wins.
let _initPromise: Promise<CompatDatabase> | null = null;

/**
 * Initialize the database. Must be called once at process startup (before
 * any getDb() call). For native: sync under the hood. For wasm: loads the
 * wasm binary async. Thread-safe: concurrent callers share the same promise.
 */
export function initializeDb(dbPath: string): Promise<CompatDatabase> {
  if (_initializedDb) return Promise.resolve(_initializedDb);
  if (_initPromise) return _initPromise;

  const p = (async () => {
    // INV-DB-01 slices 2a/2b-ii: the declarations, then the DB file's header, decide the driver AND the mode.
    const r = resolveOpen(dbPath, "open");
    const driver = r.driver;
    log.info(`[db] Initializing SQLite driver: ${driver}${r.mode === "owner" ? " (single owner)" : ""}`);

    if (r.mode === "owner") {
      _initializedDb = await createOwnedWasmDb(dbPath, r.header);
    } else {
      _initializedDb = await createNativeDb(dbPath, r.header);
    }

    _driverUsed = driver;
    return _initializedDb;
  })();
  _initPromise = p;
  // A refused (or failed) init is not cached: the next call re-evaluates (Codex #380 R1 P2-6).
  p.catch(() => {
    if (_initPromise === p) _initPromise = null;
  });
  return p;
}

/**
 * Get the initialized database handle. Throws if initializeDb() has not
 * been called yet. This is the sync access point all of src/db.ts uses.
 */
export function getInitializedDb(): CompatDatabase | null {
  return _initializedDb;
}

export function getActiveDriver(): SqliteDriver | null {
  return _driverUsed;
}

/**
 * The driver of an OPEN connection, read from the object itself — the truest
 * state, no global, no env, no tracker that can go stale. Used to capture the
 * driver identity WHILE a connection is live, to hand to openReadOnly (which
 * never infers). #190 r3.
 */
export function driverOf(db: CompatDatabase): SqliteDriver {
  return db instanceof WasmDatabase ? "wasm" : "native";
}

/**
 * The CONFIGURED driver for a COLD open — the ONLY legitimate read of the
 * requested env: when there is NO live connection to read (a first-ever restore
 * probing an archive before any DB is initialized). Here the request IS the
 * reality: it is the driver the process will instantiate. NEVER use this where a
 * live connection exists — use driverOf(db) there. #190 r3.
 */
export function configuredDriver(dbPath?: string): SqliteDriver {
  // 2b-ii: with a DB path, the header decides (an RLYW file is read with the wasm driver whatever the declarations).
  return dbPath ? resolveOpen(dbPath, "read").driver : getDriverType();
}

/**
 * INV-DB-01 slices 1 and 2a: refuse an instance driver this release does not accept, and a DB whose header refuses
 * that driver, BEFORE any filesystem effect of a DB open (db.initializeDb() calls it before it creates the DB's parent
 * directory). Warns as getDriverType() and the header check do.
 */
export function assertInstanceDriverAccepted(dbPath: string): DriverHeader {
  return resolveOpen(dbPath, "open").header;
}

/**
 * Close and clear the initialized DB (for test cleanup).
 */
/**
 * ADR-0048: drop the initialized handle WITHOUT any write, for a DB refused after
 * opening. WASM: discard() skips the flush. Native: nothing has been written yet
 * (no pragma, no schema: those run after the re-check), so close() writes nothing.
 */
export function discardInitializedDb(): void {
  const db = _initializedDb;
  _initializedDb = null;
  _driverUsed = null;
  _initPromise = null;
  if (!db) return;
  if (db instanceof WasmDatabase) db.discard();
  else db.close();
}

export function closeInitializedDb(): void {
  const db = _initializedDb;
  try {
    db?.close();
  } catch (err) {
    // A NATIVE handle whose close failed (better-sqlite3 refuses a busy connection) is still open and held: keep the
    // reference, so a retry closes it and releases its hold (Codex #380 R2). Any other failed close (a refused wasm
    // write-back, reported by name) clears the handle as before: it never leaves a stale one.
    if (db && isOpenNative(db)) throw err;
    clearInitialized();
    throw err;
  }
  clearInitialized();
}
function clearInitialized(): void {
  _initializedDb = null;
  _driverUsed = null;
  _initPromise = null;
}
/** A native handle still open (its close failed). */
export function isOpenNative(db: CompatDatabase): boolean {
  return !(db instanceof WasmDatabase) && (db as unknown as { open?: boolean }).open === true;
}
