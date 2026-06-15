// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.
//
// v2.10 — capability-routed messaging (principle #1: capability routing over
// named routing). A sender tags an FYI by a single domain/capability and the
// relay fans it out to the CURRENT owner(s) of that capability via the normal
// messages inbox. FYI/coordination lane ONLY — the action lane (point-to-point
// ship-pongs) stays send_message and is kept machine-distinguishable via the
// routed_capability column + the get_messages lane filter.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-caprouting-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const {
  registerAgent,
  sendMessage,
  getMessages,
  postToCapability,
  findCapabilityOwners,
  getDb,
  closeDb,
} = await import("../src/db.js");

const { handlePostToCapability } = await import("../src/tools/messaging.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
});

/** Count messages rows directly (bypasses session read semantics). */
function rawMessageCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
  return row.n;
}

describe("v2.10 — migration: messages.routed_capability column", () => {
  it("adds a nullable routed_capability column (schema v14)", () => {
    // Touch the DB so init runs.
    registerAgent("seed", "worker", ["x"]);
    const cols = getDb()
      .prepare("PRAGMA table_info(messages)")
      .all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "routed_capability")).toBe(true);
  });

  it("leaves routed_capability NULL on point-to-point send_message rows", () => {
    registerAgent("alice", "worker", ["x"]);
    registerAgent("bob", "worker", ["y"]);
    const msg = sendMessage("alice", "bob", "hi", "normal");
    const row = getDb()
      .prepare("SELECT routed_capability FROM messages WHERE id = ?")
      .get(msg.id) as { routed_capability: string | null };
    expect(row.routed_capability).toBeNull();
  });
});

describe("v2.10 — findCapabilityOwners", () => {
  it("returns every agent whose capability set includes the tag (exact match)", () => {
    registerAgent("concierge", "concierge", ["relationships", "calendar"]);
    registerAgent("builder", "builder", ["build"]);
    expect(findCapabilityOwners("relationships")).toEqual(["concierge"]);
    expect(findCapabilityOwners("build")).toEqual(["builder"]);
  });

  it("returns ALL owners (fan-out), ordered by name", () => {
    registerAgent("zeta", "builder", ["build"]);
    registerAgent("alpha", "builder", ["build"]);
    expect(findCapabilityOwners("build")).toEqual(["alpha", "zeta"]);
  });

  it("does NOT fuzzy/substring match — exact string only", () => {
    registerAgent("concierge", "concierge", ["relationships"]);
    expect(findCapabilityOwners("relationship")).toEqual([]); // singular ≠ plural
    expect(findCapabilityOwners("relation")).toEqual([]);
  });

  it("excludes the sender when excludeSender is provided", () => {
    registerAgent("a", "builder", ["build"]);
    registerAgent("b", "builder", ["build"]);
    expect(findCapabilityOwners("build", "a")).toEqual(["b"]);
  });

  it("returns [] when no agent owns the capability", () => {
    registerAgent("a", "builder", ["build"]);
    expect(findCapabilityOwners("astrology")).toEqual([]);
  });
});

describe("v2.10 — postToCapability fan-out", () => {
  it("routes to the single owner of a capability", () => {
    registerAgent("concierge", "concierge", ["relationships"]);
    registerAgent("scout", "worker", ["scan"]);
    const res = postToCapability("scout", "relationships", "found a lead", "normal");
    expect(res.routed_to).toEqual(["concierge"]);
    expect(res.message_ids).toHaveLength(1);

    // The owning persona picks it up on a normal get_messages drain, with
    // the capability provenance attached.
    const inbox = getMessages("concierge", "all", 50, true, null, "all");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].content).toBe("found a lead");
    expect(inbox[0].routed_capability).toBe("relationships");
    expect(inbox[0].from_agent).toBe("scout");
  });

  it("fans out one row per owner to ALL current owners", () => {
    registerAgent("b1", "builder", ["build"]);
    registerAgent("b2", "builder", ["build"]);
    registerAgent("scout", "worker", ["scan"]);
    const res = postToCapability("scout", "build", "ci is red", "high");
    expect(res.routed_to.sort()).toEqual(["b1", "b2"]);
    expect(res.message_ids).toHaveLength(2);
    expect(rawMessageCount()).toBe(2);
  });

  it("excludes the sender by default (exclude_self=true)", () => {
    registerAgent("concierge", "concierge", ["relationships"]);
    // concierge tags its own domain — should not ping itself.
    const res = postToCapability("concierge", "relationships", "self note", "normal", true);
    expect(res.routed_to).toEqual([]);
    expect(rawMessageCount()).toBe(0);
  });

  it("includes the sender when exclude_self=false", () => {
    registerAgent("concierge", "concierge", ["relationships"]);
    const res = postToCapability("concierge", "relationships", "self note", "normal", false);
    expect(res.routed_to).toEqual(["concierge"]);
    expect(res.message_ids).toHaveLength(1);
  });

  it("NO-OWNER CASE (ruling #2): returns routed_to:[] and stores NOTHING (fire-and-forget, not queued)", () => {
    registerAgent("scout", "worker", ["scan"]);
    const res = postToCapability("scout", "astrology", "nobody owns this", "normal");
    expect(res.routed_to).toEqual([]);
    expect(res.message_ids).toEqual([]);
    // Critical: no row was inserted (NOT queued-until-owner — that's task semantics).
    expect(rawMessageCount()).toBe(0);
  });
});

describe("v2.10 — hard line: action vs FYI is machine-distinguishable (get_messages lane filter)", () => {
  it("lane='direct' returns only point-to-point; lane='capability' returns only FYI; lane='all' returns both", () => {
    registerAgent("concierge", "concierge", ["relationships"]);
    registerAgent("scout", "worker", ["scan"]);

    // One action-lane ship-pong (point-to-point) ...
    sendMessage("scout", "concierge", "ACTION: review my PR", "high");
    // ... and one FYI-lane capability-routed message to the same inbox.
    postToCapability("scout", "relationships", "FYI: cross-cutting intel", "normal");

    const all = getMessages("concierge", "all", 50, true, null, "all");
    expect(all).toHaveLength(2);

    const direct = getMessages("concierge", "all", 50, true, null, "direct");
    expect(direct).toHaveLength(1);
    expect(direct[0].routed_capability).toBeNull();
    expect(direct[0].content).toBe("ACTION: review my PR");

    const fyi = getMessages("concierge", "all", 50, true, null, "capability");
    expect(fyi).toHaveLength(1);
    expect(fyi[0].routed_capability).toBe("relationships");
    expect(fyi[0].content).toBe("FYI: cross-cutting intel");
  });
});

describe("v2.10 — handlePostToCapability (tool handler)", () => {
  function parse(result: any) {
    return JSON.parse(result.content[0].text);
  }

  it("returns success with routed_to + count + note when an owner exists", () => {
    registerAgent("concierge", "concierge", ["relationships"]);
    registerAgent("scout", "worker", ["scan"]);
    const out = parse(
      handlePostToCapability({
        from: "scout",
        capability: "relationships",
        content: "found a lead",
        priority: "normal",
        exclude_self: true,
      } as any)
    );
    expect(out.success).toBe(true);
    expect(out.capability).toBe("relationships");
    expect(out.routed_to).toEqual(["concierge"]);
    expect(out.count).toBe(1);
    expect(out.message_ids).toHaveLength(1);
  });

  it("returns routed_to:[] with an explanatory note when no owner exists", () => {
    registerAgent("scout", "worker", ["scan"]);
    const out = parse(
      handlePostToCapability({
        from: "scout",
        capability: "astrology",
        content: "nobody owns this",
        priority: "normal",
        exclude_self: true,
      } as any)
    );
    expect(out.success).toBe(true);
    expect(out.routed_to).toEqual([]);
    expect(out.count).toBe(0);
    expect(out.note).toMatch(/No registered owner/i);
  });
});
