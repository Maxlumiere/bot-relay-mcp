// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR C containment — the traffic recorder must not persist minted tokens.
 *
 * `redact()` walked field NAMES only and let a bare string fall through, so a
 * token serialised inside the MCP response envelope `{content:[{text: …}]}` was
 * fsync'd to disk cleartext whenever RELAY_RECORD_TRAFFIC was set (register_agent
 * agent_token, rotate_token new_token, revoke_token recovery_token,
 * registration_recovery). ADR-0015 harm: a REAL minted token through the REAL
 * recorder to a REAL file, then grep the file — not a unit test on redact().
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const LOG_DIR = path.join(os.tmpdir(), "bot-relay-v243-recorder-" + process.pid);
const LOG_PATH = path.join(LOG_DIR, "traffic.jsonl");

const { recordCall, _resetTrafficRecorderForTests } = await import("../src/transport/traffic-recorder.js");
const { generateToken } = await import("../src/auth.js");

/** The MCP tool-response envelope every handler returns. */
function envelope(obj: Record<string, unknown>): unknown {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

beforeEach(() => {
  if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  delete process.env.RELAY_RECORD_TRAFFIC;
  _resetTrafficRecorderForTests();
});
afterEach(() => {
  delete process.env.RELAY_RECORD_TRAFFIC;
  _resetTrafficRecorderForTests();
  if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });
});

describe("v2.24.3 — traffic recorder does not persist minted tokens (PR C containment)", () => {
  it("real minted tokens inside response envelopes are NOT written to the traffic log", () => {
    process.env.RELAY_RECORD_TRAFFIC = LOG_PATH;
    _resetTrafficRecorderForTests(); // re-read the env with recording enabled

    const agentToken = generateToken();
    const newToken = generateToken();
    const recoveryToken = generateToken();
    const regRecovery = generateToken();

    // The four leaking response shapes, each through the REAL recordCall path.
    recordCall({
      tool: "register_agent",
      args: { name: "victim" },
      response: envelope({ success: true, agent_name: "victim", agent_token: agentToken, registration_recovery: regRecovery }),
      transport: "http",
    });
    recordCall({
      tool: "rotate_token",
      args: { agent_name: "victim" },
      response: envelope({ success: true, new_token: newToken }),
      transport: "http",
    });
    recordCall({
      tool: "revoke_token",
      args: { agent_name: "victim", issue_recovery: true },
      response: envelope({ success: true, recovery_token: recoveryToken }),
      transport: "http",
    });

    const disk = fs.readFileSync(LOG_PATH, "utf8");

    // HARM: no minted token value appears ANYWHERE in the on-disk log.
    for (const [label, tok] of [
      ["agent_token", agentToken],
      ["new_token", newToken],
      ["recovery_token", recoveryToken],
      ["registration_recovery", regRecovery],
    ] as const) {
      expect(disk.includes(tok), `${label} leaked to the traffic log on disk`).toBe(false);
    }

    // INNOCENT (non-vacuity + replay parity): the structural fields ARE recorded,
    // so redaction removed the secret, not the whole record. Three records written.
    expect(disk).toContain("register_agent");
    expect(disk).toContain("victim");
    expect(disk).toContain("rotate_token");
    expect(disk).toContain("revoke_token");
    expect(disk.trim().split("\n").length).toBe(3);
  });
});
