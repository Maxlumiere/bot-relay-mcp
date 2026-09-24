// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 S3-lite — `relay bind` WIRES the continuity claim (rows 1 and 4).
 *
 * Row 1: restart or crash → `ai` → `/resume C`. The hook fires (resume, C). C is
 * bound to X and X's window anchor is dead → rebind X to THIS window under CAS.
 * Zero steps. The decision is resolveContinuityClaim (pure, gated on
 * anchorLivenessVerdict ONLY) and the write is rebindAgentToWindow (one handle,
 * one transaction).
 *
 * Pinned here at the SHIPPED VERB, as hard on the refusals as on the claim:
 *   - an ALIVE or UNVERIFIABLE holder is never taken; the window is still recorded
 *     (as itself) and the announcement says who holds X and why it was not taken;
 *   - a NAMED window (launch intent) never inherits: S3-lite is rows 1/4, and row 3
 *     (launcher X resuming Y's conversation) is S3;
 *   - only `resume` opens a continuity lookup;
 *   - row 1 as it REALLY happens: `ai` binds the window unnamed at startup first;
 *   - IDENTITY CARRIES (row 8): after a claim, `/clear` binds the new conversation
 *     to X (clear-carry) and `/compact` keeps X, although the window's env still has
 *     no name. The window's identity is its binding, not its env.
 *
 * Harness copied from tests/adr-0036-s1-relay-bind.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");

const TEST_ROOT = path.join(os.tmpdir(), `bot-relay-s3lite-cont-${process.pid}`);
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

const PRIOR = "prior-x";
const C = "c0c0c0c0-1111-2222-3333-444444444444";
const C2 = "c2c2c2c2-1111-2222-3333-444444444444";
const N = "0e0e0e0e-1111-2222-3333-444444444444";

async function raw<T>(fn: (db: import("better-sqlite3").Database) => T): Promise<T> {
  const Better = (await import("better-sqlite3")).default;
  const db = new Better(TEST_DB_PATH);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** X registered, and its current binding on conversation C held by the given anchor. */
async function seedHolder(anchor: { hostId: string; pid: number; startedAt: string }): Promise<void> {
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  const { registerAgent, closeDb, upsertAgentBinding } = await import("../src/db.js");
  registerAgent(PRIOR, "builder", []);
  closeDb();
  await raw((db) => {
    db.prepare("UPDATE agents SET agent_pid = ?, agent_pid_start = ?, host_id = ? WHERE name = ?").run(
      anchor.pid,
      anchor.startedAt,
      anchor.hostId,
      PRIOR,
    );
    upsertAgentBinding(db as never, {
      hostId: anchor.hostId,
      windowPid: anchor.pid,
      windowPidStart: anchor.startedAt,
      agentName: PRIOR,
      agentClass: null,
      conversationId: C,
      conversationTitle: null,
      cwd: "/tmp/prior",
      boundVia: "launch-intent",
    });
  });
}

async function agentRow(): Promise<{ agent_pid: number | null; session_id: string | null }> {
  return raw((db) => db.prepare("SELECT agent_pid, session_id FROM agents WHERE name = ?").get(PRIOR) as never);
}

async function thisWindowBinding(): Promise<Record<string, unknown> | undefined> {
  const { detectAgentProcess, processStartedAt, getOwnHostId } = await import("../src/liveness.js");
  const pid = detectAgentProcess()?.pid ?? process.pid;
  const start = detectAgentProcess()?.startedAt ?? processStartedAt(pid);
  return raw(
    (db) =>
      db
        .prepare(
          "SELECT * FROM agent_bindings WHERE host_id = ? AND window_pid = ? AND window_pid_start = ? AND superseded_at IS NULL",
        )
        .get(getOwnHostId(), pid, start) as Record<string, unknown> | undefined,
  );
}

const UNNAMED = { RELAY_AGENT_NAME: undefined };

describe("S3-lite — relay bind claims a dead holder's identity on /resume (rows 1 and 4)", () => {
  it("PRECONDITION: this fixture's window anchor resolves (else every case refuses early, vacuously)", async () => {
    const { resolveWindowAnchor } = await import("../src/binding.js");
    const { getOwnHostId } = await import("../src/liveness.js");
    expect(resolveWindowAnchor({ claudePid: ANCHOR_PID, detected: DETECTED }).ok).toBe(true);
    expect(getOwnHostId()).toBeTruthy();
  });

  it("CLAIM: an unnamed window resuming C, whose holder is DEAD, becomes X — announced, anchor + session moved", async () => {
    const { getOwnHostId } = await import("../src/liveness.js");
    await seedHolder({ hostId: getOwnHostId()!, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026" });
    const before = await agentRow();

    const r = runBind([], sessionStart("resume", C), UNNAMED);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`reclaimed ${PRIOR}`));
    const after = await agentRow();
    expect(after.agent_pid, "the identity now points at THIS window").toBe(ANCHOR_PID);
    expect(after.session_id, "a takeover rotates the session").not.toBe(before.session_id);
    const b = await thisWindowBinding();
    expect(b?.agent_name).toBe(PRIOR);
    expect(b?.bound_via).toBe("continuity");
  }, 30_000);

  it("ROW 1 AS IT REALLY HAPPENS: `ai` binds unnamed at startup, THEN /resume C claims X", async () => {
    const { getOwnHostId } = await import("../src/liveness.js");
    await seedHolder({ hostId: getOwnHostId()!, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026" });

    const s = runBind([], sessionStart("startup", N), UNNAMED);
    expect(s.status, s.stderr).toBe(0);
    const r = runBind([], sessionStart("resume", C), UNNAMED);

    expect(r.status, r.stderr).toBe(0);
    expect((await thisWindowBinding())?.agent_name).toBe(PRIOR);
  }, 30_000);

  it("REFUSE: the holder is ALIVE — X is not taken, the window is recorded as itself, and it says why", async () => {
    const { getOwnHostId, processStartedAt } = await import("../src/liveness.js");
    const livePid = process.ppid;
    await seedHolder({ hostId: getOwnHostId()!, pid: livePid, startedAt: processStartedAt(livePid) ?? "" });
    const before = await agentRow();

    const r = runBind([], sessionStart("resume", C), UNNAMED);

    expect(r.status, "the window is still recorded: refusing X is not a bind failure").toBe(0);
    expect(r.stdout).toMatch(new RegExp(`did not take ${PRIOR}`));
    expect(r.stdout).toMatch(/ALIVE/);
    expect(await agentRow(), "X is untouched").toEqual(before);
    expect((await thisWindowBinding())?.agent_name ?? null).toBeNull();
  }, 30_000);

  it("REFUSE: the holder is UNVERIFIABLE (another host) — unverifiable is not dead", async () => {
    await seedHolder({ hostId: "some-other-host", pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026" });
    const before = await agentRow();

    const r = runBind([], sessionStart("resume", C), UNNAMED);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`did not take ${PRIOR}`));
    expect(r.stdout).toMatch(/CANNOT BE VERIFIED/);
    expect(await agentRow()).toEqual(before);
  }, 30_000);

  it("A NAMED window never inherits (launch intent wins; row 3 is S3, not S3-lite)", async () => {
    const { getOwnHostId } = await import("../src/liveness.js");
    await seedHolder({ hostId: getOwnHostId()!, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026" });
    const before = await agentRow();

    const r = runBind([], sessionStart("resume", C), { RELAY_AGENT_NAME: "named-y" });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/reclaimed/);
    expect(await agentRow()).toEqual(before);
    expect((await thisWindowBinding())?.agent_name).toBe("named-y");
  }, 30_000);

  it("only /resume opens a continuity lookup: a startup carrying C's id does not claim", async () => {
    const { getOwnHostId } = await import("../src/liveness.js");
    await seedHolder({ hostId: getOwnHostId()!, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026" });
    const before = await agentRow();
    runBind([], sessionStart("startup", C), UNNAMED);
    expect(await agentRow()).toEqual(before);
  }, 30_000);
});

describe("S3-lite — the claimed identity CARRIES in the same window (row 8)", () => {
  it("/clear after a claim binds the new conversation to X (clear-carry), not to an unnamed window", async () => {
    const { getOwnHostId } = await import("../src/liveness.js");
    await seedHolder({ hostId: getOwnHostId()!, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026" });
    expect(runBind([], sessionStart("resume", C), UNNAMED).status).toBe(0);

    const r = runBind([], sessionStart("clear", C2), UNNAMED);

    expect(r.status, r.stderr).toBe(0);
    const b = await thisWindowBinding();
    expect(b?.conversation_id).toBe(C2);
    expect(b?.agent_name, "the window's identity is its binding, not its env").toBe(PRIOR);
    expect(b?.bound_via).toBe("clear-carry");
  }, 30_000);

  it("CONTROL: /compact after a claim keeps X (same conversation → refresh)", async () => {
    const { getOwnHostId } = await import("../src/liveness.js");
    await seedHolder({ hostId: getOwnHostId()!, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026" });
    expect(runBind([], sessionStart("resume", C), UNNAMED).status).toBe(0);
    expect(runBind([], sessionStart("compact", C), UNNAMED).status).toBe(0);
    expect((await thisWindowBinding())?.agent_name).toBe(PRIOR);
  }, 30_000);
});
