// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01: a wasm-driven DB file is touched by ONE process only, and never while another process has it open.
 *
 * Driven through the relay's own DB layer (dist/db.js) in child processes (from FILES), under a SANDBOX HOME, so each
 * row fails on unprotected code for its real reason. The single-owner lock itself is measured per OS by
 * tests/inv-db-01-owner-lock-race.test.ts; the behavioural rows here run where that lock is enabled
 * (MEASURED_PLATFORMS), and elsewhere a wasm write is refused by name.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_JS = pathToFileURL(path.join(REPO, "dist", "db.js")).href;
const LOCK_JS = pathToFileURL(path.join(REPO, "dist", "db-owner-lock.js")).href;
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "inv-db-01-")));
const HOME = path.join(ROOT, "home");
fs.mkdirSync(HOME);
// In-process lock calls (macOS keeps its lock files under os.homedir()) use the SANDBOX home too, never the operator's.
const SAVED_HOME = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const restoreHome = () => {
  for (const [k, v] of Object.entries(SAVED_HOME)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};
const { MEASURED_PLATFORMS } = (await import("../dist/db-owner-lock.js")) as { MEASURED_PLATFORMS: ReadonlySet<string> };
const ENABLED = MEASURED_PLATFORMS.has(process.platform);
const recorded: ChildProcess[] = [];
afterAll(async () => {
  // A child killed by afterEach may not have emitted "exit" yet: kill what is left and WAIT (bounded) for every one.
  const waitExit = (c: ChildProcess) =>
    c.exitCode !== null || c.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((res) => { c.once("exit", () => res()); setTimeout(res, 5000); });
  for (const c of recorded) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  await Promise.all(recorded.map(waitExit));
  const alive = recorded.filter((c) => c.exitCode === null && c.signalCode === null);
  restoreHome();
  fs.rmSync(ROOT, { recursive: true, force: true });
  expect(alive.length, "every recorded child had exited").toBe(0);
});

const OP = path.join(ROOT, "op.mjs");
fs.writeFileSync(
  OP,
  `const db = await import(${JSON.stringify(DB_JS)});\n` +
    `const [op, name] = process.argv.slice(2);\n` +
    `const out = (s) => process.stdout.write(s + "\\n");\n` +
    `try {\n` +
    `  await db.initializeDb();\n` +
    `  db.registerAgent(name, "r", []);\n` +
    `  if (op === "hold") { for (let i = 0; i < 3; i++) db.registerAgent(name + "-" + i, "r", []); out("READY"); setInterval(() => {}, 1000); }\n` +
    `  else { db.closeDb(); out("OK"); process.exit(0); }\n` +
    `} catch (e) { out("REFUSED " + String(e && e.message).replace(/\\n/g, " ")); process.exit(0); }\n`
);

let dbDir: string;
let dbPath: string;
beforeEach(() => {
  // Under the SANDBOX HOME: always an approved root (on Windows, ROOT itself is not one for the children).
  dbDir = fs.mkdtempSync(path.join(HOME, "case-"));
  dbPath = path.join(dbDir, "relay.db");
});
afterEach(() => {
  for (const c of recorded) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
});

function child(op: "hold" | "write", name: string, driver: "wasm" | "native", db = dbPath): { proc: ChildProcess; out: Promise<string>; ready: Promise<string> } {
  const proc = spawn(process.execPath, [OP, op, name], {
    env: { ...process.env, HOME, USERPROFILE: HOME, RELAY_DB_PATH: db, RELAY_SQLITE_DRIVER: driver, RELAY_HTTP_PORT: "1", RELAY_CONFIG_PATH: path.join(dbDir, "config.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  recorded.push(proc);
  let buf = "";
  const ready = new Promise<string>((res) => proc.stdout!.on("data", (d) => { buf += d; if (/READY|REFUSED|OK/.test(buf)) res(buf); }));
  proc.stdout!.on("data", () => {});
  return { proc, out: new Promise((res) => proc.on("exit", () => res(buf))), ready };
}
async function nativeRows(db = dbPath): Promise<string[]> {
  const Database = (await import("better-sqlite3")).default;
  const d = new Database(db, { readonly: true });
  try {
    return (d.prepare("SELECT name FROM agents ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  } finally {
    d.close();
  }
}

describe.skipIf(!ENABLED)(`INV-DB-01 on ${process.platform}: one wasm owner, enforced before any read or write`, () => {
  it("(1) a NATIVE WAL writer holds the DB → a wasm open is refused (side files beside it); the DB is intact", async () => {
    const holder = child("hold", "native-holder", "native");
    expect(await holder.ready).toMatch(/READY/);
    const w = await child("write", "wasm-intruder", "wasm").out;
    expect(w).toMatch(/REFUSED .*-(wal|shm) file is beside/);
    holder.proc.kill("SIGTERM");
    await holder.out;
    expect(await nativeRows(), "the native holder's rows are intact, the intruder's absent").toContain("native-holder");
    expect(await nativeRows()).not.toContain("wasm-intruder");
  }, 60_000);

  it("(2) a SECOND wasm process is refused while the first owns the DB", async () => {
    const a = child("hold", "wasm-a", "wasm");
    expect(await a.ready).toMatch(/READY/);
    expect(await child("write", "wasm-b", "wasm").out).toMatch(/REFUSED .*could not be locked/);
  }, 60_000);

  it("(3) a NATIVE open is refused while a wasm owner is alive", async () => {
    const a = child("hold", "wasm-a", "wasm");
    expect(await a.ready).toMatch(/READY/);
    expect(await child("write", "native-b", "native").out).toMatch(/REFUSED .*owned by a wasm-driver process/);
  }, 60_000);

  it("(4) the wasm owner SIGKILLed → the next opener succeeds (the kernel released the lock)", async () => {
    const a = child("hold", "wasm-a", "wasm");
    expect(await a.ready).toMatch(/READY/);
    a.proc.kill("SIGKILL");
    await a.out;
    expect(await child("write", "wasm-b", "wasm").out).toMatch(/OK/);
  }, 60_000);

  it("(5) known-good twin: a single wasm process on its own DB writes and reopens", async () => {
    expect(await child("write", "solo", "wasm").out).toMatch(/OK/);
    expect(await child("write", "solo-2", "wasm").out).toMatch(/OK/);
    expect(await nativeRows()).toEqual(expect.arrayContaining(["solo", "solo-2"]));
  }, 60_000);

  it("ruled (1): the owner has PERSISTED (tmp + rename: a new inode), and a new opener is still refused (the same key)", async () => {
    const a = child("hold", "wasm-a", "wasm"); // it writes 4 rows, each a persist
    expect(await a.ready).toMatch(/READY/);
    expect(await child("write", "wasm-b", "wasm").out).toMatch(/REFUSED .*could not be locked/);
  }, 60_000);

  it("ruled (2): alias spellings (a symlink, `..`, a case variant where this volume folds case) are the SAME owner", async () => {
    const a = child("hold", "wasm-a", "wasm");
    expect(await a.ready).toMatch(/READY/);
    const spellings = [path.join(dbDir, ".", "x", "..", "relay.db")];
    fs.mkdirSync(path.join(dbDir, "x"));
    if (process.platform !== "win32") {
      const link = path.join(HOME, `link-${path.basename(dbDir)}.db`);
      fs.symlinkSync(dbPath, link);
      spellings.push(link);
    }
    const upper = path.join(dbDir, "RELAY.DB");
    if (fs.existsSync(upper) && fs.realpathSync.native(upper) === fs.realpathSync.native(dbPath)) spellings.push(upper);
    for (const s of spellings) expect(await child("write", "alias", "wasm", s).out, s).toMatch(/REFUSED/);
  }, 60_000);

  it("ruled (3): a HARD-LINKED DB: a wasm write is refused by name", async () => {
    expect(await child("write", "seed", "native").out).toMatch(/OK/);
    fs.linkSync(dbPath, path.join(dbDir, "second-name.db"));
    expect(await child("write", "wasm-w", "wasm").out).toMatch(/REFUSED .*hard links/);
  }, 60_000);

  const folds = (() => {
    const probe = path.join(ROOT, "CaseProbe");
    fs.writeFileSync(probe, "");
    return fs.existsSync(path.join(ROOT, "caseprobe"));
  })();
  it.skipIf(!folds)("ruled (4): a NEW DB created concurrently through two case spellings: exactly ONE owner", async () => {
    const lower = path.join(dbDir, "new.db");
    const upper = path.join(dbDir, "NEW.DB");
    const x = child("hold", "x", "wasm", lower);
    const y = child("hold", "y", "wasm", upper);
    const outs = await Promise.all([x.ready, y.ready]);
    expect(outs.filter((o) => /READY/.test(o)).length, outs.join(" | ")).toBe(1);
  }, 60_000);

  it("ruled (5): the canonical path changes after the lock is taken → no owner is kept on the stale key", async () => {
    const lock = (await import("../dist/db-owner-lock.js")) as {
      acquirePrimitive: (p: string, o?: object) => Promise<{ key: string; release(): void }>;
      lockKey: (p: string) => string;
      holdsOwnerLock: (p: string) => boolean;
      _setAfterAcquireHookForTests: (fn: (() => void) | null) => void;
    };
    const t1 = path.join(dbDir, "one.db");
    const t2 = path.join(dbDir, "two.db");
    fs.writeFileSync(t1, "");
    fs.writeFileSync(t2, "");
    const link = path.join(dbDir, "moving.db");
    fs.symlinkSync(t1, link);
    let moved = false;
    lock._setAfterAcquireHookForTests(() => {
      if (moved) return;
      moved = true;
      fs.unlinkSync(link);
      fs.symlinkSync(t2, link);
    });
    try {
      const got = await lock.acquirePrimitive(link);
      expect(got.key, "it ends on the CURRENT key").toBe(lock.lockKey(t2));
      expect(lock.holdsOwnerLock(t1), "no lock is kept on the stale key").toBe(false);
      got.release();
    } finally {
      lock._setAfterAcquireHookForTests(null);
    }
  }, 60_000);

  it("a native open racing a wasm owner (the owner arrives between the native open and its RE-CHECK) is refused; on Windows the owner cannot persist at all, and is refused BY NAME with nothing written", async () => {
    const compat = (await import("../dist/sqlite-compat.js")) as {
      _setNativeAfterOpenHookForTests?: (fn: (() => Promise<void>) | null) => void;
      initializeDb: (p: string) => Promise<unknown>;
      closeInitializedDb?: () => void;
    };
    expect(typeof compat._setNativeAfterOpenHookForTests, "the post-open seam exists").toBe("function");
    let owner: ReturnType<typeof child> | null = null;
    let sizeWhileOpen = -1;
    compat._setNativeAfterOpenHookForTests!(async () => {
      sizeWhileOpen = fs.statSync(dbPath).size;
      owner = child("hold", "wasm-late", "wasm");
      if (process.platform === "win32") {
        // Windows cannot replace a file another process holds open: the owner's first persist is refused BY NAME, it
        // writes nothing, and it exits (so the native's re-check finds no owner).
        expect(await owner.ready).toMatch(/REFUSED .*another process has the DB file open; Windows cannot replace it; nothing was written/);
        await owner.out;
        expect(fs.statSync(dbPath).size, "the refused owner wrote nothing").toBe(sizeWhileOpen);
      } else {
        expect(await owner.ready).toMatch(/READY/);
      }
    });
    const prev = { driver: process.env.RELAY_SQLITE_DRIVER, home: process.env.HOME };
    process.env.RELAY_SQLITE_DRIVER = "native";
    process.env.HOME = HOME;
    try {
      if (process.platform === "win32") {
        await expect(compat.initializeDb(dbPath), "the native open, its owner gone, proceeds").resolves.toBeTruthy();
      } else {
        await expect(compat.initializeDb(dbPath)).rejects.toThrow(/owned by a wasm-driver process/);
      }
    } finally {
      compat._setNativeAfterOpenHookForTests!(null);
      compat.closeInitializedDb?.();
      process.env.RELAY_SQLITE_DRIVER = prev.driver;
      process.env.HOME = prev.home;
    }
  }, 60_000);
});

describe.skipIf(!ENABLED)(`INV-DB-01 on ${process.platform}: every other native open of the DB checks the owner, and a restore swap is locked`, () => {
  const ENV_KEYS = ["HOME", "RELAY_DB_PATH", "RELAY_SQLITE_DRIVER", "RELAY_HTTP_PORT", "RELAY_CONFIG_PATH"] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.HOME = HOME; // the darwin lock dir lives under HOME: the SANDBOX one
    process.env.RELAY_DB_PATH = dbPath;
    process.env.RELAY_HTTP_PORT = "1";
    process.env.RELAY_CONFIG_PATH = path.join(dbDir, "config.json");
    (await import("../src/db.js")).closeDb();
  });
  afterEach(async () => {
    (await import("../src/db.js")).closeDb();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it.each([true, false])("openRawRelayDb (relay bind / pending / fleet / recover / purges), readonly=%s, refuses a wasm-owned DB", async (readonly) => {
    expect(await child("write", "seed", "native").out).toMatch(/OK/);
    const a = child("hold", "wasm-a", "wasm");
    expect(await a.ready).toMatch(/READY/);
    const { openRawRelayDb } = await import("../src/cli/_instance-db.js");
    await expect(openRawRelayDb(dbPath, { readonly })).rejects.toThrow(/owned by a wasm-driver process/);
  }, 60_000);

  it("a NATIVE export (relay backup, no connection open) of a wasm-owned DB is refused", async () => {
    expect(await child("write", "seed", "native").out).toMatch(/OK/);
    const a = child("hold", "wasm-a", "wasm");
    expect(await a.ready).toMatch(/READY/);
    process.env.RELAY_SQLITE_DRIVER = "native";
    const { exportRelayState } = await import("../src/backup.js");
    await expect(exportRelayState({ destinationPath: path.join(HOME, `exp-${path.basename(dbDir)}.tar.gz`) })).rejects.toThrow(/owned by a wasm-driver process/);
  }, 60_000);

  it("a -wal/-shm left by a native cold export: the wasm open refuses, and NAMES the cause and the remedy", async () => {
    expect(await child("write", "seed", "native").out).toMatch(/OK/);
    process.env.RELAY_SQLITE_DRIVER = "native";
    const { exportRelayState } = await import("../src/backup.js");
    await exportRelayState({ destinationPath: path.join(HOME, `wal-${path.basename(dbDir)}.tar.gz`) });
    (await import("../src/db.js")).closeDb();
    expect(fs.existsSync(dbPath + "-wal"), "precondition: the native cold export left a -wal (MEASURED)").toBe(true);
    const w = await child("write", "w", "wasm").out;
    expect(w).toMatch(/REFUSED .*-(wal|shm) file is beside the DB/);
    expect(w, "the cause").toMatch(/left by a native open \(e\.g\. a native `relay backup`\)/);
    expect(w, "the remedy").toMatch(/open it once with the native driver to checkpoint.*then retry/);
    // The remedy WORKS as named: one native open of the DB (the relay's own), then the wasm open succeeds.
    expect(await child("write", "remedy", "native").out).toMatch(/OK/);
    expect(await child("write", "after-remedy", "wasm").out, "the wasm open after the remedy").toMatch(/OK/);
  }, 60_000);

  it.each(["native", "wasm"] as const)("a %s cold export beside the owner's lock file: a NORMAL archive name is not refused, it succeeds, and the lock file is NOT archived", async (driver) => {
    expect(await child("write", "seed", "native").out).toMatch(/OK/);
    const a = child("hold", "wasm-owner", "wasm"); // the owner creates its lock file (macOS: beside the DB)
    expect(await a.ready).toMatch(/READY/);
    a.proc.kill("SIGTERM");
    await a.out;
    if (process.platform === "darwin") {
      expect(fs.existsSync(path.join(fs.realpathSync.native(dbDir), ".relay.db.relay-owner")), "precondition: the owner's lock file is there").toBe(true);
    }
    process.env.RELAY_SQLITE_DRIVER = driver;
    const { exportRelayState } = await import("../src/backup.js");
    const r = await exportRelayState({ destinationPath: path.join(dbDir, `backup-${driver}.tar.gz`) });
    const listed = spawnSync("tar", ["-tzf", path.basename(r.archive_path)], { cwd: path.dirname(r.archive_path), encoding: "utf-8" });
    expect(listed.status, listed.stderr).toBe(0);
    const members = listed.stdout.split(/\r?\n/).filter(Boolean);
    expect(members.length, "precondition: the archive has members").toBeGreaterThan(0);
    expect(members.filter((x) => x.includes("relay-owner")), "the lock file was archived").toEqual([]);
  }, 60_000);

  it.each(["a single statement", "a transaction"])("a REFUSED persist (%s) loses no write: nothing on disk changes, no temp file is left, and the NEXT persist writes it", async (path_) => {
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const db = await import("../src/db.js");
    const compat = (await import("../src/sqlite-compat.js")) as unknown as {
      _setPersistRenameForTests?: (fn: ((from: string, to: string) => void) | null) => void;
    };
    expect(typeof compat._setPersistRenameForTests, "the persist seam exists").toBe("function");
    await db.initializeDb();
    const h = db.getDb();
    h.exec("CREATE TABLE IF NOT EXISTS persist_probe (v TEXT)");
    const ins = h.prepare("INSERT INTO persist_probe (v) VALUES (?)");
    const write = (v: string) => (path_ === "a transaction" ? h.transaction(() => ins.run(v))() : ins.run(v));
    write("before");
    const bytesBefore = fs.readFileSync(dbPath);
    let fail = true;
    compat._setPersistRenameForTests!((from, to) => {
      if (fail) throw Object.assign(new Error("EPERM: operation not permitted (injected)"), { code: "EPERM" });
      fs.renameSync(from, to);
    });
    try {
      expect(() => write("during")).toThrow(/nothing was written.*next successful persist/);
      expect(fs.readFileSync(dbPath).equals(bytesBefore), "the DB file changed").toBe(true);
      expect(fs.readdirSync(dbDir).filter((f) => f.endsWith(".tmp")), "a temp file was left").toEqual([]);
      fail = false;
      write("after");
      // Read the FILE before closing (a close persists too, and would hide a dropped persist).
      const Database = (await import("better-sqlite3")).default;
      const ro = new Database(dbPath, { readonly: true });
      try {
        const vs = (ro.prepare("SELECT v FROM persist_probe ORDER BY rowid").all() as Array<{ v: string }>).map((r) => r.v);
        expect(vs, "the next persist wrote the earlier write too").toEqual(["before", "during", "after"]);
      } finally {
        ro.close();
      }
    } finally {
      compat._setPersistRenameForTests!(null);
      db.closeDb();
    }
  }, 60_000);

  it("a persist refused at CLOSE is reported BY NAME, counting the writes it LOST; never silent, and the handle is cleared", async () => {
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const db = await import("../src/db.js");
    const compat = (await import("../src/sqlite-compat.js")) as unknown as {
      _setPersistRenameForTests?: (fn: ((from: string, to: string) => void) | null) => void;
    };
    await db.initializeDb();
    const h = db.getDb();
    h.exec("CREATE TABLE IF NOT EXISTS persist_probe (v TEXT)");
    const ins = h.prepare("INSERT INTO persist_probe (v) VALUES (?)");
    ins.run("kept");
    compat._setPersistRenameForTests!(() => {
      throw Object.assign(new Error("EPERM: operation not permitted (injected)"), { code: "EPERM" });
    });
    try {
      expect(() => ins.run("lost")).toThrow(/nothing was written/);
      expect(() => db.closeDb(), "a refused final persist is reported").toThrow(/final persist was refused, so 1 write\(s\) since the last successful persist (are|were) LOST/);
    } finally {
      compat._setPersistRenameForTests!(null);
    }
    // The handle was cleared, and the lock released: a fresh open works, and holds only what was persisted.
    await db.initializeDb();
    const vs = (db.getDb().prepare("SELECT v FROM persist_probe ORDER BY rowid").all() as Array<{ v: string }>).map((r) => r.v);
    db.closeDb();
    expect(vs).toEqual(["kept"]);
  }, 60_000);

  it.each(["wasm", "native"] as const)("a RESTORE (driver %s) while another process owns the DB is refused, and the owner's data survives", async (driver) => {
    expect(await child("write", "seed", "native").out).toMatch(/OK/);
    process.env.RELAY_SQLITE_DRIVER = "native";
    const { exportRelayState, importRelayState } = await import("../src/backup.js");
    const archive = (await exportRelayState({ destinationPath: path.join(HOME, `arc-${driver}-${path.basename(dbDir)}.tar.gz`) })).archive_path;
    (await import("../src/db.js")).closeDb();
    // A native cold export (a read-only open of a WAL DB) leaves -wal/-shm beside it (MEASURED); the relay's own native
    // open (one that READS: a bare open + close does not, MEASURED) checkpoints and removes them on its last close.
    expect(await child("write", "normalize", "native").out).toMatch(/OK/);
    expect(["-wal", "-shm"].filter((x) => fs.existsSync(dbPath + x)), "precondition: no side files").toEqual([]);
    const a = child("hold", "wasm-owner", "wasm");
    expect(await a.ready).toMatch(/READY/);
    process.env.RELAY_SQLITE_DRIVER = driver;
    await expect(importRelayState(archive, { force: true })).rejects.toThrow(/could not be locked|owned by a wasm-driver process/);
    a.proc.kill("SIGTERM");
    await a.out;
    expect(await nativeRows(), "the owner's rows were not swapped away").toContain("wasm-owner");
  }, 90_000);
});

describe.skipIf(ENABLED)(`INV-DB-01 on ${process.platform}: the lock is not measured here, so wasm writes are refused`, () => {
  it("a wasm open is refused by name, with the remedy", async () => {
    expect(await child("write", "w", "wasm").out).toMatch(/REFUSED .*not been measured here.*native driver/);
  }, 60_000);
});
