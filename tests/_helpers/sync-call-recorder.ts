// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * REPORT ONLY, TEST ONLY: who blocked the main thread? The timing bars' daemon runs IN the test process, so a
 * main-thread freeze (a /health breach and a loop-delay breach that agree, with the idle sentinel worker unaffected)
 * is either the DAEMON's synchronous work (a SQLite statement, a COMMIT, a checkpoint) or the HARNESS's (a sync fs call,
 * a sync child process). This records every SYNCHRONOUS call of the kinds below that takes at least `thresholdMs`,
 * with its call stack, on the bars' own clock, so a breach can be matched to the call that spanned it.
 *
 * COVERED, in THIS process only:
 *   - better-sqlite3: Database#prepare/exec/pragma, Statement#run/get/all, every next() of an iterator Statement#iterate
 *     returns (rows are evaluated there, not in iterate() itself), and every function Database#transaction returns,
 *     with its variants (its COMMIT, with any fsync or checkpoint, runs inside the library, not in a Statement call);
 *   - fs: every *Sync function; child_process: execFileSync, execSync, spawnSync. syncBuiltinESMExports() carries the
 *     wrappers to ESM named imports (`import { writeFileSync } from "fs"`) too.
 * NOT COVERED (a "NO recorded sync call" line is ABSENCE OF EVIDENCE, never "no block"):
 *   - a function captured BEFORE install (a destructured fs function, a transaction created earlier, a Statement
 *     method bound earlier) keeps calling the original;
 *   - other native addons; crypto and zlib *Sync; Atomics.wait; plain JavaScript compute; GC (reported separately).
 * TIMING NEUTRALITY IS NOT ESTABLISHED: every wrapped call, fast ones too, pays two clock reads and a closure call.
 *
 * SAFETY: ONE recorder per process (a second install while one is active throws, so overlapping installs can never
 * restore out of order); installation is all-or-nothing (a failure part-way restores every change and re-syncs the
 * ESM exports, then rethrows); uninstall is idempotent; after it, any wrapper a caller still holds (a transaction
 * function made while installed, a captured fs function) passes straight through without recording.
 */
import fs from "fs";
import childProcess from "child_process";
import { syncBuiltinESMExports } from "module";

export interface SlowCall {
  /** What ran: "sqlite Statement#run", "fs.writeFileSync", "child_process.spawnSync", … */
  what: string;
  /** A short, single-line description of the arguments (SQL text, a path, a command). */
  detail: string;
  /** Absolute start and end (ms, the clock the caller passed in). */
  from: number;
  to: number;
  /** The caller's stack (the recorder's own frames removed), trimmed. */
  stack: string;
}

export interface SyncRecorder {
  /** Every recorded call overlapping [from, to]. */
  overlapping(from: number, to: number): SlowCall[];
  /** How many calls were recorded in total (all kinds, at or over the threshold). */
  count(): number;
  /** Restore every wrapped function (idempotent); wrappers still held elsewhere stop recording. */
  uninstall(): void;
}

const MAX_KEPT = 1000;
/** The process's one active recorder (or null). */
let activeRecorder: SyncRecorder | null = null;
const TX_VARIANTS = ["default", "deferred", "immediate", "exclusive"];

function short(v: unknown): string {
  if (typeof v === "string") return v.replace(/\s+/g, " ").slice(0, 120);
  if (Buffer.isBuffer(v)) return `<buffer ${v.length}>`;
  if (v instanceof URL) return v.href.slice(0, 120);
  if (typeof v === "number") return String(v);
  return typeof v;
}

function callerStack(): string {
  const lines = (new Error().stack ?? "").split("\n").slice(1).map((l) => l.trim());
  return lines.filter((l) => !/_helpers\/sync-call-recorder\.ts/.test(l)).slice(0, 8).join(" <- "); // only THIS helper's frames
}

/**
 * Install the recorder. `statementProto` / `databaseProto` are better-sqlite3's prototypes (read from a live handle
 * by the caller: `Object.getPrototypeOf(db)` and `Object.getPrototypeOf(db.prepare("SELECT 1"))`).
 */
export function installSyncRecorder(opts: {
  now: () => number;
  thresholdMs: number;
  databaseProto?: Record<string, unknown>;
  statementProto?: Record<string, unknown>;
}): SyncRecorder {
  if (activeRecorder) throw new Error("sync-call-recorder: a recorder is already active in this process (one at a time; uninstall it first)");
  const { now, thresholdMs } = opts;
  const kept: SlowCall[] = [];
  let total = 0;
  let active = true;
  const restores: Array<() => void> = [];

  /** `fn`, timed while the recorder is active; a straight pass-through once it is not. */
  const timed = <F extends (...a: unknown[]) => unknown>(fn: F, label: string, describe: (self: unknown, args: unknown[]) => string, after?: (result: unknown) => unknown): F =>
    function (this: unknown, ...args: unknown[]) {
      if (!active) return fn.apply(this, args);
      const from = now();
      try {
        const result = fn.apply(this, args);
        return after ? after(result) : result;
      } finally {
        const to = now();
        if (active && to - from >= thresholdMs) {
          total++;
          kept.push({ what: label, detail: describe(this, args), from, to, stack: callerStack() });
          if (kept.length > MAX_KEPT) kept.shift();
        }
      }
    } as unknown as F;

  const replace = (owner: Record<string, unknown>, name: string, value: unknown) => {
    const original = owner[name];
    owner[name] = value;
    restores.push(() => {
      owner[name] = original;
    });
  };
  const wrap = (owner: Record<string, unknown>, name: string, label: string, describe: (self: unknown, args: unknown[]) => string, after?: (result: unknown) => unknown) => {
    const original = owner[name];
    if (typeof original !== "function") return;
    const wrapped = timed(original as (...a: unknown[]) => unknown, label, describe, after) as unknown as Record<string, unknown>;
    for (const k of Object.keys(original as object)) wrapped[k] = (original as unknown as Record<string, unknown>)[k];
    replace(owner, name, wrapped);
  };

  const rollback = () => {
    active = false;
    while (restores.length) restores.pop()!();
    syncBuiltinESMExports();
    if (activeRecorder === self) activeRecorder = null;
  };
  let self: SyncRecorder | null = null;

  try {
    if (opts.databaseProto) {
      const dbProto = opts.databaseProto;
      for (const m of ["prepare", "exec", "pragma"]) wrap(dbProto, m, `sqlite Database#${m}`, (_s, a) => short(a[0]));
      const originalTx = dbProto.transaction;
      if (typeof originalTx === "function") {
        replace(dbProto, "transaction", function (this: unknown, ...args: unknown[]) {
          const tx = (originalTx as (...a: unknown[]) => unknown).apply(this, args) as ((...a: unknown[]) => unknown) & Record<string, unknown>;
          if (!active) return tx;
          // The returned function's WHOLE property graph is kept: every own descriptor of the function AND of each
          // variant is copied (.database, and the variants' links to each other), with every link to a variant pointing
          // at its timed twin. The variants are non-configurable, so the values are swapped in the descriptor maps
          // BEFORE the one defineProperties (redefining them afterwards throws).
          const out = timed(tx, "sqlite transaction (body + COMMIT)", () => "");
          const twins = new Map<unknown, unknown>([[tx, out]]);
          for (const v of TX_VARIANTS) {
            const fn = tx[v];
            if (typeof fn === "function" && !twins.has(fn)) twins.set(fn, timed(fn as (...a: unknown[]) => unknown, `sqlite transaction.${v} (body + COMMIT)`, () => ""));
          }
          for (const [orig, twin] of twins) {
            const descs = Object.getOwnPropertyDescriptors(orig);
            for (const v of TX_VARIANTS) {
              const d = descs[v];
              if (d && "value" in d && twins.has(d.value)) descs[v] = { ...d, value: twins.get(d.value) };
            }
            Object.defineProperties(twin, descs);
          }
          return out;
        });
      }
    }
    if (opts.statementProto) {
      for (const m of ["run", "get", "all"]) wrap(opts.statementProto, m, `sqlite Statement#${m}`, (self) => short((self as { source?: unknown })?.source));
      // iterate() only builds the iterator; its rows are evaluated in next(), so each next() is timed.
      wrap(opts.statementProto, "iterate", "sqlite Statement#iterate", (self) => short((self as { source?: unknown })?.source), (it) => {
        const iter = it as { next?: (...a: unknown[]) => unknown };
        if (iter && typeof iter.next === "function") iter.next = timed(iter.next.bind(iter), "sqlite Statement#iterate next()", () => "");
        return it;
      });
    }
    const fsObj = fs as unknown as Record<string, unknown>;
    for (const name of Object.keys(fsObj)) {
      if (name.endsWith("Sync") && typeof fsObj[name] === "function") wrap(fsObj, name, `fs.${name}`, (_s, a) => short(a[0]));
    }
    const cp = childProcess as unknown as Record<string, unknown>;
    for (const name of ["execFileSync", "execSync", "spawnSync"]) {
      wrap(cp, name, `child_process.${name}`, (_s, a) => `${short(a[0])} ${Array.isArray(a[1]) ? short((a[1] as unknown[]).join(" ")) : ""}`.trim());
    }
    syncBuiltinESMExports();
  } catch (err) {
    rollback(); // all-or-nothing: nothing stays patched when install fails part-way
    throw err;
  }

  self = {
    overlapping: (from, to) => kept.filter((c) => c.from < to && c.to > from),
    count: () => total,
    uninstall: () => {
      if (!active) return; // idempotent
      rollback();
    },
  };
  activeRecorder = self;
  return self;
}
