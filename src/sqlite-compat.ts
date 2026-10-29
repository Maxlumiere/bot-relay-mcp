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
import { acquireOwnerLock, assertSingleLink, holdsOwnerLock, isOwnedElsewhere, OwnerLockError, type OwnerLock } from "./db-owner-lock.js";

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
function getDriverType(): SqliteDriver {
  const raw = process.env.RELAY_SQLITE_DRIVER || "native";
  if (raw === "wasm") return "wasm";
  return "native";
}

// --- Native driver (better-sqlite3 passthrough) ---

async function createNativeDb(dbPath: string): Promise<CompatDatabase> {
  const { default: Database } = await import("better-sqlite3");
  return new Database(dbPath) as unknown as CompatDatabase;
}

// --- Wasm driver (sql.js adapter) ---

class WasmStatement implements CompatStatement {
  constructor(private db: any, private sql: string) {}

  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint } {
    const stmt = this.db.prepare(this.sql);
    try {
      if (params.length > 0) {
        stmt.bind(params);
      }
      stmt.step();
    } finally {
      stmt.free();
    }
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
      stmt.free();
    }
  }

  all(...params: any[]): any[] {
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
      stmt.free();
    }
  }

  /** Rows one at a time: the sql.js statement is stepped and each row yielded, never collected; freed when the loop ends or breaks. */
  *iterate(...params: any[]): IterableIterator<any> {
    const stmt = this.db.prepare(this.sql);
    try {
      if (params.length > 0) {
        stmt.bind(params);
      }
      while (stmt.step()) {
        yield stmt.getAsObject();
      }
    } finally {
      stmt.free();
    }
  }

  private _flush(): void {
    // Delegate to WasmDatabase's flush via a tag on the raw db handle.
    if (typeof (this.db as any).__flush === "function") {
      (this.db as any).__flush();
    }
  }
}

class WasmDatabase implements CompatDatabase {
  private db: any;
  private dbPath: string;
  private txDepth = 0;
  /** INV-DB-01: a read-only handle (a probe, a snapshot source) never writes the file back, not even on close(). */
  readonly readOnly: boolean;
  /** INV-DB-01: the single-owner lock a WRITABLE handle holds; released when it closes. */
  ownerLock: OwnerLock | null = null;

  constructor(rawDb: any, dbPath: string, opts: { readOnly?: boolean } = {}) {
    this.db = rawDb;
    this.dbPath = dbPath;
    this.readOnly = opts.readOnly ?? false;
    // Attach conditional flush so WasmStatement can call it.
    // Skips actual flush when inside a transaction (depth > 0) — the
    // transaction() wrapper handles flushing at COMMIT/ROLLBACK.
    (this.db as any).__flush = () => {
      if (this.txDepth === 0) this.flush();
    };
  }

  prepare(sql: string): CompatStatement {
    return new WasmStatement(this.db, sql);
  }

  exec(sql: string): this {
    this.db.run(sql);
    // v2.0 beta: respect txDepth so exec() inside a transaction doesn't flush
    // mid-way. Calling export() between DDL statements inside an open
    // transaction loses the in-memory state that hasn't yet been committed.
    if (this.txDepth === 0) this.flush();
    return this;
  }

  pragma(source: string, _options?: any): any {
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
      const isOutermost = this.txDepth === 0;
      const spName = `sp_${this.txDepth}`;
      this.txDepth++;
      if (isOutermost) {
        this.db.run("BEGIN TRANSACTION");
      } else {
        this.db.run(`SAVEPOINT ${spName}`);
      }
      try {
        const result = fn();
        if (isOutermost) {
          this.db.run("COMMIT");
        } else {
          this.db.run(`RELEASE ${spName}`);
        }
        this.txDepth--;
        if (this.txDepth === 0) this.flush();
        return result;
      } catch (err) {
        this.txDepth--;
        try {
          if (isOutermost) {
            this.db.run("ROLLBACK");
          } else {
            this.db.run(`ROLLBACK TO ${spName}`);
          }
        } catch {
          // Transaction/savepoint may already be finalized.
        }
        if (this.txDepth === 0) this.flush();
        throw err;
      }
    };
  }

  close(): void {
    try {
      if (!this.readOnly) this.flush();
    } finally {
      this.db.close();
      this.releaseOwner();
    }
  }

  private releaseOwner(): void {
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
    this.db.close();
    this.releaseOwner();
  }

  /**
   * #171: atomic in-memory serialization — the whole DB image as bytes, produced
   * synchronously from memory with no filesystem touch. Tear-proof by
   * construction (unlike copying the write-back file, whose flush is a bare
   * non-atomic fs.writeFileSync). Backs `snapshotToFile` on the wasm driver.
   */
  serialize(): Uint8Array {
    return this.db.export();
  }

  // v1.11.1: flush propagates REAL errors (fail-closed for disk-write
  // failures like ENOSPC). Emscripten internal FS errors from db.export()
  // are caught and retried — sql.js's wasm layer sometimes throws ErrnoError
  // on export() due to Emscripten virtual filesystem quirks that do not
  // affect the in-memory data integrity.
  private flush(): void {
    let data: Uint8Array;
    try {
      data = this.db.export();
    } catch (err: any) {
      if (err?.name === "ErrnoError") {
        // Emscripten FS error — the in-memory DB is still valid. Log but
        // don't propagate: the data is safe in memory, just not flushed yet.
        // Next write will retry the export.
        log.warn("[db-wasm] export() hit Emscripten FS error (non-fatal, data safe in memory):", err);
        return;
      }
      throw err;
    }
    if (this.readOnly) {
      throw new OwnerLockError(`wasm persist refused: the handle on ${this.dbPath} is read-only.`);
    }
    // INV-DB-01: persist ONLY under this process's single-owner lock (never a write another owner could race), never
    // to a hard-linked DB, and ATOMICALLY: a fresh temp file beside the DB, then renamed over it. A failure is
    // propagated (disk full, permissions, a lost lock).
    if (!this.ownerLock || !holdsOwnerLock(this.dbPath)) {
      throw new OwnerLockError(
        `wasm persist refused: this process does not hold the single-owner lock for ${this.dbPath}, so another process may own it. Nothing was written.`
      );
    }
    assertSingleLink(this.dbPath);
    const tmp = `${this.dbPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, Buffer.from(data), { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, this.dbPath);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
}

async function createWasmDb(dbPath: string): Promise<CompatDatabase> {
  let initSqlJs: any;
  try {
    const mod = await import("sql.js");
    initSqlJs = mod.default;
  } catch {
    throw new Error(
      "sql.js is not installed. RELAY_SQLITE_DRIVER=wasm requires sql.js. " +
      "Install it with: npm install sql.js"
    );
  }

  const SQL = await initSqlJs();

  let rawDb: any;
  if (fs.existsSync(dbPath)) {
    const fileData = fs.readFileSync(dbPath);
    rawDb = new SQL.Database(fileData);
  } else {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    rawDb = new SQL.Database();
  }

  return new WasmDatabase(rawDb, dbPath);
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
  if (driver === "wasm") return openWasmFromBytes(fs.readFileSync(dbPath), dbPath);
  const { default: Database } = await import("better-sqlite3");
  return new Database(dbPath, { readonly: true }) as unknown as CompatDatabase;
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
      // INV-DB-01: a native process never opens a wasm-owned DB: checked before the open and right after.
      await assertNotOwnedByWasm(dbPath);
      db = await openReadOnlyUnchecked(dbPath, driver);
      await assertNotOwnedByWasm(dbPath);
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
        `${what}: a ${side} file is beside the DB at '${dbPath}'. Either another process has the DB open, or the ` +
          `file was left by a native open (e.g. a native \`relay backup\`), and the last transaction may not be in ` +
          `the main file, which is all the wasm driver reads. If no other process has it open: open it once with the ` +
          `native driver to checkpoint (closing its last connection removes the side files), then retry.`
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
  return new WasmDatabase(new SQL.Database(bytes), dbPath, { readOnly: true });
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
/** INV-DB-01: refuse, by name, a DB a wasm-driver process owns (every native open checks before and right after). */
export async function assertNotOwnedByWasm(dbPath: string): Promise<void> {
  if (await isOwnedElsewhere(dbPath)) {
    throw new OwnerLockError(
      `the DB at ${dbPath} is owned by a wasm-driver process; a native process does not open it meanwhile. Stop that process first.`
    );
  }
}

/** Test-only: runs between a native open and its re-check (an owner arriving in that window). */
let nativeAfterOpenHook: (() => Promise<void>) | null = null;
export function _setNativeAfterOpenHookForTests(fn: (() => Promise<void>) | null): void {
  nativeAfterOpenHook = fn;
}

export function initializeDb(dbPath: string, opts: { verifyCreated?: (dbPath: string) => void } = {}): Promise<CompatDatabase> {
  if (_initializedDb) return Promise.resolve(_initializedDb);
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const driver = getDriverType();
    log.info(`[db] Initializing SQLite driver: ${driver}`);

    if (driver === "wasm") {
      // INV-DB-01, the wasm write protocol: the single-owner lock FIRST (it materializes an absent DB; a bounded
      // jittered retry, then a named refusal), then no side file beside the DB, no hard link, and only then the load.
      const lock = await acquireOwnerLock(dbPath, { verifyCreated: opts.verifyCreated });
      let wdb: WasmDatabase;
      try {
        assertWasmSourceReadable(dbPath, "wasm open refused");
        assertSingleLink(dbPath);
        wdb = (await createWasmDb(dbPath)) as WasmDatabase;
      } catch (err) {
        lock.release();
        throw err;
      }
      wdb.ownerLock = lock;
      _initializedDb = wdb;
    } else {
      // INV-DB-01: a native process never opens a DB a wasm-driver process owns: checked BEFORE the open and again
      // right AFTER it, before anything is written (an owner may arrive in between).
      await assertNotOwnedByWasm(dbPath);
      const ndb = await createNativeDb(dbPath);
      try {
        await nativeAfterOpenHook?.();
        await assertNotOwnedByWasm(dbPath);
      } catch (err) {
        ndb.close();
        throw err;
      }
      _initializedDb = ndb;
    }

    _driverUsed = driver;
    return _initializedDb;
  })();
  // A refused open (e.g. another owner, INV-DB-01) must not stay cached: a later call tries again.
  _initPromise.catch(() => {
    _initPromise = null;
  });

  return _initPromise;
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
export function configuredDriver(): SqliteDriver {
  return getDriverType();
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
  if (_initializedDb) {
    _initializedDb.close();
    _initializedDb = null;
    _driverUsed = null;
    _initPromise = null;
  }
}
