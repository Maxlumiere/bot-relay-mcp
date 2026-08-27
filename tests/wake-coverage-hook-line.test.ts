// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0026 item 1 — the SessionStart wiring. check-relay.sh must READ the durable
 * wake-coverage status sink and emit ONE `[RELAY] wake-coverage: ...` line to STDOUT
 * (which becomes the agent's session context). The line is produced by the SAME tested
 * SSOT the daemon-briefing uses — formatWakeCoverageStatusLine in the db-free
 * wake-coverage-status module — so the "poisoned/ancient file reads UNKNOWN, never a live
 * alert" rule holds at the hook layer too, without re-implementing it in bash.
 *
 * These tests RED on the UNWIRED hook (no wake-coverage line is emitted at all), which is
 * the failing-first proof: the wiring is what makes a fresh UNCOVERED finding reach a
 * freshly-starting agent, and what makes a missing/stale sink read as UNKNOWN rather than
 * silently "all clear". The line is asserted on STDOUT specifically — a briefing that only
 * reached stderr would not enter context and would fail this.
 *
 * The line lives on the hook's SUCCESS path (valid identity + DB present), AFTER the
 * invalid-name / out-of-bounds / missing-DB guards that `exit 0` early. So the setup here
 * provides a minimal real DB + an explicit RELAY_DB_PATH + an unreachable HTTP port,
 * mirroring tests/v2-6-2-hook-contracts.ts — exactly what carries the hook past those guards.
 * The contract that stdout stays verdict-only when DEGRADED is owned by that file; here we
 * assert the positive: on a healthy start, the briefing line IS present.
 *
 * NB: HOME is synthetic (mkdtemp), so the resolved default sink path lives under the temp
 * HOME — this test never touches the real ~/.bot-relay/wake-coverage-status.json. It also
 * pins RELAY_WAKE_COVERAGE_STATUS_PATH explicitly as the unambiguous env seam.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "check-relay.sh");

let home: string;
let dbPath: string;
let statusPath: string;

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/** Run the hook against a synthetic HOME; stdout and stderr captured SEPARATELY so a test
 *  can prove the briefing line lands in context (stdout), not merely on the user's stderr. */
function runHook(env: Record<string, string> = {}): RunResult {
  const r = spawnSync("bash", [HOOK], {
    env: {
      ...process.env,
      HOME: home,
      RELAY_AGENT_NAME: "probe",
      RELAY_DB_PATH: dbPath,
      RELAY_HTTP_PORT: "1", // privileged port → ECONNREFUSED instantly; no live-daemon dependency
      RELAY_WAKE_COVERAGE_STATUS_PATH: statusPath,
      ...env,
    },
    encoding: "utf8",
    timeout: 8000,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

/** Minimal schema the SessionStart hook queries between the DB-present guard and the end.
 *  Empty tables are fine — the point is that the queries don't error the hook off its
 *  success path before the wake-coverage briefing line. Mirrors v2-6-2-hook-contracts. */
function initMinimalDb(p: string): void {
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY, role TEXT, capabilities TEXT, last_seen TEXT,
      session_id TEXT, auth_state TEXT DEFAULT 'active', token_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, from_agent TEXT, to_agent TEXT, content TEXT,
      priority TEXT DEFAULT 'normal', status TEXT DEFAULT 'pending',
      created_at TEXT, resolved_at TEXT, read_by_session TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, from_agent TEXT, to_agent TEXT, title TEXT,
      status TEXT, priority TEXT, created_at TEXT
    );
  `);
  db.close();
}

function writeStatus(obj: unknown): void {
  fs.writeFileSync(statusPath, JSON.stringify(obj, null, 2));
}

const HOUR = 60 * 60 * 1000;
const isoAgo = (ms: number): string => new Date(Date.now() - ms).toISOString();

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hook-wc-"));
  fs.mkdirSync(path.join(home, ".bot-relay"), { recursive: true });
  dbPath = path.join(home, ".bot-relay", "relay.db");
  initMinimalDb(dbPath);
  statusPath = path.join(home, ".bot-relay", "wake-coverage-status.json");
});

afterEach(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("ADR-0026 item 1 — check-relay.sh emits the wake-coverage briefing line to stdout", () => {
  it("FRESH UNCOVERED: a just-written uncovered finding surfaces LOUD on stdout, naming the agent", () => {
    writeStatus({
      generatedAt: isoAgo(2 * 60 * 1000), // 2 min old = fresh
      thresholdMs: 48 * HOUR,
      uncoveredCount: 1,
      findings: [{ agent: "regressed", verdict: "uncovered" }],
    });
    const { stdout } = runHook();
    expect(stdout, "the wake-coverage line must be on STDOUT (session context), not stderr").toMatch(
      /\[RELAY\].*wake-coverage.*UNCOVERED/,
    );
    expect(stdout).toMatch(/regressed/);
  });

  it("MISSING sink: no status file → UNKNOWN on stdout (silence-as-failure, never 'all clear')", () => {
    // No writeStatus(): the sink is absent. A healthy-but-uncovered-by-detector agent must be told UNKNOWN.
    const { stdout } = runHook();
    expect(stdout).toMatch(/\[RELAY\].*wake-coverage:.*UNKNOWN/);
  });

  it("STALE sink: a 15-day-old finding reads UNKNOWN and does NOT name the agent as a live alert", () => {
    writeStatus({
      generatedAt: isoAgo(15 * 24 * HOUR), // 15 days old
      thresholdMs: 48 * HOUR,
      uncoveredCount: 1,
      findings: [{ agent: "stale-ghost", verdict: "uncovered" }],
    });
    const { stdout } = runHook();
    expect(stdout).toMatch(/\[RELAY\].*wake-coverage:.*UNKNOWN/);
    expect(stdout, "a stale finding must not be presented as a live UNCOVERED alert").not.toMatch(
      /stale-ghost/,
    );
  });

  it("HARDENING: a hijacked/failing node must NOT leak its stdout as a wake-coverage line", () => {
    // Same untrusted-partial-output class the mute self-check guards (and which the
    // tests/hook-mute-diagnostics.ts MED test caught on the first, unhardened cut of this block):
    // put a hostile `node` first on PATH that prints a canary and exits non-zero. The block runs
    // node; it MUST gate on node's exit and validate the [RELAY] shape, so the canary never
    // reaches session context. This is NOT vacuous — the block is reached on the success path
    // even when node fails (that reachability is exactly what made the original leak possible).
    writeStatus({
      generatedAt: isoAgo(2 * 60 * 1000),
      thresholdMs: 48 * HOUR,
      uncoveredCount: 0,
      findings: [],
    });
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fakenode-wc-"));
    const fakeNode = path.join(binDir, "node");
    fs.writeFileSync(fakeNode, '#!/bin/sh\nprintf "LEAK-CANARY-abc123/untrusted.js"\nexit 23\n');
    fs.chmodSync(fakeNode, 0o755);
    try {
      const { stdout } = runHook({ PATH: `${binDir}:${process.env.PATH ?? ""}` });
      expect(
        stdout,
        "a failing/hijacked node must not leak its partial stdout into session context",
      ).not.toMatch(/LEAK-CANARY-abc123/);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});
