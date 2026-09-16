// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 S1 — the SessionStart hook RECORDS the binding, and SAYS SO.
 *
 * Victra's addition (2026-09-16 04:04Z): "a window that becomes X without saying
 * so is the same silence-as-health failure the whole arc exists to end." So the
 * hook must call `relay bind` with its payload and surface the result where a
 * human and an agent both read it.
 *
 * RED ON TODAY'S HOOK, and for a specific reason worth stating: check-relay.sh
 * contains NO reference to stdin anywhere (`HOOK_INPUT`, `/dev/stdin`, `STDIN`
 * all absent; every `session_id` hit is SQL against the agents table). It has
 * never read its payload. So every test below that needs the payload fails today.
 *
 * THE REGRESSION THIS FILE EXISTS TO PREVENT is the empty-stdin case. The hook
 * runs at SessionStart under a 10s timeout; an unguarded `cat` blocks until the
 * writer closes, and a hook that hangs costs the whole session start. Trading a
 * session-start hang for a cosmetic announce would be a far worse bug than the
 * silence it fixes, so "no payload completes promptly" is pinned as hard as the
 * happy path.
 *
 * NO DAEMON, ON PURPOSE (ADR-0036 §2.2): bind is DB-direct so that a daemon slow
 * to start after a reboot cannot cause a missed bind. The happy path below runs
 * against a port with nothing listening and still expects the row. A test that
 * booted a daemon first would pass while the guarantee was broken.
 *
 * FAILURE TAXONOMY, mirroring post-tool-use-check.sh's existing absent/invalid
 * split rather than inventing a second vocabulary:
 *   absent payload   → NOT a failure (manual run, non-SessionStart caller). Silent.
 *   malformed payload→ loud on stderr, verdict UNTOUCHED (this session is fine).
 *   schema not migrated → SYSTEMIC: no window anywhere gets recorded mid-rollout,
 *                         so it is written into the VERDICT (RULING 1: "loudly
 *                         into the verdict, never a silent skip").
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { getFreePort } from "./_helpers/port.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_HOOKS = path.join(REPO_ROOT, "hooks");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
const DIST_BIND = path.join(REPO_ROOT, "dist", "cli", "bind.js");

const TEST_ROOT = path.join(os.tmpdir(), `bot-relay-s1-announce-${process.pid}`);
const FAKE_REPO = path.join(TEST_ROOT, "bot-relay-mcp");
const HOOK_COPY_DIR = path.join(FAKE_REPO, "hooks");
const HOOK = path.join(HOOK_COPY_DIR, "check-relay.sh");
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");

process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

/** Mirror production: CLAUDE_PID and the ancestry walk AGREE in a real window. */
const DETECTED = (await import("../src/liveness.js")).detectAgentProcess();
const ANCHOR_PID = DETECTED?.pid ?? process.pid;

const CONV = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb";

function sessionStart(source: string, sessionId = CONV): string {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: `${TEST_ROOT}/.claude/projects/p/${sessionId}.jsonl`,
    cwd: TEST_ROOT,
    hook_event_name: "SessionStart",
    source,
  });
}

/** The single verdict token. Values may carry underscores (REGISTER_FAILED). */
function verdictOf(out: string): string | null {
  const m = out.match(/VERDICT=([A-Z_-]+)/);
  return m ? m[1] : null;
}

interface RunOpts {
  port: number;
  name?: string;
  input: string;
}

function runHook(o: RunOpts): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("bash", [HOOK], {
    encoding: "utf-8",
    timeout: 15_000,
    input: o.input,
    env: {
      HOME: TEST_ROOT,
      RELAY_HOME: TEST_ROOT,
      PATH: process.env.PATH || "/usr/bin:/bin",
      RELAY_DB_PATH: TEST_DB_PATH,
      RELAY_AGENT_NAME: o.name ?? "s1-announce",
      RELAY_AGENT_ROLE: "builder",
      RELAY_AGENT_CAPABILITIES: "",
      RELAY_AGENT_TOKEN: "",
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HTTP_PORT: String(o.port),
      CLAUDE_PID: String(ANCHOR_PID),
    },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

/** Rows in agent_bindings, read with a plain handle (never the app's init path). */
async function bindings(): Promise<Array<Record<string, unknown>>> {
  const Better = (await import("better-sqlite3")).default;
  const db = new Better(TEST_DB_PATH, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT * FROM agent_bindings ORDER BY bound_at, binding_id").all() as Array<
      Record<string, unknown>
    >;
  } finally {
    db.close();
  }
}

/** Shrink the DB to its v24 shape: the mid-rollout state RULING 1 is about. */
async function downgradeToV24(): Promise<void> {
  const Better = (await import("better-sqlite3")).default;
  const db = new Better(TEST_DB_PATH);
  db.exec("DROP TABLE IF EXISTS agent_bindings");
  db.prepare("UPDATE schema_info SET version = ?, last_migrated_at = ? WHERE id = 1").run(24, new Date().toISOString());
  db.close();
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true, mode: 0o700 });
  fs.cpSync(REAL_HOOKS, HOOK_COPY_DIR, { recursive: true });
  // The hook resolves the CLI as $HOOKS_DIR/../bin/relay. Without these the copied
  // tree has no sibling bin/dist and the hook would fall back to a `relay` on PATH
  // that does not exist — failing for a reason this file is not testing.
  fs.symlinkSync(path.join(REPO_ROOT, "bin"), path.join(FAKE_REPO, "bin"), "dir");
  fs.symlinkSync(path.join(REPO_ROOT, "dist"), path.join(FAKE_REPO, "dist"), "dir");
  // A valid config keeps the hook on its success path; a dead one can exit before
  // the bind block and the test would then pass or fail for the wrong reason.
  fs.writeFileSync(
    path.join(TEST_ROOT, ".claude.json"),
    JSON.stringify({ mcpServers: { "bot-relay": { type: "stdio", command: "node", args: [DIST_INDEX] } } }),
  );
  const { closeDb } = await import("../src/db.js");
  closeDb();
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  const { getDb } = await import("../src/db.js");
  getDb(); // full schema incl. v25 agent_bindings
  closeDb();
  expect(fs.existsSync(DIST_INDEX), "dist/index.js missing — run npm run build first").toBe(true);
  expect(fs.existsSync(DIST_BIND), "dist/cli/bind.js missing — run npm run build first").toBe(true);
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("ADR-0036 S1 — the SessionStart hook records the binding and announces it", () => {
  it("records a row and announces it WITHOUT a daemon (§2.2: DB-direct, never via the daemon)", async () => {
    const port = await getFreePort(); // free = nothing listening, on purpose

    const r = runHook({ port, input: sessionStart("startup") });

    const rows = await bindings();
    expect(rows.length, r.stdout + r.stderr).toBe(1);
    expect(rows[0].conversation_id).toBe(CONV);
    expect(rows[0].agent_name).toBe("s1-announce");
    expect(rows[0].window_pid).toBe(ANCHOR_PID);

    // The announcement names the identity AND the conversation — victra's
    // requirement is that it say what it bound and on what evidence.
    expect(r.stdout).toMatch(/\[RELAY\] bound /);
    expect(r.stdout).toContain(CONV);
    expect(r.stdout).toContain("s1-announce");
    // The hook's output contract is not weakened by adding this line.
    expect((r.stdout.match(/VERDICT=/g) ?? []).length, "exactly one verdict").toBe(1);
  }, 25_000);

  it("carries the SessionStart source into bound_via (clear carries the identity)", async () => {
    const port = await getFreePort();

    const r = runHook({ port, input: sessionStart("clear") });

    const rows = await bindings();
    expect(rows.length, r.stdout + r.stderr).toBe(1);
    expect(rows[0].bound_via).toBe("clear-carry");
  }, 25_000);

  /**
   * AN OPEN STDIN NOBODY CLOSES — the case that actually bit.
   *
   * The empty-stdin test below is NOT sufficient and this comment exists so no
   * one mistakes it for coverage: spawnSync's `input:` always CLOSES the write
   * end, so a read that blocks until EOF still passes it. The real hazard is a
   * parent that hands the child a pipe and never writes to it — which is exactly
   * what `spawn(cmd, {})` does by default, with no stdio option. CANARY 6 in
   * tests/regression-plug-and-play.test.ts spawns this hook that way, and a
   * size-bounded-but-not-TIME-bounded read hangs there until the test times out.
   * A hook that hangs costs the whole session start, so this is pinned as a
   * first-class case rather than trusted to the empty-stdin twin.
   */
  it("an OPEN stdin that never closes still completes promptly (CANARY 6's shape)", async () => {
    const port = await getFreePort();
    const { spawn } = await import("child_process");

    const started = Date.now();
    const child = spawn("bash", [HOOK], {
      // No `stdio` and no input: fd 0 is a pipe the parent never closes.
      env: {
        HOME: TEST_ROOT,
        RELAY_HOME: TEST_ROOT,
        PATH: process.env.PATH || "/usr/bin:/bin",
        RELAY_DB_PATH: TEST_DB_PATH,
        RELAY_AGENT_NAME: "s1-openstdin",
        RELAY_AGENT_ROLE: "builder",
        RELAY_AGENT_CAPABILITIES: "",
        RELAY_AGENT_TOKEN: "",
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HTTP_PORT: String(port),
        CLAUDE_PID: String(ANCHOR_PID),
      },
    });
    const exitCode: number = await new Promise((resolve) => {
      child.on("close", (code) => resolve(code ?? -1));
    });
    const elapsed = Date.now() - started;

    expect(exitCode, "the hook must exit, not hang, on an unclosed stdin").toBe(0);
    // Generous, but far below the 10s hook timeout the real cost is measured against.
    expect(elapsed, `took ${elapsed}ms — the bounded read did not fire`).toBeLessThan(8000);
  }, 25_000);

  it("NO PAYLOAD completes promptly and stays silent — absent is not a failure", async () => {
    const port = await getFreePort();

    const r = runHook({ port, input: "" });

    // The regression guard: a hook that hangs on an unguarded read costs the whole
    // session start. spawnSync's timeout would surface as a non-zero/-1 status.
    expect(r.status, "the hook must not hang or die on empty stdin").toBe(0);
    expect(r.stdout).not.toMatch(/\[RELAY\] bound /);
    expect(r.stdout + r.stderr).not.toMatch(/BIND_FAILED/);
    expect((r.stdout.match(/VERDICT=/g) ?? []).length, "exactly one verdict").toBe(1);
    expect(await bindings()).toEqual([]);
  }, 25_000);

  it("a MALFORMED payload is loud on stderr but never touches the verdict", async () => {
    const port = await getFreePort();

    const r = runHook({ port, input: "{not json at all" });

    expect(r.stderr).toMatch(/BIND_FAILED/);
    expect(r.stdout).not.toMatch(/\[RELAY\] bound /);
    expect(await bindings()).toEqual([]);
    // This session is otherwise fine; a bad payload is not a session-health event.
    expect(verdictOf(r.stdout)).not.toBe("BIND_FAILED");
    expect((r.stdout.match(/VERDICT=/g) ?? []).length, "exactly one verdict").toBe(1);
  }, 25_000);

  it("a payload with NO session_id writes nothing — refuse rather than guess (§8a d)", async () => {
    const port = await getFreePort();

    const r = runHook({ port, input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }) });

    expect(await bindings()).toEqual([]);
    expect(r.stdout).not.toMatch(/\[RELAY\] bound /);
    expect(r.stderr).toMatch(/BIND_FAILED/);
  }, 25_000);

  it("agent_bindings ABSENT (mid-rollout v24 DB) is SYSTEMIC → written into the verdict (RULING 1)", async () => {
    const port = await getFreePort();
    await downgradeToV24();

    const r = runHook({ port, input: sessionStart("startup") });

    // Loud, and never a silent skip: no window anywhere is being recorded.
    expect(r.stdout + r.stderr).toMatch(/schema not migrated/i);
    // DEGRADED alone is a WEAK bar here: this harness runs with no daemon, so the
    // hook already emits DEGRADED reason="daemon unreachable" on its own. Asserting
    // the token would pass for the wrong reason and keep passing if the bind block
    // were deleted. Pin the REASON, which only the bind path can produce.
    expect(verdictOf(r.stdout), r.stdout + r.stderr).toBe("DEGRADED");
    expect(r.stdout, "the verdict must name the bind failure, not just degrade").toMatch(
      /VERDICT=DEGRADED reason="[^"]*bind[^"]*"/i,
    );
    expect((r.stdout.match(/VERDICT=/g) ?? []).length, "exactly one verdict").toBe(1);
  }, 25_000);
});
