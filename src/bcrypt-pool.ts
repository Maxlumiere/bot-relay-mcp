// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * EVERY bcrypt COMPARE runs here, on a worker thread, never on the event loop (PR-B; architect
 * ruling e26359ac (ii)).
 *
 * A bcrypt compare at 10 rounds costs ~64 ms of CPU. On the event loop, a burst of failed auths
 * froze the daemon: MEASURED, 20 wrong tokens blocked /health for 1.3 s, and an unknown token
 * (then a compare against every agent row) for 65 s. bcryptjs's own async API does NOT help:
 * it yields only once per 100 ms slice, so a ~64 ms compare never yields (MEASURED: 20
 * concurrent async compares lagged the loop 1257 ms; the same 20 on one worker thread, 1.7 ms).
 *
 *   - TWO workers (POOL_SIZE), lazily started, each kept alive only while it has a compare
 *     pending (a CLI still exits when its work is done).
 *   - A GLOBAL bound on queued compares (MAX_PENDING): overflow is REFUSED at once with
 *     BcryptBusyError ("busy, retry"), never a wait, so a flood cannot build an unbounded queue.
 *   - A worker that errors or exits FAILS CLOSED: every pending compare rejects, so the caller
 *     treats the token as not verified, and the next compare starts a fresh worker.
 *   - The worker runs bcryptjs's compareSync: on ITS thread, blocking is the point.
 *   - tests/pr-b-no-sync-bcrypt.test.ts fails on any bcrypt compare outside this module.
 */
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BCRYPTJS = require.resolve("bcryptjs");

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const bcrypt = require(${JSON.stringify(BCRYPTJS)});
parentPort.on("message", ({ id, token, hash }) => {
  let ok = false;
  try { ok = bcrypt.compareSync(token, hash); } catch { ok = false; }
  parentPort.postMessage({ id, ok });
});
`;

export const POOL_SIZE = 2;
export const MAX_PENDING = 16;

/** The pool is full: refused at once, never queued. */
export class BcryptBusyError extends Error {
  constructor() {
    super(`credential verification is busy (${MAX_PENDING} compares pending): retry`);
    this.name = "BcryptBusyError";
  }
}

interface Pending {
  resolve: (ok: boolean) => void;
  reject: (err: Error) => void;
}
interface Slot {
  worker: Worker;
  pending: Map<number, Pending>;
}

const slots: Array<Slot | null> = new Array(POOL_SIZE).fill(null);
let nextId = 0;
let compareCount = 0;
const pendingTotal = () => slots.reduce((n, s) => n + (s ? s.pending.size : 0), 0);

function failSlot(slot: Slot, err: Error): void {
  for (const p of slot.pending.values()) p.reject(err);
  slot.pending.clear();
}

function startSlot(i: number): Slot {
  const w = new Worker(WORKER_SOURCE, { eval: true });
  const slot: Slot = { worker: w, pending: new Map() };
  w.on("message", (m: { id: number; ok: boolean }) => {
    const p = slot.pending.get(m.id);
    if (!p) return;
    slot.pending.delete(m.id);
    if (slot.pending.size === 0) w.unref();
    p.resolve(m.ok === true);
  });
  const dead = (why: string) => {
    if (slots[i] === slot) slots[i] = null;
    failSlot(slot, new Error(`bcrypt worker ${why}: the token was NOT verified`));
  };
  w.on("error", (err) => dead(`failed (${err instanceof Error ? err.message : String(err)})`));
  w.on("exit", (code) => dead(`exited (code ${code})`));
  w.unref();
  slots[i] = slot;
  return slot;
}

/** The slot with the fewest pending compares (a dead or unstarted slot is started). */
function pickSlot(): Slot {
  let best = -1;
  let bestLoad = Infinity;
  for (let i = 0; i < POOL_SIZE; i++) {
    const load = slots[i]?.pending.size ?? 0;
    if (load < bestLoad) {
      best = i;
      bestLoad = load;
    }
  }
  return slots[best] ?? startSlot(best);
}

/**
 * Does `token` match the bcrypt `hash`? Resolves false for a mismatch. REJECTS with BcryptBusyError
 * at once when MAX_PENDING compares are already queued, and with an Error when a worker fails: in
 * both cases the caller must treat the token as NOT verified.
 */
export function compareOffLoop(token: string, hash: string): Promise<boolean> {
  if (pendingTotal() >= MAX_PENDING) return Promise.reject(new BcryptBusyError());
  compareCount++;
  const slot = pickSlot();
  const id = ++nextId;
  return new Promise<boolean>((resolve, reject) => {
    slot.pending.set(id, { resolve, reject });
    slot.worker.ref();
    slot.worker.postMessage({ id, token, hash });
  });
}

/** How many compares were requested (the zero-bcrypt COUNT test reads it). */
export function bcryptCompareCount(): number {
  return compareCount;
}

/** Stop the workers (tests; a daemon shutdown). Pending compares fail closed. */
export async function stopBcryptPool(): Promise<void> {
  const live = slots.filter((s): s is Slot => s !== null);
  slots.fill(null);
  for (const s of live) failSlot(s, new Error("bcrypt worker stopped: the token was NOT verified"));
  await Promise.all(live.map((s) => s.worker.terminate()));
}
