// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 slice 3: by-path opens. Every opener that reaches the DB by its PATH (the CLI verbs' raw open, getDb()'s
 * synchronous fallback, export, restore) follows the INSTANCE: a declared-wasm instance is never opened natively by
 * path (one opener: everyone else goes over HTTP), a wasm DB with more than one hard link is refused by every
 * opener, every replace targets the canonical referent (a symlinked DB path keeps its link), and a DB file is never
 * unlinked (a refusal leaves it and names it). Runs on Linux, macOS (the owner lock is O_EXLOCK there) and Windows.
 *
 * Each row names the finding it reproduces: G1..G5 are the slice-3 plan's gaps, P1-1 / P1-2 / P2-4 are Codex's
 * #377 R1 reproductions. Rows marked GUARD already hold on the base (the header refuses them since 2a/2b-ii) and
 * stay as regression guards.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import Database from "better-sqlite3";
import crypto from "crypto";
import * as compat from "../src/sqlite-compat.js";
import * as db from "../src/db.js";
import { materializeDb } from "../src/db-owner-lock.js";
import { openRawRelayDb } from "../src/cli/_instance-db.js";
import { exportRelayState, importRelayState, _setBeforeRestoreSwapForTests } from "../src/backup.js";
import * as backupMod from "../src/backup.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DB = pathToFileURL(path.join(REPO, "dist", "db.js")).href;
const WASM = 0x524c5957;
const NATIVE = 0x524c594e;
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "s3-")));
const KEYS = ["HOME", "USERPROFILE", "RELAY_CONFIG_PATH", "RELAY_INSTANCE_ID", "RELAY_SQLITE_DRIVER", "RELAY_DB_PATH"] as const;
let saved: Record<string, string | undefined>;
let caseDir: string;
let dbPath: string;
let cfgPath: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  caseDir = fs.mkdtempSync(path.join(ROOT, "case-"));
  dbPath = path.join(caseDir, "relay.db");
  cfgPath = path.join(caseDir, "config.json");
  process.env.HOME = caseDir;
  process.env.USERPROFILE = caseDir;
  delete process.env.RELAY_INSTANCE_ID;
  delete process.env.RELAY_SQLITE_DRIVER;
  process.env.RELAY_DB_PATH = dbPath;
  process.env.RELAY_CONFIG_PATH = cfgPath;
  db.closeDb();
  compat.closeInitializedDb();
  compat._resetDriverWarningForTests();
});
afterEach(() => {
  try {
    db.closeDb();
  } catch {
    /* a refused close is not this row's subject */
  }
  compat.closeInitializedDb();
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const declareWasm = (file = cfgPath) => fs.writeFileSync(file, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
function makeDb(file: string, appId: number, rows: string[] = ["row-1"]): void {
  const d = new Database(file);
  d.pragma("journal_mode = DELETE");
  if (appId !== 0) d.pragma(`application_id = ${appId}`);
  d.exec("CREATE TABLE kept (v TEXT)");
  for (const r of rows) d.prepare("INSERT INTO kept VALUES (?)").run(r);
  d.close();
}
const keptRows = (file: string): string[] => {
  const d = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (d.prepare("SELECT v FROM kept ORDER BY rowid").all() as Array<{ v: string }>).map((r) => r.v);
  } finally {
    d.close();
  }
};
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const waitExitOf = (c: ChildProcess) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise((r) => c.once("exit", r)));

/**
 * A HOT WAL on `file`: another process switches it to WAL, commits `n` rows that stay in the -wal (no checkpoint), and
 * exits WITHOUT closing, as a killed opener leaves it (the -wal and -shm stay).
 */
const HOT_WAL = path.join(ROOT, "hot-wal.cjs");
fs.writeFileSync(
  HOT_WAL,
  `const D = require(process.argv[2]); const d = new D(process.argv[3]); d.pragma("journal_mode = WAL"); d.pragma("wal_autocheckpoint = 0");\n` +
    `const ins = d.prepare("INSERT INTO kept VALUES (?)"); for (let i = 0; i < Number(process.argv[4]); i++) ins.run("wal-" + i);\n` +
    `process.exit(0);\n`
);
function leaveHotWal(file: string, n = 50): void {
  const r = spawnSync(process.execPath, [HOT_WAL, path.join(REPO, "node_modules", "better-sqlite3"), file, String(n)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`precondition: the hot-WAL writer failed: ${r.stderr}`);
  if (!fs.existsSync(`${file}-wal`) || fs.statSync(`${file}-wal`).size === 0) throw new Error(`precondition: no hot -wal beside ${file}`);
}
const fileState = (f: string) => (fs.existsSync(f) ? `${fs.statSync(f).size}:${sha(f)}` : "absent");

/**
 * A LIVE opener in another process: it opens `file` in WAL mode and stays open until killed (its connection is pinned
 * on globalThis: an unreferenced better-sqlite3 connection is closed on GC, measured to drop its locks). "idle": no transaction
 * (it only holds the connection); "txn": it first commits rows that stay in the -wal, then holds a READ transaction
 * (a snapshot), so a TRUNCATE checkpoint cannot finish.
 */
const LIVE = path.join(ROOT, "live-opener.cjs");
fs.writeFileSync(
  LIVE,
  `const D = require(process.argv[2]); const d = new D(process.argv[3]); d.pragma("journal_mode = WAL"); d.pragma("wal_autocheckpoint = 0");\n` +
    `if (process.argv[4] === "txn") { const ins = d.prepare("INSERT INTO kept VALUES (?)"); for (let i = 0; i < 20; i++) ins.run("live-" + i); d.exec("BEGIN"); d.prepare("SELECT count(*) FROM kept").get(); }\n` +
    `else d.prepare("SELECT count(*) FROM kept").get();\n` +
    // PINNED: an unreferenced better-sqlite3 connection is closed on GC, which drops its locks and its side files.
    `globalThis.__liveOpener = d; process.stdout.write("READY\\n"); setInterval(() => { if (!globalThis.__liveOpener.open) process.exit(9); }, 1000);\n` +
    // "read" (stdin): the opener reads its own rows through its live connection and reports them on one line.
    `process.stdin.on("data", (b) => { for (const l of String(b).split("\\n")) if (l === "read") { try { process.stdout.write("ROWS " + JSON.stringify(globalThis.__liveOpener.prepare("SELECT v FROM kept ORDER BY rowid").all().map((r) => r.v)) + "\\n"); } catch (e) { process.stdout.write("READ-FAILED " + String(e && e.message || e).split("\\n")[0] + "\\n"); } } });\n`
);
async function startLiveOpener(file: string, mode: "idle" | "txn"): Promise<ChildProcess> {
  const c = spawn(process.execPath, [LIVE, path.join(REPO, "node_modules", "better-sqlite3"), file, mode], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(c);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("precondition: the live opener did not start within 20 s")), 20_000);
    c.stdout!.on("data", (d) => String(d).includes("READY") && (clearTimeout(t), res()));
  });
  return c;
}

/** A child that opens the relay DB through dist/db.js (env as given), prints READY or REFUSED <msg>, then idles. */
const OWNER = path.join(ROOT, "owner.mjs");
fs.writeFileSync(
  OWNER,
  `const db = await import(${JSON.stringify(DIST_DB)});\n` +
    `try { await db.initializeDb(); db.registerAgent("child-" + process.pid, "r", []); process.stdout.write("READY\\n"); }\n` +
    `catch (e) { process.stdout.write("REFUSED " + String(e && e.message || e).split("\\n")[0] + "\\n"); process.exit(3); }\n` +
    `process.stdin.on("data", (d) => { for (const line of String(d).split("\\n")) {\n` +
    `  if (line === "exit") { db.closeDb(); process.exit(0); }\n` +
    `  const w = /^write (\\S+)$/.exec(line);\n` +
    `  if (w) { try { db.registerAgent(w[1], "r", []); process.stdout.write("WROTE\\n"); } catch (e) { process.stdout.write("WRITE-REFUSED " + String(e && e.message || e).split("\\n")[0] + "\\n"); } }\n` +
    `} });\n` +
    `setInterval(() => {}, 1000);\n`
);
function ask(child: ChildProcess, cmd: string): Promise<string> {
  return new Promise((res) => {
    let out = "";
    const t = setTimeout(() => res(`TIMEOUT ${out}`), 20_000);
    const on = (d: Buffer) => {
      out += d;
      if (/\n/.test(out)) {
        clearTimeout(t);
        child.stdout!.off("data", on);
        res(out.split("\n")[0]!);
      }
    };
    child.stdout!.on("data", on);
    child.stdin!.write(`${cmd}\n`);
  });
}
/** An owner child on `ownDbPath` declaring wasm through its OWN config file (this process's declaration is separate). */
function startOwner(ownDbPath: string, ownCfg: string): { child: ChildProcess; first: Promise<string> } {
  declareWasm(ownCfg);
  const env: NodeJS.ProcessEnv = { ...process.env, RELAY_DB_PATH: ownDbPath, RELAY_CONFIG_PATH: ownCfg };
  const child = spawn(process.execPath, [OWNER], { env, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  const first = new Promise<string>((res) => {
    let out = "";
    const t = setTimeout(() => res(`TIMEOUT ${out}`), 30_000);
    child.stdout!.on("data", function on(d: Buffer) {
      out += d;
      if (/\n/.test(out)) {
        clearTimeout(t);
        child.stdout!.off("data", on);
        res(out.split("\n")[0]!);
      }
    });
  });
  return { child, first };
}
async function stopOwner(o: { child: ChildProcess }): Promise<void> {
  o.child.stdin!.write("exit\n");
  await waitExitOf(o.child);
}

describe("INV-DB-01 slice 3: by-path opens follow the instance", () => {
  // --- G1 / Codex #377 R1 P1-1: every replace targets the canonical referent ---

  it.skipIf(process.platform === "win32")("G1: a restore through a SYMLINKED DB path keeps the link and restores its referent", async () => {
    const realDir = path.join(caseDir, "real");
    fs.mkdirSync(realDir);
    const real = path.join(realDir, "relay.db");
    makeDb(real, 0, ["row-1"]);
    const link = path.join(caseDir, "link.db");
    fs.symlinkSync(real, link);
    process.env.RELAY_DB_PATH = link;
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    const live = new Database(real);
    live.prepare("INSERT INTO kept VALUES ('row-2')").run();
    live.close();
    const r = await importRelayState(archive, { force: true });
    expect(r.restored).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink(), "the DB path is still a symlink (the restore replaced its referent, not the link)").toBe(true);
    expect(fs.realpathSync.native(link), "and it still names the same referent").toBe(fs.realpathSync.native(real));
    expect(keptRows(real), "the referent holds the archive").toEqual(["row-1"]);
  }, 60_000);

  it.skipIf(process.platform === "win32")("P1-1: a restore through alias/link.db -> real/relay.db never touches alias/relay.db, another process's OWNED DB, which keeps working", async () => {
    const aliasDir = path.join(caseDir, "alias");
    const realDir = path.join(caseDir, "real");
    fs.mkdirSync(aliasDir);
    fs.mkdirSync(realDir);
    const real = path.join(realDir, "relay.db");
    makeDb(real, 0, ["row-1"]);
    const link = path.join(aliasDir, "link.db");
    fs.symlinkSync(real, link);
    const victim = path.join(aliasDir, "relay.db");
    const a = startOwner(victim, path.join(caseDir, "owner-config.json"));
    expect(await a.first, "precondition: another process owns alias/relay.db").toBe("READY");
    const theirs = sha(victim);
    process.env.RELAY_DB_PATH = link;
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    const r = await importRelayState(archive, { force: true });
    expect(r.restored).toBe(true);
    expect(sha(victim), "the other process's DB is untouched").toBe(theirs);
    expect(await ask(a.child, "write after-restore"), "and its owner still writes").toBe("WROTE");
    expect(fs.lstatSync(link).isSymbolicLink(), "the restore went to the referent: the link survives").toBe(true);
    expect(keptRows(real), "the referent holds the archive").toEqual(["row-1"]);
    await stopOwner(a);
  }, 90_000);

  // --- G2: a declared-wasm instance is never opened natively by path, and nothing is created ---

  it("G2: getDb()'s synchronous native fallback on a declared-wasm instance with NO DB refuses by name (the HTTP hint) and creates neither the file nor its directory", () => {
    declareWasm();
    const parent = path.join(caseDir, "missing-parent");
    process.env.RELAY_DB_PATH = path.join(parent, "relay.db");
    expect(() => db.getDb()).toThrow(/wasm[\s\S]*HTTP|HTTP[\s\S]*wasm/i);
    expect(fs.existsSync(parent), "the DB's directory was not created").toBe(false);
  });

  it("G2: a raw by-path open (the CLI verbs: bind, fleet, recover, purge-*) on a declared-wasm instance with NO DB names the instance's wasm declaration and the HTTP route", async () => {
    declareWasm();
    await expect(openRawRelayDb(dbPath, { readonly: true })).rejects.toThrow(/wasm[\s\S]*HTTP|HTTP[\s\S]*wasm/i);
    expect(fs.existsSync(dbPath), "nothing was created").toBe(false);
  });

  it("G2: an export of a declared-wasm instance with NO DB (its parent missing) is refused and creates nothing", async () => {
    declareWasm();
    const parent = path.join(caseDir, "missing-parent");
    process.env.RELAY_DB_PATH = path.join(parent, "relay.db");
    await expect(exportRelayState({ destinationPath: path.join(caseDir, "out.tar.gz") })).rejects.toThrow();
    expect(fs.existsSync(parent), "the DB's directory was not created").toBe(false);
    expect(fs.existsSync(path.join(caseDir, "out.tar.gz")), "no archive was written").toBe(false);
  });

  it("G2 twin: a NATIVE instance's getDb() fallback still creates and opens its DB (stamped RLYN)", () => {
    expect(() => db.getDb()).not.toThrow();
    expect(fs.existsSync(dbPath)).toBe(true);
    db.closeDb();
    expect(fs.readFileSync(dbPath).readInt32BE(68)).toBe(NATIVE);
  });

  // --- G3 / Codex #377 R1 P2-4: a wasm DB with more than one hard link is refused by EVERY opener ---

  it("G3: a cold export through a HARD LINK of a DB another process owns is refused (a second name is a second lock key), and writes no archive", async () => {
    const a = startOwner(dbPath, path.join(caseDir, "owner-config.json"));
    expect(await a.first, "precondition: another process owns relay.db").toBe("READY");
    const alias = path.join(caseDir, "alias.db");
    fs.linkSync(dbPath, alias);
    declareWasm();
    process.env.RELAY_DB_PATH = alias;
    const out = path.join(caseDir, "via-alias.tar.gz");
    await expect(exportRelayState({ destinationPath: out })).rejects.toThrow(/hard link|links/i);
    expect(fs.existsSync(out), "no archive of the owner's live DB was written").toBe(false);
    await stopOwner(a);
  }, 90_000);

  it("G3: a restore onto a HARD LINK of a DB another process owns is refused, and the owner's file is untouched", async () => {
    makeDb(dbPath, WASM);
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path; // no owner yet
    const a = startOwner(dbPath, path.join(caseDir, "owner-config.json"));
    expect(await a.first, "precondition: another process owns relay.db").toBe("READY");
    const theirs = sha(dbPath);
    const alias = path.join(caseDir, "alias.db");
    fs.linkSync(dbPath, alias);
    process.env.RELAY_DB_PATH = alias;
    await expect(importRelayState(archive, { force: true })).rejects.toThrow(/hard link|links/i);
    expect(sha(dbPath), "the owner's file is untouched").toBe(theirs);
    expect(fs.statSync(alias).ino, "and the alias still names it").toBe(fs.statSync(dbPath).ino);
    await stopOwner(a);
  }, 90_000);

  it("P2-4 GUARD: a native raw open through a hard-link alias of an RLYW DB is refused before any read", async () => {
    makeDb(dbPath, WASM);
    const alias = path.join(caseDir, "other-name.db");
    fs.linkSync(dbPath, alias);
    await expect(openRawRelayDb(alias, { readonly: true })).rejects.toThrow(/HTTP/);
  });

  // --- Codex #377 R1 P1-2, for W and N files (the legacy-0 + env-wasm case is slice 4's) ---

  it("P1-2 GUARD (N): a raw native handle held on an RLYN DB, then a declared-wasm owner starts on it in another process: the owner is refused, the file stays RLYN", async () => {
    makeDb(dbPath, NATIVE);
    const before = sha(dbPath); // before the handle is held: this process never fs-reads a DB it holds natively
    const held = await openRawRelayDb(dbPath, { readonly: true });
    try {
      const a = startOwner(dbPath, path.join(caseDir, "owner-config.json"));
      expect(await a.first).toMatch(/^REFUSED /);
      await waitExitOf(a.child);
    } finally {
      held.close();
    }
    expect(sha(dbPath), "the native file is untouched").toBe(before);
  }, 60_000);

  it("P1-2 GUARD (W): a raw native open of an RLYW DB is refused, so no native handle exists for a wasm writer to race", async () => {
    makeDb(dbPath, WASM);
    await expect(openRawRelayDb(dbPath, { readonly: false })).rejects.toThrow(/HTTP/);
  });

  // --- Q2 (the slice-3 ruling): restore REQUIRES -wal/-shm absent at its swap; relay code never unlinks them ---

  it("Q2 (amended): a LIVE opener in another process at the swap: the restore is refused by name (each side file, with its size); the DB, its WAL and the .new state are unchanged, the -shm left in place", async () => {
    makeDb(dbPath, 0, ["row-1"]);
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    const live = await startLiveOpener(dbPath, "idle");
    const state = { db: fileState(dbPath), wal: fileState(`${dbPath}-wal`), shm: fileState(`${dbPath}-shm`), dotNew: fileState(`${dbPath}.new`) };
    expect(state.wal, "precondition: the live opener's -wal is there").not.toBe("absent");
    await expect(importRelayState(archive, { force: true })).rejects.toThrow(/restore refused[\s\S]*-wal[\s\S]*\d+ bytes[\s\S]*external tool's PERSIST\/TRUNCATE or persistent-WAL mode/);
    // The DB and its WAL are byte for byte unchanged, and no .new was made. The -shm is SQLite's shared-memory INDEX
    // (no data): every connection updates it, the safety backup's read-only open and the pre-swap step included, so
    // the row asserts it is still there (never deleted), at its size.
    expect({ db: fileState(dbPath), wal: fileState(`${dbPath}-wal`), dotNew: fileState(`${dbPath}.new`) }, "the DB, its WAL and the .new state are unchanged").toEqual({ db: state.db, wal: state.wal, dotNew: state.dotNew });
    expect(fs.existsSync(`${dbPath}-shm`) ? fs.statSync(`${dbPath}-shm`).size : -1, "the -shm is left in place, at its size").toBe(Number(state.shm.split(":")[0]));
    // Positive control: the live opener still works, through its own connection, and sees exactly its pre-restore rows.
    expect(await ask(live, "read"), "the live opener reads its own rows after the refused restore").toBe(`ROWS ${JSON.stringify(["row-1"])}`);
    live.kill("SIGKILL");
    await waitExitOf(live);
  }, 60_000);

  it.skipIf(process.platform === "win32")("Q2 (amended): a LIVE opener of the CANONICAL REFERENT of a symlinked DB path refuses the restore too (checked beside both names)", async () => {
    const realDir = path.join(caseDir, "real");
    fs.mkdirSync(realDir);
    const real = path.join(realDir, "relay.db");
    makeDb(real, 0, ["row-1"]);
    const link = path.join(caseDir, "link.db");
    fs.symlinkSync(real, link);
    process.env.RELAY_DB_PATH = link;
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    const live = await startLiveOpener(real, "idle");
    const before = fileState(real);
    await expect(importRelayState(archive, { force: true })).rejects.toThrow(/restore refused[\s\S]*-wal/);
    expect(fs.lstatSync(link).isSymbolicLink(), "the link is untouched").toBe(true);
    expect(fileState(real), "the referent is untouched").toBe(before);
    expect(fs.existsSync(`${real}-wal`), "and its -wal is left, not deleted").toBe(true);
    live.kill("SIGKILL");
    await waitExitOf(live);
  }, 60_000);

  it("Q2 (amended): another process holding a READ TRANSACTION makes the pre-swap checkpoint busy: refused by name, nothing replaced, every committed row kept", async () => {
    makeDb(dbPath, 0, ["row-1"]);
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    const live = await startLiveOpener(dbPath, "txn");
    await expect(importRelayState(archive, { force: true })).rejects.toThrow(/restore refused[\s\S]*busy/);
    live.kill("SIGKILL");
    await waitExitOf(live);
    expect(keptRows(dbPath).filter((v) => v.startsWith("live-")).length, "the other process's 20 committed rows are kept (not replaced by the archive)").toBe(20);
  }, 60_000);

  it("Q2 (amended): a KILLED writer's hot WAL at the swap is checkpointed by the bare native close (not unlinked), then the DB is replaced: a native open sees exactly the archive", async () => {
    makeDb(dbPath, 0, ["row-1"]);
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    _setBeforeRestoreSwapForTests(async () => leaveHotWal(dbPath)); // after the safety backup: the stated residual
    try {
      const r = await importRelayState(archive, { force: true });
      expect(r.restored).toBe(true);
    } finally {
      _setBeforeRestoreSwapForTests(null);
    }
    expect(keptRows(dbPath)).toEqual(["row-1"]);
  }, 60_000);

  it("Q2 (amended): the pre-swap step is a BARE connection: on a legacy (0) WAL-mode DB it removes the side files the safety backup created, and stamps, migrates and re-journals nothing", async () => {
    makeDb(dbPath, 0, ["row-1"]);
    const w = new Database(dbPath);
    w.pragma("journal_mode = WAL");
    w.close(); // a writable last close: no side files
    const pages = (f: string) => fs.readFileSync(f).readUInt32BE(28);
    const before = { id: fs.readFileSync(dbPath).readUInt32BE(68), journal: `${fs.readFileSync(dbPath)[18]}/${fs.readFileSync(dbPath)[19]}`, pages: pages(dbPath) };
    expect(before.journal, "precondition: a WAL-mode header").toBe("2/2");
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    const setHook = (backupMod as unknown as { _setAfterRestoreCheckpointForTests?: (fn: ((p: string) => void) | null) => void })._setAfterRestoreCheckpointForTests;
    let seen: Record<string, unknown> | null = null;
    setHook?.((p) => {
      const b = fs.readFileSync(p);
      seen = { id: b.readUInt32BE(68), journal: `${b[18]}/${b[19]}`, pages: b.readUInt32BE(28), wal: fs.existsSync(`${p}-wal`), shm: fs.existsSync(`${p}-shm`) };
    });
    try {
      await importRelayState(archive, { force: true });
    } finally {
      setHook?.(null);
    }
    expect(seen, "the step ran, and the hook after it was reached").not.toBeNull();
    expect(seen).toEqual({ ...before, wal: false, shm: false });
  }, 60_000);

  it("Q2 twin: with the side files gone at the swap (the last opener closed cleanly), the restore succeeds and a native open sees exactly the archive's rows", async () => {
    makeDb(dbPath, 0, ["row-1"]);
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    const live = new Database(dbPath);
    live.pragma("journal_mode = WAL");
    live.prepare("INSERT INTO kept VALUES ('row-2')").run();
    live.close(); // the clean last close checkpoints and removes -wal and -shm
    const r = await importRelayState(archive, { force: true });
    expect(r.restored).toBe(true);
    expect(keptRows(dbPath)).toEqual(["row-1"]);
  }, 60_000);

  it("Q2 (the measure, permanent): a restore NEVER leaves a stale WAL to be replayed: it refuses, or a native open afterwards sees exactly the archive's rows (never the 50 WAL-only rows)", async () => {
    makeDb(dbPath, 0, ["row-1"]);
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    let injected = false;
    _setBeforeRestoreSwapForTests(async () => {
      leaveHotWal(dbPath);
      injected = true;
    });
    let refused = false;
    try {
      await importRelayState(archive, { force: true });
    } catch (e) {
      refused = /restore refused/.test((e as Error).message);
      if (!refused) throw e;
    } finally {
      _setBeforeRestoreSwapForTests(null);
    }
    expect(injected, "the hot-WAL injection ran (the row reached the swap, not an earlier refusal)").toBe(true);
    if (!refused) expect(keptRows(dbPath), "the restored DB shows the archive, not the replayed stale WAL").toEqual(["row-1"]);
  }, 60_000);

  it("Q2: the SAFETY BACKUP of a hot-WAL DB carries the WAL-only rows (it is the only copy of the state the restore replaces)", async () => {
    makeDb(dbPath, 0, ["row-1"]);
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    leaveHotWal(dbPath, 50); // the live state now includes 50 rows that exist ONLY in the -wal
    const r = await importRelayState(archive, { force: true });
    expect(r.restored, "the pre-swap checkpoint removed the side files, so the restore ran").toBe(true);
    expect(r.previous_backup_path).not.toBe("");
    expect(keptRows(dbPath), "the hot WAL was checkpointed, then the DB replaced by the archive").toEqual(["row-1"]);
    // Bring the safety backup back, then read it.
    await importRelayState(r.previous_backup_path, { force: true });
    const rows = keptRows(dbPath);
    expect(rows[0]).toBe("row-1");
    expect(rows.filter((v) => v.startsWith("wal-")).length, "all 50 WAL-only rows are in the safety backup").toBe(50);
  }, 90_000);

  // --- Codex #391 R1, each a RED on e2948f4 ---

  type AfterCheckpoint = (fn: ((p: string, result?: { ran: boolean; why?: string }) => void) | null) => void;
  const setAfterCheckpoint = (backupMod as unknown as { _setAfterRestoreCheckpointForTests?: AfterCheckpoint })._setAfterRestoreCheckpointForTests;
  const setAfterStage = (backupMod as unknown as { _setAfterRestoreStageForTests?: (fn: ((newPath: string, target: string) => void) | null) => void })._setAfterRestoreStageForTests;

  it.skipIf(process.platform === "win32")("R1 P1-1: a restore whose DB path is RETARGETED after its lock was taken (a symlink moved to another, owned DB) is refused by name; that DB and its live owner are untouched", async () => {
    const a = path.join(caseDir, "a.db");
    makeDb(a, WASM);
    const b = path.join(caseDir, "b.db");
    const link = path.join(caseDir, "link.db");
    fs.symlinkSync(a, link);
    process.env.RELAY_DB_PATH = link;
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    const owner = startOwner(b, path.join(caseDir, "owner-config.json"));
    expect(await owner.first, "precondition: another process owns b.db").toBe("READY");
    const theirs = sha(b);
    let retargeted = false;
    _setBeforeRestoreSwapForTests(async () => {
      fs.unlinkSync(link);
      fs.symlinkSync(b, link);
      retargeted = true;
    });
    try {
      await expect(importRelayState(archive, { force: true })).rejects.toThrow(/restore refused[\s\S]*now resolves to/);
    } finally {
      _setBeforeRestoreSwapForTests(null);
    }
    expect(retargeted, "precondition: the link was moved after the lock was taken").toBe(true);
    expect(sha(b), "the other owner's DB is untouched").toBe(theirs);
    expect(await ask(owner.child, "write after-refused-restore"), "and its owner still writes").toBe("WROTE");
    await stopOwner(owner);
  }, 90_000);

  it("R1 P1-2: on a declared-wasm instance the pre-swap step opens NOTHING natively (a legacy DELETE-mode DB): it reports itself skipped, by the declaration", async () => {
    makeDb(dbPath, 0, ["row-1"]);
    declareWasm();
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    let result: unknown = "the hook after the step did not run";
    setAfterCheckpoint?.((_p, r) => {
      result = r;
    });
    try {
      await importRelayState(archive, { force: true });
    } finally {
      setAfterCheckpoint?.(null);
    }
    expect(result).toMatchObject({ ran: false, why: expect.stringMatching(/declares sqlite_driver "wasm"/) });
  }, 60_000);

  it("R1 P2-5: an owned DB that gains a HARD LINK after the lock was taken (during the safety backup) is refused right before the replacement; both names still name the same file", async () => {
    makeDb(dbPath, WASM);
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    const alias = path.join(caseDir, "late-alias.db");
    _setBeforeRestoreSwapForTests(async () => fs.linkSync(dbPath, alias));
    try {
      await expect(importRelayState(archive, { force: true })).rejects.toThrow(/hard link/);
    } finally {
      _setBeforeRestoreSwapForTests(null);
    }
    expect(fs.statSync(alias).ino, "the names were not split").toBe(fs.statSync(dbPath).ino);
  }, 60_000);

  it("R1 table: a side file that appears WHILE the archive is staged into .new refuses the rename (a second stat right before it); the DB is untouched and the staged .new is removed", async () => {
    makeDb(dbPath, 0, ["row-1"]);
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    const before = fileState(dbPath);
    let staged = "";
    setAfterStage?.((newPath, target) => {
      staged = newPath;
      fs.writeFileSync(`${target}-wal`, Buffer.alloc(32)); // a writer's WAL, during the copy
    });
    try {
      await expect(importRelayState(archive, { force: true })).rejects.toThrow(/restore refused[\s\S]*-wal/);
    } finally {
      setAfterStage?.(null);
    }
    expect(staged, "the hook after staging ran").not.toBe("");
    expect(fileState(dbPath), "the DB is untouched").toBe(before);
    expect(fs.existsSync(staged), "the staged .new (this restore's own copy, not a DB name) is removed").toBe(false);
  }, 60_000);

  // --- Codex #391 R1 P2-3 / P2-4 (one predicate: the DB's own instance declaration AND the caller's) ---

  /** Two instances under this test's relay root: A declares `declA` (or has none), B (active) declares native. */
  function twoInstances(declA: string | null): { aDb: string; aCfg: string } {
    const root = path.join(caseDir, ".bot-relay", "instances");
    fs.mkdirSync(path.join(root, "a"), { recursive: true });
    fs.mkdirSync(path.join(root, "b"), { recursive: true });
    const aCfg = path.join(root, "a", "config.json");
    if (declA !== null) fs.writeFileSync(aCfg, declA, { mode: 0o600 });
    fs.writeFileSync(path.join(root, "b", "config.json"), JSON.stringify({ sqlite_driver: "native" }), { mode: 0o600 });
    delete process.env.RELAY_CONFIG_PATH;
    process.env.RELAY_INSTANCE_ID = "b";
    return { aDb: path.join(root, "a", "relay.db"), aCfg };
  }
  const WASM_DECL = JSON.stringify({ sqlite_driver: "wasm" });
  const RELAY_BIN = path.join(REPO, "bin", "relay");
  const cli = (args: string[]) =>
    spawnSync(process.execPath, [RELAY_BIN, ...args], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", HOME: caseDir, USERPROFILE: caseDir, RELAY_INSTANCE_ID: "b", RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(caseDir, "wc.json") },
    });

  it("R1 P2-3: A declares wasm, B (active) is native: A's ABSENT DB through RELAY_DB_PATH is refused by getDb()'s fallback and by a raw open, and nothing is created", async () => {
    const { aDb } = twoInstances(WASM_DECL);
    process.env.RELAY_DB_PATH = aDb;
    expect(() => db.getDb()).toThrow(/declares sqlite_driver "wasm"/);
    await expect(openRawRelayDb(aDb, { readonly: true })).rejects.toThrow(/declares sqlite_driver "wasm"/);
    expect(fs.existsSync(aDb), "nothing was created").toBe(false);
  });

  it("R1 P2-3: A declares wasm, B (active) is native: A's LEGACY (0) DB through RELAY_DB_PATH is refused by a raw open AND by initializeDb (no native init, the file unchanged)", async () => {
    const { aDb } = twoInstances(WASM_DECL);
    makeDb(aDb, 0, ["row-1"]);
    const before = sha(aDb);
    process.env.RELAY_DB_PATH = aDb;
    await expect(openRawRelayDb(aDb, { readonly: true })).rejects.toThrow(/declares sqlite_driver "wasm"/);
    await expect(db.initializeDb()).rejects.toThrow(/declares sqlite_driver "wasm"/);
    expect(sha(aDb), "the file is unchanged (no stamp, no schema)").toBe(before);
  });

  it("R1 P2-3: the same through --db-path (a CLI verb, another process): A's absent DB and A's legacy (0) DB are each refused by name, nothing created or changed", () => {
    const { aDb } = twoInstances(WASM_DECL);
    const absent = cli(["purge-history", "someone", "--db-path", aDb, "--dry-run"]);
    expect(absent.status, absent.stdout + absent.stderr).not.toBe(0);
    expect(absent.stdout + absent.stderr).toMatch(/declares sqlite_driver "wasm"/);
    expect(fs.existsSync(aDb), "nothing was created").toBe(false);
    makeDb(aDb, 0, ["row-1"]);
    const before = sha(aDb);
    const legacy = cli(["purge-history", "someone", "--db-path", aDb, "--dry-run"]);
    expect(legacy.status, legacy.stdout + legacy.stderr).not.toBe(0);
    expect(legacy.stdout + legacy.stderr).toMatch(/declares sqlite_driver "wasm"/);
    expect(sha(aDb), "the file is unchanged").toBe(before);
  }, 60_000);

  it("R1 P2-3: RELAY_CONFIG_PATH names a NATIVE config while the DB's own instance declares wasm → refused (both are consulted; neither alone can allow)", async () => {
    const { aDb } = twoInstances(WASM_DECL);
    makeDb(aDb, 0, ["row-1"]);
    const nativeCfg = path.join(caseDir, "native-config.json");
    fs.writeFileSync(nativeCfg, JSON.stringify({ sqlite_driver: "native" }), { mode: 0o600 });
    process.env.RELAY_CONFIG_PATH = nativeCfg;
    await expect(openRawRelayDb(aDb, { readonly: true })).rejects.toThrow(/declares sqlite_driver "wasm"/);
  });

  it("R1 P2-3 twin: both declarations native → the raw open is allowed", async () => {
    const { aDb } = twoInstances(JSON.stringify({ sqlite_driver: "native" }));
    makeDb(aDb, 0, ["row-1"]);
    const h = await openRawRelayDb(aDb, { readonly: true });
    h.close();
  });

  it("R1 P2-3 twin: a DB with NO instance association (outside every instance dir and the relay home) and a native caller → the header decides: a legacy (0) DB opens", async () => {
    twoInstances(WASM_DECL);
    const elsewhere = path.join(caseDir, "elsewhere", "relay.db");
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    makeDb(elsewhere, 0, ["row-1"]);
    const h = await openRawRelayDb(elsewhere, { readonly: true });
    h.close();
  });

  const unreadable: Array<[string, (cfg: string) => void, boolean]> = [
    ["a parse error", (cfg) => fs.writeFileSync(cfg, '{"sqlite_driver": "wasm"', { mode: 0o600 }), false],
    ["EACCES (mode 000)", (cfg) => {
      fs.writeFileSync(cfg, WASM_DECL, { mode: 0o600 });
      fs.chmodSync(cfg, 0o000);
    }, process.platform === "win32" || process.getuid?.() === 0],
    ["a FIFO", (cfg) => {
      const r = spawnSync("mkfifo", [cfg]);
      if (r.status !== 0) throw new Error(`precondition: mkfifo failed: ${String(r.stderr)}`);
    }, process.platform === "win32"],
  ];
  for (const [label, make, skip] of unreadable) {
    it.skipIf(skip)(`R1 P2-4: the DB's own instance declaration is UNREADABLE (${label}) → a raw native open is refused by name, with the path and the remedy`, async () => {
      const { aDb, aCfg } = twoInstances(null);
      makeDb(aDb, 0, ["row-1"]);
      make(aCfg);
      try {
        await expect(openRawRelayDb(aDb, { readonly: true })).rejects.toThrow(/could not be read[\s\S]*fix or remove that config\.json/i);
      } finally {
        try {
          fs.chmodSync(aCfg, 0o600);
        } catch {
          /* a FIFO or a parse-error file: nothing to restore */
        }
      }
    });
  }

  it("R1 P2-4 twin: the DB's own instance has NO config.json (ENOENT) → no declaration: the raw open is allowed", async () => {
    const { aDb } = twoInstances(null);
    makeDb(aDb, 0, ["row-1"]);
    const h = await openRawRelayDb(aDb, { readonly: true });
    h.close();
  });

  // --- G5: a DB file is never unlinked: a refusal leaves it and names it ---

  it("G5: a materialize whose verification FAILS leaves the created DB in place and the refusal names its path and size", () => {
    const bytes = new Uint8Array(4096).fill(7);
    let msg = "";
    try {
      materializeDb(dbPath, bytes, () => {
        throw new Error("verification refused");
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg, "the refusal propagates").toMatch(/verification refused/);
    expect(fs.existsSync(dbPath), "the created file is NOT unlinked").toBe(true);
    expect(msg, "the refusal names the file left behind").toContain(dbPath);
    expect(msg, "and its size").toMatch(/4096 bytes/);
  });

  it("G5 (ADR-0048 amended): a DB refused after its open is never unlinked: the refusal NAMES the 0-byte file the open created", async () => {
    // Outside the approved roots (this test's HOME and the temp dir): beside the repo, removed at the end.
    const outside = path.join(REPO, `.s3-outside-${process.pid}`);
    fs.mkdirSync(outside, { recursive: true });
    const dir = path.join(caseDir, "racy");
    const configured = path.join(dir, "relay.db");
    process.env.RELAY_DB_PATH = configured;
    const realMkdir = fs.mkdirSync.bind(fs);
    // The racer: when the DB's directory is created, a link to OUTSIDE appears there instead (on Windows an NTFS
    // junction, which needs no privilege, unlike a directory symlink).
    const spy = vi.spyOn(fs, "mkdirSync").mockImplementation(((p: fs.PathLike, o?: unknown) => {
      if (String(p) === dir) {
        fs.symlinkSync(outside, dir, process.platform === "win32" ? "junction" : undefined);
        return undefined;
      }
      return realMkdir(p, o as never);
    }) as never);
    try {
      let msg = "";
      try {
        await db.initializeDb();
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/REFUSING the relay DB after opening it/);
      expect(fs.existsSync(path.join(outside, "relay.db")), "precondition: the native open created the file").toBe(true);
      expect(msg, "the refusal names the file it leaves, by the configured path").toContain(configured);
      expect(msg, "with its size").toMatch(/\(0 bytes\)/);
      expect(msg, "and says it is left in place").toMatch(/LEFT in place/);
    } finally {
      spy.mockRestore();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("G5 twin: a materialize with no verification creates the DB with exactly its first image", () => {
    const bytes = new Uint8Array(4096).fill(9);
    materializeDb(dbPath, bytes);
    expect(Buffer.compare(fs.readFileSync(dbPath), Buffer.from(bytes))).toBe(0);
  });
});
