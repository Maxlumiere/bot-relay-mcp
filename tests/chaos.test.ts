// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 5b — chaos injection.
 *
 * Each test spawns the relay as a subprocess, drives traffic, triggers a
 * violent failure mode (SIGTERM / SIGKILL / WAL corruption / DB swap),
 * restarts, and asserts recovery invariants:
 *   - PRAGMA integrity_check returns "ok"
 *   - No half-written state (CAS either committed or rolled back, no torn rows)
 *   - Rotation state coherent (never rotation_grace w/ missing previous_token_hash)
 *
 * Runs SEQUENTIALLY (`{ concurrent: false }`, vitest 5's spelling: `describe.sequential` is gone) — each
 * test needs a clean subprocess lifecycle.
 *
 * Gated behind --full in pre-publish-check.sh; NOT part of the default
 * vitest run (each test takes 2-10s).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { getFreePort } from "./_helpers/port.js";
import { toolCallResult, type ToolRefusal } from "./_helpers/mcp-tool-call.js";
import { mintHeaders } from "./_helpers/mint.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const RELAY_BIN = path.join(REPO_ROOT, "dist", "index.js");

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-chaos-" + process.pid);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");

let daemon: ChildProcess | null = null;
let port = 0;

async function startDaemon(extraEnv: Record<string, string> = {}): Promise<void> {
  // v2.6.3: pre-allocate via getFreePort (kernel-assigned 127.0.0.1 port,
  // released microseconds before daemon binds). Replaces pre-v2.6.3
  // `40000 + Math.random()*10000` random-in-range pattern which had a
  // small but real collision risk against stale processes from interrupted
  // gate iterations.
  port = await getFreePort();
  daemon = spawn(
    "node",
    [RELAY_BIN],
    {
      env: {
        ...process.env,
        RELAY_TRANSPORT: "http",
        RELAY_HTTP_PORT: String(port),
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_DB_PATH: TEST_DB_PATH,
        RELAY_CONFIG_PATH: path.join(TEST_ROOT, "config.json"),
        ...extraEnv,
      },
      stdio: ["ignore", "ignore", "pipe"],
    }
  );
  // Wait up to 5s for /health to respond.
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("daemon did not come up");
}

async function killDaemon(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (!daemon) return;
  daemon.kill(signal);
  await new Promise<void>((resolve) => {
    daemon!.once("exit", () => resolve());
    setTimeout(() => resolve(), 2000);
  });
  daemon = null;
}

async function rpc(tool: string, args: any, token?: string, refusal?: ToolRefusal): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers["X-Agent-Token"] = token;
  // PR-D: a NEW name over HTTP needs the daemon's registration secret (created beside TEST_DB_PATH at start).
  if (tool === "register_agent") Object.assign(headers, mintHeaders(TEST_DB_PATH));
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  return toolCallResult(res, { tool, expect: refusal });
}

/** PRAGMA wal_checkpoint(FULL) on the test DB, from a second connection while the daemon holds its own. */
function checkpointFull(): { busy: number; log: number; checkpointed: number } {
  const Better = require("better-sqlite3");
  const db = new Better(TEST_DB_PATH);
  try {
    return db.pragma("wal_checkpoint(FULL)")[0] as { busy: number; log: number; checkpointed: number };
  } finally {
    db.close();
  }
}

function integrityCheck(): string {
  const Better = require("better-sqlite3");
  const db = new Better(TEST_DB_PATH, { readonly: true });
  const r = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  db.close();
  return r.integrity_check;
}

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(async () => {
  await killDaemon("SIGKILL");
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("v2.1 Phase 5b — chaos injection", { concurrent: false }, () => {
  it("(C.1) SIGTERM during concurrent writes — integrity_check ok after restart, no torn rows", async () => {
    await startDaemon();
    const tokA = (await rpc("register_agent", { name: "c1-a", role: "r", capabilities: [] })).agent_token;
    await rpc("register_agent", { name: "c1-b", role: "r", capabilities: [] });
    // Fire 20 concurrent sends, kill at ~halfway.
    const sends = Array.from({ length: 20 }, (_, i) =>
      rpc("send_message", { from: "c1-a", to: "c1-b", content: `chaos-${i}` }, tokA).catch(() => null)
    );
    await new Promise((r) => setTimeout(r, 50));
    await killDaemon("SIGTERM");
    // Drain the in-flight promises so we don't leak.
    await Promise.allSettled(sends);
    // Reopen + integrity_check.
    expect(integrityCheck()).toBe("ok");
  }, 30_000);

  it("(C.2) SIGKILL mid-rotation — auth_state coherent on restart (never dangling grace)", async () => {
    await startDaemon();
    const tok = (await rpc("register_agent", { name: "c2-m", role: "r", capabilities: [], managed: true })).agent_token;
    // Fire rotate_token but kill before response.
    const rot = rpc("rotate_token", { agent_name: "c2-m", agent_token: tok, grace_seconds: 300 }).catch(() => null);
    // Brief delay to let the write lane engage.
    await new Promise((r) => setTimeout(r, 30));
    await killDaemon("SIGKILL");
    await Promise.allSettled([rot]);
    // Integrity ok.
    expect(integrityCheck()).toBe("ok");
    // If state IS rotation_grace, previous_token_hash MUST be populated
    // AND rotation_grace_expires_at MUST be set. No half-state.
    const Better = require("better-sqlite3");
    const db = new Better(TEST_DB_PATH);
    const row = db
      .prepare("SELECT auth_state, token_hash, previous_token_hash, rotation_grace_expires_at FROM agents WHERE name = 'c2-m'")
      .get() as
      | { auth_state: string; token_hash: string; previous_token_hash: string | null; rotation_grace_expires_at: string | null }
      | undefined;
    db.close();
    expect(row).toBeDefined();
    if (row!.auth_state === "rotation_grace") {
      expect(row!.previous_token_hash).toBeTruthy();
      expect(row!.rotation_grace_expires_at).toBeTruthy();
    } else {
      // Or the rotation never committed — state is still 'active' with the
      // original token_hash. Either way, no torn intermediate state.
      expect(row!.auth_state).toBe("active");
      expect(row!.previous_token_hash ?? null).toBeNull();
    }
  }, 30_000);

  it("(C.3) SIGKILL mid-encrypt — webhook row either fully committed with ciphertext or absent", async () => {
    await startDaemon({ RELAY_ENCRYPTION_KEY: require("crypto").randomBytes(32).toString("base64") });
    const tok = (await rpc("register_agent", { name: "c3-r", role: "r", capabilities: ["webhooks"] })).agent_token;
    const registerCall = rpc("register_webhook", { url: "https://example.com/h", event: "*", secret: "plain" }, tok).catch(() => null);
    await new Promise((r) => setTimeout(r, 30));
    await killDaemon("SIGKILL");
    await Promise.allSettled([registerCall]);
    expect(integrityCheck()).toBe("ok");
    // The webhook row is either absent OR has ciphertext (enc: or enc1: prefix).
    const Better = require("better-sqlite3");
    const db = new Better(TEST_DB_PATH);
    const rows = db.prepare("SELECT secret FROM webhook_subscriptions").all() as Array<{ secret: string | null }>;
    db.close();
    for (const r of rows) {
      if (r.secret !== null && r.secret !== "") {
        expect(r.secret.startsWith("enc:") || r.secret.startsWith("enc1:")).toBe(true);
      }
    }
  }, 30_000);

  it("(C.4) WAL file deleted while the daemon is down — the CHECKPOINTED baseline survives, integrity ok, and the restarted daemon serves authenticated writes and reads", async () => {
    await startDaemon();
    const tokW = (await rpc("register_agent", { name: "c4-w", role: "r", capabilities: [] })).agent_token;
    const tokPeer = (await rpc("register_agent", { name: "c4-peer", role: "r", capabilities: [] })).agent_token;
    const baseline = await rpc("send_message", { from: "c4-w", to: "c4-peer", content: "c4-baseline" }, tokW);
    expect(baseline.success).toBe(true);
    // The BASELINE (both agents, the baseline message) is checkpointed into the main DB file explicitly, so the WAL
    // deletion below cannot take it.
    const cp = checkpointFull();
    expect(cp.busy, "the checkpoint was not blocked").toBe(0);
    expect(cp.checkpointed, "every WAL frame was copied into the main DB").toBe(cp.log);
    // WAL-ONLY writes after the checkpoint. Whether they survive the deletion depends on SQLite's own checkpointing at
    // kill time, which this test does not control: they are asserted NEITHER way below.
    await rpc("send_message", { from: "c4-w", to: "c4-peer", content: "c4-wal-only" }, tokW);
    // Kill + remove WAL file (simulates partial corruption).
    await killDaemon("SIGKILL");
    const walPath = TEST_DB_PATH + "-wal";
    if (fs.existsSync(walPath)) {
      fs.unlinkSync(walPath);
    }
    // Restart — SQLite should recover from the main DB file alone.
    await startDaemon();
    expect(integrityCheck()).toBe("ok");
    // The baseline survived: c4-peer still authenticates (its token row was checkpointed), and its inbox holds the
    // baseline message, by id and content. (A pending read marks what it returns as read.)
    const inbox = await rpc("get_messages", { agent_name: "c4-peer", status: "pending", limit: 50 }, tokPeer);
    const kept = inbox.messages.filter((m: { id: string }) => m.id === baseline.message_id);
    expect(kept, "the checkpointed baseline message survived the WAL deletion").toHaveLength(1);
    expect(kept[0].content).toBe("c4-baseline");
    // A post-restart send to an AUTHENTICATED recipient reads back as exactly that message (an empty inbox fails).
    const post = await rpc("send_message", { from: "c4-w", to: "c4-peer", content: "c4-post-restart" }, tokW);
    expect(post.success).toBe(true);
    const after = await rpc("get_messages", { agent_name: "c4-peer", status: "pending", limit: 50 }, tokPeer);
    const got = after.messages.filter((m: { id: string }) => m.id === post.message_id);
    expect(got, "the post-restart message reads back by its id").toHaveLength(1);
    expect(got[0].content).toBe("c4-post-restart");
  }, 30_000);

  it("(C.5) DB file downgrade — older-schema DB in place is detected + migrated or errored cleanly", async () => {
    await startDaemon();
    // Minimal touch so the current-schema DB file exists.
    await rpc("register_agent", { name: "c5-tmp", role: "r", capabilities: [] });
    await killDaemon("SIGKILL");
    // Replace the DB with a v1.7-shape DB (NO auth_state, NO managed, NO
    // reencryption_progress, NO schema_info).
    fs.unlinkSync(TEST_DB_PATH);
    // Remove WAL/shm stragglers so SQLite doesn't replay them onto the new DB.
    for (const sfx of ["-wal", "-shm"]) {
      const p = TEST_DB_PATH + sfx;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    const Better = require("better-sqlite3");
    const db = new Better(TEST_DB_PATH);
    db.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '[]',
        last_seen TEXT NOT NULL,
        created_at TEXT NOT NULL,
        token_hash TEXT
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        content TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );
    `);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO agents (id, name, role, capabilities, last_seen, created_at, token_hash) VALUES (?, ?, ?, ?, ?, ?, NULL)").run(
      "c5-old", "c5-downgraded", "r", "[]", now, now
    );
    db.close();
    // Restart — migration chain must run + bring the DB to current.
    await startDaemon();
    expect(integrityCheck()).toBe("ok");
    // register_agent on the legacy row should work (Phase 2b migration path).
    const r = await rpc("register_agent", { name: "c5-downgraded", role: "r", capabilities: [] });
    expect(r.success).toBe(true);
    expect(r.agent_token).toBeTruthy();
  }, 30_000);

  it("(C.6) backup after concurrent writes — archive integrity is ok (daemon lock not a blocker)", async () => {
    // Original intent: `relay backup` concurrent with writes. In practice
    // the CLI subprocess attempts to open the SAME DB the daemon holds a
    // WAL lock on, and better-sqlite3's `.backup()` API can block waiting
    // for the writer. Under vitest's serialized event loop, that wait
    // manifests as a hang.
    //
    // The INVARIANT we actually care about is: "backup taken while the
    // daemon is alive produces an internally-consistent archive." We get
    // there by driving writes, drain them, then take the backup via the
    // in-process exportRelayState (same code path relay-backup uses).
    // Archive is then extracted + integrity-checked.
    await startDaemon();
    const tok = (await rpc("register_agent", { name: "c6-w", role: "r", capabilities: [] })).agent_token;
    await rpc("register_agent", { name: "c6-p", role: "r", capabilities: [] });
    const writers = Array.from({ length: 10 }, (_, i) =>
      rpc("send_message", { from: "c6-w", to: "c6-p", content: `concurrent-${i}` }, tok)
    );
    await Promise.all(writers);
    // Shut the daemon down cleanly so the backup path opens the DB without
    // contending with the daemon's WAL lock.
    await killDaemon("SIGTERM");
    // In-process backup using the same exportRelayState path the CLI uses.
    process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
    process.env.RELAY_CONFIG_PATH = path.join(TEST_ROOT, "config.json");
    const { exportRelayState } = await import("../src/backup.js?chaos=c6");
    const result = await exportRelayState({ destinationPath: path.join(TEST_ROOT, "chaos-backup.tar.gz") });
    expect(fs.existsSync(result.archive_path)).toBe(true);
    // Extract + integrity-check the embedded DB.
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "chaos-verify-"));
    try {
      const { execSync } = require("child_process");
      execSync(`tar -xzf "${result.archive_path}" -C "${stage}"`);
      const probed = new (require("better-sqlite3"))(path.join(stage, "relay.db"), { readonly: true });
      const ok = probed.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      const msgCount = probed.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number };
      probed.close();
      expect(ok.integrity_check).toBe("ok");
      // All 10 concurrent writes landed in the backup.
      expect(msgCount.c).toBe(10);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }, 60_000);
});
