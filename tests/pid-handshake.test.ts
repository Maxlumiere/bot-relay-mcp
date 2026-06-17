// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Tether v0.3 PID-handshake — relay-side (schema v16) contract.
 *
 * DB-layer invariants (in-process):
 *   - additive round-trip: register host_shell_pids + host_id → discover surfaces them parsed
 *   - H3: re-register OVERWRITES host_shell_pids when re-reported; PRESERVES when omitted
 *   - host_id is IMMUTABLE after first registration
 *   - legacy rows (no handshake) surface null for both
 *   - malformed stored JSON surfaces as null (never throws — discover can't crash)
 *   - schema is at v16 with both columns present
 *
 * Governance (real HTTP daemon — exercises the dispatcher auth, not the DB layer
 * which intentionally bypasses it): an unauthenticated re-register of an existing
 * name is REJECTED, and the attacker's host_shell_pids do NOT land. This is the
 * codex-probed boundary: writing PIDs under a name requires that name's token.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  spawnDaemon,
  tearDownDaemon,
  type DaemonHandle,
} from "./helpers/relay-http-harness.js";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-pid-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { registerAgent, getAgents, getSchemaVersion, CURRENT_SCHEMA_VERSION, closeDb, getDb } =
  await import("../src/db.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

function findAgent(name: string) {
  return getAgents().find((a) => a.name === name);
}

describe("PID-handshake — DB layer (schema v16)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("schema is at version 16 with host_shell_pids + host_id columns", () => {
    registerAgent("seed", "role", []); // triggers init
    expect(CURRENT_SCHEMA_VERSION).toBe(16);
    expect(getSchemaVersion()).toBe(16);
    const cols = (getDb().prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("host_shell_pids");
    expect(cols).toContain("host_id");
  });

  it("registers host_shell_pids + host_id and surfaces them parsed via discover", () => {
    registerAgent("a", "builder", ["x"], { host_shell_pids: [101, 55, 1], host_id: "GUID-A" });
    const a = findAgent("a");
    expect(a?.host_shell_pids).toEqual([101, 55, 1]);
    expect(a?.host_id).toBe("GUID-A");
  });

  it("legacy agents (no handshake) surface null for both fields", () => {
    registerAgent("legacy", "builder", []);
    const a = findAgent("legacy");
    expect(a?.host_shell_pids).toBeNull();
    expect(a?.host_id).toBeNull();
  });

  it("H3: re-register OVERWRITES host_shell_pids (replace, not append)", () => {
    registerAgent("a", "builder", [], { host_shell_pids: [100, 200], host_id: "GUID-A" });
    registerAgent("a", "builder", [], { host_shell_pids: [300] });
    expect(findAgent("a")?.host_shell_pids).toEqual([300]); // NOT [100,200,300]
  });

  it("re-register with host_shell_pids OMITTED preserves the stored chain", () => {
    registerAgent("a", "builder", [], { host_shell_pids: [100, 200], host_id: "GUID-A" });
    registerAgent("a", "deployer", []); // re-register, no PID re-report
    expect(findAgent("a")?.host_shell_pids).toEqual([100, 200]);
  });

  it("host_id is IMMUTABLE after first registration", () => {
    registerAgent("a", "builder", [], { host_shell_pids: [1], host_id: "GUID-A" });
    registerAgent("a", "builder", [], { host_shell_pids: [2], host_id: "GUID-B-attempt" });
    expect(findAgent("a")?.host_id).toBe("GUID-A"); // unchanged
    expect(findAgent("a")?.host_shell_pids).toEqual([2]); // pids still mutable
  });

  it("malformed stored host_shell_pids JSON surfaces as null (parse never throws)", () => {
    registerAgent("a", "builder", [], { host_shell_pids: [1], host_id: "GUID-A" });
    // Corrupt the column directly to simulate a bad/old row.
    getDb().prepare("UPDATE agents SET host_shell_pids = ? WHERE name = ?").run("{not json", "a");
    expect(() => getAgents()).not.toThrow();
    expect(findAgent("a")?.host_shell_pids).toBeNull();
  });
});

// --- Governance: dispatcher-layer name-auth (real HTTP daemon) ---

interface RpcResult {
  ok: boolean;
  resultText?: string;
  raw: string;
}

async function callToolViaHttp(
  baseUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  token?: string,
): Promise<RpcResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers["X-Agent-Token"] = token;
  const resp = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  const raw = await resp.text();
  const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) return { ok: resp.ok, raw };
  const rpc = JSON.parse(dataLine.slice(6)) as {
    error?: unknown;
    result?: { isError?: boolean; content?: { text?: string }[] };
  };
  // A tool that throws surfaces as result.isError (MCP) or a top-level error.
  const isError = !!rpc.error || rpc.result?.isError === true;
  return { ok: !isError, resultText: rpc.result?.content?.[0]?.text, raw };
}

describe("PID-handshake — governance (dispatcher name-auth, real daemon)", () => {
  let daemon: DaemonHandle;

  beforeEach(async () => {
    daemon = await spawnDaemon();
  }, 20_000);
  afterEach(async () => {
    if (daemon) await tearDownDaemon(daemon);
  });

  it("rejects an unauthenticated re-register and does NOT write the attacker's host_shell_pids", async () => {
    // First registration claims the name + mints a token (no PIDs reported).
    const reg = await callToolViaHttp(daemon.baseUrl, "register_agent", {
      name: "gov-victim",
      role: "builder",
      capabilities: [],
    });
    expect(reg.ok).toBe(true);
    const victimToken = (JSON.parse(reg.resultText ?? "{}") as { agent_token?: string }).agent_token;
    expect(victimToken).toBeTruthy();

    // Attacker re-registers the SAME name with a forged PID chain + a WRONG token.
    const attack = await callToolViaHttp(
      daemon.baseUrl,
      "register_agent",
      { name: "gov-victim", role: "builder", capabilities: [], host_shell_pids: [9999], host_id: "ATTACKER" },
      "definitely-not-the-real-token",
    );
    expect(attack.ok).toBe(false); // dispatcher auth rejects before the handler

    // The forged PIDs/host_id must NOT have landed. Read with the victim's own
    // (still-valid) token — the attack was rejected, so its credentials stand.
    const disc = await callToolViaHttp(daemon.baseUrl, "discover_agents", {}, victimToken);
    expect(disc.ok).toBe(true);
    const parsed = JSON.parse(disc.resultText ?? "{}") as {
      agents?: Array<{ name: string; host_shell_pids: number[] | null; host_id: string | null }>;
    };
    const victim = parsed.agents?.find((a) => a.name === "gov-victim");
    expect(victim).toBeTruthy();
    expect(victim?.host_shell_pids).toBeNull();
    expect(victim?.host_id).toBeNull();
  }, 20_000);
});
