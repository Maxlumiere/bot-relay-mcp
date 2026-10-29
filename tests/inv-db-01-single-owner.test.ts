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
import { spawn, type ChildProcess } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_JS = pathToFileURL(path.join(REPO, "dist", "db.js")).href;
const LOCK_JS = pathToFileURL(path.join(REPO, "dist", "db-owner-lock.js")).href;
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "inv-db-01-")));
const HOME = path.join(ROOT, "home");
fs.mkdirSync(HOME);
const { MEASURED_PLATFORMS } = (await import("../dist/db-owner-lock.js")) as { MEASURED_PLATFORMS: ReadonlySet<string> };
const ENABLED = MEASURED_PLATFORMS.has(process.platform);
const recorded: ChildProcess[] = [];
afterAll(() => {
  const alive = recorded.filter((c) => c.exitCode === null && c.signalCode === null);
  for (const c of alive) c.kill("SIGKILL");
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
  dbDir = fs.mkdtempSync(path.join(ROOT, "case-"));
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
      const link = path.join(ROOT, `link-${path.basename(dbDir)}.db`);
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

  it("a native open racing a wasm owner (the owner arrives between the native open and its RE-CHECK) is refused", async () => {
    const compat = (await import("../dist/sqlite-compat.js")) as {
      _setNativeAfterOpenHookForTests?: (fn: (() => Promise<void>) | null) => void;
      initializeDb: (p: string) => Promise<unknown>;
      closeInitializedDb?: () => void;
    };
    expect(typeof compat._setNativeAfterOpenHookForTests, "the post-open seam exists").toBe("function");
    let owner: ReturnType<typeof child> | null = null;
    compat._setNativeAfterOpenHookForTests!(async () => {
      owner = child("hold", "wasm-late", "wasm");
      expect(await owner.ready).toMatch(/READY/);
    });
    const prev = { driver: process.env.RELAY_SQLITE_DRIVER, home: process.env.HOME };
    process.env.RELAY_SQLITE_DRIVER = "native";
    process.env.HOME = HOME;
    try {
      await expect(compat.initializeDb(dbPath)).rejects.toThrow(/owned by a wasm-driver process/);
    } finally {
      compat._setNativeAfterOpenHookForTests!(null);
      compat.closeInitializedDb?.();
      process.env.RELAY_SQLITE_DRIVER = prev.driver;
      process.env.HOME = prev.home;
    }
  }, 60_000);
});

describe.skipIf(ENABLED)(`INV-DB-01 on ${process.platform}: the lock is not measured here, so wasm writes are refused`, () => {
  it("a wasm open is refused by name, with the remedy", async () => {
    expect(await child("write", "w", "wasm").out).toMatch(/REFUSED .*not been measured here.*native driver/);
  }, 60_000);
});
