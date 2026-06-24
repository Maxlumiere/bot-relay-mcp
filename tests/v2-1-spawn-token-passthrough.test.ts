// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.6.1 — legacy-rejection regression for the spawn token-passthrough path
 * deprecated in v2.6.1 (was: v2.1 Phase 4j env-var passthrough).
 *
 * Pre-v2.6.1 the parent registered the child + threaded the plaintext token
 * into the child's `RELAY_AGENT_TOKEN` env. Empirically broken when invoked
 * directly via `bin/spawn-agent.sh` (no parent-side register step) — the
 * SessionStart hook called register_agent over HTTP, the relay returned a
 * fresh token, the script discarded the response. 3-min spawn-to-broken-state
 * caught 2026-05-04 during a builder spawn.
 *
 * v2.6.1 closes the gap with a per-instance file vault. handleSpawnAgent now
 * writes the plaintext token to `<instanceDir>/agents/<name>.token` BEFORE
 * driver dispatch; the SessionStart hook reads from disk on first turn.
 *
 * What this file asserts:
 *   1. Fresh spawn still pre-registers + returns plaintext token (vault is
 *      the persistence, not the surface — agent_token still in response).
 *   2. NO RELAY_AGENT_TOKEN in driver env (regression: the prior path leaked
 *      the parent's token into the child's RELAY_* glob).
 *   3. NO 5th-arg-token in macOS spawn-agent.sh argv.
 *   4. Vault file present after spawn (pre-mint write happened).
 *   5. Name-collision still refused cleanly with no side effects.
 *   6. Driver failure rolls back BOTH the agent row AND the vault file.
 *   7. initial_message still queues alongside the vault write.
 *   8. Returned token still matches the bash hook's shape regex.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-spawn-token-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;

// Mock child_process.spawn so we can assert on env + args without opening a window.
vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  execSync: vi.fn(() => Buffer.from("")),
}));

const { handleSpawnAgent } = await import("../src/tools/spawn.js");
const { getAgentAuthData, registerAgent, getMessages, closeDb } = await import("../src/db.js");
const { buildSpawnCommand } = await import("../src/spawn/dispatcher.js");
const { defaultTokenStore, _resetDefaultTokenStoreForTests } = await import("../src/token-store.js");
const cp = await import("child_process");

function parseResult(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

function cleanup() {
  vi.clearAllMocks();
  closeDb();
  _resetDefaultTokenStoreForTests();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}
beforeEach(cleanup);
afterEach(cleanup);

const TOKEN_SHAPE_RE = /^[A-Za-z0-9_=.-]{8,128}$/;

function vaultPathFor(name: string): string {
  return path.join(TEST_DB_DIR, "agents", `${name}.token`);
}

describe("v2.6.1 — spawn-flow self-bootstrap (regression for v2.1 Phase 4j passthrough)", () => {
  it("(1) fresh spawn pre-registers, returns agent_token, writes vault file", async () => {
    const result = parseResult(
      await handleSpawnAgent({
        name: "child-1",
        role: "builder",
        capabilities: ["build"],
      })
    );
    expect(result.success).toBe(true);
    expect(result.agent_token).toMatch(TOKEN_SHAPE_RE);
    expect(result.auth_note).toMatch(/file vault/i);
    expect(getAgentAuthData("child-1")?.token_hash).toBeTruthy();

    // v2.6.1: vault file written before driver dispatch.
    const vp = vaultPathFor("child-1");
    expect(fs.existsSync(vp)).toBe(true);
    const stored = fs.readFileSync(vp, "utf-8").trim();
    expect(stored).toBe(result.agent_token);
  });

  it("(2) driver env DOES NOT carry RELAY_AGENT_TOKEN (legacy passthrough removed)", () => {
    // Register a child row manually (simulating parent-side register) and then
    // ask the dispatcher to build the command. The dispatcher signature now
    // takes _legacyTokenSlot=undefined; even if a stale caller tried to pass
    // a token positionally, buildChildEnv strips RELAY_AGENT_TOKEN.
    registerAgent("env-child", "r", []);

    const cmd = buildSpawnCommand(
      { name: "env-child", role: "r", capabilities: [] } as any,
      undefined,
      { hasBinary: () => true, terminalOverride: null },
      "linux"
    );
    expect(cmd.env.RELAY_AGENT_TOKEN).toBeUndefined();
    expect(cmd.env.RELAY_AGENT_NAME).toBe("env-child");
  });

  it("(3a) macOS argv has no 5th-arg-token (only name/role/caps/cwd)", () => {
    registerAgent("mac-child", "r", []);

    const cmd = buildSpawnCommand(
      { name: "mac-child", role: "r", capabilities: [], cwd: "/tmp" } as any,
      undefined,
      { hasBinary: () => true, terminalOverride: null },
      "darwin"
    );
    expect(cmd.exec).toMatch(/bin\/spawn-agent\.sh$/);
    // 4 args: name, role, caps, cwd. No token slot. No brief slot here.
    expect(cmd.args.length).toBe(4);
    expect(cmd.env.RELAY_AGENT_TOKEN).toBeUndefined();
  });

  it("(3b) Linux argv has no actual token interpolated and env carries no RELAY_AGENT_TOKEN", () => {
    const reg = registerAgent("lin-child", "r", []);
    const actualToken = reg.plaintext_token;

    const cmd = buildSpawnCommand(
      { name: "lin-child", role: "r", capabilities: [], cwd: "/tmp" } as any,
      undefined,
      { hasBinary: (n) => n === "xterm", terminalOverride: null },
      "linux"
    );
    // The minted plaintext token MUST NOT appear in argv (would expose via
    // `ps` listings on multi-user hosts — historic concern preserved in the
    // regression). v2.6.1 R1: the launch command DOES contain a vault-read
    // prelude that references a vault path + the token-shape regex; those
    // are public-shape strings, not the actual minted secret. Assert
    // specifically that the secret value isn't present.
    expect(actualToken).toBeTruthy();
    expect(cmd.args.some((a) => a.includes(actualToken!))).toBe(false);
    expect(cmd.env.RELAY_AGENT_TOKEN).toBeUndefined();
  });

  it("(4) name-collision is refused with no side effect — no spawn, no register, no vault", async () => {
    registerAgent("taken-name", "r", []);
    vi.clearAllMocks();

    const result = parseResult(
      await handleSpawnAgent({
        name: "taken-name",
        role: "builder",
        capabilities: [],
      })
    );
    expect(result.success).toBe(false);
    expect(result.name_collision).toBe(true);
    expect(cp.spawn).not.toHaveBeenCalled();
    // Vault must NOT have been written for the rejected spawn.
    expect(fs.existsSync(vaultPathFor("taken-name"))).toBe(false);
  });

  it("(5) driver failure rolls back the row AND the vault file", async () => {
    (cp.spawn as any).mockImplementationOnce(() => {
      throw new Error("spawn ENOENT");
    });

    const result = parseResult(
      await handleSpawnAgent({
        name: "rollback-child",
        role: "builder",
        capabilities: [],
      })
    );
    expect(result.success).toBe(false);
    expect(result.rolled_back).toBe(true);
    // Row gone.
    expect(getAgentAuthData("rollback-child")).toBeNull();
    // v2.6.1: vault entry also scrubbed so the next spawn can succeed cleanly.
    expect(fs.existsSync(vaultPathFor("rollback-child"))).toBe(false);
  });

  it("(6) initial_message still queues alongside the vault write", async () => {
    const result = parseResult(
      await handleSpawnAgent({
        name: "msg-child",
        role: "builder",
        capabilities: [],
        initial_message: "hello from parent",
      })
    );
    expect(result.success).toBe(true);
    const msgs = getMessages("msg-child", "pending", 10);
    expect(msgs.length).toBe(1);
    expect(msgs[0].from_agent).toBe("system");
    expect(msgs[0].content).toBe("hello from parent");
    // Vault present too.
    expect(fs.existsSync(vaultPathFor("msg-child"))).toBe(true);
  });

  it("(7) returned token matches the post-tool-use hook's shape regex", async () => {
    const result = parseResult(
      await handleSpawnAgent({
        name: "shape-child",
        role: "r",
        capabilities: [],
      })
    );
    expect(result.agent_token).toMatch(TOKEN_SHAPE_RE);
    expect(result.agent_token.length).toBeGreaterThanOrEqual(8);
    expect(result.agent_token.length).toBeLessThanOrEqual(128);
  });

  it("(8) driver-fail rollback after a partial vault write still scrubs", async () => {
    // Defensive — same shape as (5) but exercises the rollback path on a
    // different name to guard against cross-test state.
    (cp.spawn as any).mockImplementation(() => {
      throw new Error("spawn failed");
    });

    const result = parseResult(
      await handleSpawnAgent({
        name: "unsupp-child",
        role: "r",
        capabilities: [],
      })
    );
    expect(result.success).toBe(false);
    expect(result.rolled_back).toBe(true);
    expect(getAgentAuthData("unsupp-child")).toBeNull();
    expect(fs.existsSync(vaultPathFor("unsupp-child"))).toBe(false);
  });

  it("(9) FileTokenStore round-trip — write reads back the same token", async () => {
    const store = defaultTokenStore();
    const token = "Test_Token-WithAllowedChars.123_=";
    await store.write("rt-agent", token);
    const back = await store.read("rt-agent");
    expect(back).toBe(token);
  });
});
