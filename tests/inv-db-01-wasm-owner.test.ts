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
import crypto from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as lockMod from "../src/db-owner-lock.js";
import * as compat from "../src/sqlite-compat.js";
import * as db from "../src/db.js";
import * as header from "../src/db-header.js";
import { openRawRelayDb } from "../src/cli/_instance-db.js";
import { exportRelayState, importRelayState, _setBeforeRestoreSwapForTests } from "../src/backup.js";
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
    `process.stdin.on("data", (d) => { for (const line of String(d).split("\\n")) {\n` +
    `  if (line === "exit") { db.closeDb(); process.exit(0); }\n` +
    `  const w = /^write (\\S+)$/.exec(line);\n` +
    `  if (w) { try { db.registerAgent(w[1], "r", []); process.stdout.write("WROTE\\n"); } catch (e) { process.stdout.write("WRITE-REFUSED " + String(e && e.message || e).split("\\n")[0] + "\\n"); } }\n` +
    `} });\n` +
    `setInterval(() => {}, 1000);\n`
);
/** A child that takes ONLY the single-owner lock of a DB (no DB open, no write), prints HELD, then idles. */
const LOCK_ONLY = path.join(ROOT, "lock-only.mjs");
fs.writeFileSync(
  LOCK_ONLY,
  `const { acquireOwnerLock } = await import(${JSON.stringify(pathToFileURL(path.join(REPO, "dist", "db-owner-lock.js")).href)});\n` +
    `await acquireOwnerLock(process.argv[2]); process.stdout.write("HELD\\n"); setInterval(() => {}, 1000);\n`
);
/** The next stdout line from an owner child after `cmd` (e.g. "write <name>"), bounded. */
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
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const waitExitOf = (c: ChildProcess) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise((r) => c.once("exit", r)));
function startOwner(env: Record<string, string | undefined> = {}): { child: ChildProcess; first: Promise<string> } {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]; // undefined = unset, never "undefined"
  const child = spawn(process.execPath, [OWNER], {
    env: merged,
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
    // The OPEN-time refusal, by its own words (not a later persist refusal, which also names the lock).
    expect(await b.first).toMatch(/^REFUSED .*owned by another relay process/);
    expect(await ask(a.child, "write after-b"), "the first owner keeps working: a later write is acknowledged").toBe("WROTE");
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

  it("twin: a LEGACY (0) DB under env-wasm keeps working over stdio, as today (no lock, unstamped): two REAL stdio servers each acknowledge a tool call", async () => {
    makeDb(dbPath, 0);
    const connect = async (tag: string) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [DIST_INDEX],
        env: { PATH: process.env.PATH ?? "", HOME: caseDir, USERPROFILE: caseDir, RELAY_DB_PATH: dbPath, RELAY_CONFIG_PATH: cfgPath, RELAY_TRANSPORT: "stdio", RELAY_SKIP_TTY_CHECK: "1", RELAY_SQLITE_DRIVER: "wasm", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
        stderr: "pipe",
      });
      const client = new Client({ name: `legacy-${tag}`, version: "0" }, { capabilities: {} });
      await client.connect(transport);
      return client;
    };
    const [a, b] = [await connect("a"), await connect("b")];
    try {
      for (const [c, name] of [[a, "legacy-a"], [b, "legacy-b"]] as const) {
        const r = (await c.callTool({ name: "register_agent", arguments: { name, role: "r", capabilities: [] } })) as { isError?: boolean; content?: Array<{ text?: string }> };
        expect(r.isError, `${name}: ${JSON.stringify(r.content)}`).not.toBe(true);
      }
      const later = (await a.callTool({ name: "health_check", arguments: {} })) as { isError?: boolean };
      expect(later.isError, "a later call is acknowledged too").not.toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
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
    // POSIX: hold the old file open, so its inode cannot be freed and REUSED by a later temp file (ext4 reuses a freed
    // inode number at once: a bare before/after compare read equal on Linux CI). Windows keeps the plain compare.
    const posix = process.platform !== "win32";
    const fd = posix ? fs.openSync(dbPath, "r") : -1;
    const ino1 = posix ? fs.fstatSync(fd).ino : fs.statSync(dbPath).ino;
    db.registerAgent("persisted", "r", []);
    const ino2 = fs.statSync(dbPath).ino;
    if (posix) {
      expect(fs.fstatSync(fd).nlink, "the old file was unlinked by the rename").toBe(0);
      fs.closeSync(fd);
    }
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

  it("an owner REFUSES a persist when another writer rewrote the file IN PLACE (the same inode: identity is more than dev+ino)", async () => {
    declareWasm();
    await db.initializeDb();
    db.registerAgent("before", "r", []);
    const ino = fs.statSync(dbPath).ino;
    const bytes = fs.readFileSync(dbPath);
    await new Promise((r) => setTimeout(r, 1100)); // a later mtime/ctime, past even a 1 s timestamp granularity
    fs.writeFileSync(dbPath, bytes); // another writer: truncate + write, the SAME inode
    expect(fs.statSync(dbPath).ino, "precondition: rewritten in place").toBe(ino);
    expect(() => db.registerAgent("after", "r", [])).toThrow(/replaced .*since this owner's last write|identity/i);
  });

  // A DELIBERATE decision: a metadata change is not a write. The identity leaves ctime out, because the relay itself
  // chmods its DB after every open (a ctime identity refused the owner's own next persist: MEASURED, 12 rows red).
  it.skipIf(process.platform === "win32")("twin: a chmod by ANOTHER process does NOT refuse the owner's persist (metadata only, deliberately: the relay chmods its own DB on every open)", async () => {
    declareWasm();
    await db.initializeDb();
    db.registerAgent("before", "r", []);
    const mode = fs.statSync(dbPath).mode & 0o777;
    await new Promise((r) => setTimeout(r, 1100));
    const r = spawnSync(process.execPath, ["-e", `require("fs").chmodSync(${JSON.stringify(dbPath)}, ${mode === 0o600 ? 0o640 : 0o600})`]);
    expect(r.status, `precondition: the other process chmodded it\n${r.stderr}`).toBe(0);
    expect(() => db.registerAgent("after", "r", [])).not.toThrow();
    expect(db.getAgents().map((x: { name: string }) => x.name)).toContain("after");
  });

  it("a hard-linked RLYW DB: the owner refuses to open it (a rename persist would split its names)", async () => {
    makeDb(dbPath, WASM);
    fs.linkSync(dbPath, path.join(caseDir, "alias.db"));
    declareWasm();
    await expect(db.initializeDb()).rejects.toThrow(/wasm open refused: .*hard links/); // the OPEN refuses, before any write
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

  it("in-process maintenance RE-ENTERS the owner's lock, and its release leaves the live owner holding it: a second process is still refused", async () => {
    declareWasm();
    await db.initializeDb(); // this process is the owner
    const m = await compat.holdOwnerForMaintenance(dbPath, "backup"); // re-entrant here
    m.release();
    const b = startOwner();
    expect(await b.first, "the owner's lock outlived the maintenance release").toMatch(/^REFUSED .*owned by another relay process/);
    db.registerAgent("still-owner", "r", []); // and this owner still writes
  }, 60_000);

  it("a LEGACY connection never writes onto a file that became OWNED after it opened (stamped RLYW by an owner): refused, the owner's file untouched", async () => {
    makeDb(dbPath, 0);
    process.env.RELAY_SQLITE_DRIVER = "wasm"; // legacy: env-only
    await db.initializeDb();
    expect(compat.getActiveDriver(), "precondition: a legacy wasm connection").toBe("wasm");
    const other = path.join(caseDir, "owned.db");
    makeDb(other, WASM);
    fs.renameSync(other, dbPath); // an owner's file now sits at the name
    const theirs = sha(dbPath);
    expect(() => db.registerAgent("legacy-after", "r", [])).toThrow(/now owned by the wasm driver's single owner/);
    expect(sha(dbPath), "the owner's file is untouched").toBe(theirs);
  });

  it("a RESTORE of an owned DB while ANOTHER process owns it is refused by name, and the owner's file is untouched", async () => {
    makeDb(dbPath, WASM);
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path; // no owner yet
    declareWasm();
    const a = startOwner();
    expect(await a.first).toBe("READY");
    const theirs = sha(dbPath);
    fs.rmSync(cfgPath); // this process: no declaration; the header (RLYW) still makes it owned
    await expect(importRelayState(archive, { force: true })).rejects.toThrow(/restore refused: .*owned by a live relay process/);
    expect(sha(dbPath), "the owner's file is untouched").toBe(theirs);
    a.child.stdin!.write("exit\n");
    await waitExitOf(a.child);
  }, 60_000);

  // --- Codex #385 R2, each a RED on the source it reviewed ---

  it.skipIf(process.platform === "win32")("R2 P1-2: a restore whose owner lock file is REPLACED before its swap (another process then owns the DB and writes it) REFUSES, and that owner's file survives", async () => {
    makeDb(dbPath, WASM);
    const archive = (await exportRelayState({ destinationPath: path.join(caseDir, "before.tar.gz") })).archive_path;
    let b: ChildProcess | null = null;
    let theirs = "";
    _setBeforeRestoreSwapForTests(async () => {
      fs.rmSync(path.join(fs.realpathSync.native(caseDir), ".relay.db.relay-owner"));
      b = spawn(process.execPath, [LOCK_ONLY, dbPath], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      children.push(b);
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error("precondition: the second process did not hold within 20 s")), 20_000);
        b!.stdout!.on("data", (d) => String(d).includes("HELD") && (clearTimeout(t), res()));
      });
      const other = path.join(caseDir, "theirs.db");
      makeDb(other, WASM);
      fs.renameSync(other, dbPath); // the new owner's write
      theirs = sha(dbPath);
    });
    try {
      await expect(importRelayState(archive, { force: true })).rejects.toThrow(/owner lock file .* (removed|replaced) while this process held it/);
    } finally {
      _setBeforeRestoreSwapForTests(null);
    }
    expect(theirs, "precondition: the other owner wrote").not.toBe("");
    expect(sha(dbPath), "the other owner's file survives byte for byte").toBe(theirs);
  }, 60_000);

  /** In ANOTHER process: can it take the lock of `p` right now? */
  const otherProcessAcquires = (p: string) =>
    spawnSync(process.execPath, ["-e", `import(${JSON.stringify(pathToFileURL(path.join(REPO, "dist", "db-owner-lock.js")).href)}).then((m) => m.acquirePrimitive(${JSON.stringify(p)}, { attempts: 1 })).then(() => { console.log("OWNER"); process.exit(0); }, () => { console.log("LOST"); process.exit(0); })`], { encoding: "utf8", env: process.env }).stdout.trim();

  it.skipIf(process.platform === "win32")("R2 P2-3: a release token counts ONCE, and a STALE one (its acquisition invalidated) never closes a NEWER acquisition", async () => {
    const p = path.join(caseDir, "tokens.db");
    fs.writeFileSync(p, "");
    const a = await lockMod.acquirePrimitive(p);
    const m = await lockMod.acquirePrimitive(p); // re-entrant in this process
    m.release();
    m.release(); // the same token again
    expect(lockMod.holdsOwnerLock(p), "a token released twice counted once").toBe(true);
    fs.rmSync(lockMod.lockFilePath(p));
    expect(() => lockMod.assertLockIntact(p), "precondition: the acquisition is invalidated").toThrow(/removed/);
    const fresh = await lockMod.acquirePrimitive(p); // a NEW acquisition, same key
    a.release(); // a stale token
    expect(lockMod.holdsOwnerLock(p), "the newer acquisition survives the stale token").toBe(true);
    expect(otherProcessAcquires(p), "and so does its kernel lock").toBe("LOST");
    fresh.release();
    expect(otherProcessAcquires(p), "twin: released for real, another process acquires").toBe("OWNER");
  }, 60_000);

  it("R2 P2-5: a cleanup that FAILS after the lock is taken rolls the acquisition back: no entry and no lock are kept", async () => {
    const p = path.join(caseDir, "roll.db");
    fs.writeFileSync(p, "x");
    fs.linkSync(p, path.join(caseDir, ".roll.db.12345.abcdefabcdef.new")); // a leftover: the cleanup runs
    const dir = fs.realpathSync.native(caseDir);
    const real = fs.readdirSync;
    const spy = vi.spyOn(fs, "readdirSync").mockImplementation(((d: fs.PathLike, o?: unknown) => {
      if (String(d) === dir) throw Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
      return (real as (...a: unknown[]) => unknown)(d, o);
    }) as typeof fs.readdirSync);
    try {
      await expect(lockMod.acquirePrimitive(p)).rejects.toThrow(/EACCES/);
    } finally {
      spy.mockRestore();
    }
    expect(lockMod.holdsOwnerLock(p), "no entry is kept").toBe(false);
    expect(otherProcessAcquires(p), "no lock is kept").toBe("OWNER");
  }, 60_000);

  // --- Codex #385 R1, each a RED on the 2b-ii source it reviewed ---

  it("P1-1: a LEGACY (env-only) open that awaits sql.js while another process OWNS the file meanwhile does not become an unlocked writer", async () => {
    process.env.RELAY_SQLITE_DRIVER = "wasm"; // legacy: no declaration in this process's config
    const cfgB = path.join(caseDir, "owner-b.json");
    fs.writeFileSync(cfgB, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    let b: ReturnType<typeof startOwner> | null = null;
    compat._setAfterSqlJsLoadForTests(async () => {
      b = startOwner({ RELAY_CONFIG_PATH: cfgB, RELAY_SQLITE_DRIVER: undefined });
      expect(await b.first, "precondition: B owns the file while A waits").toBe("READY");
    });
    try {
      await expect(compat.initializeDb(dbPath)).rejects.toThrow(/owned by another relay process/);
    } finally {
      compat._setAfterSqlJsLoadForTests(null);
    }
    expect(await ask(b!.child, "write b-after"), "B's ownership is intact").toBe("WROTE");
    b!.child.stdin!.write("exit\n");
  }, 60_000);

  it("P1-1 twin: a FOREIGN DB that appears while a legacy open awaits sql.js gets the normal refusal (the verdict is re-applied after the load)", async () => {
    process.env.RELAY_SQLITE_DRIVER = "wasm"; // legacy
    compat._setAfterSqlJsLoadForTests(() => makeDb(dbPath, 0x12345678));
    try {
      await expect(compat.initializeDb(dbPath)).rejects.toThrow(/not the relay's/);
    } finally {
      compat._setAfterSqlJsLoadForTests(null);
    }
  });

  it.each([
    ["native-stamped (RLYN)", NATIVE, /native/i],
    ["FOREIGN", 0x12345678, /not the relay's/],
  ])("P1-3: a %s DB that appears while the owner lock is taken gets the normal refusal, never an unlocked wasm connection", async (_label, appId, refusal) => {
    declareWasm();
    const other = path.join(caseDir, "other.db");
    lockMod._setAfterAcquireHookForTests(() => {
      makeDb(other, appId);
      fs.renameSync(other, dbPath);
    });
    try {
      await expect(compat.initializeDb(dbPath)).rejects.toThrow(refusal);
    } finally {
      lockMod._setAfterAcquireHookForTests(null);
    }
    expect(idOf(dbPath), "the file is untouched").toBe(String(appId));
  });

  it("P1-4: a writer that replaces the DB right AFTER the owner's rename is not adopted as the owner's own: the next persist is refused and the replacement survives", async () => {
    declareWasm();
    await db.initializeDb();
    db.registerAgent("before", "r", []);
    const other = path.join(caseDir, "replacement.db");
    let theirs = "";
    compat._setPersistRenameForTests((from, to) => {
      fs.renameSync(from, to);
      fs.copyFileSync(to, other);
      fs.appendFileSync(other, Buffer.alloc(4096)); // another writer's (bigger) file
      fs.renameSync(other, to);
      theirs = sha(to);
      compat._setPersistRenameForTests(null);
    });
    try {
      db.registerAgent("written", "r", []); // its own later write-back (if any) meets the replacement too
    } catch {
      /* refused there already: also the property */
    }
    expect(theirs, "precondition: the replacement happened").not.toBe("");
    expect(() => db.registerAgent("after", "r", [])).toThrow(/identity|replaced/i);
    expect(sha(dbPath), "the replacement survives byte for byte").toBe(theirs);
  });

  it.skipIf(process.platform === "win32")("P2-5: a persist through a SYMLINKED DB path writes the real DB and leaves the link a link", async () => {
    const realDir = path.join(caseDir, "real");
    const aliasDir = path.join(caseDir, "alias");
    fs.mkdirSync(realDir);
    fs.mkdirSync(aliasDir);
    const real = path.join(realDir, "relay.db");
    const alias = path.join(aliasDir, "relay.db");
    makeDb(real, WASM);
    fs.symlinkSync(real, alias);
    process.env.RELAY_DB_PATH = alias;
    declareWasm();
    const before = sha(real);
    await db.initializeDb();
    db.registerAgent("via-alias", "r", []);
    db.closeDb();
    expect(fs.lstatSync(alias).isSymbolicLink(), "the link is still a link").toBe(true);
    expect(sha(real), "the REAL DB was written").not.toBe(before);
  });

  it("P2-6: a materialize killed between its link and its temp removal leaves a second name; the next owner open removes THAT name (same file, temp pattern) and opens", async () => {
    makeDb(dbPath, WASM);
    const leftover = path.join(caseDir, ".relay.db.12345.abcdefabcdef.new");
    fs.linkSync(dbPath, leftover);
    declareWasm();
    await db.initializeDb();
    expect(fs.existsSync(leftover), "the leftover name is gone").toBe(false);
    expect(fs.statSync(dbPath).nlink).toBe(1);
  });

  it.skipIf(process.platform === "win32")("P2-7: a lock-file name that is a HARD LINK (here to a DB a native handle holds) is refused BEFORE it is opened", async () => {
    const heldPath = path.join(caseDir, "held.db");
    makeDb(heldPath, NATIVE);
    const held = await compat.openReadOnly(heldPath, "native");
    try {
      makeDb(dbPath, WASM);
      fs.linkSync(heldPath, path.join(caseDir, ".relay.db.relay-owner"));
      _takeFsSpyViolations();
      await expect(compat.holdOwnerForMaintenance(dbPath, "backup")).rejects.toThrow(/links/);
      expect(_takeFsSpyViolations(), "no fs open of the held DB through the lock-file name").toEqual([]);
    } finally {
      held.close();
    }
  });

  it("P3-8: a first image whose write FAILS after the exclusive create (ENOSPC) leaves no temp file behind", () => {
    const target = path.join(caseDir, "new.db");
    const real = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, d: unknown, o?: unknown) => {
      if (String(p).endsWith(".new")) {
        fs.closeSync(fs.openSync(p as string, "wx", 0o600));
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      }
      return (real as (...a: unknown[]) => void)(p, d, o);
    }) as typeof fs.writeFileSync);
    try {
      expect(() => lockMod.materializeDb(target, new Uint8Array([1, 2, 3]))).toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(caseDir).filter((f) => f.endsWith(".new")), "no partial temp left").toEqual([]);
  });

  it.skipIf(process.platform === "win32")("the lock file UNLINKED while its owner lives: a second process owns a NEW one, and the first owner's next write is REFUSED; the second's bytes survive", async () => {
    declareWasm();
    const a = startOwner();
    expect(await a.first).toBe("READY");
    fs.rmSync(path.join(fs.realpathSync.native(caseDir), ".relay.db.relay-owner"));
    // The second process takes ONLY the lock (a new lock file), and writes nothing: a relay opening the DB writes at
    // its open (its migrations), which the first owner's identity check would catch on its own. Here nothing changed
    // the DB, so only the lock-file guard can stop the first owner from writing beside a second lock holder.
    const b = spawn(process.execPath, [LOCK_ONLY, dbPath], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(b);
    expect(
      await new Promise<string>((res) => {
        const t = setTimeout(() => res("TIMEOUT"), 20_000);
        b.stdout!.on("data", (d) => String(d).includes("HELD") && (clearTimeout(t), res("HELD")));
        b.on("exit", (c) => (clearTimeout(t), res(`EXIT ${c}`)));
      }),
      "precondition: a second process holds the NEW lock file"
    ).toBe("HELD");
    const before = sha(dbPath);
    expect(await ask(a.child, "write a-after"), "the first owner stops writing").toMatch(/^WRITE-REFUSED .*owner lock file .* (removed|replaced) while this process held it/);
    expect(sha(dbPath), "the file is untouched by the first owner").toBe(before);
    a.child.stdin!.write("exit\n");
    b.kill("SIGKILL");
    await Promise.all([waitExitOf(a.child), waitExitOf(b)]);
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
