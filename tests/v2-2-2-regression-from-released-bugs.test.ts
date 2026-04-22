// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.2 BUG3 — regression-from-released-bugs suite.
 *
 * ONE test case per bug discovered in the v2.1.x → v2.2.x arc that made
 * it into an operator's hands (not pre-ship catches). Permanent
 * regression coverage — this file grows with every release cycle. New
 * bugs each add a permanent case so the same mistake cannot re-land.
 *
 * Pattern for new entries:
 *   1. Name the case after the surfaced symptom, not the internal fix
 *      ("operator sees X" / "dashboard hides Y" — not "UPDATE missing").
 *   2. Comment-header references the originating bug's release + label
 *      (e.g. "v2.2.1 B3", "v2.2.2 BUG1") so the forensic chain is
 *      readable a year later.
 *   3. Exercise the EXTERNAL contract (MCP tool / CLI output / HTTP
 *      endpoint / derivation), not an internal helper — regressions
 *      reach operators via the external surface.
 *   4. Keep each case self-contained. Do NOT reuse fixtures across
 *      cases — this file must stay safe to extend without ordering
 *      dependencies.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v222-regression-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const { parseCliFlags } = await import("../src/cli.js");
const {
  closeDb,
  getDb,
  registerAgent,
  sendMessage,
  getMessages,
  closeAgentSession,
  getAgents,
} = await import("../src/db.js");
const { handleRegisterAgent } = await import("../src/tools/identity.js");
const { handleGetMessages } = await import("../src/tools/messaging.js");

beforeEach(() => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
});
afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("v2.2.2 regression-from-released-bugs", () => {
  // ─── v2.1.7-era / v2.2.1 B1 ─────────────────────────────────────────
  it("(1) CLI flags don't vanish silently — `node dist/index.js --transport=http --port=3777` parses both", () => {
    // Pre-v2.2.1 B1: `node dist/index.js --transport=http --port=3777`
    // silently ignored both args. Parser now surfaces them; unknown
    // flags fast-fail with exitCode=2.
    const ok = parseCliFlags(["--transport=http", "--port=3777"]);
    expect(ok.error).toBeNull();
    expect(ok.flags.transport).toBe("http");
    expect(ok.flags.port).toBe(3777);
    const bad = parseCliFlags(["--bogus"]);
    expect(bad.error).not.toBeNull();
    expect(bad.error!.exitCode).toBe(2);
    // --help must win over unknown flags (v2.2.1 L2).
    const helpWins = parseCliFlags(["--bogus", "--help"]);
    expect(helpWins.help).toBe(true);
    expect(helpWins.error).toBeNull();
  });

  // ─── v2.2.1 B3 ──────────────────────────────────────────────────────
  it("(2) daemon non-TTY guard — src/index.ts refuses stdio in non-TTY context without RELAY_SKIP_TTY_CHECK", () => {
    // Pre-v2.2.1 B3: `node dist/index.js` in a non-TTY context (sandbox
    // bash, systemd) silently exited when stdin closed. Regression
    // surface: an explicit error message + exit code 3, plus escape
    // hatch RELAY_SKIP_TTY_CHECK=1. We grep the source to anchor the
    // check — spawning a non-TTY daemon here would race + flake.
    const src = fs.readFileSync(path.join(process.cwd(), "src", "index.ts"), "utf-8");
    expect(src).toMatch(/RELAY_SKIP_TTY_CHECK/);
    expect(src).toMatch(/process\.exit\(3\)/);
  });

  // ─── v2.2.1 B4 ──────────────────────────────────────────────────────
  it("(3) since-filter trap — get_messages returns hint when narrow window hides pending mail", () => {
    registerAgent("r3-from", "r", []);
    registerAgent("r3-to", "r", []);
    // Backdate a pending message by 25 minutes.
    sendMessage("r3-from", "r3-to", "stale-pending", "normal");
    const stamp = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    getDb().prepare("UPDATE messages SET created_at = ? WHERE to_agent = ?").run(stamp, "r3-to");
    const res = handleGetMessages({
      agent_name: "r3-to",
      status: "pending",
      limit: 20,
      since: "15m",
      peek: false,
    } as any);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.count).toBe(0);
    expect(parsed.hint).toBeTruthy();
    expect(parsed.hint).toMatch(/since/i);
  });

  // ─── v2.2.1 B2 ──────────────────────────────────────────────────────
  it("(4) NAME_COLLISION_ACTIVE — re-registering an online agent rejects unless force=true", () => {
    // First registration seeds token; re-register without the real
    // token OR force will hit NAME_COLLISION_ACTIVE.
    const { plaintext_token } = registerAgent("r4", "r", []);
    expect(plaintext_token).toBeTruthy();
    // Re-register without force + without token → rejected.
    const reject = handleRegisterAgent({
      name: "r4",
      role: "r",
      capabilities: [],
      force: false,
    } as any);
    const rejectJson = JSON.parse(reject.content[0].text);
    expect(rejectJson.success).toBe(false);
    expect(rejectJson.error_code).toBe("NAME_COLLISION_ACTIVE");
    // force=true breaks the deadlock.
    const forceOk = handleRegisterAgent({
      name: "r4",
      role: "r",
      capabilities: [],
      force: true,
    } as any);
    const forceJson = JSON.parse(forceOk.content[0].text);
    expect(forceJson.success).toBe(true);
  });

  // ─── v2.2.2 BUG1 ────────────────────────────────────────────────────
  it("(5) read-mark race — peek=false drains, peek=true preserves", () => {
    registerAgent("r5-from", "r", []);
    registerAgent("r5-to", "r", []);
    sendMessage("r5-from", "r5-to", "m1", "normal");
    sendMessage("r5-from", "r5-to", "m2", "normal");
    // peek=true → two polls both return 2.
    const p1 = getMessages("r5-to", "pending", 20, true);
    const p2 = getMessages("r5-to", "pending", 20, true);
    expect(p1.length).toBe(2);
    expect(p2.length).toBe(2);
    // peek=false (default) drains.
    const consume = getMessages("r5-to", "pending", 20, false);
    const after = getMessages("r5-to", "pending", 20, false);
    expect(consume.length).toBe(2);
    expect(after.length).toBe(0);
  });

  // ─── v2.2.2 BUG2 ────────────────────────────────────────────────────
  it("(6) closed status — SIGINT-closed agents are 'closed' not 'offline'", () => {
    registerAgent("r6", "r", []);
    const sid = (getDb()
      .prepare("SELECT session_id FROM agents WHERE name = ?")
      .get("r6") as { session_id: string }).session_id;
    closeAgentSession("r6", sid);
    const derived = getAgents().find((a) => a.name === "r6");
    expect(derived?.agent_status).toBe("closed");
    expect(derived?.agent_status).not.toBe("offline");
  });
});
