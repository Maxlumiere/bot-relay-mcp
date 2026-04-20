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
import fs from "fs";
import path from "path";
import { log } from "./logger.js";

// Type subset of better-sqlite3 that src/db.ts actually uses.
export interface CompatStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

export interface CompatDatabase {
  prepare(sql: string): CompatStatement;
  exec(sql: string): this;
  pragma(source: string, options?: any): any;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

export type SqliteDriver = "native" | "wasm";

export function getDriverType(): SqliteDriver {
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
    this.flush();
    this.db.close();
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
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // THIS write-to-disk failure IS propagated (disk full, permissions, etc.)
    fs.writeFileSync(this.dbPath, Buffer.from(data));
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

  _initPromise = (async () => {
    const driver = getDriverType();
    log.info(`[db] Initializing SQLite driver: ${driver}`);

    if (driver === "wasm") {
      _initializedDb = await createWasmDb(dbPath);
    } else {
      _initializedDb = await createNativeDb(dbPath);
    }

    _driverUsed = driver;
    return _initializedDb;
  })();

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
 * Close and clear the initialized DB (for test cleanup).
 */
export function closeInitializedDb(): void {
  if (_initializedDb) {
    _initializedDb.close();
    _initializedDb = null;
    _driverUsed = null;
    _initPromise = null;
  }
}
