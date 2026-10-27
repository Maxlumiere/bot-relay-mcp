// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * REPORT ONLY, TEST ONLY: who blocked the main thread? The timing bars' daemon runs IN the test process, so a
 * main-thread freeze (a /health breach and a loop-delay breach that agree, with the idle sentinel worker unaffected)
 * is either the DAEMON's synchronous work (a SQLite statement, a checkpoint) or the HARNESS's (a sync fs call, a sync
 * child process). This records every SYNCHRONOUS call of either kind that takes at least `thresholdMs`, with its call
 * stack, on the bars' own clock, so a breach can be matched to the call that spanned it.
 *
 * It wraps, in THIS process only:
 *   - better-sqlite3: Database#prepare/exec/pragma, Statement#run/get/all/iterate (the prototypes, so every handle
 *     the daemon opens is covered, including one reopened after closeDb), and every function Database#transaction
 *     returns (its COMMIT, with any fsync or checkpoint, runs inside the library, not in a Statement call);
 *   - fs: every *Sync function; child_process: execFileSync, execSync, spawnSync. syncBuiltinESMExports() carries the
 *     wrappers to ESM named imports (`import { writeFileSync } from "fs"`) too.
 * The wrappers only time and record: the call, its arguments, its result and its throw are passed through unchanged.
 * Installed only when asked (RELAY_TIMING_DIAG=1 in tests/pr-b-failed-auth.test.ts); never a verdict input.
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
  /** Restore every wrapped function. */
  uninstall(): void;
}

const MAX_KEPT = 1000;

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
  const { now, thresholdMs } = opts;
  const kept: SlowCall[] = [];
  let total = 0;
  const restores: Array<() => void> = [];

  const wrap = (owner: Record<string, unknown>, name: string, label: string, describe: (self: unknown, args: unknown[]) => string) => {
    const original = owner[name];
    if (typeof original !== "function") return;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const from = now();
      try {
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      } finally {
        const to = now();
        if (to - from >= thresholdMs) {
          total++;
          kept.push({ what: label, detail: describe(this, args), from, to, stack: callerStack() });
          if (kept.length > MAX_KEPT) kept.shift();
        }
      }
    };
    for (const k of Object.keys(original as object)) (wrapped as unknown as Record<string, unknown>)[k] = (original as unknown as Record<string, unknown>)[k];
    owner[name] = wrapped;
    restores.push(() => {
      owner[name] = original;
    });
  };

  const timed = <F extends (...a: unknown[]) => unknown>(fn: F, label: string, detail: string): F => {
    const t = function (this: unknown, ...args: unknown[]) {
      const from = now();
      try {
        return fn.apply(this, args);
      } finally {
        const to = now();
        if (to - from >= thresholdMs) {
          total++;
          kept.push({ what: label, detail, from, to, stack: callerStack() });
          if (kept.length > MAX_KEPT) kept.shift();
        }
      }
    } as unknown as F;
    return t;
  };
  if (opts.databaseProto) {
    for (const m of ["prepare", "exec", "pragma"]) wrap(opts.databaseProto, m, `sqlite Database#${m}`, (_s, a) => short(a[0]));
    const dbProto = opts.databaseProto;
    const originalTx = dbProto.transaction;
    if (typeof originalTx === "function") {
      dbProto.transaction = function (this: unknown, ...args: unknown[]) {
        const tx = (originalTx as (...a: unknown[]) => Record<string, unknown> & ((...a: unknown[]) => unknown)).apply(this, args);
        const out = timed(tx, "sqlite transaction (body + COMMIT)", "") as unknown as Record<string, unknown>;
        for (const v of ["deferred", "immediate", "exclusive"]) {
          if (typeof tx[v] === "function") out[v] = timed(tx[v] as (...a: unknown[]) => unknown, `sqlite transaction.${v} (body + COMMIT)`, "");
        }
        return out;
      };
      restores.push(() => {
        dbProto.transaction = originalTx;
      });
    }
  }
  if (opts.statementProto) {
    for (const m of ["run", "get", "all", "iterate"]) {
      wrap(opts.statementProto, m, `sqlite Statement#${m}`, (self) => short((self as { source?: unknown })?.source));
    }
  }
  const fsObj = fs as unknown as Record<string, unknown>;
  for (const name of Object.keys(fsObj)) {
    if (name.endsWith("Sync") && typeof fsObj[name] === "function") wrap(fsObj, name, `fs.${name}`, (_s, a) => short(a[0]));
  }
  const cp = childProcess as unknown as Record<string, unknown>;
  for (const name of ["execFileSync", "execSync", "spawnSync"]) wrap(cp, name, `child_process.${name}`, (_s, a) => `${short(a[0])} ${Array.isArray(a[1]) ? short((a[1] as unknown[]).join(" ")) : ""}`.trim());

  syncBuiltinESMExports();
  return {
    overlapping: (from, to) => kept.filter((c) => c.from < to && c.to > from),
    count: () => total,
    uninstall: () => {
      while (restores.length) restores.pop()!();
      syncBuiltinESMExports();
    },
  };
}
