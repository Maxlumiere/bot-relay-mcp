// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

// v1 Kanban dashboard — relay-side snapshot projection + outbound push.
// The board is a read-only projection of UNCAPPED primitives: agents (headers),
// and obligations owed by a HUMAN (a recipient with no agent row) as the
// pending-on-human lane. Per-task detail is deliberately absent in v1.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-dashpush-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
// ensure the push feature is OFF by default for the no-op test
delete process.env.RELAY_DASHBOARD_PUSH_URL;

const { handleRegisterAgent } = await import("../src/tools/identity.js");
const { handleSendMessage } = await import("../src/tools/messaging.js");
const { closeDb, getHumanPendingObligations } = await import("../src/db.js");
const { buildKanbanSnapshot, pushKanbanSnapshotOnce } = await import("../src/dashboard-push.js");

function parse(r: { content: Array<{ text: string }> }) {
  return JSON.parse(r.content[0].text);
}
function register(name: string) {
  return parse(handleRegisterAgent({ name, role: "builder", capabilities: [] } as any));
}
function obligation(from: string, to: string, content: string) {
  return parse(
    handleSendMessage({ from, to, content, priority: "normal", disposition: "obligation" } as any),
  );
}

beforeAll(() => {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  expect(register("sender").success).toBe(true);
  expect(register("realagent").success).toBe(true); // a REGISTERED recipient
});
afterAll(() => {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("v1 Kanban — pending-on-human lane (getHumanPendingObligations)", () => {
  it("surfaces an obligation owed by an UNREGISTERED human, not one owed by a registered agent", () => {
    expect(obligation("sender", "maxime", "approve the release").success).toBe(true); // human
    expect(obligation("sender", "realagent", "review the PR").success).toBe(true); // registered agent

    const human = getHumanPendingObligations();
    const toNames = human.map((h) => h.to_agent);
    expect(toNames).toContain("maxime"); // unregistered recipient → human lane
    expect(toNames).not.toContain("realagent"); // registered agent → belongs in its column, not here
    const m = human.find((h) => h.to_agent === "maxime");
    expect(m?.content_preview).toContain("approve the release");
    expect(m?.from_agent).toBe("sender");
  });
});

describe("v1 Kanban — snapshot shape (buildKanbanSnapshot)", () => {
  it("is a kanban.v1 projection with agent headers, the human lane, and task-detail explicitly OFF", () => {
    const snap = buildKanbanSnapshot("2026-09-09T00:00:00.000Z");
    expect(snap.schema).toBe("kanban.v1");
    expect(snap.generated_at).toBe("2026-09-09T00:00:00.000Z");
    expect(snap.agents.some((a) => a.name === "sender")).toBe(true);
    expect(snap.agents[0]).toHaveProperty("status"); // coarse status present
    expect(snap.agents[0]).toHaveProperty("cli_profile");
    expect(snap.pending_on_human.some((h) => h.to_agent === "maxime")).toBe(true);
    // per-task detail is deliberately NOT in v1 — and the page is told so
    expect(snap.task_detail_available).toBe(false);
    expect(snap.note).toMatch(/tasks. capability/i);
  });
});

describe("v1 Kanban — outbound push safety gates", () => {
  it("is a no-op (pushed:false) when dashboard_push_url is unconfigured", async () => {
    const r = await pushKanbanSnapshotOnce();
    expect(r.pushed).toBe(false);
    expect(r.reason).toMatch(/not configured/i);
  });

  it("REFUSES to push unsigned when a URL is set but no secret is configured (decision surface)", async () => {
    // The board is a decision surface — an unsigned POST endpoint is one leaked
    // URL away from writing false state onto a board Maxime trusts. A URL without
    // a secret must DISABLE the push, not silently degrade to unsigned.
    process.env.RELAY_DASHBOARD_PUSH_URL = "https://example.com/ingest";
    delete process.env.RELAY_DASHBOARD_PUSH_SECRET;
    try {
      const r = await pushKanbanSnapshotOnce();
      expect(r.pushed).toBe(false);
      expect(r.reason).toMatch(/secret/i);
      expect(r.reason).toMatch(/unsigned|refus/i);
    } finally {
      delete process.env.RELAY_DASHBOARD_PUSH_URL;
    }
  });
});
