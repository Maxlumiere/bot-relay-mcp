// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 S3-lite, row 11 condition B2 (architect): a send to a TRANSIENT window
 * label is REFUSED LOUDLY. A transient label (`tmp:<folder>:<4hex>`) lives only in
 * agent_bindings; it has no agents row, no token and no inbox. `send_message`'s
 * `to` accepts any non-empty string, and mail to a name that is not an agent lands
 * in the pending-on-a-human lane. So without a refusal, mail to a window label would
 * sit there looking delivered, and nobody would ever read it.
 *
 * The refusal lives in the DB layer (sendMessage / postTask), the one choke point
 * every transport (MCP, HTTP, REST, CLI) shares. Its innocent twin: mail to a real
 * non-agent recipient (a human) still lands in the human lane.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const DIR = path.join(os.tmpdir(), "bot-relay-s3lite-transient-to-" + process.pid);
process.env.RELAY_DB_PATH = path.join(DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const { handleSendMessage } = await import("../src/tools/messaging.js");
const { handlePostTask } = await import("../src/tools/tasks.js");
const db = await import("../src/db.js");

const LABEL = "tmp:proj:ab12";

function parse(r: { content: { text: string }[] }) {
  return JSON.parse(r.content[0].text);
}
function rowsTo(name: string): number {
  return (db.getDb().prepare("SELECT COUNT(*) AS c FROM messages WHERE to_agent = ?").get(name) as { c: number }).c;
}
function cleanup() {
  db.closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
}
beforeEach(() => cleanup());
afterEach(() => cleanup());

describe("S3-lite B2 — mail to a transient window label is refused, never parked", () => {
  it("send_message to a transient label: success false, a specific error_code, and NO row", () => {
    db.registerAgent("b2-sender", "r", []);
    const r = parse(handleSendMessage({ from: "b2-sender", to: LABEL, content: "hello?", priority: "normal" } as never));
    expect(r.success).toBe(false);
    expect(r.error_code).toBe("RECIPIENT_IS_TRANSIENT");
    expect(r.error).toMatch(/no inbox/i);
    expect(rowsTo(LABEL), "nothing parked in the human lane").toBe(0);
  });

  it("the system sender is refused too (the refusal sits before the system bypass)", () => {
    db.getDb();
    expect(() => db.sendMessage("system", LABEL, "x", "normal")).toThrow(/transient/i);
    expect(rowsTo(LABEL)).toBe(0);
  });

  it("post_task to a transient label is refused", () => {
    db.registerAgent("b2-sender", "r", []);
    const r = parse(handlePostTask({ from: "b2-sender", to: LABEL, title: "t", description: "d", priority: "normal" } as never));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/transient/i);
  });

  it("INNOCENT TWIN: mail to a real non-agent recipient (a human) still lands in the human lane", () => {
    db.registerAgent("b2-sender", "r", []);
    const r = parse(handleSendMessage({ from: "b2-sender", to: "maxime-human", content: "for you", priority: "normal" } as never));
    expect(r.success).toBe(true);
    expect(rowsTo("maxime-human")).toBe(1);
  });
});
