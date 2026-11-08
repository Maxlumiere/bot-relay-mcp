// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 slice 4 (BREAKING, 5.0.0): `relay convert-journal`, the one way between the native and the wasm driver, and
 * the flip that makes the invariant hold: a wasm DB has ONE owner, always.
 * - convert-journal, native→wasm: pre-checks (no opener live: the stat-only side-file absence, a bare checkpoint) →
 *   journal_mode=DELETE (outside a transaction) → a transaction stamping RLYW → the instance config's sqlite_driver
 *   (written to its canonical referent, every other field and 0600 kept) → verify after close. wasm→native: stamp RLYN
 *   FIRST, then WAL. Idempotent from every intermediate state. It is the ONLY native opener of an RLYW file, under the
 *   owner lock itself.
 * - The flip: a contradicting RELAY_SQLITE_DRIVER refuses; a declared-wasm instance on a 0/N DB refuses; env-only wasm
 *   on an existing 0 DB refuses (naming convert-journal), and on a NEW DB runs the single owner (the legacy no-owner
 *   mode is retired).
 * - Restore re-stamps its private staged copy to the instance's kind (a 0 archive onto a wasm instance becomes W).
 * Each row names the ruling it checks (Q1..Q5 of the slice-4 plan).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import Database from "better-sqlite3";
import * as compat from "../src/sqlite-compat.js";
import * as db from "../src/db.js";
import * as dbHeader from "../src/db-header.js";
import { exportRelayState, importRelayState } from "../src/backup.js";
import { srcProgram } from "./_helpers/ts-binding.js";
import ts from "typescript-legacy";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DB = pathToFileURL(path.join(REPO, "dist", "db.js")).href;
const RELAY_BIN = path.join(REPO, "bin", "relay");
const WASM = 0x524c5957;
const NATIVE = 0x524c594e;
/** Skips, each named: a FILE symlink is privileged on Windows (a junction is directories only). */
const WIN_FILE_SYMLINK = process.platform === "win32";
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "s4-")));
const KEYS = ["HOME", "USERPROFILE", "RELAY_CONFIG_PATH", "RELAY_INSTANCE_ID", "RELAY_SQLITE_DRIVER", "RELAY_DB_PATH"] as const;
let saved: Record<string, string | undefined>;
let caseDir: string;
let dbPath: string;
let cfgPath: string;
const children: ChildProcess[] = [];

type ConvertReport = {
  converted: boolean;
  to: "wasm" | "native";
  header: string;
  journal: string;
  integrity: string;
  config: string;
  /** Which converter ran: the native one, or the sql.js one (a host where the native driver does not load). */
  via?: "native" | "sqljs";
  /** The sql.js converter's safety copy of the original bytes (in the backups directory). */
  safetyCopy?: string;
};
type ConvertMod = {
  convertJournal: (opts: {
    to: "wasm" | "native";
    dbPath?: string;
    _failAfterForTests?: "journal" | "stamp" | "config";
    /** sql.js converter: run after the image is read and before the identity re-check (another writer meanwhile). */
    _beforeReplaceForTests?: () => void;
    /** sql.js converter: replaces the rename of the temp file onto the DB (a planted failure). */
    _renameForTests?: (from: string, to: string) => void;
  }) => Promise<ConvertReport>;
};
/** The module this slice adds (absent on the base: every row that needs it fails there, by name). */
async function convertMod(): Promise<ConvertMod> {
  return (await import("../src/convert-journal.js")) as unknown as ConvertMod;
}

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

const writeCfg = (obj: Record<string, unknown>, file = cfgPath) => fs.writeFileSync(file, JSON.stringify(obj), { mode: 0o600 });
const readCfg = (file = cfgPath) => JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
const header = (f: string) => {
  const b = fs.readFileSync(f);
  return { id: b.readUInt32BE(68), journal: `${b[18]}/${b[19]}` };
};
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
/** A DB with `rows` in table kept, stamped `appId`, in WAL (default) or DELETE mode, cleanly closed. */
function makeDb(file: string, appId: number, rows: string[] = ["row-1", "row-2"], journal: "WAL" | "DELETE" = "WAL"): void {
  const d = new Database(file);
  d.pragma(`journal_mode = ${journal}`);
  if (appId !== 0) d.pragma(`application_id = ${appId}`);
  d.exec("CREATE TABLE kept (v TEXT)");
  for (const r of rows) d.prepare("INSERT INTO kept VALUES (?)").run(r);
  d.close();
}
/** The rows and integrity of `file`, read by a throwaway READ-ONLY raw connection in another process (never this one's). */
const READ = path.join(ROOT, "read.cjs");
fs.writeFileSync(
  READ,
  `const D = require(process.argv[2]); const d = new D(process.argv[3], { readonly: true, fileMustExist: true });\n` +
    `const rows = d.prepare("SELECT v FROM kept ORDER BY rowid").all().map((r) => r.v); const ok = d.pragma("integrity_check", { simple: true });\n` +
    `d.close(); process.stdout.write(JSON.stringify({ rows, ok }));\n`
);
const readOther = (f: string): { rows: string[]; ok: string } =>
  JSON.parse(spawnSync(process.execPath, [READ, path.join(REPO, "node_modules", "better-sqlite3"), f], { encoding: "utf-8" }).stdout) as { rows: string[]; ok: string };
const sideFiles = (f: string) => ["-wal", "-shm", "-journal"].filter((s) => fs.existsSync(f + s));

/** A child that opens the relay DB through dist/db.js (env as given), prints READY or REFUSED <msg>, then idles. */
const OWNER = path.join(ROOT, "owner.mjs");
fs.writeFileSync(
  OWNER,
  `const db = await import(${JSON.stringify(DIST_DB)});\n` +
    `try { await db.initializeDb(); process.stdout.write("READY\\n"); }\n` +
    `catch (e) { process.stdout.write("REFUSED " + String(e && e.message || e).split("\\n")[0] + "\\n"); process.exit(3); }\n` +
    `setInterval(() => {}, 1000);\n`
);
function startOwner(env: Record<string, string>): { child: ChildProcess; first: Promise<string> } {
  const child = spawn(process.execPath, [OWNER], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
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
/** A LIVE native opener in another process (connection pinned: a GC'd better-sqlite3 handle drops its locks). */
const LIVE = path.join(ROOT, "live.cjs");
fs.writeFileSync(
  LIVE,
  `const D = require(process.argv[2]); const d = new D(process.argv[3]); d.prepare("SELECT count(*) FROM kept").get();\n` +
    `globalThis.__pin = d; process.stdout.write("READY\\n"); setInterval(() => { if (!globalThis.__pin.open) process.exit(9); }, 1000);\n`
);
async function startLive(file: string): Promise<ChildProcess> {
  const c = spawn(process.execPath, [LIVE, path.join(REPO, "node_modules", "better-sqlite3"), file], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(c);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("precondition: the live opener did not start")), 20_000);
    c.stdout!.on("data", (d) => String(d).includes("READY") && (clearTimeout(t), res()));
  });
  return c;
}

describe("INV-DB-01 slice 4: `relay convert-journal` (Q1, Q2)", () => {
  it("native→wasm: an RLYN WAL DB becomes RLYW + DELETE, its rows intact, no side file left, the instance config says wasm (other fields and 0600 kept), verified after close", async () => {
    makeDb(dbPath, NATIVE);
    writeCfg({ sqlite_driver: "native", http_port: 4321 });
    const r = await (await convertMod()).convertJournal({ to: "wasm" });
    expect(r).toMatchObject({ converted: true, to: "wasm", header: "wasm", journal: "1/1", integrity: "ok", config: "wasm" });
    expect(header(dbPath)).toEqual({ id: WASM, journal: "1/1" });
    expect(readOther(dbPath)).toEqual({ rows: ["row-1", "row-2"], ok: "ok" });
    expect(sideFiles(dbPath), "no side file left").toEqual([]);
    expect(readCfg()).toEqual({ sqlite_driver: "wasm", http_port: 4321 });
    if (process.platform !== "win32") expect(fs.statSync(cfgPath).mode & 0o777, "the config stays 0600").toBe(0o600);
  }, 60_000);

  it("wasm→native: an RLYW DELETE DB becomes RLYN + WAL, its rows intact, the config says native", async () => {
    makeDb(dbPath, WASM, ["row-1", "row-2"], "DELETE");
    writeCfg({ sqlite_driver: "wasm" });
    const r = await (await convertMod()).convertJournal({ to: "native" });
    expect(r).toMatchObject({ converted: true, to: "native", header: "native", journal: "2/2", integrity: "ok", config: "native" });
    expect(header(dbPath)).toEqual({ id: NATIVE, journal: "2/2" });
    expect(readOther(dbPath).rows).toEqual(["row-1", "row-2"]);
    expect(readCfg().sqlite_driver).toBe("native");
  }, 60_000);

  it("round trip twin: native→wasm→native keeps exactly the rows", async () => {
    makeDb(dbPath, NATIVE, ["a", "b", "c"]);
    writeCfg({ sqlite_driver: "native" });
    const m = await convertMod();
    await m.convertJournal({ to: "wasm" });
    await m.convertJournal({ to: "native" });
    expect(readOther(dbPath)).toEqual({ rows: ["a", "b", "c"], ok: "ok" });
    expect(header(dbPath).id).toBe(NATIVE);
  }, 60_000);

  it("native→wasm is REFUSED while another process has the DB open (a live native opener), and nothing changes", async () => {
    makeDb(dbPath, NATIVE);
    writeCfg({ sqlite_driver: "native" });
    const live = await startLive(dbPath);
    const before = { id: header(dbPath).id, cfg: readCfg() };
    await expect((await convertMod()).convertJournal({ to: "wasm" })).rejects.toThrow(/convert-journal refused[\s\S]*(open|side files)/i);
    live.kill("SIGKILL");
    expect({ id: header(dbPath).id, cfg: readCfg() }, "nothing changed").toEqual(before);
  }, 60_000);

  it("wasm→native is REFUSED while the wasm owner is live (another process holds the single-owner lock)", async () => {
    makeDb(dbPath, WASM, ["row-1"], "DELETE");
    writeCfg({ sqlite_driver: "wasm" });
    const owner = startOwner({ RELAY_DB_PATH: dbPath, RELAY_CONFIG_PATH: cfgPath });
    expect(await owner.first, "precondition: a live owner").toBe("READY");
    const before = sha(dbPath);
    await expect((await convertMod()).convertJournal({ to: "native" })).rejects.toThrow(/convert-journal refused[\s\S]*owned by a live relay process/i);
    expect(sha(dbPath), "the owner's DB is untouched").toBe(before);
  }, 60_000);

  it("Q2: an RLYW DB with more than one hard link, or with a side file beside it, is refused (an anomaly), unchanged", async () => {
    makeDb(dbPath, WASM, ["row-1"], "DELETE");
    writeCfg({ sqlite_driver: "wasm" });
    const m = await convertMod();
    const alias = path.join(caseDir, "alias.db");
    fs.linkSync(dbPath, alias);
    await expect(m.convertJournal({ to: "native" })).rejects.toThrow(/hard link/);
    fs.rmSync(alias);
    fs.writeFileSync(`${dbPath}-journal`, Buffer.alloc(16));
    await expect(m.convertJournal({ to: "native" })).rejects.toThrow(/-journal/);
    expect(header(dbPath).id, "still RLYW").toBe(WASM);
  }, 60_000);

  it.each(["journal", "stamp", "config"] as const)("Q1 crash consistency: a failure right after the %s step leaves a file its header's driver opens, and a RE-RUN completes (idempotent)", async (step) => {
    makeDb(dbPath, NATIVE);
    writeCfg({ sqlite_driver: "native" });
    const m = await convertMod();
    await expect(m.convertJournal({ to: "wasm", _failAfterForTests: step })).rejects.toThrow(/injected failure/);
    const mid = header(dbPath);
    // Every intermediate state is consistent: DELETE-mode RLYN (journal), RLYW + DELETE (stamp, config).
    expect(step === "journal" ? mid : mid.id, `after ${step}`).toEqual(step === "journal" ? { id: NATIVE, journal: "1/1" } : WASM);
    const r = await m.convertJournal({ to: "wasm" });
    expect(r).toMatchObject({ header: "wasm", journal: "1/1", integrity: "ok", config: "wasm" });
    expect(readOther(dbPath).rows).toEqual(["row-1", "row-2"]);
  }, 60_000);

  it.skipIf(WIN_FILE_SYMLINK)("Q1 (2): the config is written to its canonical REFERENT: a symlinked config.json stays a symlink, and its target holds the new driver", async () => {
    makeDb(dbPath, NATIVE);
    const real = path.join(caseDir, "real-config.json");
    writeCfg({ sqlite_driver: "native", other: true }, real);
    fs.symlinkSync(real, cfgPath);
    await (await convertMod()).convertJournal({ to: "wasm" });
    expect(fs.lstatSync(cfgPath).isSymbolicLink(), "the link survives").toBe(true);
    expect(readCfg(real)).toEqual({ sqlite_driver: "wasm", other: true });
  }, 60_000);

  it("Q1 (2): RELAY_CONFIG_PATH naming a DIFFERENT file from the DB's own instance config is refused by name, nothing changed", async () => {
    const instDir = path.join(caseDir, ".bot-relay", "instances", "a");
    fs.mkdirSync(instDir, { recursive: true });
    const aDb = path.join(instDir, "relay.db");
    makeDb(aDb, NATIVE);
    writeCfg({ sqlite_driver: "native" }, path.join(instDir, "config.json"));
    writeCfg({ sqlite_driver: "native" }); // cfgPath: another file
    process.env.RELAY_DB_PATH = aDb;
    process.env.RELAY_INSTANCE_ID = "a";
    await expect((await convertMod()).convertJournal({ to: "wasm" })).rejects.toThrow(/RELAY_CONFIG_PATH[\s\S]*different/i);
    expect(header(aDb).id).toBe(NATIVE);
  }, 60_000);

  it("the CLI: `relay convert-journal --to wasm` converts and says to close every terminal first; an unknown --to is a usage error", () => {
    makeDb(dbPath, NATIVE);
    writeCfg({ sqlite_driver: "native" });
    const env = { PATH: process.env.PATH ?? "", HOME: caseDir, USERPROFILE: caseDir, RELAY_DB_PATH: dbPath, RELAY_CONFIG_PATH: cfgPath, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
    const ok = spawnSync(process.execPath, [RELAY_BIN, "convert-journal", "--to", "wasm"], { encoding: "utf-8", env });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout + ok.stderr).toMatch(/close every (terminal|relay process)/i);
    expect(header(dbPath).id).toBe(WASM);
    const bad = spawnSync(process.execPath, [RELAY_BIN, "convert-journal", "--to", "sideways"], { encoding: "utf-8", env });
    expect(bad.status).toBe(2);
  }, 60_000);

  it("Q2 (narrowed, Codex #401 R1 P3-10): EVERY native better-sqlite3 construction in src is listed with its reason; convert-journal's is the only one that opens a LIVE RLYW file; and every sql.js construction is listed and passes a fresh copy", () => {
    const program = srcProgram();
    // Each site, keyed file::enclosing top-level function, with its count and WHY it may construct a native handle.
    const NATIVE_SITES: Record<string, { n: number; why: string }> = {
      "src/convert-journal.ts::openForConversion": { n: 1, why: "the converter: the ONLY native opener of a LIVE RLYW file, under its single-owner lock" },
      "src/sqlite-compat.ts::openNativeDb": { n: 1, why: "THE general construction every relay native open goes through (its count and claims), including restampStagedCopy's re-stamp of restore's PRIVATE staged copy, which may be RLYW (a staging exception: never a live DB)" },
      "src/sqlite-compat.ts::checkpointBeforeRestoreSwap": { n: 1, why: "an in-memory probe (\":memory:\"), never a file" },
      "src/sqlite-compat.ts::nativeLoadsHere": { n: 1, why: "an in-memory probe (\":memory:\"), never a file" },
      "src/doorbell-lock.ts::openLockFile": { n: 1, why: "the doorbell's OWN lock file (refused when it is a hard link or a relay DB)" },
    };
    const native: Record<string, number> = {};
    for (const sf of program.getSourceFiles()) {
      const rel = path.relative(REPO, sf.fileName).split(path.sep).join("/");
      if (!rel.startsWith("src/") || sf.isDeclarationFile) continue;
      // The enclosing top-level function is passed down the walk (this program's nodes carry no parent links).
      const visit = (n: ts.Node, fnName: string): void => {
        const inner = ts.isFunctionDeclaration(n) && n.name && fnName === "<module>" ? n.name.text : fnName;
        if (ts.isNewExpression(n) && /^(Database|BetterSqlite3|\(loadNative\(\)\)|D)$/.test(n.expression.getText(sf))) {
          const key = `${rel}::${inner}`;
          native[key] = (native[key] ?? 0) + 1;
        }
        ts.forEachChild(n, (c) => visit(c, inner));
      };
      visit(sf, "<module>");
    }
    expect(native, "every native construction in src is listed (a new site fails until it is)").toEqual(
      Object.fromEntries(Object.entries(NATIVE_SITES).map(([k, v]) => [k, v.n]))
    );
    // The slice-4 wasm-only ruling: EVERY sql.js construction in src is listed here with its reason,
    // so a NEW one fails until it is listed. Only convert-journal's REPLACES a live native/legacy file.
    const SQLJS_SITES: Record<string, { n: number; why: string }> = {
      "src/convert-journal.ts::loadImage": { n: 1, why: "the wasm-only converter: the image load and its fresh verify load, under the owner lock; the ONLY sql.js path that replaces a live RLYN/0 file" },
      "src/sqlite-compat.ts::restampStagedCopy": { n: 1, why: "restore's re-stamp (Q5) of its PRIVATE staged copy, never the live DB" },
      "src/sqlite-compat.ts::createOwnedWasmDb": { n: 2, why: "the wasm owner: a NEW DB's first (empty) image, and an RLYW file's bytes under its lock" },
      "src/sqlite-compat.ts::openWasmFromBytes": { n: 1, why: "read-only staging/export reads (openReadOnly, the export source): no write-back" },
    };
    const sqljs: Record<string, number> = {};
    for (const sf of program.getSourceFiles()) {
      const rel = path.relative(REPO, sf.fileName).split(path.sep).join("/");
      if (!rel.startsWith("src/") || sf.isDeclarationFile) continue;
      // The enclosing top-level function is tracked down the walk (this program's nodes carry no parent links).
      const visitSqljs = (n: ts.Node, fnName: string): void => {
        const inner = ts.isFunctionDeclaration(n) && n.name && fnName === "<module>" ? n.name.text : fnName;
        if (ts.isNewExpression(n) && /\.Database$/.test(n.expression.getText(sf))) {
          const key = `${rel}::${inner}`;
          sqljs[key] = (sqljs[key] ?? 0) + 1;
        }
        ts.forEachChild(n, (c) => visitSqljs(c, inner));
      };
      visitSqljs(sf, "<module>");
    }
    expect(sqljs, "every sql.js construction in src is listed (a new site fails until it is)").toEqual(
      Object.fromEntries(Object.entries(SQLJS_SITES).map(([k, v]) => [k, v.n]))
    );
    // sql.js ADOPTS the array it is given: measured on sql.js 1.14.2, the image's edits change it. So every construction
    // passes a FRESH copy (or nothing): no caller's buffer can ever be edited behind its back (the converter's safety
    // copy was once the edited image). Checked at the construction itself, whatever the callers do.
    const unsafe: string[] = [];
    for (const sf of program.getSourceFiles()) {
      const rel = path.relative(REPO, sf.fileName).split(path.sep).join("/");
      if (!rel.startsWith("src/") || sf.isDeclarationFile) continue;
      const visitArgs = (n: ts.Node): void => {
        if (ts.isNewExpression(n) && /\.Database$/.test(n.expression.getText(sf))) {
          const args = n.arguments ?? [];
          const ok = args.length === 0 || (args.length === 1 && /^Uint8Array\.from\(/.test(args[0]!.getText(sf)));
          if (!ok) unsafe.push(`${rel}: ${n.getText(sf)}`);
        }
        ts.forEachChild(n, visitArgs);
      };
      visitArgs(sf);
    }
    expect(unsafe, "every sql.js construction passes Uint8Array.from(...) (a fresh copy) or nothing").toEqual([]);
  }, 120_000);
});

describe("INV-DB-01 slice 4: restore RE-STAMPS its staged copy to the instance's kind (Q5)", () => {
  it("a legacy (0) archive restored onto a WASM instance becomes RLYW + DELETE, its rows intact", async () => {
    makeDb(dbPath, 0, ["archived"], "DELETE");
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "a.tar.gz") })).archive_path;
    fs.rmSync(dbPath);
    makeDb(dbPath, WASM, ["live"], "DELETE");
    writeCfg({ sqlite_driver: "wasm" });
    await importRelayState(archive, { force: true });
    expect(header(dbPath)).toEqual({ id: WASM, journal: "1/1" });
    expect(readOther(dbPath).rows).toEqual(["archived"]);
  }, 60_000);

  it("an RLYW archive restored onto a NATIVE instance becomes RLYN", async () => {
    makeDb(dbPath, WASM, ["archived"], "DELETE");
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "w.tar.gz") })).archive_path;
    fs.rmSync(dbPath);
    makeDb(dbPath, NATIVE, ["live"]);
    writeCfg({ sqlite_driver: "native" });
    await importRelayState(archive, { force: true });
    expect(header(dbPath).id).toBe(NATIVE);
    expect(readOther(dbPath).rows).toEqual(["archived"]);
  }, 60_000);

  it("a declaration that DISAGREES with the live header (declared wasm, the live DB RLYN) refuses the restore by name, nothing replaced", async () => {
    makeDb(dbPath, 0, ["archived"], "DELETE");
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "d.tar.gz") })).archive_path;
    fs.rmSync(dbPath);
    makeDb(dbPath, NATIVE, ["live"]);
    writeCfg({ sqlite_driver: "wasm" });
    const before = sha(dbPath);
    await expect(importRelayState(archive, { force: true })).rejects.toThrow(/restore refused[\s\S]*(declares|disagree)/i);
    expect(sha(dbPath)).toBe(before);
  }, 60_000);
});

describe("INV-DB-01 slice 4, Codex #401 R1: the canonical target, the lock binding, restore's header, the config path", () => {
  const wasmOnly = () => dbHeader._setNativeProbeForTests(() => ({ ok: false, reason: "test: a wasm-only install (npm 12, scripts off)" }));
  afterEach(() => dbHeader._setNativeProbeForTests(null));
  /** dbPath becomes a SYMLINK to a real DB file in its own directory; returns that real file. */
  const symlinkedDb = (): string => {
    const realDir = fs.mkdtempSync(path.join(caseDir, "real-"));
    const real = path.join(realDir, "relay.db");
    return real;
  };

  it.skipIf(WIN_FILE_SYMLINK)("R1 P1-1: a DB SYMLINK whose referent has a HOT WAL is refused (never converted without it): the referent's bytes and its WAL unchanged (skipped on Windows: file symlinks + SIGKILL of self)", async () => {
    const real = symlinkedDb();
    spawnSync(process.execPath, [HOT, path.join(REPO, "node_modules", "better-sqlite3"), real]);
    expect(fs.existsSync(real + "-wal") && fs.statSync(real + "-wal").size > 0, "precondition: a hot WAL beside the REFERENT").toBe(true);
    fs.symlinkSync(real, dbPath);
    const dbSha = sha(real);
    const walSha = sha(real + "-wal");
    writeCfg({});
    wasmOnly();
    await expect((await convertMod()).convertJournal({ to: "wasm" })).rejects.toThrow(/convert-journal refused[\s\S]*-wal/);
    expect(sha(real)).toBe(dbSha);
    expect(sha(real + "-wal")).toBe(walSha);
    expect(fs.lstatSync(dbPath).isSymbolicLink(), "the DB path is still the link").toBe(true);
  }, 60_000);

  it.skipIf(WIN_FILE_SYMLINK)("R1 P1-2 (a): the DB MOVED and its symlink RETARGETED to the moved file mid-conversion (bytes and metadata kept) is refused: nothing replaced (skipped on Windows: file symlinks)", async () => {
    const real = symlinkedDb();
    makeDb(real, 0, ["a"], "DELETE");
    fs.symlinkSync(real, dbPath);
    const movedDir = fs.mkdtempSync(path.join(caseDir, "moved-"));
    const moved = path.join(movedDir, "relay.db");
    const before = sha(real);
    writeCfg({});
    wasmOnly();
    const retarget = () => {
      fs.renameSync(real, moved); // keeps the inode, the size and the mtime
      fs.rmSync(dbPath);
      fs.symlinkSync(moved, dbPath);
    };
    await expect((await convertMod()).convertJournal({ to: "wasm", _beforeReplaceForTests: retarget })).rejects.toThrow(/convert-journal refused/);
    expect(header(moved).id, "the moved file was not replaced").toBe(0);
    expect(sha(moved)).toBe(before);
    expect(readCfg(), "nothing declared").toEqual({});
  }, 60_000);

  it("R1 P1-2 (b): a HARD LINK added to the DB mid-conversion is refused (a rename would split the names into two DBs): nothing replaced", async () => {
    makeDb(dbPath, 0, ["a"], "DELETE");
    const alias = path.join(caseDir, "alias.db");
    const before = sha(dbPath);
    writeCfg({});
    wasmOnly();
    await expect((await convertMod()).convertJournal({ to: "wasm", _beforeReplaceForTests: () => fs.linkSync(dbPath, alias) })).rejects.toThrow(/convert-journal refused[\s\S]*(hard link|links)/);
    expect(header(dbPath).id).toBe(0);
    expect(sha(dbPath)).toBe(before);
    expect(sha(alias)).toBe(before);
  }, 60_000);

  it.skipIf(WIN_FILE_SYMLINK)("R1 P2-7 (a): a DANGLING symlink config.json is refused by name before anything changes: the link is kept, the DB unchanged (skipped on Windows: file symlinks)", async () => {
    makeDb(dbPath, NATIVE, ["a"]);
    const before = sha(dbPath);
    const nowhere = path.join(caseDir, "nowhere", "config.json");
    fs.symlinkSync(nowhere, cfgPath);
    await expect((await convertMod()).convertJournal({ to: "wasm" })).rejects.toThrow(/convert-journal refused[\s\S]*config\.json[\s\S]*(does not exist|dangling)/);
    expect(fs.lstatSync(cfgPath).isSymbolicLink(), "the link is never replaced").toBe(true);
    expect(fs.existsSync(nowhere)).toBe(false);
    expect(sha(dbPath)).toBe(before);
  }, 60_000);

  it.skipIf(WIN_FILE_SYMLINK)("R1 P2-7 (b): an ABSENT config reached through two spellings of a symlinked parent is ONE file (/var vs /private/var), not a mismatch: the conversion runs (skipped on Windows: directory symlinks here need privileges)", async () => {
    const homeReal = path.join(caseDir, ".bot-relay-real");
    fs.mkdirSync(homeReal, { recursive: true });
    const home = path.join(caseDir, ".bot-relay");
    fs.symlinkSync(homeReal, home); // the relay home's spelling is a symlink, as /var is on macOS
    const savedHome = process.env.RELAY_HOME;
    delete process.env.RELAY_HOME;
    try {
      const db2 = path.join(home, "relay.db");
      makeDb(db2, NATIVE, ["a"]);
      process.env.RELAY_DB_PATH = db2;
      process.env.RELAY_CONFIG_PATH = path.join(home, "config.json"); // absent, through the link spelling
      const r = await (await convertMod()).convertJournal({ to: "wasm", dbPath: db2 });
      expect(r.config).toBe("wasm");
      expect(JSON.parse(fs.readFileSync(path.join(homeReal, "config.json"), "utf-8")).sqlite_driver).toBe("wasm");
    } finally {
      if (savedHome === undefined) delete process.env.RELAY_HOME;
      else process.env.RELAY_HOME = savedHome;
    }
  }, 60_000);

  it("R1 P2-5: a restore archive whose DB carries a FOREIGN application_id is refused BEFORE any re-stamp (never converted into a relay DB): the live DB untouched", async () => {
    makeDb(dbPath, 0, ["live"], "DELETE");
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "good.tar.gz") })).archive_path;
    const x = fs.mkdtempSync(path.join(caseDir, "x-"));
    const run = (args: string[], cwd: string) => {
      const r = spawnSync("tar", args, { cwd, encoding: "utf-8", env: { ...process.env, COPYFILE_DISABLE: "1" } });
      if (r.status !== 0) throw new Error(`tar ${args.join(" ")}: ${r.stderr}`);
    };
    run(["-xzf", archive], x);
    fs.rmSync(path.join(x, "relay.db"));
    makeDb(path.join(x, "relay.db"), 0x12345678, ["foreign_row"], "DELETE");
    const forged = path.join(caseDir, "foreign.tar.gz");
    run(["--format=ustar", "-czf", forged, "relay.db", "manifest.json"], x);
    const before = sha(dbPath);
    await expect(importRelayState(forged, { force: true })).rejects.toThrow(/not the relay's|foreign/i);
    expect(sha(dbPath), "the live DB is untouched").toBe(before);
    expect(readOther(dbPath).rows).toEqual(["live"]);
  }, 60_000);

  it("R1 P2-6: an EXPLICIT sqlite_driver \"native\" over a live RLYW DB refuses the restore by name (the disagreement is symmetric), nothing replaced", async () => {
    makeDb(dbPath, NATIVE, ["archived"]);
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "n.tar.gz") })).archive_path;
    fs.rmSync(dbPath);
    makeDb(dbPath, WASM, ["live"], "DELETE");
    writeCfg({ sqlite_driver: "native" });
    const before = sha(dbPath);
    await expect(importRelayState(archive, { force: true })).rejects.toThrow(/restore refused[\s\S]*declares sqlite_driver "native"[\s\S]*disagree/);
    expect(sha(dbPath)).toBe(before);
  }, 60_000);

  it("R1 P2-6 twin (as designed): an ENV-ONLY RELAY_SQLITE_DRIVER=native on a SILENT instance over a live RLYW DB is not a declaration: the header decides (wasm), the restore runs", async () => {
    makeDb(dbPath, WASM, ["archived"], "DELETE");
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "w.tar.gz") })).archive_path;
    writeCfg({});
    process.env.RELAY_SQLITE_DRIVER = "native";
    await importRelayState(archive, { force: true });
    expect(header(dbPath).id).toBe(WASM);
  }, 60_000);
});

describe("INV-DB-01 slice 4: the flip: one owner, always (Q3, Q4; BREAKING 5.0.0)", () => {
  it("Q3: env-only RELAY_SQLITE_DRIVER=wasm on an EXISTING legacy (0) DB is refused by name, naming `relay convert-journal` (the legacy no-owner mode is retired)", async () => {
    makeDb(dbPath, 0, ["row-1"], "DELETE");
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const before = sha(dbPath);
    await expect(db.initializeDb()).rejects.toThrow(/relay convert-journal/);
    expect(sha(dbPath)).toBe(before);
  }, 60_000);

  it("Q3: env-only RELAY_SQLITE_DRIVER=wasm creating a NEW DB runs the single OWNER: the DB is born RLYW, and a second process is refused", async () => {
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    await db.initializeDb();
    db.closeDb();
    compat.closeInitializedDb();
    expect(header(dbPath).id, "born stamped for its owner").toBe(WASM);
    const a = startOwner({ RELAY_DB_PATH: dbPath, RELAY_CONFIG_PATH: cfgPath, RELAY_SQLITE_DRIVER: "wasm" });
    expect(await a.first).toBe("READY");
    const b = startOwner({ RELAY_DB_PATH: dbPath, RELAY_CONFIG_PATH: cfgPath, RELAY_SQLITE_DRIVER: "wasm" });
    expect(await b.first, "one owner").toMatch(/^REFUSED /);
  }, 90_000);

  it("Q4 (the slice-3 residual): env-only wasm on a NON-colocated custom path with a legacy (0) DB is refused", async () => {
    const custom = path.join(caseDir, "custom", "place", "relay.db");
    fs.mkdirSync(path.dirname(custom), { recursive: true });
    makeDb(custom, 0, ["row-1"], "DELETE");
    process.env.RELAY_DB_PATH = custom;
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    await expect(db.initializeDb()).rejects.toThrow(/relay convert-journal/);
  }, 60_000);

  it.each([
    ["declares native, env says wasm", "native", "wasm"],
    ["declares wasm, env says native", "wasm", "native"],
  ] as const)("the flip: a CONTRADICTING env override (%s) is refused by name with the remedy (before: warned, the instance won)", async (_label, declared, env) => {
    makeDb(dbPath, declared === "wasm" ? WASM : NATIVE, ["row-1"], declared === "wasm" ? "DELETE" : "WAL");
    writeCfg({ sqlite_driver: declared });
    process.env.RELAY_SQLITE_DRIVER = env;
    await expect(db.initializeDb()).rejects.toThrow(/RELAY_SQLITE_DRIVER[\s\S]*(remove|unset)/i);
  }, 60_000);

  it.each([
    ["a legacy (0) DB", 0],
    ["an RLYN DB", NATIVE],
  ] as const)("the flip: a declared-WASM instance on %s is refused by name, naming `relay convert-journal` (before: the legacy mode, warned)", async (_label, appId) => {
    makeDb(dbPath, appId, ["row-1"], "DELETE");
    writeCfg({ sqlite_driver: "wasm" });
    await expect(db.initializeDb()).rejects.toThrow(/relay convert-journal/);
  }, 60_000);

  it("twin: a NATIVE instance with no env override opens as before (RLYN)", async () => {
    makeDb(dbPath, NATIVE);
    writeCfg({ sqlite_driver: "native" });
    await db.initializeDb();
    db.closeDb();
    expect(header(dbPath).id).toBe(NATIVE);
  }, 60_000);

  it("twin: a declared-wasm instance on its RLYW DB opens as its owner", async () => {
    makeDb(dbPath, WASM, ["row-1"], "DELETE");
    writeCfg({ sqlite_driver: "wasm" });
    await db.initializeDb();
    expect(compat.getActiveDriver()).toBe("wasm");
  }, 60_000);
});

/** A DB whose last commits are only in a HOT WAL: a child commits, then kills itself without closing. */
const HOT = path.join(ROOT, "hot-wal.cjs");
fs.writeFileSync(
  HOT,
  `const D = require(process.argv[2]); const f = process.argv[3];\n` +
    `let d = new D(f); d.pragma("journal_mode = WAL"); d.exec("CREATE TABLE kept (v TEXT); INSERT INTO kept VALUES ('checkpointed')"); d.close();\n` +
    `d = new D(f); d.pragma("wal_autocheckpoint = 0"); d.prepare("INSERT INTO kept VALUES ('only-in-the-wal')").run();\n` +
    `process.kill(process.pid, "SIGKILL");\n`
);
const rowCount = (f: string) => readOther(f).rows.length;

describe("INV-DB-01 slice 4: the wasm-only converter (sql.js, native→wasm; the slice-4 ruling)", () => {
  const wasmOnly = () => dbHeader._setNativeProbeForTests(() => ({ ok: false, reason: "test: a wasm-only install (npm 12, scripts off)" }));
  afterEach(() => dbHeader._setNativeProbeForTests(null));

  it.each([
    ["a legacy (0) DB in DELETE mode", 0, "DELETE"],
    ["an RLYN DB in WAL mode", NATIVE, "WAL"],
  ] as const)("%s on a host where native does not load becomes RLYW + DELETE through sql.js, row counts equal, the config says wasm", async (_label, appId, journal) => {
    makeDb(dbPath, appId, ["a", "b", "c"], journal);
    writeCfg({ http_port: 3777 });
    wasmOnly();
    const r = await (await convertMod()).convertJournal({ to: "wasm" });
    expect(r.via, "the sql.js converter ran").toBe("sqljs");
    expect({ header: r.header, journal: r.journal, integrity: r.integrity, config: r.config }).toEqual({ header: "wasm", journal: "1/1", integrity: "ok", config: "wasm" });
    expect(header(dbPath)).toEqual({ id: WASM, journal: "1/1" });
    expect(readOther(dbPath)).toEqual({ rows: ["a", "b", "c"], ok: "ok" });
    expect(sideFiles(dbPath)).toEqual([]);
    expect(readCfg()).toEqual({ http_port: 3777, sqlite_driver: "wasm" });
  }, 60_000);

  it("the safety copy is byte-equal to the original, 0600, in the backups directory", async () => {
    makeDb(dbPath, 0, ["a"], "DELETE");
    const before = sha(dbPath);
    writeCfg({});
    wasmOnly();
    const r = await (await convertMod()).convertJournal({ to: "wasm" });
    expect(r.safetyCopy, "the report names the safety copy").toBeTruthy();
    expect(path.dirname(r.safetyCopy!)).toBe(path.join(caseDir, "backups"));
    expect(sha(r.safetyCopy!), "byte-equal to the original").toBe(before);
    if (process.platform !== "win32") expect(fs.statSync(r.safetyCopy!).mode & 0o777).toBe(0o600);
  }, 60_000);

  it.skipIf(process.platform === "win32")("a HOT WAL (commits only in -wal) is refused, never dropped: the DB and WAL bytes are unchanged, and the remedy names a checkpoint (skipped on Windows: SIGKILL of self)", async () => {
    spawnSync(process.execPath, [HOT, path.join(REPO, "node_modules", "better-sqlite3"), dbPath]);
    expect(fs.existsSync(dbPath + "-wal") && fs.statSync(dbPath + "-wal").size > 0, "precondition: a hot WAL").toBe(true);
    const dbSha = sha(dbPath);
    const walSha = sha(dbPath + "-wal");
    writeCfg({});
    wasmOnly();
    await expect((await convertMod()).convertJournal({ to: "wasm" })).rejects.toThrow(/convert-journal refused[\s\S]*-wal[\s\S]*wal_checkpoint\(TRUNCATE\)/);
    expect(sha(dbPath)).toBe(dbSha);
    expect(sha(dbPath + "-wal")).toBe(walSha);
    expect(readCfg()).toEqual({});
  }, 60_000);

  it.each(["-wal", "-shm"])("an EMPTY %s beside the DB is refused, nothing changed", async (side) => {
    makeDb(dbPath, 0, ["a"], "DELETE");
    fs.writeFileSync(dbPath + side, "");
    const before = sha(dbPath);
    writeCfg({});
    wasmOnly();
    await expect((await convertMod()).convertJournal({ to: "wasm" })).rejects.toThrow(new RegExp(`convert-journal refused[\\s\\S]*${side}`));
    expect(sha(dbPath)).toBe(before);
    expect(header(dbPath).id).toBe(0);
  }, 60_000);

  it("the main file CHANGED between the read and the rename (another writer) is refused, nothing replaced", async () => {
    makeDb(dbPath, 0, ["a"], "DELETE");
    writeCfg({});
    wasmOnly();
    const write = () => {
      const d = new Database(dbPath);
      d.prepare("INSERT INTO kept VALUES ('late')").run();
      d.close();
    };
    await expect((await convertMod()).convertJournal({ to: "wasm", _beforeReplaceForTests: write })).rejects.toThrow(/convert-journal refused[\s\S]*changed/i);
    expect(header(dbPath).id, "not replaced: still the legacy file").toBe(0);
    expect(readOther(dbPath).rows, "the late write is intact").toEqual(["a", "late"]);
    expect(readCfg()).toEqual({});
  }, 60_000);

  it("a planted RENAME failure leaves the original intact and names the temp file (never a copy over in place)", async () => {
    makeDb(dbPath, 0, ["a", "b"], "DELETE");
    const before = sha(dbPath);
    writeCfg({});
    wasmOnly();
    let tmp = "";
    const fail = (from: string) => {
      tmp = from;
      throw Object.assign(new Error("EXDEV: planted rename failure"), { code: "EXDEV" });
    };
    const err = await (await convertMod()).convertJournal({ to: "wasm", _renameForTests: fail }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/convert-journal refused/);
    expect(tmp, "the rename was attempted with a temp file").not.toBe("");
    expect(err?.message, "the refusal names the temp").toContain(tmp);
    expect(path.basename(tmp).startsWith("."), "the temp is a dotfile, outside SQLite's side-file names").toBe(true);
    expect(sha(dbPath), "the original is intact").toBe(before);
    expect(readCfg(), "the config is written only after the file").toEqual({});
  }, 60_000);

  it("the step ORDER: the safety copy is on disk BEFORE the first edit: an edit that fails leaves the copy (byte-equal, 0600) and the live file untouched", async () => {
    makeDb(dbPath, 0, ["a", "b"], "DELETE");
    const before = sha(dbPath);
    writeCfg({});
    wasmOnly();
    // TEST-ONLY seam: sql.js memoises its module (initSqlJs returns the SAME SQL object to every caller), so patching the
    // Database prototype here reaches the converter's image. The FIRST edit (journal_mode=DELETE) fails, as a crash
    // mid-edit would.
    const SQL = await ((await import("sql.js")) as unknown as { default: () => Promise<{ Database: { prototype: { exec(sql: string): unknown } } }> }).default();
    const proto = SQL.Database.prototype;
    const exec = proto.exec;
    proto.exec = function (this: unknown, sql: string) {
      if (/journal_mode\s*=\s*DELETE/i.test(sql)) throw new Error("injected: the first edit fails");
      return exec.call(this, sql);
    };
    try {
      await expect((await convertMod()).convertJournal({ to: "wasm" })).rejects.toThrow(/injected: the first edit fails/);
    } finally {
      proto.exec = exec;
    }
    const backups = path.join(caseDir, "backups");
    const copies = fs.existsSync(backups) ? fs.readdirSync(backups).filter((f) => f.includes(".pre-convert-")) : [];
    expect(copies, "the safety copy was written before the edit").toHaveLength(1);
    const copy = path.join(backups, copies[0]!);
    expect(sha(copy), "byte-equal to the original").toBe(before);
    if (process.platform !== "win32") expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
    expect(sha(dbPath), "the live file is untouched").toBe(before);
    expect(readCfg(), "nothing declared").toEqual({});
  }, 60_000);

  it("twin: wasm→native on a host where native does not load is refused by name (it needs the native driver)", async () => {
    makeDb(dbPath, WASM, ["a"], "DELETE");
    writeCfg({ sqlite_driver: "wasm" });
    wasmOnly();
    await expect((await convertMod()).convertJournal({ to: "native" })).rejects.toThrow(/convert-journal refused[\s\S]*native driver/);
    expect(header(dbPath).id).toBe(WASM);
  }, 60_000);

  it("twin: on a host where native DOES load, native→wasm runs the native converter (no safety copy needed)", async () => {
    makeDb(dbPath, 0, ["a"], "DELETE");
    writeCfg({});
    const r = await (await convertMod()).convertJournal({ to: "wasm" });
    expect(r.via).toBe("native");
    expect(rowCount(dbPath)).toBe(1);
  }, 60_000);
});

// --- Codex #401 R1 design items, as ruled: native writers during a conversion (P1-3), hot journals (P2-8) ---

const DIST_COMPAT = pathToFileURL(path.join(REPO, "dist", "sqlite-compat.js")).href;
/** A child that HOLDS the DB's single-owner lock (as a conversion does), prints READY, then idles. */
const HOLD = path.join(ROOT, "hold-lock.mjs");
fs.writeFileSync(
  HOLD,
  `const c = await import(${JSON.stringify(DIST_COMPAT)});\n` +
    `try { await c.holdOwnerForMaintenance(process.argv[2], "convert-journal"); process.stdout.write("READY\\n"); }\n` +
    `catch (e) { process.stdout.write("REFUSED " + String(e && e.message || e).split("\\n")[0] + "\\n"); process.exit(3); }\n` +
    `setInterval(() => {}, 1000);\n`
);
/** A child that opens the DB natively and HOLDS a transaction: "read" (SHARED) or "write" (RESERVED, a journal on disk). */
const TXN = path.join(ROOT, "hold-txn.cjs");
fs.writeFileSync(
  TXN,
  `const D = require(process.argv[2]); const d = new D(process.argv[3], { timeout: 0 });\n` +
    `if (process.argv[4] === "write") { d.exec("BEGIN IMMEDIATE"); d.prepare("INSERT INTO kept VALUES ('held')").run(); }\n` +
    `else { d.exec("BEGIN"); d.prepare("SELECT * FROM kept").all(); }\n` +
    `process.stdout.write("READY\\n"); setInterval(() => {}, 1000);\n`
);
/**
 * A child that leaves a HOT journal: the stamp's transaction, its pages spilled, then killed before COMMIT. MEASURED:
 * page 1 is not spilled (its header still reads 0), so hotJournalAtStamp() then writes the RLYW stamp into the main
 * file's header: the on-disk state of a crash between COMMIT writing page 1 and deleting the journal (the journal holds
 * the original page 1). That instant cannot be hit with a kill.
 */
const HOTJ = path.join(ROOT, "hot-journal.cjs");
fs.writeFileSync(
  HOTJ,
  `const D = require(process.argv[2]); const d = new D(process.argv[3]); d.pragma("journal_mode = DELETE"); d.pragma("cache_size = 2");\n` +
    `d.exec("BEGIN IMMEDIATE"); d.pragma("application_id = ${WASM}");\n` +
    `const ins = d.prepare("INSERT INTO kept VALUES (?)"); for (let i = 0; i < 4000; i++) ins.run("spill-" + i + "-" + "x".repeat(200));\n` +
    `process.kill(process.pid, "SIGKILL");\n`
);
function hotJournalAtStamp(file: string): void {
  spawnSync(process.execPath, [HOTJ, path.join(REPO, "node_modules", "better-sqlite3"), file]);
  const fd = fs.openSync(file, "r+");
  try {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(WASM, 0);
    fs.writeSync(fd, b, 0, 4, 68);
  } finally {
    fs.closeSync(fd);
  }
}
function startChild(script: string, args: string[]): { child: ChildProcess; first: Promise<string> } {
  const child = spawn(process.execPath, [script, ...args], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
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
const BSQ3 = () => path.join(REPO, "node_modules", "better-sqlite3");
const lockFileOf = (f: string) => path.join(path.dirname(fs.realpathSync.native(f)), `.${path.basename(fs.realpathSync.native(f))}.relay-owner`);

describe("INV-DB-01 slice 4, Codex #401 R1 P1-3 (ruled): native openers during a conversion; P2-8: hot journals", () => {
  const wasmOnly = () => dbHeader._setNativeProbeForTests(() => ({ ok: false, reason: "test: a wasm-only install (npm 12, scripts off)" }));
  afterEach(() => dbHeader._setNativeProbeForTests(null));

  it("(1a) a relay NATIVE opener (openRawRelayDb, initializeDb) refuses while ANOTHER process holds the DB's owner lock (a conversion), on a native (RLYN) DB", async () => {
    makeDb(dbPath, NATIVE, ["a"]);
    writeCfg({});
    const h = startChild(HOLD, [dbPath]);
    expect(await h.first, "precondition: the other process holds the lock").toBe("READY");
    const { openRawRelayDb } = await import("../src/cli/_instance-db.js");
    await expect(openRawRelayDb(dbPath)).rejects.toThrow(/owner lock|being converted|owned by/i);
    await expect(db.initializeDb()).rejects.toThrow(/owner lock|being converted|owned by/i);
  }, 60_000);

  it("(1a) twin: with NO holder, a native open works, and its probe CREATES no lock file (non-creating)", async () => {
    makeDb(dbPath, NATIVE, ["a"]);
    writeCfg({});
    await db.initializeDb();
    db.closeDb();
    expect(fs.existsSync(lockFileOf(dbPath)), "the probe never creates the owner lock file").toBe(false);
  }, 60_000);

  it("(1b) a native conversion while another process holds a READ transaction (SHARED) on a DELETE-mode DB is refused BY NAME (BEGIN EXCLUSIVE across the stamp): the DB unchanged", async () => {
    makeDb(dbPath, NATIVE, ["a"], "DELETE");
    const before = sha(dbPath);
    writeCfg({});
    const r = startChild(TXN, [BSQ3(), dbPath, "read"]);
    expect(await r.first).toBe("READY");
    await expect((await convertMod()).convertJournal({ to: "wasm" })).rejects.toThrow(/convert-journal refused[\s\S]*(in use|another process)/);
    expect(sha(dbPath)).toBe(before);
    expect(readCfg()).toEqual({});
  }, 60_000);

  it("(1d) sql.js: a write that lands on the ORIGINAL file after the identity check (at the rename) is reported as a FAILURE, never a success: the late bytes are saved beside the safety copy, and the remedy is named", async () => {
    makeDb(dbPath, 0, ["a"], "DELETE");
    writeCfg({});
    wasmOnly();
    const late = (from: string, to: string) => {
      const d = new Database(to);
      d.prepare("INSERT INTO kept VALUES ('late')").run();
      d.close();
      fs.renameSync(from, to);
    };
    const err = await (await convertMod()).convertJournal({ to: "wasm", _renameForTests: late }).then(() => null, (e: Error) => e);
    expect(err?.message, "never a success").toMatch(/convert-journal (refused|FAILED)[\s\S]*(changed|written|lost)/i);
    const backups = path.join(caseDir, "backups");
    const saved = fs.readdirSync(backups).filter((f) => !f.includes(".pre-convert-"));
    expect(saved.length, `the late bytes are saved beside the safety copy (${fs.readdirSync(backups).join(", ")})`).toBeGreaterThanOrEqual(1);
    const rows = saved.flatMap((f) => readOther(path.join(backups, f)).rows);
    expect(rows, "the saved file holds the late write").toContain("late");
    expect(err?.message).toContain(path.join(backups, saved[0]!));
  }, 60_000);

  it.skipIf(process.platform === "win32")("(P2-8) an interrupted stamp COMMIT (RLYW header spilled + a HOT journal) is RECOVERED by the rerun: SQLite rolls it back, then the conversion completes, the rows the original ones (skipped on Windows: SIGKILL of self)", async () => {
    makeDb(dbPath, 0, ["orig-1", "orig-2"], "DELETE");
    hotJournalAtStamp(dbPath);
    expect(fs.existsSync(dbPath + "-journal") && fs.statSync(dbPath + "-journal").size > 0, "precondition: a hot journal").toBe(true);
    expect(header(dbPath).id, "precondition: the spilled header reads RLYW (the crash window)").toBe(WASM);
    writeCfg({});
    const r = await (await convertMod()).convertJournal({ to: "wasm" });
    expect({ header: r.header, journal: r.journal, integrity: r.integrity }).toEqual({ header: "wasm", journal: "1/1", integrity: "ok" });
    expect(readOther(dbPath).rows, "the killed transaction was rolled back").toEqual(["orig-1", "orig-2"]);
    expect(sideFiles(dbPath)).toEqual([]);
  }, 60_000);

  it("(P2-8) a journal of a LIVE writer (RESERVED held by another process: not hot) is refused by name, the writer's transaction intact", async () => {
    makeDb(dbPath, 0, ["a"], "DELETE");
    writeCfg({});
    const w = startChild(TXN, [BSQ3(), dbPath, "write"]);
    expect(await w.first).toBe("READY");
    // Preconditions, MEASURED here (one native-binary run converted anyway, 8 Nov): the writer's journal is on disk, and
    // the writer really holds its lock (a probe connection of this process is BUSY).
    expect(fs.existsSync(dbPath + "-journal"), "precondition: the live writer's journal exists").toBe(true);
    const probe = new Database(dbPath, { timeout: 0 });
    let busy = "";
    try {
      probe.exec("BEGIN IMMEDIATE");
      probe.exec("ROLLBACK");
    } catch (e) {
      busy = (e as { code?: string }).code ?? String(e);
    } finally {
      probe.close();
    }
    expect(busy, "precondition: the writer holds RESERVED (this probe is BUSY)").toBe("SQLITE_BUSY");
    await expect((await convertMod()).convertJournal({ to: "wasm" })).rejects.toThrow(/convert-journal refused/);
    expect(header(dbPath).id, "not converted").toBe(0);
    expect(fs.existsSync(dbPath + "-journal"), "the live writer's journal is intact (never rolled back)").toBe(true);
  }, 60_000);

  it.skipIf(process.platform === "win32")("(P2-8) native-less: a hot journal is refused with the named remedy (an integrity_check with every relay process stopped) (skipped on Windows: SIGKILL of self)", async () => {
    makeDb(dbPath, 0, ["orig"], "DELETE");
    hotJournalAtStamp(dbPath);
    expect(fs.existsSync(dbPath + "-journal"), "precondition: a hot journal").toBe(true);
    writeCfg({});
    wasmOnly();
    await expect((await convertMod()).convertJournal({ to: "wasm" })).rejects.toThrow(/convert-journal refused[\s\S]*sqlite3 [\s\S]*PRAGMA integrity_check;[\s\S]*every relay process stopped/);
  }, 60_000);
});

