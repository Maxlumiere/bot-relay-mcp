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
 *       summary), neither red nor green. Never a retry, never best-of-N.
 *   (5) NEGATIVE CONTROLS, sized from the RULED CONSTANTS, never from a pre-run measurement (a paired d_i takes an
 *       injected delay directly): a GROSS block of +200 ms in every auth burst must TRIP on EVERY run, a noisy one
 *       too (else RED: the instrument is blind); and on every EVALUATED run, the BOUNDARY PAIR: +80 ms (1.6 x the
 *       effect size) must FAIL and +20 ms (0.4 x) must PASS, proving discrimination at the threshold on that runner.
 *   (6) The 500 ms per-reading ceiling is an always-on freeze detector.
 *   (7) Every BAR line reports median d, median |a|, the effect size, the verdict and the resolution.
 * A pool-loaded bar's controls (both of them) must also prove their occupancy (expectControlLoaded).
 *
 * CLAIMS, stated per instrument and reported per run (architect, LOOP boundary sizing):
 *   - AVAILABILITY (/health): decision threshold 50 ms; detection of >= 80 ms added per burst proven in the run
 *     that reports it (the boundary pair: +80 FAIL, +20 PASS).
 *   - LOOP (event-loop delay): ELD is a MAX, so an injected stall B lands as d ~= B - (the control's own max), not
 *     +B: a fixed +80 read only 56-60 on CI, hugging the threshold. Its FAIL block is therefore 1.6 x 50 + the
 *     SAME run's median control ELD max (taken from the +20 bar, after its A/A-quiet check), capped at 200 ms
 *     (over the cap: LOOP boundary NOT_EVALUATED). Claim: "LOOP detects a single synchronous stall >= 50 ms + this
 *     run's median control ELD max (reported per run)". Its PASS block stays +20.
 *   Regressions under these are carried by COUNT + the compare ban.
 */
const K = 9;
const EFFECT_MS = 50;
const GROSS_BLOCK_MS = 200;
const BOUNDARY_FAIL_MS = 80;
const BOUNDARY_PASS_MS = 20;
const LOOP_BLOCK_CAP_MS = 200;
const HEALTH_CLAIM = `AVAILABILITY: decision threshold ${EFFECT_MS} ms; detection of >= ${BOUNDARY_FAIL_MS} ms added per burst proven this run`;
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
      (opts.poolControl && control.every((r) => r.pool) && control2.every((r) => r.pool) ? ` | control pool in-window ${occ(control)} | control' pool in-window ${occ(control2)}` : ""),
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

/**
 * The bar's gate. Deterministic parts always: nothing shed, the exact compare count, the controls' occupancy, the
 * 500 ms ceiling on every auth reading. Then each instrument: FAIL is red; NOT_EVALUATED is neither (announced).
 */
function expectBarHolds(b: BarStats, compares: { max?: number; exactPerRound?: number } = { max: 0 }): void {
  expect([...b.control, ...b.control2, ...b.auth].map((r) => r.shed), `${b.label}: calls shed by the per-IP limits (every arm)`).toEqual(Array(3 * K).fill(0));
  if (compares.exactPerRound !== undefined) {
    // EXACT, not <=: the pool-loaded control runs the design constant, so a regression that added compares
    // must fail here rather than hide inside a matching control (architect b72c3ac4 condition 1).
    expect(b.perRound, `${b.label}: bcrypt compares per round`).toEqual(Array(K).fill(compares.exactPerRound));
    expectControlLoaded(b, compares.exactPerRound);
  } else {
    expect(b.compares, `${b.label}: bcrypt compares`).toBeLessThanOrEqual(compares.max ?? 0);
  }
  for (const r of b.auth) {
    expect(r.healthMax, `${b.label}: a single /health reading over the ${CEILING_MS} ms ceiling (a freeze)`).toBeLessThan(CEILING_MS);
    expect(r.eldMax, `${b.label}: a single loop-delay reading over the ${CEILING_MS} ms ceiling (a freeze)`).toBeLessThan(CEILING_MS);
  }
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
      expectBarHolds(await runBar("A/A control vs control", port, controlLoad(20)));
    });
  }, 300_000);

  it("(b) 20 wrong-token register_agent, (c) 20 wrong-token get_messages, (d) 20 unknown tokens with 51 agents", async () => {
    for (let i = 0; i < 50; i++) reg(`fleet-${i}`);
    reg("victim");
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`); // warm
      // Measured first, asserted after: one red still logs every BAR line.
      const b = await runBar("(b) wrong token, register_agent", port, authLoad(20, "register_agent", { name: "victim", role: "worker", capabilities: [] }));
      const c = await runBar("(c) wrong token, get_messages", port, authLoad(20, "get_messages", { agent_name: "victim" }));
      const d = await runBar("(d) unknown token, token-only", port, authLoad(20, "discover_agents", {}));
      for (const bar of [b, c, d]) expectBarHolds(bar);
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
      const bar = await runBar("unknown-provenance, token-only", port, authLoad(30, "discover_agents", {}), { poolControl });
      // (5) ON THE POOL-LOADED PATH: the GROSS block (+200 ms, the ruled constant) in every auth burst must TRIP,
      // noisy run or not.
      const neg = await runBar(`gross negative pool-loaded (+${GROSS_BLOCK_MS} ms)`, port, authLoad(30, "discover_agents", {}), { poolControl, onLoop: loopBlock(GROSS_BLOCK_MS) });
      // THE LAPSE DEMO (the occupancy check's own known-bad): the same pool work with a forced idle in the middle,
      // sized from its own busy time (LAPSE_RATIO). Its window spans it, but the pool is idle for much of it.
      const lapsed = lapsedPool(poolControl, () => compareOffLoop(randomToken(), hashes[0]));
      const r = await measure(port, controlLoad(30), undefined, lapsed);

      expectBarHolds(bar, { exactPerRound: 4 * SCAN_BURST });
      expectControlLoaded(neg, 4 * SCAN_BURST); // the negative's own controls are valid, so its trip means something
      expect(neg.perRound, "the loaded negative's auth arm did the design's compares (it exercised the same path)").toEqual(Array(K).fill(4 * SCAN_BURST));
      expectTrips(neg); // includes: nothing shed on any arm
      // The demo's SELF-CHECK (architect 1850c978): it must reach its designed state, a margin under the floor, or it
      // proves nothing. Its message names D, C, the idle and the window.
      expect(r.pool!.busy, lapseReport(r.pool!.busy, lapsed.stats)).toBeLessThanOrEqual(LAPSE_MAX_BUSY);
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
      // THE BOUNDARY PAIRS, live. The +20 PASS bar runs FIRST: its controls give this run's median control ELD max.
      const at20 = await runBar(`boundary +${BOUNDARY_PASS_MS} ms`, port, authLoad(20, "discover_agents", {}), { onLoop: loopBlock(BOUNDARY_PASS_MS) });
      //   AVAILABILITY's FAIL block: a fixed +80.
      const at80 = await runBar(`boundary AVAILABILITY +${BOUNDARY_FAIL_MS} ms`, port, authLoad(20, "discover_agents", {}), { onLoop: loopBlock(BOUNDARY_FAIL_MS) });
      //   LOOP's FAIL block: 1.6 x 50 + this run's median control ELD max (after the A/A-quiet check), capped.
      const ctlEldMedian = median(at20.control.map((r) => r.eldMax));
      const loopBlockMs = BOUNDARY_FAIL_MS + ctlEldMedian;
      const loopSized = at20.eld.verdict !== "NOT_EVALUATED" && loopBlockMs <= LOOP_BLOCK_CAP_MS;
      const atLoop = loopSized ? await runBar(`boundary LOOP +${loopBlockMs.toFixed(1)} ms (80 + median control ELD ${ctlEldMedian.toFixed(1)})`, port, authLoad(20, "discover_agents", {}), { onLoop: loopBlock(loopBlockMs) }) : null;

      const healthEvaluated = at80.health.verdict !== "NOT_EVALUATED" && at20.health.verdict !== "NOT_EVALUATED";
      const loopEvaluated = atLoop !== null && atLoop.eld.verdict !== "NOT_EVALUATED" && at20.eld.verdict !== "NOT_EVALUATED";
      announce(
        healthEvaluated
          ? `CLAIM ${HEALTH_CLAIM} | boundary EVALUATED: +${BOUNDARY_FAIL_MS} ms ${at80.health.verdict}; +${BOUNDARY_PASS_MS} ms ${at20.health.verdict}`
          : `CLAIM ${HEALTH_CLAIM} | boundary NOT_EVALUATED (the instrument was noisy this run): only the gross negative, COUNT and the ceiling gate decide`,
      );
      announce(
        loopEvaluated
          ? `CLAIM ${loopClaim(ctlEldMedian)} | boundary EVALUATED: +${loopBlockMs.toFixed(1)} ms ${atLoop!.eld.verdict}; +${BOUNDARY_PASS_MS} ms ${at20.eld.verdict}`
          : `CLAIM ${loopClaim(ctlEldMedian)} | boundary NOT_EVALUATED (${!loopSized && loopBlockMs > LOOP_BLOCK_CAP_MS ? `the sized block ${loopBlockMs.toFixed(1)} ms exceeds the ${LOOP_BLOCK_CAP_MS} ms cap` : "the instrument was noisy this run"}): only the gross negative, COUNT and the ceiling gate decide`,
      );

      expectTrips(neg); // on EVERY run, noisy or not: the instrument must not be blind
      expect(noisy.eld.verdict, "injected A/A noise must read NOT_EVALUATED (never red)").toBe("NOT_EVALUATED");
      if (healthEvaluated) {
        expect(at80.health.verdict, `AVAILABILITY +${BOUNDARY_FAIL_MS} ms must FAIL (d=${at80.health.d.toFixed(1)})`).toBe("FAIL");
        expect(at20.health.verdict, `AVAILABILITY +${BOUNDARY_PASS_MS} ms must PASS (d=${at20.health.d.toFixed(1)})`).toBe("PASS");
      }
      if (loopEvaluated) {
        expect(atLoop!.eld.verdict, `LOOP +${loopBlockMs.toFixed(1)} ms must FAIL (d=${atLoop!.eld.d.toFixed(1)})`).toBe("FAIL");
        expect(at20.eld.verdict, `LOOP +${BOUNDARY_PASS_MS} ms must PASS (d=${at20.eld.d.toFixed(1)})`).toBe("PASS");
      }
    });
  }, 600_000);
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
