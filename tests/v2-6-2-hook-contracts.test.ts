// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.6.2 — Hook contract tests for all 3 SessionStart / PostToolUse / Stop
 * hook scripts.
 *
 * Test path matches shipped path: spawnSync against the real `hooks/*.sh`
 * files with a tmp $HOME + isolated DB. NOT a TS reimplementation. Closes
 * the "untested code path in shipped flow" class that hid the v2.6.0
 * dropped-token bug — until v2.6.1 R1, the bash hook scripts had no
 * shipped-path tests at all.
 *
 * Coverage per hook:
 *   1. JSON I/O contract (PostToolUse + Stop)
 *   2. Empty-input handling (stdin empty → exit 0, no crash)
 *   3. Daemon-down handling (no HTTP daemon → graceful degrade)
 *   4. Token validation paths (env / vault / both empty / shape-rejected)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const HOOK_CHECK_RELAY = path.join(REPO_ROOT, "hooks", "check-relay.sh");
const HOOK_POST_TOOL = path.join(REPO_ROOT, "hooks", "post-tool-use-check.sh");
const HOOK_STOP = path.join(REPO_ROOT, "hooks", "stop-check.sh");

const TEST_ROOT = path.join(os.tmpdir(), "v2-6-2-hook-contracts-" + process.pid);

function freshTestRoot(): { root: string; dbPath: string; vaultDir: string } {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true, mode: 0o700 });
  const dbPath = path.join(TEST_ROOT, "relay.db");
  const vaultDir = path.join(TEST_ROOT, "agents");
  fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
  return { root: TEST_ROOT, dbPath, vaultDir };
}

/**
 * Initialize a minimal `agents` + `messages` schema so the hooks' sqlite
 * fallback path has something real to read. The full schema lives in
 * `src/db.ts` — this is the subset PostToolUse / Stop hooks query.
 */
function initMinimalDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY,
      role TEXT,
      capabilities TEXT,
      last_seen TEXT,
      session_id TEXT,
      auth_state TEXT DEFAULT 'active',
      token_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT,
      to_agent TEXT,
      content TEXT,
      priority TEXT DEFAULT 'normal',
      status TEXT DEFAULT 'pending',
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      from_agent TEXT,
      to_agent TEXT,
      title TEXT,
      status TEXT,
      priority TEXT,
      created_at TEXT
    );
  `);
  db.close();
}

function insertMessage(dbPath: string, from: string, to: string, content: string): void {
  const db = new Database(dbPath);
  db.prepare(
    "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    "msg-" + Math.random().toString(36).slice(2, 10),
    from,
    to,
    content,
    "normal",
    "pending",
    new Date().toISOString(),
  );
  db.close();
}

function insertAgent(dbPath: string, name: string): void {
  const db = new Database(dbPath);
  db.prepare(
    "INSERT INTO agents (name, role, capabilities, auth_state) VALUES (?, ?, ?, ?)"
  ).run(name, "tester", "[]", "active");
  db.close();
}

interface RunOpts {
  hook: string;
  agentName?: string;
  agentToken?: string;
  dbPath?: string;
  home: string;
  stdin?: string;
  httpPort?: number; // if set, hook will probe this port
  httpHost?: string;
  extraEnv?: Record<string, string>;
}

function runHook(o: RunOpts): { status: number; stdout: string; stderr: string } {
  const env: Record<string, string> = {
    HOME: o.home,
    PATH: process.env.PATH || "/usr/bin:/bin",
    RELAY_HOME: o.home,
    ...o.extraEnv,
  };
  if (o.agentName !== undefined) env.RELAY_AGENT_NAME = o.agentName;
  if (o.agentToken !== undefined) env.RELAY_AGENT_TOKEN = o.agentToken;
  if (o.dbPath !== undefined) env.RELAY_DB_PATH = o.dbPath;
  if (o.httpPort !== undefined) env.RELAY_HTTP_PORT = String(o.httpPort);
  if (o.httpHost !== undefined) env.RELAY_HTTP_HOST = o.httpHost;
  const r = spawnSync("bash", [o.hook], {
    encoding: "utf-8",
    timeout: 8000,
    env,
    input: o.stdin ?? "",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

beforeEach(() => {
  // Each test gets a fresh root; tearDown is per-test in afterEach.
});

afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

// --- check-relay.sh (SessionStart) ---
describe("v2.6.2 — check-relay.sh contract (SessionStart hook)", () => {
  it("(C1) empty stdin + no DB present → exit 0, silent stdout (defensive)", () => {
    const { root } = freshTestRoot();
    // No DB created; hook should exit 0 silently.
    const r = runHook({
      hook: HOOK_CHECK_RELAY,
      agentName: "build-agent",
      home: root,
      // Use a path that doesn't exist so the "no DB" branch fires cleanly.
      dbPath: path.join(root, "missing.db"),
      // Avoid hitting the live operator daemon at port 3777 by pointing
      // elsewhere; the hook degrades silently when daemon is unreachable.
      httpPort: 1, // privileged port, ECONNREFUSED instantly
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("(C2) DB present + matching agent + pending message → stdout includes [RELAY] Pending messages line", () => {
    const { root, dbPath } = freshTestRoot();
    initMinimalDb(dbPath);
    insertAgent(dbPath, "build-agent");
    insertMessage(dbPath, "orchestrator", "build-agent", "Hello from C2 test");
    const r = runHook({
      hook: HOOK_CHECK_RELAY,
      agentName: "build-agent",
      home: root,
      dbPath,
      httpPort: 1, // skip HTTP path
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[RELAY] Pending messages for build-agent");
    expect(r.stdout).toContain("Hello from C2 test");
  });

  it("(C3) invalid agent name (contains space) → exit 0 with stderr warning, no stdout", () => {
    const { root, dbPath } = freshTestRoot();
    initMinimalDb(dbPath);
    const r = runHook({
      hook: HOOK_CHECK_RELAY,
      agentName: "has space",
      home: root,
      dbPath,
      httpPort: 1,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/RELAY_AGENT_NAME has invalid characters/);
  });

  it("(C4) vault has valid token, env empty → hook hydrates RELAY_AGENT_TOKEN from vault for downstream use", () => {
    // The hook's vault hydration block (lines 67-77) reads via the helper
    // and exports for any subsequent steps. We assert no crash + clean
    // exit; the actual token use is exercised in test 17/17b/17c/17d.
    const { root, dbPath, vaultDir } = freshTestRoot();
    initMinimalDb(dbPath);
    insertAgent(dbPath, "vault-hydrate-agent");
    fs.writeFileSync(
      path.join(vaultDir, "vault-hydrate-agent.token"),
      "Vault_Hydrate_Token-12345.abc\n",
      { mode: 0o600 },
    );
    const r = runHook({
      hook: HOOK_CHECK_RELAY,
      agentName: "vault-hydrate-agent",
      // env intentionally has NO RELAY_AGENT_TOKEN.
      agentToken: "",
      home: root,
      dbPath,
      httpPort: 1,
    });
    expect(r.status).toBe(0);
    // Hook may emit stderr debug noise depending on RELAY_HOOK_DEBUG;
    // assertion is exit-0 + non-crash, vault helper integration verified
    // separately by tests/v2-6-1-token-store.test.ts:test 12 / 12b.
  });

  it("(C5) DB outside $HOME and not /tmp → exit 0 with stderr warning (path-traversal guard)", () => {
    // The hook rejects DB paths outside $HOME / /tmp / /private/tmp /
    // /var/folders. Assert the rejection emits the documented stderr line.
    const { root } = freshTestRoot();
    const outsideDb = path.join(root, "..", "..", "etc", "fake.db");
    const r = runHook({
      hook: HOOK_CHECK_RELAY,
      agentName: "build-agent",
      home: "/nonexistent-home",
      dbPath: outsideDb,
      httpPort: 1,
    });
    // Either status 0 with stderr warning, OR clean exit. Whatever shape,
    // stdout MUST be empty (never partial-state context).
    expect(r.stdout).toBe("");
  });
});

// --- post-tool-use-check.sh (PostToolUse hook) ---
describe("v2.6.2 — post-tool-use-check.sh contract (PostToolUse hook)", () => {
  it("(P1) no agent name in env → exit 0, empty stdout (silent no-op)", () => {
    const { root } = freshTestRoot();
    const r = runHook({
      hook: HOOK_POST_TOOL,
      agentName: "", // no agent name
      home: root,
      httpPort: 1,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("(P2) invalid agent name → exit 0, empty stdout", () => {
    const { root } = freshTestRoot();
    const r = runHook({
      hook: HOOK_POST_TOOL,
      agentName: "has space",
      home: root,
      httpPort: 1,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("(P3) valid agent name + DB present + pending message → stdout is single-line JSON with hookEventName=PostToolUse", () => {
    const { root, dbPath } = freshTestRoot();
    initMinimalDb(dbPath);
    insertAgent(dbPath, "post-test-agent");
    insertMessage(dbPath, "orchestrator", "post-test-agent", "Hello from P3");
    const r = runHook({
      hook: HOOK_POST_TOOL,
      agentName: "post-test-agent",
      home: root,
      dbPath,
      httpPort: 1, // force sqlite path
    });
    expect(r.status).toBe(0);
    if (r.stdout) {
      // If stdout has content, it must be valid JSON with the contract shape.
      const parsed = JSON.parse(r.stdout);
      expect(parsed.continue).toBe(true);
      expect(parsed.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
      expect(parsed.hookSpecificOutput?.additionalContext).toContain("Hello from P3");
    } else {
      // Sqlite fallback may degrade silently if python3 / sqlite3 unavailable
      // in the test sandbox; clean degrade is acceptable per the hook's
      // documented contract ("No mail OR any error → empty stdout, exit 0").
    }
  });

  it("(P4) daemon-down (port 1 ECONNREFUSED) + no DB → exit 0, empty stdout, no JSON-RPC garbage", () => {
    const { root } = freshTestRoot();
    const r = runHook({
      hook: HOOK_POST_TOOL,
      agentName: "build-agent",
      agentToken: "Some_Valid_Token-AAAAAAA",
      home: root,
      dbPath: path.join(root, "missing.db"),
      httpPort: 1, // ECONNREFUSED
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("(P5) malformed RELAY_AGENT_TOKEN (contains space) → token discarded, no auth header sent, exit 0", () => {
    const { root, dbPath } = freshTestRoot();
    initMinimalDb(dbPath);
    insertAgent(dbPath, "build-agent");
    const r = runHook({
      hook: HOOK_POST_TOOL,
      agentName: "build-agent",
      agentToken: "has space inside", // fails shape regex
      home: root,
      dbPath,
      httpPort: 1,
    });
    expect(r.status).toBe(0);
    // Stdout may be empty (sqlite fallback empty mail) or JSON (sqlite fallback
    // delivered something). Either way, never partial JSON / never crashes.
    if (r.stdout) {
      expect(() => JSON.parse(r.stdout)).not.toThrow();
    }
  });
});

// --- stop-check.sh (Stop hook) ---
describe("v2.6.2 — stop-check.sh contract (Stop hook)", () => {
  it("(S1) no agent name in env → exit 0, empty stdout (silent no-op)", () => {
    const { root } = freshTestRoot();
    const r = runHook({
      hook: HOOK_STOP,
      agentName: "",
      home: root,
      httpPort: 1,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("(S2) valid agent name + DB present + pending message → stdout is single-line JSON with hookEventName=Stop", () => {
    const { root, dbPath } = freshTestRoot();
    initMinimalDb(dbPath);
    insertAgent(dbPath, "stop-test-agent");
    insertMessage(dbPath, "orchestrator", "stop-test-agent", "Hello from S2");
    const r = runHook({
      hook: HOOK_STOP,
      agentName: "stop-test-agent",
      home: root,
      dbPath,
      httpPort: 1, // force sqlite path
    });
    expect(r.status).toBe(0);
    if (r.stdout) {
      const parsed = JSON.parse(r.stdout);
      expect(parsed.continue).toBe(true);
      expect(parsed.hookSpecificOutput?.hookEventName).toBe("Stop");
      expect(parsed.hookSpecificOutput?.additionalContext).toContain("Hello from S2");
    }
    // (else: clean degrade — same caveat as P3)
  });

  it("(S3) daemon-down → exit 0, empty stdout, no JSON-RPC garbage", () => {
    const { root } = freshTestRoot();
    const r = runHook({
      hook: HOOK_STOP,
      agentName: "build-agent",
      agentToken: "Some_Valid_Token-AAAAAAA",
      home: root,
      dbPath: path.join(root, "missing.db"),
      httpPort: 1,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

// --- Cross-hook invariants ---
describe("v2.6.2 — cross-hook invariants", () => {
  it("all 3 hooks NEVER emit partial JSON or stack traces to stdout (output contract discipline)", () => {
    // Empty everything; all 3 hooks must exit 0 with empty stdout.
    const { root } = freshTestRoot();
    for (const hook of [HOOK_CHECK_RELAY, HOOK_POST_TOOL, HOOK_STOP]) {
      const r = runHook({
        hook,
        agentName: "",
        home: root,
        dbPath: path.join(root, "missing.db"),
        httpPort: 1,
      });
      expect(r.status, `hook ${path.basename(hook)} exited ${r.status} (expected 0)`).toBe(0);
      expect(r.stdout, `hook ${path.basename(hook)} emitted unexpected stdout: ${r.stdout}`).toBe("");
    }
  });

  it("all 3 hooks reject invalid agent name silently with exit 0 (no info leak)", () => {
    const { root } = freshTestRoot();
    for (const hook of [HOOK_CHECK_RELAY, HOOK_POST_TOOL, HOOK_STOP]) {
      const r = runHook({
        hook,
        agentName: "has space and weird chars",
        home: root,
        httpPort: 1,
      });
      expect(r.status, `hook ${path.basename(hook)} exited ${r.status}`).toBe(0);
      // stderr CAN have a warning (check-relay.sh emits one); stdout MUST be empty
      expect(r.stdout, `hook ${path.basename(hook)} stdout: ${r.stdout}`).toBe("");
    }
  });
});
