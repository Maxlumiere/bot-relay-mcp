// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 slice 2b-ii: the wasm single owner (rulings 5aa0c030, cd11ffa7, and the 2b-ii rulings).
 * - OWNER MODE comes only from the instance declaration `sqlite_driver: "wasm"` (on a new DB), or from an RLYW header
 *   (whatever the env). An owner takes the single-owner lock (one per DB, kernel-held), creates a new DB already
 *   stamped RLYW (it appears complete, by a link), persists atomically (temp + rename) under the lock, and refuses a
 *   persist when the file was replaced by another writer.
 * - A second process on an owned DB is refused by name; the owner's exit releases it.
 * - Native-only openers and a stdio server on an RLYW DB are refused, with a copy-pasteable HTTP client config.
 * - Legacy env-wasm (`RELAY_SQLITE_DRIVER=wasm` with no instance declaration) never stamps RLYW; an owner never adopts
 *   a legacy (0) file. A declaration that the env contradicts wins, and the env warns.
 * Processes are real (children running dist/), each recorded by pid and killed at the end.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import Database from "better-sqlite3";
import * as compat from "../src/sqlite-compat.js";
import * as db from "../src/db.js";
import * as header from "../src/db-header.js";
import { openRawRelayDb } from "../src/cli/_instance-db.js";
import { exportRelayState, importRelayState } from "../src/backup.js";
import { log } from "../src/logger.js";
import { _takeFsSpyViolations } from "./_setup/no-fs-on-held-db.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DB = pathToFileURL(path.join(REPO, "dist", "db.js")).href;
const DIST_INDEX = path.join(REPO, "dist", "index.js");
const WASM = 0x524c5957;
const NATIVE = 0x524c594e;
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "s2bii-")));
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
  vi.restoreAllMocks();
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const declareWasm = () => fs.writeFileSync(cfgPath, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
/** The application_id in the main file, read by ANOTHER process. */
const READ_ID = path.join(ROOT, "read-id.cjs");
fs.writeFileSync(READ_ID, `const b=require("fs").readFileSync(process.argv[2]); process.stdout.write(String(b.length>=72?b.readInt32BE(68):"short:"+b.length));\n`);
const idOf = (f: string) => spawnSync(process.execPath, [READ_ID, f], { encoding: "utf8" }).stdout;
function makeDb(file: string, appId: number): void {
  const d = new Database(file);
  d.pragma("journal_mode = DELETE");
  if (appId !== 0) d.pragma(`application_id = ${appId}`);
  d.exec("CREATE TABLE kept (v TEXT); INSERT INTO kept VALUES ('row-1');");
  d.close();
}

/** A child that opens the relay DB through dist/db.js (env as given), prints READY or REFUSED <msg>, then idles. */
const OWNER = path.join(ROOT, "owner.mjs");
fs.writeFileSync(
  OWNER,
  `const db = await import(${JSON.stringify(DIST_DB)});\n` +
    `try { await db.initializeDb(); db.registerAgent("child-" + process.pid, "r", []); process.stdout.write("READY\\n"); }\n` +
    `catch (e) { process.stdout.write("REFUSED " + String(e && e.message || e).split("\\n")[0] + "\\n"); process.exit(3); }\n` +
    `process.stdin.on("data", (d) => { if (String(d).includes("exit")) { db.closeDb(); process.exit(0); } });\n` +
    `setInterval(() => {}, 1000);\n`
);
function startOwner(env: Record<string, string | undefined> = {}): { child: ChildProcess; first: Promise<string> } {
  const child = spawn(process.execPath, [OWNER], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const first = new Promise<string>((res) => {
    let out = "";
    const t = setTimeout(() => res(`TIMEOUT ${out}`), 20_000);
    child.stdout!.on("data", (d) => {
      out += d;
      if (/\n/.test(out)) {
        clearTimeout(t);
        res(out.split("\n")[0]!);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(t);
      res(out.split("\n")[0] || `EXIT ${code}`);
    });
  });
  return { child, first };
}

describe("INV-DB-01 2b-ii: the wasm single owner", () => {
  it("the instance declaration sqlite_driver \"wasm\" is ACCEPTED: a new DB is born stamped RLYW (read from another process)", async () => {
    declareWasm();
    await db.initializeDb();
    db.closeDb();
    expect(idOf(dbPath)).toBe(String(WASM));
  });

  it("Q-C: a NEW owned DB appears COMPLETE and stamped: at the moment it is about to be locked, another process already reads RLYW (never an empty or unstamped file)", async () => {
    declareWasm();
    const lock = (await import("../src/db-owner-lock.js").catch(() => null)) as { _setAfterMaterializeHookForTests?: (f: (() => void) | null) => void } | null;
    let seen = "hook never ran";
    lock?._setAfterMaterializeHookForTests?.(() => {
      seen = idOf(dbPath);
    });
    try {
      await db.initializeDb();
    } finally {
      lock?._setAfterMaterializeHookForTests?.(null);
    }
    expect(seen).toBe(String(WASM));
  });

  it("ONE owner: a second process on an owned DB is refused by name; the first keeps working", async () => {
    declareWasm();
    const a = startOwner();
    expect(await a.first).toBe("READY");
    const b = startOwner();
    expect(await b.first).toMatch(/^REFUSED .*(owned|lock)/i);
    a.child.stdin!.write("exit\n");
  }, 60_000);

  it("the owner's exit releases the DB: a new process then owns it", async () => {
    declareWasm();
    const a = startOwner();
    expect(await a.first).toBe("READY");
    a.child.kill("SIGKILL");
    await new Promise((r) => a.child.once("exit", r));
    const b = startOwner();
    expect(await b.first).toBe("READY");
    b.child.stdin!.write("exit\n");
  }, 60_000);

  it("(1) the HEADER decides, whatever the env: an env-only wasm process on an RLYW DB follows the owner protocol (refused while an owner lives)", async () => {
    declareWasm();
    const a = startOwner();
    expect(await a.first).toBe("READY");
    fs.rmSync(cfgPath); // the second process has NO instance declaration: env-wasm only
    const b = startOwner({ RELAY_SQLITE_DRIVER: "wasm" });
    expect(await b.first).toMatch(/^REFUSED .*(owned|lock)/i);
    a.child.stdin!.write("exit\n");
  }, 60_000);

  it("native-only openers on an RLYW DB are refused with a copy-pasteable HTTP client config", async () => {
    makeDb(dbPath, WASM);
    await expect(openRawRelayDb(dbPath, { readonly: true })).rejects.toThrow(/"type": ?"http"/);
  });

  it("a STDIO server on an RLYW DB exits non-zero, with a copy-pasteable HTTP client config", async () => {
    makeDb(dbPath, WASM);
    const r = spawnSync(process.execPath, [DIST_INDEX], {
      // Past the stdin guard (it would exit on a closed stdin before the DB is considered).
      env: { ...process.env, RELAY_TRANSPORT: "stdio", RELAY_SKIP_TTY_CHECK: "1" },
      input: "",
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(/"type": ?"http"/);
  }, 30_000);

  it("twin: a LEGACY (0) DB under env-wasm keeps working over stdio, as today (no lock, unstamped)", async () => {
    makeDb(dbPath, 0);
    const a = startOwner({ RELAY_SQLITE_DRIVER: "wasm" });
    const b = startOwner({ RELAY_SQLITE_DRIVER: "wasm" });
    expect([await a.first, await b.first]).toEqual(["READY", "READY"]);
    a.child.stdin!.write("exit\n");
    b.child.stdin!.write("exit\n");
    await Promise.all([new Promise((r) => a.child.once("exit", r)), new Promise((r) => b.child.once("exit", r))]);
    expect(idOf(dbPath), "never stamped").toBe("0");
  }, 60_000);

  it("(2) legacy env-wasm never stamps RLYW: env-only wasm on a NEW path creates an unstamped DB", async () => {
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    await db.initializeDb();
    db.closeDb();
    expect(idOf(dbPath)).toBe("0");
  });

  it("(2) an owner never ADOPTS a legacy (0) file: declared wasm on an existing 0 DB stays 0, with a named warning", async () => {
    makeDb(dbPath, 0);
    declareWasm();
    const warn = vi.spyOn(log, "warn");
    await db.initializeDb();
    db.closeDb();
    expect(idOf(dbPath)).toBe("0");
    expect(warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n")).toMatch(/legacy .*not adopted|not adopt/i);
  });

  it("(3) the instance declaration WINS over a contradicting env, which warns: declared wasm + env native → an owner (RLYW)", async () => {
    declareWasm();
    process.env.RELAY_SQLITE_DRIVER = "native";
    const warn = vi.spyOn(log, "warn");
    await db.initializeDb();
    db.closeDb();
    expect(idOf(dbPath)).toBe(String(WASM));
    expect(warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n")).toMatch(/RELAY_SQLITE_DRIVER=native .*instance.*wins/i);
  });

  it("Q-B: an RLYW DB with a native handle already counted (opened past the header check) → the header still decides, with NO fs open", async () => {
    makeDb(dbPath, WASM);
    const n = compat.openNativeDb(dbPath, { readonly: true }, { kind: "wasm" });
    try {
      _takeFsSpyViolations();
      await expect(compat.initializeDb(dbPath)).rejects.toThrow(/REFUSING/);
      expect(_takeFsSpyViolations(), "no fs open of the held family").toEqual([]);
    } finally {
      n.close();
    }
  });

  it("an owner's persist is ATOMIC (temp + rename: the file's inode changes, no temp file remains) and stays RLYW", async () => {
    declareWasm();
    await db.initializeDb();
    const ino1 = fs.statSync(dbPath).ino;
    db.registerAgent("persisted", "r", []);
    const ino2 = fs.statSync(dbPath).ino;
    expect(ino2, "replaced by a rename").not.toBe(ino1);
    expect(fs.readdirSync(caseDir).filter((f) => f.endsWith(".tmp")), "no temp file left").toEqual([]);
    db.closeDb();
    expect(idOf(dbPath)).toBe(String(WASM));
  });

  it("an owner REFUSES a persist when another writer replaced the file (per-persist identity check)", async () => {
    declareWasm();
    await db.initializeDb();
    db.registerAgent("before", "r", []);
    const copy = path.join(caseDir, "swap.db");
    fs.copyFileSync(dbPath, copy);
    fs.renameSync(copy, dbPath); // another writer replaced it (same bytes, a NEW inode)
    expect(() => db.registerAgent("after", "r", [])).toThrow(/replaced .*since this owner's last write|identity/i);
  });

  it("a hard-linked RLYW DB: the owner refuses to open it (a rename persist would split its names)", async () => {
    makeDb(dbPath, WASM);
    fs.linkSync(dbPath, path.join(caseDir, "alias.db"));
    declareWasm();
    await expect(db.initializeDb()).rejects.toThrow(/hard links/);
  });

  it("maintenance on an RLYW DB with NO owner live: a cold export runs under the lock and succeeds", async () => {
    makeDb(dbPath, WASM);
    const exp = await exportRelayState({ destinationPath: path.join(caseDir, "w.tar.gz") });
    expect(fs.existsSync(exp.archive_path)).toBe(true);
  });

  it("maintenance on an RLYW DB with an owner LIVE (another process): a cold export is refused, naming the owner", async () => {
    declareWasm();
    const a = startOwner();
    expect(await a.first).toBe("READY");
    fs.rmSync(cfgPath);
    await expect(exportRelayState({ destinationPath: path.join(caseDir, "x.tar.gz") })).rejects.toThrow(/owned by .*(relay|daemon|process)/i);
    a.child.stdin!.write("exit\n");
  }, 60_000);

  it("restore's owner check only READS the header: a LIVE legacy wasm connection + env switched to native → the restore is not refused", async () => {
    process.env.RELAY_SQLITE_DRIVER = "wasm"; // legacy wasm (no declaration)
    await db.initializeDb();
    db.registerAgent("restore-live-wasm", "role", []);
    const exp = await exportRelayState({ destinationPath: path.join(caseDir, "r.tar.gz") });
    expect(compat.getActiveDriver(), "precondition: the live connection is wasm").toBe("wasm");
    process.env.RELAY_SQLITE_DRIVER = "native"; // the env now contradicts the live connection
    await importRelayState(exp.archive_path, { force: true });
    await db.initializeDb();
    expect(db.getAgents().map((x: { name: string }) => x.name)).toContain("restore-live-wasm");
  }, 60_000);
});
