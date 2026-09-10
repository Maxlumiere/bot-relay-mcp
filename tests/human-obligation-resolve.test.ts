// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

// The pending-on-a-human lane must be able to DRAIN. send_message(to="maxime",
// disposition="obligation") is accepted because there's no recipient-existence
// check — but a human has no token, so under recipient-only resolve scoping nobody
// could ever clear it (write-only lane). Fix: a SENDER may resolve an obligation it
// sent to a recipient that is NOT a registered agent. The load-bearing boundary —
// which these tests exist to prove — is that a sender can NEVER resolve mail
// addressed to a REAL agent.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-humanresolve-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const { handleRegisterAgent } = await import("../src/tools/identity.js");
const { handleSendMessage } = await import("../src/tools/messaging.js");
const { handleResolveMessages } = await import("../src/tools/messaging.js");
const { closeDb, resolveMessages, getHumanPendingObligations } = await import("../src/db.js");

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0].text);
}
function register(name: string) {
  return parse(handleRegisterAgent({ name, role: "builder", capabilities: [] } as any));
}
function obligation(from: string, to: string, content: string): string {
  const r = parse(handleSendMessage({ from, to, content, priority: "normal", disposition: "obligation" } as any));
  expect(r.success).toBe(true);
  return r.message_id;
}

beforeAll(() => {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  expect(register("sender").success).toBe(true);
  expect(register("realagent").success).toBe(true);
  expect(register("third").success).toBe(true);
});
afterAll(() => {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("human-obligation resolve — the lane can drain", () => {
  it("(a) a sender CAN resolve its own obligation to a non-agent, and it leaves the lane", () => {
    const id = obligation("sender", "maxime", "approve the release"); // maxime = not a registered agent
    expect(getHumanPendingObligations().some((h) => h.id === id)).toBe(true); // in the lane
    const r = resolveMessages("sender", [id]);
    expect(r.resolved_count).toBe(1);
    expect(r.resolved_ids).toContain(id);
    expect(getHumanPendingObligations().some((h) => h.id === id)).toBe(false); // drained
  });

  it("(b) THE BOUNDARY: a sender CANNOT resolve mail it sent to a REAL agent", () => {
    const id = obligation("sender", "realagent", "review the PR"); // realagent IS registered
    const r = resolveMessages("sender", [id]);
    expect(r.resolved_count).toBe(0); // THE boundary: neither recipient (to≠sender) nor sender-of-a-non-agent (to IS an agent)
    // the zero is legible: the diagnostic names realagent as a registered recipient (same note covers always-agent + flip):
    expect(r.blocked_by_recipient_registration.map((b) => b.to_agent)).toContain("realagent");
    // still pending for the real recipient to clear:
    const recipient = resolveMessages("realagent", [id]);
    expect(recipient.resolved_count).toBe(1); // (c) recipient-resolve still works
  });

  it("(d) an unrelated third agent (neither sender nor recipient) resolves nothing", () => {
    const id = obligation("sender", "maxime", "second question");
    const r = resolveMessages("third", [id]);
    expect(r.resolved_count).toBe(0);
    // and the real sender can still clear it:
    expect(resolveMessages("sender", [id]).resolved_count).toBe(1);
  });

  it("(e) LEGIBLE ZERO: recipient registered AFTER the obligation → sender can't resolve, and the note says why", () => {
    const id = obligation("sender", "futurehuman", "waiting on a decision"); // not an agent yet
    // ... the human later registers as an agent (human-named agents are a real pattern, e.g. concierge):
    expect(register("futurehuman").success).toBe(true);
    const r = resolveMessages("sender", [id]);
    expect(r.resolved_count).toBe(0); // the NOT IN agents guard now fails — evaluated at resolve time
    expect(r.blocked_by_recipient_registration.map((b) => b.to_agent)).toContain("futurehuman");
    // the handler turns that into a legible note, not a silent zero:
    const out = parse(handleResolveMessages({ agent_name: "sender", message_ids: [id] } as any));
    expect(out.resolved_count).toBe(0);
    expect(out.note).toMatch(/futurehuman/);
    expect(out.note).toMatch(/registered agent/i);
    expect(out.note).toMatch(/not a failure/i);
    // and the now-registered recipient CAN resolve its own mail:
    expect(resolveMessages("futurehuman", [id]).resolved_count).toBe(1);
  });
});
