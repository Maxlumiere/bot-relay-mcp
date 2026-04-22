// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.3.0 Part C — Phase 4s ambient-wake.
 *
 * C.1.1  Schema v11 migration is idempotent + adds the expected columns.
 * C.2.1  Delivery-time seq is assigned monotonically per recipient.
 * C.2.2  Re-reading a message returns the same seq (stable on second read).
 * C.3.1  peek_inbox_version is pure (no mutation; repeated peek idempotent).
 * C.3.2  peek returns epoch + last_seq + total_messages_count.
 * C.4.1  Epoch rotation invalidates a client's cursor semantic.
 * C.5.1  Filesystem marker writes under RELAY_FILESYSTEM_MARKERS=1.
 * C.5.2  Filesystem marker is a no-op when disabled.
 * C.6.1  /api/wake-agent endpoint path + marker round-trip.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v230-wake-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
const TEST_MARKER_DIR = path.join(os.tmpdir(), "bot-relay-v230-marker-" + process.pid);
process.env.RELAY_DB_PATH = TEST_DB_PATH;
process.env.RELAY_MARKER_DIR = TEST_MARKER_DIR;
delete process.env.RELAY_FILESYSTEM_MARKERS;
delete process.env.RELAY_HTTP_SECRET;

const {
  closeDb,
  getDb,
  registerAgent,
  sendMessage,
  getMessages,
  getOrCreateMailbox,
  peekMailboxVersion,
  rotateMailboxEpoch,
  CURRENT_SCHEMA_VERSION,
} = await import("../src/db.js");
const { touchMarker, markerPath, markersEnabled } = await import("../src/filesystem-marker.js");
const { handlePeekInboxVersion } = await import("../src/tools/peek-inbox-version.js");
const { startHttpServer } = await import("../src/transport/http.js");
const { _resetDashboardWsForTests } = await import("../src/transport/websocket.js");

let server: HttpServer | null = null;
let port = 0;

async function bootServer(): Promise<void> {
  if (server) { try { server.close(); } catch { /* ignore */ } }
  _resetDashboardWsForTests();
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 60));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
}

function postJson(p: string, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: p, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)) },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

beforeEach(() => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  if (fs.existsSync(TEST_MARKER_DIR)) fs.rmSync(TEST_MARKER_DIR, { recursive: true, force: true });
});
afterEach(() => {
  try { if (server) server.close(); } catch { /* ignore */ }
  server = null;
  _resetDashboardWsForTests();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  if (fs.existsSync(TEST_MARKER_DIR)) fs.rmSync(TEST_MARKER_DIR, { recursive: true, force: true });
  delete process.env.RELAY_FILESYSTEM_MARKERS;
});

describe("v2.3.0 C.1 — schema v11 migration", () => {
  it("(C.1.1) schema version is 11 after init + expected columns present", () => {
    registerAgent("c1-a", "r", []);
    const ver = (getDb().prepare("SELECT version FROM schema_info WHERE id = 1").get() as { version: number }).version;
    expect(ver).toBe(11);
    expect(CURRENT_SCHEMA_VERSION).toBe(11);
    const messageCols = (getDb().prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
    expect(messageCols).toContain("seq");
    expect(messageCols).toContain("epoch");
    const mailboxCols = (getDb().prepare("PRAGMA table_info(mailbox)").all() as { name: string }[]).map((c) => c.name);
    expect(mailboxCols).toContain("mailbox_id");
    expect(mailboxCols).toContain("agent_name");
    expect(mailboxCols).toContain("epoch");
    expect(mailboxCols).toContain("next_seq");
  });
});

describe("v2.3.0 C.2 — delivery-time seq assignment", () => {
  it("(C.2.1) seq is monotonic per recipient across multiple messages", () => {
    registerAgent("c2-from", "r", []);
    registerAgent("c2-to", "r", []);
    sendMessage("c2-from", "c2-to", "m1", "normal");
    sendMessage("c2-from", "c2-to", "m2", "normal");
    sendMessage("c2-from", "c2-to", "m3", "normal");
    const got = getMessages("c2-to", "pending", 100, true);
    const seqs = got.map((m) => m.seq).filter((s) => typeof s === "number") as number[];
    expect(seqs.length).toBe(3);
    // Every returned seq is non-null + distinct + forms a monotonic run.
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(seqs.length);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBe(sorted[i - 1] + 1);
    }
  });

  it("(C.2.2) re-reading the same message returns the same seq", () => {
    registerAgent("c22-from", "r", []);
    registerAgent("c22-to", "r", []);
    sendMessage("c22-from", "c22-to", "once", "normal");
    const a = getMessages("c22-to", "pending", 100, true);
    const b = getMessages("c22-to", "all", 100, true);
    expect(a[0].seq).toBeGreaterThan(0);
    const matching = b.find((m) => m.id === a[0].id);
    expect(matching?.seq).toBe(a[0].seq);
    expect(matching?.epoch).toBe(a[0].epoch);
  });
});

describe("v2.3.0 C.3 — peek_inbox_version", () => {
  it("(C.3.1) peek is pure — no mutation, repeated peek identical", () => {
    registerAgent("c3-from", "r", []);
    registerAgent("c3-to", "r", []);
    sendMessage("c3-from", "c3-to", "alpha", "normal");
    const a = peekMailboxVersion("c3-to");
    const b = peekMailboxVersion("c3-to");
    expect(a).toEqual(b);
    // Pending count via a separate peek-friendly get is unchanged.
    const pending = getMessages("c3-to", "pending", 100, true);
    expect(pending.length).toBe(1);
  });

  it("(C.3.2) peek reveals mailbox_id, epoch, last_seq, total_messages_count", () => {
    registerAgent("c32-from", "r", []);
    registerAgent("c32-to", "r", []);
    sendMessage("c32-from", "c32-to", "one", "normal");
    sendMessage("c32-from", "c32-to", "two", "normal");
    // Drain once to assign seqs.
    getMessages("c32-to", "pending", 100, true);
    const snap = peekMailboxVersion("c32-to");
    expect(snap.mailbox_id).toBeTruthy();
    expect(snap.epoch).toBeTruthy();
    expect(snap.last_seq).toBe(2);
    expect(snap.total_messages_count).toBe(2);
  });

  it("(C.3.3) handlePeekInboxVersion returns MCP-envelope JSON with the same fields", () => {
    registerAgent("c33", "r", []);
    const res = handlePeekInboxVersion({ agent_name: "c33" } as any);
    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true);
    expect(typeof body.mailbox_id).toBe("string");
    expect(typeof body.epoch).toBe("string");
    expect(body.last_seq).toBe(0);
    expect(body.total_messages_count).toBe(0);
  });
});

describe("v2.3.0 C.4 — epoch rotation", () => {
  it("(C.4.1) rotateMailboxEpoch changes the epoch returned by peek", () => {
    registerAgent("c4", "r", []);
    getOrCreateMailbox("c4");
    const before = peekMailboxVersion("c4").epoch;
    const rotated = rotateMailboxEpoch("c4");
    expect(rotated).not.toBe(before);
    expect(peekMailboxVersion("c4").epoch).toBe(rotated);
  });
});

describe("v2.3.0 C.5 — filesystem markers", () => {
  it("(C.5.1) touchMarker writes the marker file under RELAY_FILESYSTEM_MARKERS=1", () => {
    process.env.RELAY_FILESYSTEM_MARKERS = "1";
    expect(markersEnabled()).toBe(true);
    touchMarker("c5-target");
    const p = markerPath("c5-target");
    expect(p).toBeTruthy();
    expect(fs.existsSync(p!)).toBe(true);
  });

  it("(C.5.2) touchMarker is a no-op when the env is unset", () => {
    expect(markersEnabled()).toBe(false);
    touchMarker("c52-target");
    const p = markerPath("c52-target");
    expect(p).toBeTruthy();
    expect(fs.existsSync(p!)).toBe(false);
  });

  it("(C.5.3) malformed agent name returns null from markerPath + no file written", () => {
    process.env.RELAY_FILESYSTEM_MARKERS = "1";
    expect(markerPath("../../etc/passwd")).toBeNull();
    touchMarker("../../etc/passwd");
    // touchMarker(invalid) early-returns before mkdir, so the marker
    // dir itself is never created. Either outcome (dir missing, or dir
    // present but empty) is a pass — the invariant is "no file outside
    // the sanctioned namespace".
    if (fs.existsSync(TEST_MARKER_DIR)) {
      expect(fs.readdirSync(TEST_MARKER_DIR)).toEqual([]);
    }
  });
});

describe("v2.3.0 C.6 — wake-agent HTTP endpoint", () => {
  it("(C.6.1) POST /api/wake-agent disabled → markers_enabled=false in response", async () => {
    await bootServer();
    registerAgent("c6-target", "r", []);
    const res = await postJson("/api/wake-agent", { agent_name: "c6-target" });
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.markers_enabled).toBe(false);
  });

  it("(C.6.2) POST /api/wake-agent enabled → touches marker + returns path", async () => {
    process.env.RELAY_FILESYSTEM_MARKERS = "1";
    await bootServer();
    registerAgent("c62-target", "r", []);
    const res = await postJson("/api/wake-agent", { agent_name: "c62-target" });
    expect(res.status).toBe(200);
    expect(res.json.markers_enabled).toBe(true);
    expect(typeof res.json.marker_path).toBe("string");
    expect(fs.existsSync(res.json.marker_path)).toBe(true);
    // Audit entry landed.
    const audit = getDb()
      .prepare(
        "SELECT agent_name, tool, params_summary FROM audit_log " +
        "WHERE tool = 'wake_agent' AND source = 'dashboard' " +
        "ORDER BY id DESC LIMIT 1",
      )
      .get() as { agent_name: string; tool: string; params_summary: string } | undefined;
    expect(audit).toBeDefined();
    expect(audit!.agent_name).toBe("c62-target");
  });

  it("(C.6.3) POST /api/wake-agent with invalid body → 400", async () => {
    await bootServer();
    const res = await postJson("/api/wake-agent", { agent_name: "" });
    expect(res.status).toBe(400);
  });
});
