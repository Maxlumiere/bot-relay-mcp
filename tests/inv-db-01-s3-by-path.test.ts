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
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
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

  it("Q2: a HOT stale WAL beside the DB at the swap: the restore is refused by name (each side file, with its size); the DB, its side files and the .new state are unchanged", async () => {
    makeDb(dbPath, 0, ["row-1"]);
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    let state: Record<string, string> = {};
    _setBeforeRestoreSwapForTests(async () => {
      leaveHotWal(dbPath); // another opener, after this restore closed its own handle
      state = { db: fileState(dbPath), wal: fileState(`${dbPath}-wal`), shm: fileState(`${dbPath}-shm`), dotNew: fileState(`${dbPath}.new`) };
    });
    try {
      await expect(importRelayState(archive, { force: true })).rejects.toThrow(/restore refused[\s\S]*-wal[\s\S]*\d+ bytes/);
    } finally {
      _setBeforeRestoreSwapForTests(null);
    }
    expect(state.wal, "precondition: a hot -wal was there at the swap").not.toBe("absent");
    expect({ db: fileState(dbPath), wal: fileState(`${dbPath}-wal`), shm: fileState(`${dbPath}-shm`), dotNew: fileState(`${dbPath}.new`) }, "nothing changed").toEqual(state);
  }, 60_000);

  it.skipIf(process.platform === "win32")("Q2: a hot stale WAL beside the CANONICAL REFERENT of a symlinked DB path refuses the restore too (checked beside both names)", async () => {
    const realDir = path.join(caseDir, "real");
    fs.mkdirSync(realDir);
    const real = path.join(realDir, "relay.db");
    makeDb(real, 0, ["row-1"]);
    const link = path.join(caseDir, "link.db");
    fs.symlinkSync(real, link);
    process.env.RELAY_DB_PATH = link;
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    let before = "";
    _setBeforeRestoreSwapForTests(async () => {
      leaveHotWal(real);
      before = fileState(real);
    });
    try {
      await expect(importRelayState(archive, { force: true })).rejects.toThrow(/restore refused[\s\S]*-wal/);
    } finally {
      _setBeforeRestoreSwapForTests(null);
    }
    expect(fs.lstatSync(link).isSymbolicLink(), "the link is untouched").toBe(true);
    expect(fileState(real), "the referent is untouched").toBe(before);
    expect(fs.existsSync(`${real}-wal`), "and its -wal is left, not deleted").toBe(true);
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
    _setBeforeRestoreSwapForTests(async () => leaveHotWal(dbPath));
    let refused = false;
    try {
      await importRelayState(archive, { force: true });
    } catch (e) {
      refused = /restore refused/.test((e as Error).message);
      if (!refused) throw e;
    } finally {
      _setBeforeRestoreSwapForTests(null);
    }
    if (!refused) expect(keptRows(dbPath), "the restored DB shows the archive, not the replayed stale WAL").toEqual(["row-1"]);
  }, 60_000);

  it("Q2: the SAFETY BACKUP of a hot-WAL DB carries the WAL-only rows (it is the only copy of the state the restore replaces)", async () => {
    makeDb(dbPath, 0, ["row-1"]);
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    leaveHotWal(dbPath, 50); // the live state now includes 50 rows that exist ONLY in the -wal
    const r = await importRelayState(archive, { force: true });
    expect(r.restored, "precondition: the safety backup's clean close removed the side files, so the restore ran").toBe(true);
    expect(r.previous_backup_path).not.toBe("");
    // Bring the safety backup back, then read it.
    await importRelayState(r.previous_backup_path, { force: true });
    const rows = keptRows(dbPath);
    expect(rows[0]).toBe("row-1");
    expect(rows.filter((v) => v.startsWith("wal-")).length, "all 50 WAL-only rows are in the safety backup").toBe(50);
  }, 90_000);

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

  it("G5 twin: a materialize with no verification creates the DB with exactly its first image", () => {
    const bytes = new Uint8Array(4096).fill(9);
    materializeDb(dbPath, bytes);
    expect(Buffer.compare(fs.readFileSync(dbPath), Buffer.from(bytes))).toBe(0);
  });
});
