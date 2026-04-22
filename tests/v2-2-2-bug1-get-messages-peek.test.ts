// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.2 BUG1 — get_messages `peek` parameter.
 *
 * Pre-v2.2.2 `getMessages(agentName, 'pending', …)` marked every
 * returned row as read-by-the-current-session after the SELECT,
 * consuming them on the first poll. Orchestrators that survey their
 * own inbox repeatedly (Victra's polling pattern) lost visibility of
 * real pending mail the moment they looked at it once.
 *
 * With `peek=true`, the mark-as-read side effect is skipped. Two
 * consecutive pending polls by the same session return the same
 * rows. Default `peek=false` preserves v2.0 consume-once semantics
 * for single-shot workers.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v222-bug1-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;

const { closeDb, registerAgent, sendMessage, getMessages } = await import("../src/db.js");

beforeEach(() => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("v2.2.2 BUG1 — get_messages peek param", () => {
  it("(1) peek=false (default): first poll returns N, second returns 0 (consume-once preserved)", () => {
    registerAgent("peek-from", "r", []);
    registerAgent("peek-to", "r", []);
    sendMessage("peek-from", "peek-to", "one", "normal");
    sendMessage("peek-from", "peek-to", "two", "normal");
    const first = getMessages("peek-to", "pending", 20);
    expect(first.length).toBe(2);
    const second = getMessages("peek-to", "pending", 20);
    expect(second.length).toBe(0);
  });

  it("(2) peek=true: first + second polls both return N (no read-mark side effect)", () => {
    registerAgent("peek2-from", "r", []);
    registerAgent("peek2-to", "r", []);
    sendMessage("peek2-from", "peek2-to", "alpha", "normal");
    sendMessage("peek2-from", "peek2-to", "beta", "normal");
    const first = getMessages("peek2-to", "pending", 20, true);
    expect(first.length).toBe(2);
    const second = getMessages("peek2-to", "pending", 20, true);
    expect(second.length).toBe(2);
    // IDs match — same rows returned.
    expect(new Set(second.map((m) => m.id))).toEqual(new Set(first.map((m) => m.id)));
  });

  it("(3) peek=true followed by peek=false: peek preserves, subsequent consume drains", () => {
    registerAgent("peek3-from", "r", []);
    registerAgent("peek3-to", "r", []);
    sendMessage("peek3-from", "peek3-to", "x", "normal");
    const peeked = getMessages("peek3-to", "pending", 20, true);
    expect(peeked.length).toBe(1);
    const consumed = getMessages("peek3-to", "pending", 20, false);
    expect(consumed.length).toBe(1);
    const third = getMessages("peek3-to", "pending", 20, false);
    expect(third.length).toBe(0);
  });

  it("(4) peek=true with status='all': returns N without marking", () => {
    registerAgent("peek4-from", "r", []);
    registerAgent("peek4-to", "r", []);
    sendMessage("peek4-from", "peek4-to", "m1", "normal");
    sendMessage("peek4-from", "peek4-to", "m2", "normal");
    const first = getMessages("peek4-to", "all", 20, true);
    expect(first.length).toBe(2);
    // Pending poll afterward must still see both (peek must not have
    // marked them read as a side effect).
    const pending = getMessages("peek4-to", "pending", 20, true);
    expect(pending.length).toBe(2);
  });
});
