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
 *   - v2.11.0 GAP 1: host_id REFRESHES on re-register when re-reported; PRESERVES when
 *     omitted (was immutable pre-2.11.0) — and an initially-empty host_id can populate
 *   - re-register rotates session_id (session-aware reads)
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
import { resolveWakeTargetByPid, parseAgentBinding } from "../extensions/vscode/src/pid-binding.js";

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

describe("PID-handshake — DB layer (schema v17)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("schema is at version 17 with host_shell_pids + host_id columns", () => {
    registerAgent("seed", "role", []); // triggers init
    expect(CURRENT_SCHEMA_VERSION).toBe(17);
    expect(getSchemaVersion()).toBe(17);
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

  it("v2.11.0 GAP 1: host_id REFRESHES when re-reported, PRESERVES when omitted", () => {
    registerAgent("a", "builder", [], { host_shell_pids: [1], host_id: "GUID-A" });
    // Re-report a new host_id → overwrites (the owner declaring its current machine).
    registerAgent("a", "builder", [], { host_shell_pids: [2], host_id: "GUID-B" });
    expect(findAgent("a")?.host_id).toBe("GUID-B"); // refreshed, NOT pinned to GUID-A
    expect(findAgent("a")?.host_shell_pids).toEqual([2]);
    // Re-register WITHOUT host_id → preserves the stored value (don't wipe the binding).
    registerAgent("a", "builder", [], { host_shell_pids: [3] });
    expect(findAgent("a")?.host_id).toBe("GUID-B"); // preserved
    expect(findAgent("a")?.host_shell_pids).toEqual([3]);
  });

  it("v2.11.0 GAP 1: re-register populates an initially-empty host_id (the build-agent case)", () => {
    // Long-lived agent row first created WITHOUT a handshake → host_id null.
    registerAgent("agent", "builder", []);
    expect(findAgent("agent")?.host_id).toBeNull();
    expect(findAgent("agent")?.host_shell_pids).toBeNull();
    // A later relaunch reports the live chain + GUID → both populate. Pre-2.11.0
    // host_id was immutable, so an empty host_id could NEVER be filled in.
    registerAgent("agent", "builder", [], { host_shell_pids: [9, 8, 7], host_id: "GUID-NEW" });
    expect(findAgent("agent")?.host_id).toBe("GUID-NEW");
    expect(findAgent("agent")?.host_shell_pids).toEqual([9, 8, 7]);
  });

  it("re-register ROTATES session_id (session-aware reads see a fresh session)", () => {
    registerAgent("s", "builder", [], { host_shell_pids: [1], host_id: "GUID-A" });
    const first = findAgent("s")?.session_id;
    expect(first).toBeTruthy();
    registerAgent("s", "builder", [], { host_shell_pids: [2], host_id: "GUID-A" });
    const second = findAgent("s")?.session_id;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first); // rotated on re-register
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

// --- End-to-end round-trip: register pids+guid → discover → parse → match ---

describe("PID-handshake — round-trip + host-scoping invariant (real daemon)", () => {
  let daemon: DaemonHandle;
  beforeEach(async () => {
    daemon = await spawnDaemon();
  }, 20_000);
  afterEach(async () => {
    if (daemon) await tearDownDaemon(daemon);
  });

  it("a registered chain+host_id round-trips through discover_agents and binds the matching PID — same host only", async () => {
    // The agent registers its ancestry chain + machine GUID on first register.
    const reg = await callToolViaHttp(daemon.baseUrl, "register_agent", {
      name: "pid-agent",
      role: "builder",
      capabilities: [],
      host_shell_pids: [55566, 55479, 55465],
      host_id: "HOST-X",
    });
    expect(reg.ok).toBe(true);
    const token = (JSON.parse(reg.resultText ?? "{}") as { agent_token?: string }).agent_token;

    // Tether reads it back via discover_agents + parses the binding.
    const disc = await callToolViaHttp(daemon.baseUrl, "discover_agents", {}, token);
    expect(disc.ok).toBe(true);
    const binding = parseAgentBinding(JSON.parse(disc.resultText ?? "{}"), "pid-agent");
    expect(binding).toEqual({ hostShellPids: [55566, 55479, 55465], hostId: "HOST-X" });

    // Same-host: a terminal whose processId is the controlling shell (55479) —
    // even named "zsh" — binds by PID.
    const terms = [
      { name: "zsh", processId: 55479 },
      { name: "codex", processId: 12345 },
    ];
    const sameHost = resolveWakeTargetByPid("pid-agent", binding!, "HOST-X", terms);
    expect(sameHost.kind).toBe("inject");
    if (sameHost.kind === "inject") expect(sameHost.terminal.name).toBe("zsh");

    // Different host (equal PID present): host-scoping rejects → no PID match,
    // and "zsh" doesn't name-match → no-match. The federation-safety invariant.
    const otherHost = resolveWakeTargetByPid("pid-agent", binding!, "HOST-OTHER", terms);
    expect(otherHost.kind).toBe("no-match");
  }, 20_000);

  it("re-register OVERWRITES the chain end-to-end (discover reflects the new chain)", async () => {
    const reg = await callToolViaHttp(daemon.baseUrl, "register_agent", {
      name: "pid-agent2",
      role: "builder",
      capabilities: [],
      host_shell_pids: [111, 222],
      host_id: "HOST-X",
    });
    const token = (JSON.parse(reg.resultText ?? "{}") as { agent_token?: string }).agent_token;
    // Re-register (with the owner's token) reporting a fresh chain. force=true
    // bypasses the active-session collision guard (the name was just claimed +
    // still has a live session — this is the same owner re-reporting, not a
    // concurrent-terminal race).
    await callToolViaHttp(
      daemon.baseUrl,
      "register_agent",
      {
        name: "pid-agent2",
        role: "builder",
        capabilities: [],
        host_shell_pids: [333],
        host_id: "HOST-X",
        force: true,
      },
      token,
    );
    const disc = await callToolViaHttp(daemon.baseUrl, "discover_agents", {}, token);
    const binding = parseAgentBinding(JSON.parse(disc.resultText ?? "{}"), "pid-agent2");
    expect(binding?.hostShellPids).toEqual([333]); // overwritten, not [111,222,333]
  }, 20_000);

  it("v2.11.0 GAP 1: an AUTHENTICATED re-register refreshes host_id + host_shell_pids end-to-end", async () => {
    // First register with an empty handshake (the long-lived agent shape:
    // row exists, host_id null) and mint the owner's token.
    const reg = await callToolViaHttp(daemon.baseUrl, "register_agent", {
      name: "pid-agent3",
      role: "builder",
      capabilities: [],
    });
    expect(reg.ok).toBe(true);
    const token = (JSON.parse(reg.resultText ?? "{}") as { agent_token?: string }).agent_token;
    expect(token).toBeTruthy();

    // The owner relaunches and re-reports a fresh chain + a NEW host_id. force=true
    // bypasses the just-claimed active-session collision guard (same owner, not a
    // concurrent terminal). Pre-2.11.0 host_id was immutable — this would have
    // left host_id null forever.
    const refresh = await callToolViaHttp(
      daemon.baseUrl,
      "register_agent",
      {
        name: "pid-agent3",
        role: "builder",
        capabilities: [],
        host_shell_pids: [4242, 4200],
        host_id: "HOST-REFRESHED",
        force: true,
      },
      token,
    );
    expect(refresh.ok).toBe(true);

    const disc = await callToolViaHttp(daemon.baseUrl, "discover_agents", {}, token);
    const binding = parseAgentBinding(JSON.parse(disc.resultText ?? "{}"), "pid-agent3");
    expect(binding).toEqual({ hostShellPids: [4242, 4200], hostId: "HOST-REFRESHED" });
  }, 20_000);
});
