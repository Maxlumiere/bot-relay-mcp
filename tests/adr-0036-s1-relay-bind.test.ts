// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 S1 — `relay bind`: the window→identity RECORD writer.
 *
 * S1 records and lists. It changes no auth and performs NO automatic rebind
 * (that is S3-lite, rows 1/4/11). This file pins two layers:
 *
 *   1. PURE RESOLVERS (src/binding.ts) — every branch, including the ones a
 *      spawned CLI cannot reach. A test process has no `claude` ancestor, so
 *      detectAgentProcess() returns null there; and the "detected anchor
 *      disagrees with CLAUDE_PID" refusal (§8a amendment d) is unreachable
 *      through the CLI by construction. Pure functions make both testable.
 *   2. THE SHIPPED VERB — `node bin/relay bind`, driven exactly as
 *      tests/cli-release-binding.test.ts drives its verb.
 *
 * RULING 1 (victra, 2026-09-16, on my msg 1e7d5141): bind opens a RAW handle
 * with busy_timeout only — NO applySchemaSetup — and PROBES for agent_bindings
 * first. Absent → BIND_FAILED "schema not migrated", written loudly, never
 * silent. A schema migration and a record purge must never ride a path that
 * fires dozens of times a day under a 10s hook timeout beside old code.
 *
 * Victra's instruction, followed here: the REFUSALS are pinned as hard as the
 * happy path. A bind that writes a guessed or NULL anchor is worse than no
 * bind at all, because the fleet list would then point at the wrong window.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");

const TEST_ROOT = path.join(os.tmpdir(), `bot-relay-s1-bind-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
const HOME_DIR = path.join(TEST_ROOT, "home");

process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

/**
 * The anchor these CLI runs will resolve to.
 *
 * In a real window Claude Code sets CLAUDE_PID to the same `claude` process the
 * ancestry walk finds, so the two AGREE. An earlier version of this harness set
 * CLAUDE_PID to the vitest worker while detection found the real claude, which
 * is a genuine disagreement — and the §8a-d refusal fired on it correctly. (That
 * refusal's first catch was this test file.) So mirror production: use whatever
 * detection finds, falling back to our own pid where there is no claude ancestor
 * (CI), which exercises the "CLAUDE_PID set, detection found nothing" branch.
 */
const DETECTED = (await import("../src/liveness.js")).detectAgentProcess();
const ANCHOR_PID = DETECTED?.pid ?? process.pid;
const DEAD_PID = 2_147_483_646;

const CONV = "11111111-1111-1111-1111-111111111111";
const CONV2 = "22222222-2222-2222-2222-222222222222";

/** A SessionStart payload as Claude Code 2.1.272 actually sends it (MEASURED, spikes E3/E4). */
function sessionStart(source: string, sessionId = CONV, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: sessionId,
    transcript_path: `${HOME_DIR}/.claude/projects/p/${sessionId}.jsonl`,
    cwd: path.join(TEST_ROOT, "stdin-cwd"),
    hook_event_name: "SessionStart",
    source,
    ...extra,
  });
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runBind(args: string[], stdin: string, env: Record<string, string | undefined> = {}): RunResult {
  const finalEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: HOME_DIR,
    RELAY_HOME: HOME_DIR,
    RELAY_DB_PATH: TEST_DB_PATH,
    CLAUDE_PID: String(ANCHOR_PID),
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete finalEnv[k];
    else finalEnv[k] = v;
  }
  const r = spawnSync("node", [RELAY_BIN, "bind", ...args], {
    encoding: "utf-8",
    timeout: 30_000,
    input: stdin,
    env: finalEnv,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Rows in agent_bindings, read with a plain handle (never the app's init path). */
async function bindings(): Promise<Array<Record<string, unknown>>> {
  const Better = (await import("better-sqlite3")).default;
  const db = new Better(TEST_DB_PATH, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT * FROM agent_bindings ORDER BY bound_at, binding_id").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

async function seedSchema(): Promise<void> {
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  const { getDb, closeDb } = await import("../src/db.js");
  getDb(); // full schema incl. v25 agent_bindings
  closeDb();
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, "stdin-cwd"), { recursive: true });
  const { closeDb } = await import("../src/db.js");
  closeDb();
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  await seedSchema();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. PURE RESOLVERS — the branches the CLI cannot reach
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-0036 S1 — resolveWindowAnchor (pure): never guesses, never picks a side", () => {
  it("CLAUDE_PID and the detected anchor AGREE → that anchor", async () => {
    const { resolveWindowAnchor } = await import("../src/binding.js");
    const r = resolveWindowAnchor({ claudePid: 4242, detected: { pid: 4242, startedAt: "Mon Sep 15 10:00:00 2026" } });
    expect(r.ok).toBe(true);
    expect(r.ok && r.anchor).toEqual({ pid: 4242, startedAt: "Mon Sep 15 10:00:00 2026" });
  });

  it("CLAUDE_PID and the detected anchor DISAGREE → BIND_FAILED, and it names both (§8a d)", async () => {
    const { resolveWindowAnchor } = await import("../src/binding.js");
    const r = resolveWindowAnchor({ claudePid: 4242, detected: { pid: 9999, startedAt: "Mon Sep 15 10:00:00 2026" } });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/4242/);
    expect(r.ok === false && r.reason).toMatch(/9999/);
  });

  it("CLAUDE_PID set, detection found nothing → use CLAUDE_PID (a failed detection is not a disagreement)", async () => {
    const { resolveWindowAnchor } = await import("../src/binding.js");
    const r = resolveWindowAnchor({ claudePid: 4242, detected: null, startedAtFor: () => "Mon Sep 15 10:00:00 2026" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.anchor.pid).toBe(4242);
  });

  it("no CLAUDE_PID, detection found an anchor → use it", async () => {
    const { resolveWindowAnchor } = await import("../src/binding.js");
    const r = resolveWindowAnchor({ claudePid: null, detected: { pid: 777, startedAt: "Mon Sep 15 10:00:00 2026" } });
    expect(r.ok).toBe(true);
    expect(r.ok && r.anchor.pid).toBe(777);
  });

  it("neither → BIND_FAILED, never a NULL or guessed anchor", async () => {
    const { resolveWindowAnchor } = await import("../src/binding.js");
    const r = resolveWindowAnchor({ claudePid: null, detected: null });
    expect(r.ok).toBe(false);
  });

  it("an anchor whose start time cannot be read → BIND_FAILED (a pid alone is not an anchor)", async () => {
    const { resolveWindowAnchor } = await import("../src/binding.js");
    const r = resolveWindowAnchor({ claudePid: 4242, detected: null, startedAtFor: () => null });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/start/i);
  });
});

/**
 * These two resolvers had NO direct tests until now. The spawned verb exercises
 * exactly one (source, isNamed) combination per run, so the mapping below was
 * unpinned in practice even though every bind depends on it. Both encode a
 * DECISION rather than plumbing: bound_via is the reason the fleet list will
 * give for a window holding its identity, and resolveAgentName is the single
 * place where "default" stops being a name (ADR-0036 S3-lite row 11).
 */
describe("ADR-0036 S1 — boundViaForSource (pure): the reason a binding exists", () => {
  it("clear carries the identity onto the new conversation id, named or not", async () => {
    const { boundViaForSource } = await import("../src/binding.js");
    expect(boundViaForSource("clear", true)).toBe("clear-carry");
    expect(boundViaForSource("clear", false)).toBe("clear-carry");
  });

  it("fork is its own reason — a fork must never inherit the parent's name", async () => {
    const { boundViaForSource } = await import("../src/binding.js");
    expect(boundViaForSource("fork", true)).toBe("fork");
    expect(boundViaForSource("fork", false)).toBe("fork");
  });

  it("every other source splits on whether the window carries a name", async () => {
    const { boundViaForSource } = await import("../src/binding.js");
    expect(boundViaForSource("startup", true)).toBe("launch-intent");
    expect(boundViaForSource("startup", false)).toBe("transient");
    expect(boundViaForSource("resume", true)).toBe("launch-intent");
    expect(boundViaForSource("compact", false)).toBe("transient");
  });

  it("an absent source is not a crash: it falls to the named/unnamed split", async () => {
    const { boundViaForSource } = await import("../src/binding.js");
    expect(boundViaForSource(null, true)).toBe("launch-intent");
    expect(boundViaForSource(undefined, false)).toBe("transient");
  });
});

describe("ADR-0036 S1 — resolveAgentName (pure): 'default' is not a name (row 11)", () => {
  it("accepts a valid name, trimming surrounding whitespace", async () => {
    const { resolveAgentName } = await import("../src/binding.js");
    expect(resolveAgentName("victra-build")).toBe("victra-build");
    expect(resolveAgentName("  victra-build  ")).toBe("victra-build");
    expect(resolveAgentName("a_b.c-1")).toBe("a_b.c-1");
  });

  it("'default' resolves to UNNAMED — the whole point of row 11", async () => {
    const { resolveAgentName } = await import("../src/binding.js");
    expect(resolveAgentName("default")).toBeNull();
  });

  it("unset, empty and whitespace-only are unnamed, not errors", async () => {
    const { resolveAgentName } = await import("../src/binding.js");
    expect(resolveAgentName(undefined)).toBeNull();
    expect(resolveAgentName(null)).toBeNull();
    expect(resolveAgentName("")).toBeNull();
    expect(resolveAgentName("   ")).toBeNull();
  });

  it("an INVALID name binds as unnamed rather than failing the whole bind", async () => {
    const { resolveAgentName } = await import("../src/binding.js");
    expect(resolveAgentName("has space")).toBeNull();
    expect(resolveAgentName("semi;colon")).toBeNull();
    expect(resolveAgentName("x".repeat(65))).toBeNull();
    expect(resolveAgentName("x".repeat(64))).toBe("x".repeat(64));
  });
});

describe("ADR-0036 S1 — resolveBindCwd (pure): one precedence, stated once (§8a e)", () => {
  it("CLAUDE_PROJECT_DIR wins over stdin cwd and process.cwd()", async () => {
    const { resolveBindCwd } = await import("../src/binding.js");
    expect(resolveBindCwd({ projectDir: "/a", stdinCwd: "/b", processCwd: "/c" })).toBe("/a");
  });
  it("stdin cwd wins over process.cwd() when CLAUDE_PROJECT_DIR is absent", async () => {
    const { resolveBindCwd } = await import("../src/binding.js");
    expect(resolveBindCwd({ projectDir: undefined, stdinCwd: "/b", processCwd: "/c" })).toBe("/b");
  });
  it("process.cwd() is the last resort", async () => {
    const { resolveBindCwd } = await import("../src/binding.js");
    expect(resolveBindCwd({ projectDir: undefined, stdinCwd: undefined, processCwd: "/c" })).toBe("/c");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE SHIPPED VERB — refusals first, pinned as hard as the happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-0036 S1 — relay bind REFUSES loudly and writes NOTHING", () => {
  it("empty stdin → BIND_FAILED, no row, non-zero exit", async () => {
    const r = runBind([], "");
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(r.stderr).toMatch(/BIND_FAILED/);
    expect(await bindings()).toEqual([]);
  });

  it("malformed stdin (not JSON) → BIND_FAILED, no row", async () => {
    const r = runBind([], '{"session_id": "trunc');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/BIND_FAILED/);
    expect(await bindings()).toEqual([]);
  });

  it("stdin without session_id → BIND_FAILED, never a guessed conversation id (§8a d)", async () => {
    const r = runBind([], JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: TEST_ROOT }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/BIND_FAILED/);
    expect(r.stderr).toMatch(/conversation|session_id/i);
    expect(await bindings()).toEqual([]);
  });

  /**
   * WHICH refusal this is depends on the machine, so name it honestly.
   *
   * A dead CLAUDE_PID beside a LIVE detected anchor is a DISAGREEMENT, not an
   * unreadable start time: resolveWindowAnchor compares the two pids BEFORE it
   * reads any start time (src/binding.ts:57-64). So wherever a real `claude`
   * ancestor exists — every dev machine — this exercises the §8a-d ambiguity
   * refusal, and the message must name BOTH pids: a refusal that names only one
   * is indistinguishable from silently picking one, which is the exact failure
   * the rule exists to prevent. Where there is no ancestor (CI), the same input
   * falls through to the start-time branch (src/binding.ts:74-83) instead.
   *
   * Both paths refuse and both write nothing — that is the invariant this test
   * owns through the spawned verb. Each branch is ALSO pinned independently and
   * machine-agnostically by the pure-resolver describe above: the disagreement
   * case directly, and the unreadable-start-time case with an injected
   * startedAtFor. So whichever branch this machine happens to take, the other
   * one is not left unpinned.
   */
  it("CLAUDE_PID disagreeing with the detected window → BIND_FAILED naming both pids, no row", async () => {
    const r = runBind([], sessionStart("startup"), { CLAUDE_PID: String(DEAD_PID) });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/BIND_FAILED/);
    if (DETECTED) {
      expect(r.stderr).toMatch(/ambiguous/i);
      expect(r.stderr).toContain(String(DEAD_PID));
      expect(r.stderr).toContain(String(DETECTED.pid));
    } else {
      expect(r.stderr).toMatch(/start time/i);
      expect(r.stderr).toContain(String(DEAD_PID));
    }
    expect(await bindings()).toEqual([]);
  });

  it("agent_bindings absent (v24-shaped DB) → BIND_FAILED naming the schema, never a silent skip (RULING 1)", async () => {
    const Better = (await import("better-sqlite3")).default;
    const db = new Better(TEST_DB_PATH);
    db.exec("DROP TABLE IF EXISTS agent_bindings");
    db.prepare("UPDATE schema_info SET version = ?, last_migrated_at = ? WHERE id = 1").run(24, new Date().toISOString());
    db.close();

    const r = runBind([], sessionStart("startup"), { RELAY_AGENT_NAME: "s1-bind-x" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/BIND_FAILED/);
    expect(r.stderr).toMatch(/schema not migrated/i);
  });

  it("bind does NOT migrate the DB it opens (RULING 1: no applySchemaSetup on this path)", async () => {
    const Better = (await import("better-sqlite3")).default;
    let db = new Better(TEST_DB_PATH);
    db.exec("DROP TABLE IF EXISTS agent_bindings");
    db.prepare("UPDATE schema_info SET version = ?, last_migrated_at = ? WHERE id = 1").run(24, new Date().toISOString());
    db.close();

    runBind([], sessionStart("startup"), { RELAY_AGENT_NAME: "s1-bind-x" });

    db = new Better(TEST_DB_PATH, { readonly: true });
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_bindings'").get();
    const version = (db.prepare("SELECT version FROM schema_info WHERE id = 1").get() as { version: number }).version;
    db.close();
    expect(table, "bind must not create the table").toBeUndefined();
    expect(version, "bind must not advance the schema version").toBe(24);
  });
});

describe("ADR-0036 S1 — relay bind RECORDS the window (happy paths)", () => {
  it("startup, named window → one current row with the anchor, conversation and launch-intent", async () => {
    const r = runBind([], sessionStart("startup"), { RELAY_AGENT_NAME: "s1-bind-named" });
    expect(r.status, r.stdout + r.stderr).toBe(0);

    const rows = await bindings();
    expect(rows).toHaveLength(1);
    const b = rows[0];
    expect(b.agent_name).toBe("s1-bind-named");
    expect(b.conversation_id).toBe(CONV);
    expect(b.window_pid).toBe(ANCHOR_PID);
    expect(String(b.window_pid_start ?? "").length).toBeGreaterThan(0);
    expect(String(b.host_id ?? "").length).toBeGreaterThan(0);
    expect(b.bound_via).toBe("launch-intent");
    expect(b.superseded_at).toBeNull();
    expect(b.end_reason).toBeNull();
  });

  it("startup, UNNAMED window → a row with agent_name NULL and bound_via transient (default stops existing)", async () => {
    const r = runBind([], sessionStart("startup"), { RELAY_AGENT_NAME: undefined });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const rows = await bindings();
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_name).toBeNull();
    expect(rows[0].bound_via).toBe("transient");
  });

  it("cwd precedence: CLAUDE_PROJECT_DIR wins over the stdin cwd (§8a e)", async () => {
    const projectDir = path.join(TEST_ROOT, "project-dir");
    fs.mkdirSync(projectDir, { recursive: true });
    const r = runBind([], sessionStart("startup"), { RELAY_AGENT_NAME: "s1-bind-cwd", CLAUDE_PROJECT_DIR: projectDir });
    expect(r.status).toBe(0);
    expect((await bindings())[0].cwd).toBe(projectDir);
  });

  it("running bind twice for the same window and conversation does NOT duplicate the row", async () => {
    runBind([], sessionStart("startup"), { RELAY_AGENT_NAME: "s1-bind-idem" });
    runBind([], sessionStart("startup"), { RELAY_AGENT_NAME: "s1-bind-idem" });
    const rows = await bindings();
    expect(rows.filter((b) => b.superseded_at == null)).toHaveLength(1);
  });

  it("compact → refreshes last_verified_at on the SAME row, never a second current row", async () => {
    runBind([], sessionStart("startup"), { RELAY_AGENT_NAME: "s1-bind-compact" });
    const before = (await bindings())[0];
    runBind([], sessionStart("compact"), { RELAY_AGENT_NAME: "s1-bind-compact" });
    const rows = await bindings();
    expect(rows.filter((b) => b.superseded_at == null)).toHaveLength(1);
    expect(rows[0].binding_id).toBe(before.binding_id);
    expect(String(rows[0].last_verified_at ?? "") >= String(before.last_verified_at ?? "")).toBe(true);
  });

  it("clear → supersedes the old conversation and carries the identity to the new one (D2)", async () => {
    runBind([], sessionStart("startup"), { RELAY_AGENT_NAME: "s1-bind-clear" });
    runBind([], sessionStart("clear", CONV2), { RELAY_AGENT_NAME: "s1-bind-clear" });

    const rows = await bindings();
    const current = rows.filter((b) => b.superseded_at == null);
    const superseded = rows.filter((b) => b.superseded_at != null);
    expect(current).toHaveLength(1);
    expect(superseded).toHaveLength(1);
    expect(current[0].conversation_id).toBe(CONV2);
    expect(current[0].agent_name).toBe("s1-bind-clear");
    expect(current[0].bound_via).toBe("clear-carry");
    // §8a D2: Claude Code's word goes in end_reason; the relay's own word in supersede_reason.
    expect(superseded[0].supersede_reason).toBe("clear-carry");
  });

  it("--end records SessionEnd's reason VERBATIM on the current row, and adds no row (D6)", async () => {
    runBind([], sessionStart("startup"), { RELAY_AGENT_NAME: "s1-bind-end" });
    const r = runBind(["--end"], JSON.stringify({ session_id: CONV, hook_event_name: "SessionEnd", reason: "prompt_input_exit" }), {
      RELAY_AGENT_NAME: "s1-bind-end",
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);

    const rows = await bindings();
    expect(rows).toHaveLength(1);
    expect(rows[0].end_reason).toBe("prompt_input_exit");
  });

  it("the bind ANNOUNCES itself: stdout names the identity, the conversation and the evidence (victra 04:04Z)", async () => {
    const r = runBind([], sessionStart("startup"), { RELAY_AGENT_NAME: "s1-bind-loud" });
    expect(r.status).toBe(0);
    const said = r.stdout + r.stderr;
    expect(said).toMatch(/s1-bind-loud/);
    expect(said).toMatch(new RegExp(CONV));
    expect(said).toMatch(/launch-intent|bound/i);
  });
});
