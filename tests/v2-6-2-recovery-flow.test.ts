// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.6.2 — Recovery flow integration test.
 *
 * End-to-end: register → admin revoke (issue_recovery=true) → original
 * token rejected → re-register with recovery_token → fresh agent_token
 * authenticates → vault re-hydrated.
 *
 * Test path matches shipped path: real `node dist/index.js` HTTP daemon
 * subprocess + real JSON-RPC over fetch. No InMemoryTransport, no
 * convenience rigs. Closes the partial coverage of the recovery cycle
 * across previous Phase 4b.1 v2 unit tests by stitching the full
 * register → revoke → recover → re-auth chain at the wire surface.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { getFreePort } from "./_helpers/port.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

interface RpcOpts {
  port: number;
  args: { name: string; arguments: any };
  headers?: Record<string, string>;
}

async function rpc(o: RpcOpts): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(o.headers ?? {}),
  };
  const body = {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1e9),
    method: "tools/call",
    params: { name: o.args.name, arguments: o.args.arguments },
  };
  const resp = await fetch(`http://127.0.0.1:${o.port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  const dataLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
  const payload = dataLine ? dataLine.slice(5).trim() : text.trim();
  const rpcResp = JSON.parse(payload);
  const inner = rpcResp.result?.content?.[0]?.text;
  return inner ? JSON.parse(inner) : rpcResp;
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`HTTP daemon at :${port} did not become healthy within ${timeoutMs}ms`);
}

describe("v2.6.2 — recovery flow integration (register → revoke → recover → re-auth)", () => {
  it("full recovery cycle works end-to-end against a real HTTP daemon", async () => {
    const PORT = await getFreePort();
    const ROOT = path.join(os.tmpdir(), "v2-6-2-recovery-" + process.pid);
    if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
    expect(fs.existsSync(DIST_INDEX)).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("child_process") as typeof import("child_process");

    const child = spawn("node", [DIST_INDEX], {
      env: {
        ...process.env,
        RELAY_TRANSPORT: "http",
        RELAY_HTTP_PORT: String(PORT),
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HOME: ROOT,
        RELAY_DB_PATH: path.join(ROOT, "relay.db"),
        RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
        RELAY_AGENT_TOKEN: "",
        RELAY_AGENT_NAME: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHealth(PORT, 5000);

      // Step 1 — register the admin who will perform the revoke. Needs the
      // "admin" capability per src/auth.ts:TOOL_CAPABILITY.
      const adminReg = await rpc({
        port: PORT,
        args: {
          name: "register_agent",
          arguments: { name: "admin-rev", role: "admin", capabilities: ["admin"] },
        },
      });
      expect(adminReg.success).toBe(true);
      const ADMIN_TOKEN = adminReg.agent_token;
      expect(ADMIN_TOKEN).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);

      // Step 2 — register the target agent. Capture its first agent_token.
      const targetReg = await rpc({
        port: PORT,
        args: {
          name: "register_agent",
          arguments: { name: "recovery-test-agent", role: "tester", capabilities: [] },
        },
      });
      expect(targetReg.success).toBe(true);
      const ORIGINAL_TOKEN = targetReg.agent_token;
      expect(ORIGINAL_TOKEN).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);
      expect(ORIGINAL_TOKEN).not.toBe(ADMIN_TOKEN);

      // Step 3 — write the original token to the per-instance vault. This is
      // what handleSpawnAgent / handleRegisterAgent (via the SessionStart
      // hook) would do in normal operation.
      const VAULT_FILE = path.join(ROOT, "agents", "recovery-test-agent.token");
      fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true, mode: 0o700 });
      fs.writeFileSync(VAULT_FILE, ORIGINAL_TOKEN + "\n", { mode: 0o600 });
      expect(fs.existsSync(VAULT_FILE)).toBe(true);
      expect(fs.readFileSync(VAULT_FILE, "utf-8").trim()).toBe(ORIGINAL_TOKEN);

      // Step 4 — sanity: original token authenticates a call from the target.
      const baseline = await rpc({
        port: PORT,
        args: {
          name: "get_messages",
          arguments: { agent_name: "recovery-test-agent", status: "pending", limit: 5 },
        },
        headers: { "X-Agent-Token": ORIGINAL_TOKEN },
      });
      expect(Array.isArray(baseline.messages)).toBe(true);
      expect(baseline.auth_error).toBeUndefined();

      // Step 5 — admin revokes with issue_recovery=true. Captures recovery_token.
      const revoked = await rpc({
        port: PORT,
        args: {
          name: "revoke_token",
          arguments: {
            target_agent_name: "recovery-test-agent",
            revoker_name: "admin-rev",
            issue_recovery: true,
          },
        },
        headers: { "X-Agent-Token": ADMIN_TOKEN },
      });
      expect(revoked.success).toBe(true);
      expect(revoked.changed).toBe(true);
      expect(revoked.auth_state_after).toBe("recovery_pending");
      const RECOVERY_TOKEN = revoked.recovery_token;
      expect(RECOVERY_TOKEN).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);
      expect(RECOVERY_TOKEN).not.toBe(ORIGINAL_TOKEN);

      // Step 6 — original token MUST now fail auth. The auth_state is
      // recovery_pending; the previous token_hash is still in the row but
      // resolveCallerByToken's state check (src/server.ts:870-878) refuses
      // any state other than 'active' or 'rotation_grace'.
      const stale = await rpc({
        port: PORT,
        args: {
          name: "get_messages",
          arguments: { agent_name: "recovery-test-agent", status: "pending", limit: 5 },
        },
        headers: { "X-Agent-Token": ORIGINAL_TOKEN },
      });
      expect(stale.auth_error).toBe(true);
      expect(stale.error_code).toBe("AUTH_FAILED");

      // v2.6.2 R1 — revoke_token now scrubs the vault (Maxime's call,
      // 2026-05-05, per memory/feedback_maxime_owns_strategic_calls.md).
      // The security boundary already held via the auth_state check at
      // src/server.ts:870-878 — a stale token in the vault was harmless.
      // R1 aligns the mental model so revoke_token leaves NO credential on
      // disk for the agent. Mirrors the recovery-CLI scrub at
      // src/cli/recover.ts:300-301. Implemented via deleteSync in
      // src/tools/identity.ts:handleRevokeToken (after the DB-side revoke).
      expect(fs.existsSync(VAULT_FILE)).toBe(false); // vault scrubbed by revoke_token (v2.6.2 R1)

      // Step 7 — re-register with the recovery_token. Captures the fresh
      // agent_token. State transitions back to 'active'.
      const recovered = await rpc({
        port: PORT,
        args: {
          name: "register_agent",
          arguments: {
            name: "recovery-test-agent",
            role: "tester",
            capabilities: [],
            recovery_token: RECOVERY_TOKEN,
          },
        },
      });
      expect(recovered.success).toBe(true);
      expect(recovered.recovery_completed).toBe(true);
      const NEW_TOKEN = recovered.agent_token;
      expect(NEW_TOKEN).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);
      expect(NEW_TOKEN).not.toBe(ORIGINAL_TOKEN);
      expect(NEW_TOKEN).not.toBe(RECOVERY_TOKEN);

      // Step 8 — operator (or hook) writes the new token to vault, replacing
      // the stale entry. This mirrors hooks/check-relay.sh:170-174.
      fs.writeFileSync(VAULT_FILE, NEW_TOKEN + "\n", { mode: 0o600 });
      expect(fs.readFileSync(VAULT_FILE, "utf-8").trim()).toBe(NEW_TOKEN);

      // Step 9 — new token authenticates an authenticated call. The recovery
      // cycle is complete: same agent identity, fresh credential, vault
      // hydrated for the next spawn.
      const reauth = await rpc({
        port: PORT,
        args: {
          name: "get_messages",
          arguments: { agent_name: "recovery-test-agent", status: "pending", limit: 5 },
        },
        headers: { "X-Agent-Token": NEW_TOKEN },
      });
      expect(Array.isArray(reauth.messages)).toBe(true);
      expect(reauth.auth_error).toBeUndefined();

      // Step 10 — recovery_token is single-use: a second register_agent call
      // with the SAME recovery_token must NOT succeed (state is now active,
      // not recovery_pending; the recovery_token_hash should have been
      // cleared by the successful re-register per Phase 4b.1 v2 invariants).
      const replay = await rpc({
        port: PORT,
        args: {
          name: "register_agent",
          arguments: {
            name: "recovery-test-agent",
            role: "tester",
            capabilities: [],
            recovery_token: RECOVERY_TOKEN,
          },
        },
      });
      // Either the relay rejects with an error, or it treats the call as a
      // re-register (state already active) and does NOT include
      // recovery_completed:true. Both shapes prove single-use.
      if (replay.success) {
        expect(replay.recovery_completed).not.toBe(true);
      } else {
        expect(replay.success).toBe(false);
      }
    } finally {
      child.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 20_000);

  it("v2.6.2 R1 — revoke_token WITHOUT recovery (terminal revocation) also scrubs vault", async () => {
    // Per Maxime's call (2026-05-05), v2.6.2 R1 added a vault scrub to
    // revoke_token regardless of issue_recovery. The legitimate revocation
    // path (terminal revoke, agent should re-bootstrap from scratch) leaves
    // no credential on disk. This complements the recovery-flow test above
    // (which exercises issue_recovery=true) — both branches must scrub.
    const PORT = await getFreePort();
    const ROOT = path.join(os.tmpdir(), "v2-6-2-r1-revoke-scrub-" + process.pid);
    if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
    expect(fs.existsSync(DIST_INDEX)).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("child_process") as typeof import("child_process");

    const child = spawn("node", [DIST_INDEX], {
      env: {
        ...process.env,
        RELAY_TRANSPORT: "http",
        RELAY_HTTP_PORT: String(PORT),
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HOME: ROOT,
        RELAY_DB_PATH: path.join(ROOT, "relay.db"),
        RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
        RELAY_AGENT_TOKEN: "",
        RELAY_AGENT_NAME: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHealth(PORT, 5000);

      // Register admin + target.
      const adminReg = await rpc({
        port: PORT,
        args: { name: "register_agent", arguments: { name: "admin-rev2", role: "admin", capabilities: ["admin"] } },
      });
      expect(adminReg.success).toBe(true);
      const ADMIN_TOKEN = adminReg.agent_token;

      const targetReg = await rpc({
        port: PORT,
        args: { name: "register_agent", arguments: { name: "terminal-revoke-target", role: "tester", capabilities: [] } },
      });
      expect(targetReg.success).toBe(true);
      const ORIGINAL_TOKEN = targetReg.agent_token;

      // Write the original token to vault.
      const VAULT_FILE = path.join(ROOT, "agents", "terminal-revoke-target.token");
      fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true, mode: 0o700 });
      fs.writeFileSync(VAULT_FILE, ORIGINAL_TOKEN + "\n", { mode: 0o600 });
      expect(fs.existsSync(VAULT_FILE)).toBe(true);

      // Terminal revocation: issue_recovery=false. State goes to 'revoked'
      // (terminal), not 'recovery_pending'. No recovery_token issued.
      const revoked = await rpc({
        port: PORT,
        args: {
          name: "revoke_token",
          arguments: {
            target_agent_name: "terminal-revoke-target",
            revoker_name: "admin-rev2",
            issue_recovery: false,
          },
        },
        headers: { "X-Agent-Token": ADMIN_TOKEN },
      });
      expect(revoked.success).toBe(true);
      expect(revoked.changed).toBe(true);
      expect(revoked.auth_state_after).toBe("revoked");
      expect(revoked.recovery_token).toBeUndefined();

      // R1 contract: vault scrubbed even on terminal-revoke (no recovery).
      expect(fs.existsSync(VAULT_FILE)).toBe(false);

      // Original token now fails (state=revoked).
      const stale = await rpc({
        port: PORT,
        args: {
          name: "get_messages",
          arguments: { agent_name: "terminal-revoke-target", status: "pending", limit: 5 },
        },
        headers: { "X-Agent-Token": ORIGINAL_TOKEN },
      });
      expect(stale.auth_error).toBe(true);
      expect(stale.error_code).toBe("AUTH_FAILED");
    } finally {
      child.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { child.kill("SIGKILL"); } catch { /* */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 15_000);

  it("v2.6.2 R1 — revoke_token vault scrub is best-effort (missing vault is a no-op, not a failure)", async () => {
    // Idempotency: revoke_token must not fail when there's no vault file
    // to scrub (e.g. agent registered manually without a vault entry, or
    // the vault was already deleted out-of-band by the operator). The
    // delete is wrapped in try/catch in src/tools/identity.ts, and the
    // underlying FileTokenStore.deleteSync swallows ENOENT.
    const PORT = await getFreePort();
    const ROOT = path.join(os.tmpdir(), "v2-6-2-r1-revoke-noop-" + process.pid);
    if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("child_process") as typeof import("child_process");

    const child = spawn("node", [DIST_INDEX], {
      env: {
        ...process.env,
        RELAY_TRANSPORT: "http",
        RELAY_HTTP_PORT: String(PORT),
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HOME: ROOT,
        RELAY_DB_PATH: path.join(ROOT, "relay.db"),
        RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
        RELAY_AGENT_TOKEN: "",
        RELAY_AGENT_NAME: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHealth(PORT, 5000);
      const adminReg = await rpc({
        port: PORT,
        args: { name: "register_agent", arguments: { name: "admin-rev3", role: "admin", capabilities: ["admin"] } },
      });
      const ADMIN_TOKEN = adminReg.agent_token;
      const targetReg = await rpc({
        port: PORT,
        args: { name: "register_agent", arguments: { name: "no-vault-target", role: "tester", capabilities: [] } },
      });
      expect(targetReg.success).toBe(true);
      // Intentionally do NOT write a vault file.
      const VAULT_FILE = path.join(ROOT, "agents", "no-vault-target.token");
      expect(fs.existsSync(VAULT_FILE)).toBe(false);

      // Revoke with no vault present — must succeed cleanly.
      const revoked = await rpc({
        port: PORT,
        args: {
          name: "revoke_token",
          arguments: {
            target_agent_name: "no-vault-target",
            revoker_name: "admin-rev3",
            issue_recovery: true,
          },
        },
        headers: { "X-Agent-Token": ADMIN_TOKEN },
      });
      expect(revoked.success).toBe(true);
      expect(revoked.changed).toBe(true);
      // Vault still doesn't exist — no half-creation.
      expect(fs.existsSync(VAULT_FILE)).toBe(false);
    } finally {
      child.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { child.kill("SIGKILL"); } catch { /* */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 15_000);
});
