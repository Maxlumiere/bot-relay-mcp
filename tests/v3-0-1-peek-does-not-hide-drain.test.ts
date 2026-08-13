// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

// 3.0.1 (the-fixer / victra seq 883): a shipped 3.0.0 silent-non-delivery defect. #198 made
// a pending drain return undelivered mail regardless of `since`, but keyed "undelivered" on
// the OBSERVED axis (`seq IS NULL`). A non-consuming PEEK — what every watcher does
// (Sentinel, the dashboard, `relay watch`) — stamps `seq` without delivering, so peeking an
// aged undelivered message lapsed the escape and the `since` window then hid it from the
// recipient's own drain. The fix keys the escape on the DELIVERED axis (read_by_session IS
// NULL = NEVER_DRAINED_SQL), the same SSOT the purge exemption and wake detector use.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-peekdrain-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const { registerAgent, sendMessage, getMessages, getDb, closeDb } = await import("../src/db.js");

const HOUR = 60 * 60 * 1000;
const sinceHoursAgo = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

function ensureAgent(name: string): void {
  if (!getDb().prepare("SELECT 1 FROM agents WHERE name = ?").get(name)) registerAgent(name, "tester", ["test"]);
}
function seed(from: string, to: string, content: string, hoursAgo: number): string {
  ensureAgent(from);
  sendMessage(from, to, content, "normal");
  const { id } = getDb().prepare("SELECT id FROM messages ORDER BY rowid DESC LIMIT 1").get() as { id: string };
  getDb().prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(sinceHoursAgo(hoursAgo), id);
  return id;
}
function row(id: string) {
  return getDb().prepare("SELECT seq, read_by_session FROM messages WHERE id = ?").get(id) as {
    seq: number | null;
    read_by_session: string | null;
  };
}

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(cleanup);
afterEach(cleanup);

describe("3.0.1 — a peek does not hide a recipient's aged undelivered mail from its drain", () => {
  it("PRIMARY: peek an aged undelivered message, then a WINDOWED drain still returns it", () => {
    registerAgent("recip", "r", []);
    const id = seed("sender", "recip", "aged undelivered", 48); // older than the 24h window

    // Pre: never observed, never drained.
    expect(row(id).seq).toBeNull();
    expect(row(id).read_by_session).toBeNull();

    // PEEK — what a watcher does. Stamps the observation cursor (seq), does NOT mark read.
    getMessages("recip", "pending", 50, /*peek*/ true, /*since*/ null);
    expect(row(id).seq, "a peek stamps the observation cursor (seq)").not.toBeNull();
    expect(row(id).read_by_session, "a peek does NOT mark read").toBeNull();

    // DRAIN with the 24h window. The FIX: the message is STILL returned — undelivered means
    // NOT DRAINED, and no session has drained it, so the since-escape keeps it eligible.
    const drained = getMessages("recip", "pending", 50, /*peek*/ false, /*since*/ sinceHoursAgo(24));
    expect(
      drained.some((m) => m.id === id),
      "an aged undelivered message a watcher merely peeked must still reach its recipient's own drain",
    ).toBe(true);
  });

  it("CONTROL: a never-peeked aged undelivered message is returned by a windowed drain too (unchanged)", () => {
    registerAgent("recip2", "r", []);
    const id = seed("sender", "recip2", "aged, never peeked", 48);
    const drained = getMessages("recip2", "pending", 50, false, sinceHoursAgo(24));
    expect(drained.some((m) => m.id === id)).toBe(true);
  });

  it("a DRAINED (delivered) aged message is NOT re-returned by a windowed drain — history is bounded by `since`", () => {
    registerAgent("recip3", "r", []);
    const id = seed("sender", "recip3", "aged, already delivered", 48);
    getMessages("recip3", "pending", 50, false, null); // first drain delivers it (marks read)
    expect(row(id).read_by_session, "the first drain marks it read").not.toBeNull();
    const second = getMessages("recip3", "pending", 50, false, sinceHoursAgo(24));
    expect(second.some((m) => m.id === id), "delivered history older than the window is correctly bounded").toBe(false);
  });
});
