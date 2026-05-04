// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.6.0 — `relay mint-token` subcommand integration tests.
 *
 * Spawns `node bin/relay mint-token ...` via spawnSync against a throwaway
 * DB and asserts on exit codes, stdout/stderr shape, DB row state, and
 * audit_log entries. Mirrors tests/cli-recover.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import net from "net";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-mint-token-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
const TEST_CONFIG_PATH = path.join(TEST_ROOT, "config.json");

process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
process.env.RELAY_CONFIG_PATH = TEST_CONFIG_PATH;
// Bind probes to an unused port so the daemon-running advisory stays silent
// regardless of whether a real daemon is alive on :3777 in the dev env.
process.env.RELAY_HTTP_PORT = "54998";
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;

function resetRoot() {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
}

function runMint(
  args: string[],
  extraEnv: Record<string, string | undefined> = {}
): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RELAY_DB_PATH: TEST_DB_PATH,
    RELAY_CONFIG_PATH: TEST_CONFIG_PATH,
    RELAY_HTTP_PORT: process.env.RELAY_HTTP_PORT,
  };
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const r = spawnSync("node", [RELAY_BIN, "mint-token", ...args], {
    env,
    encoding: "utf-8",
    timeout: 5_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

beforeEach(async () => {
  resetRoot();
  const { closeDb } = await import("../src/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

const TOKEN_REGEX = /[A-Za-z0-9_-]{43}/;

describe("v2.6 — relay mint-token CLI", () => {
  it("(1) first mint creates row, prints token, hashes correctly", async () => {
    const r = runMint(["codex-5-5", "--role", "builder", "--capabilities", "build,test,audit"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Minted token for new agent "codex-5-5"/);
    expect(r.stdout).toMatch(/Token \(shown ONCE/);
    const tokenMatch = r.stdout.match(TOKEN_REGEX);
    expect(tokenMatch).not.toBeNull();
    const plaintext = tokenMatch![0];

    const { initializeDb, getDb, getAgentAuthData } = await import("../src/db.js");
    await initializeDb();
    const db = getDb();
    const row = db.prepare("SELECT * FROM agents WHERE name = ?").get("codex-5-5") as any;
    expect(row).toBeDefined();
    expect(row.role).toBe("builder");
    expect(row.token_hash).toBeTruthy();
    expect(row.agent_status).toBe("idle");
    expect(JSON.parse(row.capabilities)).toEqual(["build", "test", "audit"]);

    // Token authenticates against stored hash.
    const auth = getAgentAuthData("codex-5-5");
    expect(auth).toBeDefined();
    const { verifyToken } = await import("../src/auth.js");
    expect(verifyToken(plaintext, auth!.token_hash!)).toBe(true);
  });

  it("(2) mint on existing agent without --force is refused", async () => {
    const r1 = runMint(["existing", "--role", "builder", "--capabilities", "build"]);
    expect(r1.status).toBe(0);
    const t1 = r1.stdout.match(TOKEN_REGEX)![0];

    const r2 = runMint(["existing", "--role", "builder", "--capabilities", "build"]);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toMatch(/already exists/);
    expect(r2.stderr).toMatch(/--force/);

    // Original token still authenticates — refusal did not mutate state.
    const { initializeDb, getAgentAuthData } = await import("../src/db.js");
    await initializeDb();
    const auth = getAgentAuthData("existing");
    const { verifyToken } = await import("../src/auth.js");
    expect(verifyToken(t1, auth!.token_hash!)).toBe(true);
  });

  it("(3) --force rotates the token, old fails, new succeeds, caps + role preserved", async () => {
    const r1 = runMint([
      "rotater",
      "--role",
      "builder",
      "--capabilities",
      "build,audit",
      "--description",
      "first mint",
    ]);
    expect(r1.status).toBe(0);
    const t1 = r1.stdout.match(TOKEN_REGEX)![0];

    // --force with a different role + caps; both should be IGNORED on rotate.
    const r2 = runMint([
      "rotater",
      "--force",
      "--role",
      "DIFFERENT",
      "--capabilities",
      "DIFFERENT,CAPS",
    ]);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/Rotated token for existing agent "rotater"/);
    const t2 = r2.stdout.match(TOKEN_REGEX)![0];
    expect(t2).not.toBe(t1);

    const { initializeDb, getDb, getAgentAuthData } = await import("../src/db.js");
    await initializeDb();
    const db = getDb();
    const auth = getAgentAuthData("rotater");
    const { verifyToken } = await import("../src/auth.js");

    // New token authenticates; old does not.
    expect(verifyToken(t2, auth!.token_hash!)).toBe(true);
    expect(verifyToken(t1, auth!.token_hash!)).toBe(false);

    // Caps + role preserved per immutability discipline.
    const row = db.prepare("SELECT * FROM agents WHERE name = ?").get("rotater") as any;
    expect(row.role).toBe("builder");
    expect(JSON.parse(row.capabilities)).toEqual(["build", "audit"]);
    // session_id cleared, agent_status flipped to offline.
    expect(row.session_id).toBeNull();
    expect(row.agent_status).toBe("offline");
  });

  it("(4) token shape is 43-char base64url (matches generateToken convention)", () => {
    const r = runMint(["shape-check", "--role", "agent"]);
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n").map((l) => l.trim());
    const tokenLine = lines.find((l) => /^[A-Za-z0-9_-]+$/.test(l) && l.length >= 40);
    expect(tokenLine).toBeDefined();
    expect(tokenLine!.length).toBe(43); // 32-byte → base64url unpadded = 43 chars
    expect(tokenLine!).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("(5) bcrypt hash carries cost factor that matches BCRYPT_ROUNDS export", async () => {
    const r = runMint(["bcrypt-check", "--role", "agent"]);
    expect(r.status).toBe(0);

    const { initializeDb, getAgentAuthData } = await import("../src/db.js");
    await initializeDb();
    const auth = getAgentAuthData("bcrypt-check");
    expect(auth!.token_hash).toBeTruthy();

    // bcrypt-js emits hashes shaped `$2a$<rounds>$...`. Pin against the exported
    // constant so a future bump (10 → 12) stays in lockstep with the test.
    const { BCRYPT_ROUNDS } = await import("../src/auth.js");
    const m = auth!.token_hash!.match(/^\$2[aby]\$(\d+)\$/);
    expect(m).not.toBeNull();
    expect(parseInt(m![1], 10)).toBe(BCRYPT_ROUNDS);
  });

  it("(6) --json emits parseable structured output with all expected fields", () => {
    const r = runMint(["json-check", "--role", "agent", "--capabilities", "x,y", "--json"]);
    expect(r.status).toBe(0);
    // --json suppresses the human-readable stderr advisory; stdout should be a
    // single JSON line.
    const trimmed = r.stdout.trim();
    expect(trimmed.startsWith("{")).toBe(true);
    const parsed = JSON.parse(trimmed);
    expect(parsed.success).toBe(true);
    expect(parsed.name).toBe("json-check");
    expect(parsed.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parsed.agent_id).toMatch(/[0-9a-f-]{36}/i);
    expect(parsed.created).toBe(true);
    expect(parsed.force).toBe(false);
    expect(parsed.env_block).toContain("RELAY_AGENT_NAME=json-check");
    expect(parsed.env_block).toContain(`RELAY_AGENT_TOKEN=${parsed.token}`);
  });

  it("(7) audit_log entry written on successful mint with operator + force flag", async () => {
    const r = runMint(["audit-check", "--role", "agent", "--capabilities", "x"]);
    expect(r.status).toBe(0);

    const { initializeDb, getDb } = await import("../src/db.js");
    await initializeDb();
    const db = getDb();
    const row = db
      .prepare(
        "SELECT tool, agent_name, source, params_summary, success FROM audit_log WHERE tool = 'agent.token_minted' AND agent_name = ?"
      )
      .get("audit-check") as any;
    expect(row).toBeDefined();
    expect(row.source).toBe("cli");
    expect(row.success).toBe(1);
    expect(row.params_summary).toMatch(/operator=\S+ target=audit-check created=true force=false/);
  });

  it("(8) audit_log entry written on REFUSED mint (existing-without-force)", async () => {
    const r1 = runMint(["audit-refused", "--role", "agent"]);
    expect(r1.status).toBe(0);
    const r2 = runMint(["audit-refused", "--role", "agent"]);
    expect(r2.status).toBe(2);

    const { initializeDb, getDb } = await import("../src/db.js");
    await initializeDb();
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT success, params_summary FROM audit_log WHERE tool = 'agent.token_minted' AND agent_name = ? ORDER BY created_at"
      )
      .all("audit-refused") as any[];
    // First success then a refusal — at least one row with success=0.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const refused = rows.find((r) => r.success === 0);
    expect(refused).toBeDefined();
    expect(refused.params_summary).toMatch(/success=false/);
  });

  it("(9) --db-path with non-existent parent directory: exit 2 with clean error", () => {
    const badPath = path.join(os.tmpdir(), "no-such-dir-mint-" + process.pid, "sub", "relay.db");
    const r = runMint(["whoever", "--role", "agent", "--db-path", badPath]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/parent directory does not exist/);
  });

  it("(10) --help prints usage, leaves DB alone", async () => {
    const r = runMint(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: relay mint-token/);
    expect(r.stdout).toMatch(/--force/);
    expect(r.stdout).toMatch(/--json/);

    // DB file should not have been opened by the help path.
    expect(fs.existsSync(TEST_DB_PATH)).toBe(false);
  });

  it("(11) missing <name> argument: exit 1 with usage", () => {
    const r = runMint([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing <name>/);
    expect(r.stdout).toMatch(/Usage: relay mint-token/);
  });

  // v2.6 R1 — codex audit P2 #2 regression. The daemon-running advisory
  // must reach stderr regardless of --json; the prior `!args.json` exclusion
  // suppressed it for scripted callers, defeating the brief Item 3.7 safety
  // signal. Both subtests bind a real TCP listener on the configured probe
  // port so the CLI's daemonListening() returns true, then assert the
  // verbatim stderr phrase.

  function bindListener(port: number): Promise<{ close: () => Promise<void> }> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => {
        resolve({
          close: () =>
            new Promise<void>((res) => {
              srv.close(() => res());
            }),
        });
      });
    });
  }

  it("(12) --json still prints the daemon-running advisory to stderr", async () => {
    // Bind a free port so the test is hermetic vs. any real daemon on :3777.
    const port = 54897;
    const listener = await bindListener(port);
    try {
      const r = runMint(["json-warn-check", "--role", "agent", "--json"], {
        RELAY_HTTP_PORT: String(port),
      });
      expect(r.status).toBe(0);
      // stdout MUST still parse as a single JSON line — no warn pollution.
      const trimmed = r.stdout.trim();
      const parsed = JSON.parse(trimmed);
      expect(parsed.success).toBe(true);
      expect(parsed.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // stderr MUST carry the verbatim phrase from src/cli/mint-token.ts.
      expect(r.stderr).toContain("Daemon currently running on 127.0.0.1:54897");
      expect(r.stderr).toContain("Token mint applied to live DB.");
    } finally {
      await listener.close();
    }
  });

  it("(13) human-readable mode also emits the daemon-running advisory to stderr", async () => {
    const port = 54896;
    const listener = await bindListener(port);
    try {
      const r = runMint(["human-warn-check", "--role", "agent"], {
        RELAY_HTTP_PORT: String(port),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Minted token for new agent/);
      expect(r.stderr).toContain("Daemon currently running on 127.0.0.1:54896");
      expect(r.stderr).toContain("agent process");
      expect(r.stderr).toContain("must be restarted with the new RELAY_AGENT_TOKEN");
    } finally {
      await listener.close();
    }
  });
});
