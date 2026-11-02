// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01, slice 1: the SQLite driver is a property of the INSTANCE (`sqlite_driver` in the instance config, default
 * native), read before any DB open.
 *
 * In this release the instance value `wasm` is REFUSED as "not yet supported", before any file is opened or created.
 * A config.json that cannot be read (unparseable, unreadable) does NOT break a DB open that worked before: native,
 * with a named warning.
 * An invalid value is refused by name. An env override (RELAY_SQLITE_DRIVER) that disagrees with the instance driver,
 * including the implicit native, is WARNED once per process (it still wins, as today), and the warning says nothing
 * needs doing yet. None of INV-DB-01's single-owner clauses holds after this slice.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { pathToFileURL } from "url";
import * as compat from "../src/sqlite-compat.js";
import * as db from "../src/db.js";
import * as config from "../src/config.js";
import { log } from "../src/logger.js";

const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "inst-driver-")));
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
  delete process.env.RELAY_DB_PATH;
  process.env.RELAY_CONFIG_PATH = path.join(caseDir, "config.json");
  compat.closeInitializedDb();
  (compat as unknown as { _resetDriverWarningForTests?: () => void })._resetDriverWarningForTests?.();
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

const writeConfig = (file: string, body: Record<string, unknown>) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
};
const driverWarnings = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map((c) => c.map(String).join(" ")).filter((m) => /sqlite_driver|RELAY_SQLITE_DRIVER/.test(m));

describe("INV-DB-01 slice 1: the driver is an instance property", () => {
  it("instance sqlite_driver \"wasm\" is refused as not yet supported, before the DB file is created", async () => {
    writeConfig(process.env.RELAY_CONFIG_PATH!, { sqlite_driver: "wasm" });
    await expect(compat.initializeDb(dbPath)).rejects.toThrow(/sqlite_driver "wasm" is not yet supported/);
    expect(fs.existsSync(dbPath), "no DB file was created").toBe(false);
  });

  it("the same refusal at startup validation (the daemon and stdio servers validate their config first)", () => {
    writeConfig(process.env.RELAY_CONFIG_PATH!, { sqlite_driver: "wasm" });
    expect(() => config.validateConfigAndEnv(config.loadConfig())).toThrow(/sqlite_driver "wasm" is not yet supported/);
  });

  it("an invalid sqlite_driver value is refused by name, listing the valid ones", async () => {
    writeConfig(process.env.RELAY_CONFIG_PATH!, { sqlite_driver: "sql.js" });
    await expect(compat.initializeDb(dbPath)).rejects.toThrow(/sqlite_driver "sql\.js" is not valid.*native/);
    expect(() => config.validateConfigAndEnv(config.loadConfig())).toThrow(/sqlite_driver "sql\.js" is not valid/);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it.each([
    ["absent", {}],
    ["\"native\"", { sqlite_driver: "native" }],
  ])("sqlite_driver %s → the native driver, and no driver warning (known-good twin)", async (_label, body) => {
    writeConfig(process.env.RELAY_CONFIG_PATH!, body);
    const warn = vi.spyOn(log, "warn");
    await compat.initializeDb(dbPath);
    expect(compat.getActiveDriver()).toBe("native");
    expect(driverWarnings(warn)).toEqual([]);
  });

  it.each([
    ["the implicit default (no sqlite_driver key)", {}],
    ["an explicit \"native\"", { sqlite_driver: "native" }],
  ])("RELAY_SQLITE_DRIVER=wasm against %s: WARNED once per process, saying nothing is needed yet; the env still wins", async (_label, body) => {
    writeConfig(process.env.RELAY_CONFIG_PATH!, body);
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const warn = vi.spyOn(log, "warn");
    await compat.initializeDb(dbPath);
    expect(compat.getActiveDriver(), "the env override still wins in this release").toBe("wasm");
    const said = driverWarnings(warn);
    expect(said.length, "warned exactly once").toBe(1);
    expect(said[0]).toMatch(/RELAY_SQLITE_DRIVER=wasm/);
    expect(said[0]).toMatch(/this instance's sqlite_driver is native/);
    expect(said[0]).toMatch(/a later release will require the instance to be converted \(`relay db convert-journal`\); nothing to do until then/);
    compat.closeInitializedDb();
    await compat.initializeDb(dbPath); // a second open in the same process
    expect(driverWarnings(warn).length, "once per process, not once per open").toBe(1);
  });

  const canChmod = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;
  it.each([
    ["unparseable", (f: string) => fs.writeFileSync(f, "{ not json", { mode: 0o600 }), true],
    ["unreadable (mode 000)", (f: string) => {
      fs.writeFileSync(f, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
      fs.chmodSync(f, 0o000);
    }, canChmod],
  ] as const)("a config.json that is %s does not break a DB open (no worse than today): native, with a named warning", async (_label, make, runs) => {
    if (!runs) return; // mode 000 is meaningless on Windows and for root
    make(process.env.RELAY_CONFIG_PATH!);
    const warn = vi.spyOn(log, "warn");
    try {
      await compat.initializeDb(dbPath);
      expect(compat.getActiveDriver()).toBe("native");
      const said = driverWarnings(warn);
      expect(said.length, "one named warning").toBe(1);
      expect(said[0]).toMatch(/could not read this instance's sqlite_driver from .*config\.json .*using native/);
    } finally {
      try {
        fs.chmodSync(process.env.RELAY_CONFIG_PATH!, 0o600);
      } catch {
        /* best effort */
      }
    }
  });

  it.skipIf(!canChmod)("a config.json under a DENIED parent directory (stat EACCES) is not \"missing\": native, with the named warning", async () => {
    const denied = path.join(caseDir, "denied");
    writeConfig(path.join(denied, "config.json"), { sqlite_driver: "wasm" });
    process.env.RELAY_CONFIG_PATH = path.join(denied, "config.json");
    fs.chmodSync(denied, 0o000);
    const warn = vi.spyOn(log, "warn");
    try {
      await compat.initializeDb(dbPath);
      expect(compat.getActiveDriver()).toBe("native");
      expect(driverWarnings(warn).some((m) => /could not read this instance's sqlite_driver from .*(EACCES|EPERM)/.test(m)), "named, never silent").toBe(true);
    } finally {
      fs.chmodSync(denied, 0o700);
    }
  });

  it("the fallback warning names the EFFECTIVE driver: an unparseable config + RELAY_SQLITE_DRIVER=wasm says wasm", async () => {
    fs.writeFileSync(process.env.RELAY_CONFIG_PATH!, "{ not json", { mode: 0o600 });
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const warn = vi.spyOn(log, "warn");
    await compat.initializeDb(dbPath);
    expect(compat.getActiveDriver()).toBe("wasm");
    const fallback = driverWarnings(warn).find((m) => /could not read this instance's sqlite_driver/.test(m));
    expect(fallback, "the fallback warning").toBeTruthy();
    expect(fallback).toMatch(/using wasm/);
    expect(fallback).not.toMatch(/using native/);
  });

  it("db.initializeDb() checks the driver BEFORE creating the DB's parent: a refused config leaves no directory behind", async () => {
    writeConfig(process.env.RELAY_CONFIG_PATH!, { sqlite_driver: "wasm" });
    const parent = path.join(caseDir, "missing", "sub");
    process.env.RELAY_DB_PATH = path.join(parent, "relay.db");
    db.closeDb();
    await expect(db.initializeDb()).rejects.toThrow(/not yet supported/);
    expect(fs.existsSync(path.join(caseDir, "missing")), "the DB's parent was created before the refusal").toBe(false);
  });

  it("validateConfigAndEnv(DEFAULT_CONFIG) with an instance resolution that FAILS still passes when no sqlite_driver is set (as at the base)", () => {
    delete process.env.RELAY_CONFIG_PATH;
    process.env.RELAY_INSTANCE_ID = "bad/id"; // fails INSTANCE_ID_RE: the resolution throws
    expect(() => config.validateConfigAndEnv(config.DEFAULT_CONFIG)).not.toThrow();
  });

  it.skipIf(process.platform === "win32")("a config path that BLOCKS on read (a FIFO with no writer) does not stall a DB open: it returns promptly, native", async () => {
    const fifo = path.join(caseDir, "config.fifo");
    const mk = await new Promise<number | null>((res) => spawn("mkfifo", [fifo]).on("exit", res));
    expect(mk, "mkfifo").toBe(0);
    // In a CHILD process with a deadline: on the old code the read blocks forever, and must not hang this worker.
    const script = path.join(caseDir, "open.mjs");
    fs.writeFileSync(
      script,
      `const c = await import(${JSON.stringify(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "sqlite-compat.js")).href)});\n` +
        `await c.initializeDb(":memory:");\n` +
        `process.stdout.write("OPENED " + c.getActiveDriver() + "\\n");\n` +
        `process.exit(0);\n`
    );
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, RELAY_CONFIG_PATH: fifo, HOME: caseDir, USERPROFILE: caseDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    const finished = await new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), 10_000);
      child.on("close", () => {
        clearTimeout(t);
        res(true);
      });
    });
    if (!finished) child.kill("SIGKILL");
    expect(finished, "the DB open returned (it did not block on the FIFO)").toBe(true);
    expect(out).toMatch(/OPENED native/);
  }, 30_000);

  it.skipIf(process.platform === "win32")("a config swapped to a FIFO AFTER its check (a stale stat) does not stall a DB open: inspection and read use one descriptor", async () => {
    const fifo = path.join(caseDir, "swapped.fifo");
    const regular = path.join(caseDir, "regular.json");
    fs.writeFileSync(regular, "{}", { mode: 0o600 });
    const mk = await new Promise<number | null>((res) => spawn("mkfifo", [fifo]).on("exit", res));
    expect(mk, "mkfifo").toBe(0);
    // The race, made deterministic: the PATH check (statSync) reports a regular file, while the path IS a FIFO, as if it
    // was swapped between the check and the read. A read that trusts the check blocks forever (in a child, deadline).
    const script = path.join(caseDir, "swapped.mjs");
    fs.writeFileSync(
      script,
      `import fs from "fs";\n` +
        `const real = fs.statSync;\n` +
        `fs.statSync = (p, o) => (String(p) === ${JSON.stringify(fifo)} ? real(${JSON.stringify(regular)}, o) : real(p, o));\n` +
        `const c = await import(${JSON.stringify(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "sqlite-compat.js")).href)});\n` +
        `await c.initializeDb(":memory:");\n` +
        `process.stdout.write("OPENED " + c.getActiveDriver() + "\\n");\n` +
        `process.exit(0);\n`
    );
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, RELAY_CONFIG_PATH: fifo, HOME: caseDir, USERPROFILE: caseDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (err += d));
    const finished = await new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), 10_000);
      child.on("close", () => {
        clearTimeout(t);
        res(true);
      });
    });
    if (!finished) child.kill("SIGKILL");
    expect(finished, "the DB open returned (the read did not trust the stale check)").toBe(true);
    expect(out).toMatch(/OPENED native/);
    expect(err, "the fallback is named").toMatch(/could not read this instance's sqlite_driver from .*swapped\.fifo .*not a regular file/);
  }, 30_000);

  it("RELAY_SQLITE_DRIVER=native with no instance value: no warning (known-good twin)", async () => {
    process.env.RELAY_SQLITE_DRIVER = "native";
    const warn = vi.spyOn(log, "warn");
    await compat.initializeDb(dbPath);
    expect(compat.getActiveDriver()).toBe("native");
    expect(driverWarnings(warn)).toEqual([]);
  });

  it("per instance: instance A's sqlite_driver \"wasm\" is refused; instance B (no value) opens natively", async () => {
    delete process.env.RELAY_CONFIG_PATH;
    const instances = path.join(caseDir, ".bot-relay", "instances");
    writeConfig(path.join(instances, "a", "config.json"), { sqlite_driver: "wasm" });
    fs.mkdirSync(path.join(instances, "b"), { recursive: true });
    process.env.RELAY_INSTANCE_ID = "a";
    await expect(compat.initializeDb(path.join(instances, "a", "relay.db"))).rejects.toThrow(/not yet supported/);
    compat.closeInitializedDb();
    process.env.RELAY_INSTANCE_ID = "b";
    await compat.initializeDb(path.join(instances, "b", "relay.db"));
    expect(compat.getActiveDriver()).toBe("native");
  });

  it("SOURCE SCAN (not a runtime proof): src/ reads RELAY_SQLITE_DRIVER from the process env only in sqlite-compat.ts", () => {
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(srcDir);
    const reads = /process\.env(\.RELAY_SQLITE_DRIVER\b|\[\s*["'`]RELAY_SQLITE_DRIVER["'`]\s*\])|\{[^}]*\bRELAY_SQLITE_DRIVER\b[^}]*\}\s*=\s*process\.env/;
    const readers = files.filter((f) => reads.test(fs.readFileSync(f, "utf-8"))).map((f) => path.relative(srcDir, f));
    expect(readers).toEqual(["sqlite-compat.ts"]);
  });
});
