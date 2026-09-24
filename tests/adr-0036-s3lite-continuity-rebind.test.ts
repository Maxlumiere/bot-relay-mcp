// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 S3-lite — CONTINUITY REBIND (rows 1 and 4).
 *
 * THE DELIVERABLE, in Maxime's words: `ai`, then `/resume`, and the window is
 * back as itself. No line to paste, no instruction to give. Zero steps.
 *
 * ROW 1 (verbatim): "Hook fires (resume, C). C is bound to X; X's anchor is
 * dead. Rebind X to this window under CAS on binding_version. The connector
 * picks X up on its next call. Zero steps." ROW 4: "Same as row 1."
 *
 * THIS SLICE CROSSES A LINE S1 DELIBERATELY DID NOT. S1 was record-only, no auth
 * change. A continuity rebind performs RELEASE-THEN-CLAIM on the `agents` table:
 * it releases X's stale session and anchor and claims them for this window. That
 * rewrites `session_id` and the anchor — auth-adjacent state — and it is what
 * makes today's non-S2 machinery treat this window as X. Measured reason it is
 * required rather than optional: `agent_bindings` appears ZERO times in
 * server.ts and transport/stdio.ts, and resolveCallerNameForVault still returns
 * the env name or null, so a record-only rebind would write a correct row and
 * change nothing for a live window.
 *
 * THE GATE IS DELIBERATELY ASYMMETRIC (ruled, non-negotiable): rebind ONLY when
 * anchorLivenessVerdict returns `dead`. Both `alive` AND `unverifiable` refuse.
 * That matters because the verdict COLLAPSES "observed alive (start time
 * matched)" with "present but unverifiable (no/unreadable start anchor, so PID
 * reuse cannot be excluded)" into one `alive` — so `alive` means NOT OBSERVED
 * DEAD, and gating on `dead` refuses the live case and the unverifiable one.
 * Failing toward NOT acting is the whole safety argument for automatic takeover.
 *
 * CAS ON THE FULL OBSERVED BINDING, NEVER NAME ALONE (ruled). And a LOST CAS
 * REFUSES — it never retries. ForcePreconditionError says so in its own message:
 * "Re-read — do NOT retry force."
 *
 * RED-FIRST: none of the three units below exist yet. Each test fails because
 * the feature is absent, not because the harness is broken — verified by
 * checking the failure names the missing export rather than an assertion.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ROOT = path.join(os.tmpdir(), `bot-relay-s3lite-rebind-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");

process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

/** The conversation that carries the identity across window lifetimes. */
const CONV = "cccccccc-1111-2222-3333-444444444444";

/** The OLD window that held X and is now gone. */
const DEAD_ANCHOR = { hostId: "s3-host", windowPid: 999_001, windowPidStart: "Mon Sep 15 09:00:00 2026" };
/** The NEW window presenting C after `/resume`. */
const NEW_ANCHOR = { hostId: "s3-host", windowPid: 999_002, windowPidStart: "Mon Sep 15 10:00:00 2026" };

async function openDb(): Promise<import("../src/sqlite-compat.js").CompatDatabase> {
  const Better = (await import("better-sqlite3")).default;
  return new Better(TEST_DB_PATH) as unknown as import("../src/sqlite-compat.js").CompatDatabase;
}

/** Seed X bound to conversation C under the OLD (soon-dead) window. */
async function seedPriorBinding(agentName = "s3-x"): Promise<void> {
  const { upsertAgentBinding } = await import("../src/db.js");
  const db = await openDb();
  try {
    upsertAgentBinding(db, {
      ...DEAD_ANCHOR,
      agentName,
      agentClass: null,
      conversationId: CONV,
      conversationTitle: null,
      cwd: "/tmp/s3-project",
      boundVia: "launch-intent",
    });
  } finally {
    (db as unknown as { close(): void }).close();
  }
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const { closeDb } = await import("../src/db.js");
  closeDb();
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  const { getDb } = await import("../src/db.js");
  getDb(); // v25 schema incl. agent_bindings + the partial unique index
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE PURE DECISION — every branch, including the ones a DB cannot reach
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-0036 S3-lite — resolveContinuityClaim (pure): only a PROVABLY DEAD anchor rebinds", () => {
  const priorBinding = {
    binding_id: "b-old",
    binding_version: 3,
    agent_name: "s3-x",
    conversation_id: CONV,
    host_id: DEAD_ANCHOR.hostId,
    window_pid: DEAD_ANCHOR.windowPid,
    window_pid_start: DEAD_ANCHOR.windowPidStart,
  };

  it("a DEAD prior anchor → claim, carrying the version to CAS on", async () => {
    const { resolveContinuityClaim } = await import("../src/binding.js");
    const r = resolveContinuityClaim({
      priorBinding,
      priorAnchorVerdict: "dead",
      thisAnchor: { hostId: NEW_ANCHOR.hostId, pid: NEW_ANCHOR.windowPid, startedAt: NEW_ANCHOR.windowPidStart },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.agentName).toBe("s3-x");
      expect(r.expectedBindingVersion, "the CAS must pin the version we READ").toBe(3);
      expect(r.boundVia, "§2.2's sanctioned vocabulary — the relay's own record is the claim").toBe("continuity");
    }
  });

  it("an ALIVE prior anchor → REFUSED, and the reason names the live window", async () => {
    const { resolveContinuityClaim } = await import("../src/binding.js");
    const r = resolveContinuityClaim({
      priorBinding,
      priorAnchorVerdict: "alive",
      thisAnchor: { hostId: NEW_ANCHOR.hostId, pid: NEW_ANCHOR.windowPid, startedAt: NEW_ANCHOR.windowPidStart },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/live|alive|another window/i);
  });

  /**
   * THE HALF THAT ROTS IF IT IS NOT PINNED SEPARATELY. `alive` collapses
   * observed-alive with present-but-unverifiable, so a reader may assume
   * `unverifiable` is "probably fine". It is not: PID reuse cannot be excluded,
   * and taking over a name whose holder we cannot observe is the one mistake
   * that silently cuts a live agent's token.
   */
  it("an UNVERIFIABLE prior anchor → REFUSED, never treated as dead", async () => {
    const { resolveContinuityClaim } = await import("../src/binding.js");
    const r = resolveContinuityClaim({
      priorBinding,
      priorAnchorVerdict: "unverifiable",
      thisAnchor: { hostId: NEW_ANCHOR.hostId, pid: NEW_ANCHOR.windowPid, startedAt: NEW_ANCHOR.windowPidStart },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/unverifiable|cannot be verified|could not observe/i);
      // and it must name the route, never leave the operator guessing
      expect(r.reason).toMatch(/release-binding|--override/i);
    }
  });

  it("an UNNAMED prior binding is not an identity to inherit → REFUSED", async () => {
    const { resolveContinuityClaim } = await import("../src/binding.js");
    const r = resolveContinuityClaim({
      priorBinding: { ...priorBinding, agent_name: null },
      priorAnchorVerdict: "dead",
      thisAnchor: { hostId: NEW_ANCHOR.hostId, pid: NEW_ANCHOR.windowPid, startedAt: NEW_ANCHOR.windowPidStart },
    });
    expect(r.ok).toBe(false);
  });

  it("the SAME window re-presenting its own conversation is a refresh, not a takeover", async () => {
    const { resolveContinuityClaim } = await import("../src/binding.js");
    const r = resolveContinuityClaim({
      priorBinding,
      priorAnchorVerdict: "dead",
      // identical anchor: this IS the window that holds it
      thisAnchor: { hostId: DEAD_ANCHOR.hostId, pid: DEAD_ANCHOR.windowPid, startedAt: DEAD_ANCHOR.windowPidStart },
    });
    // Never a release-then-claim against yourself: that would rotate the session
    // of a window that already holds the name, for no reason.
    expect(r.ok === false || (r.ok && r.action === "refresh")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE READ — identity follows the CONVERSATION (§3 precedence)
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-0036 S3-lite — getCurrentBindingByConversation", () => {
  it("finds the CURRENT binding for a conversation, with the anchor needed to gate it", async () => {
    await seedPriorBinding();
    const { getCurrentBindingByConversation } = await import("../src/db.js");
    const db = await openDb();
    try {
      const row = getCurrentBindingByConversation(db, CONV);
      expect(row, "conversation C must resolve to the binding that holds it").toBeTruthy();
      expect(row!.agent_name).toBe("s3-x");
      expect(row!.binding_version).toBe(1);
      // The gate needs all three anchor fields, or it cannot ask if X is dead.
      expect(row!.host_id).toBe(DEAD_ANCHOR.hostId);
      expect(row!.window_pid).toBe(DEAD_ANCHOR.windowPid);
      expect(row!.window_pid_start).toBe(DEAD_ANCHOR.windowPidStart);
    } finally {
      (db as unknown as { close(): void }).close();
    }
  });

  it("returns nothing for an unknown conversation — a first bind is not a rebind", async () => {
    const { getCurrentBindingByConversation } = await import("../src/db.js");
    const db = await openDb();
    try {
      expect(getCurrentBindingByConversation(db, "no-such-conversation")).toBeFalsy();
    } finally {
      (db as unknown as { close(): void }).close();
    }
  });

  it("ignores SUPERSEDED rows — history is not a claim", async () => {
    await seedPriorBinding();
    const { upsertAgentBinding, getCurrentBindingByConversation } = await import("../src/db.js");
    const db = await openDb();
    try {
      // Same anchor, different conversation → supersedes the row above.
      upsertAgentBinding(db, {
        ...DEAD_ANCHOR,
        agentName: "s3-x",
        agentClass: null,
        conversationId: "dddddddd-1111-2222-3333-444444444444",
        conversationTitle: null,
        cwd: "/tmp/s3-project",
        boundVia: "clear-carry",
      });
      expect(
        getCurrentBindingByConversation(db, CONV),
        "the superseded row must not offer an identity",
      ).toBeFalsy();
    } finally {
      (db as unknown as { close(): void }).close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE WRITER — release-then-claim, CAS on the FULL observed binding
// ─────────────────────────────────────────────────────────────────────────────

describe("ADR-0036 S3-lite — rebindAgentToWindow: release-then-claim under CAS", () => {
  it("moves the identity: the agents row now points at THIS window, session rotated", async () => {
    await seedPriorBinding();
    const { registerAgent, getAgentAuthData, rebindAgentToWindow } = await import("../src/db.js");
    registerAgent("s3-x", "builder", []);
    const before = getAgentAuthData("s3-x")!;

    const db = await openDb();
    try {
      const r = rebindAgentToWindow(db, {
        agentName: "s3-x",
        conversationId: CONV,
        newAnchor: NEW_ANCHOR,
        cwd: "/tmp/s3-project",
        expected: {
          bindingId: "unused-in-assertion",
          bindingVersion: 1,
          sessionId: before.session_id,
          agentPid: before.agent_pid ?? null,
          agentPidStart: before.agent_pid_start ?? null,
        },
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    } finally {
      (db as unknown as { close(): void }).close();
    }

    const after = getAgentAuthData("s3-x")!;
    expect(after.agent_pid, "the claim must stamp THIS window's anchor").toBe(NEW_ANCHOR.windowPid);
    expect(after.agent_pid_start).toBe(NEW_ANCHOR.windowPidStart);
    expect(after.session_id, "a takeover rotates the session (ADR-0012)").not.toBe(before.session_id);
    // IDENTITY PRESERVED: a rebind is not a re-registration from scratch.
    expect(after.token_hash, "the token must survive a rebind").toBe(before.token_hash);
  });

  it("bumps binding_version and records bound_via=continuity, superseding the old row", async () => {
    await seedPriorBinding();
    const { registerAgent, getAgentAuthData, rebindAgentToWindow, listAgentBindings } = await import("../src/db.js");
    registerAgent("s3-x", "builder", []);
    const before = getAgentAuthData("s3-x")!;

    const db = await openDb();
    try {
      rebindAgentToWindow(db, {
        agentName: "s3-x",
        conversationId: CONV,
        newAnchor: NEW_ANCHOR,
        cwd: "/tmp/s3-project",
        expected: {
          bindingId: "unused-in-assertion",
          bindingVersion: 1,
          sessionId: before.session_id,
          agentPid: before.agent_pid ?? null,
          agentPidStart: before.agent_pid_start ?? null,
        },
      });
      const current = listAgentBindings(db).filter((b) => b.conversation_id === CONV);
      expect(current.length, "exactly one current binding for the conversation").toBe(1);
      expect(current[0].window_pid).toBe(NEW_ANCHOR.windowPid);
      expect(current[0].binding_version, "every rebind bumps the CAS version (§2.2)").toBe(2);
      expect(current[0].bound_via).toBe("continuity");
    } finally {
      (db as unknown as { close(): void }).close();
    }
  });

  it("a STALE binding_version LOSES the CAS: nothing is written, and it does NOT retry", async () => {
    await seedPriorBinding();
    const { registerAgent, getAgentAuthData, rebindAgentToWindow, listAgentBindings } = await import("../src/db.js");
    registerAgent("s3-x", "builder", []);
    const before = getAgentAuthData("s3-x")!;

    const db = await openDb();
    try {
      const r = rebindAgentToWindow(db, {
        agentName: "s3-x",
        conversationId: CONV,
        newAnchor: NEW_ANCHOR,
        cwd: "/tmp/s3-project",
        expected: {
          bindingId: "unused-in-assertion",
          bindingVersion: 99, // someone else rebound between our read and this write
          sessionId: before.session_id,
          agentPid: before.agent_pid ?? null,
          agentPidStart: before.agent_pid_start ?? null,
        },
      });
      expect(r.ok, "a lost CAS must refuse").toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/version|compare-and-swap|CAS|changed/i);

      const current = listAgentBindings(db).filter((b) => b.conversation_id === CONV);
      expect(current[0].window_pid, "the loser must not have moved the binding").toBe(DEAD_ANCHOR.windowPid);
    } finally {
      (db as unknown as { close(): void }).close();
    }

    const after = getAgentAuthData("s3-x")!;
    expect(after.session_id, "a lost CAS must not have rotated the session either").toBe(before.session_id);
  });

  it("a STALE session_id LOSES the CAS too — the CAS is the FULL binding, not the name", async () => {
    await seedPriorBinding();
    const { registerAgent, getAgentAuthData, rebindAgentToWindow } = await import("../src/db.js");
    registerAgent("s3-x", "builder", []);
    const before = getAgentAuthData("s3-x")!;

    const db = await openDb();
    try {
      const r = rebindAgentToWindow(db, {
        agentName: "s3-x",
        conversationId: CONV,
        newAnchor: NEW_ANCHOR,
        cwd: "/tmp/s3-project",
        expected: {
          bindingId: "unused-in-assertion",
          bindingVersion: 1,
          sessionId: "a-session-that-is-not-current",
          agentPid: before.agent_pid ?? null,
          agentPidStart: before.agent_pid_start ?? null,
        },
      });
      expect(r.ok, "name-only CAS would have let this through — that is the defect").toBe(false);
    } finally {
      (db as unknown as { close(): void }).close();
    }

    expect(getAgentAuthData("s3-x")!.session_id).toBe(before.session_id);
  });

  /**
   * TORN STATE IS THE DEFECT THIS WRITER EXISTS TO AVOID (ruled: pin it).
   *
   * A release-then-claim split across two CONNECTIONS cannot share a transaction,
   * so a failure between the halves leaves the agents row moved and the binding
   * row not — the identity side getting exactly the torn state the partial unique
   * index prevents on the binding side. One handle, one transaction, or neither.
   *
   * Driven through the FAILING CAS because that is the reachable rollback path:
   * the agents claim succeeds, the binding supersede then loses, and the whole
   * transaction must roll back — leaving the agents row EXACTLY as it was.
   */
  it("TORN STATE IS IMPOSSIBLE: a binding-CAS loss rolls back the agents claim too", async () => {
    await seedPriorBinding();
    const { registerAgent, getAgentAuthData, rebindAgentToWindow, listAgentBindings } = await import("../src/db.js");
    registerAgent("s3-x", "builder", []);
    const before = getAgentAuthData("s3-x")!;

    const db = await openDb();
    try {
      const r = rebindAgentToWindow(db, {
        agentName: "s3-x",
        conversationId: CONV,
        newAnchor: NEW_ANCHOR,
        cwd: "/tmp/s3-project",
        expected: {
          bindingId: "unused-in-assertion",
          // agents-side CAS values are CORRECT, so step 1 succeeds…
          sessionId: before.session_id,
          agentPid: before.agent_pid ?? null,
          agentPidStart: before.agent_pid_start ?? null,
          // …while the binding version is stale, so step 2 must lose.
          bindingVersion: 99,
        },
      });
      expect(r.ok, "the binding CAS must lose").toBe(false);

      const current = listAgentBindings(db).filter((b) => b.conversation_id === CONV);
      expect(current[0].window_pid, "binding must not have moved").toBe(DEAD_ANCHOR.windowPid);
    } finally {
      (db as unknown as { close(): void }).close();
    }

    // THE ASSERTION THAT MATTERS: the agents row is untouched. Without one
    // transaction, step 1 would have committed and this identity would now point
    // at a window that holds no binding.
    const after = getAgentAuthData("s3-x")!;
    expect(after.session_id, "a rolled-back rebind must not rotate the session").toBe(before.session_id);
    expect(after.agent_pid, "a rolled-back rebind must not move the anchor").toBe(before.agent_pid ?? null);
    expect(after.agent_pid_start).toBe(before.agent_pid_start ?? null);
  }, 30_000);

  it("ANNOUNCES in ONE line: the hook collapses bind stdout and prints only the first", async () => {
    // check-relay.sh:919-921 does `tr '\r\n' '  '` and prints only if the result
    // starts with "[RELAY]". A release AND a claim therefore share ONE line —
    // `relay fleet` is where the pair is separable (bound_via + binding_version).
    await seedPriorBinding();
    const { registerAgent, getAgentAuthData, rebindAgentToWindow } = await import("../src/db.js");
    registerAgent("s3-x", "builder", []);
    const before = getAgentAuthData("s3-x")!;

    const db = await openDb();
    try {
      const r = rebindAgentToWindow(db, {
        agentName: "s3-x",
        conversationId: CONV,
        newAnchor: NEW_ANCHOR,
        cwd: "/tmp/s3-project",
        expected: {
          bindingId: "unused-in-assertion",
          bindingVersion: 1,
          sessionId: before.session_id,
          agentPid: before.agent_pid ?? null,
          agentPidStart: before.agent_pid_start ?? null,
        },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.announce, "the rebind must say what it did").toBeTruthy();
        expect(r.announce).not.toMatch(/[\r\n]/);
        // Both halves in the one line it is allowed.
        expect(r.announce).toMatch(/s3-x/);
        expect(r.announce).toMatch(/released|took over|reclaimed/i);
      }
    } finally {
      (db as unknown as { close(): void }).close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ROW 1'S REAL SEQUENCE — this window is ALREADY bound (its own startup)
// ─────────────────────────────────────────────────────────────────────────────
//
// `ai` fires SessionStart(startup) with a fresh conversation id BEFORE the user types
// `/resume C`, so by the time the continuity claim runs, THIS anchor already holds a
// current (unnamed) binding. Every fixture above used a fresh anchor, so none of them
// could see what happens here. The partial unique index allows ONE current row per
// anchor: the claim must supersede this window's own row, in the same transaction.

describe("ADR-0036 S3-lite — rebind when THIS window already holds a binding (row 1 as it really happens)", () => {
  it("supersedes this window's own startup binding and leaves exactly one current row for the anchor", async () => {
    await seedPriorBinding();
    const { registerAgent, getAgentAuthData, rebindAgentToWindow, upsertAgentBinding, getCurrentBinding } =
      await import("../src/db.js");
    registerAgent("s3-x", "builder", []);
    const before = getAgentAuthData("s3-x")!;

    const db = await openDb();
    try {
      // The window's own startup bind: unnamed, fresh conversation.
      upsertAgentBinding(db, {
        ...NEW_ANCHOR,
        agentName: null,
        agentClass: null,
        conversationId: "eeeeeeee-1111-2222-3333-444444444444",
        conversationTitle: null,
        cwd: "/tmp/s3-project",
        boundVia: "transient",
      });
      const startupRow = getCurrentBinding(db, NEW_ANCHOR)!;

      const r = rebindAgentToWindow(db, {
        agentName: "s3-x",
        conversationId: CONV,
        newAnchor: NEW_ANCHOR,
        cwd: "/tmp/s3-project",
        expected: {
          bindingId: "unused-in-assertion",
          bindingVersion: 1,
          sessionId: before.session_id,
          agentPid: before.agent_pid ?? null,
          agentPidStart: before.agent_pid_start ?? null,
        },
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);

      const current = (db as unknown as { prepare(s: string): { all(...a: unknown[]): unknown[] } })
        .prepare(
          "SELECT binding_id, agent_name, conversation_id FROM agent_bindings " +
            "WHERE host_id = ? AND window_pid = ? AND window_pid_start = ? AND superseded_at IS NULL",
        )
        .all(NEW_ANCHOR.hostId, NEW_ANCHOR.windowPid, NEW_ANCHOR.windowPidStart) as Array<Record<string, unknown>>;
      expect(current, "exactly one current row for this window").toHaveLength(1);
      expect(current[0].agent_name).toBe("s3-x");
      expect(current[0].conversation_id).toBe(CONV);
      const old = (db as unknown as { prepare(s: string): { get(...a: unknown[]): unknown } })
        .prepare("SELECT superseded_at, supersede_reason FROM agent_bindings WHERE binding_id = ?")
        .get(startupRow.binding_id) as { superseded_at: string | null; supersede_reason: string | null };
      expect(old.superseded_at, "this window's startup row is history now").not.toBeNull();
    } finally {
      (db as unknown as { close(): void }).close();
    }
  });
});
