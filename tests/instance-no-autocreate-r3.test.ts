// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #442 R3 (architect 574e2e54): two more REDs beside Codex R2 P2-1 (tests/instance-no-autocreate.test.ts).
 *
 * P3, a regression of R2: `relay init --instance-id NEW` while the active-instance marker names a DIFFERENT, stale
 * (unprovisioned) instance wrote NEW's files and then exited 1 (getConfigPath threw on the stale selection), so the
 * ~/.claude.json MCP entry was never written; main ea50c6e exited 0. Configuring a NON-active instance is
 * legitimate: it takes the existing "Not the ACTIVE instance" path, and says the active selection is missing.
 *
 * .native: on a case-insensitive file system, a wrong-case RELAY_DB_PATH (<home>/.bot-relay/INSTANCES/<stale>/...)
 * names the same directory, and JS realpathSync keeps the caller's case, so the layout test missed it. The default
 * macOS file system (APFS) is case-insensitive, so this file is in the macOS PR subset, where the .native row runs;
 * on Linux CI it skips with a printed reason (detected, never assumed).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveInstance, createInstance } from "../src/instance.js";
import { initializeDb, closeDb } from "../src/db.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");
const ENV_KEYS = ["HOME", "RELAY_HOME", "RELAY_INSTANCE_ID", "RELAY_DB_PATH", "RELAY_CONFIG_PATH", "RELAY_CLAUDE_HOME"] as const;

let home: string;
let saved: Record<string, string | undefined>;
const relayRoot = () => path.join(home, ".bot-relay");
const instDir = (id: string) => path.join(relayRoot(), "instances", id);

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-442-r3-"));
  process.env.HOME = home;
});

afterEach(() => {
  try {
    closeDb();
  } catch {
    /* nothing open */
  }
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

/** A clean child env: the sandbox HOME only (claudeHome and relayHome both follow it). */
const childEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir() });

describe("P3: relay init --instance-id NEW while the marker names a STALE instance (architect 574e2e54)", () => {
  it("exits 0; NEW gets instance.json, config.json and secrets/mint.secret; the MCP entry is written; the warning names the missing selection", () => {
    createInstance("realinst", "t");
    fs.writeFileSync(path.join(relayRoot(), "active-instance"), "goneinst\n"); // stale: never provisioned
    const r = spawnSync(process.execPath, [RELAY_BIN, "init", "--yes", "--skip-daemon", "--skip-hooks", "--transport", "http", "--instance-id", "newinst"], {
      env: childEnv(),
      encoding: "utf-8",
      timeout: 60_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(path.join(instDir("newinst"), "instance.json"))).toBe(true);
    expect(fs.existsSync(path.join(instDir("newinst"), "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(instDir("newinst"), "secrets", "mint.secret"))).toBe(true);
    const claude = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf-8")) as { mcpServers?: Record<string, unknown> };
    expect(claude.mcpServers?.["bot-relay"], "the MCP entry is written, as on main").toBeDefined();
    expect(r.stdout).toContain("Not the ACTIVE instance");
    expect(r.stdout).toMatch(/goneinst/);
    expect(r.stdout).toContain("relay use-instance newinst");
    expect(fs.existsSync(instDir("goneinst")), "the stale selection was not created").toBe(false);
  });

  it("a resolver error that is NOT unprovisioned (an EMPTY marker) still fails loud, BEFORE any write", () => {
    createInstance("realinst", "t");
    fs.writeFileSync(path.join(relayRoot(), "active-instance"), "");
    const r = spawnSync(process.execPath, [RELAY_BIN, "init", "--yes", "--skip-daemon", "--skip-hooks", "--transport", "http", "--instance-id", "newinst"], {
      env: childEnv(),
      encoding: "utf-8",
      timeout: 60_000,
    });
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(/is empty/);
    expect(fs.existsSync(instDir("newinst")), "the resolution is read before the first write").toBe(false);
  });
});

/** Case-insensitivity is DETECTED on the temp file system at run time, never assumed from the platform. */
function tempFsIsCaseInsensitive(): boolean {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "relay-caseprobe-"));
  try {
    fs.mkdirSync(path.join(d, "probe"));
    return fs.existsSync(path.join(d, "PROBE"));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}
const CASE_INSENSITIVE = tempFsIsCaseInsensitive();
if (!CASE_INSENSITIVE) {
  process.stderr.write("[instance-no-autocreate-r3] .native rows SKIPPED: the temp file system is case-sensitive (detected at run time)\n");
}

describe.skipIf(!CASE_INSENSITIVE)(".native: a WRONG-CASE explicit path into instances/<stale>/ is in the layout (case-insensitive file system, detected)", () => {
  it("RELAY_DB_PATH=<home>/.bot-relay/INSTANCES/<stale>/relay.db is the unprovisioned error; the open refuses and creates nothing", async () => {
    createInstance("realinst", "t");
    fs.writeFileSync(path.join(relayRoot(), "active-instance"), "realinst\n");
    process.env.RELAY_DB_PATH = path.join(relayRoot(), "INSTANCES", "stale", "relay.db");
    expect(resolveInstance()).toMatchObject({ kind: "error", unprovisioned: true });
    await expect(initializeDb()).rejects.toThrow(/instance "stale"/);
    expect(fs.existsSync(instDir("stale")), "nothing created under any case").toBe(false);
  });
});
