// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.12.0 — pending-vs-history contract tests.
 *
 * Problem fixed: the pending read model is session-scoped on purpose (a
 * fresh terminal re-sees previously-read mail so handovers never drop
 * UNfinished work — v2.0 final #6). The side effect was that ALREADY-
 * HANDLED mail also re-flooded every new session. This adds a session-
 * INDEPENDENT `resolved_at` plane: `pending` now also requires
 * `resolved_at IS NULL`, so resolved items leave the action queue
 * permanently while unfinished work still re-surfaces.
 *
 * The 7 contract tests (assert the CONTRACT, not a proxy):
 *   1. Regression of the live re-flood bug: ack-drain in S1 ⇒ S2 pending
 *      EMPTY; WITHOUT ack, S2 still re-sees them (proves the fix is the
 *      resolve, not a change to session-scoped read semantics).
 *   2. A resolved message is ABSENT from pending, PRESENT in all/history.
 *   3. ack=true resolves EXACTLY the returned set — no more, no less;
 *      read-mark + resolve move together.
 *   4. resolve_messages resolves only the named ids, only for the recipient.
 *   5. Authz (adversarial): agent B's token CANNOT resolve agent A's mail.
 *   6. Back-compat: ack=false ⇒ byte-identical response shape + the
 *      session-scoped handover re-surface is preserved.
 *   7. Concurrency-safe resolution is idempotent (BEGIN IMMEDIATE +
 *      `resolved_at IS NULL` guard): a second drain/resolve neither
 *      double-counts nor drops.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import cp from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v2120-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// Scrub inherited RELAY_AGENT_* so the isolated test never auths against a
// parent-shell spawn token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
process.env.RELAY_HTTP_PORT = "54996";

const { handleSendMessage, handleGetMessages, handleGetMessagesSummary, handleResolveMessages } =
  await import("../src/tools/messaging.js");
const {
  closeDb,
  getDb,
  registerAgent,
  sendMessage,
  getMessages,
  resolveMessages,
} = await import("../src/db.js");
const { createServer } = await import("../src/server.js");

function parse(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

/** Send `n` messages from `sender` to `to`; returns the message ids. */
function seed(sender: string, to: string, n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const m = sendMessage(sender, to, `msg-${i}`, "normal");
    ids.push(m.id);
  }
  return ids;
}

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

// --- 1. Regression of the live cross-session re-flood bug ---

describe("v2.12.0 — (1) re-flood regression", () => {
  it("ack-drain in S1 ⇒ a fresh session S2 sees an EMPTY pending queue", () => {
    registerAgent("sender", "r", []);
    registerAgent("alice", "r", []); // session S1
    seed("sender", "alice", 2);

    const s1 = parse(handleGetMessages({ agent_name: "alice", status: "pending", limit: 20, ack: true } as any));
    expect(s1.count).toBe(2);
    expect(s1.acked).toBe(true);
    expect(s1.resolved_count).toBe(2);

    // S2 = a brand-new terminal session (register rotates session_id).
    registerAgent("alice", "r", []);
    const s2 = parse(handleGetMessages({ agent_name: "alice", status: "pending", limit: 20 } as any));
    expect(s2.count).toBe(0); // the bug, now fixed
  });

  it("WITHOUT ack, S2 STILL re-sees them — proving the fix is the resolve, not changed read-semantics", () => {
    registerAgent("sender", "r", []);
    registerAgent("bob", "r", []); // session S1
    seed("sender", "bob", 2);

    const s1 = parse(handleGetMessages({ agent_name: "bob", status: "pending", limit: 20 } as any)); // no ack
    expect(s1.count).toBe(2);
    expect(s1.acked).toBeUndefined();

    registerAgent("bob", "r", []); // session S2
    const s2 = parse(handleGetMessages({ agent_name: "bob", status: "pending", limit: 20 } as any));
    expect(s2.count).toBe(2); // session-scoped handover re-surface preserved
  });
});

// --- 2. resolved is absent from pending, present in all/history ---

describe("v2.12.0 — (2) resolved leaves pending, stays in history", () => {
  it("a resolved message is absent from pending and present in all + history + resolved", () => {
    registerAgent("sender", "r", []);
    registerAgent("alice", "r", []);
    const [id] = seed("sender", "alice", 1);

    const res = resolveMessages("alice", [id]);
    expect(res.resolved_count).toBe(1);

    // Fresh session so the pending filter isn't masking via read-state.
    registerAgent("alice", "r", []);
    expect(getMessages("alice", "pending", 20).length).toBe(0);
    expect(getMessages("alice", "all", 20).some((m) => m.id === id)).toBe(true);
    expect(getMessages("alice", "history", 20).some((m) => m.id === id)).toBe(true);
    expect(getMessages("alice", "resolved", 20).some((m) => m.id === id)).toBe(true);
  });
});

// --- 3. ack resolves EXACTLY the returned set ---

describe("v2.12.0 — (3) ack resolves exactly the returned set", () => {
  it("limit caps the returned set; only those are resolved (read-mark + resolve move together)", () => {
    registerAgent("sender", "r", []);
    registerAgent("alice", "r", []);
    seed("sender", "alice", 3);

    // Drain only 2 of 3, with ack. The 3rd is neither returned, read, nor resolved.
    const drained = parse(handleGetMessages({ agent_name: "alice", status: "pending", limit: 2, ack: true } as any));
    expect(drained.count).toBe(2);
    expect(drained.resolved_count).toBe(2);

    // Exactly 2 resolved; exactly 1 still pending (same session — unread + unresolved).
    expect(getMessages("alice", "resolved", 20).length).toBe(2);
    expect(getMessages("alice", "pending", 20).length).toBe(1);

    // The returned set moved together: each returned id is BOTH read and resolved.
    const db = getDb();
    for (const m of drained.messages) {
      const row = db
        .prepare("SELECT read_by_session, resolved_at FROM messages WHERE id = ?")
        .get(m.id) as { read_by_session: string | null; resolved_at: string | null };
      expect(row.read_by_session).not.toBeNull();
      expect(row.resolved_at).not.toBeNull();
    }
  });
});

// --- 4. resolve_messages: only named ids, only the recipient's ---

describe("v2.12.0 — (4) resolve_messages scoping", () => {
  it("resolves only the named ids", () => {
    registerAgent("sender", "r", []);
    registerAgent("alice", "r", []);
    const ids = seed("sender", "alice", 3);

    const out = parse(handleResolveMessages({ agent_name: "alice", message_ids: [ids[0], ids[2]] } as any));
    expect(out.success).toBe(true);
    expect(out.resolved_count).toBe(2);
    expect(out.resolved_ids.sort()).toEqual([ids[0], ids[2]].sort());

    registerAgent("alice", "r", []);
    const pendingIds = getMessages("alice", "pending", 20).map((m) => m.id);
    expect(pendingIds).toEqual([ids[1]]); // only the un-named one remains
  });

  it("does NOT resolve a message addressed to a different agent (recipient scope at the DB layer)", () => {
    registerAgent("sender", "r", []);
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    const [aliceMsg] = seed("sender", "alice", 1);

    // bob tries to resolve alice's message by id — DB scopes by to_agent.
    const out = resolveMessages("bob", [aliceMsg]);
    expect(out.resolved_count).toBe(0);
    expect(out.resolved_ids).toEqual([]);

    // alice's message is untouched — still pending for alice.
    registerAgent("alice", "r", []);
    expect(getMessages("alice", "pending", 20).some((m) => m.id === aliceMsg)).toBe(true);
  });
});

// --- 5. Authz (adversarial) — through the real dispatcher ---

describe("v2.12.0 — (5) authz: B's token cannot resolve A's mail", () => {
  async function connectClient() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);
    const client = new Client({ name: "v2120-authz", version: "0.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    return { client, server };
  }

  it("the dispatcher rejects B's token presented for agent_name=A (token↔agent_name binding)", async () => {
    const alice = registerAgent("alice", "r", []);
    const bob = registerAgent("bob", "r", []);
    const [aliceMsg] = seed("alice", "alice", 1); // a message in alice's mailbox

    const { client, server } = await connectClient();
    try {
      // B presents ITS token but claims to be A → dispatcher must reject.
      const res: any = await client.callTool({
        name: "resolve_messages",
        arguments: { agent_name: "alice", message_ids: [aliceMsg], agent_token: bob.plaintext_token },
      });
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text);
      expect(body.success).toBe(false);
      expect(body.auth_error).toBe(true);
      expect(body.error_code).toBe("AUTH_FAILED");

      // A's message is untouched (never resolved).
      expect(getMessages("alice", "resolved", 20).length).toBe(0);

      // Sanity: A CAN resolve its own mail with A's token.
      const ok: any = await client.callTool({
        name: "resolve_messages",
        arguments: { agent_name: "alice", message_ids: [aliceMsg], agent_token: alice.plaintext_token },
      });
      const okBody = JSON.parse(ok.content[0].text);
      expect(okBody.success).toBe(true);
      expect(okBody.resolved_count).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("even with a VALID self-claim, B cannot resolve A's message (DB recipient scope)", async () => {
    registerAgent("alice", "r", []);
    const bob = registerAgent("bob", "r", []);
    const [aliceMsg] = seed("alice", "alice", 1);

    const { client, server } = await connectClient();
    try {
      // B authenticates correctly as itself, but passes A's message id.
      const res: any = await client.callTool({
        name: "resolve_messages",
        arguments: { agent_name: "bob", message_ids: [aliceMsg], agent_token: bob.plaintext_token },
      });
      const body = JSON.parse(res.content[0].text);
      expect(body.success).toBe(true);
      expect(body.resolved_count).toBe(0); // not bob's mail → untouched
      expect(getMessages("alice", "resolved", 20).length).toBe(0);
    } finally {
      await server.close();
    }
  });

  // The exact bypass an external audit reproduced: a STRAY `from` on an
  // agent_name-keyed tool. Pre-fix, agentFromArgs read `from` first for every
  // tool, so a valid bob token + from:bob authenticated as bob while the
  // handler acted on agent_name:alice. Now `from` is unknown to these tools'
  // schemas, so it cannot identify the caller → the bob/alice mismatch is
  // rejected.
  it("resolve_messages: a stray `from` cannot bypass the agent_name binding", async () => {
    registerAgent("alice", "r", []);
    const bob = registerAgent("bob", "r", []);
    const [aliceMsg] = seed("alice", "alice", 1);

    const { client, server } = await connectClient();
    try {
      const res: any = await client.callTool({
        name: "resolve_messages",
        arguments: {
          from: "bob", // ← the exploit: extra field, valid bob token below
          agent_name: "alice",
          message_ids: [aliceMsg],
          agent_token: bob.plaintext_token,
        },
      });
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text);
      expect(body.error_code).toBe("AUTH_FAILED");
      // alice's mail untouched.
      expect(getMessages("alice", "resolved", 20).length).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("get_messages: a stray `from` cannot read/consume another agent's mailbox", async () => {
    registerAgent("alice", "r", []);
    const bob = registerAgent("bob", "r", []);
    const [aliceMsg] = seed("bob", "alice", 1);

    const { client, server } = await connectClient();
    try {
      const res: any = await client.callTool({
        name: "get_messages",
        arguments: {
          from: "bob",
          agent_name: "alice",
          status: "pending",
          limit: 20,
          agent_token: bob.plaintext_token,
        },
      });
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text);
      expect(body.error_code).toBe("AUTH_FAILED");
      // The rejected call must NOT have marked alice's message read.
      const row = getDb()
        .prepare("SELECT read_by_session FROM messages WHERE id = ?")
        .get(aliceMsg) as { read_by_session: string | null };
      expect(row.read_by_session).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("get_messages_summary: a stray `from` cannot preview another agent's mailbox", async () => {
    registerAgent("alice", "r", []);
    const bob = registerAgent("bob", "r", []);
    seed("bob", "alice", 1);

    const { client, server } = await connectClient();
    try {
      const res: any = await client.callTool({
        name: "get_messages_summary",
        arguments: {
          from: "bob",
          agent_name: "alice",
          status: "pending",
          limit: 20,
          agent_token: bob.plaintext_token,
        },
      });
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text);
      expect(body.error_code).toBe("AUTH_FAILED");
    } finally {
      await server.close();
    }
  });
});

// --- 6. Back-compat: ack=false is byte-identical + preserves handover ---

describe("v2.12.0 — (6) back-compat when ack=false", () => {
  it("ack=false response has NO acked/resolved_count fields (byte-identical shape)", () => {
    registerAgent("sender", "r", []);
    registerAgent("alice", "r", []);
    seed("sender", "alice", 1);

    const data = parse(handleGetMessages({ agent_name: "alice", status: "pending", limit: 20 } as any));
    expect(Object.keys(data).sort()).toEqual(
      ["agent", "count", "filter", "messages", "since", "since_bound"].sort(),
    );
    expect("acked" in data).toBe(false);
    expect("resolved_count" in data).toBe(false);
  });

  it("the session-scoped handover re-surface still works with ack=false", () => {
    registerAgent("sender", "r", []);
    registerAgent("alice", "r", []);
    seed("sender", "alice", 1);

    parse(handleGetMessages({ agent_name: "alice", status: "pending", limit: 20 } as any)); // S1 reads, no ack
    registerAgent("alice", "r", []); // S2
    const s2 = parse(handleGetMessages({ agent_name: "alice", status: "pending", limit: 20 } as any));
    expect(s2.count).toBe(1); // unfinished work re-surfaces across sessions
  });
});

// --- 6b. ack + peek are mutually exclusive (validation hardening) ---

describe("v2.12.0 — (6b) ack + peek rejected (no false ack receipt)", () => {
  it("ack=true + peek=true is a VALIDATION error and resolves nothing", () => {
    registerAgent("sender", "r", []);
    registerAgent("alice", "r", []);
    const [id] = seed("sender", "alice", 1);

    const res = handleGetMessages({ agent_name: "alice", status: "pending", limit: 20, ack: true, peek: true } as any);
    expect((res as any).isError).toBe(true);
    const body = parse(res);
    expect(body.success).toBe(false);
    expect(body.error_code).toBe("VALIDATION");

    // Nothing was resolved or read — the call was rejected before any mutation.
    const row = getDb()
      .prepare("SELECT read_by_session, resolved_at FROM messages WHERE id = ?")
      .get(id) as { read_by_session: string | null; resolved_at: string | null };
    expect(row.read_by_session).toBeNull();
    expect(row.resolved_at).toBeNull();
  });
});

// --- 7. Idempotent / concurrency-safe resolution ---

describe("v2.12.0 — (7) idempotent resolution (no double-count, no drop)", () => {
  it("a second resolve of the same id is a no-op and does not change resolved_at", () => {
    registerAgent("sender", "r", []);
    registerAgent("alice", "r", []);
    const [id] = seed("sender", "alice", 1);

    const first = resolveMessages("alice", [id]);
    expect(first.resolved_count).toBe(1);
    const db = getDb();
    const t1 = (db.prepare("SELECT resolved_at FROM messages WHERE id = ?").get(id) as { resolved_at: string }).resolved_at;

    const second = resolveMessages("alice", [id]);
    expect(second.resolved_count).toBe(0); // already resolved → no double-count
    const t2 = (db.prepare("SELECT resolved_at FROM messages WHERE id = ?").get(id) as { resolved_at: string }).resolved_at;
    expect(t2).toBe(t1); // timestamp unchanged

    // Exactly one resolved row — never duplicated, never dropped.
    expect(getMessages("alice", "resolved", 20).filter((m) => m.id === id).length).toBe(1);
  });

  it("two ack drains across sessions resolve the message exactly once", () => {
    registerAgent("sender", "r", []);
    registerAgent("alice", "r", []); // S1
    const [id] = seed("sender", "alice", 1);

    const s1 = parse(handleGetMessages({ agent_name: "alice", status: "pending", limit: 20, ack: true } as any));
    expect(s1.count).toBe(1);

    registerAgent("alice", "r", []); // S2 races a second drain
    const s2 = parse(handleGetMessages({ agent_name: "alice", status: "pending", limit: 20, ack: true } as any));
    expect(s2.count).toBe(0); // already resolved — neither double-delivered nor dropped

    expect(getMessages("alice", "resolved", 20).filter((m) => m.id === id).length).toBe(1);
  });

  // A REAL OS-level race (not a sequential simulation): two child processes
  // resolve the SAME id set against the shared DB file at the same time. The
  // BEGIN IMMEDIATE tx + `resolved_at IS NULL` guard must make each id resolve
  // EXACTLY once — so the children's resolved_counts sum to N (no double-count)
  // and every message ends resolved (no drop), regardless of interleaving.
  it("two OS processes ack-resolving the same set — each id resolved exactly once", async () => {
    const N = 40;
    getDb();
    registerAgent("sender", "r", []);
    registerAgent("raceagent", "r", []);
    const ids = seed("sender", "raceagent", N);
    closeDb(); // release the parent connection so the children open cleanly

    // ESM child written to a .mjs file. It calls the async initializeDb()
    // first (the ESM-safe driver loader the daemon uses) so the synchronous
    // getDb() returns the cached connection rather than its lazy
    // createRequire path, which is not loadable in a standalone ESM child.
    // Then it resolves the id set against the shared DB and prints the count
    // (logger writes to stderr, so stdout is clean JSON).
    const dbUrl = pathToFileURL(path.join(REPO_ROOT, "dist/db.js")).href;
    const childPath = path.join(TEST_DB_DIR, "race-child.mjs");
    fs.writeFileSync(
      childPath,
      `import { initializeDb, resolveMessages } from ${JSON.stringify(dbUrl)};\n` +
        `await initializeDb();\n` +
        `const ids = JSON.parse(process.env.RACE_IDS);\n` +
        `const r = resolveMessages("raceagent", ids);\n` +
        `process.stdout.write(JSON.stringify({ resolved_count: r.resolved_count }));\n`,
    );
    function spawnResolver() {
      return new Promise<{ resolved_count: number; stderr: string; code: number | null }>((resolve, reject) => {
        const child = cp.spawn(process.execPath, [childPath], {
          env: { ...process.env, RELAY_DB_PATH: TEST_DB_PATH, RACE_IDS: JSON.stringify(ids) },
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("error", reject);
        child.on("exit", (code) => {
          let parsed = { resolved_count: -1 };
          try { parsed = JSON.parse(stdout); } catch { /* leave -1 */ }
          resolve({ resolved_count: parsed.resolved_count, stderr, code });
        });
      });
    }

    // Launch both concurrently for genuine contention.
    const [a, b] = await Promise.all([spawnResolver(), spawnResolver()]);
    expect(a.code, `child A failed: ${a.stderr}`).toBe(0);
    expect(b.code, `child B failed: ${b.stderr}`).toBe(0);

    // No double-count: the two processes resolved disjoint subsets summing to N.
    expect(a.resolved_count + b.resolved_count).toBe(N);

    // No drop: every message ended resolved, exactly once.
    const verify = getDb();
    const resolved = (verify
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE to_agent = 'raceagent' AND resolved_at IS NOT NULL")
      .get() as { c: number }).c;
    const unresolved = (verify
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE to_agent = 'raceagent' AND resolved_at IS NULL")
      .get() as { c: number }).c;
    expect(resolved).toBe(N);
    expect(unresolved).toBe(0);
  }, 30000);
});
