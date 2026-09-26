// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0041 R1, the handler walk: "check every handler for counts copied from the
 * input, not just this one". A read-only walk of all 28 mutating handlers found two
 * more receipts built from the request rather than from the write:
 *
 *   1. register_agent's `agent` object was PROJECTED IN MEMORY, not read back. On a
 *      first register it omitted server_version, cli_profile, host_id and
 *      host_shell_pids although the INSERT writes all four. On a re-register it
 *      spread the OLD row although the UPDATE writes server_version = VERSION and
 *      COALESCEs cli_profile.
 *   2. spawn_agent reported `has_initial_message: !!input.initial_message` even when
 *      sendMessage threw and the error was swallowed: no row, receipt says yes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-adr0041-walk-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

// spawn_agent must not launch a real terminal.
vi.mock("child_process", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn(), pid: 12345, stdout: null, stderr: null })),
    execFileSync: vi.fn(() => ""),
  };
});

// A switch that makes sendMessage fail the way SQLITE_BUSY or an encryption error
// would, so the swallowed-failure path in spawn_agent is reachable.
const failSend = { on: false };
vi.mock("../src/db.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown> & { sendMessage: (...a: unknown[]) => unknown };
  return {
    ...actual,
    sendMessage: (...a: unknown[]) => {
      if (failSend.on) throw new Error("SQLITE_BUSY: database is locked (injected)");
      return actual.sendMessage(...a);
    },
  };
});

const { handleRegisterAgent } = await import("../src/tools/identity.js");
const { handleSpawnAgent } = await import("../src/tools/spawn.js");
const { closeDb, getDb } = await import("../src/db.js");
const { VERSION } = await import("../src/version.js");

function parse(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

/** A relaunch: the prior session went quiet long enough that a re-register is allowed. */
function ageOut(name: string): void {
  getDb().prepare("UPDATE agents SET last_seen = '2000-01-01T00:00:00.000Z' WHERE name = ?").run(name);
}

function reRegister(name: string, token: string, extra: Record<string, unknown> = {}) {
  ageOut(name);
  const r = parse(handleRegisterAgent({ name, role: "r", capabilities: [], agent_token: token, ...extra } as never));
  expect(r.success, `precondition: the re-register landed (${r.error ?? ""})`).toBe(true);
  return r;
}

function stored(name: string): Record<string, unknown> {
  return getDb().prepare("SELECT * FROM agents WHERE name = ?").get(name) as Record<string, unknown>;
}

function cleanup() {
  closeDb();
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(() => {
  cleanup();
  failSend.on = false;
});
afterEach(() => cleanup());

describe("ADR-0041 R1 walk — register_agent's `agent` is what was WRITTEN", () => {
  it("first register: host_id, cli_profile, host_shell_pids and server_version match the stored row", () => {
    const r = parse(
      handleRegisterAgent({
        name: "walk-a",
        role: "builder",
        capabilities: [],
        host_id: "host-guid-1",
        cli_profile: "claude",
        host_shell_pids: [4242, 1],
      } as never),
    );
    const row = stored("walk-a");
    expect(row.host_id, "precondition: the INSERT wrote it").toBe("host-guid-1");
    expect(r.agent.host_id).toBe(row.host_id);
    expect(r.agent.cli_profile).toBe(row.cli_profile);
    expect(r.agent.host_shell_pids).toEqual(JSON.parse(String(row.host_shell_pids)));
    expect(r.agent.server_version).toBe(row.server_version);
    expect(r.agent.server_version).toBe(VERSION);
  });

  it("re-register: server_version is the one the UPDATE wrote, not the old row's", () => {
    const first = parse(handleRegisterAgent({ name: "walk-b", role: "r", capabilities: [] } as never));
    getDb().prepare("UPDATE agents SET server_version = '0.0.1' WHERE name = ?").run("walk-b");
    const again = reRegister("walk-b", first.agent_token);
    expect(stored("walk-b").server_version, "precondition: the UPDATE wrote VERSION").toBe(VERSION);
    expect(again.agent.server_version).toBe(VERSION);
  });

  it("re-register: a cli_profile supplied now (row had none) shows in the receipt", () => {
    const first = parse(handleRegisterAgent({ name: "walk-c", role: "r", capabilities: [] } as never));
    const again = reRegister("walk-c", first.agent_token, { cli_profile: "claude" });
    expect(stored("walk-c").cli_profile).toBe("claude");
    expect(again.agent.cli_profile).toBe("claude");
  });
});

describe("ADR-0041 R1 walk — spawn_agent's has_initial_message reports the insert", () => {
  const base = { name: "walk-child", role: "builder", capabilities: [], cwd: os.tmpdir() };

  it("HARM: the message insert FAILED → has_initial_message is false, and the reply says why", async () => {
    failSend.on = true;
    const r = parse(await handleSpawnAgent({ ...base, initial_message: "start here" } as never));
    const rows = getDb().prepare("SELECT COUNT(*) AS c FROM messages WHERE to_agent = ?").get("walk-child") as { c: number };
    expect(rows.c, "precondition: nothing was queued").toBe(0);
    expect(r.has_initial_message).toBe(false);
    expect(r.initial_message_error).toMatch(/not queued/i);
  });

  it("INNOCENT TWIN: the insert succeeded → has_initial_message is true and the row exists", async () => {
    const r = parse(await handleSpawnAgent({ ...base, initial_message: "start here" } as never));
    const rows = getDb().prepare("SELECT COUNT(*) AS c FROM messages WHERE to_agent = ?").get("walk-child") as { c: number };
    expect(rows.c).toBe(1);
    expect(r.has_initial_message).toBe(true);
    expect(r.initial_message_error).toBeUndefined();
  });
});

