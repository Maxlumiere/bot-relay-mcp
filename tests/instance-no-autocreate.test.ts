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
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { initializeDb, getDb, closeDb } from "../src/db.js";
import { assertInstanceResolution, createInstance, resolveInstance } from "../src/instance.js";
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
    // A real relay DB, built elsewhere, then placed as a pre-instance.json instance's relay.db.
    const built = path.join(home, "elsewhere", "relay.db");
    process.env.RELAY_DB_PATH = built;
    await initializeDb();
    closeDb();
    delete process.env.RELAY_DB_PATH;
    fs.mkdirSync(instDir("legacy"), { recursive: true, mode: 0o700 });
    fs.copyFileSync(built, path.join(instDir("legacy"), "relay.db"));
    process.env.RELAY_INSTANCE_ID = "legacy";
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

/** Codex #442 R1 P2-1: EVERY resolver consumer refuses (the resolver classifies the instance as an error), with no artifact. */
describe("every resolver consumer refuses an unprovisioned instance, leaving no artifact (Codex #442 R1 P2-1)", () => {
  it("resolveInstance() answers the ERROR kind (unprovisioned: true) for a stale RELAY_INSTANCE_ID and a removed marker; a provisioned instance with no DB yet is still the instance kind", () => {
    realInstanceActive();
    process.env.RELAY_INSTANCE_ID = BOGUS;
    const stale = resolveInstance();
    expect(stale.kind).toBe("error");
    expect(stale.kind === "error" && stale.unprovisioned).toBe(true);
    delete process.env.RELAY_INSTANCE_ID;
    fs.writeFileSync(path.join(relayRoot(), "active-instance"), "goneinst\n");
    const gone = resolveInstance();
    expect(gone.kind === "error" && gone.unprovisioned).toBe(true);
    fs.writeFileSync(path.join(relayRoot(), "active-instance"), "realinst\n");
    const fresh = resolveInstance();
    expect(fresh.kind).toBe("instance");
    expect(fresh.kind === "instance" && fresh.exists).toBe(false);
  });

  it("relay where --json reports the failure (exit non-zero, kind error, unprovisioned): the hooks get no path", () => {
    realInstanceActive();
    const r = spawnSync(process.execPath, [RELAY_BIN, "where", "--json"], { env: cleanEnv({ RELAY_INSTANCE_ID: BOGUS }), encoding: "utf-8", timeout: 30_000 });
    expect(r.status).not.toBe(0);
    const res = (JSON.parse(r.stdout) as { resolution: Record<string, unknown> }).resolution;
    expect(res.kind).toBe("error");
    expect(res.unprovisioned).toBe(true);
    expect(fs.existsSync(instDir(BOGUS))).toBe(false);
  });

  it("the hooks' vault and spawn-manifest writers refuse and create nothing under the instance", () => {
    realInstanceActive();
    const helper = path.join(REPO_ROOT, "hooks", "_vault-helpers.sh");
    const script = `set -u\n. '${helper}'\nwrite_relay_token_to_vault someagent abcdefgh12345678; a=$?\nwrite_relay_spawn_manifest someagent somerole; b=$?\necho "$a $b"\n`;
    const r = spawnSync("bash", ["-c", script], { env: cleanEnv({ RELAY_INSTANCE_ID: BOGUS }), encoding: "utf-8", timeout: 60_000 });
    expect(r.stdout.trim(), r.stderr).toBe("1 1");
    expect(r.stderr).toContain("does not exist");
    expect(fs.existsSync(instDir(BOGUS)), "no instance directory, no agents/ under it").toBe(false);
  });

  it("relay remote set-mint-secret refuses and creates no credential directory", () => {
    realInstanceActive();
    const r = spawnSync(process.execPath, [RELAY_BIN, "remote", "set-mint-secret", "example.com:3777"], {
      env: cleanEnv({ RELAY_INSTANCE_ID: BOGUS }),
      input: `${"s".repeat(40)}\n`,
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`instance "${BOGUS}"`);
    expect(fs.existsSync(instDir(BOGUS))).toBe(false);
  });

  it("relay pending refuses with the remediation (how to create or select an instance), creates nothing", () => {
    realInstanceActive();
    const r = spawnSync(process.execPath, [RELAY_BIN, "pending", "someagent", "--json"], { env: cleanEnv({ RELAY_INSTANCE_ID: BOGUS }), encoding: "utf-8", timeout: 30_000 });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain(`relay init --instance-id ${BOGUS}`);
    expect(fs.existsSync(instDir(BOGUS))).toBe(false);
  });

  it("the HTTP daemon refuses to start, creates nothing (no DB, no secrets, no owner record)", async () => {
    realInstanceActive();
    // A real free port: an invalid one would end the daemon on a config error, a refusal for the wrong reason.
    const port = await new Promise<number>((res) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => res(p));
      });
    });
    const child = spawn(process.execPath, [SERVER], { env: cleanEnv({ RELAY_INSTANCE_ID: BOGUS, RELAY_TRANSPORT: "http", RELAY_HTTP_PORT: String(port) }), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
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
    expect(code, `it exited by itself; stderr: ${stderr}`).not.toBeNull();
    expect(code).not.toBe(0);
    expect(stderr).toContain(`instance "${BOGUS}"`);
    expect(fs.existsSync(instDir(BOGUS))).toBe(false);
  }, 30_000);
});

/** Codex #442 R1 P2-2: the open re-verifies; a stale resolution or pin cannot recreate a removed instance. */
describe("the open re-verifies provisioning: concurrent deletion recreates nothing (Codex #442 R1 P2-2)", () => {
  /** A pre-instance.json instance: a real relay DB (built elsewhere) as its relay.db, and no instance.json. */
  async function legacyInstance(id: string): Promise<void> {
    const built = path.join(home, `built-${id}`, "relay.db");
    process.env.RELAY_DB_PATH = built;
    await initializeDb();
    closeDb();
    delete process.env.RELAY_DB_PATH;
    fs.mkdirSync(instDir(id), { recursive: true, mode: 0o700 });
    fs.copyFileSync(built, path.join(instDir(id), "relay.db"));
  }

  it("pinned, then the instance directory is removed before the open: initializeDb refuses and leaves no directory", async () => {
    await legacyInstance("legacy");
    process.env.RELAY_INSTANCE_ID = "legacy";
    expect(await pinResolvedDbPath()).toBeNull();
    fs.rmSync(instDir("legacy"), { recursive: true, force: true });
    await expect(initializeDb()).rejects.toThrow(/instance "legacy".*does not exist: .*holds no instance\.json/);
    expect(fs.existsSync(instDir("legacy"))).toBe(false);
  });

  it("pinned, then only the legacy DB is removed (no instance.json): getDb refuses and writes nothing into the directory", async () => {
    await legacyInstance("legacy2");
    process.env.RELAY_INSTANCE_ID = "legacy2";
    expect(await pinResolvedDbPath()).toBeNull();
    fs.rmSync(path.join(instDir("legacy2"), "relay.db"));
    expect(() => getDb()).toThrow(/instance "legacy2".*does not exist: .*holds no instance\.json/);
    expect(fs.readdirSync(instDir("legacy2"))).toEqual([]);
  });

  it("an explicit RELAY_DB_PATH INTO the instances layout of an ABSENT instance (another selected) is refused, not created", async () => {
    realInstanceActive();
    process.env.RELAY_DB_PATH = path.join(instDir(BOGUS), "relay.db");
    // The open's OWN refusal (named by the DB path), not SQLite's "directory does not exist".
    await expect(initializeDb()).rejects.toThrow(new RegExp(`instance "${BOGUS}" \\(named by the DB path`));
    expect(fs.existsSync(instDir(BOGUS))).toBe(false);
  });

  it("an explicit RELAY_DB_PATH INTO an existing BARE instance directory (another selected): only the open's check stands between it and a new relay.db", async () => {
    realInstanceActive();
    fs.mkdirSync(instDir("bare"), { mode: 0o700 });
    process.env.RELAY_DB_PATH = path.join(instDir("bare"), "relay.db");
    await expect(initializeDb()).rejects.toThrow(/instance "bare" \(named by the DB path/);
    expect(fs.readdirSync(instDir("bare")), "no relay.db, nothing written").toEqual([]);
    expect(() => getDb()).toThrow(/instance "bare" \(named by the DB path/);
    expect(fs.readdirSync(instDir("bare"))).toEqual([]);
  });
});

/** the-fixer #442 P3: ONE predicate. An instance.json that `use-instance` / `list-instances` reject is not a provisioning. */
describe("a corrupt or non-file instance.json is NOT a provisioning, for every verb alike (the-fixer #442 P3)", () => {
  const cases: Array<[string, (dir: string) => void]> = [
    ["corrupt ('{')", (dir) => fs.writeFileSync(path.join(dir, "instance.json"), "{")],
    ["a directory", (dir) => fs.mkdirSync(path.join(dir, "instance.json"))],
    ["a JSON non-object (3)", (dir) => fs.writeFileSync(path.join(dir, "instance.json"), "3")],
  ];
  for (const [label, plant] of cases) {
    it(`instance.json ${label}: relay purge-agents refuses and creates no relay.db; relay use-instance agrees it is not found`, () => {
      realInstanceActive();
      fs.mkdirSync(instDir("bad"), { mode: 0o700 });
      plant(instDir("bad"));
      const purge = spawnSync(process.execPath, [RELAY_BIN, "purge-agents"], { env: cleanEnv({ RELAY_INSTANCE_ID: "bad" }), encoding: "utf-8", timeout: 30_000 });
      expect(purge.status, purge.stdout + purge.stderr).not.toBe(0);
      expect(`${purge.stdout}${purge.stderr}`).toContain(`instance "bad"`);
      expect(fs.existsSync(path.join(instDir("bad"), "relay.db")), "no relay.db was created").toBe(false);
      const use = spawnSync(process.execPath, [RELAY_BIN, "use-instance", "bad"], { env: cleanEnv({}), encoding: "utf-8", timeout: 30_000 });
      expect(use.status).not.toBe(0);
      expect(use.stderr).toContain("not found");
    });
  }
});
