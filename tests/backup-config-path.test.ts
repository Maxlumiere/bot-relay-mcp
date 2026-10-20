// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay backup` archives the config the relay actually READS. backup.ts had its own getConfigPath()
 * (RELAY_CONFIG_PATH, else the legacy flat ~/.bot-relay/config.json), which never got the per-instance resolution
 * config.ts gained in v2.4.0: with an instance active, the archive held the stale flat file, not the live one
 * (MEASURED 20 Oct, a sandboxed export: the archived config was the flat file's marker). One resolver now
 * (config.ts → instance.ts); tests/config-path-single-resolver.test.ts keeps it one.
 *
 * MEASURED on main (this file, RED): the private resolver also ignored RELAY_HOME (it read os.homedir()), so under a
 * RELAY_HOME the archive held NO config at all. Each case writes a DIFFERENT marker at each candidate path, exports,
 * and reads the archived config.json back. Everything lives under a private RELAY_HOME, or the worker's sandboxed HOME.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "backup-config-path-"));
const KEYS = ["RELAY_HOME", "RELAY_INSTANCE_ID", "RELAY_DB_PATH", "RELAY_CONFIG_PATH", "RELAY_AGENT_TOKEN", "RELAY_AGENT_NAME"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

let n = 0;
let home: string;
beforeEach(() => {
  home = path.join(ROOT, `case-${++n}`, ".bot-relay");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const k of KEYS) delete process.env[k];
  process.env.RELAY_HOME = home;
  vi.resetModules(); // a fresh resolution and DB handle per case
});
afterEach(async () => {
  (await import("../src/db.js")).closeDb();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const marker = (m: string) => JSON.stringify({ marker: m });
/** Export with the relay's own backup, then read the archived config.json (or null when the archive has none). */
async function archivedConfig(): Promise<string | null> {
  const db = await import("../src/db.js");
  await db.initializeDb();
  const { exportRelayState } = await import("../src/backup.js");
  const r = await exportRelayState({ destinationPath: path.join(path.dirname(db.getDbPath()), "out.tar.gz") });
  const out = fs.mkdtempSync(path.join(ROOT, "x-"));
  const x = spawnSync("tar", ["-xzf", r.archive_path, "-C", out], { encoding: "utf-8" });
  expect(x.status, x.stderr).toBe(0);
  const f = path.join(out, "config.json");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : null;
}

describe("relay backup archives the config the relay READS (one resolver)", () => {
  it("HARM an ACTIVE instance: the archive holds the INSTANCE's config, not the stale flat one", async () => {
    const { createInstance } = await import("../src/instance.js");
    createInstance("probe-inst", "test");
    const instDir = path.join(home, "instances", "probe-inst");
    fs.writeFileSync(path.join(instDir, "config.json"), marker("INSTANCE"), { mode: 0o600 });
    fs.writeFileSync(path.join(home, "config.json"), marker("LEGACY-FLAT"), { mode: 0o600 });
    process.env.RELAY_INSTANCE_ID = "probe-inst";
    const cfg = await import("../src/config.js");
    expect(cfg.getConfigPath(), "precondition: the relay itself reads the instance config").toBe(path.join(instDir, "config.json"));
    expect(await archivedConfig()).toBe(marker("INSTANCE"));
  });

  it("HARM an ACTIVE instance, no RELAY_HOME (the measured defect, isolated): the INSTANCE config, never the stale flat one", async () => {
    delete process.env.RELAY_HOME;
    expect(os.homedir(), "precondition: HOME is a sandbox").not.toBe(os.userInfo().homedir);
    const root = path.join(os.homedir(), ".bot-relay");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const id = `probe-home-${n}`;
    const { createInstance } = await import("../src/instance.js");
    createInstance(id, "test");
    const instCfg = path.join(root, "instances", id, "config.json");
    const flat = path.join(root, "config.json");
    fs.writeFileSync(instCfg, marker("INSTANCE"), { mode: 0o600 });
    fs.writeFileSync(flat, marker("LEGACY-FLAT"), { mode: 0o600 });
    process.env.RELAY_INSTANCE_ID = id;
    try {
      expect((await import("../src/config.js")).getConfigPath(), "precondition: the relay itself reads the instance config").toBe(instCfg);
      expect(await archivedConfig()).toBe(marker("INSTANCE"));
    } finally {
      fs.rmSync(path.join(root, "instances", id), { recursive: true, force: true });
      fs.rmSync(flat, { force: true });
    }
  });

  it("HARM a RELAY_HOME with no instance: the archive holds THAT root's flat config (main ignored RELAY_HOME)", async () => {
    fs.writeFileSync(path.join(home, "config.json"), marker("RELAY-HOME-FLAT"), { mode: 0o600 });
    expect(await archivedConfig()).toBe(marker("RELAY-HOME-FLAT"));
  });

  it("TWIN no RELAY_HOME, no instance: the archive holds ~/.bot-relay/config.json (the legacy default, unchanged)", async () => {
    delete process.env.RELAY_HOME;
    // The worker's HOME is the tripwire's sandbox, never the account's: assert it before writing under it.
    expect(os.homedir(), "precondition: HOME is a sandbox").not.toBe(os.userInfo().homedir);
    const flat = path.join(os.homedir(), ".bot-relay", "config.json");
    fs.mkdirSync(path.dirname(flat), { recursive: true, mode: 0o700 });
    fs.writeFileSync(flat, marker("HOME-FLAT"), { mode: 0o600 });
    try {
      expect(await archivedConfig()).toBe(marker("HOME-FLAT"));
    } finally {
      fs.rmSync(flat, { force: true });
    }
  });

  it("TWIN an explicit RELAY_CONFIG_PATH wins over both", async () => {
    const explicit = path.join(ROOT, `explicit-${n}.json`);
    fs.writeFileSync(explicit, marker("EXPLICIT"), { mode: 0o600 });
    fs.writeFileSync(path.join(home, "config.json"), marker("LEGACY-FLAT"), { mode: 0o600 });
    process.env.RELAY_CONFIG_PATH = explicit;
    expect(await archivedConfig()).toBe(marker("EXPLICIT"));
  });
});
