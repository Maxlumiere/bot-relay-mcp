// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Cached writer dirs re-verify provisioning AT WRITE TIME (the #442 review's P2-2, after the open-time re-check):
 * a writer whose instance path was resolved while the instance existed must not re-create that instance when it is
 * gone by the time of the write. The token store and the hooks' vault and spawn-manifest writers refuse, and nothing
 * is created; they never `mkdir -p` from above the instance directory.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createInstance } from "../src/instance.js";
import { FileTokenStore } from "../src/token-store.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_KEYS = ["HOME", "RELAY_HOME", "RELAY_INSTANCE_ID", "RELAY_DB_PATH", "RELAY_CONFIG_PATH", "RELAY_CLAUDE_HOME"] as const;
let home: string;
let saved: Record<string, string | undefined>;
const instDir = (id: string) => path.join(home, ".bot-relay", "instances", id);

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-writer-reverify-")));
  process.env.HOME = home;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("the token store re-verifies its instance at write time", () => {
  it("a provisioned instance: the write lands (agents/ 0700, the token 0600)", async () => {
    createInstance("live", "t");
    process.env.RELAY_INSTANCE_ID = "live";
    const store = new FileTokenStore();
    await store.write("w-bob", "abcdefgh12345678");
    expect(fs.readFileSync(path.join(instDir("live"), "agents", "w-bob.token"), "utf-8")).toBe("abcdefgh12345678\n");
    expect(fs.statSync(path.join(instDir("live"), "agents")).mode & 0o777).toBe(0o700);
  });
  it("the instance REMOVED after the store resolved its path → the write refuses, and nothing is re-created", async () => {
    createInstance("gone", "t");
    process.env.RELAY_INSTANCE_ID = "gone";
    const store = new FileTokenStore(); // resolves <instances>/gone/agents now
    fs.rmSync(instDir("gone"), { recursive: true, force: true });
    await expect(store.write("w-bob", "abcdefgh12345678")).rejects.toThrow(/instance "gone"/);
    expect(fs.existsSync(instDir("gone")), "the instance dir is not re-created").toBe(false);
  });
  it("an instance reduced to a BARE directory (its record and DB gone) → refused: a bare directory is not a provisioning", async () => {
    createInstance("bare", "t");
    process.env.RELAY_INSTANCE_ID = "bare";
    const store = new FileTokenStore();
    for (const f of fs.readdirSync(instDir("bare"))) fs.rmSync(path.join(instDir("bare"), f), { recursive: true, force: true });
    await expect(store.write("w-bob", "abcdefgh12345678")).rejects.toThrow(/instance "bare"/);
    expect(fs.existsSync(path.join(instDir("bare"), "agents"))).toBe(false);
  });
  it("a LINKED agents/ under a provisioned instance → refused; its target is untouched", async () => {
    createInstance("live", "t");
    process.env.RELAY_INSTANCE_ID = "live";
    const target = path.join(home, "elsewhere");
    fs.mkdirSync(target);
    fs.rmSync(path.join(instDir("live"), "agents"), { recursive: true, force: true });
    fs.symlinkSync(target, path.join(instDir("live"), "agents"));
    await expect(new FileTokenStore().write("w-bob", "abcdefgh12345678")).rejects.toThrow(/not a real directory/);
    expect(fs.readdirSync(target)).toEqual([]);
  });
});

describe("the hooks' writers re-verify the instance before creating anything (a path resolved while it existed)", () => {
  const helper = path.join(REPO, "hooks", "_vault-helpers.sh");
  /** Source the helpers, then pin the DB path the writers resolve (a CACHED resolution: the instance is gone now). */
  const run = (dbPath: string) => {
    const script = `set -u\n. '${helper}'\nresolve_relay_db_path() { printf '%s\\n' '${dbPath}'; }\nwrite_relay_token_to_vault w-bob abcdefgh12345678; a=$?\nwrite_relay_spawn_manifest w-bob somerole; b=$?\necho "$a $b"\n`;
    return spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir() }, encoding: "utf-8", timeout: 60_000 });
  };
  it("a provisioned instance: both writers succeed", () => {
    createInstance("live", "t");
    const r = run(path.join(instDir("live"), "relay.db"));
    expect(r.stdout.trim(), r.stderr).toBe("0 0");
    expect(fs.existsSync(path.join(instDir("live"), "agents", "w-bob.token"))).toBe(true);
  });
  it("the instance REMOVED after the path was resolved → both writers refuse (1 1), and nothing is created", () => {
    createInstance("gone", "t");
    const db = path.join(instDir("gone"), "relay.db");
    fs.rmSync(instDir("gone"), { recursive: true, force: true });
    const r = run(db);
    expect(r.stdout.trim(), r.stderr).toBe("1 1");
    expect(r.stderr).toContain("not provisioned");
    expect(fs.existsSync(instDir("gone")), "no instance directory, no agents/ under it").toBe(false);
  });
  it("a LINKED agents/ under a provisioned instance → both writers refuse; the target is untouched", () => {
    createInstance("live", "t");
    const target = path.join(home, "elsewhere");
    fs.mkdirSync(target);
    fs.rmSync(path.join(instDir("live"), "agents"), { recursive: true, force: true });
    fs.symlinkSync(target, path.join(instDir("live"), "agents"));
    const r = run(path.join(instDir("live"), "relay.db"));
    expect(r.stdout.trim(), r.stderr).toBe("1 1");
    expect(fs.readdirSync(target)).toEqual([]);
  });
});
