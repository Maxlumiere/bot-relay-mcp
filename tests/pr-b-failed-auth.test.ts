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
  const stop = new Promise((r) => parentPort.once("message", r));
  parentPort.postMessage({ started: true });
  const statuses = n > 0 ? await Promise.all(Array.from({ length: n }, call)) : (await new Promise((r) => setTimeout(r, 300)), []);
  // The window stays open (and /health keeps being sampled) until the parent says stop: a POOL-LOADED control's
  // window must span its pool work, not just its requests.
  parentPort.postMessage({ loaded: true, statuses });
  await stop;
  done = true;
  await sampler;
  parentPort.postMessage({ healthMax });
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
  /** A POOL-LOADED control only: its pool work INSIDE the measured window (see measure). */
  pool?: PoolOccupancy;
}

/** How much of a pool-loaded control's window its pool work actually occupied. */
interface PoolOccupancy {
  /** Compares that started and finished inside the window. */
  inWindow: number;
  /** Compares that had FINISHED when the reading was taken (inside the window or not). */
  total: number;
  /** Fraction of the window with at least one control compare in flight. */
  busy: number;
}

/**
 * The control's pool work, instrumented: `track` wraps each compare, so measure() knows when the pool was busy.
 * MEASURED on main (294fdfc, local M2): the control's window was 35-63 ms while its 12 compares finished 390-457 ms
 * after it opened; with the old window this occupancy check reads "0/0 in-window, busy 0.00" in every round. The
 * "pool-loaded" control measured an unloaded loop. The auth arm's compares run inside its requests, so its
 * window spans them; on a noisy 3-core runner the longer window alone catches more delay, which inflated the gap
 * (CI 26803c9: control per-round eld 11.5/57.7/6.7/54.8/185.2, BIMODAL by whether the pool overlapped).
 */
type PoolWork = (track: <T>(p: () => Promise<T>) => Promise<T>) => Promise<unknown>;

/**
 * Run `load` from a worker while timing the daemon's loop; `onLoop` runs ON the daemon's loop once the load has
 * started; `poolWork` (the POOL-LOADED control) starts at the same moment and is finished before this returns.
 */
async function measure(port: number, load: Load, onLoop?: () => void, poolWork?: PoolWork): Promise<Reading> {
  let pool: Promise<unknown> = Promise.resolve();
  const spans: Array<[number, number]> = [];
  let t0 = 0;
  const track = async <T,>(p: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await p();
    } finally {
      spans.push([start, performance.now()]);
    }
  };
  const eld = monitorEventLoopDelay({ resolution: 1 });
  const worker = new Worker(LOAD_WORKER, { eval: true, workerData: { port, n: load.kind === "idle" ? 0 : load.n, kind: load.kind, tool: load.tool, args: load.args } });
  try {
    return await new Promise<Reading>((resolve, reject) => {
      let statuses: number[] = [];
      let t1 = 0;
      worker.on("error", reject);
      worker.on("message", (m: { started?: true; loaded?: true; healthMax?: number; statuses?: number[] }) => {
        if (m.started) {
          t0 = performance.now();
          eld.enable();
          if (onLoop) setTimeout(onLoop, 5);
          if (poolWork) pool = poolWork(track);
          return;
        }
        if (m.loaded) {
          statuses = m.statuses!;
          // The window closes when the requests AND the control's pool work are done (the pool, not the requests,
          // is the longer one), so the control is loaded for its whole window, like the auth arm.
          pool.then(
            () => {
              t1 = performance.now();
              eld.disable();
              worker.postMessage("stop");
            },
            reject,
          );
          return;
        }
        const reading: Reading = { healthMax: m.healthMax!, eldMax: eld.max / 1e6, shed: statuses.filter((s) => s === 429).length };
        if (poolWork) reading.pool = occupancy(spans, t0, t1);
        resolve(reading);
      });
    });
  } finally {
    await worker.terminate();
    await pool.catch(() => undefined);
  }
}

/** The pool's occupancy of the window [t0, t1]: compares inside it, and the fraction with one in flight. */
function occupancy(spans: Array<[number, number]>, t0: number, t1: number): PoolOccupancy {
  const inWindow = spans.filter(([a, b]) => a >= t0 && b <= t1).length;
  const clipped = spans.map(([a, b]) => [Math.max(a, t0), Math.min(b, t1)] as [number, number]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let busyMs = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of clipped) {
    if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
    else {
      if (cur) busyMs += cur[1] - cur[0];
      cur = [a, b];
    }
  }
  if (cur) busyMs += cur[1] - cur[0];
  return { inWindow, total: spans.length, busy: t1 > t0 ? busyMs / (t1 - t0) : 0 };
}

/**
 * THE TIMING BARS (e26359ac Q3 as amended by architect 10f7a172, 47e64b3a, 8cdbc68b and f9916d46).
 *
 * WHAT THEY CAN AND CANNOT SEE. On a shared CI runner, a burst of requests that does NO auth work already
 * moves the loop delay 30-86 ms and /health 40-165 ms (MEASURED, CI fef36b4). So the timing bars RESOLVE an
 * auth-specific slowdown of about MARGIN_MS over the same run's control, and no less: they CANNOT promise
 * to see ONE on-loop bcrypt (~64-100 ms). That property is carried by the deterministic checks: COUNT (zero
 * instrumented compares where a digest decides) and the static ban on compares outside the pool
 * (tests/pr-b-auth-invariants.test.ts). The timing bars catch a loop block or an availability loss LARGER
 * than their stated resolution, which every BAR line logs.
 *
 * THE INSTRUMENT, calibrated on the gating runner in EVERY run:
 *   - ISOLATED: the bars run as their own serial CI step after the suite (RELAY_TIMING_BARS=1), never in
 *     parallel with ~300 other files; the parallel suite skips them, visibly.
 *   - K interleaved (control, auth) rounds; each bar asserts on MEDIANS: loop delay and /health of the auth
 *     arm <= the control arm's median + MARGIN_MS. A deterministic regression shifts the median; a one-off
 *     spike does not (NOT best-of-N: nothing is retried).
 *   - A HARD ceiling on EVERY single auth reading (CEILING_MS), so a freeze-sized one-off fails on ONE
 *     occurrence. Named residual, accepted (f9916d46): an intermittent auth-specific spike under the ceiling
 *     in 1 of K rounds or fewer.
 *   - A/A CONTROL: control vs control under the same rule MUST PASS (the margin is above the runner's noise).
 *     If it fails, that is an INSTRUMENT fault, reported as such, never a retry.
 *   - NEGATIVE CONTROL: a loop block sized 2 x the allowance in EVERY auth round MUST FAIL both predicates
 *     (the bar sees a block of the forbidden size).
 * MARGIN_MS is provisional until the isolated step's A/A gaps are in (f9916d46: >= ~15 ms goes back to the
 * architect before anything widens).
 */
const K = 5;
const MARGIN_MS = 25;
const CEILING_MS = 500;
/**
 * A pool-loaded control round is VALID only when its pool work ran inside its window: every design compare in it,
 * and a compare in flight for at least this fraction of it. Otherwise the control was not loaded, and the round is
 * an INSTRUMENT FAULT (never a bar verdict). MEASURED with the window spanning the pool: see the BAR line's
 * "control pool busy" values; a forced 300 ms idle in the middle of the pool work drops it well below (the
 * unknown-provenance test's lapse demo).
 */
const OCCUPANCY_FLOOR = 0.8;
const fmt = (r: Reading) => `health=${r.healthMax.toFixed(1)} eld=${r.eldMax.toFixed(1)} shed=${r.shed}`;
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const list = (xs: number[]) => xs.map((x) => x.toFixed(1)).join("/");

interface BarStats {
  label: string;
  control: Reading[];
  auth: Reading[];
  compares: number;
  /** The auth arm's compares in each round. */
  perRound: number[];
  med: { ctlHealth: number; ctlEld: number; authHealth: number; authEld: number };
}

/**
 * Run one bar: a discarded warm-up, then K interleaved (control, auth) rounds. Logs a BAR line with the resolution.
 * `poolControl` (architect b72c3ac4): the control arm also runs the pool work the design INTENDS for this load,
 * a DESIGN CONSTANT in production's shape, so the bar compares the auth PATH against the bcrypt work itself.
 */
async function runBar(label: string, port: number, load: Load, opts: { onLoop?: () => void; poolControl?: PoolWork } = {}): Promise<BarStats> {
  _resetAuthThrottleForTests();
  await measure(port, controlLoad(load.n), undefined, opts.poolControl); // WARM-UP, discarded: a fresh daemon's first burst pays one-off costs
  const control: Reading[] = [];
  const auth: Reading[] = [];
  const perRound: number[] = [];
  for (let k = 0; k < K; k++) {
    control.push(await measure(port, controlLoad(load.n), undefined, opts.poolControl));
    _resetAuthThrottleForTests(); // every auth round meets the same budgets (the scan budget refills slowly)
    perRound.push(
      await compares(async () => {
        auth.push(await measure(port, load, opts.onLoop));
      }),
    );
  }
  const count = perRound.reduce((a, b) => a + b, 0);
  const med = {
    ctlHealth: median(control.map((r) => r.healthMax)),
    ctlEld: median(control.map((r) => r.eldMax)),
    authHealth: median(auth.map((r) => r.healthMax)),
    authEld: median(auth.map((r) => r.eldMax)),
  };
  console.log(
    `BAR ${label} | median auth health=${med.authHealth.toFixed(1)} eld=${med.authEld.toFixed(1)} | median control health=${med.ctlHealth.toFixed(1)} eld=${med.ctlEld.toFixed(1)}` +
      ` | gap health=${(med.authHealth - med.ctlHealth).toFixed(1)} eld=${(med.authEld - med.ctlEld).toFixed(1)}` +
      ` | resolution health>${(med.ctlHealth + MARGIN_MS).toFixed(1)} eld>${(med.ctlEld + MARGIN_MS).toFixed(1)}` +
      ` | compares=${count} (per round ${perRound.join("/")})${opts.poolControl ? " | control: POOL-LOADED" : ""} | rounds auth health ${list(auth.map((r) => r.healthMax))} eld ${list(auth.map((r) => r.eldMax))}` +
      ` | rounds control health ${list(control.map((r) => r.healthMax))} eld ${list(control.map((r) => r.eldMax))}` +
      (opts.poolControl ? ` | control pool in-window ${control.map((r) => `${r.pool!.inWindow}/${r.pool!.total}`).join(" ")} busy ${control.map((r) => r.pool!.busy.toFixed(2)).join("/")}` : ""),
  );
  return { label, control, auth, compares: count, perRound, med };
}

/** Every pool-loaded control round ran its design compares INSIDE its window, busy for >= OCCUPANCY_FLOOR of it. */
function expectControlLoaded(b: BarStats, designCompares: number): void {
  const pools = b.control.map((r) => r.pool);
  if (pools.some((p) => p === undefined)) return; // not a pool-loaded bar
  const fault = (what: string) => `INSTRUMENT FAULT (${b.label}): the pool-loaded control ${what}; this round measured an unloaded loop, so no bar verdict is possible`;
  expect(pools.map((p) => p!.inWindow), fault(`ran compares outside its window (design: ${designCompares} per round, all inside)`)).toEqual(Array(K).fill(designCompares));
  for (const p of pools) expect(p!.busy, fault(`left its pool idle for part of its window (busy ${p!.busy.toFixed(2)} < ${OCCUPANCY_FLOOR})`)).toBeGreaterThanOrEqual(OCCUPANCY_FLOOR);
}

/** The bar's predicates. NOT VACUOUS: no call of any arm was shed (a shed call is a cheap 429 before the MCP cycle). */
function expectBarHolds(b: BarStats, compares: { max?: number; exactPerRound?: number } = { max: 0 }): void {
  expect([...b.control, ...b.auth].map((r) => r.shed), `${b.label}: calls shed by the per-IP limits (every arm)`).toEqual(Array(2 * K).fill(0));
  if (compares.exactPerRound !== undefined) {
    // EXACT, not <=: the pool-loaded control runs the design constant, so a regression that added compares
    // must fail here rather than hide inside a matching control (architect b72c3ac4 condition 1).
    expect(b.perRound, `${b.label}: bcrypt compares per round`).toEqual(Array(K).fill(compares.exactPerRound));
    // The CONTROL's own validity, BEFORE any timing verdict: a round whose pool work lapsed is an instrument fault.
    expectControlLoaded(b, compares.exactPerRound);
  } else {
    expect(b.compares, `${b.label}: bcrypt compares`).toBeLessThanOrEqual(compares.max ?? 0);
  }
  expect(b.med.authEld, `${b.label}: LOOP median ${b.med.authEld.toFixed(1)} vs control median ${b.med.ctlEld.toFixed(1)} + ${MARGIN_MS}`).toBeLessThanOrEqual(b.med.ctlEld + MARGIN_MS);
  expect(b.med.authHealth, `${b.label}: AVAILABILITY median ${b.med.authHealth.toFixed(1)} vs control median ${b.med.ctlHealth.toFixed(1)} + ${MARGIN_MS}`).toBeLessThanOrEqual(b.med.ctlHealth + MARGIN_MS);
  for (const r of b.auth) {
    expect(r.healthMax, `${b.label}: a single /health reading over the ${CEILING_MS} ms ceiling (a freeze)`).toBeLessThan(CEILING_MS);
    expect(r.eldMax, `${b.label}: a single loop-delay reading over the ${CEILING_MS} ms ceiling (a freeze)`).toBeLessThan(CEILING_MS);
  }
}

describe.runIf(process.env.RELAY_TIMING_BARS === "1")("BARS (serial CI step, RELAY_TIMING_BARS=1): a burst of failed auths moves the loop and /health no more than the same run's control, with ZERO compares where a digest decides", () => {
  // The per-minute request limit is not under test here, and each bar sends 2K+1 bursts: lift it so no
  // burst is shed by it (read when the daemon starts). The concurrent cap stays at its default.
  const savedRate = process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE;
  beforeAll(() => {
    process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE = "100000";
  });
  afterAll(() => {
    if (savedRate === undefined) delete process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE;
    else process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE = savedRate;
  });

  it("A/A CONTROL: control vs control under the same rule PASSES (the margin sits above this runner's noise; a failure is an INSTRUMENT fault)", async () => {
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`);
      expectBarHolds(await runBar("A/A control vs control", port, controlLoad(20)));
    });
  }, 180_000);

  it("(b) 20 wrong-token register_agent, (c) 20 wrong-token get_messages, (d) 20 unknown tokens with 51 agents", async () => {
    for (let i = 0; i < 50; i++) reg(`fleet-${i}`);
    reg("victim");
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`); // warm
      expectBarHolds(await runBar("(b) wrong token, register_agent", port, authLoad(20, "register_agent", { name: "victim", role: "worker", capabilities: [] })));
      expectBarHolds(await runBar("(c) wrong token, get_messages", port, authLoad(20, "get_messages", { agent_name: "victim" })));
      expectBarHolds(await runBar("(d) unknown token, token-only", port, authLoad(20, "discover_agents", {})));
    });
  }, 300_000);

  it("unknown-provenance rows: wrong tokens are BOUNDED (the source's scan budget) and move the loop no more than the control (bcrypt off the loop)", async () => {
    for (let i = 0; i < 4; i++) {
      reg(`legacy-${i}`);
      db.getDb().prepare("UPDATE agents SET token_lookup = NULL WHERE name = ?").run(`legacy-${i}`);
    }
    const hashes = [0, 1, 2, 3].map((i) => db.getAgentAuthData(`legacy-${i}`)!.token_hash!);
    // THE POOL-LOADED CONTROL (architect b72c3ac4). The design INTENDS bcrypt here: the source's scan budget admits
    // SCAN_BURST token-only scans per round, each comparing the 4 digest-less rows ONE AFTER ANOTHER (db.ts
    // findAgentRowByToken awaits each compare), the scans side by side. The control does exactly that on the SAME
    // pool with the SAME hashes and a wrong token, so the bar measures the auth PATH, not the bcrypt CPU. The count
    // is the DESIGN CONSTANT (4 x SCAN_BURST), never the auth arm's measured one.
    // RESIDUAL, stated: on a small host the pool's own CPU competes with the main thread; that is bounded by the
    // scan budget x the per-compare cost, not by this bar.
    const poolControl: PoolWork = (track) =>
      Promise.all(
        Array.from({ length: SCAN_BURST }, async () => {
          for (const h of hashes) await track(() => compareOffLoop(randomToken(), h));
        }),
      );
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`);
      expectBarHolds(await runBar("unknown-provenance, token-only", port, authLoad(30, "discover_agents", {}), { poolControl }), { exactPerRound: 4 * SCAN_BURST });
      // THE LAPSE DEMO (the occupancy check's own known-bad): the same pool work with a forced 300 ms idle in the
      // middle. Its window still spans it, but the pool is idle for much of it: the round must read as an
      // INSTRUMENT FAULT, never as a valid control.
      const lapsed: PoolWork = async (track) => {
        await poolControl(track);
        await new Promise((r) => setTimeout(r, 300));
        await track(() => compareOffLoop(randomToken(), hashes[0]));
      };
      const r = await measure(port, controlLoad(30), undefined, lapsed);
      expect(r.pool!.busy, `the lapse demo: busy ${r.pool!.busy.toFixed(2)} must fall below the floor`).toBeLessThan(OCCUPANCY_FLOOR);
      const lapsedBar: BarStats = { label: "lapse demo", control: Array(K).fill(r), auth: [], compares: 0, perRound: [], med: { ctlHealth: 0, ctlEld: 0, authHealth: 0, authEld: 0 } };
      expect(() => expectControlLoaded(lapsedBar, 4 * SCAN_BURST + 1)).toThrow(/INSTRUMENT FAULT/);
    });
  }, 180_000);

  it("NEGATIVE CONTROL: a loop block sized 2 x the allowance in EVERY auth round FAILS both predicates (the bar sees a block of the forbidden size)", async () => {
    // Architect 47e64b3a: sized against the thresholds in THIS run, not against bcrypt's real cost.
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`);
      await measure(port, controlLoad(20));
      const pre = await measure(port, controlLoad(20));
      const blockMs = 2 * (Math.max(pre.healthMax, pre.eldMax) + MARGIN_MS);
      const b = await runBar(`negative-control (block=${blockMs.toFixed(1)}ms)`, port, authLoad(20, "discover_agents", {}), {
        onLoop: () => {
          const end = performance.now() + blockMs; // block the DAEMON's loop: what an on-loop bcrypt, or a scan of them, does
          while (performance.now() < end) {
            /* busy */
          }
        },
      });
      expect([...b.control, ...b.auth].map((r) => r.shed), "the negative control's bursts reached the daemon").toEqual(Array(2 * K).fill(0));
      // The bar's own predicates, inverted: each must FAIL here, or the bar cannot see the harm.
      expect(b.med.authEld, "a sized loop block must exceed the LOOP allowance").toBeGreaterThan(b.med.ctlEld + MARGIN_MS);
      expect(b.med.authHealth, "a sized loop block must exceed the AVAILABILITY allowance").toBeGreaterThan(b.med.ctlHealth + MARGIN_MS);
    });
  }, 180_000);
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
