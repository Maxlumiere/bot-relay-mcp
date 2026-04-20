// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 2c — backup/restore integration tests.
 *
 * Each test seeds its own DB under a fresh tmp dir, runs export or import,
 * and asserts on archive contents + DB state after the operation. No
 * dependency on the live ~/.bot-relay/relay.db.
 *
 * Coverage (8 tests):
 *   1. export happy path — archive exists, manifest matches, row counts correct.
 *   2. export includes config.json when present; omits it when absent.
 *   3. import happy path — round-trips agents + messages through a restore.
 *   4. import ALWAYS safety-backs-up current DB before touching it.
 *   5. import refuses archived schema_version > current (hard refuse).
 *   6. import refuses when /health daemon probe responds (unless force=true).
 *   7. import rejects a corrupted archive (missing manifest / empty DB) and
 *      leaves the current DB untouched.
 *   8. import atomic swap leaves no `.new` or orphan temp files on success.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import { spawnSync } from "child_process";

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-backup-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
const TEST_CONFIG_PATH = path.join(TEST_ROOT, "config.json");

process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
process.env.RELAY_CONFIG_PATH = TEST_CONFIG_PATH;
process.env.RELAY_HTTP_PORT = "0"; // set per-test when needed
delete process.env.RELAY_ALLOW_LEGACY;

function resetRoot() {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
}

beforeEach(async () => {
  resetRoot();
  // Fresh module state per test so initializeDb re-runs against the fresh path.
  const { closeDb } = await import("../src/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

async function seedDb(): Promise<void> {
  const { registerAgent, sendMessage, postTask } = await import("../src/db.js");
  registerAgent("alpha", "r", ["tasks"]);
  registerAgent("beta", "r", []);
  sendMessage("alpha", "beta", "ping", "normal");
  sendMessage("beta", "alpha", "pong", "normal");
  postTask("alpha", "beta", "t1", "do the thing", "normal");
}

describe("v2.1 Phase 2c — exportRelayState", () => {
  it("(1) happy path: archive exists, manifest matches, row counts correct", async () => {
    await seedDb();
    const { exportRelayState } = await import("../src/backup.js");
    const result = await exportRelayState();

    expect(fs.existsSync(result.archive_path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.row_counts.agents).toBe(2);
    expect(result.row_counts.messages).toBe(2);
    expect(result.row_counts.tasks).toBe(1);

    // Extract and verify manifest.json matches.
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
    try {
      spawnSync("tar", ["-xzf", result.archive_path, "-C", stage], { encoding: "utf-8" });
      const manifest = JSON.parse(fs.readFileSync(path.join(stage, "manifest.json"), "utf-8"));
      expect(manifest.schema_version).toBe(result.schema_version);
      expect(manifest.row_counts.agents).toBe(2);
      expect(manifest.archive_format_version).toBe(1);
      expect(fs.existsSync(path.join(stage, "relay.db"))).toBe(true);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });

  it("(2) includes config.json when present; omits it when absent", async () => {
    await seedDb();
    // No config yet → archive should NOT contain config.json.
    const { exportRelayState } = await import("../src/backup.js");
    const noConfig = await exportRelayState();
    const stage1 = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
    try {
      spawnSync("tar", ["-xzf", noConfig.archive_path, "-C", stage1], { encoding: "utf-8" });
      expect(fs.existsSync(path.join(stage1, "config.json"))).toBe(false);
    } finally {
      fs.rmSync(stage1, { recursive: true, force: true });
    }

    // Drop a config.json → archive should contain it.
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ hello: "world" }));
    const withConfig = await exportRelayState();
    const stage2 = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
    try {
      spawnSync("tar", ["-xzf", withConfig.archive_path, "-C", stage2], { encoding: "utf-8" });
      expect(fs.existsSync(path.join(stage2, "config.json"))).toBe(true);
      expect(fs.readFileSync(path.join(stage2, "config.json"), "utf-8")).toContain("hello");
    } finally {
      fs.rmSync(stage2, { recursive: true, force: true });
    }
  });
});

describe("v2.1 Phase 2c — importRelayState", () => {
  it("(3) round-trips agents + messages through a restore", async () => {
    await seedDb();
    const { exportRelayState, importRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState();

    // Wipe the current DB and seed with something unrelated so we can prove the import replaced it.
    const { closeDb, registerAgent, getAgents, getMessages } = await import("../src/db.js");
    closeDb();
    fs.rmSync(TEST_DB_PATH, { force: true });
    for (const suf of ["-wal", "-shm"]) {
      const p = TEST_DB_PATH + suf;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    // Restore from archive.
    const imp = await importRelayState(exp.archive_path);
    expect(imp.restored).toBe(true);

    // After restore: the seeded agents + messages should reappear.
    const agents = getAgents();
    expect(agents.map((a) => a.name).sort()).toEqual(["alpha", "beta"]);
    const msgs = getMessages("beta", "all", 50);
    expect(msgs.some((m) => m.content === "ping")).toBe(true);

    // In this test we deleted the DB before restoring, so there was no
    // prior DB to safety-back-up. Test (4) covers the safety-backup path
    // end-to-end — here we just assert the empty-string contract.
    expect(imp.previous_backup_path).toBe("");
  });

  it("(4) import ALWAYS safety-backs-up the current DB before touching it", async () => {
    await seedDb();
    const { exportRelayState, importRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState();

    // Prove the safety-backup is produced and contains the PRE-import state:
    // mutate the live DB AFTER export, then import.
    const { sendMessage } = await import("../src/db.js");
    sendMessage("alpha", "beta", "mutation-after-export", "normal");

    const imp = await importRelayState(exp.archive_path);

    expect(fs.existsSync(imp.previous_backup_path)).toBe(true);
    // Extract the safety-backup and check it has the mutation — proving it
    // captured the pre-import state, NOT the post-import (restored) state.
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
    try {
      spawnSync("tar", ["-xzf", imp.previous_backup_path, "-C", stage], { encoding: "utf-8" });
      const Database = (await import("better-sqlite3")).default;
      const probe = new Database(path.join(stage, "relay.db"), { readonly: true });
      const row = probe.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number };
      probe.close();
      // Pre-import DB had 2 + 1 mutation = 3 messages. Post-import (restored) has 2.
      expect(row.c).toBe(3);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });

  it("(5) refuses archived schema_version > current (hard refuse, no force bypass)", async () => {
    await seedDb();
    const { exportRelayState, importRelayState, SCHEMA_VERSION } = await import("../src/backup.js");
    const exp = await exportRelayState();

    // Patch the archive's manifest to claim a future schema_version.
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "patch-"));
    spawnSync("tar", ["-xzf", exp.archive_path, "-C", stage], { encoding: "utf-8" });
    const manifestPath = path.join(stage, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    manifest.schema_version = SCHEMA_VERSION + 1;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const tamperedArchive = path.join(TEST_ROOT, "tampered.tar.gz");
    spawnSync("tar", ["-czf", tamperedArchive, "manifest.json", "relay.db"], { cwd: stage, encoding: "utf-8" });
    fs.rmSync(stage, { recursive: true, force: true });

    // Even with force=true, future-schema must refuse.
    await expect(importRelayState(tamperedArchive, { force: true })).rejects.toThrow(/schema_version/i);
  });

  // v2.1 Phase 8 (CI-fix): 15s timeout because this test runs TWO full import
  // cycles back-to-back (first rejects via daemon-probe, second force-restores
  // including safety-backup → extract → integrity-check → atomic swap). Slow
  // CI disks push wall-clock over the 5s default.
  it("(6) refuses when /health probe responds; force=true bypasses", async () => {
    await seedDb();
    const { exportRelayState, importRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState();

    // Stand up a tiny HTTP server on a random port that answers /health=200.
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"status":"ok"}');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const prevPort = process.env.RELAY_HTTP_PORT;
    process.env.RELAY_HTTP_PORT = String(port);

    try {
      await expect(importRelayState(exp.archive_path)).rejects.toThrow(/daemon appears to be running/i);
      // force=true should bypass the daemon-running refusal.
      const forced = await importRelayState(exp.archive_path, { force: true });
      expect(forced.restored).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      if (prevPort === undefined) delete process.env.RELAY_HTTP_PORT;
      else process.env.RELAY_HTTP_PORT = prevPort;
    }
  }, 15000);

  it("(7) rejects corrupted archive (missing manifest) and leaves current DB untouched", async () => {
    await seedDb();
    const { exportRelayState, importRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState();

    // Build a bad archive with only relay.db (no manifest).
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "corrupt-"));
    spawnSync("tar", ["-xzf", exp.archive_path, "-C", stage], { encoding: "utf-8" });
    fs.unlinkSync(path.join(stage, "manifest.json"));
    const badArchive = path.join(TEST_ROOT, "bad.tar.gz");
    spawnSync("tar", ["-czf", badArchive, "relay.db"], { cwd: stage, encoding: "utf-8" });
    fs.rmSync(stage, { recursive: true, force: true });

    // Snapshot current DB row counts to prove data stays untouched. File
    // size isn't a reliable check in WAL mode — a VACUUM INTO invoked by
    // the pre-import safety-backup can checkpoint the WAL and grow the
    // main DB file without mutating any row.
    const Database = (await import("better-sqlite3")).default;
    const { closeDb } = await import("../src/db.js");
    const rowCountsBefore = (() => {
      const probe = new Database(TEST_DB_PATH, { readonly: true });
      const r = {
        agents: (probe.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }).c,
        messages: (probe.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c,
        tasks: (probe.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c,
      };
      probe.close();
      return r;
    })();

    await expect(importRelayState(badArchive)).rejects.toThrow(/manifest/i);

    // Data integrity: the rows seeded before the failed import are still there.
    closeDb();
    const rowCountsAfter = (() => {
      const probe = new Database(TEST_DB_PATH, { readonly: true });
      const r = {
        agents: (probe.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }).c,
        messages: (probe.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c,
        tasks: (probe.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c,
      };
      probe.close();
      return r;
    })();
    expect(rowCountsAfter).toEqual(rowCountsBefore);
  });

  it("(8) atomic swap leaves no .new or orphan temp files on success", async () => {
    await seedDb();
    const { exportRelayState, importRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState();

    await importRelayState(exp.archive_path);

    // No leftover staging artifacts in the DB dir.
    const files = fs.readdirSync(TEST_ROOT);
    expect(files.some((f) => f.endsWith(".new"))).toBe(false);
  });
});
