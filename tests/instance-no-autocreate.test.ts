// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A NON-EXISTENT instance is refused, never created (the stray-database defect).
 *
 * The injury: a process whose RELAY_INSTANCE_ID (or active-instance marker) names an instance that was never
 * provisioned used to CREATE `<relay home>/instances/<id>/relay.db`, an empty relay. It then started cleanly, looked
 * connected, and read an empty mailbox while every peer wrote to the real instance. Measured on main ea50c6e:
 * `relay watch`, `relay send`, the stdio MCP server and the HTTP daemon all created the directory and the DB.
 *
 * The rule: an INSTANCE-kind resolution may open only a PROVISIONED instance: one whose directory holds
 * instance.json (written by `relay init --instance-id` / `--multi-instance`, src/instance.ts createInstance) or whose
 * relay.db already exists (a legacy instance with data). The flat zero-config layout and an explicit RELAY_DB_PATH /
 * --db-path keep creating their DB.
 *
 * Every refusal is asserted on the HARM (the instance directory does not exist afterwards), not only on the message.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { initializeDb, getDb, closeDb } from "../src/db.js";
import { assertInstanceResolution, createInstance } from "../src/instance.js";
import { pinResolvedDbPath } from "../src/cli/_instance-db.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");
const SERVER = path.join(REPO_ROOT, "dist", "index.js");

const BOGUS = "00000000-0000-4000-8000-0000000000aa";
const ENV_KEYS = ["HOME", "RELAY_HOME", "RELAY_INSTANCE_ID", "RELAY_DB_PATH", "RELAY_CONFIG_PATH", "RELAY_ALLOW_LEGACY_FALLBACK"] as const;

let home: string;
let saved: Record<string, string | undefined>;

const relayRoot = () => path.join(home, ".bot-relay");
const instDir = (id: string) => path.join(relayRoot(), "instances", id);

/** A provisioned instance exactly as `relay init --instance-id` leaves it (instance.json, no DB yet). */
function provision(id: string): void {
  createInstance(id, "test");
}

/** The machine state of the defect: one real instance, active through the marker. */
function realInstanceActive(): void {
  provision("realinst");
  fs.writeFileSync(path.join(relayRoot(), "active-instance"), "realinst\n");
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-no-autocreate-"));
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

describe("an instance that does not exist is REFUSED and NOT created", () => {
  it("initializeDb(): a stale RELAY_INSTANCE_ID is refused, names the id and how to create it, creates nothing", async () => {
    realInstanceActive();
    process.env.RELAY_INSTANCE_ID = BOGUS;
    await expect(initializeDb()).rejects.toThrow(new RegExp(`instance "${BOGUS}".*does not exist[\\s\\S]*relay init --instance-id ${BOGUS}`));
    expect(fs.existsSync(instDir(BOGUS)), "no instance directory was created").toBe(false);
  });

  it("initializeDb(): an active-instance marker naming a removed instance is refused, creates nothing", async () => {
    provision("realinst");
    fs.writeFileSync(path.join(relayRoot(), "active-instance"), "goneinst\n");
    await expect(initializeDb()).rejects.toThrow(/instance "goneinst".*does not exist[\s\S]*relay use-instance/);
    expect(fs.existsSync(instDir("goneinst"))).toBe(false);
  });

  it("getDb() (the synchronous native fallback) refuses the same way, creates nothing", () => {
    realInstanceActive();
    process.env.RELAY_INSTANCE_ID = BOGUS;
    expect(() => getDb()).toThrow(/does not exist/);
    expect(fs.existsSync(instDir(BOGUS))).toBe(false);
  });

  it("an existing but EMPTY instance directory (no instance.json, no relay.db) is refused: a directory is not a provisioning", async () => {
    realInstanceActive();
    fs.mkdirSync(instDir(BOGUS), { mode: 0o700 });
    process.env.RELAY_INSTANCE_ID = BOGUS;
    await expect(initializeDb()).rejects.toThrow(/does not exist/);
    expect(fs.readdirSync(instDir(BOGUS)), "nothing was written into it").toEqual([]);
  });

  it("assertInstanceResolution() (the daemon and stdio startup gate) refuses before anything touches the disk", () => {
    realInstanceActive();
    process.env.RELAY_INSTANCE_ID = BOGUS;
    expect(() => assertInstanceResolution(() => {})).toThrow(/REFUSING TO START[\s\S]*does not exist/);
    expect(fs.existsSync(instDir(BOGUS))).toBe(false);
  });

  it("pinResolvedDbPath() (relay watch / send / watch-until-wake) answers the fault instead of pinning a path to create", async () => {
    realInstanceActive();
    process.env.RELAY_INSTANCE_ID = BOGUS;
    const fault = await pinResolvedDbPath();
    expect(fault).toMatch(/does not exist/);
    expect(process.env.RELAY_DB_PATH, "nothing was pinned").toBeUndefined();
  });
});

describe("the provisioning channels that MUST still create", () => {
  it("a provisioned instance (instance.json, no DB yet: right after relay init --instance-id) gets its DB on first open", async () => {
    provision("fresh");
    process.env.RELAY_INSTANCE_ID = "fresh";
    await initializeDb();
    expect(fs.existsSync(path.join(instDir("fresh"), "relay.db"))).toBe(true);
  });

  it("a legacy instance with a relay.db but no instance.json still opens", async () => {
    process.env.RELAY_INSTANCE_ID = "legacy";
    // Create its DB the way a pre-instance.json relay did: through an explicit path.
    process.env.RELAY_DB_PATH = path.join(instDir("legacy"), "relay.db");
    await initializeDb();
    closeDb();
    delete process.env.RELAY_DB_PATH;
    expect(fs.existsSync(path.join(instDir("legacy"), "instance.json"))).toBe(false);
    await expect(initializeDb()).resolves.toBeUndefined();
  });

  it("zero-config first run (no relay home at all) creates the flat DB", async () => {
    await initializeDb();
    expect(fs.existsSync(path.join(relayRoot(), "relay.db"))).toBe(true);
  });

  it("an explicit RELAY_DB_PATH to a new path creates it (the operator named the file)", async () => {
    const p = path.join(home, "explicit", "relay.db");
    process.env.RELAY_DB_PATH = p;
    await initializeDb();
    expect(fs.existsSync(p)).toBe(true);
  });
});

/** The black-box entry points (dist/: CI builds before the suite). A clean env with only the sandbox HOME. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), RELAY_HTTP_PORT: "1", ...extra };
}

describe("black box: the CLI verbs and the server refuse, and leave no directory", () => {
  it("relay send with a stale RELAY_INSTANCE_ID exits non-zero naming the instance, creates nothing", () => {
    realInstanceActive();
    const r = spawnSync(process.execPath, [RELAY_BIN, "send", "other", "hi", "--from", "someagent"], {
      env: cleanEnv({ RELAY_INSTANCE_ID: BOGUS }),
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toContain(`instance "${BOGUS}"`);
    expect(fs.existsSync(instDir(BOGUS))).toBe(false);
  });

  it("relay watch with a stale RELAY_INSTANCE_ID exits (does not watch an empty relay), creates nothing", () => {
    realInstanceActive();
    const r = spawnSync(process.execPath, [RELAY_BIN, "watch", "someagent", "--json"], {
      env: cleanEnv({ RELAY_INSTANCE_ID: BOGUS }),
      encoding: "utf-8",
      timeout: 30_000,
    });
    // spawnSync's timeout SIGTERMs the watch, which then exits 0: the timeout is detected by r.error, not the status.
    expect((r.error as NodeJS.ErrnoException | undefined)?.code, "it exited by itself instead of watching").toBeUndefined();
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain(`instance "${BOGUS}"`);
    expect(fs.existsSync(instDir(BOGUS))).toBe(false);
  });

  it("the stdio MCP server refuses to start on a stale RELAY_INSTANCE_ID, creates nothing", async () => {
    realInstanceActive();
    const child = spawn(process.execPath, [SERVER], {
      env: cleanEnv({ RELAY_INSTANCE_ID: BOGUS, RELAY_TRANSPORT: "stdio" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    // A real client's first frames, kept open: on main the server opened (and created) the DB and answered.
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`,
    );
    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, 20_000);
      child.on("exit", (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    expect(code, `it exited by itself, non-zero; stderr: ${stderr}`).not.toBeNull();
    expect(code).not.toBe(0);
    expect(stderr).toContain(`instance "${BOGUS}"`);
    expect(fs.existsSync(instDir(BOGUS))).toBe(false);
  }, 30_000);

  it("plain relay init with a marker naming a removed instance refuses BEFORE any write (no config.json in a stray dir)", () => {
    provision("realinst");
    fs.writeFileSync(path.join(relayRoot(), "active-instance"), "goneinst\n");
    const r = spawnSync(process.execPath, [RELAY_BIN, "init", "--yes", "--config-only", "--transport", "http"], {
      env: cleanEnv({}),
      encoding: "utf-8",
      timeout: 60_000,
    });
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(/instance "goneinst".*does not exist/);
    expect(fs.existsSync(instDir("goneinst")), "nothing was scaffolded").toBe(false);
    expect(fs.existsSync(path.join(relayRoot(), "config.json")), "and nothing fell back to the flat config").toBe(false);
  });

  it("relay doctor FAILS the instance-resolution check instead of passing a non-existent instance", () => {
    realInstanceActive();
    const r = spawnSync(process.execPath, [RELAY_BIN, "doctor"], {
      env: cleanEnv({ RELAY_INSTANCE_ID: BOGUS }),
      encoding: "utf-8",
      timeout: 60_000,
    });
    expect(r.stdout).toMatch(/FAIL\s+instance resolution:.*does not exist/);
    expect(fs.existsSync(instDir(BOGUS))).toBe(false);
  });
});
