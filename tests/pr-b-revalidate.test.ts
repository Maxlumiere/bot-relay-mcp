// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR-B (Codex R2 on #308; architect b11ef8ad / cbc2e1c5 / ea8db5d9): authority is decided at ONE site. Every
 * allowed call carries its verdict's evidence, and the dispatcher's revalidate re-derives it synchronously after
 * the LAST await. THE RACE MATRIX, through the real HTTP dispatcher: at EACH await point of BOTH auth paths, a
 * mutation lands while the compare is outstanding (rotate, revoke, recovery, or the CLOCK passing a grace window);
 * the call must be refused (or re-verified against the new state), NEVER served on the stale verdict. Each cell's
 * twin, with no mutation, is served. (In-process; the cross-process residual is ADR-0050, see SECURITY.md.)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Server as HttpServer } from "http";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr-b-reval-")));
process.env.RELAY_DB_PATH = path.join(ROOT, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_ENCRYPTION_KEYRING;
delete process.env.RELAY_ENCRYPTION_KEY;

const db = await import("../src/db.js");
const { _onNextCompareForTests } = await import("../src/bcrypt-pool.js");
const { _resetAuthThrottleForTests } = await import("../src/auth-throttle.js");
const { authCacheClear } = await import("../src/auth-cache.js");
const { _resetTokenLookupCacheForTests } = await import("../src/token-lookup.js");

let server: HttpServer;
let port = 0;
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
beforeEach(async () => {
  db.closeDb();
  for (const f of ["relay.db", "relay.db-wal", "relay.db-shm", "token-lookup.key"]) fs.rmSync(path.join(ROOT, f), { force: true });
  _resetTokenLookupCacheForTests();
  _resetAuthThrottleForTests();
  authCacheClear();
  _onNextCompareForTests(null);
  db.getDb();
  const { startHttpServer } = await import("../src/transport/http.js");
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 60));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  _onNextCompareForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
});

async function call(tool: string, args: Record<string, unknown>, token: string): Promise<{ isError: boolean; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Agent-Token": token },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const text = await r.text();
  const json = JSON.parse(text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text);
  return { isError: json.result?.isError === true, body: JSON.parse(json.result.content[0].text) };
}

/** Land `mutation` at the N-th compare of the next call (1 = the first await point, 2 = the second). */
function atCompare(n: number, mutation: () => void): () => boolean {
  let fired = false;
  const arm = (left: number) =>
    _onNextCompareForTests(() => {
      if (left > 1) return arm(left - 1);
      fired = true;
      mutation();
    });
  arm(n);
  return () => fired;
}

type Mutation = "rotate" | "revoke" | "recovery" | "grace-expiry";
interface Fixture {
  name: string;
  token: string;
}
/** An ACTIVE agent (its current token), or one in ROTATION GRACE presenting its PREVIOUS or CURRENT token. */
function activeAgent(name: string): Fixture {
  return { name, token: db.registerAgent(name, "worker", []).plaintext_token! };
}
function graceAgent(name: string, present: "previous" | "current"): Fixture {
  const t1 = db.registerAgent(name, "worker", [], { managed: true }).plaintext_token!;
  const out = db.rotateAgentToken(name, db.getAgentAuthData(name)!.token_hash!, { graceSeconds: 60 });
  expect(db.getAgentAuthData(name)!.auth_state).toBe("rotation_grace");
  return { name, token: present === "previous" ? t1 : out.newPlaintextToken };
}
/**
 * The cache-put's verify (the explicit path's later await point) runs only when the digests cannot tell the
 * current token from the previous one: a rotation_grace row whose CURRENT digest is unknown (NULL, a pre-PR-B row).
 */
function graceAgentNullCurrentDigest(name: string, present: "previous" | "current"): Fixture {
  const f = graceAgent(name, present);
  db.getDb().prepare("UPDATE agents SET token_lookup = NULL WHERE name = ?").run(name);
  return f;
}
function mutate(m: Mutation, name: string, realNow: () => number): void {
  const row = db.getAgentAuthData(name)!;
  if (m === "rotate") db.rotateAgentToken(name, row.token_hash!, { graceSeconds: 0 }); // a hard cut: the old token is dead
  if (m === "revoke") db.revokeAgentToken(name, { issueRecovery: false });
  if (m === "recovery") db.revokeAgentToken(name, { issueRecovery: true });
  if (m === "grace-expiry") {
    const expiry = new Date(row.rotation_grace_expires_at!).getTime();
    Date.now = () => Math.max(realNow(), expiry + 1); // the CLOCK passes the window; no row changes
  }
}

/**
 * The cells. explicit = get_messages naming the agent (authenticateAgent's compare is await point 1; for a
 * rotation_grace row the cache-put's verify is await point 2). token-only = discover_agents (findAgentRowByToken's
 * compare is await point 1).
 */
const PATHS = {
  explicit: (f: Fixture) => call("get_messages", { agent_name: f.name }, f.token),
  "token-only": (f: Fixture) => call("discover_agents", {}, f.token),
} as const;
const CELLS: Array<{ path: keyof typeof PATHS; at: number; m: Mutation; fixture: (n: string) => Fixture; na?: string }> = [];
for (const p of ["explicit", "token-only"] as const) {
  for (const m of ["rotate", "revoke", "recovery"] as const) CELLS.push({ path: p, at: 1, m, fixture: activeAgent });
  CELLS.push({ path: p, at: 1, m: "grace-expiry", fixture: (n) => graceAgent(n, "previous") });
}
// The explicit path's LATER await point: the cache-put's verify, which runs only for a rotation_grace row whose
// current digest is unknown. Presenting the CURRENT token, it is compare 2 (authenticate: current ok; cache-put).
// Presenting the PREVIOUS token, it is compare 3 (authenticate: current wrong, previous ok; then the cache-put).
for (const m of ["revoke", "recovery"] as const) CELLS.push({ path: "explicit", at: 2, m, fixture: (n) => graceAgentNullCurrentDigest(n, "current") });
CELLS.push({ path: "explicit", at: 3, m: "grace-expiry", fixture: (n) => graceAgentNullCurrentDigest(n, "previous") });
CELLS.push({ path: "explicit", at: 2, m: "rotate", fixture: (n) => graceAgentNullCurrentDigest(n, "current"), na: "a rotation needs an ACTIVE row; this await point exists only for a rotation_grace row" });

describe("the race matrix: never served on a stale verdict (each await point x each mutation, both auth paths)", () => {
  let seq = 0;
  for (const c of CELLS) {
    const label = `${c.path} @ await ${c.at} x ${c.m}`;
    if (c.na) {
      it.skip(`${label}: N/A (${c.na})`, () => {});
      continue;
    }
    it(`${label} → refused, never served`, async () => {
      const f = c.fixture(`agent-${seq++}`);
      const realNow = Date.now;
      const fired = atCompare(c.at, () => mutate(c.m, f.name, realNow));
      try {
        const r = await PATHS[c.path](f);
        expect(fired(), "the mutation landed during the compare").toBe(true);
        expect(r.isError, `served on a stale verdict: ${JSON.stringify(r.body)}`).toBe(true);
      } finally {
        Date.now = realNow;
      }
    });
    it(`${label} TWIN (no mutation) → served`, async () => {
      const f = c.fixture(`twin-${seq++}`);
      const r = await PATHS[c.path](f);
      expect(r.isError, JSON.stringify(r.body)).toBe(false);
    });
  }
});

describe("a CACHED verdict goes through revalidate too (a cache is never the last word)", () => {
  it("explicit path: a cached previous-credential verdict is refused once the clock passes the grace window", async () => {
    const f = graceAgent("cached-grace", "previous");
    expect((await call("get_messages", { agent_name: f.name }, f.token)).isError).toBe(false); // verifies + caches
    expect((await call("get_messages", { agent_name: f.name }, f.token)).isError).toBe(false); // cache hit, still inside
    const realNow = Date.now;
    const expiry = new Date(db.getAgentAuthData(f.name)!.rotation_grace_expires_at!).getTime();
    Date.now = () => expiry + 1;
    try {
      expect((await call("get_messages", { agent_name: f.name }, f.token)).isError).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });
});
