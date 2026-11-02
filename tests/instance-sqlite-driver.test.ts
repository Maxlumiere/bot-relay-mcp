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
import * as compat from "../src/sqlite-compat.js";
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
