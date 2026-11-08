// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 slice 2b-i (rulings 7657ad36, e6e1b44e): a native process never fs-opens a DB-family file.
 * - The header comes, in order, from (1) PRAGMA application_id on a native handle this process holds, else (3) ONE
 *   synchronous fs read of the main file, only when this process holds no native handle on it. (2), a pre-open
 *   read-only SQLite open, was MEASURED out: it creates a -wal on every WAL file.
 * - The hold registry is retired; a minimal in-process native-handle COUNT stays, for the header source and restore.
 * - A native open of a file this process holds through a WRITABLE wasm connection is refused (the reverse in-process
 *   mix: the wasm write-back's close would drop the native handle's locks).
 * - The restore archive reader refuses a member of the live DB's family, by identity.
 * Lock assertions use another process (POSIX fcntl, or a SQLite BEGIN EXCLUSIVE); byte reads of a held DB likewise.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import * as compat from "../src/sqlite-compat.js";
import * as db from "../src/db.js";
import * as header from "../src/db-header.js";
import { openRawRelayDb } from "../src/cli/_instance-db.js";
import { exportRelayState, importRelayState } from "../src/backup.js";
import { _takeFsSpyViolations } from "./_setup/no-fs-on-held-db.js";
import { pathToFileURL } from "url";

const NATIVE = 0x524c594e;
/** INV-DB-01 slice 4: a wasm connection is always its single owner, so the wasm rows below open an RLYW (owned) file. */
const WASM = 0x524c5957;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "s2bi-")));
const KEYS = ["HOME", "USERPROFILE", "RELAY_CONFIG_PATH", "RELAY_INSTANCE_ID", "RELAY_SQLITE_DRIVER", "RELAY_DB_PATH"] as const;
let saved: Record<string, string | undefined>;
let caseDir: string;
let dbPath: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  caseDir = fs.mkdtempSync(path.join(ROOT, "case-"));
  dbPath = path.join(caseDir, "relay.db");
  process.env.HOME = caseDir;
  process.env.USERPROFILE = caseDir;
  delete process.env.RELAY_INSTANCE_ID;
  delete process.env.RELAY_SQLITE_DRIVER;
  process.env.RELAY_DB_PATH = dbPath;
  process.env.RELAY_CONFIG_PATH = path.join(caseDir, "config.json");
  db.closeDb();
  compat.closeInitializedDb();
  compat._resetDriverWarningForTests();
});
afterEach(() => {
  db.closeDb();
  compat.closeInitializedDb();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** In ANOTHER process: can it take an exclusive POSIX lock on [start, start+length) of `file`? (DENIED while held.) */
function otherProcessLock(file: string, start: number, length: number): string {
  const script = path.join(ROOT, "try-lock.py");
  if (!fs.existsSync(script)) {
    fs.writeFileSync(script, ["import fcntl, os, sys", "fd = os.open(sys.argv[1], os.O_RDWR)", "try:", "    fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, int(sys.argv[3]), int(sys.argv[2]), os.SEEK_SET); print('GRANTED')", "except OSError:", "    print('DENIED')", ""].join("\n"));
  }
  return spawnSync("python3", ["-I", script, file, String(start), String(length)], { encoding: "utf8" }).stdout.trim();
}
const SHM_DMS = 128;
const POSIX = process.platform !== "win32";
function makeRollbackDb(file: string, appId: number): void {
  const d = new Database(file);
  d.pragma("journal_mode = DELETE");
  if (appId !== 0) d.pragma(`application_id = ${appId}`);
  d.exec("CREATE TABLE kept (v TEXT); INSERT INTO kept VALUES ('row-1');");
  d.close();
}
function makeWalDb(file: string, appId: number): void {
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  if (appId !== 0) d.pragma(`application_id = ${appId}`);
  d.exec("CREATE TABLE kept (v TEXT); INSERT INTO kept VALUES ('row-1');");
  d.close();
}
const family = (p: string) => [p, `${p}-wal`, `${p}-shm`, `${p}-journal`];
/** Every fs open/read of a DB-family path made while `fn` runs (a spy on the descriptor-opening functions). */
async function familyOpensDuringAsync<T>(p: string, fn: () => Promise<T>): Promise<string[]> {
  const opens: string[] = [];
  const restore = spyFamily(p, opens);
  try {
    await fn();
  } finally {
    restore();
  }
  return opens;
}
function spyFamily(p: string, opens: string[]): () => void {
  const members = new Set(family(p));
  const spies = (["openSync", "readFileSync", "createReadStream"] as const).map((name) => {
    const orig = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!;
    return vi.spyOn(fs as unknown as Record<string, (...a: unknown[]) => unknown>, name).mockImplementation(function (this: unknown, ...a: unknown[]) {
      if (typeof a[0] === "string" && members.has(a[0])) opens.push(`${name}(${a[0]})`);
      return orig.apply(this, a);
    });
  });
  return () => {
    for (const s of spies) s.mockRestore();
  };
}
function familyOpensDuring<T>(p: string, fn: () => T): { result: T; opens: string[] } {
  const members = new Set(family(p));
  const opens: string[] = [];
  const spies = (["openSync", "readFileSync", "createReadStream"] as const).map((name) => {
    const orig = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!;
    return vi.spyOn(fs as unknown as Record<string, (...a: unknown[]) => unknown>, name).mockImplementation(function (this: unknown, ...a: unknown[]) {
      if (typeof a[0] === "string" && members.has(a[0])) opens.push(`${name}(${a[0]})`);
      return orig.apply(this, a);
    });
  });
  try {
    return { result: fn(), opens };
  } finally {
    for (const s of spies) s.mockRestore();
  }
}
/** In ANOTHER process: can a SQLite connection take the DB exclusively? (BUSY while this process holds a lock.) */
function otherProcessBeginExclusive(file: string): string {
  const script = path.join(ROOT, "begin-exclusive.cjs");
  if (!fs.existsSync(script)) {
    fs.writeFileSync(
      script,
      `const D = require(require("module").createRequire(${JSON.stringify(path.join(REPO, "package.json"))}).resolve("better-sqlite3"));\n` +
        `const d = new D(process.argv[2], { timeout: 0 });\n` +
        `try { d.exec("BEGIN EXCLUSIVE"); d.exec("ROLLBACK"); process.stdout.write("GRANTED"); } catch (e) { process.stdout.write(e.code || String(e)); } finally { d.close(); }\n`
    );
  }
  const r = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  return r.stdout.trim() || `exit ${r.status}: ${r.stderr}`;
}

describe("INV-DB-01 2b-i: a native process never fs-opens a DB-family file", () => {
  it("HOLDING a write lock, the header is read through the held connection: no fs open of the family, and the lock is still held", async () => {
    makeWalDb(dbPath, NATIVE);
    await db.initializeDb();
    db.getDb().exec("BEGIN IMMEDIATE");
    try {
      const { result, opens } = familyOpensDuring(dbPath, () => header.readDriverHeader(dbPath));
      expect(result).toEqual({ kind: "native" });
      expect(opens, "no fs open of the DB family").toEqual([]);
      expect(otherProcessBeginExclusive(dbPath), "another process cannot take it").toBe("SQLITE_BUSY");
    } finally {
      db.getDb().exec("ROLLBACK");
    }
  });

  it("twin: with NO native handle held, the header is ONE synchronous fs read of the main file (source 3)", () => {
    makeWalDb(dbPath, NATIVE);
    const { result, opens } = familyOpensDuring(dbPath, () => header.readDriverHeader(dbPath));
    expect(result).toEqual({ kind: "native" });
    expect(result instanceof Promise, "synchronous").toBe(false);
    expect(opens).toEqual([`openSync(${dbPath})`]);
  });

  it("a native open of a file this process holds through a WRITABLE wasm connection is refused by name (the reverse in-process mix)", async () => {
    makeRollbackDb(dbPath, WASM); // slice 4: was a legacy (0) file in the retired legacy mode; now an owned one
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    await compat.initializeDb(dbPath);
    await expect(openRawRelayDb(dbPath, { readonly: true })).rejects.toThrow(
      /REFUSING the native driver on the DB at .*a wasm connection to that file is open, or opening, in this process/
    );
  });

  it("the restore archive reader refuses a member of the live DB's family by identity: the DB, its -shm, a hard link to it", async () => {
    await db.initializeDb();
    db.getDb().prepare("SELECT count(*) FROM agents").get();
    const alias = path.join(caseDir, "alias.db");
    fs.linkSync(dbPath, alias);
    for (const p of [dbPath, `${dbPath}-shm`, alias]) {
      await expect(importRelayState(p, { force: true }), p).rejects.toThrow(/backup archive refused: .* is the live relay database \(or one of its side files\)/);
    }
  });

  it("twin (7657ad36): a native cold export opens no DB-family file through fs (SQLite reads it; any hash is of the snapshot)", async () => {
    makeWalDb(dbPath, NATIVE);
    const opens = await familyOpensDuringAsync(dbPath, () => exportRelayState({ destinationPath: path.join(caseDir, "cold.tar.gz") }));
    expect(opens.filter((o) => !o.startsWith("openSync(")), "no read of the live file's bytes").toEqual([]);
  });

  it("the suite-wide spy records an fs read of a DB this process holds natively (and this row clears it)", async () => {
    makeWalDb(dbPath, NATIVE);
    await db.initializeDb();
    _takeFsSpyViolations();
    fs.readFileSync(dbPath); // the hazard itself, on purpose: the lock is lost for this row only
    const seen = _takeFsSpyViolations();
    expect(seen).toHaveLength(1);
    // Recorded at the fd level (Codex #383 R2): readFileSync acquires its descriptor through fs.openSync.
    expect(seen[0]).toMatch(/fs\.openSync\(.*relay\.db\) while this process holds a native handle on that DB/);
  });

  describe("Codex #383 R1", () => {
    it("P1-1: a SIDE FILE of a held DB passed as a database (its -shm, or a hard link to it) is refused by name, never fs-opened; the -shm lock stays", async () => {
      makeWalDb(dbPath, NATIVE);
      const raw = await openRawRelayDb(dbPath, { readonly: true });
      try {
        raw.prepare("SELECT v FROM kept").get();
        const shm = `${dbPath}-shm`;
        const alias = path.join(caseDir, "shm-alias");
        fs.linkSync(shm, alias);
        for (const p of [shm, alias]) {
          const { opens } = familyOpensDuring(dbPath, () => expect(() => header.readDriverHeader(p), p).toThrow(/is a side file of a database this process holds natively/));
          expect(opens, p).toEqual([]);
        }
        if (POSIX) expect(otherProcessLock(shm, SHM_DMS, 1), "the -shm lock byte").toBe("DENIED");
      } finally {
        raw.close();
      }
    });

    it("P1-2: a native open while a WASM init is between its awaits is refused by name (the init holds its claim from before its first await)", async () => {
      makeRollbackDb(dbPath, WASM); // slice 4: was a legacy (0) file; a wasm init is now always an owner's
      process.env.RELAY_SQLITE_DRIVER = "wasm";
      const init = compat.initializeDb(dbPath); // not awaited: it is now inside its awaits
      expect(() => compat.openNativeDb(dbPath, { readonly: true }, { kind: "wasm" })).toThrow(/a wasm connection to that file is open, or opening, in this process/);
      const w = await init;
      expect(compat.driverOf(w)).toBe("wasm");
      expect(header.nativeHandleCount(dbPath)).toBe(0);
    });

    it("P1-3: a native open DURING a cold wasm export (before its torn-read hash) is refused by name; the export completes", async () => {
      makeRollbackDb(dbPath, 0);
      process.env.RELAY_SQLITE_DRIVER = "wasm";
      const backup = await import("../src/backup.js");
      let refused = "";
      backup._setExportReadHookForTests(() => {
        try {
          compat.openNativeDb(dbPath, { readonly: true }, { kind: "legacy" }).close();
        } catch (e) {
          refused = (e as Error).message;
        }
      });
      try {
        await exportRelayState({ destinationPath: path.join(caseDir, "cold-wasm.tar.gz") });
      } finally {
        backup._setExportReadHookForTests(null);
      }
      expect(refused).toMatch(/a wasm connection to that file is open, or opening, in this process/);
    });

    it("P1-4: a restore whose archive path is ANY database this process holds natively (not only the live one) is refused by name, never fs-opened", async () => {
      await db.initializeDb(); // the live DB (A)
      const other = path.join(caseDir, "other.db"); // B
      makeWalDb(other, NATIVE);
      const raw = await openRawRelayDb(other, { readonly: true });
      try {
        raw.prepare("SELECT v FROM kept").get();
        for (const p of [other, `${other}-shm`]) {
          await expect(importRelayState(p, { force: true }), p).rejects.toThrow(/belongs to a database this process holds open natively/);
        }
      } finally {
        raw.close();
      }
    });

    it("P2-5: a BUSY held handle (an open iterator) does not break the header read: a free held handle answers; all busy → a named, retryable refusal, never an fs read", async () => {
      makeWalDb(dbPath, NATIVE);
      const a = await openRawRelayDb(dbPath, { readonly: true });
      const b = await openRawRelayDb(dbPath, { readonly: true });
      const itA = a.prepare("SELECT v FROM kept").iterate() as IterableIterator<unknown>;
      itA.next();
      let itB: IterableIterator<unknown> | null = null;
      try {
        expect(header.readDriverHeader(dbPath), "the free handle answers").toEqual({ kind: "native" });
        itB = b.prepare("SELECT v FROM kept").iterate() as IterableIterator<unknown>;
        itB.next();
        const { opens } = familyOpensDuring(dbPath, () => expect(() => header.readDriverHeader(dbPath)).toThrow(/every native connection this process holds on it is busy .* retry/));
        expect(opens, "never an fs read").toEqual([]);
        await expect(openRawRelayDb(dbPath, { readonly: true }), "a native open meanwhile: the same named refusal").rejects.toThrow(/is busy .* retry/);
      } finally {
        itA.return?.();
        itB?.return?.();
        a.close();
        b.close();
      }
      expect(header.readDriverHeader(dbPath), "once free, it answers").toEqual({ kind: "native" });
    });

    it("P2-6: module copies share one count (vi.resetModules + a fresh import still register where every copy reads)", async () => {
      makeWalDb(dbPath, NATIVE);
      vi.resetModules();
      const fresh = await import("../src/cli/_instance-db.js");
      const raw = await fresh.openRawRelayDb(dbPath, { readonly: true });
      try {
        expect(header.nativeHandleCount(dbPath), "the original module copy sees it").toBe(1);
      } finally {
        raw.close();
      }
    });

    it.each([
      ["a copy DESTINATION", (p: string) => fs.copyFileSync(path.join(ROOT, "staged.bin"), p)],
      ["a hard link to the held -shm", (p: string) => fs.readFileSync(path.join(path.dirname(p), "shm-link"))],
      ["a file URL with an encoded space", (p: string) => fs.readFileSync(pathToFileURL(p))],
    ] as const)("P2-7: the spy records %s", async (_label, act) => {
      const spaced = path.join(caseDir, "with space");
      fs.mkdirSync(spaced);
      const p = path.join(spaced, "relay.db");
      makeWalDb(p, NATIVE);
      fs.writeFileSync(path.join(ROOT, "staged.bin"), "x");
      const raw = await openRawRelayDb(p, { readonly: true });
      try {
        raw.prepare("SELECT v FROM kept").get();
        fs.linkSync(`${p}-shm`, path.join(spaced, "shm-link"));
        _takeFsSpyViolations();
        try {
          act(p);
        } catch {
          /* the spy's record is what is under test */
        }
        expect(_takeFsSpyViolations().length).toBeGreaterThan(0);
      } finally {
        raw.close();
      }
    });
  });

  describe("Codex #383 R2", () => {
    it.skipIf(!POSIX)("P2-1: the spy records an fd acquisition even when the outer operation then FAILS (a read through an append-only fd: EBADF), and does NOT record an open that failed (ENOENT)", async () => {
      makeWalDb(dbPath, NATIVE);
      const raw = await openRawRelayDb(dbPath, { readonly: true });
      try {
        raw.prepare("SELECT v FROM kept").get();
        _takeFsSpyViolations();
        expect(() => fs.readFileSync(`${dbPath}-shm`, { flag: "a" }), "the read fails after the open succeeded").toThrow(/EBADF/);
        expect(_takeFsSpyViolations().length, "the open was recorded").toBeGreaterThan(0);
        await new Promise<void>((res) => fs.open(`${dbPath}-journal`, "r", () => res()));
        expect(_takeFsSpyViolations(), "an open that failed (ENOENT) is not recorded").toEqual([]);
      } finally {
        raw.close();
      }
    });

    it("P2-2: a NON-busy PRAGMA failure on a held handle (not a database) surfaces as itself, never as a retryable busy error", async () => {
      const p = path.join(caseDir, "garbage.db");
      fs.writeFileSync(p, Buffer.alloc(4096, 0x5a));
      const raw = await openRawRelayDb(p, { readonly: true });
      try {
        let err: Error | null = null;
        try {
          header.readDriverHeader(p);
        } catch (e) {
          err = e as Error;
        }
        expect(err?.name, String(err)).not.toBe("DbHeaderBusyError");
        expect(String(err?.message)).toMatch(/not a database|SQLITE_NOTADB/);
      } finally {
        raw.close();
      }
    });

    it("P3: the spy reads PATH arguments only: a write whose PAYLOAD is a held DB's path (a string or a Buffer) is not a violation", async () => {
      makeWalDb(dbPath, NATIVE);
      const raw = await openRawRelayDb(dbPath, { readonly: true });
      try {
        _takeFsSpyViolations();
        fs.writeFileSync(path.join(caseDir, "pointer.txt"), dbPath);
        fs.writeFileSync(path.join(caseDir, "pointer.bin"), Buffer.from(dbPath));
        expect(_takeFsSpyViolations()).toEqual([]);
      } finally {
        raw.close();
      }
    });

    it.each(["close", "discard"] as const)("inherited: a wasm %s whose underlying close THROWS after closing still releases the claim (the handle is dead): a native open then works", async (how) => {
      makeRollbackDb(dbPath, WASM); // slice 4: was a legacy (0) file; a wasm connection is now always an owner's
      process.env.RELAY_SQLITE_DRIVER = "wasm";
      const w = await compat.initializeDb(dbPath);
      const rawWasm = (w as unknown as { db: { close(): void } }).db;
      const orig = rawWasm.close.bind(rawWasm);
      rawWasm.close = () => {
        orig();
        throw new Error("injected: closed, then threw");
      };
      try {
        if (how === "close") compat.closeInitializedDb();
        else compat.discardInitializedDb();
      } catch {
        /* the injected failure */
      }
      const n = compat.openNativeDb(dbPath, { readonly: true }, { kind: "wasm" });
      n.close();
    });

    // POSIX-only, as the doorbell itself: its state dir must be private (mode 0700), which Windows cannot express.
    it.skipIf(!POSIX)("inherited: the doorbell's lock DB refuses a path that aliases a relay DB this process has claimed (a hard link under the lock's name)", async () => {
      makeRollbackDb(dbPath, WASM); // slice 4: was a legacy (0) file; a wasm init is now always an owner's
      const stateDir = path.join(caseDir, "state");
      fs.mkdirSync(stateDir, { mode: 0o700 });
      fs.linkSync(dbPath, path.join(stateDir, "doorbell.lock.db"));
      process.env.RELAY_SQLITE_DRIVER = "wasm";
      // slice 4: imported FIRST, so the doorbell call runs while the init's claim is held (synchronously after the init
      // begins, before its first await). An owner init now rejects soon after (the hard link), releasing the claim.
      const { acquireInstanceLock } = await import("../src/doorbell-lock.js");
      const init = compat.initializeDb(dbPath); // its claim is recorded before its first await
      expect(() => acquireInstanceLock(stateDir, { pid: process.pid, proc_start: null, host_id: null })).toThrow(
        /refusing to open it as a lock: it is .* relay database this process has open/
      );
      // slice 4: the owner then refuses the hard-linked DB itself (its lock is keyed by one name); before, the legacy
      // open (no owner) succeeded.
      await expect(init).rejects.toThrow(/hard link/);
    });
  });
});
