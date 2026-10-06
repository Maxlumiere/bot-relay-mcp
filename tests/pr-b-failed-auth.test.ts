// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR-B: a failed auth can no longer freeze the relay (architect rulings e26359ac, 16343dc1, 7ab8ea86,
 * f7a6cf06, 8c8ef8ea, 64131354). MEASURED before this PR on a sandbox daemon with 51 agents: 20 wrong
 * tokens blocked /health for 1.3 s; 20 unknown tokens for 65 s (a sync bcrypt against EVERY row).
 *
 *   COUNT  : bcrypt compares are counted at the pool, so "zero" is asserted, not inferred.
 *   BARS   : a real HTTP daemon, /health sampled every ~10 ms during each burst: MAX < 50 ms.
 *   SHAPE  : known-provenance digests decide a wrong token with no bcrypt; unknown-provenance and
 *            digest-less rows are found and healed, and their failures are bounded (throttle + pool).
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { Server as HttpServer } from "http";
import { monitorEventLoopDelay } from "perf_hooks";
import { Worker } from "worker_threads";
import bcrypt from "bcryptjs";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr-b-")));
process.env.RELAY_DB_PATH = path.join(ROOT, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_ENCRYPTION_KEYRING;
delete process.env.RELAY_ENCRYPTION_KEYRING_PATH;
delete process.env.RELAY_ENCRYPTION_KEY;

const db = await import("../src/db.js");
const { lookupKeys, computeTokenLookup, _resetTokenLookupCacheForTests } = await import("../src/token-lookup.js");
const { bcryptCompareCount, compareOffLoop, MAX_PENDING } = await import("../src/bcrypt-pool.js");
const { _resetAuthThrottleForTests, THROTTLE_BURST, SCAN_BURST } = await import("../src/auth-throttle.js");
const { _resetAuthRejectionAuditForTests } = await import("../src/auth-rejection-audit.js");
const { authCacheClear } = await import("../src/auth-cache.js");
const { verifyCredential } = await import("../src/token-verify.js");
const { decryptContent } = await import("../src/encryption.js");

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function reset(): void {
  db.closeDb();
  fs.rmSync(path.join(ROOT, "relay.db"), { force: true });
  for (const f of ["relay.db-wal", "relay.db-shm", "token-lookup.key"]) fs.rmSync(path.join(ROOT, f), { force: true });
  delete process.env.RELAY_ENCRYPTION_KEYRING;
  _resetTokenLookupCacheForTests();
  _resetAuthThrottleForTests();
  _resetAuthRejectionAuditForTests();
  authCacheClear();
  db.getDb();
}
beforeEach(reset);

const reg = (name: string): string => db.registerAgent(name, "worker", []).plaintext_token!;
/** The compares a block of work requested from the pool. */
async function compares(work: () => Promise<unknown>): Promise<number> {
  const before = bcryptCompareCount();
  await work();
  return bcryptCompareCount() - before;
}
const randomToken = () => crypto.randomBytes(32).toString("base64url");

describe("the stored digest names its key (one-way)", () => {
  it("a register stores `<current key id>|<hex>`; the px fingerprint is an HMAC of a fixed label, never key material", () => {
    const tok = reg("fp");
    const [cur] = lookupKeys();
    expect(db.getAgentAuthData("fp")!.token_lookup).toBe(`${cur.id}|${crypto.createHmac("sha256", cur.key).update(tok).digest("hex")}`);
    expect(cur.id).toMatch(/^px:[0-9a-f]{16}$/);
    const fp = cur.id.slice(3);
    expect(fp).toBe(crypto.createHmac("sha256", cur.key).update("bot-relay/lookup-key-id/v1").digest("hex").slice(0, 16));
    const file = fs.readFileSync(path.join(ROOT, "token-lookup.key"));
    for (const material of [cur.key.toString("hex"), file.toString("hex"), cur.key.toString("base64"), file.toString("base64")]) {
      expect(material.includes(fp), "the fingerprint is a slice of key material").toBe(false);
    }
  });
});

describe("COUNT: failures never hash where a digest can decide", () => {
  it("an UNKNOWN token (no digest-less or unknown-provenance rows) costs ZERO bcrypt compares", async () => {
    for (let i = 0; i < 20; i++) reg(`c-${i}`);
    expect(await compares(async () => expect(await db.resolveAgentByToken(randomToken())).toBeNull())).toBe(0);
  });
  it("the fallback compares ONLY the credential the index cannot decide (a grace row: digest-less previous, indexed current)", async () => {
    db.registerAgent("grace", "worker", [], { managed: true }); // a MANAGED agent keeps its previous token through a grace window
    db.rotateAgentToken("grace", db.getAgentAuthData("grace")!.token_hash!, { graceSeconds: 3600 });
    db.getDb().prepare("UPDATE agents SET previous_token_lookup = NULL WHERE name = ?").run("grace");
    expect(db.getAgentAuthData("grace")!.previous_token_hash).toBeTruthy(); // precondition: a previous credential exists
    expect(await compares(async () => expect(await db.resolveAgentByToken(randomToken())).toBeNull())).toBe(1); // the previous one only
  });
  it("a WRONG token for a known-provenance agent costs ZERO compares; its RIGHT token exactly one", async () => {
    const tok = reg("known");
    const row = db.getAgentAuthData("known")!;
    const cred = { hash: row.token_hash, lookup: row.token_lookup };
    expect(await compares(async () => expect((await verifyCredential("known", cred, randomToken(), "t")).verdict).toBe("wrong"))).toBe(0);
    expect(await compares(async () => expect((await verifyCredential("known", cred, tok, "t")).verdict).toBe("ok"))).toBe(1);
  });
});

describe("no lockout: rows the index cannot decide are still found, then healed", () => {
  it("a PRE-UPGRADE unprefixed row + its VALID token, via a token-only call: authenticated AND healed to `<current key>|hex`", async () => {
    const tok = reg("legacy-hex");
    const bare = computeTokenLookup(tok).split("|")[1]; // what a pre-PR-B daemon wrote
    db.getDb().prepare("UPDATE agents SET token_lookup = ? WHERE name = ?").run(bare, "legacy-hex");
    // Found through the INDEX (its bare form under a derivable key), not the bcrypt fallback.
    const found = await db.findAgentRowByToken(tok);
    expect(found && "row" in found ? found.fromLocator : null).toBe(true);
    expect(await db.resolveAgentByToken(tok)).toEqual({ name: "legacy-hex", capabilities: [] });
    expect(db.getAgentAuthData("legacy-hex")!.token_lookup).toBe(computeTokenLookup(tok));
  });
  it("variant: the ORIGINAL KEY REMOVED from the keyring: the valid token still authenticates (bounded fallback) and heals under the new key", async () => {
    const k = () => crypto.randomBytes(32).toString("base64");
    const [ka, kb] = [k(), k()];
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "a", keys: { a: ka } });
    _resetTokenLookupCacheForTests();
    const tok = reg("rotated");
    expect(db.getAgentAuthData("rotated")!.token_lookup!.startsWith("kr:a|")).toBe(true);
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "b", keys: { b: kb } }); // key "a" is gone
    _resetTokenLookupCacheForTests();
    authCacheClear();
    expect(await db.resolveAgentByToken(tok)).toEqual({ name: "rotated", capabilities: [] });
    expect(db.getAgentAuthData("rotated")!.token_lookup!.startsWith("kr:b|")).toBe(true);
    delete process.env.RELAY_ENCRYPTION_KEYRING;
  });
  it("an UNPREFIXED digest under a LOST key (no derivable key reproduces it): the valid token still authenticates via the fallback, and heals", async () => {
    const tok = reg("lost-key");
    db.getDb().prepare("UPDATE agents SET token_lookup = ? WHERE name = ?").run("ab".repeat(32), "lost-key");
    const found = await db.findAgentRowByToken(tok);
    expect(found && "row" in found ? [found.row.name, found.fromLocator] : found).toEqual(["lost-key", false]);
    expect(await db.resolveAgentByToken(tok)).toEqual({ name: "lost-key", capabilities: [] });
    expect(db.getAgentAuthData("lost-key")!.token_lookup).toBe(computeTokenLookup(tok));
  });
  it("a digest-less row: its valid token authenticates (bounded fallback) and heals", async () => {
    const tok = reg("nodigest");
    db.getDb().prepare("UPDATE agents SET token_lookup = NULL WHERE name = ?").run("nodigest");
    expect(await db.resolveAgentByToken(tok)).toEqual({ name: "nodigest", capabilities: [] });
    expect(db.getAgentAuthData("nodigest")!.token_lookup).toBe(computeTokenLookup(tok));
  });
});

describe("BOUNDED: where bcrypt must decide, failures are throttled per (source, name) and the pool refuses overflow", () => {
  it("wrong tokens against an unknown-provenance row cost at most THROTTLE_BURST compares, then refuse WITHOUT one", async () => {
    reg("unk");
    db.getDb().prepare("UPDATE agents SET token_lookup = 'deadbeef' WHERE name = ?").run("unk"); // unknown provenance
    const row = db.getAgentAuthData("unk")!;
    const verdicts: string[] = [];
    const n = await compares(async () => {
      for (let i = 0; i < THROTTLE_BURST + 5; i++) verdicts.push((await verifyCredential("unk", { hash: row.token_hash, lookup: row.token_lookup }, randomToken(), "src-1")).verdict);
    });
    expect(n).toBe(THROTTLE_BURST);
    expect(verdicts.filter((v) => v === "throttled")).toHaveLength(5);
    // keyed by (source, name): another name from the same source is unaffected
    reg("unk2");
    db.getDb().prepare("UPDATE agents SET token_lookup = 'deadbeef' WHERE name = ?").run("unk2");
    const r2 = db.getAgentAuthData("unk2")!;
    expect((await verifyCredential("unk2", { hash: r2.token_hash, lookup: r2.token_lookup }, randomToken(), "src-1")).verdict).toBe("wrong");
  });
  it("the token-only FALLBACK is charged ONCE per request to the SOURCE's scan budget, never to the scanned rows' per-name buckets", async () => {
    const legacy: string[] = [];
    for (let i = 0; i < 4; i++) {
      legacy.push(reg(`legacy-${i}`));
      db.getDb().prepare("UPDATE agents SET token_lookup = NULL WHERE name = ?").run(`legacy-${i}`);
    }
    const results: unknown[] = [];
    const n = await compares(async () => {
      for (let i = 0; i < SCAN_BURST + 3; i++) results.push(await db.findAgentRowByToken(randomToken(), "src-A"));
    });
    expect(n, "each budgeted scan compares the 4 digest-less rows once; refused scans compare nothing").toBe(SCAN_BURST * 4);
    expect(results.slice(0, SCAN_BURST)).toEqual(Array(SCAN_BURST).fill(null));
    expect(results.slice(SCAN_BURST)).toEqual(Array(3).fill({ refused: "throttled" }));
    // The rows' own buckets were NOT spent: a name-addressed wrong token for legacy-0 from the SAME source
    // is still compared (a full burst), not throttled.
    const row = db.getAgentAuthData("legacy-0")!;
    const named: string[] = [];
    for (let i = 0; i < THROTTLE_BURST; i++) named.push((await verifyCredential("legacy-0", { hash: row.token_hash, lookup: null }, randomToken(), "src-A")).verdict);
    expect(named).toEqual(Array(THROTTLE_BURST).fill("wrong"));
    // Per SOURCE: another source's valid token-only call still scans, authenticates, and heals.
    const found = await db.findAgentRowByToken(legacy[3], "src-B");
    expect(found && "row" in found ? found.row.name : found).toBe("legacy-3");
  });
  it("a scan that AUTHENTICATES gives its unit back (only a failed scan spends)", async () => {
    const tok = reg("legacy-ok");
    db.getDb().prepare("UPDATE agents SET token_lookup = NULL WHERE name = ?").run("legacy-ok");
    for (let i = 0; i < SCAN_BURST + 2; i++) {
      const found = await db.findAgentRowByToken(tok, "src-C");
      expect(found && "row" in found ? found.row.name : found, `scan ${i + 1}`).toBe("legacy-ok");
    }
  });
  it("the pool refuses overflow AT ONCE (busy), never queues past MAX_PENDING", async () => {
    const hash = db.getAgentAuthData((reg("p"), "p"))!.token_hash!;
    const all = Array.from({ length: MAX_PENDING + 4 }, () => compareOffLoop("x", hash).then(() => "done", (e: Error) => e.name));
    const out = await Promise.all(all);
    expect(out.filter((o) => o === "BcryptBusyError")).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------------------------------
// A real daemon: the bars, and the bounded audit, through the HTTP dispatcher.
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
const rpc = (port: number, tool: string, args: Record<string, unknown>, token?: string) =>
  fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { "X-Agent-Token": token } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  }).then((r) => r.text());

/**
 * The LOAD runs in a WORKER THREAD, never on the daemon's loop: the daemon here is in-process, and 30 fetch
 * clients plus the /health sampler on the SAME loop would charge their own work to the daemon (MEASURED:
 * with an in-process client, a 30-call burst alone raised the loop delay to 9-40 ms). In production the
 * clients are other processes; the worker gives the daemon's loop only the daemon's work.
 * `kind`: "auth" calls `tool` with a RANDOM token each; "control" calls register_agent with no name and no
 * token (see controlLoad).
 */
const LOAD_WORKER = `
const { parentPort, workerData } = require("worker_threads");
const { port, n, kind, tool, args } = workerData;
const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
const call = () => fetch("http://127.0.0.1:" + port + "/mcp", {
  method: "POST",
  headers: Object.assign({ "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, kind === "auth" ? { "X-Agent-Token": hex() } : {}),
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: kind === "auth" ? { name: tool, arguments: args } : { name: "register_agent", arguments: {} } }),
}).then(async (r) => (await r.text(), r.status));
(async () => {
  let healthMax = 0, done = false;
  const sampler = (async () => {
    while (!done) {
      const t = performance.now();
      await fetch("http://127.0.0.1:" + port + "/health").then((r) => r.text());
      healthMax = Math.max(healthMax, performance.now() - t);
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  await new Promise((r) => setTimeout(r, 50));
  parentPort.postMessage({ started: true });
  const statuses = n > 0 ? await Promise.all(Array.from({ length: n }, call)) : (await new Promise((r) => setTimeout(r, 300)), []);
  done = true;
  await sampler;
  parentPort.postMessage({ healthMax, statuses });
})();
`;

interface Load {
  kind: "auth" | "control" | "idle";
  n: number;
  tool?: string;
  args?: Record<string, unknown>;
}
/**
 * The KNOWN-GOOD CONTROL (architect 10f7a172): the same N, the same transport and concurrency, admitted past
 * the per-IP cap the same way, and refused AFTER the full stateless MCP cycle (createServer + transport +
 * dispatcher) by the handler's own validation: register_agent with no name and no token does no auth work
 * at all (enforceAuth returns early; RegisterAgentSchema.parse throws in the handler).
 */
const controlLoad = (n: number): Load => ({ kind: "control", n });
const authLoad = (n: number, tool: string, args: Record<string, unknown>): Load => ({ kind: "auth", n, tool, args });

interface Reading {
  /** Max /health latency (ms), sampled every ~10 ms from the worker while the load runs: AVAILABILITY. */
  healthMax: number;
  /** Max delay (ms) of the DAEMON's event loop while the load runs: LOOP blocking (a bcrypt on it is ~64 ms). */
  eldMax: number;
  /** How many of the load's calls the per-IP cap shed (429) before the MCP cycle. */
  shed: number;
}

/** Run `load` from a worker while timing the daemon's loop; `onLoop` runs ON the daemon's loop once the load has started. */
async function measure(port: number, load: Load, onLoop?: () => void): Promise<Reading> {
  const eld = monitorEventLoopDelay({ resolution: 1 });
  const worker = new Worker(LOAD_WORKER, { eval: true, workerData: { port, n: load.kind === "idle" ? 0 : load.n, kind: load.kind, tool: load.tool, args: load.args } });
  try {
    return await new Promise<Reading>((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", (m: { started?: true; healthMax?: number; statuses?: number[] }) => {
        if (m.started) {
          eld.enable();
          if (onLoop) setTimeout(onLoop, 5);
          return;
        }
        eld.disable();
        resolve({ healthMax: m.healthMax!, eldMax: eld.max / 1e6, shed: m.statuses!.filter((s) => s === 429).length });
      });
    });
  } finally {
    await worker.terminate();
  }
}

const LOOP_MAX_MS = 50;
const AVAILABILITY_MARGIN_MS = 25;
const AVAILABILITY_CEILING_MS = 500;
const fmt = (r: Reading) => `health=${r.healthMax.toFixed(1)} eld=${r.eldMax.toFixed(1)} shed=${r.shed}`;

/**
 * THE BAR (e26359ac Q3 as amended by architect 10f7a172). ONE run, no retries (a best-of-N hides a real
 * 1-in-N failure; the same-run control replaces it):
 *   - COUNT: the burst's bcrypt compares stay within `maxCompares` (ZERO where a digest decides). The primary
 *     discriminator, deterministic.
 *   - LOOP: event-loop delay max < 50 ms. Discriminates on any runner: see the NEGATIVE CONTROL test.
 *   - AVAILABILITY: /health max <= the larger of the control bursts run before and after + 25 ms, and < 500 ms
 *     absolute (a real freeze). Runner speed and drift cancel; an auth-specific slowdown does not.
 * Every reading is logged (BAR line) so the CI numbers can be reported.
 */
async function barHolds(label: string, port: number, load: Load, maxCompares = 0): Promise<void> {
  _resetAuthThrottleForTests();
  await measure(port, controlLoad(load.n)); // WARM-UP, discarded: the first burst on a fresh daemon pays one-off costs (MEASURED 25-45 ms vs ~2 ms after), which would inflate the control and bias the bar toward PASS
  const baseline = await measure(port, { kind: "idle", n: 0 });
  const before = await measure(port, controlLoad(load.n));
  let auth!: Reading;
  const count = await compares(async () => {
    auth = await measure(port, load);
  });
  const after = await measure(port, controlLoad(load.n));
  const controlMax = Math.max(before.healthMax, after.healthMax);
  console.log(`BAR ${label} | auth ${fmt(auth)} compares=${count} | control-before ${fmt(before)} | control-after ${fmt(after)} | idle eld=${baseline.eldMax.toFixed(1)}`);
  // NOT VACUOUS: every call of the auth burst reached auth, and both controls were admitted the same way. A
  // shed call is a cheap 429 before the MCP cycle (MEASURED: once the per-minute limit ran out, a whole auth
  // burst was shed and its bar passed on nothing).
  expect([auth.shed, before.shed, after.shed], `${label}: calls shed by the per-IP limits (auth, control before, control after)`).toEqual([0, 0, 0]);
  expect(count, `${label}: bcrypt compares`).toBeLessThanOrEqual(maxCompares);
  expect(auth.eldMax, `${label}: event-loop delay max (ms)`).toBeLessThan(LOOP_MAX_MS);
  expect(auth.healthMax, `${label}: /health max (ms) vs the same-run control (${controlMax.toFixed(1)} ms) + ${AVAILABILITY_MARGIN_MS}`).toBeLessThanOrEqual(controlMax + AVAILABILITY_MARGIN_MS);
  expect(auth.healthMax, `${label}: /health max (ms), absolute ceiling`).toBeLessThan(AVAILABILITY_CEILING_MS);
}

describe("BARS: a burst of failed auths keeps the loop under 50 ms and /health within its same-run control, with ZERO compares where a digest decides", () => {
  // The per-minute request limit is not under test here, and each bar sends ~4 bursts: lift it so no burst is
  // shed by it (read when the daemon starts). The concurrent cap stays at its default: the bars run under it.
  const savedRate = process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE;
  beforeAll(() => {
    process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE = "100000";
  });
  afterAll(() => {
    if (savedRate === undefined) delete process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE;
    else process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE = savedRate;
  });
  it("(b) 20 wrong-token register_agent, (c) 20 wrong-token get_messages, (d) 20 unknown tokens with 51 agents", async () => {
    for (let i = 0; i < 50; i++) reg(`fleet-${i}`);
    reg("victim");
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`); // warm
      await barHolds("(b) wrong token, register_agent", port, authLoad(20, "register_agent", { name: "victim", role: "worker", capabilities: [] }));
      await barHolds("(c) wrong token, get_messages", port, authLoad(20, "get_messages", { agent_name: "victim" }));
      await barHolds("(d) unknown token, token-only", port, authLoad(20, "discover_agents", {}));
    });
  }, 60_000);

  it("unknown-provenance rows: wrong tokens are BOUNDED (the source's scan budget) and the loop stays under 50 ms (bcrypt off the loop)", async () => {
    for (let i = 0; i < 4; i++) {
      reg(`legacy-${i}`);
      db.getDb().prepare("UPDATE agents SET token_lookup = NULL WHERE name = ?").run(`legacy-${i}`);
    }
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`);
      // compares are BOUNDED by the source's SCAN budget: at most SCAN_BURST scans of the 4 digest-less rows.
      await barHolds("unknown-provenance, token-only", port, authLoad(30, "discover_agents", {}), 4 * SCAN_BURST);
    });
  }, 60_000);

  it("NEGATIVE CONTROL: the same burst plus ONE bcrypt compare ON the loop trips BOTH bars, LOOP and AVAILABILITY (each instrument discriminates on this runner)", async () => {
    reg("victim2");
    const hash = db.getAgentAuthData("victim2")!.token_hash!;
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`);
      await measure(port, controlLoad(20)); // the same warm-up as every bar
      const control = await measure(port, controlLoad(20));
      // the regression PR-B removed: one bcrypt compare on the daemon's event loop, during the same burst
      const r = await measure(port, authLoad(20, "discover_agents", {}), () => void bcrypt.compareSync(randomToken(), hash));
      console.log(`BAR negative-control | ${fmt(r)} | control ${fmt(control)}`);
      expect([r.shed, control.shed], "the negative control's bursts reached the daemon").toEqual([0, 0]);
      // BOTH bars must see it, each by its own instrument: the same assertions barHolds makes, inverted.
      expect(r.eldMax, "one on-loop bcrypt compare must exceed the LOOP bar, or the bar cannot see the harm").toBeGreaterThanOrEqual(LOOP_MAX_MS);
      expect(r.healthMax, "one on-loop bcrypt compare must exceed the AVAILABILITY bar (control + margin)").toBeGreaterThan(control.healthMax + AVAILABILITY_MARGIN_MS);
    });
  }, 60_000);
});

describe("Q4: rejections are audited BOUNDED, one row per (source, reason, window) with a count", () => {
  it("50 unknown-token calls from one source → ONE auth_rejection row, count 50, agent_name NULL", async () => {
    reg("someone");
    await withDaemon(async (port) => {
      for (let i = 0; i < 50; i++) await rpc(port, "discover_agents", {}, randomToken());
    });
    const rows = db.getDb().prepare("SELECT agent_name, error, params_json FROM audit_log WHERE tool = 'auth_rejection'").all() as Array<{ agent_name: string | null; error: string; params_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_name).toBeNull();
    expect(rows[0].error).toBe("unknown_token");
    expect(JSON.parse(decryptContent(rows[0].params_json)!).count).toBe(50);
    expect(db.getDb().prepare("SELECT COUNT(*) AS c FROM audit_log WHERE tool = 'discover_agents' AND success = 0").get()).toEqual({ c: 0 }); // never per request
  }, 60_000);
});
