// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 2c — wasm-driver export coverage.
 *
 * Separate file from backup.test.ts because RELAY_SQLITE_DRIVER=wasm must be
 * set at module load time. Validates that the VACUUM INTO snapshot path —
 * which is plain SQL through CompatDatabase — works identically on sql.js.
 *
 * The snapshot file itself is still read via better-sqlite3 (native) inside
 * backup.ts: VACUUM INTO produces a standard SQLite file on disk, and
 * better-sqlite3 is always a hard dependency, so this read path is portable
 * regardless of the live driver.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-backup-wasm-" + process.pid);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
process.env.RELAY_SQLITE_DRIVER = "wasm";
delete process.env.RELAY_ALLOW_LEGACY;

const { registerAgent, sendMessage, closeDb } = await import("../src/db.js");
const { exportRelayState } = await import("../src/backup.js");

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("v2.1 Phase 2c — exportRelayState on wasm driver", () => {
  it("VACUUM INTO through CompatDatabase produces a valid snapshot archive on sql.js", async () => {
    registerAgent("wasm-a", "r", []);
    registerAgent("wasm-b", "r", []);
    sendMessage("wasm-a", "wasm-b", "hello from wasm", "normal");

    const result = await exportRelayState();
    expect(fs.existsSync(result.archive_path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.row_counts.agents).toBe(2);
    expect(result.row_counts.messages).toBe(1);

    // Extract and confirm the snapshot DB is a valid SQLite file with the
    // seeded data — proves VACUUM INTO ran correctly through wasm.
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "wasm-verify-"));
    try {
      spawnSync("tar", ["-xzf", result.archive_path, "-C", stage], { encoding: "utf-8" });
      expect(fs.existsSync(path.join(stage, "manifest.json"))).toBe(true);
      expect(fs.existsSync(path.join(stage, "relay.db"))).toBe(true);

      const Database = (await import("better-sqlite3")).default;
      const probe = new Database(path.join(stage, "relay.db"), { readonly: true });
      const agents = probe.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number };
      const msgs = probe.prepare("SELECT content FROM messages").all() as Array<{ content: string }>;
      probe.close();
      expect(agents.c).toBe(2);
      expect(msgs.some((m) => m.content === "hello from wasm")).toBe(true);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });
});
