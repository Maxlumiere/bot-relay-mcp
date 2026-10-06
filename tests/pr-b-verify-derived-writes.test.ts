// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR-B (architect 07fe7cfc): a WRITE DERIVED FROM AN AWAITED VERIFY must still be right when the
 * credential changed DURING the verify. Auth is async (bcrypt runs in the worker pool), so a rotate,
 * admin-rotate, revoke or recovery can land between the read of the row and the verdict.
 *
 * Each race is DETERMINISTIC: `_onNextCompareForTests` lands the mutation synchronously at the moment
 * the compare is requested, which is after the verifier read the row and before its verdict, exactly
 * where a concurrent request can land. Each write is checked by its observable effect:
 *   - the lookup-digest HEAL is a compare-and-set on the credential it verified: a rotate during the
 *     compare must not overwrite the new token's digest (or the new token is locked out);
 *   - the verified-token CACHE is bound to the generation read BEFORE the verify: a revoke during the
 *     compare must not leave a cached "valid" verdict for the revoked token;
 *   - the dashboard's send_message (authorized by an awaited from_agent_token verify) re-checks the
 *     generation, so a revoke during the compare refuses the send.
 * tests/pr-b-auth-invariants.test.ts holds the structural half: every function that awaits a verify is
 * classified there, so a new one cannot appear unreviewed.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { Server as HttpServer } from "http";
import { OPERATOR_SECRET, operatorPost } from "./_helpers/operator-auth.js";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr-b-race-")));
process.env.RELAY_DB_PATH = path.join(ROOT, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;
delete process.env.RELAY_ENCRYPTION_KEYRING;
delete process.env.RELAY_ENCRYPTION_KEYRING_PATH;
delete process.env.RELAY_ENCRYPTION_KEY;

const db = await import("../src/db.js");
const { lookupKeys, computeTokenLookup, _resetTokenLookupCacheForTests } = await import("../src/token-lookup.js");
const { _onNextCompareForTests, bcryptCompareCount } = await import("../src/bcrypt-pool.js");
const { _resetAuthThrottleForTests } = await import("../src/auth-throttle.js");
const { _resetAuthRejectionAuditForTests } = await import("../src/auth-rejection-audit.js");
const { authCacheClear } = await import("../src/auth-cache.js");

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => {
  db.closeDb();
  for (const f of ["relay.db", "relay.db-wal", "relay.db-shm", "token-lookup.key"]) fs.rmSync(path.join(ROOT, f), { force: true });
  _resetTokenLookupCacheForTests();
  _resetAuthThrottleForTests();
  _resetAuthRejectionAuditForTests();
  authCacheClear();
  _onNextCompareForTests(null);
  db.getDb();
});
afterEach(() => _onNextCompareForTests(null));

const reg = (name: string): string => db.registerAgent(name, "worker", []).plaintext_token!;
/** The pre-PR-B BARE digest (no key id): a row in that form is healed on its next successful auth. */
function makeBare(name: string, token: string): void {
  const hex = crypto.createHmac("sha256", lookupKeys()[0].key).update(token, "utf8").digest("hex");
  db.getDb().prepare("UPDATE agents SET token_lookup = ? WHERE name = ?").run(hex, name);
}
/** Land `mutation` while the NEXT compare is outstanding; returns a probe that says whether it fired. */
function duringNextCompare(mutation: () => void): () => boolean {
  let fired = false;
  _onNextCompareForTests(() => {
    fired = true;
    mutation();
  });
  return () => fired;
}
const rotate = (name: string): string => db.rotateAgentToken(name, db.getAgentAuthData(name)!.token_hash!).newPlaintextToken;

async function withDaemon(fn: (port: number) => Promise<void>): Promise<void> {
  const { startHttpServer } = await import("../src/transport/http.js");
  const server: HttpServer = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 80));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}
/** One MCP tool call; ok = the tool ran (not an auth refusal). */
async function call(port: number, tool: string, args: Record<string, unknown>, token: string): Promise<{ ok: boolean; text: string }> {
  const text = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Agent-Token": token },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  }).then((r) => r.text());
  return { ok: !/"isError":\s*true/.test(text) && !/AUTH_FAILED|auth_error/.test(text), text };
}

describe("HEAL: a compare-and-set on the credential it verified (a rotate during the compare never locks the new token out)", () => {
  it("token-only path: T1 in the pre-PR-B bare form; rotated to T2 while T1's compare runs → T2 still authenticates, and its digest is intact", async () => {
    const t1 = reg("h1");
    makeBare("h1", t1);
    let t2 = "";
    const fired = duringNextCompare(() => {
      t2 = rotate("h1");
    });
    await db.resolveAgentByToken(t1);
    expect(fired(), "precondition: the rotate landed during T1's compare").toBe(true);
    expect(db.getAgentAuthData("h1")!.token_lookup, "T2's digest was overwritten by the heal of T1").toBe(computeTokenLookup(t2));
    authCacheClear();
    expect(await db.resolveAgentByToken(t2)).toEqual({ name: "h1", capabilities: [] });
  });

  it("explicit-caller path (through the dispatcher): the same race → T2 still authenticates", async () => {
    const t1 = reg("h2");
    makeBare("h2", t1);
    await withDaemon(async (port) => {
      let t2 = "";
      const fired = duringNextCompare(() => {
        t2 = rotate("h2");
      });
      await call(port, "get_messages", { agent_name: "h2" }, t1);
      expect(fired(), "precondition: the rotate landed during T1's compare").toBe(true);
      expect(db.getAgentAuthData("h2")!.token_lookup).toBe(computeTokenLookup(t2));
      const r = await call(port, "get_messages", { agent_name: "h2" }, t2);
      expect(r.ok, r.text.slice(0, 400)).toBe(true);
    });
  }, 30_000);

  it("control: with NO race, the heal still rewrites a bare digest to the current key's form (the CAS matches)", async () => {
    const t1 = reg("h3");
    makeBare("h3", t1);
    expect(await db.resolveAgentByToken(t1)).toEqual({ name: "h3", capabilities: [] });
    expect(db.getAgentAuthData("h3")!.token_lookup).toBe(computeTokenLookup(t1));
  });

  it("the heal does NOT bump the auth generation (it cannot change validity; a bump would only flush every cached verdict)", async () => {
    const t1 = reg("h4");
    makeBare("h4", t1);
    const before = db.getAuthGeneration();
    await db.resolveAgentByToken(t1);
    expect(db.getAgentAuthData("h4")!.token_lookup).toBe(computeTokenLookup(t1)); // healed
    expect(db.getAuthGeneration()).toBe(before);
  });
});

describe("CACHE: bound to the generation read BEFORE the verify (a revoke during the compare leaves no cached 'valid')", () => {
  it("explicit-caller path: revoked while its compare runs → refused on THAT call (the re-check) and on the NEXT one", async () => {
    const t1 = reg("c1");
    await withDaemon(async (port) => {
      const fired = duringNextCompare(() => db.revokeAgentToken("c1"));
      const first = await call(port, "get_messages", { agent_name: "c1" }, t1);
      expect(fired(), "precondition: the revoke landed during T1's compare").toBe(true);
      expect(first.ok, `the in-flight call was served with a revoked token: ${first.text.slice(0, 300)}`).toBe(false);
      const next = await call(port, "get_messages", { agent_name: "c1" }, t1);
      expect(next.ok, `a LATER call was served with a revoked token (a cached verdict): ${next.text.slice(0, 300)}`).toBe(false);
    });
  }, 30_000);

  it("token-only path: the same race → refused on that call and the next", async () => {
    const t1 = reg("c2");
    await withDaemon(async (port) => {
      const fired = duringNextCompare(() => db.revokeAgentToken("c2"));
      const first = await call(port, "discover_agents", {}, t1);
      expect(fired()).toBe(true);
      expect(first.ok, first.text.slice(0, 300)).toBe(false);
      expect((await call(port, "discover_agents", {}, t1)).ok).toBe(false);
    });
  }, 30_000);

  it("control: with NO race, a valid token is served, and its second call is a cache hit (zero compares)", async () => {
    const t1 = reg("c3");
    await withDaemon(async (port) => {
      expect((await call(port, "get_messages", { agent_name: "c3" }, t1)).ok).toBe(true);
      const before = bcryptCompareCount();
      expect((await call(port, "get_messages", { agent_name: "c3" }, t1)).ok).toBe(true);
      expect(bcryptCompareCount() - before).toBe(0);
    });
  }, 30_000);
});

describe("DASHBOARD send_message: authorized by an awaited from_agent_token verify, so it re-checks the generation", () => {
  afterEach(() => {
    delete process.env.RELAY_DASHBOARD_SECRET;
  });
  it("from-agent revoked while its token's compare runs → the send is REFUSED and nothing is stored; control: no race → sent", async () => {
    process.env.RELAY_DASHBOARD_SECRET = OPERATOR_SECRET;
    const t1 = reg("d1");
    reg("d-to");
    await withDaemon(async (port) => {
      const ok = await operatorPost(port, "/api/send-message", { from: "d1", to: "d-to", content: "control", from_agent_token: t1 });
      expect(ok.status, "control: an unraced send succeeds").toBe(200);
      const fired = duringNextCompare(() => db.revokeAgentToken("d1"));
      authCacheClear();
      const raced = await operatorPost(port, "/api/send-message", { from: "d1", to: "d-to", content: "raced", from_agent_token: t1 });
      expect(fired(), "precondition: the revoke landed during the from-token compare").toBe(true);
      expect(raced.status).not.toBe(200);
      const contents = (db.getDb().prepare("SELECT COUNT(*) AS c FROM messages WHERE from_agent = 'd1'").get() as { c: number }).c;
      expect(contents, "the raced message was stored").toBe(1);
    });
  }, 30_000);
});

// The ROTATION GRACE race (Codex R1 #2) moved to tests/pr-b-revalidate.test.ts: the window is decided at ONE site,
// revalidate at dispatch (architect b11ef8ad), not inside authenticateAgent; the matrix covers it at every await.
