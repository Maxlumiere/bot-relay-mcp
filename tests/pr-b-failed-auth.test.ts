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
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { Server as HttpServer } from "http";
import { monitorEventLoopDelay, PerformanceObserver } from "perf_hooks";
import { Worker } from "worker_threads";
import childProcess, { spawn } from "child_process";
import { installSyncRecorder, type SyncRecorder } from "./_helpers/sync-call-recorder.js";
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
/** A stall interval in ABSOLUTE ms (performance.timeOrigin + performance.now()), comparable across threads. */
interface Gap {
  from: number;
  to: number;
}
/** The SENTINEL's floor: gaps shorter than this are never recorded; the sentinel only judges ceiling-sized stalls. */
const GAP_FLOOR_MS = 20;
const GAP_KEEP = 4096;
/**
 * The MAIN ticker's floor (LOOP reads it): LOOP compares sizes around 5-150 ms, so it records every gap of >= 2 ms. A
 * window with no gap at or over the floor reads as the floor (2 ms).
 */
const MAIN_GAP_FLOOR_MS = 2;
/**
 * The MAIN ring's size. The gaps are disjoint and each >= MAIN_GAP_FLOOR_MS, so a span of S ms holds at most
 * S / floor + 1 of them: 65536 holds every gap of any span up to ~131 s, far past any window here (plus its settle).
 * It still FAULTS on overflow (TICKER_SRC's fault): an eviction is never a smaller max.
 */
const MAIN_GAP_KEEP = 65_536;
/**
 * THE TICKER PRIMITIVE, ONE SOURCE for every thread (the main thread, the dedicated sentinel worker, the load worker):
 * a 1 ms wall-clock ticker, running from its creation and NEVER reset, that records each gap of >= GAP_FLOOR_MS between
 * two consecutive ticks as an ABSOLUTE interval. Not monitorEventLoopDelay: MEASURED (flake f), that histogram is blind
 * to a stall landing before its first tick after enable() or reset() (a 600 ms stop read 1.3-14.0 ms; this ticker read
 * 608.7-610.3 ms). Absolute time is comparable across threads: MEASURED, a worker's stamp fell inside the main
 * thread's [send, receive] window in 3 x 2000 round trips (round trip <= 0.21 ms).
 */
const TICKER_SRC = `(function makeTicker(floor, keep, manualStart) {
  // manualStart (a number): a SCRIPTED ticker for a pure test. No interval runs; the test calls tick(now) itself, so
  // the ring's record/evict/fault logic is driven deterministically, never by a real scheduler.
  const manual = typeof manualStart === "number";
  const gaps = [];
  let last = manual ? manualStart : performance.timeOrigin + performance.now();
  let ticks = 0;
  // RING EVICTION IS A FAULT (ruling on the LOOP ticket): every eviction is counted, and the latest end of an evicted
  // gap is kept, so a snapshot that an evicted gap may overlap is refused (fault), never read as a smaller max.
  let evictions = 0;
  let evictedTo = -Infinity;
  // The ticker's OWN cost on its thread (ms spent inside its callback), REPORTED ONLY.
  let busy = 0;
  const onTick = (now) => {
    if (now - last >= floor) {
      gaps.push({ from: last, to: now });
      if (gaps.length > keep) {
        const evicted = gaps.shift();
        evictions++;
        if (evicted.to > evictedTo) evictedTo = evicted.to;
      }
    }
    last = now;
    ticks++;
    if (!manual) busy += performance.timeOrigin + performance.now() - now;
  };
  const timer = manual ? null : setInterval(() => onTick(performance.timeOrigin + performance.now()), 1);
  if (timer && timer.unref) timer.unref();
  // settled(to): resolves once a tick has landed at or after \`to\`, so every gap ending by then is RECORDED (a gap is
  // only recorded by the tick that ends it, and an overdue tick can run AFTER a pending message is handled). Bounded
  // in POLLS (each >= 1 ms of this thread running), so a host stop never spends the bound; exhausted: it rejects.
  const settled = (to, maxPolls) =>
    new Promise((resolve, reject) => {
      let polls = 0;
      const check = () => {
        if (last >= to) return resolve();
        if (++polls > maxPolls) return reject(new Error("the ticker never ticked at or after the requested end (" + maxPolls + " polls)"));
        setTimeout(check, 1);
      };
      check();
    });
  // fault(from, to): why a snapshot of [from, to] cannot be trusted (an evicted gap may overlap it), or null.
  const fault = (from, to) =>
    evictedTo > from ? "the ticker's ring evicted " + evictions + " gap(s), one ending at " + evictedTo.toFixed(1) + ", after the window opened at " + from.toFixed(1) + " (keep " + keep + "): its max cannot be trusted" : null;
  const inWindow = (from, to) => gaps.filter((g) => g.to > from && g.from < to);
  // snapshot(from, to): the sentinel's reply, ONE rule: a fault (no stream) when an evicted gap may overlap the window,
  // else the gaps. The worker replies with exactly this, and a pure test drives it through tick().
  const snapshot = (from, to) => {
    const f = fault(from, to);
    return f === null ? { gaps: inWindow(from, to) } : { fault: f };
  };
  return { gaps: inWindow, fault, snapshot, tick: onTick, evictions: () => evictions, busy: () => busy, ticks: () => ticks, lastTick: () => last, settled, stop: () => timer && clearInterval(timer) };
})`;
interface Ticker {
  gaps: (from: number, to: number) => Gap[];
  fault: (from: number, to: number) => string | null;
  /** The sentinel's reply for [from, to]: a fault (no stream) when an evicted gap may overlap it, else the gaps. */
  snapshot: (from: number, to: number) => { gaps?: Gap[]; fault?: string };
  /** A scripted tick at `now` (a manual ticker only: makeTicker(floor, keep, start)). */
  tick: (now: number) => void;
  evictions: () => number;
  busy: () => number;
  ticks: () => number;
  lastTick: () => number;
  settled: (to: number, maxPolls: number) => Promise<void>;
  stop: () => void;
}
/** How many >= 1 ms polls a judging snapshot waits for its ticker to tick past the window's end: an INSTRUMENT FAULT beyond. */
const SETTLE_POLLS = 2_000;
const makeTicker = new Function(`return ${TICKER_SRC}`)() as (floor: number, keep: number, manualStart?: number) => Ticker;
/**
 * THE PLANT'S OWN MEASURE, ONE SOURCE for the main thread and the load worker (ruling R2, "confirm stimulated"): the
 * largest gap between two consecutive clock reads of the planting thread, from just BEFORE its kill(SIGSTOP) until a
 * gap >= floorMs is seen (or maxWaitMs passes). Not the time across the kill() call: a self-SIGSTOP of a multithreaded
 * process may take effect AFTER kill() returns. MEASURED: on Linux CI (#338, Node 22) the load worker read 0.0 ms
 * across its kill() while the sentinel saw a 601.2 ms stop; locally, a stop delivered ~5 ms after kill() returned read
 * 0.0 ms across the call (3/3) and 602.4-602.6 ms on this loop; a synchronous stop read 600.8-602.7 either way.
 */
const STOP_MEASURE_SRC = `(function stopAndMeasure(kill, floorMs, maxWaitMs, clock) {
  const read = clock || (() => performance.now());
  const before = read();
  let last = before;
  let gap = 0;
  kill();
  for (;;) {
    const now = read();
    if (now - last > gap) gap = now - last;
    last = now;
    if (gap >= floorMs || now - before >= maxWaitMs) return gap;
  }
})`;
const stopAndMeasure = new Function(`return ${STOP_MEASURE_SRC}`)() as (kill: () => void, floorMs: number, maxWaitMs: number, clock?: () => number) => number;
const absNow = () => performance.timeOrigin + performance.now();

/**
 * DIAGNOSTICS (RELAY_TIMING_DIAG=1 only; REPORT ONLY, never a verdict input): who froze the main thread in a breach?
 * The daemon runs in this process, so a main-thread freeze is the daemon's synchronous work or the harness's. The
 * recorder (tests/_helpers/sync-call-recorder.ts) times every sync SQLite call, transaction, fs *Sync and sync child
 * process at or over DIAG_THRESHOLD_MS, on this clock; each breach line is followed by the recorded calls it overlaps.
 */
const DIAG_THRESHOLD_MS = 100;
/**
 * The recorder for ONE bar, or null: installed ONLY when RELAY_TIMING_DIAG=1, and runBar uninstalls it when the bar
 * ends (finally), so outside a DIAG bar nothing is patched and a normal run behaves exactly as without this code.
 */
export function diagInstall(env: NodeJS.ProcessEnv = process.env): SyncRecorder | null {
  if (env.RELAY_TIMING_DIAG !== "1") return null;
  const handle = db.getDb() as unknown as { prepare(sql: string): object };
  const rec = installSyncRecorder({
    now: absNow,
    thresholdMs: DIAG_THRESHOLD_MS,
    databaseProto: Object.getPrototypeOf(handle) as Record<string, unknown>,
    statementProto: Object.getPrototypeOf(handle.prepare("SELECT 1")) as Record<string, unknown>,
  });
  liveRecorders.add(rec);
  return rec;
}
/** Every recorder not yet uninstalled: a bar a test TIMEOUT abandons never reaches its finally; teardown cleans up. */
const liveRecorders = new Set<SyncRecorder>();
/** Uninstall every live recorder (idempotent). Registered with afterEach, so no wrapper outlives its test. */
export function diagCleanupAll(): void {
  for (const r of liveRecorders) r.uninstall();
  liveRecorders.clear();
}
afterEach(diagCleanupAll);
/** Run `fn` with a recorder for its duration (null unless RELAY_TIMING_DIAG=1): uninstalled when it settles, either way. */
export async function withDiag<T>(env: NodeJS.ProcessEnv, fn: (rec: SyncRecorder | null) => Promise<T>): Promise<T> {
  const rec = diagInstall(env);
  try {
    return await fn(rec);
  } finally {
    if (rec) {
      rec.uninstall();
      liveRecorders.delete(rec);
    }
  }
}
/** One DIAG line per located breach (every arm), naming the recorded sync calls that overlap it, or saying none did. */
export function diagLines(label: string, b: Pick<BarStats, "auth" | "control" | "control2">, rec: Pick<SyncRecorder, "overlapping" | "count">): string[] {
  const out: string[] = [];
  for (const [arm, rs] of [["auth", b.auth], ["control", b.control], ["control'", b.control2]] as const) {
    rs.forEach((r, i) => {
      for (const x of r.breaches.filter((g) => g.to - g.from >= CEILING_MS)) {
        const calls = rec.overlapping(x.from, x.to);
        out.push(
          `DIAG ${label} | arm ${arm} round ${i + 1} | ${x.kind} ${(x.to - x.from).toFixed(1)} ms | ` +
            (calls.length
              ? `${calls.length} sync call(s) >= ${DIAG_THRESHOLD_MS} ms overlap it`
              : `NO recorded sync call >= ${DIAG_THRESHOLD_MS} ms overlaps it (the block is not a recorded SQLite/fs/child-process call: widen the instrument)`),
        );
        for (const c of calls) out.push(`DIAG   - ${c.what} ${(c.to - c.from).toFixed(1)} ms [${c.detail}] at ${c.stack}`);
      }
    });
  }
  out.push(`DIAG ${label} | recorder: ${rec.count()} sync call(s) >= ${DIAG_THRESHOLD_MS} ms recorded during this bar`);
  return out;
}

/** What LOOP reads for one window, from the MAIN ticker (8). */
interface LoopReading {
  /** The largest main-thread gap overlapping the window (ms); MAIN_GAP_FLOOR_MS when none reached the floor. */
  max: number;
  /** The gaps at or over the ceiling: the loop-delay breaches the ceiling (6) judges. ONE source with `max`. */
  breaches: Gap[];
  /** How many main-thread gaps (>= the floor) overlapped the window: the ring-sizing evidence. REPORTED ONLY. */
  gapCount: number;
  /** The ticker's own callback time inside the window (ms): its cost on the daemon's loop. REPORTED ONLY. */
  tickerBusy: number;
  /** monitorEventLoopDelay's max over the same window (ms): REPORTED ONLY, for calibration, never read by a verdict. */
  histMax: number;
}

/**
 * LOOP's instrument for ONE window, on the never-reset MAIN ticker (8), opened at the window's start: `close()` marks
 * its end, `read()` waits until the ticker has ticked past that end (a gap is recorded only by the tick that ends
 * it) and reads the window. A stall that lands right after `open`, before any tick of a fresh histogram, is still a
 * gap here (MEASURED: a 300 ms block right after enable() read 1.3 ms on the histogram, 300.1-301.5 ms on the ticker).
 * The histogram rides along, REPORTED ONLY. An evicted gap that may overlap the window is an INSTRUMENT FAULT.
 */
function openLoopWindow(ticker: Ticker): { from: number; close: () => void; read: () => Promise<LoopReading> } {
  const busyAtOpen = ticker.busy();
  const hist = monitorEventLoopDelay({ resolution: 1 });
  hist.enable();
  const from = absNow();
  let to = 0;
  let busyAtClose = 0;
  const close = () => {
    if (to) return;
    to = absNow();
    busyAtClose = ticker.busy();
    hist.disable();
  };
  const read = async (): Promise<LoopReading> => {
    close();
    await ticker.settled(to, SETTLE_POLLS).catch((err: Error) => {
      throw new Error(`INSTRUMENT FAULT: the main-thread ticker did not tick past the window's end (${err.message})`);
    });
    const fault = ticker.fault(from, to);
    if (fault !== null) throw new Error(`INSTRUMENT FAULT: LOOP's main-thread ticker: ${fault}`);
    const gaps = ticker.gaps(from, to);
    return {
      max: gaps.reduce((mx, g) => Math.max(mx, g.to - g.from), MAIN_GAP_FLOOR_MS),
      breaches: gaps.filter((g) => g.to - g.from >= CEILING_MS),
      gapCount: gaps.length,
      tickerBusy: busyAtClose - busyAtOpen,
      histMax: hist.max / 1e6,
    };
  };
  return { from, close, read };
}

const LOAD_WORKER = `
const { parentPort, workerData } = require("worker_threads");
const { port, n, kind, tool, args, ceilingMs, workerStallMs, prepHostStallHelperPid, prepStopFloorMs } = workerData;
const stopAndMeasure = (${STOP_MEASURE_SRC});
// A LIVE-RED knob only (#332 R2 P2b): stop the WHOLE process right after the FIRST /health request is issued, BEFORE
// the window opens. The helper (a recorded pid > 1, armed by the test) resumes it; the request then spans the stop.
let prepStall = prepHostStallHelperPid > 1;
let prepStopMs = null;
const abs = () => performance.timeOrigin + performance.now();
// The LOAD worker's own gaps: REPORTED ONLY. It is busy (the calls, its own GC), so its gaps never exempt a breach
// (architect ruling on #332 R1 P1 #1): only the DEDICATED idle sentinel can.
const own = (${TICKER_SRC})(${GAP_FLOOR_MS}, ${GAP_KEEP});
const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
const call = () => fetch("http://127.0.0.1:" + port + "/mcp", {
  method: "POST",
  headers: Object.assign({ "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, kind === "auth" ? { "X-Agent-Token": hex() } : {}),
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: kind === "auth" ? { name: tool, arguments: args } : { name: "register_agent", arguments: {} } }),
}).then(async (r) => (await r.text(), r.status));
(async () => {
  let healthMax = 0, done = false;
  const healthBreaches = []; // every /health sample at or over the ceiling, as an absolute interval
  const sampler = (async () => {
    while (!done) {
      const t = performance.now();
      const at = abs();
      const req = fetch("http://127.0.0.1:" + port + "/health").then((r) => r.text());
      if (prepStall) {
        prepStall = false;
        process.kill(prepHostStallHelperPid, "SIGUSR2");
        // The plant's own length, as this thread saw it (STOP_MEASURE_SRC; verified by the test).
        prepStopMs = stopAndMeasure(() => process.kill(process.pid, "SIGSTOP"), prepStopFloorMs, prepStopFloorMs + 1000);
      }
      await req;
      const ms = performance.now() - t;
      healthMax = Math.max(healthMax, ms);
      if (ms >= ceilingMs) healthBreaches.push({ from: at, to: at + ms });
      await new Promise((r) => setTimeout(r, 10));
    }
  })();
  await new Promise((r) => setTimeout(r, 50));
  const stop = new Promise((r) => parentPort.once("message", r));
  const opened = abs();
  parentPort.postMessage({ started: true });
  // A LIVE-RED knob only (#332 R1): this LOAD worker busy for workerStallMs as the window opens, a worker-only stall.
  if (workerStallMs > 0) {
    const end = performance.now() + workerStallMs;
    while (performance.now() < end) {}
  }
  const statuses = n > 0 ? await Promise.all(Array.from({ length: n }, call)) : (await new Promise((r) => setTimeout(r, 300)), []);
  // The window stays open (and /health keeps being sampled) until the parent says stop: a POOL-LOADED control's
  // window must span its pool work, not just its requests.
  parentPort.postMessage({ loaded: true, statuses });
  await stop;
  done = true;
  await sampler;
  const loadGapMax = own.gaps(opened, abs()).reduce((m, g) => Math.max(m, g.to - g.from), 0);
  own.stop();
  parentPort.postMessage({ healthMax, healthBreaches, loadGapMax, prepStopMs });
})();
`;

interface Load {
  kind: "auth" | "control" | "idle";
  n: number;
  tool?: string;
  args?: Record<string, unknown>;
  /** A LIVE-RED knob only: the LOAD worker busy this long as the window opens (a worker-only stall). */
  workerStallMs?: number;
  /** A LIVE-RED knob only: the LOAD worker stops the whole process during PREPARATION; this armed helper resumes it. */
  prepHostStallHelperPid?: number;
  /** With prepHostStallHelperPid: the gap the worker's own measure waits for (the plant - the tolerance). */
  prepStopFloorMs?: number;
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
  /**
   * LOOP: the largest gap (ms) of the never-reset MAIN ticker overlapping the window (openLoopWindow): the DAEMON's loop
   * blocking (a bcrypt on it is ~64 ms). The name is historical (it was the event-loop-delay histogram's max).
   */
  eldMax: number;
  /** The event-loop-delay histogram's max over the same window: REPORTED ONLY (calibration), never read by a verdict. */
  eldHist: number;
  /** How many main-ticker gaps (>= 2 ms) overlapped the window, and the ticker's own time in it: REPORTED ONLY. */
  mainGapCount: number;
  tickerBusy: number;
  /** How many of the load's calls the per-IP cap shed (429) before the MCP cycle. */
  shed: number;
  /**
   * Every stall the ceiling (6) judges, as ABSOLUTE intervals: each /health sample at or over the ceiling (the load
   * worker), and each main-thread gap of the never-reset main ticker at or over it (the daemon's loop).
   */
  breaches: Array<Gap & { kind: "/health" | "loop-delay" }>;
  /**
   * THE SENTINEL's stream: the DEDICATED, otherwise-idle sentinel worker's gaps overlapping the window (absolute).
   * Missing (not an array) is an INSTRUMENT FAULT, never a pass.
   */
  sentinelGaps?: Gap[];
  /** The largest sentinel gap in the window (ms), for the BAR line. */
  sentinelMax: number;
  /** The LOAD worker's own largest gap (ms): REPORTED ONLY, it never exempts a breach. */
  loadGapMax: number;
  /** Why the sentinel stream is missing, when it is (its snapshot never settled): carried into the INSTRUMENT FAULT. */
  sentinelFault?: string;
  /** When the measured window opened (absolute ms); /health samples may start before it (see measureWindow). */
  windowFrom: number;
  /**
   * The longest GC pause (ms) on the MAIN thread inside the window (flake f, Phase 0): REPORTED ONLY. The daemon
   * runs in the test's own isolate, so the harness's GC lands on the daemon's loop; this separates "a GC pause"
   * from "the code" when a main-thread stall shows up.
   */
  gcMax: number;
  /** A POOL-LOADED control only: its pool work INSIDE the measured window (see measure). */
  pool?: PoolOccupancy;
  /** The PREPARATION plant only: the load worker's own time across its SIGSTOP (the plant, verified by its test). */
  prepStopMs?: number;
  /** T-A, REPORT ONLY (no verdict reads it): this window's process-wide counters (procCounters). */
  proc?: ProcCounters;
  /** Why `proc` is absent (measureWindow sets one or the other for every reading it takes). */
  procWhy?: string;
}

/**
 * T-A's instrument, REPORT ONLY (ruling: the contention VERDICT is parked; this lands so a breach carries its evidence).
 * process.resourceUsage() over one window: voluntary and involuntary context switches, and CPU time (user + system)
 * against wall time. PROCESS-WIDE: they include every worker thread (the sentinel, the load worker, the pool), never
 * the main thread alone. No verdict and no threshold use them.
 */
export interface ProcCounters {
  volCs: number;
  invCs: number;
  cpuMs: number;
  wallMs: number;
}
const procNow = () => ({ ru: process.resourceUsage(), at: performance.now() });
const procDelta = (a: ReturnType<typeof procNow>, b: ReturnType<typeof procNow>): ProcCounters => ({
  volCs: b.ru.voluntaryContextSwitches - a.ru.voluntaryContextSwitches,
  invCs: b.ru.involuntaryContextSwitches - a.ru.involuntaryContextSwitches,
  cpuMs: (b.ru.userCPUTime + b.ru.systemCPUTime - a.ru.userCPUTime - a.ru.systemCPUTime) / 1000,
  wallMs: b.at - a.at,
});
/** Never a bare "not recorded": a reading without counters says why (a reading built outside measureWindow, e.g. a
 * replayed CI log, names its source; one with no reason at all says that it has none). */
export const fmtProc = (p?: ProcCounters, why?: string) =>
  p
    ? `process-wide counters: voluntary cs ${p.volCs}, involuntary cs ${p.invCs}, CPU ${p.cpuMs.toFixed(1)} ms of ${p.wallMs.toFixed(1)} ms wall`
    : `process-wide counters: not recorded: ${why?.trim() || "this reading was not taken by measureWindow and names no reason"}`;

/**
 * Run `load` from a worker while timing the daemon's loop; `onLoop` runs ON the daemon's loop once the load has
 * started; `poolWork` (the POOL-LOADED control) starts at the same moment and is finished before this returns.
 */
/** The MAIN thread's ticker (the daemon's loop) and the DEDICATED sentinel worker: created once, never reset. */
let mainTicker: Ticker | null = null;
interface Sentinel {
  worker: Worker;
  ask: (from: number, to: number) => Promise<{ gaps?: Gap[]; fault?: string }>;
}
let sentinel: Sentinel | null = null;
const SENTINEL_WORKER = `
const { parentPort, workerData } = require("worker_threads");
const t = (${TICKER_SRC})(${GAP_FLOOR_MS}, workerData.keep);
parentPort.on("message", (m) => {
  if (m.arm) {
    const armed = () => (t.ticks() >= 2 ? parentPort.postMessage({ armed: true }) : setTimeout(armed, 1));
    armed();
    return;
  }
  // ARMED FOR THIS SNAPSHOT (Codex R2 P2a): reply only once a tick has landed at or after the requested end.
  // RING EVICTION IS A FAULT: an evicted gap that may overlap the snapshot is never a missing cover.
  t.settled(m.to, ${SETTLE_POLLS}).then(
    () => parentPort.postMessage({ id: m.id, ...t.snapshot(m.from, m.to) }),
    (err) => parentPort.postMessage({ id: m.id, fault: String((err && err.message) || err) }),
  );
});
`;
/**
 * ARM, CONFIRM ARMED, THEN STIMULATE: both tickers exist and have ticked at least twice before any window opens, so
 * no stall can land before a first tick. The sentinel does nothing else: an INDEPENDENT, otherwise-idle thread.
 */
async function armInstruments(): Promise<void> {
  if (!mainTicker) mainTicker = makeTicker(MAIN_GAP_FLOOR_MS, MAIN_GAP_KEEP);
  while (mainTicker.ticks() < 2) await new Promise((r) => setTimeout(r, 1));
  if (!sentinel) sentinel = await startSentinel(GAP_KEEP);
}

/** Start a DEDICATED sentinel worker (ring of `keep` gaps) and return once it is ARMED (it has ticked twice). */
async function startSentinel(keep: number): Promise<Sentinel> {
  const worker = new Worker(SENTINEL_WORKER, { eval: true, workerData: { keep } });
  worker.unref();
  let seq = 0;
  const pending = new Map<number, (g: { gaps?: Gap[]; fault?: string }) => void>();
  worker.on("message", (m: { id?: number; gaps?: Gap[]; fault?: string }) => {
    if (m.id !== undefined) {
      pending.get(m.id)?.({ gaps: m.gaps, fault: m.fault });
      pending.delete(m.id);
    }
  });
  await new Promise<void>((res, rej) => {
    worker.once("error", rej);
    const onArmed = (m: { armed?: true }) => {
      if (!m.armed) return;
      worker.off("message", onArmed);
      res();
    };
    worker.on("message", onArmed);
    worker.postMessage({ arm: true });
  });
  const send = <T,>(msg: Record<string, unknown>) =>
    new Promise<T>((res) => {
      const id = ++seq;
      pending.set(id, res as (g: { gaps?: Gap[]; fault?: string }) => void);
      worker.postMessage({ id, ...msg });
    });
  return {
    worker,
    ask: (from, to) => send({ from, to }),
  };
}

/**
 * `onOpen` (a LIVE-RED knob only): runs SYNCHRONOUSLY as the window opens, before any tick of a freshly enabled
 * histogram: the stall the LOOP ticket names. `onLoop` runs 5 ms later, mid-window.
 */
async function measureWindow(port: number, load: Load, onLoop?: () => void, poolWork?: PoolWork, onOpen?: () => void): Promise<Reading> {
  await armInstruments();
  let pool: Promise<unknown> = Promise.resolve();
  let t0Abs = 0;
  let t1Abs = 0;
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
  let loopWindow: ReturnType<typeof openLoopWindow> | null = null;
  let procAtOpen: ReturnType<typeof procNow> | null = null;
  let procAtClose: ReturnType<typeof procNow> | null = null;
  // Every main-thread GC entry is kept; the ones that START inside [t0, t1] are the window's (entries are delivered
  // after the pause, so the observer stays connected until the reading is built).
  const gcs: Array<[number, number]> = [];
  const gcObs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) gcs.push([e.startTime, e.duration]);
  });
  gcObs.observe({ entryTypes: ["gc"] });
  const worker = new Worker(LOAD_WORKER, { eval: true, workerData: { port, n: load.kind === "idle" ? 0 : load.n, kind: load.kind, tool: load.tool, args: load.args, ceilingMs: CEILING_MS, workerStallMs: load.workerStallMs ?? 0, prepHostStallHelperPid: load.prepHostStallHelperPid ?? 0, prepStopFloorMs: load.prepStopFloorMs ?? 0 } });
  try {
    return await new Promise<Reading>((resolve, reject) => {
      let statuses: number[] = [];
      let t1 = 0;
      worker.on("error", reject);
      worker.on("message", (m: { started?: true; loaded?: true; healthMax?: number; healthBreaches?: Gap[]; loadGapMax?: number; prepStopMs?: number | null; statuses?: number[] }) => {
        if (m.started) {
          t0 = performance.now();
          t0Abs = absNow();
          loopWindow = openLoopWindow(mainTicker!);
          procAtOpen = procNow();
          if (onOpen) onOpen();
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
              t1Abs = absNow();
              loopWindow!.close();
              procAtClose = procNow();
              worker.postMessage("stop");
            },
            reject,
          );
          return;
        }
        const gcMax = gcs.filter(([at]) => at >= t0 && at <= t1).reduce((mx, [, dur]) => Math.max(mx, dur), 0);
        const tEnd = absNow(); // the /health sampler ran until now
        void (async () => {
          // (Codex R2 P2b) The /health sampler starts BEFORE the window opens, and healthMax (the ruled AVAILABILITY
          // reading) keeps every sample since then. So the sentinel is asked over the ENVELOPE of every included
          // sample, not from t0: cutting the samples to the window instead would leave a healthMax >= 500 ms with no
          // located breach, which (6) reads as a freeze.
          const healthBreaches = m.healthBreaches ?? [];
          const askFrom = Math.min(t0Abs, ...healthBreaches.map((g) => g.from));
          const asked = await sentinel!.ask(askFrom, tEnd);
          // (Codex R2 P2a) The main ticker too: a gap is recorded only by the tick that ends it (read() settles first).
          const loop = await loopWindow!.read();
          const sentinelGaps = asked.gaps;
          const reading: Reading = {
            healthMax: m.healthMax!,
            eldMax: loop.max,
            eldHist: loop.histMax,
            mainGapCount: loop.gapCount,
            tickerBusy: loop.tickerBusy,
            shed: statuses.filter((s) => s === 429).length,
            breaches: [...healthBreaches.map((g) => ({ ...g, kind: "/health" as const })), ...loop.breaches.map((g) => ({ ...g, kind: "loop-delay" as const }))],
            sentinelGaps,
            ...(asked.fault ? { sentinelFault: asked.fault } : {}),
            sentinelMax: (sentinelGaps ?? []).reduce((mx, g) => Math.max(mx, g.to - g.from), 0),
            windowFrom: t0Abs,
            loadGapMax: m.loadGapMax ?? 0,
            gcMax,
          };
          if (poolWork) reading.pool = occupancy(spans, t0, t1);
          if (typeof m.prepStopMs === "number") reading.prepStopMs = m.prepStopMs;
          if (procAtOpen && procAtClose) reading.proc = procDelta(procAtOpen, procAtClose);
          else reading.procWhy = `measureWindow took no ${procAtOpen ? "closing" : "opening"} snapshot (process.resourceUsage)`;
          resolve(reading);
        })().catch(reject);
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
 *       FAIL: no code defect was measured. The retry machinery's own SELF-TEST (the ceiling's host stall in attempt 1
 *       only) asserts what that machinery did and REPORTS the deciding verdict: NOT CAUGHT there, by design, is a FAIL
 *       of its live, unplanted re-run (the gate's own bars judge live readings). Every PLANTED stall is verified before
 *       its verdict is asserted; one that did not land is a FIXTURE_FAULT (hostStallPlantFault, freezePlantFault).
 *   (5) NEGATIVE CONTROLS, sized from the RULED CONSTANTS and the SAME run's CONTROL arm, never from a pre-run
 *       measurement or the arm under test: a GROSS block of +200 ms in every auth burst must TRIP on EVERY run, a
 *       noisy one too (else RED: the instrument is blind); and on every EVALUATED run, the BOUNDARY PAIRS: a block of
 *       80 ms + this run's median control max (per instrument; see CLAIMS) must FAIL and +20 ms (0.4 x the effect
 *       size, FIXED) must PASS, proving discrimination at the threshold on that runner.
 *   (6) The 500 ms per-reading ceiling is an always-on freeze detector, gated by the SENTINEL, PER BREACH (ruling of
 *       2026-10-21, superseding the 13 Oct coverage predicate and its fitted slack): a /health sample or a main-loop
 *       gap at or over the ceiling is charged to the daemon only for its UNCOVERED time, its length minus its overlap
 *       with the UNION of the DEDICATED idle sentinel's gaps (the host's share). FAIL iff that uncovered time is itself
 *       >= the ceiling (500 ms), final; otherwise NOT_EVALUATED ((4) applies). So a touch, a matching magnitude at
 *       another time, or a stall of the busy LOAD worker (never the sentinel) leaves the whole breach uncovered: a
 *       FREEZE, FAIL. STATED NOT-CAUGHT: a daemon freeze of F ms overlapping sentinel gaps of G ms reads NOT_EVALUATED
 *       when F - G < 500 (e.g. a 510 ms freeze beside a routine 20 ms gap): the host's share is real, and a
 *       NOT_EVALUATED never passes (three in a row is a blocking FINAL NOT_EVALUATED). A main-thread-only stall
 *       (GC included) is charged like any breach: the idle sentinel does not stall with it, so it is wholly uncovered
 *       and FAILs once it reaches 500 ms, unless a sentinel gap overlaps it enough to leave < 500 ms (the NOT-caught
 *       case above).
 *       A reading with no sentinel is an INSTRUMENT FAULT, never a pass. MEASURED (flake f, Phase 0, 9 CI job logs):
 *       Phase 0's sentinel attributed 0 of the 20 unplanted runner stalls seen (max 156.1 ms). That sentinel was an
 *       event-loop-delay histogram, since replaced (8) because it is blind to a stall before its first tick in each
 *       window, so the 0 of 20 holds only for stalls after that tick. This guard is for a TRUE host stall only and
 *       claims nothing about those stalls.
 *   (7) Every BAR line reports median d, median |a|, the effect size, the verdict and the resolution.
 *   (8) ARM, CONFIRM ARMED, THEN STIMULATE: the instruments of (6) AND LOOP are ONE ticker primitive (TICKER_SRC: 1 ms,
 *       never reset, absolute intervals) on the main thread and in a DEDICATED, otherwise-idle sentinel worker, both
 *       created once and confirmed ticking before any window opens. LOOP reads the MAIN ticker's largest gap in the
 *       window (floor 2 ms; the sentinel's floor is 20 ms), so a stall right as a window opens is seen: the
 *       event-loop-delay histogram it replaced was blind before its first tick after enable(). A ring that evicted a
 *       gap the snapshot may overlap is an INSTRUMENT FAULT, never a smaller max or a missing cover. Each reading
 *       carries its breach intervals and the sentinel's gaps. Also REPORTED ONLY, never read by a verdict: the
 *       histogram's max (calibration, for one release), the main ticker's gap count and own time per window, the load
 *       worker's own largest gap (it is busy, so it never exempts) and the longest main-thread GC pause (the daemon
 *       shares the test's isolate).
 * A pool-loaded bar's controls (both of them) must also prove their occupancy (expectControlLoaded).
 *
 * CLAIMS, stated per instrument and reported per run (architect, LOOP boundary sizing):
 *   - AVAILABILITY (/health): healthMax is a MAX too, so the same holds (MEASURED, flake f: a fixed +80 read
 *     d = 49.4-63.1 on macOS, whose control maxes run 41-54 ms). Claim: "a paired effect >= 50 ms is detected; the
 *     discrimination block = 80 + this run's median control /health max (reported per run)", sized and capped
 *     exactly as LOOP's below. Its PASS block stays +20.
 *   - LOOP (the main ticker's largest gap, (8)): it is a MAX, so an injected stall B lands as d ~= B - (the control's own
 *     max), not +B: a fixed +80 read only 56-60 on CI (then on the histogram), hugging the threshold. Its FAIL block
 *     is therefore 1.6 x 50 + the SAME run's median control ELD max (taken from the +20 bar, after its A/A-quiet
 *     check), capped at 200 ms (over the cap: that boundary is NOT_EVALUATED). Claim: "the median of 9 paired rounds detects a synchronous stall
 *     repeated in each auth burst of >= 50 ms + this run's median control ELD max (reported per run)". PASS block: +20.
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
const healthClaim = (controlMedian: number) =>
  `AVAILABILITY: a paired effect >= ${EFFECT_MS} ms is detected; the discrimination block = ${BOUNDARY_FAIL_MS} ms + this run's median control /health max (${controlMedian.toFixed(1)} ms) = ${(BOUNDARY_FAIL_MS + controlMedian).toFixed(1)} ms`;
const loopClaim = (controlMedian: number) =>
  `LOOP: the median of ${K} paired rounds detects a synchronous stall repeated in each auth burst of >= ${EFFECT_MS} ms + this run's median control ELD max (${controlMedian.toFixed(1)} ms), i.e. >= ${(EFFECT_MS + controlMedian).toFixed(1)} ms (read on the main ticker, a stall as the window opens included)`;
const NOISE_LIMIT_MS = EFFECT_MS / 2;
const CEILING_MS = 500;
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const list = (xs: number[]) => xs.map((x) => x.toFixed(1)).join("/");
/**
 * The unrounded tail (from the #332 replay): the BAR line prints each value with toFixed(1), so a median just over a
 * threshold can print as the threshold itself, and a replay from the log then judges rounded inputs the gate never saw.
 * The tail carries, as JSON, exactly the values the gate judged (each arm's healthMax and eldMax) and its outputs.
 */
export function exactTail(b: { auth: Reading[]; control: Reading[]; control2: Reading[]; health: InstrumentVerdict; eld: InstrumentVerdict }): string {
  const arm = (rs: Reading[]) => ({ health: rs.map((r) => r.healthMax), eld: rs.map((r) => r.eldMax) });
  const out = ({ d, noise, verdict }: InstrumentVerdict) => ({ d, noise, verdict });
  return ` | exact ${JSON.stringify({ auth: arm(b.auth), control: arm(b.control), control2: arm(b.control2), judged: { health: out(b.health), eld: out(b.eld) } })}`;
}

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

/** How long two absolute intervals overlap (ms; 0 when they only touch or are apart). */
const overlapMs = (a: Gap, b: Gap) => Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from));

/** How much of `b` the UNION of `gaps` covers (ms): overlapping gaps are merged first, so no time counts twice. */
export function unionOverlapMs(b: Gap, gaps: Gap[]): number {
  const parts = gaps
    .map((g) => ({ from: Math.max(g.from, b.from), to: Math.min(g.to, b.to) }))
    .filter((x) => x.to > x.from)
    .sort((x, y) => x.from - y.from);
  let total = 0;
  let cur: Gap | null = null;
  for (const x of parts) {
    if (cur && x.from <= cur.to) cur.to = Math.max(cur.to, x.to);
    else {
      if (cur) total += cur.to - cur.from;
      cur = { ...x };
    }
  }
  return cur ? total + (cur.to - cur.from) : total;
}

/**
 * (6) THE CEILING, pure, PER BREACH (ruling of 2026-10-21). A breach is a /health sample or a main-loop gap at or over the
 * ceiling. Its UNCOVERED time = its length - its overlap with the UNION of the dedicated sentinel's gaps. FAIL iff the
 * uncovered time is >= CEILING_MS (a freeze the host does not explain), final; else NOT_EVALUATED. No fitted slack. A
 * /health reading at or over the ceiling with no sample interval to locate it cannot be covered: a freeze. (LOOP's
 * reading and its loop-delay breaches are ONE source, the main ticker's gaps, so a loop reading over the ceiling always
 * carries its breach.) No sentinel stream: an INSTRUMENT FAULT.
 */
export function ceilingVerdict(label: string, readings: Array<Pick<Reading, "healthMax" | "eldMax" | "breaches" | "sentinelGaps"> & { sentinelFault?: string; proc?: ProcCounters; procWhy?: string }>): { verdict: Verdict; why: string } {
  const freezes: string[] = [];
  const hostStalls: string[] = [];
  readings.forEach((r, i) => {
    if (!Array.isArray(r.sentinelGaps)) {
      throw new Error(`INSTRUMENT FAULT (${label}): reading ${i + 1} has no sentinel stream${r.sentinelFault ? ` (${r.sentinelFault})` : ""}, so the exemption rule cannot be applied; no ceiling verdict is possible`);
    }
    const breaches = r.breaches.filter((b) => b.to - b.from >= CEILING_MS);
    if (r.healthMax >= CEILING_MS && !breaches.some((b) => b.kind === "/health")) {
      freezes.push(`round ${i + 1} /health ${r.healthMax.toFixed(1)} ms with no sample interval to locate it (it cannot be covered); ${fmtProc(r.proc, r.procWhy)}`);
    }
    for (const b of breaches) {
      const ms = b.to - b.from;
      const covered = unionOverlapMs(b, r.sentinelGaps);
      const uncovered = ms - covered;
      // T-A (parked): a breach the sentinel does not overlap at all says so, with the window's counters (report only).
      const tA = covered === 0 ? "; no sentinel overlap: a daemon freeze or unseen contention (T-A parked)" : "";
      const at = `round ${i + 1} ${b.kind} ${ms.toFixed(1)} ms, the sentinel covers ${covered.toFixed(1)} ms of it, uncovered ${uncovered.toFixed(1)} ms (a freeze iff >= ${CEILING_MS})${tA}; ${fmtProc(r.proc, r.procWhy)}`;
      (uncovered >= CEILING_MS ? freezes : hostStalls).push(at);
    }
  });
  if (freezes.length) return { verdict: "FAIL", why: `a single reading over the ${CEILING_MS} ms ceiling NOT covered by the sentinel's own stall (a freeze: its UNCOVERED time is itself over the ceiling): ${freezes.join("; ")}` };
  if (hostStalls.length) return { verdict: "NOT_EVALUATED", why: `over the ${CEILING_MS} ms ceiling but COVERED by the sentinel's own stall: a sentinel-covered breach, NOT_EVALUATED under the exemption rule (6) (its uncovered time is under the ceiling; coverage is the rule, not proof of the cause): ${hostStalls.join("; ")}` };
  return { verdict: "PASS", why: "" };
}

/**
 * T-A's breach diagnostics, REPORT ONLY (review R1): one line for EVERY breached reading of EVERY arm (auth, control,
 * control'), independent of which verdict the ceiling picks: a covered breach next to a FAIL, or a control-arm breach
 * (the ceiling judges the auth arm only), still carries its round, its sizes and its process-wide counters.
 */
export function breachDiagnostics(label: string, b: Pick<BarStats, "auth" | "control" | "control2">): string[] {
  const out: string[] = [];
  for (const [arm, rs] of [["auth", b.auth], ["control", b.control], ["control'", b.control2]] as const) {
    rs.forEach((r, i) => {
      const located = r.breaches.filter((x) => x.to - x.from >= CEILING_MS);
      for (const x of located) {
        const ms = x.to - x.from;
        const covered = Array.isArray(r.sentinelGaps) ? unionOverlapMs(x, r.sentinelGaps) : null;
        const cov = covered === null ? "no sentinel stream" : `the sentinel covers ${covered.toFixed(1)} ms, uncovered ${(ms - covered).toFixed(1)} ms${covered === 0 ? " (no sentinel overlap)" : ""}`;
        out.push(`BREACH ${label} | arm ${arm} round ${i + 1} | ${x.kind} ${ms.toFixed(1)} ms, ${cov} | ${fmtProc(r.proc, r.procWhy)}`);
      }
      if (r.healthMax >= CEILING_MS && !located.some((x) => x.kind === "/health")) {
        out.push(`BREACH ${label} | arm ${arm} round ${i + 1} | /health ${r.healthMax.toFixed(1)} ms with no sample interval to locate it | ${fmtProc(r.proc, r.procWhy)}`);
      }
    });
  }
  return out;
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
/** An attempt's VERDICT, in words: an evaluated attempt that held is a PASS (EVALUATED is its status, not its verdict). */
export const verdictOf = (status: Outcome["status"]): "PASS" | "FAIL" | "NOT_EVALUATED" => (status === "EVALUATED" ? "PASS" : status);

export async function untilEvaluated<T>(label: string, attempt: (n: number) => Promise<T>, outcome: (t: T) => Outcome): Promise<Attempts<T>> {
  const history: Outcome[] = [];
  for (let n = 1; ; n++) {
    const result = await attempt(n);
    const o = outcome(result);
    history.push(o);
    if (o.status !== "NOT_EVALUATED" || n >= MAX_ATTEMPTS) {
      if (n > 1 || o.status === "NOT_EVALUATED") {
        announce(`ATTEMPTS ${label} | ${history.map((h, i) => `#${i + 1} ${verdictOf(h.status)}`).join(", ")} | decided by attempt ${n}: ${verdictOf(o.status)}`);
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
 * ARM, CONFIRM ARMED, STIMULATE, CONFIRM STIMULATED (ruling on the #332 self-test, R2): a planted stall is VERIFIED
 * before any verdict it was planted to produce is asserted. Tolerance: 50 ms, fixed (= the resolution). MEASURED:
 * a planted 600 ms self-SIGSTOP read 600.9-603.3 ms on the main thread and on every worker (10/10, local macOS).
 * A plant that did not land is a FIXTURE_FAULT: the test throws (the step fails, loudly), it is NEVER re-run
 * (re-running a broken plant is best-of-N over the fixture), and it is never reported as a FAIL of the code
 * (scripts/timing-bars-report.mjs reports it as its own class).
 */
export const PLANT_TOLERANCE_MS = EFFECT_MS;
const perThread = (r: Pick<Reading, "sentinelMax" | "loadGapMax" | "eldMax" | "eldHist" | "healthMax">) =>
  `sentinel ${r.sentinelMax.toFixed(1)} ms, load worker ${r.loadGapMax.toFixed(1)} ms, main ticker ${r.eldMax.toFixed(1)} ms, histogram ${r.eldHist.toFixed(1)} ms, /health ${r.healthMax.toFixed(1)} ms`;
type PlantReading = Pick<Reading, "sentinelMax" | "loadGapMax" | "eldMax" | "eldHist" | "healthMax"> & { sentinelGaps?: Gap[]; breaches?: Reading["breaches"] };
/** A whole-process host stall: the planting thread's own time across its SIGSTOP AND the sentinel's gap, both >= the plant - 50. */
export function hostStallPlantFault(label: string, stallMs: number, stopMs: number | null, stalled: PlantReading): string | null {
  const floor = stallMs - PLANT_TOLERANCE_MS;
  if (stopMs !== null && stopMs >= floor && stalled.sentinelMax >= floor) return null;
  return `FIXTURE_FAULT (${label}): the planted ${stallMs} ms whole-process stop did not land as planted (each of the next two must be >= ${floor} ms): the planting thread across its own SIGSTOP ${stopMs === null ? "never measured (the plant never fired)" : `${stopMs.toFixed(1)} ms`}; ${perThread(stalled)}. NOT a failure of the code: the fixture is broken, so this attempt is not re-run.`;
}
/** A planted block's own absolute interval (absNow at its start and end), or null when it never ran. */
export type PlantSpan = { from: number; to: number } | null;
/**
 * A daemon freeze: the block's own duration >= the plant - 50, with the sentinel QUIET ON THE FREEZE. The freeze's breach
 * is the loop-delay breach that CONTAINS the plant's own absolute interval (the main ticker's gap spans the block: its
 * last tick before, its first tick after), never merely the longest breach in the round: an unrelated covered stall
 * must not fault a plant that landed, and an unrelated uncovered one must not validate a plant that did not. It is
 * charged under (6) exactly as the verdict charges it (its length - unionOverlapMs with the sentinel's gaps) and must
 * stay >= the ceiling. Never the round's TOTAL of sentinel gaps: routine sentinel gaps of 20-160 ms that do not overlap
 * the freeze would raise a FIXTURE_FAULT on a plant that landed (a new false red).
 */
export function freezePlantFault(label: string, stallMs: number, plant: PlantSpan, stalled: PlantReading): string | null {
  const floor = stallMs - PLANT_TOLERANCE_MS;
  const blockMs = plant ? plant.to - plant.from : null;
  const freeze = plant ? (stalled.breaches ?? []).find((b) => b.kind === "loop-delay" && b.from <= plant.from && b.to >= plant.to) : undefined;
  const covered = freeze ? unionOverlapMs(freeze, stalled.sentinelGaps ?? []) : null;
  const uncovered = freeze && covered !== null ? freeze.to - freeze.from - covered : null;
  if (blockMs !== null && blockMs >= floor && uncovered !== null && uncovered >= CEILING_MS) return null;
  const where = freeze ? `its loop-delay breach ${(freeze.to - freeze.from).toFixed(1)} ms, the sentinel covering ${covered!.toFixed(1)} ms of it (uncovered ${uncovered!.toFixed(1)} ms; must be >= ${CEILING_MS})` : "no located loop-delay breach containing the plant";
  return `FIXTURE_FAULT (${label}): the planted ${stallMs} ms daemon freeze did not land as planted (the block must be >= ${floor} ms and the sentinel quiet on it): block ${blockMs === null ? "never ran" : `${blockMs.toFixed(1)} ms`}; ${where}; ${perThread(stalled)}. NOT a failure of the code: the fixture is broken, so this attempt is not re-run.`;
}

/**
 * THE RETRY SELF-TEST's assertion (ruling R1): what the retry machinery DID, never what a LIVE re-run read. Attempt 1
 * (planted) is a covered NOT_EVALUATED; it was re-run; the decision is the FIRST evaluated attempt (every earlier one
 * NOT_EVALUATED); nothing is kept from attempt 1 (the result is the deciding attempt's own bar). The deciding verdict
 * is REPORTED, never asserted: an unplanted re-run is a live reading of this runner (a natural breach FAILs it, as the
 * gate must). NOT CAUGHT HERE, by design: a FAIL of that live re-run; the gate's own bars judge live readings.
 */
export function expectRetrySelfTest(label: string, a: Attempts<BarStats>, bars: BarStats[]): void {
  expect(a.history[0].status, `${label}: attempt 1 (planted): ${a.history[0].why.join("; ")}`).toBe("NOT_EVALUATED");
  expect(a.history[0].why.join(" "), `${label}: attempt 1 is COVERED by the dedicated sentinel`).toMatch(/COVERED by the sentinel's own stall: a sentinel-covered breach, NOT_EVALUATED under the exemption rule/);
  expect(a.attempts, `${label}: a NOT_EVALUATED attempt is re-run`).toBeGreaterThanOrEqual(2);
  expect(a.history.slice(0, -1).map((h) => h.status), `${label}: every attempt before the deciding one was NOT_EVALUATED`).toEqual(Array(a.attempts - 1).fill("NOT_EVALUATED"));
  expect(a.final, `${label}: the decision is the last attempt run`).toBe(a.history[a.attempts - 1]);
  expect(bars.length, `${label}: one bar per attempt`).toBe(a.attempts);
  expect(a.result, `${label}: the result is the DECIDING attempt's own bar`).toBe(bars[a.attempts - 1]);
  expect(a.result, `${label}: nothing is kept from attempt 1`).not.toBe(bars[0]);
  announce(`SELF-TEST ${label} | decided by attempt ${a.attempts}: ${verdictOf(a.final.status)} (unplanted; REPORTED, not asserted: a live reading of this runner)${a.final.why.length ? ` | ${a.final.why.join("; ")}` : ""}`);
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

type Instr = "health" | "eld";
const INSTRS: Instr[] = ["health", "eld"];
const INSTR_NAME: Record<Instr, string> = { health: "AVAILABILITY", eld: "LOOP" };
const controlMaxes = (b: BarStats, x: Instr) => b.control.map((r) => (x === "health" ? r.healthMax : r.eldMax));
export interface BoundaryResult {
  status: Outcome["status"];
  why: string[];
  /** Per instrument: the +20 bar that EVALUATED it (PASS) and sized its FAIL block. */
  at20: Partial<Record<Instr, BarStats>>;
  sized: Partial<Record<Instr, ReturnType<typeof sizeBlock>>>;
  /** Per instrument: the sized FAIL-block bar that EVALUATED it (FAIL). */
  block: Partial<Record<Instr, BarStats>>;
  /** Every bar run, in order ("+20 #1", "AVAILABILITY block #1", ...). */
  runs: string[];
}

/**
 * (5) + (4) THE BOUNDARY PAIRS as components (Codex R1 P1 #2, #3 on #332). Each component is one instrument's +20 PASS
 * twin and its sized FAIL block. Every bar first passes the ceiling (6): a freeze is FAIL, final, before anything else.
 * Then an EVALUATED unexpected verdict (a +20 that FAILs, a block that PASSes) is FAIL, final, whatever any other
 * component's noise or cap says. Evaluated results are KEPT; only the bars a component still lacks are re-run, each up
 * to MAX_ATTEMPTS. A component still unevaluated after that leaves the unit NOT_EVALUATED (final, via expectBoundary).
 */
export async function boundaryPairs(run20: () => Promise<BarStats>, runBlock: (x: Instr, sized: { median: number; ms: number }) => Promise<BarStats>): Promise<BoundaryResult> {
  const r: BoundaryResult = { status: "EVALUATED", why: [], at20: {}, sized: {}, block: {}, runs: [] };
  const ne: string[] = [];
  const fail = (why: string): BoundaryResult => ({ ...r, status: "FAIL", why: [why] });
  const needs20 = () => INSTRS.filter((x) => !r.at20[x] || r.sized[x]?.ms == null);
  for (let n = 1; n <= MAX_ATTEMPTS && needs20().length > 0; n++) {
    const b = await run20();
    r.runs.push(`+${BOUNDARY_PASS_MS} #${n}`);
    const c = ceilingVerdict(b.label, b.auth);
    if (c.verdict === "FAIL") return fail(`the +${BOUNDARY_PASS_MS} ms bar (#${n}): ${c.why}`);
    for (const x of INSTRS) {
      if (b[x].verdict === "FAIL") return fail(`${INSTR_NAME[x]} +${BOUNDARY_PASS_MS} ms read FAIL (d=${b[x].d.toFixed(1)}), evaluated: final (#${n})`);
    }
    if (c.verdict === "NOT_EVALUATED") {
      ne.push(`+${BOUNDARY_PASS_MS} #${n}: ${c.why}`);
      continue;
    }
    for (const x of needs20()) {
      if (b[x].verdict === "NOT_EVALUATED") {
        ne.push(`+${BOUNDARY_PASS_MS} #${n}: ${INSTR_NAME[x]} same-run A/A noise ${b[x].noise.toFixed(1)} ms`);
        continue;
      }
      r.at20[x] = b; // PASS, evaluated: kept
      r.sized[x] = sizeBlock(controlMaxes(b, x), true);
      if (r.sized[x]!.ms === null) ne.push(`+${BOUNDARY_PASS_MS} #${n}: ${INSTR_NAME[x]} ${r.sized[x]!.why}`);
    }
  }
  for (const x of INSTRS) {
    const sized = r.sized[x];
    if (!r.at20[x] || !sized || sized.ms === null) continue;
    for (let n = 1; n <= MAX_ATTEMPTS && !r.block[x]; n++) {
      const b = await runBlock(x, { median: sized.median, ms: sized.ms });
      r.runs.push(`${INSTR_NAME[x]} block #${n}`);
      const c = ceilingVerdict(b.label, b.auth);
      if (c.verdict === "FAIL") return fail(`the ${INSTR_NAME[x]} block bar (#${n}): ${c.why}`);
      if (b[x].verdict === "PASS") return fail(`${INSTR_NAME[x]} +${sized.ms.toFixed(1)} ms read PASS (d=${b[x].d.toFixed(1)}), evaluated: the bar cannot see harm at the boundary, final (#${n})`);
      if (c.verdict === "NOT_EVALUATED") {
        ne.push(`${INSTR_NAME[x]} block #${n}: ${c.why}`);
        continue;
      }
      if (b[x].verdict === "NOT_EVALUATED") {
        ne.push(`${INSTR_NAME[x]} block #${n}: same-run A/A noise ${b[x].noise.toFixed(1)} ms`);
        continue;
      }
      r.block[x] = b; // FAIL as designed, evaluated: kept
    }
  }
  const open = INSTRS.filter((x) => !r.at20[x] || r.sized[x]?.ms == null || !r.block[x]);
  return open.length ? { ...r, status: "NOT_EVALUATED", why: ne.length ? ne : open.map((x) => `${INSTR_NAME[x]} boundary never evaluated`) } : r;
}

/** A boundary unit's FAIL is red with its reason; its final NOT_EVALUATED is red as itself (never called FAIL). */
function expectBoundary(b: BoundaryResult): void {
  expect(b.status, `boundary pairs: ${b.why.join(" | ")}`).not.toBe("FAIL");
  expectEvaluated("boundary pairs", { result: b, attempts: b.runs.length, final: { status: b.status, why: b.why }, history: [{ status: b.status, why: b.why }] });
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

/**
 * DETAIL (b), T-A's ruling: only the SERIAL bars step (RELAY_TIMING_BARS=1, scripts/run-timing-bars.mjs) takes gate
 * readings. A line printed anywhere else (the parallel suite: the pure tests, a replayed CI log) is context, and says so.
 */
export const CONTEXT_LABEL = "parallel suite: context, not a gate reading | ";
export const contextLabel = (serial: boolean = process.env.RELAY_TIMING_BARS === "1"): string => (serial ? "" : CONTEXT_LABEL);

/** A NOT_EVALUATED bar is announced LOUDLY: the log, and the CI job summary when there is one. */
function announce(bare: string): void {
  const line = contextLabel() + bare;
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
type BarOpts = { onLoop?: () => void; onOpen?: () => void; poolControl?: PoolWork; authPool?: PoolWork; controlOnLoop?: () => void; measureImpl?: typeof measure };
async function runBar(label: string, port: number, load: Load, opts: BarOpts = {}): Promise<BarStats> {
  return withDiag(process.env, (rec) => runBarMeasured(label, port, load, opts, rec)); // rec is null unless RELAY_TIMING_DIAG=1
}
async function runBarMeasured(label: string, port: number, load: Load, opts: BarOpts, rec: SyncRecorder | null): Promise<BarStats> {
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
        auth.push(await measure(port, load, opts.onLoop, opts.authPool, opts.onOpen));
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
      ` | sentinel (dedicated idle worker, max gap, gates the ceiling) auth ${list(auth.map((r) => r.sentinelMax))} control ${list(control.map((r) => r.sentinelMax))} control' ${list(control2.map((r) => r.sentinelMax))}` +
      ` | load-worker max gap (report only) auth ${list(auth.map((r) => r.loadGapMax))}` +
      ` | eld (histogram, report only) auth ${list(auth.map((r) => r.eldHist))} control ${list(control.map((r) => r.eldHist))} control' ${list(control2.map((r) => r.eldHist))}` +
      ` | main ticker (report only) gaps per window max ${Math.max(...[...auth, ...control, ...control2].map((r) => r.mainGapCount))}, own busy ms per window auth ${list(auth.map((r) => r.tickerBusy))} control ${list(control.map((r) => r.tickerBusy))}` +
      ` | main-thread GC max pause (report only) auth ${list(auth.map((r) => r.gcMax))} control ${list(control.map((r) => r.gcMax))} control' ${list(control2.map((r) => r.gcMax))}` +
      exactTail({ auth, control, control2, health, eld }),
  );
  for (const line of breachDiagnostics(label, { auth, control, control2 })) announce(line); // T-A, report only
  if (rec) for (const line of diagLines(label, { auth, control, control2 }, rec)) announce(line); // RELAY_TIMING_DIAG, report only
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
    if (!Array.isArray(r.sentinelGaps)) throw new Error(`INSTRUMENT FAULT (${b.label}): a reading has no sentinel stream (it was not wired into measure)`);
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
    expect(ne1.result, "nothing is kept from attempt 1: the result is the deciding attempt's own").toBe(2);
    const fail1 = await scripted(["FAIL", "EVALUATED"]);
    expect([fail1.calls, fail1.final.status], "an evaluated FAIL is never re-run").toEqual([1, "FAIL"]);
    const neThenFail = await scripted(["NOT_EVALUATED", "FAIL", "EVALUATED"]);
    expect([neThenFail.calls, neThenFail.final.status], "the first EVALUATED attempt decides, a FAIL included").toEqual([2, "FAIL"]);
    expect(neThenFail.result).toBe(2);
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
  it("THE RETRY SELF-TEST (ruling R1), REPLAYING CI run 38701178186 a1 (macOS) under the (6) rule: attempt 1 planted and covered; attempt 2 UNPLANTED (517.6 ms, the sentinel 176.4 ms inside it: 341.2 ms uncovered, so NOT_EVALUATED now); attempt 3 an unplanted natural breach the sentinel does not overlap at all (FAIL). The old self-test asserted the live verdict and goes red; the new one asserts the retry machinery and REPORTS the FAIL", async () => {
    const r = (o: Partial<Reading> = {}): Reading => ({ healthMax: 60, eldMax: 60, eldHist: 60, mainGapCount: 0, tickerBusy: 0, shed: 0, breaches: [], sentinelGaps: [], sentinelMax: 0, loadGapMax: 0, gcMax: 0, windowFrom: 0, procWhy: "a replayed reading (CI run 38701178186's logged values, or a synthetic one of their shape), which carries no counters", ...o });
    const controlHealth = [63.2, 150.8, 127.8, 73.8, 64.9, 58.5, 61.8, 37.4, 98.3]; // attempt 2's control arm, as logged
    const bar = (label: string, auth: Reading[]): BarStats => ({
      label,
      control: controlHealth.map((h) => r({ healthMax: h })),
      control2: controlHealth.map((h) => r({ healthMax: h })),
      auth,
      compares: 0,
      perRound: Array(K).fill(0),
      health: { d: 8.4, noise: 10, verdict: "PASS" },
      eld: { d: 13.5, noise: 10, verdict: "PASS" },
      pooled: false,
    });
    // Attempt 1 (planted, round 5): the main loop and the sentinel both stopped ~603 ms, the same interval: covered.
    const a1 = bar("attempt 1", Array.from({ length: K }, (_, i) => (i === 4 ? r({ eldMax: 606.1, breaches: [{ from: 10_000, to: 10_606.1, kind: "loop-delay" }], sentinelGaps: [{ from: 9_999, to: 10_602.2 }], sentinelMax: 603.2, loadGapMax: 630.7 }) : r())));
    // Attempt 2 (UNPLANTED, round 4): /health 517.6 ms, the sentinel's own 176.4 ms gap inside it.
    const a2 = bar("attempt 2", Array.from({ length: K }, (_, i) => (i === 3 ? r({ healthMax: 517.6, breaches: [{ from: 20_000, to: 20_517.6, kind: "/health" }], sentinelGaps: [{ from: 20_200, to: 20_376.4 }], sentinelMax: 176.4, loadGapMax: 356.8 }) : r())));
    // Attempt 3 (UNPLANTED): a natural breach of the shape R3 found (/health 587.8 ms, auth arm), no sentinel gap near it.
    const a3 = bar("attempt 3", Array.from({ length: K }, (_, i) => (i === 3 ? r({ healthMax: 587.8, breaches: [{ from: 30_000, to: 30_587.8, kind: "/health" }] }) : r())));
    const bars = [a1, a2, a3];
    const once = await untilEvaluated("replay 38701178186", async (n) => bars[n - 1], (b) => barOutcome(b));
    expect(once.history.map((h) => h.status)).toEqual(["NOT_EVALUATED", "NOT_EVALUATED", "FAIL"]);
    expect(once.history[1].why.join(" "), "CI's red attempt under (6): 341.2 ms uncovered, NOT_EVALUATED (the stated consequence)").toMatch(/round 4 \/health 517\.6 ms, the sentinel covers 176\.4 ms of it, uncovered 341\.2 ms/);
    expect(() => expectGated(once), "THE OLD self-test (expectGated on the live re-run): red").toThrow(/587\.8 ms/);
    expect(() => expectRetrySelfTest("replay 38701178186", once, bars), "THE NEW self-test: what the retry machinery did").not.toThrow();
    expect(once.final.status, "...and the live FAIL is REPORTED (the ATTEMPTS/SELF-TEST lines), not hidden").toBe("FAIL");
    expect([verdictOf("EVALUATED"), verdictOf("FAIL"), verdictOf("NOT_EVALUATED")], "the lines print the VERDICT, never the status EVALUATED").toEqual(["PASS", "FAIL", "NOT_EVALUATED"]);
  });
  it("THE PLANT'S OWN MEASURE (STOP_MEASURE_SRC), pure, on a SCRIPTED clock (no real time, no scheduler): a stop INSIDE kill(), a stop AFTER kill() returns, no stop (the bound ends it), and the floor and bound boundaries", () => {
    /** A clock that returns the scripted readings in order (the last one repeats); `kill` may advance it. */
    const scripted = (...t: number[]) => {
      let i = 0;
      const clock = () => t[Math.min(i++, t.length - 1)];
      return { clock, reads: () => i };
    };
    // A stop INSIDE kill() (synchronous, as on macOS): the first read after kill() is 600 ms later.
    const sync = scripted(0, 600, 600.1);
    expect(stopAndMeasure(() => {}, 550, 2_000, sync.clock), "a stop inside kill()").toBe(600);
    // A stop AFTER kill() returns (asynchronous, as on Linux CI): a few fast reads, then the 600 ms gap.
    expect(stopAndMeasure(() => {}, 550, 2_000, scripted(0, 0.01, 0.02, 0.03, 600.03, 600.04).clock), "a stop after kill() returns").toBeCloseTo(600, 5);
    // No stop: 1 ms per read until the bound; the largest gap is 1 ms (no stop), and the loop ends at the bound.
    const steps = Array.from({ length: 3_002 }, (_, k) => k);
    const none = scripted(...steps);
    expect(stopAndMeasure(() => {}, 550, 3_000, none.clock), "no stop: the largest gap is 1 ms").toBe(1);
    expect(none.reads(), "and it ended AT the bound: the read that is 3000 ms after the one before kill (read 3001)").toBe(3_001);
    // The floor boundary: a gap of exactly the floor ends the wait at once; one just under it does not.
    expect(stopAndMeasure(() => {}, 550, 2_000, scripted(0, 550, 551).clock), "exactly the floor").toBe(550);
    // Just under the floor: one 549.9 ms gap, then 1 ms per read: it waits on to the bound and reports 549.9 (no stop seen).
    const under = scripted(0, 549.9, ...Array.from({ length: 1_451 }, (_, k) => 550.9 + k));
    expect(stopAndMeasure(() => {}, 550, 2_000, under.clock), "just under the floor: no stop, the largest gap reported").toBeCloseTo(549.9, 5);
    expect(under.reads(), "the wait ended at the bound (2000 ms after the read before kill)").toBe(1_453);
  });
  it("PLANT VERIFICATION (ruling R2), pure: a host stall is verified by the planting thread's own time across SIGSTOP AND the sentinel's gap (both >= 550 ms); a freeze by its block (>= 550 ms) with the sentinel quiet ON the freeze (its own uncovered time under (6) >= 500 ms, never the round's total); else a named FIXTURE_FAULT with every thread's reading", () => {
    const at = (o: Partial<Reading> = {}) => ({ healthMax: 600, eldMax: 603, eldHist: 603, sentinelMax: 603.2, loadGapMax: 630.7, ...o });
    expect(hostStallPlantFault("t", 600, 602.4, at()), "CI attempt 1's plant: landed").toBeNull();
    expect(hostStallPlantFault("t", 600, 550, at({ sentinelMax: 550 })), "exactly at the tolerance").toBeNull();
    expect(hostStallPlantFault("t", 600, 549.9, at()), "the planting thread stopped too briefly").toMatch(/^FIXTURE_FAULT \(t\): the planted 600 ms whole-process stop did not land as planted .*549\.9 ms; sentinel 603\.2 ms, load worker 630\.7 ms, main ticker 603\.0 ms, histogram 603\.0 ms, \/health 600\.0 ms\. NOT a failure of the code/);
    expect(hostStallPlantFault("t", 600, 602.4, at({ sentinelMax: 176.4 })), "the sentinel did not see the stop").toMatch(/^FIXTURE_FAULT/);
    expect(hostStallPlantFault("t", 600, null, at()), "the plant never fired").toMatch(/never measured \(the plant never fired\)/);
    const fr = { from: 1000, to: 1600.5, kind: "loop-delay" as const }; // the freeze's own located breach (the ticker's gap)
    const plant = { from: 1000.4, to: 1600.5 }; // the planted block's own span: inside that gap
    const fz = (gaps: Array<{ from: number; to: number }>, extra: Array<{ from: number; to: number; kind: "loop-delay" | "/health" }> = []) =>
      at({ breaches: [...extra, fr], sentinelGaps: gaps, sentinelMax: gaps.reduce((m, g) => Math.max(m, g.to - g.from), 0) });
    expect(freezePlantFault("t", 600, plant, fz([])), "a freeze with the sentinel quiet: landed").toBeNull();
    expect(freezePlantFault("t", 600, plant, fz([{ from: 1500, to: 1600 }])), "100 ms overlap: 500.5 uncovered, still a FAIL").toBeNull();
    expect(freezePlantFault("t", 600, plant, fz([{ from: 1400, to: 1600 }])), "200 ms overlap: it would read NE").toMatch(/^FIXTURE_FAULT .*the sentinel covering 200\.0 ms of it \(uncovered 400\.5 ms/);
    expect(freezePlantFault("t", 600, plant, fz([{ from: 3000, to: 3120 }, { from: 900, to: 950 }])), "routine gaps (a round total of 170 ms) that do NOT overlap the freeze: no fault").toBeNull();
    expect(freezePlantFault("t", 600, plant, at({ breaches: [] })), "no located breach").toMatch(/no located loop-delay breach containing the plant/);
    expect(freezePlantFault("t", 600, { from: 1000.4, to: 1549.4 }, fz([])), "a short block").toMatch(/^FIXTURE_FAULT .*block 549\.0 ms/);
    expect(freezePlantFault("t", 600, null, fz([])), "a block that never ran").toMatch(/block never ran/);
    // (review R1) THE PLANT'S breach, never the longest: unrelated breaches BEFORE and AFTER the plant.
    const before = { from: 200, to: 900, kind: "loop-delay" as const }; // 700 ms, before the plant
    const after = { from: 2000, to: 2900, kind: "loop-delay" as const }; // 900 ms, after the plant
    expect(
      freezePlantFault("t", 600, plant, fz([{ from: 2000, to: 2900 }], [before, after])),
      "a valid quiet plant beside a separate COVERED 900 ms stall (the longest breach): no fault",
    ).toBeNull();
    expect(
      freezePlantFault("t", 600, plant, fz([{ from: 1300, to: 1600 }], [before, after])),
      "the plant's OWN breach covered 300 ms (it would read NE), beside UNCOVERED unrelated breaches: a fault",
    ).toMatch(/^FIXTURE_FAULT .*its loop-delay breach 600\.5 ms, the sentinel covering 300\.0 ms/);
  });
  it("THE CEILING (6), PER BREACH: a breach is charged its UNCOVERED time (its length - its overlap with the union of the sentinel's gaps), FAIL iff that is >= 500 ms; a matching magnitude at another time, a touch, or an unlocatable breach is a FREEZE; no sentinel stream is an INSTRUMENT FAULT", () => {
    const gap = (from: number, ms: number) => ({ from, to: from + ms });
    const loop = (from: number, ms: number) => ({ ...gap(from, ms), kind: "loop-delay" as const });
    const health = (from: number, ms: number) => ({ ...gap(from, ms), kind: "/health" as const });
    const rd = (o: Partial<Pick<Reading, "healthMax" | "eldMax" | "breaches" | "sentinelGaps">> = {}) => ({ healthMax: 30, eldMax: 20, breaches: [], sentinelGaps: [], ...o });
    const quiet = Array.from({ length: K - 1 }, () => rd());
    const v = (r: ReturnType<typeof rd>) => ceilingVerdict("t", [...quiet, r]).verdict;
    expect(ceilingVerdict("t", [...quiet, rd()]).verdict).toBe("PASS");
    expect(v(rd({ eldMax: 600, breaches: [loop(1000, 600)] })), "a daemon freeze, the sentinel quiet").toBe("FAIL");
    expect(v(rd({ eldMax: 602, breaches: [loop(1000, 602)], sentinelGaps: [gap(998, 606)] })), "the whole process stopped: covered").toBe("NOT_EVALUATED");
    // Codex's static counterexample: the same magnitudes, the sentinel's stall at ANOTHER time.
    expect(v(rd({ healthMax: 650, eldMax: 600, breaches: [health(1000, 650), loop(1000, 600)], sentinelGaps: [gap(3000, 650)] })), "a matching magnitude at another time").toBe("FAIL");
    expect(v(rd({ eldMax: 600, breaches: [loop(1000, 600)], sentinelGaps: [gap(1595, 650)] })), "a touch (5 ms of overlap)").toBe("FAIL");
    expect(v(rd({ eldMax: 600, breaches: [loop(1000, 600)], sentinelGaps: [gap(1500, 100)] })), "covered 100 ms: 500 uncovered, AT the ceiling").toBe("FAIL");
    expect(v(rd({ eldMax: 600, breaches: [loop(1000, 600)], sentinelGaps: [gap(1499, 101)] })), "covered 101 ms: 499 uncovered").toBe("NOT_EVALUATED");
    // (A loop reading over the ceiling with no loop breach cannot exist: LOOP and its breaches are ONE source, the main
    // ticker's gaps; pinned by "LOOP READS THE MAIN TICKER" below.)
    expect(v(rd({ healthMax: 600, breaches: [], sentinelGaps: [gap(1000, 600)] })), "a /health reading with no sample interval to locate it").toBe("FAIL");
    expect(ceilingVerdict("t", [rd({ eldMax: 602, breaches: [loop(1000, 602)], sentinelGaps: [gap(998, 606)] }), rd({ eldMax: 600, breaches: [loop(5000, 600)] })]).verdict, "one freeze among host stalls: FAIL wins").toBe("FAIL");
    expect(() => ceilingVerdict("t", [rd(), { ...rd(), sentinelGaps: undefined }]), "no sentinel stream").toThrow(/INSTRUMENT FAULT/);
  });
  it("T-A BREACH DIAGNOSTICS (review R1): EVERY breached reading of EVERY arm gets a line with its round and counters, whatever the verdict picks: a covered auth breach beside a FAIL, and a control-arm breach the ceiling never judges", () => {
    const r = (o: Partial<Reading> = {}): Reading => ({ healthMax: 30, eldMax: 20, eldHist: 20, mainGapCount: 0, tickerBusy: 0, shed: 0, breaches: [], sentinelGaps: [], sentinelMax: 0, loadGapMax: 0, gcMax: 0, windowFrom: 0, ...o });
    const p1: ProcCounters = { volCs: 1, invCs: 11, cpuMs: 111, wallMs: 700 };
    const p2: ProcCounters = { volCs: 2, invCs: 22, cpuMs: 222, wallMs: 700 };
    const p3: ProcCounters = { volCs: 3, invCs: 33, cpuMs: 333, wallMs: 700 };
    const auth = [r({ eldMax: 600, breaches: [{ from: 1000, to: 1600, kind: "loop-delay" }], sentinelGaps: [{ from: 1000, to: 1600 }], proc: p1 }), r({ eldMax: 700, breaches: [{ from: 5000, to: 5700, kind: "loop-delay" }], proc: p2 })];
    const control = [r({ healthMax: 560, breaches: [{ from: 9000, to: 9560, kind: "/health" }], proc: p3 })];
    expect(ceilingVerdict("t", auth).verdict, "the verdict: the uncovered auth breach FAILs").toBe("FAIL");
    expect(ceilingVerdict("t", auth).why, "the FAIL message lists only the freeze").not.toContain("voluntary cs 1,");
    const lines = breachDiagnostics("t", { auth, control, control2: [] });
    expect(lines).toEqual([
      "BREACH t | arm auth round 1 | loop-delay 600.0 ms, the sentinel covers 600.0 ms, uncovered 0.0 ms | process-wide counters: voluntary cs 1, involuntary cs 11, CPU 111.0 ms of 700.0 ms wall",
      "BREACH t | arm auth round 2 | loop-delay 700.0 ms, the sentinel covers 0.0 ms, uncovered 700.0 ms (no sentinel overlap) | process-wide counters: voluntary cs 2, involuntary cs 22, CPU 222.0 ms of 700.0 ms wall",
      "BREACH t | arm control round 1 | /health 560.0 ms, the sentinel covers 0.0 ms, uncovered 560.0 ms (no sentinel overlap) | process-wide counters: voluntary cs 3, involuntary cs 33, CPU 333.0 ms of 700.0 ms wall",
    ]);
    expect(breachDiagnostics("t", { auth: [r()], control: [r()], control2: [r()] }), "no breach: no line").toEqual([]);
  });
  it("DIAG is INERT unless asked: without RELAY_TIMING_DIAG=1 nothing is patched; with it the wrappers exist only until uninstall, which restores every function (fs, child_process, the SQLite prototypes)", () => {
    const handle = db.getDb() as unknown as { prepare(sql: string): object };
    const dbProto = Object.getPrototypeOf(handle) as Record<string, unknown>;
    const stProto = Object.getPrototypeOf(handle.prepare("SELECT 1")) as Record<string, unknown>;
    const snapshot = () => [fs.readFileSync, fs.writeFileSync, childProcess.spawnSync, dbProto.prepare, dbProto.transaction, stProto.run, stProto.get];
    const before = snapshot();
    expect(diagInstall({}), "not asked: no recorder").toBeNull();
    expect(snapshot(), "not asked: nothing patched").toEqual(before);
    const rec = diagInstall({ RELAY_TIMING_DIAG: "1" })!;
    try {
      const during = snapshot();
      during.forEach((f, i) => expect(f, `function ${i} is wrapped while a DIAG bar runs`).not.toBe(before[i]));
    } finally {
      rec.uninstall();
    }
    expect(snapshot(), "after the bar: every function restored, identical").toEqual(before);
  });
  it("DIAG cleanup: a REJECTING bar restores everything; a NEVER-SETTLING bar (a test timeout abandons it) is restored by the teardown cleanup, idempotently", async () => {
    const snapshot = () => [fs.readFileSync, childProcess.spawnSync];
    const before = snapshot();
    await expect(withDiag({ RELAY_TIMING_DIAG: "1" }, async () => {
      expect(fs.readFileSync, "wrapped during the bar").not.toBe(before[0]);
      throw new Error("the bar failed");
    })).rejects.toThrow("the bar failed");
    expect(snapshot(), "a rejecting bar: restored").toEqual(before);
    void withDiag({ RELAY_TIMING_DIAG: "1" }, () => new Promise<never>(() => {})); // never settles: its finally never runs
    expect(fs.readFileSync, "the abandoned bar left the wrappers installed").not.toBe(before[0]);
    diagCleanupAll(); // what afterEach runs
    expect(snapshot(), "the teardown cleanup restored them").toEqual(before);
    diagCleanupAll();
    expect(snapshot(), "idempotent").toEqual(before);
  });
  it("DIAG (RELAY_TIMING_DIAG, report only): each located breach of every arm is matched to the recorded sync calls that OVERLAP it, or says none did; a call outside it is not listed", () => {
    const r = (o: Partial<Reading> = {}): Reading => ({ healthMax: 30, eldMax: 20, eldHist: 20, mainGapCount: 0, tickerBusy: 0, shed: 0, breaches: [], sentinelGaps: [], sentinelMax: 0, loadGapMax: 0, gcMax: 0, windowFrom: 0, ...o });
    const calls = [
      { what: "sqlite Statement#run", detail: "INSERT INTO audit_log …", from: 1100, to: 1650, stack: "run <- handler" },
      { what: "fs.writeFileSync", detail: "/tmp/x", from: 7000, to: 7200, stack: "writer" },
    ];
    const rec = { overlapping: (from: number, to: number) => calls.filter((c) => c.from < to && c.to > from), count: () => calls.length };
    const lines = diagLines("t", {
      auth: [r({ eldMax: 600, breaches: [{ from: 1000, to: 1600, kind: "loop-delay" }] })],
      control: [r({ healthMax: 560, breaches: [{ from: 9000, to: 9560, kind: "/health" }] })],
      control2: [],
    }, rec);
    expect(lines).toEqual([
      "DIAG t | arm auth round 1 | loop-delay 600.0 ms | 1 sync call(s) >= 100 ms overlap it",
      "DIAG   - sqlite Statement#run 550.0 ms [INSERT INTO audit_log …] at run <- handler",
      "DIAG t | arm control round 1 | /health 560.0 ms | NO recorded sync call >= 100 ms overlaps it (the block is not a recorded SQLite/fs/child-process call: widen the instrument)",
      "DIAG t | recorder: 2 sync call(s) >= 100 ms recorded during this bar",
    ]);
  });
  it("T-A (report only, verdict parked): a breach with NO sentinel overlap FAILS with the T-A wording and the window's PROCESS-WIDE counters; a covered breach carries the counters too; no verdict reads them", () => {
    const proc: ProcCounters = { volCs: 12, invCs: 340, cpuMs: 1234.5, wallMs: 700.2 };
    const b = { from: 1000, to: 1600, kind: "loop-delay" as const };
    const none = ceilingVerdict("t", [{ healthMax: 30, eldMax: 600, breaches: [b], sentinelGaps: [], proc }]);
    expect(none.verdict).toBe("FAIL");
    expect(none.why).toContain("no sentinel overlap: a daemon freeze or unseen contention (T-A parked); process-wide counters: voluntary cs 12, involuntary cs 340, CPU 1234.5 ms of 700.2 ms wall");
    const covered = ceilingVerdict("t", [{ healthMax: 30, eldMax: 600, breaches: [b], sentinelGaps: [{ from: 1000, to: 1600 }], proc }]);
    expect(covered.verdict).toBe("NOT_EVALUATED");
    expect(covered.why).toContain("process-wide counters: voluntary cs 12");
    expect(covered.why).not.toContain("T-A parked");
    const noProc = ceilingVerdict("t", [{ healthMax: 30, eldMax: 600, breaches: [b], sentinelGaps: [] }]);
    expect([noProc.verdict, noProc.why.includes("process-wide counters: not recorded")], "no counters: the same verdict, said so").toEqual(["FAIL", true]);
    // DETAIL (a): never a bare "not recorded". A reading without counters says why: its own reason, or that it has none.
    expect(noProc.why, "no reason given: the line says the reading names none").toContain("process-wide counters: not recorded: this reading was not taken by measureWindow and names no reason");
    const withWhy = ceilingVerdict("t", [{ healthMax: 30, eldMax: 600, breaches: [b], sentinelGaps: [], procWhy: "replayed from a log" }]);
    expect(withWhy.why, "a reason given: the line carries it").toContain("process-wide counters: not recorded: replayed from a log");
    expect(fmtProc(undefined), "fmtProc never ends at a bare 'not recorded'").toMatch(/not recorded: \S/);
    for (const blank of ["", "  "]) expect(fmtProc(undefined, blank), `an empty or blank reason (${JSON.stringify(blank)}) falls back`).toContain("not recorded: this reading was not taken by measureWindow and names no reason");
    const huge: ProcCounters = { volCs: 0, invCs: 1e6, cpuMs: 1e6, wallMs: 1 };
    expect(ceilingVerdict("t", [{ healthMax: 30, eldMax: 600, breaches: [b], sentinelGaps: [{ from: 1000, to: 1600 }], proc: huge }]).verdict, "the counters never change a verdict").toBe("NOT_EVALUATED");
  });
  it("T-A DETAIL (b) and the unrounded tail (serialization coverage; the BAR line itself is assembled in runBar): a line outside the serial bars step labels itself context; exactTail round-trips the exact values judge() saw and returned, and the rounded log reads a different verdict", () => {
    expect(contextLabel(true), "the serial bars step (RELAY_TIMING_BARS=1): no label, these are gate readings").toBe("");
    expect(contextLabel(false), "anywhere else: labelled").toBe("parallel suite: context, not a gate reading | ");
    expect(contextLabel(), "this run, by its own environment").toBe(process.env.RELAY_TIMING_BARS === "1" ? "" : CONTEXT_LABEL);
    // Pinned fixtures, six distinct arrays. AVAILABILITY: every |control - control'| is 25.03 ms, just over the 25 ms
    // noise limit (NOT_EVALUATED), yet each value prints with ONE decimal, so the logged pairs differ by exactly 25.0
    // (not over the limit: PASS). LOOP: noise 10.02, d 10.24, PASS either way.
    const fx = {
      auth: { health: [110.1, 120.1, 130.1, 140.1, 150.1, 160.1, 170.1, 180.1, 190.1], eld: [30.37, 31.37, 32.37, 33.37, 34.37, 35.37, 36.37, 37.37, 38.37] },
      control: { health: [100.04, 110.04, 120.04, 130.04, 140.04, 150.04, 160.04, 170.04, 180.04], eld: [20.13, 21.13, 22.13, 23.13, 24.13, 25.13, 26.13, 27.13, 28.13] },
      control2: { health: [75.01, 85.01, 95.01, 105.01, 115.01, 125.01, 135.01, 145.01, 155.01], eld: [10.11, 11.11, 12.11, 13.11, 14.11, 15.11, 16.11, 17.11, 18.11] },
    };
    const r = (healthMax: number, eldMax: number): Reading => ({ healthMax, eldMax, eldHist: 0, mainGapCount: 0, tickerBusy: 0, shed: 0, breaches: [], sentinelGaps: [], sentinelMax: 0, loadGapMax: 0, gcMax: 0, windowFrom: 0 });
    const arm = (a: { health: number[]; eld: number[] }) => a.health.map((h, i) => r(h, a.eld[i]));
    const [auth, control, control2] = [arm(fx.auth), arm(fx.control), arm(fx.control2)];
    const health = judge(fx.auth.health, fx.control.health, fx.control2.health);
    const eld = judge(fx.auth.eld, fx.control.eld, fx.control2.eld);
    expect([health.verdict, eld.verdict], "the gate's verdicts on the exact inputs (pinned)").toEqual(["NOT_EVALUATED", "PASS"]);
    expect(health.noise, "AVAILABILITY noise, exact").toBeCloseTo(25.03, 9);
    expect(health.d, "AVAILABILITY d, exact").toBeCloseTo(10.06, 9);
    expect(eld.noise, "LOOP noise, exact").toBeCloseTo(10.02, 9);
    expect(eld.d, "LOOP d, exact").toBeCloseTo(10.24, 9);
    const tail = exactTail({ auth, control, control2, health, eld });
    expect(tail.startsWith(" | exact {"), "the tail is its own BAR-line field").toBe(true);
    const parsed = JSON.parse(tail.slice(" | exact ".length));
    expect({ auth: parsed.auth, control: parsed.control, control2: parsed.control2 }, "all six input arrays, exactly as judged").toEqual(fx);
    expect(parsed.judged, "both output objects, exactly as returned").toEqual({ health: { d: health.d, noise: health.noise, verdict: "NOT_EVALUATED" }, eld: { d: eld.d, noise: eld.noise, verdict: "PASS" } });
    expect(judge(parsed.auth.health, parsed.control.health, parsed.control2.health).verdict, "a replay from the tail: NOT_EVALUATED, as the gate judged").toBe("NOT_EVALUATED");
    const logged = (xs: number[]) => list(xs).split("/").map(Number);
    expect(list(fx.control.health).split("/")[0], "the BAR line itself prints one decimal").toBe("100.0");
    expect(judge(logged(fx.auth.health), logged(fx.control.health), logged(fx.control2.health)).verdict, "a replay from the ROUNDED log reads PASS: the case the tail exists for").toBe("PASS");
  });
  it("THE (6) RULE's REDs (ruling of 2026-10-21): the f445297 replay reads NOT_EVALUATED (FAIL under the retired slack); a covered stall plus a >= 500 ms daemon tail FAILS; the NOT-CAUGHT case (a 510 ms freeze beside a 20 ms sentinel gap) reads NOT_EVALUATED; no overlap FAILS; two partial sentinel gaps count as their UNION", () => {
    const gap = (from: number, ms: number) => ({ from, to: from + ms });
    const one = (b: { from: number; to: number; kind: "/health" | "loop-delay" }, gaps: Array<{ from: number; to: number }>) => ceilingVerdict("t", [{ healthMax: b.kind === "/health" ? b.to - b.from : 30, eldMax: b.kind === "loop-delay" ? b.to - b.from : 20, breaches: [b], sentinelGaps: gaps }]);
    // 1. #334's macOS run at f445297 (a REAL 600 ms plant): /health 681.7 ms, the sentinel covering 605.9 ms of it, and
    //    the loop 605.8 ms covered for 604.0 ms. The retired slack (71.2) read the /health breach a FAIL; it is 75.8 ms
    //    uncovered: NOT_EVALUATED.
    const f445297 = ceilingVerdict("f445297", [{ healthMax: 681.7, eldMax: 605.8, breaches: [{ from: 1000, to: 1681.7, kind: "/health" }, { from: 1001.9, to: 1607.7, kind: "loop-delay" }], sentinelGaps: [gap(1000, 605.9)] }]);
    expect(f445297.verdict, f445297.why).toBe("NOT_EVALUATED");
    expect(f445297.why).toMatch(/\/health 681\.7 ms, the sentinel covers 605\.9 ms of it, uncovered 75\.8 ms/);
    // 2. A covered 600 ms host stop, then a 510 ms daemon tail: 510 ms uncovered, a freeze the host does not explain.
    expect(one({ ...gap(1000, 1110), kind: "/health" }, [gap(1000, 600)]).verdict, "a covered stall + a >= 500 ms daemon tail").toBe("FAIL");
    // 3. NOT CAUGHT, stated in the header: a 510 ms daemon freeze beside a routine 20 ms sentinel gap: 490 ms uncovered.
    expect(one({ ...gap(1000, 510), kind: "loop-delay" }, [gap(1100, 20)]).verdict, "the stated NOT-caught case").toBe("NOT_EVALUATED");
    // 4. No overlap at all: the whole breach is uncovered.
    expect(one({ ...gap(1000, 600), kind: "loop-delay" }, [gap(5000, 600)]).verdict, "no overlap").toBe("FAIL");
    // 5. Two partial sentinel gaps, 250 ms each and apart: their UNION covers 500 of a 900 ms breach (400 uncovered:
    //    NOT_EVALUATED), where the largest single gap would leave 650 (FAIL). Overlapping gaps never count twice.
    expect(one({ ...gap(1000, 900), kind: "/health" }, [gap(1000, 250), gap(1300, 250)]).verdict, "two partial gaps: their union").toBe("NOT_EVALUATED");
    expect(unionOverlapMs(gap(1000, 900), [gap(1000, 250), gap(1300, 250)])).toBe(500);
    expect(unionOverlapMs(gap(1000, 700), [gap(1000, 350), gap(1300, 200)]), "overlapping gaps: the union (500), never the sum (550)").toBe(500);
    expect(unionOverlapMs(gap(1000, 600), [gap(900, 50), gap(1700, 10)]), "gaps outside the breach cover nothing").toBe(0);
  });
  it("THE TICKER (8): a snapshot taken BEFORE the overdue tick misses the stall (the race Codex R2 named); settled(end) waits for a tick at or after the end, so the stall is recorded; settled is bounded and rejects", async () => {
    const t = makeTicker(GAP_FLOOR_MS, GAP_KEEP);
    try {
      await t.settled(absNow(), SETTLE_POLLS); // armed: it has ticked
      const from = absNow();
      loopBlock(300)(); // this thread blocked: its own ticker cannot tick until the block ends
      const to = absNow();
      expect(t.gaps(from, to), "a snapshot BEFORE the overdue tick: the stall is not recorded yet").toEqual([]);
      await t.settled(to, SETTLE_POLLS);
      expect(t.lastTick()).toBeGreaterThanOrEqual(to);
      const g = t.gaps(from, to);
      expect(g.length, "settled: the tick that ends the stall has landed, so the stall is a recorded gap").toBe(1);
      expect(g[0].to - g[0].from).toBeGreaterThanOrEqual(300);
    } finally {
      t.stop();
    }
    await expect(t.settled(absNow() + 60_000, 30), "a stopped ticker never settles: bounded, it rejects").rejects.toThrow(/never ticked/);
  });
  it("LOOP READS THE MAIN TICKER (8): a block RIGHT AS the window opens (before any tick of a fresh histogram) reads the whole block, and a block over the ceiling is its own located breach (one source); the twin, the same block mid-window, reads it too", async () => {
    await armInstruments();
    const atOpen = openLoopWindow(mainTicker!);
    loopBlock(CEILING_MS + 20)(); // synchronously, right after open: the stall the LOOP ticket names
    await new Promise((res) => setTimeout(res, 20)); // the overdue ticks land before close (the histogram's included)
    atOpen.close();
    const r = await atOpen.read();
    console.log(contextLabel() + `LOOP pure, block at open ${CEILING_MS + 20} ms: ticker max ${r.max.toFixed(1)} ms, histogram (report only) ${r.histMax.toFixed(1)} ms`);
    expect(r.max, "the ticker sees a stall right as the window opens").toBeGreaterThanOrEqual(CEILING_MS + 20);
    expect(r.breaches.length, "a LOOP reading over the ceiling carries its breach: one source").toBe(1);
    const mid = openLoopWindow(mainTicker!);
    await new Promise((res) => setTimeout(res, 20));
    loopBlock(300)();
    await new Promise((res) => setTimeout(res, 20));
    mid.close();
    const m = await mid.read();
    console.log(contextLabel() + `LOOP pure twin, block mid-window 300 ms: ticker max ${m.max.toFixed(1)} ms, histogram (report only) ${m.histMax.toFixed(1)} ms`);
    expect(m.max, "the twin: mid-window").toBeGreaterThanOrEqual(300);
    expect(m.breaches, "under the ceiling: no breach").toEqual([]);
    const noGaps: Ticker = { gaps: () => [], fault: () => null, snapshot: () => ({ gaps: [] }), tick: () => {}, evictions: () => 0, busy: () => 0, ticks: () => 2, lastTick: absNow, settled: async () => {}, stop: () => {} };
    const quiet = openLoopWindow(noGaps);
    quiet.close();
    expect((await quiet.read()).max, "no gap at or over the floor reads as the floor").toBe(MAIN_GAP_FLOOR_MS);
  }, 20_000);
  it("READ SETTLES (8): a block, then close() SYNCHRONOUSLY, then read() at once (this thread never yielded, so the tick that ends the stall has not run yet): read() itself waits for it, and the whole gap and its ceiling breach are read", async () => {
    await armInstruments();
    const w = openLoopWindow(mainTicker!);
    loopBlock(CEILING_MS + 20)();
    w.close(); // no yield between the block and close(), nor between close() and read()
    const r = await w.read();
    expect(r.max, "the whole stall is read: read() settled on the tick that ends it").toBeGreaterThanOrEqual(CEILING_MS + 20);
    expect(r.breaches.length, "and it is a located ceiling breach").toBe(1);
  }, 20_000);
  it("RING EVICTION IS A FAULT (main ticker): a tiny ring, one large gap, then small gaps past the keep → the window is an INSTRUMENT FAULT, never the filler's max; the twin with room reads the large gap", async () => {
    const burst = async (t: Ticker) => {
      await t.settled(absNow(), SETTLE_POLLS);
      const w = openLoopWindow(t);
      loopBlock(100)(); // the large gap
      for (let i = 0; i < 12; i++) {
        await new Promise((res) => setTimeout(res, 3));
        loopBlock(5)(); // filler: gaps of >= 2 ms, past a keep of 4
      }
      w.close();
      return w;
    };
    const tiny = makeTicker(MAIN_GAP_FLOOR_MS, 4);
    const roomy = makeTicker(MAIN_GAP_FLOOR_MS, MAIN_GAP_KEEP);
    try {
      const evicting = await burst(tiny);
      await expect(evicting.read(), "an evicted gap overlaps the window: a FAULT").rejects.toThrow(/INSTRUMENT FAULT: LOOP's main-thread ticker: the ticker's ring evicted \d+ gap/);
      expect(tiny.evictions()).toBeGreaterThan(0);
      const twin = await (await burst(roomy)).read();
      expect(twin.max, "the twin, with room: the large gap is the max").toBeGreaterThanOrEqual(100);
      expect(roomy.evictions()).toBe(0);
    } finally {
      tiny.stop();
      roomy.stop();
    }
  }, 20_000);
  it("THE LIVE BURST'S RACE, replayed on a scripted ticker: CI's measured ticks (a 150.8 ms gap, then ten filler blocks with ONE tick between them) give 3 gaps, under the keep of 4, so the ring never evicts: why a live burst cannot pin eviction", () => {
    // CI run 40150772848 (Linux), the LIVE sentinel's three gaps: 69908.4 -> 70059.2 -> 70089.9 -> 70362.3 (relative
    // 150.8, 30.7, 272.4 ms). The worker ran nine of the ten filler blocks back to back, with no tick between them: a gap
    // is recorded only by the tick that ends it, so a live burst's gap COUNT depends on the scheduler. The test below
    // scripts every tick instead.
    const t = makeTicker(GAP_FLOOR_MS, 4, 0);
    for (const at of [150.8, 181.5, 453.9]) t.tick(at);
    const r = t.snapshot(0, 454);
    expect(r.fault, "no eviction: the ring held every gap").toBeUndefined();
    expect(r.gaps?.length).toBe(3);
    expect(t.evictions()).toBe(0);
  });
  it("RING EVICTION IS A FAULT (the sentinel's ring), on a scripted ticker: a tiny ring, one large gap, then ten filler gaps each ended by its own tick → the reply is a FAULT with no stream (an INSTRUMENT FAULT at the ceiling), never a missing cover; the twin with room reads the large gap", () => {
    // Every tick is scripted, so the gap count is the construction's, never the scheduler's: one 150 ms gap, then ten
    // gaps of 30 ms (>= the sentinel's 20 ms floor), eleven in all, past a keep of 4.
    const ticks = [150, ...Array.from({ length: 10 }, (_, i) => 150 + 30 * (i + 1))];
    const burst = (keep: number) => {
      const t = makeTicker(GAP_FLOOR_MS, keep, 0);
      for (const at of ticks) t.tick(at);
      return { t, r: t.snapshot(0, ticks[ticks.length - 1] + 1) };
    };
    const tiny = burst(4);
    expect(tiny.t.evictions(), "11 gaps in a ring of 4: 7 evicted").toBe(7);
    expect(tiny.r.gaps, "an evicted gap may overlap the snapshot: no stream").toBeUndefined();
    expect(tiny.r.fault).toMatch(/the ticker's ring evicted 7 gap/);
    // FIFO, and the eviction cutoff: the ring keeps the NEWEST four gaps, so a window from 330 (the end of the last
    // evicted gap) reads exactly those, with no fault; a window opening just before 330 may overlap an evicted gap: a
    // fault. (Evicting the newest instead would keep [0,150] and the next three, and fault from 330 on.)
    expect(tiny.t.snapshot(330, 450), "a window from the cutoff: exactly the four newest gaps, oldest first").toEqual({
      gaps: [
        { from: 330, to: 360 },
        { from: 360, to: 390 },
        { from: 390, to: 420 },
        { from: 420, to: 450 },
      ],
    });
    expect(tiny.t.snapshot(329.9, 450).fault, "a window opening just before the cutoff: a fault").toMatch(/the ticker's ring evicted 7 gap\(s\), one ending at 330\.0/);
    const reading = { healthMax: 30, eldMax: 20, breaches: [], sentinelGaps: tiny.r.gaps, sentinelFault: tiny.r.fault };
    expect(() => ceilingVerdict("evicted", [reading])).toThrow(/INSTRUMENT FAULT \(evicted\): reading 1 has no sentinel stream \(the ticker's ring evicted/);
    const roomy = burst(GAP_KEEP);
    expect(roomy.r.fault, "the twin, with room: no eviction").toBeUndefined();
    expect(roomy.r.gaps?.length).toBe(11);
    expect(Math.max(...roomy.r.gaps!.map((g) => g.to - g.from)), "the twin: the large gap is there").toBe(150);
  });
  it("THE SENTINEL's snapshot is ARMED per request (the call site of settled): its reply never comes before a sentinel tick at or after the asked end; a request that cannot settle comes back as a fault, and a reading without a stream carries that reason into the INSTRUMENT FAULT", async () => {
    await armInstruments();
    const end = absNow() + 200; // an end in the near future: the sentinel must tick past it before it answers
    const ok = await sentinel!.ask(absNow() - 50, end);
    const answeredAt = absNow();
    expect(ok.fault, "a settle-able request is answered with gaps").toBeUndefined();
    expect(Array.isArray(ok.gaps)).toBe(true);
    expect(answeredAt, "the reply came only after the sentinel ticked at or after the asked end").toBeGreaterThanOrEqual(end);
    const never = await sentinel!.ask(absNow(), absNow() + 600_000); // no tick can reach it within the bound
    expect(never.gaps, "an unsettled request carries no stream").toBeUndefined();
    expect(never.fault).toMatch(/never ticked at or after the requested end/);
    const reading = { healthMax: 30, eldMax: 20, breaches: [], sentinelGaps: never.gaps, sentinelFault: never.fault };
    expect(() => ceilingVerdict("unsettled", [reading])).toThrow(/INSTRUMENT FAULT \(unsettled\): reading 1 has no sentinel stream \(the ticker never ticked/);
  }, 20_000);
  it("THE BOUNDARY PAIRS (5) + (4), mixed outcomes: an EVALUATED unexpected verdict is final before any other component's noise or cap; evaluated results are kept; only the bars a component lacks are re-run; a freeze in any boundary bar is FAIL first", async () => {
    const reading = (o: Partial<Reading> = {}): Reading => ({ healthMax: 30, eldMax: 20, eldHist: 20, mainGapCount: 0, tickerBusy: 0, shed: 0, breaches: [], sentinelGaps: [], sentinelMax: 0, loadGapMax: 0, gcMax: 0, windowFrom: 0, ...o });
    const iv = (verdict: Verdict): InstrumentVerdict => ({ d: verdict === "FAIL" ? 90 : 10, noise: verdict === "NOT_EVALUATED" ? 40 : 5, verdict });
    const bar = (label: string, health: Verdict, eld: Verdict, o: { controlHealth?: number; auth?: Reading[] } = {}): BarStats => ({
      label,
      control: Array.from({ length: K }, () => reading({ healthMax: o.controlHealth ?? 30 })),
      control2: Array.from({ length: K }, () => reading()),
      auth: o.auth ?? Array.from({ length: K }, () => reading()),
      compares: 0,
      perRound: Array(K).fill(0),
      health: iv(health),
      eld: iv(eld),
      pooled: false,
    });
    const freeze = (covered: boolean) => [
      ...Array.from({ length: K - 1 }, () => reading()),
      reading({ eldMax: 602, breaches: [{ from: 1000, to: 1602, kind: "loop-delay" }], sentinelGaps: covered ? [{ from: 998, to: 1606 }] : [] }),
    ];
    const run = async (twenties: BarStats[], blocks: Partial<Record<Instr, BarStats[]>>) => {
      const queue = { twenty: [...twenties], health: [...(blocks.health ?? [])], eld: [...(blocks.eld ?? [])] };
      const take = (q: BarStats[], what: string) => {
        const b = q.shift();
        if (!b) throw new Error(`ran more ${what} bars than scripted`);
        return b;
      };
      return boundaryPairs(
        async () => take(queue.twenty, "+20"),
        async (x) => take(queue[x], `${x} block`),
      );
    };
    const failNow = await run([bar("+20", "FAIL", "NOT_EVALUATED")], {});
    expect([failNow.status, failNow.runs], "a +20 that FAILs is final, its twin's noise notwithstanding").toEqual(["FAIL", ["+20 #1"]]);
    const capHides = await run([bar("+20", "PASS", "FAIL", { controlHealth: 130 })], {});
    expect(capHides.status, "an over-cap AVAILABILITY block cannot hide LOOP's evaluated +20 FAIL").toBe("FAIL");
    const kept = await run([bar("+20 a", "PASS", "NOT_EVALUATED"), bar("+20 b", "NOT_EVALUATED", "PASS")], { health: [bar("blk h", "FAIL", "PASS")], eld: [bar("blk l", "PASS", "FAIL")] });
    expect(kept.status).toBe("EVALUATED");
    expect([kept.at20.health?.label, kept.at20.eld?.label], "each component keeps the +20 that evaluated it").toEqual(["+20 a", "+20 b"]);
    expect(kept.runs).toEqual(["+20 #1", "+20 #2", "AVAILABILITY block #1", "LOOP block #1"]);
    const blockRerun = await run([bar("+20", "PASS", "PASS")], { health: [bar("blk h1", "NOT_EVALUATED", "PASS"), bar("blk h2", "FAIL", "PASS")], eld: [bar("blk l", "PASS", "FAIL")] });
    expect([blockRerun.status, blockRerun.runs], "only the unevaluated block is re-run; the +20 is not").toEqual(["EVALUATED", ["+20 #1", "AVAILABILITY block #1", "AVAILABILITY block #2", "LOOP block #1"]]);
    const blind = await run([bar("+20", "PASS", "PASS")], { health: [bar("blk h", "PASS", "PASS")] });
    expect([blind.status, blind.runs], "a sized block that PASSes is final: the bar cannot see harm").toEqual(["FAIL", ["+20 #1", "AVAILABILITY block #1"]]);
    const frozen20 = await run([bar("+20", "PASS", "PASS", { auth: freeze(false) })], {});
    expect([frozen20.status, frozen20.runs], "one frozen round in the +20 auth arm, medians PASS: the ceiling fails it first").toEqual(["FAIL", ["+20 #1"]]);
    expect(frozen20.why.join(" ")).toMatch(/NOT covered by the sentinel/);
    const frozenBlock = await run([bar("+20", "PASS", "PASS")], { health: [bar("blk h", "FAIL", "PASS", { auth: freeze(false) })] });
    expect(frozenBlock.status, "a freeze in a block bar is FAIL even when the block reads FAIL as designed").toBe("FAIL");
    const hostStall = await run([bar("+20 stalled", "PASS", "PASS", { auth: freeze(true) }), bar("+20 quiet", "PASS", "PASS")], { health: [bar("blk h", "FAIL", "PASS")], eld: [bar("blk l", "PASS", "FAIL")] });
    expect([hostStall.status, hostStall.at20.health?.label], "a covered host stall: that +20 is re-run and nothing is kept from it").toEqual(["EVALUATED", "+20 quiet"]);
    const noisy = await run(Array.from({ length: MAX_ATTEMPTS }, () => bar("+20", "NOT_EVALUATED", "NOT_EVALUATED")), {});
    expect([noisy.status, noisy.runs.length], "three noisy +20 bars: a FINAL NOT_EVALUATED, never FAIL, no 4th").toEqual(["NOT_EVALUATED", MAX_ATTEMPTS]);
    expect(() => expectBoundary(noisy)).toThrow(/^NOT_EVALUATED, FINAL \(boundary pairs\)/);
    const overCap = await run(Array.from({ length: MAX_ATTEMPTS }, () => bar("+20", "PASS", "PASS", { controlHealth: 130 })), { eld: [bar("blk l", "PASS", "FAIL")] });
    expect([overCap.status, overCap.runs], "over the cap every time: the +20 is re-run to re-size, then NOT_EVALUATED").toEqual(["NOT_EVALUATED", ["+20 #1", "+20 #2", "+20 #3", "LOOP block #1"]]);
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

  it("THE LOOP TICKET's RED, live: the gross block SYNCHRONOUSLY as each auth window opens (before any tick of a freshly enabled histogram, blind there) TRIPS; its twin, the same block mid-window, trips too", async () => {
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`);
      await measure(port, controlLoad(20));
      const atOpen = await runBar(`gross negative at window open (+${GROSS_BLOCK_MS} ms, before any tick)`, port, authLoad(20, "discover_agents", {}), { onOpen: loopBlock(GROSS_BLOCK_MS) });
      const midWindow = await runBar(`gross negative mid-window (+${GROSS_BLOCK_MS} ms, the twin)`, port, authLoad(20, "discover_agents", {}), { onLoop: loopBlock(GROSS_BLOCK_MS) });
      expectTrips(atOpen); // the RED: on the histogram this read near zero (it never ticked before the block)
      expectTrips(midWindow); // the twin: the RED above is the first tick, not the block
    });
  }, 600_000);

  it("NEGATIVE CONTROL + THE RESOLUTION, live: +200 ms TRIPS on every run; an injected noise source reads NOT_EVALUATED; on an evaluated run each boundary FAIL block (80 + that run's median control max, per instrument) FAILS and +20 PASSES", async () => {
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
      // THE BOUNDARY PAIRS, live (5) + (4): per component (boundaryPairs). The +20 PASS bar runs FIRST: its CONTROLS
      // size each FAIL block, 80 + this run's median control max per instrument, after its A/A-quiet check, capped.
      const pairs = await boundaryPairs(
        () => runBar(`boundary +${BOUNDARY_PASS_MS} ms`, port, authLoad(20, "discover_agents", {}), { onLoop: loopBlock(BOUNDARY_PASS_MS) }),
        (x, sized) =>
          runBar(
            x === "health"
              ? `boundary AVAILABILITY +${sized.ms.toFixed(1)} ms (80 + median control /health max ${sized.median.toFixed(1)})`
              : `boundary LOOP +${sized.ms.toFixed(1)} ms (80 + median control ELD ${sized.median.toFixed(1)})`,
            port,
            authLoad(20, "discover_agents", {}),
            { onLoop: loopBlock(sized.ms) },
          ),
      );
      for (const x of INSTRS) {
        const sized = pairs.sized[x];
        const claim = x === "health" ? healthClaim(sized?.median ?? Number.NaN) : loopClaim(sized?.median ?? Number.NaN);
        const at20 = pairs.at20[x];
        const blk = pairs.block[x];
        announce(
          at20 && blk && sized?.ms != null
            ? `CLAIM ${claim} | boundary EVALUATED: +${sized.ms.toFixed(1)} ms ${blk[x].verdict} (d=${blk[x].d.toFixed(1)}); +${BOUNDARY_PASS_MS} ms ${at20[x].verdict} (d=${at20[x].d.toFixed(1)}) | bars run: ${pairs.runs.join(", ")}`
            : `CLAIM ${claim} | boundary ${pairs.status} (${pairs.why.join("; ")}) | bars run: ${pairs.runs.join(", ")}`,
        );
      }

      expectTrips(neg); // on EVERY run, noisy or not: the instrument must not be blind
      expect(noisy.eld.verdict, "injected A/A noise must read NOT_EVALUATED (never red)").toBe("NOT_EVALUATED");
      expectBoundary(pairs); // a FAIL with its reason; a FINAL NOT_EVALUATED as itself
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

  // A helper child resumes THIS process: it is armed first (ready on stdout), then this process signals the child
  // (SIGUSR2, a synchronous syscall) and stops ITSELF (SIGSTOP on its own pid, never a group); the child sends
  // SIGCONT after STALL_MS. RESIDUAL, stated: if the child died between the two signals, this process would stay
  // stopped until the CI job's own timeout.
  const armHostStall = async (): Promise<{ pid: number; fire: () => void; fired: () => boolean; stopMs: () => number | null; disarm: () => Promise<void> }> => {
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
    console.log(contextLabel() + `HOST-STALL helper pid ${childPid} targets the test process pid ${pid} (SIGSTOP on itself only)`);
    const exited = new Promise<void>((res) => child.once("exit", () => res()));
    await new Promise<void>((res, rej) => {
      child.stdout!.once("data", () => res());
      child.once("exit", (code) => rej(new Error(`the stall helper exited early (${code})`)));
    });
    let fired = false;
    let stopMs: number | null = null;
    return {
      pid: childPid!,
      fire: () => {
        fired = true;
        process.kill(childPid!, "SIGUSR2");
        // The plant's own length, as the planting thread saw it (R2; STOP_MEASURE_SRC, never the time across kill()).
        stopMs = stopAndMeasure(() => process.kill(pid, "SIGSTOP"), STALL_MS - PLANT_TOLERANCE_MS, STALL_MS + 1000);
      },
      fired: () => fired,
      stopMs: () => stopMs,
      // A fired helper exits by itself after SIGCONT; an unfired one is ended by its RECORDED pid (SIGTERM: its own
      // handler exits, and its exit hook's SIGCONT to a running process is a no-op). Fired from the LOAD worker (the
      // preparation case), this thread never saw it: the helper has exited already, and ESRCH is not an error.
      disarm: async () => {
        if (!fired) {
          try {
            process.kill(childPid!, "SIGTERM");
          } catch {
            /* it already exited */
          }
        }
        await exited;
      },
    };
  };

  it("CEILING, a freeze: one auth round's daemon loop blocked 600 ms with the sentinel quiet FAILS, final, never re-run; every round blocked FAILS too", async () => {
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`);
      // R2: each planted block's own duration is recorded, and verified with the sentinel quiet, before its verdict.
      const timedBlock = (into: PlantSpan[], at: number) => {
        const from = absNow();
        loopBlock(STALL_MS)();
        into[at] = { from, to: absNow() };
      };
      const verified = (label: string, b: BarStats, blocks: PlantSpan[], rounds: number[]) => {
        for (const k of rounds) {
          const fault = freezePlantFault(`${label}, auth round ${k + 1}`, STALL_MS, blocks[k] ?? null, b.auth[k]);
          if (fault) throw new Error(fault);
        }
        return b;
      };
      let round = 0;
      const one = await gatedBar("ceiling RED: one auth round frozen", async () => {
        round = 0;
        const blocks: PlantSpan[] = [];
        const b = await runBar(`ceiling RED: auth round ${STALL_ROUND + 1} frozen ${STALL_MS} ms`, port, authLoad(20, "discover_agents", {}), {
          onLoop: () => {
            if (round === STALL_ROUND) timedBlock(blocks, round);
            round++;
          },
        });
        return verified("one auth round frozen", b, blocks, [STALL_ROUND]);
      });
      const every = await gatedBar("ceiling RED: every auth round frozen", async () => {
        let k = 0;
        const blocks: PlantSpan[] = [];
        const b = await runBar(`ceiling RED: every auth round frozen ${STALL_MS} ms`, port, authLoad(20, "discover_agents", {}), { onLoop: () => timedBlock(blocks, k++) });
        return verified("every auth round frozen", b, blocks, Array.from({ length: K }, (_, i) => i));
      });
      for (const [x, frozen] of [[one, 1], [every, K]] as const) {
        const c = ceilingVerdict(x.result.label, x.result.auth);
        expect(c.verdict, `${x.result.label}: the planted freeze must read as a freeze (${c.why || "no breach"})`).toBe("FAIL");
        expect(x.result.auth.filter((r) => r.eldMax >= CEILING_MS).length, `${x.result.label}: the loop breached the ceiling in each frozen round`).toBe(frozen);
        expect(x.final.status, x.final.why.join("; ")).toBe("FAIL");
        expect(x.attempts, `${x.result.label}: a ceiling breach is never re-run`).toBe(1);
      }
    });
  }, 300_000);

  it("CEILING, a host stall: the whole test process stopped 600 ms in one auth round reads NOT_EVALUATED (the dedicated sentinel's own stall COVERS the breach) and is re-run; three stalled attempts are a FINAL NOT_EVALUATED, never FAIL", async () => {
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
          if (helper) {
            // R2: CONFIRM STIMULATED. A plant that did not land throws a FIXTURE_FAULT: never re-run, never a code FAIL.
            const fault = hostStallPlantFault(`${label}, auth round ${STALL_ROUND + 1}`, STALL_MS, helper.stopMs(), bar.auth[STALL_ROUND]);
            if (fault) throw new Error(fault);
          }
          return bar;
        } finally {
          await helper?.disarm();
        }
      };
      // R1: the retry SELF-TEST asserts what the retry machinery did; the unplanted re-run's live verdict is REPORTED.
      let onceCalls = 0;
      const onceBars: BarStats[] = [];
      const once = await gatedBar("ceiling: a host stall in attempt 1 only", async () => {
        const b = await stalledAttempt(`ceiling: whole process stopped ${STALL_MS} ms (attempt 1 only)`, onceCalls++ === 0);
        onceBars.push(b);
        return b;
      });
      expectRetrySelfTest("ceiling: a host stall in attempt 1 only", once, onceBars);

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

  /** One auth window held open `holdMs` (its pool work is a sleep), so planted stalls land INSIDE it. */
  const heldWindow = (port: number, load: Load, onLoop: () => void, holdMs: number) => measure(port, load, onLoop, () => new Promise((r) => setTimeout(r, holdMs)));

  it("CEILING, the load worker is not a sentinel: a LOAD-worker-only stall and a SEPARATE daemon freeze in one window FAIL (Codex's counterexample)", async () => {
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`);
      // The load worker busy 600 ms as the window opens; the daemon's loop blocked 600 ms from 700 ms: never overlapping.
      let plant: PlantSpan = null;
      const r = await heldWindow(port, { ...authLoad(20, "discover_agents", {}), workerStallMs: STALL_MS }, () => setTimeout(() => {
        const from = absNow();
        loopBlock(STALL_MS)();
        plant = { from, to: absNow() };
      }, STALL_MS + 100), 2_000);
      const fault = freezePlantFault("the counterexample, the daemon freeze", STALL_MS, plant, r);
      if (fault) throw new Error(fault);
      const loops = r.breaches.filter((b) => b.kind === "loop-delay");
      expect(r.loadGapMax, "precondition: the LOAD worker did stall").toBeGreaterThanOrEqual(STALL_MS - PLANT_TOLERANCE_MS);
      expect(loops.length, `precondition: the daemon's freeze is a located breach (${JSON.stringify(r.breaches)})`).toBeGreaterThanOrEqual(1);
      // (the sentinel's quiet on the freeze is checked by freezePlantFault above: the freeze's own uncovered time)
      const c = ceilingVerdict("Codex's counterexample", [r]);
      expect(c.verdict, c.why).toBe("FAIL");
    });
  }, 60_000);

  it("CEILING, a busy load worker OVERLAPPING a daemon freeze, the idle sentinel quiet: FAIL", async () => {
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`);
      let plant: PlantSpan = null;
      const r = await heldWindow(port, { ...authLoad(20, "discover_agents", {}), workerStallMs: STALL_MS + 50 }, () => {
        const from = absNow();
        loopBlock(STALL_MS)();
        plant = { from, to: absNow() };
      }, 1_500);
      const fault = freezePlantFault("busy load worker over a freeze", STALL_MS, plant, r);
      if (fault) throw new Error(fault);
      expect(r.loadGapMax, "precondition: the LOAD worker was busy through the freeze").toBeGreaterThanOrEqual(STALL_MS - PLANT_TOLERANCE_MS);
      expect(r.breaches.some((b) => b.kind === "loop-delay"), `precondition: the freeze is a located breach (${JSON.stringify(r.breaches)})`).toBe(true);
      // (the sentinel's quiet on the freeze is checked by freezePlantFault above: the freeze's own uncovered time)
      const c = ceilingVerdict("busy load worker over a freeze", [r]);
      expect(c.verdict, c.why).toBe("FAIL");
    });
  }, 60_000);

  it("CEILING, a host stall during PREPARATION (before the window opens), its covering sentinel gap entirely before the window: a sentinel-covered breach reads NOT_EVALUATED, not FAIL", async () => {
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`);
      const helper = await armHostStall();
      let r: Reading;
      try {
        r = await measure(port, { ...authLoad(20, "discover_agents", {}), prepHostStallHelperPid: helper.pid, prepStopFloorMs: STALL_MS - PLANT_TOLERANCE_MS });
      } finally {
        await helper.disarm();
      }
      // R2: CONFIRM STIMULATED. The load worker's own time across its SIGSTOP, and the sentinel's gap (it is asked over
      // the envelope of every included sample, so the plant's gap is in its stream): both >= the plant - 50.
      const prepFault = hostStallPlantFault("a host stall during PREPARATION", STALL_MS, r.prepStopMs ?? null, r);
      if (prepFault) throw new Error(prepFault);
      const pre = r.breaches.filter((b) => b.kind === "/health" && b.from < r.windowFrom);
      const covering = (r.sentinelGaps ?? []).filter((g) => g.to <= r.windowFrom && pre.some((b) => overlapMs(g, b) > 0));
      const c = ceilingVerdict("preparation-period host stall", [r]);
      // Logged FIRST, so a red run still shows what the instrument saw and what the ceiling decided.
      console.log(contextLabel() + `PREP-STALL verdict ${c.verdict} | window opened ${r.windowFrom.toFixed(1)} | /health breaches before it: ${pre.map((b) => `[${b.from.toFixed(1)}, ${b.to.toFixed(1)}] (starts ${(r.windowFrom - b.from).toFixed(1)} ms before; uncovered ${(b.to - b.from - unionOverlapMs(b, r.sentinelGaps ?? [])).toFixed(1)} ms)`).join(", ") || "none"} | covering sentinel gaps: ${covering.map((g) => `[${g.from.toFixed(1)}, ${g.to.toFixed(1)}] (ends ${(r.windowFrom - g.to).toFixed(1)} ms before)`).join(", ") || "none in the stream"}`);
      expect(pre.length, `precondition: a /health breach started BEFORE the window opened (${JSON.stringify(r.breaches)}, window from ${r.windowFrom})`).toBeGreaterThanOrEqual(1);
      expect(c.verdict, c.why).toBe("NOT_EVALUATED");
      expect(covering.length, `and its covering sentinel gap ENDS before the window opens, so a query from the window's start would miss it (${JSON.stringify(r.sentinelGaps)})`).toBeGreaterThanOrEqual(1);
    });
  }, 60_000);

  it("CEILING, a missing sentinel stream is an INSTRUMENT FAULT, never a pass (the ceiling and the bar both refuse)", async () => {
    await withDaemon(async (port) => {
      await fetch(`http://127.0.0.1:${port}/health`);
      let plant: PlantSpan = null;
      const r = await heldWindow(port, authLoad(20, "discover_agents", {}), () => {
        const from = absNow();
        loopBlock(STALL_MS)();
        plant = { from, to: absNow() };
      }, 1_000);
      const fault = freezePlantFault("missing sentinel stream, the freeze", STALL_MS, plant, r);
      if (fault) throw new Error(fault);
      expect(ceilingVerdict("wired", [r]).verdict, "the same reading WITH its stream: a freeze").toBe("FAIL");
      const dropped = { ...r, sentinelGaps: undefined };
      expect(() => ceilingVerdict("unwired", [dropped])).toThrow(/INSTRUMENT FAULT/);
      const unwired: BarStats = { label: "unwired sentinel", control: [dropped], control2: [dropped], auth: [dropped], compares: 0, perRound: [0], health: judge([1], [1], [1]), eld: judge([1], [1], [1]), pooled: false };
      expect(() => barOutcome(unwired)).toThrow(/INSTRUMENT FAULT/);
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
