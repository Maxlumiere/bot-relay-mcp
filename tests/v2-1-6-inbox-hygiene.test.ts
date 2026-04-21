// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1.6 inbox hygiene tests.
 *
 *   1. get_messages gains optional `since` filter (default "24h", "all" and
 *      null preserve pre-v2.1.6 unlimited behavior, "session_start" anchors
 *      on agents.session_started_at).
 *   2. new MCP tool get_messages_summary returns {id, from_agent, priority,
 *      status, created_at, content_preview} with 100-char truncation and
 *      the same since + status filter surface. Pure observation — does not
 *      mutate read_by_session.
 *   3. CLI subcommand `relay purge-history <name>` deletes messages + tasks
 *      where the agent is sender or recipient. Preserves the agent row and
 *      audit_log entries. Idempotent.
 *   4. Kickstart prompt (bash + Linux + Windows drivers) includes the one-
 *      line reused-name nudge.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");
const SPAWN_SCRIPT = path.join(REPO_ROOT, "bin", "spawn-agent.sh");

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v216-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
process.env.RELAY_HTTP_PORT = "54998";

const { handleRegisterAgent } = await import("../src/tools/identity.js");
const { handleSendMessage, handleGetMessages, handleGetMessagesSummary } =
  await import("../src/tools/messaging.js");
const {
  closeDb,
  getDb,
  registerAgent,
  sendMessage,
  postTask,
  getMessagesSummary,
  getAgentSessionStart,
  purgeAgentHistory,
} = await import("../src/db.js");
const { GetMessagesSchema, GetMessagesSummarySchema } = await import(
  "../src/types.js"
);

function parseResult(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

// --- 1. `since` filter on get_messages ---

describe("v2.1.6 — get_messages `since` filter", () => {
  it("(1a) omitted since behaves like pre-v2.1.6 when called directly (undefined → no filter)", () => {
    handleRegisterAgent({ name: "sender", role: "r", capabilities: [] });
    handleRegisterAgent({ name: "receiver", role: "r", capabilities: [] });
    handleSendMessage({ from: "sender", to: "receiver", content: "x", priority: "normal" });

    const raw = { agent_name: "receiver", status: "pending", limit: 20 } as const;
    const data = parseResult(handleGetMessages(raw as any));
    expect(data.count).toBe(1);
  });

  it("(1b) explicit since:'1s' (future) filters out older messages", () => {
    handleRegisterAgent({ name: "sender", role: "r", capabilities: [] });
    handleRegisterAgent({ name: "receiver", role: "r", capabilities: [] });

    // Insert a message dated 2 days ago — older than any short since window.
    const db = getDb();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
    ).run("stale-id", "sender", "receiver", "old", "normal", twoDaysAgo);
    handleSendMessage({ from: "sender", to: "receiver", content: "fresh", priority: "normal" });

    const data = parseResult(
      handleGetMessages({ agent_name: "receiver", status: "pending", limit: 20, since: "1h" } as any)
    );
    expect(data.count).toBe(1);
    expect(data.messages[0].content).toBe("fresh");
    expect(data.since).toBe("1h");
    expect(data.since_bound).toBeTruthy();
  });

  it("(1c) since:'all' explicitly disables the filter (includes stale messages)", () => {
    handleRegisterAgent({ name: "sender", role: "r", capabilities: [] });
    handleRegisterAgent({ name: "receiver", role: "r", capabilities: [] });

    const db = getDb();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
    ).run("ancient", "sender", "receiver", "old", "normal", tenDaysAgo);
    handleSendMessage({ from: "sender", to: "receiver", content: "new", priority: "normal" });

    const data = parseResult(
      handleGetMessages({ agent_name: "receiver", status: "all", limit: 20, since: "all" } as any)
    );
    expect(data.count).toBe(2);
    expect(data.since_bound).toBeNull();
  });

  it("(1d) since:'session_start' anchors on agents.session_started_at", () => {
    handleRegisterAgent({ name: "sender", role: "r", capabilities: [] });
    handleRegisterAgent({ name: "receiver", role: "r", capabilities: [] });

    // Back-date the first (pre-session) message so it was written BEFORE
    // the receiver's session_started_at. Then register_agent again to rotate
    // the session anchor forward. The second (post-session) message lands
    // after the rotation and must be the only one returned.
    const db = getDb();
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
    ).run("pre-session", "sender", "receiver", "pre", "normal", longAgo);

    // Rotate session_started_at by re-registering.
    handleRegisterAgent({ name: "receiver", role: "r", capabilities: [] });
    const anchor = getAgentSessionStart("receiver");
    expect(anchor).toBeTruthy();

    handleSendMessage({ from: "sender", to: "receiver", content: "post", priority: "normal" });

    const data = parseResult(
      handleGetMessages({
        agent_name: "receiver",
        status: "all",
        limit: 20,
        since: "session_start",
      } as any)
    );
    expect(data.count).toBe(1);
    expect(data.messages[0].content).toBe("post");
  });

  it("(1e) Zod schema applies the '24h' default at the MCP boundary", () => {
    const parsed = GetMessagesSchema.parse({ agent_name: "x" });
    expect(parsed.since).toBe("24h");
  });

  it("(1f) malformed since returns a VALIDATION error, not a throw", () => {
    handleRegisterAgent({ name: "who", role: "r", capabilities: [] });
    const data = parseResult(
      handleGetMessages({
        agent_name: "who",
        status: "pending",
        limit: 20,
        since: "not-a-duration",
      } as any)
    );
    expect(data.success).toBe(false);
    expect(data.error_code).toBe("VALIDATION");
  });
});

// --- 2. get_messages_summary ---

describe("v2.1.6 — get_messages_summary tool", () => {
  it("(2a) returns headers + 100-char preview and does NOT mark messages read", () => {
    handleRegisterAgent({ name: "sender", role: "r", capabilities: [] });
    handleRegisterAgent({ name: "receiver", role: "r", capabilities: [] });
    const long = "X".repeat(500);
    handleSendMessage({ from: "sender", to: "receiver", content: long, priority: "high" });

    const data = parseResult(
      handleGetMessagesSummary({
        agent_name: "receiver",
        status: "pending",
        limit: 20,
      } as any)
    );
    expect(data.count).toBe(1);
    expect(data.summaries[0].content_preview.length).toBe(100);
    expect(data.summaries[0].content_truncated).toBe(true);
    expect(data.summaries[0].priority).toBe("high");
    expect(data.summaries[0].from_agent).toBe("sender");
    expect(data.summaries[0].id).toBeTruthy();
    // Pure-observation contract: status column still 'pending' after summary call.
    const db = getDb();
    const row = db.prepare("SELECT status FROM messages WHERE id = ?").get(data.summaries[0].id) as {
      status: string;
    };
    expect(row.status).toBe("pending");
  });

  it("(2b) short content is NOT marked truncated", () => {
    handleRegisterAgent({ name: "sender", role: "r", capabilities: [] });
    handleRegisterAgent({ name: "receiver", role: "r", capabilities: [] });
    handleSendMessage({ from: "sender", to: "receiver", content: "tiny", priority: "normal" });

    const data = parseResult(
      handleGetMessagesSummary({
        agent_name: "receiver",
        status: "pending",
        limit: 20,
      } as any)
    );
    expect(data.summaries[0].content_preview).toBe("tiny");
    expect(data.summaries[0].content_truncated).toBe(false);
  });

  it("(2c) honors since filter same as get_messages", () => {
    handleRegisterAgent({ name: "sender", role: "r", capabilities: [] });
    handleRegisterAgent({ name: "receiver", role: "r", capabilities: [] });

    const db = getDb();
    const ancient = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
    ).run("old", "sender", "receiver", "stale", "normal", ancient);
    handleSendMessage({ from: "sender", to: "receiver", content: "fresh", priority: "normal" });

    const data = parseResult(
      handleGetMessagesSummary({
        agent_name: "receiver",
        status: "all",
        limit: 20,
        since: "1h",
      } as any)
    );
    expect(data.count).toBe(1);
    expect(data.summaries[0].content_preview).toBe("fresh");
  });

  it("(2d) Zod schema is additive — same since field contract as get_messages", () => {
    const parsed = GetMessagesSummarySchema.parse({ agent_name: "x" });
    expect(parsed.since).toBe("24h");
    expect(parsed.status).toBe("pending");
    expect(parsed.limit).toBe(20);
  });
});

// --- 3. relay purge-history CLI ---

async function seedForPurge(): Promise<void> {
  registerAgent("reused", "builder", ["tasks"]);
  registerAgent("peer", "tester", []);
  sendMessage("peer", "reused", "m1", "normal");
  sendMessage("peer", "reused", "m2", "high");
  sendMessage("reused", "peer", "reply", "normal");
  postTask("peer", "reused", "t1", "first", "normal");
  postTask("reused", "peer", "t-reply", "inverse", "normal");
}

function runPurge(
  args: string[],
  input?: string
): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RELAY_DB_PATH: TEST_DB_PATH,
  };
  const r = spawnSync("node", [RELAY_BIN, "purge-history", ...args], {
    env,
    encoding: "utf-8",
    timeout: 5_000,
    input: input ?? "",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("v2.1.6 — relay purge-history CLI", () => {
  it("(3a) --yes deletes messages + tasks for both directions, preserves agent row", async () => {
    await seedForPurge();
    closeDb();

    const r = runPurge(["reused", "--yes"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/messages deleted:\s+3/);
    expect(r.stdout).toMatch(/tasks deleted:\s+2/);

    const { initializeDb } = await import("../src/db.js");
    await initializeDb();
    const db = getDb();
    const msgCount = (db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
    expect(msgCount).toBe(0);
    const taskCount = (db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c;
    expect(taskCount).toBe(0);
    const agentRow = db.prepare("SELECT name FROM agents WHERE name = ?").get("reused");
    expect(agentRow).toBeTruthy();
    const peerRow = db.prepare("SELECT name FROM agents WHERE name = ?").get("peer");
    expect(peerRow).toBeTruthy();
  });

  it("(3b) writes an audit_log entry with tool=purge-history.cli", async () => {
    await seedForPurge();
    closeDb();

    const r = runPurge(["reused", "--yes"]);
    expect(r.status).toBe(0);

    const { initializeDb } = await import("../src/db.js");
    await initializeDb();
    const db = getDb();
    const row = db
      .prepare(
        "SELECT tool, agent_name, source, success FROM audit_log WHERE tool = 'purge-history.cli' AND agent_name = ?"
      )
      .get("reused") as
      | { tool: string; agent_name: string; source: string; success: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.source).toBe("cli");
    expect(row!.success).toBe(1);
  });

  it("(3c) --dry-run leaves DB untouched", async () => {
    await seedForPurge();
    closeDb();

    const r = runPurge(["reused", "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/DRY RUN/);

    const { initializeDb } = await import("../src/db.js");
    await initializeDb();
    const db = getDb();
    const msgCount = (db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
    expect(msgCount).toBe(3);
    const taskCount = (db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c;
    expect(taskCount).toBe(2);
  });

  it("(3d) is idempotent — second --yes run on an empty-history agent does nothing", async () => {
    await seedForPurge();
    closeDb();

    const first = runPurge(["reused", "--yes"]);
    expect(first.status).toBe(0);
    const second = runPurge(["reused", "--yes"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/Nothing to purge/);
  });

  it("(3e) purgeAgentHistory db helper is transactional + returns counts", async () => {
    await seedForPurge();
    const result = purgeAgentHistory("reused");
    expect(result.messages_deleted).toBe(3);
    expect(result.tasks_deleted).toBe(2);
    const again = purgeAgentHistory("reused");
    expect(again.messages_deleted).toBe(0);
    expect(again.tasks_deleted).toBe(0);
  });
});

// --- 4. Kickstart nudge ---

describe("v2.1.6 — kickstart prompt nudge", () => {
  const nudgeRegex = /more than 5 inbox messages on first pull/;

  it("(4a) bash spawn-agent.sh default KICKSTART includes the reused-name nudge", () => {
    // Skip on non-darwin (integration gate matches the v2.1.5 precedent).
    if (process.platform !== "darwin") return;
    // /tmp/workspace is non-existent so the resolve-check skip path lets us
    // exercise the KICKSTART string without tripping the approved-roots gate
    // (matches the pattern in tests/spawn-integration.test.ts).
    const res = spawnSync(
      "bash",
      [SPAWN_SCRIPT, "testagent", "builder", "", "/tmp/workspace"],
      {
        env: { ...process.env, RELAY_SPAWN_DRY_RUN: "1" },
        encoding: "utf-8",
        timeout: 5_000,
      }
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(nudgeRegex);
  });

  it("(4b) Linux + Windows driver buildKickstart text includes the nudge when brief is set", async () => {
    // Drivers are platform-conditional (runtime gate in dispatcher), but the
    // command-construction is pure — we can invoke buildCommand directly on
    // both drivers regardless of host platform.
    const { linuxDriver } = await import("../src/spawn/drivers/linux.js");
    const { windowsDriver } = await import("../src/spawn/drivers/windows.js");
    const briefPath = path.join(TEST_DB_DIR, "brief.md");
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
    fs.writeFileSync(briefPath, "scope\n", "utf-8");

    const ctx = {
      hasBinary: () => true,
      terminalOverride: null,
    } as any;
    const input = {
      name: "tester",
      role: "builder",
      capabilities: [],
      cwd: os.tmpdir(),
      initial_message: null,
    } as any;

    const linuxCmd = linuxDriver.buildCommand(input, ctx, undefined, briefPath);
    const linuxJoined = [linuxCmd.exec, ...linuxCmd.args].join(" ");
    expect(linuxJoined).toMatch(nudgeRegex);

    const winCmd = windowsDriver.buildCommand(input, ctx, undefined, briefPath);
    const winJoined = [winCmd.exec, ...winCmd.args].join(" ");
    expect(winJoined).toMatch(nudgeRegex);
  });
});
