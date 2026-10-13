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
import { monitorEventLoopDelay, PerformanceObserver } from "perf_hooks";
import { Worker } from "worker_threads";
import { spawn } from "child_process";
import { LAPSE_MAX_BUSY, OCCUPANCY_FLOOR, lapseReport, lapsedPool, occupancy, type PoolOccupancy, type PoolWork } from "./_helpers/pool-occupancy.js";

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
// THE SENTINEL (flake f): the largest wall-clock gap between this thread's own 1 ms ticks, counted from the window's
// start. The daemon cannot block this thread (the sampler only awaits fetch), so a daemon-loop freeze leaves it quiet
// while a process- or host-wide stall does not. A ticker that runs from the worker's start and is NEVER reset, not
// monitorEventLoopDelay: MEASURED (flake f, Phase 1), that histogram is blind to a stall landing before its first tick
// after enable() or reset(), here the synchronous start of the load (a 600 ms stop read 1.3-14.0 ms; this ticker
// read 608.7-610.3 ms).
let sentinelLast = performance.now(), sentinelFrom = Infinity, sentinelMax = 0;
const sentinelTick = setInterval(() => {
  const now = performance.now();
  if (now > sentinelFrom) sentinelMax = Math.max(sentinelMax, now - sentinelLast);
  sentinelLast = now;
}, 1);
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
  sentinelFrom = performance.now(); // the window opens: from here, every gap counts
  parentPort.postMessage({ started: true });
  const statuses = n > 0 ? await Promise.all(Array.from({ length: n }, call)) : (await new Promise((r) => setTimeout(r, 300)), []);
  // The window stays open (and /health keeps being sampled) until the parent says stop: a POOL-LOADED control's
  // window must span its pool work, not just its requests.
  parentPort.postMessage({ loaded: true, statuses });
  await stop;
  clearInterval(sentinelTick);
  done = true;
  await sampler;
  parentPort.postMessage({ healthMax, sentinelMax });
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
  /**
   * THE SENTINEL (ms): the largest wall-clock gap between the load WORKER's own 1 ms ticks inside the window, a thread
   * the daemon cannot block. It gates the ceiling (6): a breach it shares is a host stall, not the code.
   */
  sentinelMax: number;
  /**
   * The longest GC pause (ms) on the MAIN thread inside the window (flake f, Phase 0): REPORTED ONLY. The daemon
   * runs in the test's own isolate, so the harness's GC lands on the daemon's loop; this separates "a GC pause"
   * from "the code" when a main-thread stall shows up.
   */
  gcMax: number;
  /** A POOL-LOADED control only: its pool work INSIDE the measured window (see measure). */
  pool?: PoolOccupancy;
}

/**
 * Run `load` from a worker while timing the daemon's loop; `onLoop` runs ON the daemon's loop once the load has
 * started; `poolWork` (the POOL-LOADED control) starts at the same moment and is finished before this returns.
 */
async function measureWindow(port: number, load: Load, onLoop?: () => void, poolWork?: PoolWork): Promise<Reading> {
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
  // Every main-thread GC entry is kept; the ones that START inside [t0, t1] are the window's (entries are delivered
  // after the pause, so the observer stays connected until the reading is built).
  const gcs: Array<[number, number]> = [];
  const gcObs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) gcs.push([e.startTime, e.duration]);
  });
  gcObs.observe({ entryTypes: ["gc"] });
  const worker = new Worker(LOAD_WORKER, { eval: true, workerData: { port, n: load.kind === "idle" ? 0 : load.n, kind: load.kind, tool: load.tool, args: load.args } });
  try {
    return await new Promise<Reading>((resolve, reject) => {
      let statuses: number[] = [];
      let t1 = 0;
      worker.on("error", reject);
      worker.on("message", (m: { started?: true; loaded?: true; healthMax?: number; sentinelMax?: number; statuses?: number[] }) => {
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
        const gcMax = gcs.filter(([at]) => at >= t0 && at <= t1).reduce((mx, [, dur]) => Math.max(mx, dur), 0);
        const reading: Reading = { healthMax: m.healthMax!, eldMax: eld.max / 1e6, shed: statuses.filter((s) => s === 429).length, sentinelMax: m.sentinelMax!, gcMax };
        if (poolWork) reading.pool = occupancy(spans, t0, t1);
        resolve(reading);
      });
    });
  } finally {
    gcObs.disconnect();
    await worker.terminate();
    await pool.catch(() => undefined);
  }
}

const measure = measureWindow;

/**
 * THE TIMING BARS: BACKSTOPS for GROSS regressions (statistic and margin per the architect's ruling of 2026-10-06,
 * superseding the median-gap rule of e26359ac Q3 / 10f7a172 / 47e64b3a / 8cdbc68b / f9916d46).
 *
 * The DISCRIMINATORS are deterministic: COUNT (exact compares) and the static ban on compares outside the pool
 * (tests/pr-b-auth-invariants.test.ts). A timing bar only backstops a GROSS regression, so it must never be flaky:
 * its effect size sits clearly above the runner's MEASURED same-run noise, and it claims no finer resolution.
 *
 *   (1) K = 9 INTERLEAVED rounds; each round measures control, control' (a second control) and auth, adjacent.
 *   (2) The statistic is the MEDIAN OF PER-ROUND PAIRED DIFFERENCES d_i = auth_i - control_i (pairing cancels
 *       runner drift), for each instrument: /health latency (AVAILABILITY) and event-loop delay (LOOP).
 *   (3) EFFECT SIZE = 50 ms for both: the auth burst may add < 50 ms over its same-round control. The stated
 *       RESOLUTION is 50 ms; anything finer is carried by COUNT + the compare ban, by design.
 *   (4) The same run's A/A, paired: a_i = control_i - control'_i. If median(|a_i|) > 25 ms (half the effect size)
 *       the instrument is NOISY and that bar is NOT_EVALUATED: reported loudly (the BAR line and the CI job
 *       summary). A VERDICT is never retried and never best-of-N: an evaluated FAIL, and a ceiling breach the
 *       sentinel does not attribute to the host, are FINAL. Only a NOT_EVALUATED attempt is re-run, up to 3
 *       attempts in total, and the FIRST evaluated attempt decides (architect ruling e475d60d (0); the merge policy
 *       of 2026-10-06). Three NOT_EVALUATED attempts are a FINAL NOT_EVALUATED: the step goes red labelled
 *       NOT_EVALUATED, blocks the merge and is escalated as a runner or instrument problem. It is never called
 *       FAIL: no code defect was measured.
 *   (5) NEGATIVE CONTROLS, sized from the RULED CONSTANTS and the SAME run's CONTROL arm, never from a pre-run
 *       measurement or the arm under test: a GROSS block of +200 ms in every auth burst must TRIP on EVERY run, a
 *       noisy one too (else RED: the instrument is blind); and on every EVALUATED run, the BOUNDARY PAIRS: a block of
 *       80 ms + this run's median control max (per instrument; see CLAIMS) must FAIL and +20 ms (0.4 x the effect
 *       size, FIXED) must PASS, proving discrimination at the threshold on that runner.
 *   (6) The 500 ms per-reading ceiling is an always-on freeze detector, gated by the SENTINEL (architect e475d60d
 *       (2)): a breach with the sentinel quiet is a FREEZE, FAIL and final; a breach while the sentinel stalled too
 *       (sentinel >= the reading - 50 ms) is a host stall, NOT_EVALUATED, and (4) applies. A main-thread-only stall
 *       (GC included) that pushes a reading past 500 ms IS an availability failure from a caller's view, so it FAILS.
 *       A reading with no sentinel is an INSTRUMENT FAULT, never a pass. MEASURED (flake f, Phase 0, 9 CI job logs):
 *       Phase 0's sentinel attributed 0 of the 20 unplanted runner stalls seen (max 156.1 ms). That sentinel was an
 *       event-loop-delay histogram, since replaced (8) because it is blind to a stall before its first tick in each
 *       window, so the 0 of 20 holds only for stalls after that tick. This guard is for a TRUE host stall only and
 *       claims nothing about those stalls.
 *   (7) Every BAR line reports median d, median |a|, the effect size, the verdict and the resolution.
 *   (8) Each reading also carries the SENTINEL (the largest wall-clock gap between the load worker's own 1 ms ticks,
 *       a ticker running from the worker's start and never reset: a thread the daemon cannot block), which gates the
 *       ceiling (6), and the longest main-thread GC pause in the window, REPORTED ONLY (the daemon shares the test's
 *       isolate; no verdict reads it).
 * A pool-loaded bar's controls (both of them) must also prove their occupancy (expectControlLoaded).
 *
 * CLAIMS, stated per instrument and reported per run (architect, LOOP boundary sizing):
 *   - AVAILABILITY (/health): healthMax is a MAX too, so the same holds (MEASURED, flake f: a fixed +80 read
 *     d = 49.4-63.1 on macOS, whose control maxes run 41-54 ms). Claim: "a paired effect >= 50 ms is detected; the
 *     discrimination block = 80 + this run's median control /health max (reported per run)", sized and capped
 *     exactly as LOOP's below. Its PASS block stays +20.
 *   - LOOP (event-loop delay): ELD is a MAX, so an injected stall B lands as d ~= B - (the control's own max), not
 *     +B: a fixed +80 read only 56-60 on CI, hugging the threshold. Its FAIL block is therefore 1.6 x 50 + the
 *     SAME run's median control ELD max (taken from the +20 bar, after its A/A-quiet check), capped at 200 ms
 *     (over the cap: that boundary is NOT_EVALUATED). Claim: "LOOP detects a single synchronous stall >= 50 ms + this
 *     run's median control ELD max (reported per run)". Its PASS block stays +20.
 *   Regressions under these are carried by COUNT + the compare ban.
 */
const K = 9;
const EFFECT_MS = 50;
const GROSS_BLOCK_MS = 200;
const BOUNDARY_FAIL_MS = 80;
const BOUNDARY_PASS_MS = 20;
const BLOCK_CAP_MS = 200;
/** (4) A NOT_EVALUATED bar is re-run up to this many attempts IN TOTAL; the first evaluated attempt decides. */
const MAX_ATTEMPTS = 3;
/** (6) A ceiling breach is a host stall when the sentinel stalled by at least (the reading - this). */
const HOST_STALL_SLACK_MS = EFFECT_MS;
const healthClaim = (controlMedian: number) =>
  `AVAILABILITY: a paired effect >= ${EFFECT_MS} ms is detected; the discrimination block = ${BOUNDARY_FAIL_MS} ms + this run's median control /health max (${controlMedian.toFixed(1)} ms) = ${(BOUNDARY_FAIL_MS + controlMedian).toFixed(1)} ms`;
const loopClaim = (controlMedian: number) =>
  `LOOP: detects a single synchronous stall >= ${EFFECT_MS} ms + this run's median control ELD max (${controlMedian.toFixed(1)} ms), i.e. >= ${(EFFECT_MS + controlMedian).toFixed(1)} ms`;
const NOISE_LIMIT_MS = EFFECT_MS / 2;
const CEILING_MS = 500;
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const list = (xs: number[]) => xs.map((x) => x.toFixed(1)).join("/");

type Verdict = "PASS" | "FAIL" | "NOT_EVALUATED";
interface InstrumentVerdict {
  /** Median of the paired differences auth_i - control_i. */
  d: number;
  /** Median of |control_i - control'_i|: the same run's paired A/A noise. */
  noise: number;
  verdict: Verdict;
}

/**
 * THE DECISION RULE, pure: paired differences against the same round's control, gated by the same run's paired A/A.
 * Unit-tested on synthetic readings (always runs), so the claimed resolution is pinned in both directions.
 */
export function judge(auth: number[], control: number[], control2: number[]): InstrumentVerdict {
  const d = median(auth.map((x, i) => x - control[i]));
  const noise = median(control.map((x, i) => Math.abs(x - control2[i])));
  return { d, noise, verdict: noise > NOISE_LIMIT_MS ? "NOT_EVALUATED" : d < EFFECT_MS ? "PASS" : "FAIL" };
}

/**
 * (6) THE CEILING, pure: over `readings` (a bar's AUTH arm), a reading at or over the ceiling with the sentinel quiet
 * is a FREEZE (FAIL, final); with the sentinel stalled too it is a host stall (NOT_EVALUATED). No sentinel: a FAULT.
 */
export function ceilingVerdict(label: string, readings: Array<Pick<Reading, "healthMax" | "eldMax" | "sentinelMax">>): { verdict: Verdict; why: string } {
  const freezes: string[] = [];
  const hostStalls: string[] = [];
  readings.forEach((r, i) => {
    if (typeof r.sentinelMax !== "number" || !Number.isFinite(r.sentinelMax)) {
      throw new Error(`INSTRUMENT FAULT (${label}): reading ${i + 1} has no sentinel, so a ceiling breach cannot be told from a host stall; no ceiling verdict is possible`);
    }
    for (const [name, v] of [["/health", r.healthMax], ["loop-delay", r.eldMax]] as const) {
      if (v < CEILING_MS) continue;
      const at = `round ${i + 1} ${name} ${v.toFixed(1)} ms, sentinel ${r.sentinelMax.toFixed(1)} ms`;
      (r.sentinelMax >= v - HOST_STALL_SLACK_MS ? hostStalls : freezes).push(at);
    }
  });
  if (freezes.length) return { verdict: "FAIL", why: `a single reading over the ${CEILING_MS} ms ceiling with the sentinel quiet (a freeze): ${freezes.join("; ")}` };
  if (hostStalls.length) return { verdict: "NOT_EVALUATED", why: `over the ${CEILING_MS} ms ceiling while the sentinel stalled too (a host stall, not the code): ${hostStalls.join("; ")}` };
  return { verdict: "PASS", why: "" };
}

/** One attempt's status under (4): a FAIL anywhere is final; otherwise any NOT_EVALUATED re-runs; otherwise EVALUATED. */
export interface Outcome {
  status: "EVALUATED" | "NOT_EVALUATED" | "FAIL";
  why: string[];
}
export interface Attempts<T> {
  result: T;
  attempts: number;
  final: Outcome;
  history: Outcome[];
}

/**
 * (4) THE RE-RUN RULE, the one place it lives: only a NOT_EVALUATED attempt is re-run, up to MAX_ATTEMPTS in total;
 * the FIRST attempt that is not NOT_EVALUATED decides, so an evaluated FAIL is never re-run.
 */
export async function untilEvaluated<T>(label: string, attempt: (n: number) => Promise<T>, outcome: (t: T) => Outcome): Promise<Attempts<T>> {
  const history: Outcome[] = [];
  for (let n = 1; ; n++) {
    const result = await attempt(n);
    const o = outcome(result);
    history.push(o);
    if (o.status !== "NOT_EVALUATED" || n >= MAX_ATTEMPTS) {
      if (n > 1 || o.status === "NOT_EVALUATED") {
        announce(`ATTEMPTS ${label} | ${history.map((h, i) => `#${i + 1} ${h.status}`).join(", ")} | decided by attempt ${n}: ${o.status}`);
      }
      return { result, attempts: n, final: o, history };
    }
    announce(`ATTEMPT ${n} ${label} NOT_EVALUATED (${o.why.join("; ")}): re-run, attempt ${n + 1} of ${MAX_ATTEMPTS}`);
  }
}

/**
 * (4) Three NOT_EVALUATED attempts: a FINAL NOT_EVALUATED. It blocks the merge (this throws, so the step goes red)
 * and is escalated as a runner or instrument problem. Its message never calls it a failure of the code.
 */
export function expectEvaluated(label: string, a: Attempts<unknown>): void {
  if (a.final.status !== "NOT_EVALUATED") return;
  const reasons = a.history.map((h, i) => `#${i + 1}: ${h.why.join("; ")}`).join(" | ");
  throw new Error(`NOT_EVALUATED, FINAL (${label}): ${a.attempts} attempts, none evaluated. A runner or instrument problem, NOT a code defect: this blocks the merge and is escalated. ${reasons}`);
}

/**
 * (5) A boundary FAIL block sized from the SAME run's CONTROL arm (architect e475d60d (1)): 80 ms + the median control
 * max of that instrument, taken only after the +20 bar's A/A-quiet check, and capped. Over the cap, or noisy: none.
 */
export function sizeBlock(controlMaxes: number[], quiet: boolean): { median: number; ms: number | null; why: string } {
  const m = median(controlMaxes);
  const ms = BOUNDARY_FAIL_MS + m;
  if (!quiet) return { median: m, ms: null, why: "the +20 bar's same-run A/A was noisy" };
  if (ms > BLOCK_CAP_MS) return { median: m, ms: null, why: `the sized block ${ms.toFixed(1)} ms exceeds the ${BLOCK_CAP_MS} ms cap` };
  return { median: m, ms, why: "" };
}

interface BarStats {
  label: string;
  control: Reading[];
  /** The second control of each round (the paired A/A). */
  control2: Reading[];
  auth: Reading[];
  compares: number;
  /** The auth arm's compares in each round. */
  perRound: number[];
  health: InstrumentVerdict;
  eld: InstrumentVerdict;
  /** DECLARED by the bar (runBar's poolControl), never inferred from the readings: a pool-loaded bar whose control
   * readings lack their occupancy is an INSTRUMENT FAULT, not a bar that silently skips the check. */
  pooled: boolean;
}

/** A NOT_EVALUATED bar is announced LOUDLY: the log, and the CI job summary when there is one. */
function announce(line: string): void {
  console.log(line);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary && /NOT_EVALUATED/.test(line)) {
    try {
      fs.appendFileSync(summary, `- **timing bar NOT EVALUATED (instrument noisy)**: \`${line.replace(/`/g, "'")}\`\n`);
    } catch {
      /* the log line above already carries it */
    }
  }
}

/**
 * Run one bar: a discarded warm-up, then K interleaved rounds of (control, control', auth). `poolControl`
 * (architect b72c3ac4): BOTH controls also run the pool work the design INTENDS for this load, so the bar compares
 * the auth PATH against the bcrypt work itself. `authPool`: the auth arm runs pool work too (a pool-loaded A/A).
 */
async function runBar(
  label: string,
  port: number,
  load: Load,
  opts: { onLoop?: () => void; poolControl?: PoolWork; authPool?: PoolWork; controlOnLoop?: () => void; measureImpl?: typeof measure } = {},
): Promise<BarStats> {
  // `measureImpl`: a seam for the WIRING MUTANT only (a measure that drops the occupancy reading).
  const measure = opts.measureImpl ?? measureWindow;
  _resetAuthThrottleForTests();
  await measure(port, controlLoad(load.n), undefined, opts.poolControl); // WARM-UP, discarded: a fresh daemon's first burst pays one-off costs
  const control: Reading[] = [];
  const control2: Reading[] = [];
  const auth: Reading[] = [];
  const perRound: number[] = [];
  for (let k = 0; k < K; k++) {
    control.push(await measure(port, controlLoad(load.n), undefined, opts.poolControl));
    control2.push(await measure(port, controlLoad(load.n), opts.controlOnLoop, opts.poolControl));
    _resetAuthThrottleForTests(); // every auth round meets the same budgets (the scan budget refills slowly)
    perRound.push(
      await compares(async () => {
        auth.push(await measure(port, load, opts.onLoop, opts.authPool));
      }),
    );
  }
  const count = perRound.reduce((a, b) => a + b, 0);
  const health = judge(auth.map((r) => r.healthMax), control.map((r) => r.healthMax), control2.map((r) => r.healthMax));
  const eld = judge(auth.map((r) => r.eldMax), control.map((r) => r.eldMax), control2.map((r) => r.eldMax));
  const fmtV = (name: string, v: InstrumentVerdict) => `${name} ${v.verdict} (median d=${v.d.toFixed(1)}, median |a|=${v.noise.toFixed(1)})`;
  const occ = (rs: Reading[]) => `${rs.map((r) => `${r.pool!.inWindow}/${r.pool!.total}`).join(" ")} busy ${rs.map((r) => r.pool!.busy.toFixed(2)).join("/")}`;
  announce(
    `BAR ${label} | ${fmtV("AVAILABILITY", health)} | ${fmtV("LOOP", eld)} | effect size ${EFFECT_MS} ms, noise limit ${NOISE_LIMIT_MS} ms, resolution ${EFFECT_MS} ms, K=${K}` +
      ` | compares=${count} (per round ${perRound.join("/")})${opts.poolControl ? " | controls: POOL-LOADED" : ""}` +
      ` | rounds auth health ${list(auth.map((r) => r.healthMax))} eld ${list(auth.map((r) => r.eldMax))}` +
      ` | rounds control health ${list(control.map((r) => r.healthMax))} eld ${list(control.map((r) => r.eldMax))}` +
      ` | rounds control' health ${list(control2.map((r) => r.healthMax))} eld ${list(control2.map((r) => r.eldMax))}` +
      (opts.poolControl && control.every((r) => r.pool) && control2.every((r) => r.pool) ? ` | control pool in-window ${occ(control)} | control' pool in-window ${occ(control2)}` : "") +
      ` | sentinel (worker wall gap, gates the ceiling) auth ${list(auth.map((r) => r.sentinelMax))} control ${list(control.map((r) => r.sentinelMax))} control' ${list(control2.map((r) => r.sentinelMax))}` +
      ` | main-thread GC max pause (report only) auth ${list(auth.map((r) => r.gcMax))} control ${list(control.map((r) => r.gcMax))} control' ${list(control2.map((r) => r.gcMax))}`,
  );
  return { label, control, control2, auth, compares: count, perRound, health, eld, pooled: opts.poolControl !== undefined };
}

/** Every pool-loaded control round (BOTH controls) ran its design compares INSIDE its window, busy for >= OCCUPANCY_FLOOR of it. */
function expectControlLoaded(b: BarStats, designCompares: number): void {
  if (!b.pooled) return; // DECLARED unloaded (the bar was given no poolControl)
  const fault = (what: string) => `INSTRUMENT FAULT (${b.label}): a pool-loaded control ${what}; that round measured an unloaded loop, so no bar verdict is possible`;
  for (const arm of [b.control, b.control2]) {
    const pools = arm.map((r) => r.pool);
    expect(pools.every((p) => p !== undefined), fault("has rounds with NO occupancy reading (the pool work was not wired into measure)")).toBe(true);
    expect(pools.map((p) => p!.inWindow), fault(`ran compares outside its window (design: ${designCompares} per round, all inside)`)).toEqual(Array(arm.length).fill(designCompares));
    for (const p of pools) expect(p!.busy, fault(`left its pool idle for part of its window (busy ${p!.busy.toFixed(2)} < ${OCCUPANCY_FLOOR})`)).toBeGreaterThanOrEqual(OCCUPANCY_FLOOR);
  }
}

type CompareSpec = { max?: number; exactPerRound?: number };

/**
 * One attempt of a gated bar, under (4) and (6). FAIL: a deterministic part broke (shed, the compare count, the
 * controls' occupancy), an instrument FAILED, or the ceiling saw a freeze. NOT_EVALUATED: an instrument was noisy, or
 * the ceiling saw a host stall. A missing sentinel on ANY reading throws (an INSTRUMENT FAULT, never a pass).
 */
function barOutcome(b: BarStats, compares: CompareSpec = { max: 0 }): Outcome {
  for (const r of [...b.control, ...b.control2, ...b.auth]) {
    if (typeof r.sentinelMax !== "number" || !Number.isFinite(r.sentinelMax)) throw new Error(`INSTRUMENT FAULT (${b.label}): a reading has no sentinel (it was not wired into measure)`);
  }
  const fail: string[] = [];
  const ne: string[] = [];
  if ([...b.control, ...b.control2, ...b.auth].some((r) => r.shed !== 0)) fail.push("calls shed by the per-IP limits");
  if (compares.exactPerRound !== undefined) {
    if (b.perRound.some((c) => c !== compares.exactPerRound)) fail.push(`bcrypt compares per round ${b.perRound.join("/")} (design ${compares.exactPerRound})`);
    try {
      expectControlLoaded(b, compares.exactPerRound);
    } catch (err) {
      fail.push((err as Error).message.split("\n")[0]);
    }
  } else if (b.compares > (compares.max ?? 0)) {
    fail.push(`bcrypt compares ${b.compares} > ${compares.max ?? 0}`);
  }
  const ceiling = ceilingVerdict(b.label, b.auth);
  for (const [name, v] of [["AVAILABILITY", b.health], ["LOOP", b.eld]] as const) {
    if (v.verdict === "FAIL") fail.push(`${name} median paired d ${v.d.toFixed(1)} ms >= ${EFFECT_MS} ms`);
    if (v.verdict === "NOT_EVALUATED") ne.push(`${name} same-run A/A noise ${v.noise.toFixed(1)} ms > ${NOISE_LIMIT_MS} ms`);
  }
  if (ceiling.verdict === "FAIL") fail.push(ceiling.why);
  if (ceiling.verdict === "NOT_EVALUATED") ne.push(ceiling.why);
  if (fail.length) return { status: "FAIL", why: fail };
  if (ne.length) return { status: "NOT_EVALUATED", why: ne };
  return { status: "EVALUATED", why: [] };
}

/** A gated bar under (4): measured until its first evaluated attempt (at most MAX_ATTEMPTS); asserted by the caller. */
const gatedBar = (label: string, run: () => Promise<BarStats>, compares?: CompareSpec): Promise<Attempts<BarStats>> =>
  untilEvaluated(label, run, (b) => barOutcome(b, compares));

/** Assert a gated bar: its deciding attempt holds (a FAIL is red with its own message), and it was evaluated. */
function expectGated(a: Attempts<BarStats>, compares?: CompareSpec): void {
  expectBarHolds(a.result, compares);
  expectEvaluated(a.result.label, a);
}

/**
 * The bar's gate. Deterministic parts always: nothing shed, the exact compare count, the controls' occupancy, the
 * sentinel-gated ceiling (6) on every auth reading. Then each instrument: FAIL is red; NOT_EVALUATED is not decided
 * here ((4): the caller re-runs it, and a FINAL NOT_EVALUATED is red as itself, via expectEvaluated).
 */
function expectBarHolds(b: BarStats, compares: CompareSpec = { max: 0 }): void {
  expect([...b.control, ...b.control2, ...b.auth].map((r) => r.shed), `${b.label}: calls shed by the per-IP limits (every arm)`).toEqual(Array(3 * K).fill(0));
  if (compares.exactPerRound !== undefined) {
    // EXACT, not <=: the pool-loaded control runs the design constant, so a regression that added compares
    // must fail here rather than hide inside a matching control (architect b72c3ac4 condition 1).
    expect(b.perRound, `${b.label}: bcrypt compares per round`).toEqual(Array(K).fill(compares.exactPerRound));
    expectControlLoaded(b, compares.exactPerRound);
  } else {
    expect(b.compares, `${b.label}: bcrypt compares`).toBeLessThanOrEqual(compares.max ?? 0);
  }
  const ceiling = ceilingVerdict(b.label, b.auth);
  expect(ceiling.verdict, `${b.label}: ${ceiling.why}`).not.toBe("FAIL");
  expect(b.health.verdict, `${b.label}: AVAILABILITY median paired d ${b.health.d.toFixed(1)} ms >= the ${EFFECT_MS} ms effect size (A/A noise ${b.health.noise.toFixed(1)})`).not.toBe("FAIL");
  expect(b.eld.verdict, `${b.label}: LOOP median paired d ${b.eld.d.toFixed(1)} ms >= the ${EFFECT_MS} ms effect size (A/A noise ${b.eld.noise.toFixed(1)})`).not.toBe("FAIL");
}

/** A block of `ms` on the DAEMON's loop: what an on-loop bcrypt, or a scan of them, does. */
const loopBlock = (ms: number) => () => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* busy */
  }
};

/** (5) The negative control must TRIP: its d crosses the effect size on BOTH instruments, noisy run or not. */
function expectTrips(b: BarStats): void {
  expect([...b.control, ...b.control2, ...b.auth].map((r) => r.shed), `${b.label}: the bursts reached the daemon`).toEqual(Array(3 * K).fill(0));
  expect(b.eld.d, `${b.label}: a sized loop block must cross the LOOP effect size (else the bar cannot see harm)`).toBeGreaterThanOrEqual(EFFECT_MS);
  expect(b.health.d, `${b.label}: a sized loop block must cross the AVAILABILITY effect size (else the bar cannot see harm)`).toBeGreaterThanOrEqual(EFFECT_MS);
}

describe("the timing-bar decision rule (pure; always runs; not matched by the isolated step's name filter): the claimed 50 ms resolution, pinned both ways", () => {
  const flat = (v: number) => Array(K).fill(v);
  it("a regression of 80 ms per round → FAIL; of 20 ms → PASS (with resolution 50 ms stated, never finer)", () => {
    expect(judge(flat(130), flat(50), flat(52)).verdict).toBe("FAIL");
    expect(judge(flat(70), flat(50), flat(52)).verdict).toBe("PASS");
    expect(judge(flat(99), flat(50), flat(50)).verdict, "d = 49 ms: under the effect size").toBe("PASS");
    expect(judge(flat(100), flat(50), flat(50)).verdict, "d = 50 ms: at the effect size").toBe("FAIL");
  });
  it("PAIRED, not difference-of-medians: a drift that moves auth and control together in each round does not FAIL", () => {
    const drift = [10, 200, 30, 180, 20, 170, 40, 160, 15];
    expect(judge(drift.map((x) => x + 5), drift, drift.map((x) => x + 3)).verdict).toBe("PASS");
  });
  it("a noisy same-run A/A (median |a| > 25 ms) → NOT_EVALUATED, never FAIL, even with a large d", () => {
    const control = flat(50);
    const control2 = [10, 100, 5, 110, 0, 95, 12, 90, 8]; // |a| median 40
    expect(judge(flat(200), control, control2).verdict).toBe("NOT_EVALUATED");
    expect(judge(flat(60), control, control2).verdict).toBe("NOT_EVALUATED");
  });
  it("THE RE-RUN RULE (4): only NOT_EVALUATED is re-run, at most 3 attempts; the first evaluated attempt decides; a FAIL is final; 3 x NOT_EVALUATED is a FINAL NOT_EVALUATED that blocks, never called FAIL", async () => {
    const scripted = async (statuses: Outcome["status"][]) => {
      let calls = 0;
      const a = await untilEvaluated("scripted", async (n) => (calls++, n), (n) => ({ status: statuses[n - 1], why: [`scripted ${statuses[n - 1]}`] }));
      return { ...a, calls };
    };
    const ne1 = await scripted(["NOT_EVALUATED", "EVALUATED", "FAIL"]);
    expect([ne1.calls, ne1.final.status]).toEqual([2, "EVALUATED"]);
    const fail1 = await scripted(["FAIL", "EVALUATED"]);
    expect([fail1.calls, fail1.final.status], "an evaluated FAIL is never re-run").toEqual([1, "FAIL"]);
    const neThenFail = await scripted(["NOT_EVALUATED", "FAIL", "EVALUATED"]);
    expect([neThenFail.calls, neThenFail.final.status], "the first EVALUATED attempt decides, a FAIL included").toEqual([2, "FAIL"]);
    const allNe = await scripted(["NOT_EVALUATED", "NOT_EVALUATED", "NOT_EVALUATED", "EVALUATED"]);
    expect([allNe.calls, allNe.final.status], "never a 4th attempt").toEqual([MAX_ATTEMPTS, "NOT_EVALUATED"]);
    expect(() => expectEvaluated("scripted", ne1)).not.toThrow();
    expect(() => expectEvaluated("scripted", allNe)).toThrow(/^NOT_EVALUATED, FINAL \(scripted\): 3 attempts, none evaluated/);
    let msg = "";
    try {
      expectEvaluated("scripted", allNe);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg, "a final NOT_EVALUATED is labelled as such: it never asserts a code failure").not.toMatch(/\bFAIL\b/);
  });
  it("THE CEILING (6): a breach with the sentinel quiet is a FREEZE (FAIL); with the sentinel stalled >= reading - 50 ms it is a host stall (NOT_EVALUATED); no sentinel is an INSTRUMENT FAULT, never a pass", () => {
    const r = (healthMax: number, eldMax: number, sentinelMax: number) => ({ healthMax, eldMax, sentinelMax });
    const quiet = Array(K).fill(r(40, 30, 4));
    expect(ceilingVerdict("t", quiet).verdict).toBe("PASS");
    expect(ceilingVerdict("t", [...quiet.slice(1), r(507.6, 467.9, 4)]).verdict, "the 07f802f reading, sentinel quiet").toBe("FAIL");
    expect(ceilingVerdict("t", [...quiet.slice(1), r(40, 600, 5)]).verdict, "a loop-only breach is a breach too").toBe("FAIL");
    expect(ceilingVerdict("t", [...quiet.slice(1), r(640, 602, 601)]).verdict, "the whole process stopped").toBe("NOT_EVALUATED");
    expect(ceilingVerdict("t", [...quiet.slice(1), r(640, 602, 589)]).verdict, "the sentinel 1 ms short of the slack").toBe("FAIL");
    expect(ceilingVerdict("t", [r(640, 602, 601), r(507.6, 467.9, 4)]).verdict, "one freeze among host stalls: FAIL wins").toBe("FAIL");
    expect(() => ceilingVerdict("t", [r(40, 30, 4), { healthMax: 40, eldMax: 30 } as never]), "no sentinel").toThrow(/INSTRUMENT FAULT/);
    expect(() => ceilingVerdict("t", [r(40, 30, Number.NaN)])).toThrow(/INSTRUMENT FAULT/);
  });
  it("THE +80 SIZING (5): MEASURED macOS readings (8c0eefe) with the FIXED +80 read PASS, which is the flake; the sized block is 80 + the +20 bar's median CONTROL max, none when noisy or over the 200 ms cap", () => {
    // The `boundary AVAILABILITY +80 ms` bar of macOS job 114838392595 (8c0eefe), as its BAR line printed it.
    const fixedAuth = [88.4, 88.1, 88.8, 130.6, 112.8, 123.8, 89.9, 139.2, 141.9];
    const fixedControl = [68.8, 50.5, 64.5, 50.9, 63.5, 58.8, 45.0, 44.1, 53.6];
    const fixedControl2 = [34.7, 38.8, 38.7, 48.5, 68.4, 40.6, 35.6, 35.8, 55.0];
    expect(judge(fixedAuth, fixedControl, fixedControl2).verdict, "the fixed +80 could not FAIL on that runner").toBe("PASS");
    // The same run's `boundary +20 ms` bar's CONTROL /health maxima, which size the block.
    const at20Control = [32.8, 47.6, 51.4, 42.7, 46.8, 53.3, 63.7, 42.2, 48.0];
    expect(sizeBlock(at20Control, true)).toEqual({ median: 47.6, ms: 127.6, why: "" });
    expect(sizeBlock(at20Control, false).ms, "a noisy +20 bar sizes nothing").toBeNull();
    expect(sizeBlock(flat(121), true).ms, "80 + 121 > the 200 ms cap").toBeNull();
    expect(sizeBlock(flat(120), true).ms, "80 + 120 = the cap, still sized").toBe(200);
  });
});

describe.runIf(process.env.RELAY_TIMING_BARS === "1")("BARS (serial CI step, RELAY_TIMING_BARS=1): a burst of failed auths moves the loop and /health no more than the same run's control, with ZERO compares where a digest decides", () => {
  // The per-minute request limit is not under test here, and each bar sends 3K+1 bursts: lift it so no
  // burst is shed by it (read when the daemon starts). The concurrent cap stays at its default.
  const savedRate = process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE;
  beforeAll(() => {
    process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE = "100000";
  });
  afterAll(() => {
    if (savedRate === undefined) delete process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE;
    else process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE = savedRate;
  });

  it("A/A CONTROL: control vs control under the same rule never FAILS (a noisy runner reads NOT_EVALUATED, not red)", async () => {
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`);
      expectGated(await gatedBar("A/A control vs control", () => runBar("A/A control vs control", port, controlLoad(20))));
    });
  }, 300_000);

  it("(b) 20 wrong-token register_agent, (c) 20 wrong-token get_messages, (d) 20 unknown tokens with 51 agents", async () => {
    for (let i = 0; i < 50; i++) reg(`fleet-${i}`);
    reg("victim");
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`); // warm
      // Measured first, asserted after: one red still logs every BAR line.
      const b = await gatedBar("(b) wrong token, register_agent", () => runBar("(b) wrong token, register_agent", port, authLoad(20, "register_agent", { name: "victim", role: "worker", capabilities: [] })));
      const c = await gatedBar("(c) wrong token, get_messages", () => runBar("(c) wrong token, get_messages", port, authLoad(20, "get_messages", { agent_name: "victim" })));
      const d = await gatedBar("(d) unknown token, token-only", () => runBar("(d) unknown token, token-only", port, authLoad(20, "discover_agents", {})));
      for (const bar of [b, c, d]) expectGated(bar);
    });
  }, 600_000);

  it("unknown-provenance rows: wrong tokens are BOUNDED (the source's scan budget) and move the loop no more than the control (bcrypt off the loop)", async () => {
    for (let i = 0; i < 4; i++) {
      reg(`legacy-${i}`);
      db.getDb().prepare("UPDATE agents SET token_lookup = NULL WHERE name = ?").run(`legacy-${i}`);
    }
    const hashes = [0, 1, 2, 3].map((i) => db.getAgentAuthData(`legacy-${i}`)!.token_hash!);
    // THE POOL-LOADED CONTROL (architect b72c3ac4). The design INTENDS bcrypt here: the source's scan budget admits
    // SCAN_BURST token-only scans per round, each comparing the 4 digest-less rows ONE AFTER ANOTHER (db.ts
    // findAgentRowByToken awaits each compare), the scans side by side. Both controls do exactly that on the SAME
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
      // Every bar of this path is MEASURED FIRST and asserted after, so one red run still logs all of its BAR lines.
      const gated = await gatedBar("unknown-provenance, token-only", () => runBar("unknown-provenance, token-only", port, authLoad(30, "discover_agents", {}), { poolControl }), { exactPerRound: 4 * SCAN_BURST });
      const bar = gated.result;
      // (5) ON THE POOL-LOADED PATH: the GROSS block (+200 ms, the ruled constant) in every auth burst must TRIP,
      // noisy run or not.
      const neg = await runBar(`gross negative pool-loaded (+${GROSS_BLOCK_MS} ms)`, port, authLoad(30, "discover_agents", {}), { poolControl, onLoop: loopBlock(GROSS_BLOCK_MS) });
      // THE LAPSE DEMO (the occupancy check's own known-bad): the same pool work with a forced idle in the middle,
      // sized from its own busy time (LAPSE_RATIO). Its window spans it, but the pool is idle for much of it.
      const lapsed = lapsedPool(poolControl, () => compareOffLoop(randomToken(), hashes[0]));
      const r = await measure(port, controlLoad(30), undefined, lapsed);

      expectGated(gated, { exactPerRound: 4 * SCAN_BURST });
      expectControlLoaded(neg, 4 * SCAN_BURST); // the negative's own controls are valid, so its trip means something
      expect(neg.perRound, "the loaded negative's auth arm did the design's compares (it exercised the same path)").toEqual(Array(K).fill(4 * SCAN_BURST));
      expectTrips(neg); // includes: nothing shed on any arm
      // The demo's SELF-CHECK (architect 1850c978): it must reach its designed state, a margin under the floor, or it
      // proves nothing. Its message names D, C, the idle, the demo's run and the measured window (t1 - t0).
      expect(r.pool!.busy, lapseReport(r.pool!, lapsed.stats)).toBeLessThanOrEqual(LAPSE_MAX_BUSY);
      const lapsedBar: BarStats = { ...bar, label: "lapse demo", control: Array(K).fill(r), control2: Array(K).fill(r), pooled: true };
      expect(() => expectControlLoaded(lapsedBar, 4 * SCAN_BURST + 1)).toThrow(/INSTRUMENT FAULT/);
      // THE WIRING MUTANT, THROUGH runBar: a measure that drops the occupancy reading on a bar DECLARED pool-loaded.
      // runBar must still complete (its log tolerates the missing reading) so the NAMED fault fires, not a TypeError.
      const dropping: typeof measure = async (...args) => {
        const reading = await measureWindow(...args);
        delete reading.pool;
        return reading;
      };
      const unwired = await runBar("unwired mutant", port, authLoad(30, "discover_agents", {}), { poolControl, measureImpl: dropping });
      expect(() => expectControlLoaded(unwired, 4 * SCAN_BURST)).toThrow(/NO occupancy reading/);
    });
  }, 600_000);

  it("NEGATIVE CONTROL + THE RESOLUTION, live: +200 ms TRIPS on every run; an injected noise source reads NOT_EVALUATED; on an evaluated run the boundary blocks FAIL (AVAILABILITY +80, LOOP +80 + the run's control ELD) and +20 PASSES", async () => {
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`);
      await measure(port, controlLoad(20));
      const neg = await runBar(`gross negative (+${GROSS_BLOCK_MS} ms)`, port, authLoad(20, "discover_agents", {}), { onLoop: loopBlock(GROSS_BLOCK_MS) });
      // An A/A with an injected NOISE source: control' gets a 60-150 ms block, a different size each round, so its
      // paired |a| sits well above the 25 ms noise limit in most rounds (MEASURED: a 0-120 ms mix with zeros gave a
      // median |a| of only 16.5-17.8 ms, under the limit: not a noise source by this rule).
      const sizes = [60, 120, 80, 150, 70, 110, 90, 140, 100];
      let round = 0;
      const noisy = await runBar("A/A with injected noise", port, controlLoad(20), { controlOnLoop: () => loopBlock(sizes[round++ % sizes.length])() });
      // THE BOUNDARY PAIRS, live, as ONE unit under (4). The +20 PASS bar runs FIRST: its CONTROLS size both FAIL
      // blocks (5): 80 + this run's median control max per instrument, after the +20 bar's A/A-quiet check, capped.
      const pairs = await untilEvaluated(
        "boundary pairs",
        async () => {
          const at20 = await runBar(`boundary +${BOUNDARY_PASS_MS} ms`, port, authLoad(20, "discover_agents", {}), { onLoop: loopBlock(BOUNDARY_PASS_MS) });
          const health = sizeBlock(at20.control.map((r) => r.healthMax), at20.health.verdict !== "NOT_EVALUATED");
          const loop = sizeBlock(at20.control.map((r) => r.eldMax), at20.eld.verdict !== "NOT_EVALUATED");
          const at80 = health.ms !== null ? await runBar(`boundary AVAILABILITY +${health.ms.toFixed(1)} ms (80 + median control /health max ${health.median.toFixed(1)})`, port, authLoad(20, "discover_agents", {}), { onLoop: loopBlock(health.ms) }) : null;
          const atLoop = loop.ms !== null ? await runBar(`boundary LOOP +${loop.ms.toFixed(1)} ms (80 + median control ELD ${loop.median.toFixed(1)})`, port, authLoad(20, "discover_agents", {}), { onLoop: loopBlock(loop.ms) }) : null;
          return { at20, health, loop, at80, atLoop };
        },
        (x) => {
          const fail: string[] = [];
          const ne: string[] = [];
          for (const [name, sized, bar, pick] of [
            ["AVAILABILITY", x.health, x.at80, (b: BarStats) => b.health],
            ["LOOP", x.loop, x.atLoop, (b: BarStats) => b.eld],
          ] as const) {
            if (bar === null) ne.push(`${name} boundary: ${sized.why}`);
            else if (pick(bar).verdict === "NOT_EVALUATED" || pick(x.at20).verdict === "NOT_EVALUATED") ne.push(`${name} boundary: the instrument was noisy this attempt`);
            else if (pick(bar).verdict !== "FAIL" || pick(x.at20).verdict !== "PASS") fail.push(`${name} boundary: +${sized.ms!.toFixed(1)} ms ${pick(bar).verdict} (d=${pick(bar).d.toFixed(1)}), +${BOUNDARY_PASS_MS} ms ${pick(x.at20).verdict} (d=${pick(x.at20).d.toFixed(1)})`);
          }
          return fail.length ? { status: "FAIL", why: fail } : ne.length ? { status: "NOT_EVALUATED", why: ne } : { status: "EVALUATED", why: [] };
        },
      );
      const { at20, health, loop, at80, atLoop } = pairs.result;
      const healthEvaluated = at80 !== null && at80.health.verdict !== "NOT_EVALUATED" && at20.health.verdict !== "NOT_EVALUATED";
      const loopEvaluated = atLoop !== null && atLoop.eld.verdict !== "NOT_EVALUATED" && at20.eld.verdict !== "NOT_EVALUATED";
      announce(
        healthEvaluated
          ? `CLAIM ${healthClaim(health.median)} | boundary EVALUATED: +${health.ms!.toFixed(1)} ms ${at80!.health.verdict}; +${BOUNDARY_PASS_MS} ms ${at20.health.verdict}`
          : `CLAIM ${healthClaim(health.median)} | boundary NOT_EVALUATED (${health.ms === null ? health.why : "the instrument was noisy this run"})`,
      );
      announce(
        loopEvaluated
          ? `CLAIM ${loopClaim(loop.median)} | boundary EVALUATED: +${loop.ms!.toFixed(1)} ms ${atLoop!.eld.verdict}; +${BOUNDARY_PASS_MS} ms ${at20.eld.verdict}`
          : `CLAIM ${loopClaim(loop.median)} | boundary NOT_EVALUATED (${loop.ms === null ? loop.why : "the instrument was noisy this run"})`,
      );

      expectTrips(neg); // on EVERY run, noisy or not: the instrument must not be blind
      expect(noisy.eld.verdict, "injected A/A noise must read NOT_EVALUATED (never red)").toBe("NOT_EVALUATED");
      if (healthEvaluated) {
        expect(at80!.health.verdict, `AVAILABILITY +${health.ms!.toFixed(1)} ms must FAIL (d=${at80!.health.d.toFixed(1)})`).toBe("FAIL");
        expect(at20.health.verdict, `AVAILABILITY +${BOUNDARY_PASS_MS} ms must PASS (d=${at20.health.d.toFixed(1)})`).toBe("PASS");
      }
      if (loopEvaluated) {
        expect(atLoop!.eld.verdict, `LOOP +${loop.ms!.toFixed(1)} ms must FAIL (d=${atLoop!.eld.d.toFixed(1)})`).toBe("FAIL");
        expect(at20.eld.verdict, `LOOP +${BOUNDARY_PASS_MS} ms must PASS (d=${at20.eld.d.toFixed(1)})`).toBe("PASS");
      }
      expectEvaluated("boundary pairs", pairs); // (4): three noisy attempts are a FINAL NOT_EVALUATED, red as itself
    });
  }, 600_000);
});

describe.runIf(process.env.RELAY_TIMING_BARS === "1")("BARS (serial CI step, RELAY_TIMING_BARS=1), the CEILING's own REDs (6): a freeze FAILS, final; a host stall reads NOT_EVALUATED and is re-run", () => {
  const savedRate = process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE;
  beforeAll(() => {
    process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE = "100000";
  });
  afterAll(() => {
    if (savedRate === undefined) delete process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE;
    else process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE = savedRate;
  });
  /** A planted stall's length: over the 500 ms ceiling by a margin no runner noise in the MEASURED tail reaches. */
  const STALL_MS = 600;
  /** The auth round (0-based) a single planted stall lands in. */
  const STALL_ROUND = 4;

  it("CEILING, a freeze: one auth round's daemon loop blocked 600 ms with the sentinel quiet FAILS, final, never re-run; every round blocked FAILS too", async () => {
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`);
      let round = 0;
      const one = await gatedBar("ceiling RED: one auth round frozen", () => {
        round = 0;
        return runBar(`ceiling RED: auth round ${STALL_ROUND + 1} frozen ${STALL_MS} ms`, port, authLoad(20, "discover_agents", {}), {
          onLoop: () => {
            if (round++ === STALL_ROUND) loopBlock(STALL_MS)();
          },
        });
      });
      const every = await gatedBar("ceiling RED: every auth round frozen", () => runBar(`ceiling RED: every auth round frozen ${STALL_MS} ms`, port, authLoad(20, "discover_agents", {}), { onLoop: loopBlock(STALL_MS) }));
      for (const [x, frozen] of [[one, 1], [every, K]] as const) {
        const c = ceilingVerdict(x.result.label, x.result.auth);
        expect(c.verdict, `${x.result.label}: the planted freeze must read as a freeze (${c.why || "no breach"})`).toBe("FAIL");
        expect(x.result.auth.filter((r) => r.eldMax >= CEILING_MS).length, `${x.result.label}: the loop breached the ceiling in each frozen round`).toBe(frozen);
        expect(x.final.status, x.final.why.join("; ")).toBe("FAIL");
        expect(x.attempts, `${x.result.label}: a ceiling breach is never re-run`).toBe(1);
      }
    });
  }, 300_000);

  it("CEILING, a host stall: the whole test process stopped 600 ms in one auth round reads NOT_EVALUATED (the sentinel stalled too) and is re-run; three stalled attempts are a FINAL NOT_EVALUATED, never FAIL", async () => {
    // A helper child resumes THIS process: it is armed first (ready on stdout), then this process signals the child
    // (SIGUSR2, a synchronous syscall) and stops ITSELF (SIGSTOP on its own pid, never a group); the child sends
    // SIGCONT after STALL_MS. RESIDUAL, stated: if the child died between the two signals, this process would stay
    // stopped until the CI job's own timeout.
    const armHostStall = async (): Promise<{ fire: () => void; fired: () => boolean; disarm: () => Promise<void> }> => {
      const pid = process.pid;
      expect(pid).toBeGreaterThan(1);
      // The child resumes the stopped process in a `finally` on its timer, AND on every exit it can run code for (its
      // `exit` hook, SIGTERM, SIGINT), so only an uncatchable SIGKILL of the child could leave this process stopped.
      const helper = [
        `const p = Number(process.argv[1]);`,
        `const resume = () => { try { process.kill(p, "SIGCONT"); } catch {} };`,
        `process.on("exit", resume);`,
        `for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => process.exit(0));`,
        `process.on("SIGUSR2", () => setTimeout(() => { try {} finally { resume(); process.exit(0); } }, ${STALL_MS}));`,
        `process.stdout.write("ready\\n");`,
        `setInterval(() => {}, 1000);`,
      ].join(" ");
      const child = spawn(process.execPath, ["-e", helper, String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
      const childPid = child.pid;
      expect(childPid).toBeGreaterThan(1);
      console.log(`HOST-STALL helper pid ${childPid} targets the test process pid ${pid} (SIGSTOP on itself only)`);
      const exited = new Promise<void>((res) => child.once("exit", () => res()));
      await new Promise<void>((res, rej) => {
        child.stdout!.once("data", () => res());
        child.once("exit", (code) => rej(new Error(`the stall helper exited early (${code})`)));
      });
      let fired = false;
      return {
        fire: () => {
          fired = true;
          process.kill(childPid!, "SIGUSR2");
          process.kill(pid, "SIGSTOP");
        },
        fired: () => fired,
        // A fired helper exits by itself after SIGCONT; an unfired one is ended by its RECORDED pid (SIGTERM: its own
        // handler exits, and its exit hook's SIGCONT to a running process is a no-op).
        disarm: async () => {
          if (!fired) process.kill(childPid!, "SIGTERM");
          await exited;
        },
      };
    };
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`);
      const stalledAttempt = async (label: string, stall: boolean): Promise<BarStats> => {
        const helper = stall ? await armHostStall() : null;
        let round = 0;
        try {
          const bar = await runBar(label, port, authLoad(20, "discover_agents", {}), {
            onLoop: () => {
              if (round++ === STALL_ROUND && helper) helper.fire();
            },
          });
          if (helper) expect(helper.fired(), `${label}: the planted stall fired`).toBe(true);
          return bar;
        } finally {
          await helper?.disarm();
        }
      };
      let onceCalls = 0;
      const once = await gatedBar("ceiling: a host stall in attempt 1 only", () => stalledAttempt(`ceiling: whole process stopped ${STALL_MS} ms (attempt 1 only)`, onceCalls++ === 0));
      expect(once.history[0].status, once.history[0].why.join("; ")).toBe("NOT_EVALUATED");
      expect(once.history[0].why.join(" "), "attempt 1 is a host stall, attributed by the sentinel").toMatch(/sentinel stalled too \(a host stall/);
      expect(once.attempts, "a NOT_EVALUATED attempt is re-run").toBeGreaterThanOrEqual(2);
      expectGated(once); // the first evaluated attempt decides (or, after 3 noisy ones, a FINAL NOT_EVALUATED, red as itself)

      const always = await gatedBar("ceiling: a host stall in every attempt", () => stalledAttempt(`ceiling: whole process stopped ${STALL_MS} ms (every attempt)`, true));
      expect(always.history.map((h) => h.status), always.history.map((h) => h.why.join("; ")).join(" | ")).toEqual(Array(MAX_ATTEMPTS).fill("NOT_EVALUATED"));
      expect(always.attempts, "never a 4th attempt").toBe(MAX_ATTEMPTS);
      let msg = "";
      try {
        expectEvaluated(always.result.label, always);
      } catch (err) {
        msg = (err as Error).message;
      }
      expect(msg).toMatch(/^NOT_EVALUATED, FINAL/);
      expect(msg, "a final NOT_EVALUATED never calls the code a failure").not.toMatch(/\bFAIL\b/);
    });
  }, 300_000);
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
