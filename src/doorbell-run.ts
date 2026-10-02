// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The doorbell job (ADR-0038; plan v3 PR 1): a SEPARATE local process, started as
 * `node <install>/dist/doorbell.js`, never `dist/index.js` (plan v3: the connector
 * classifier would read that as a connector with no row, and the deploy check would
 * fail forever). Nothing installs it yet: the launchd installer lands in PR 5b with the
 * heartbeat line that judges its build (invariant I1, src/entrypoints.ts).
 *
 * What it does, every cycle: read F1's canonical pending set for each local candidate
 * and WRITE-AHEAD an intent per agent with new mail (src/doorbell-core.ts). There is no
 * driver yet, so nothing is rung: the intents only land in the log.
 *
 *   - V1, as restated by ruling 8c83e4ce: NO LOGICAL WRITE to the relay DB, and the main
 *     file and -wal are never written by the doorbell (-shm reader coordination is
 *     inherent and permitted). It is opened READ-ONLY at the driver (openPendingDb), and
 *     ONLY when both WAL sidecars already exist: with either absent, it does not open and
 *     reports WAITING-FOR-WRITER (expected, not unhealthy; retried every cycle), so it
 *     never creates a sidecar with its own umask. A sidecar whose identity changed while
 *     the DB was being opened closes the handle at once (same state).
 *   - Its own state (the log) is opened no-follow and identity-checked; a log write that
 *     does not provably complete STOPS the job (exit 1): a restart rebuilds from the log,
 *     so a record already on disk is never written twice.
 *   - ADR-0048: the DB comes from the ONE strict resolver. A fault, or a DB that does not
 *     exist, refuses the start (exit 1); it never picks another DB.
 *   - No listener: it opens no socket of any kind, and no tool or HTTP route accepts an
 *     intent (A1 §A2).
 *   - A2.1 (never on a hub): there is no hub mode setting to read today, so the guarantee
 *     is STRUCTURAL: a candidate must be on THIS host (host_id equal to our own; unknown
 *     own host = no candidate), so no other machine's window is ever a target. An explicit
 *     hub refusal waits for a hub mode to exist (recorded in the plan, not invented here).
 *
 * Exit: 0 = stopped cleanly (--once done, or SIGTERM/SIGINT) · 1 = cannot run (resolver
 * fault, DB unreadable, log refused) · 2 = usage.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { LOADED_BUILD } from "./loaded-build.js";
import { resolveInstance, serializeResolution } from "./instance.js";
import { getOwnHostId } from "./liveness.js";
import { performance } from "perf_hooks";
import { effectiveRingMono, DEFAULT_BUDGET_PER_HOUR, DEFAULT_WINDOW_MS, MAX_WINDOW_MS, MIN_WINDOW_MS, planCycle, tunablesFault, type PendingRead } from "./doorbell-core.js";
import { appendRecord, closeLog, compactLog, LogWriteError, openLog, rungKey, stateDirFor, type IntentRecord, type LogHandle, type LogIo, type LogState } from "./doorbell-log.js";

export const DEFAULT_INTERVAL_MS = 5000;
/** D-2: the log's size cap, checked EVERY cycle. Over it: no ring, LOG-FULL, loud (a restart compacts). */
export const LOG_CAP_BYTES = 16 * 1024 * 1024;
export const MIN_INTERVAL_MS = 1000;
export const MAX_INTERVAL_MS = 600_000;

interface Args {
  once: boolean;
  intervalMs: number;
  windowMs: number;
  budgetPerHour: number;
}

function usage(out: NodeJS.WriteStream): void {
  out.write(
    "Usage: node dist/doorbell.js [--once] [--interval-ms N]\n" +
      "  The doorbell job: logs a content-free intent per agent with new pending mail.\n" +
      `  --once           run one cycle and exit\n` +
      `  --interval-ms N  cycle period, ${MIN_INTERVAL_MS}..${MAX_INTERVAL_MS} (default ${DEFAULT_INTERVAL_MS})\n` +
      `  --window-s N     per-agent coalescing window, seconds (default ${DEFAULT_WINDOW_MS / 1000}; bounds enforced)\n` +
      `  --budget-per-hour N  per-agent ring budget (default ${DEFAULT_BUDGET_PER_HOUR}; bounds enforced)\n`,
  );
}

function parseArgs(argv: string[]): Args | { error: string } | "help" {
  const a: Args = { once: false, intervalMs: DEFAULT_INTERVAL_MS, windowMs: DEFAULT_WINDOW_MS, budgetPerHour: DEFAULT_BUDGET_PER_HOUR };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--help" || t === "-h") return "help";
    else if (t === "--once") a.once = true;
    else if (t === "--interval-ms") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < MIN_INTERVAL_MS || v > MAX_INTERVAL_MS) {
        return { error: `--interval-ms must be an integer in ${MIN_INTERVAL_MS}..${MAX_INTERVAL_MS}` };
      }
      a.intervalMs = v;
    } else if (t === "--window-s") {
      // An INTEGER number of seconds, checked BEFORE scaling (#301 R1: 10.5 and 60.001 must not pass).
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < MIN_WINDOW_MS / 1000 || v > MAX_WINDOW_MS / 1000) {
        return { error: `--window-s must be an integer number of seconds in ${MIN_WINDOW_MS / 1000}..${MAX_WINDOW_MS / 1000}` };
      }
      a.windowMs = v * 1000;
    } else if (t === "--budget-per-hour") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v)) return { error: "--budget-per-hour needs a number" };
      a.budgetPerHour = v;
    } else return { error: `unknown argument ${JSON.stringify(t)}` };
  }
  const fault = tunablesFault(a);
  if (fault) return { error: fault };
  return a;
}

const fail = (reason: string): number => {
  process.stderr.write(`DOORBELL_FAILED: ${reason}\n`);
  return 1;
};

/** The install this process was loaded from (the parent of its dist/). */
function ownInstallDir(): string {
  const dist = path.dirname(fileURLToPath(import.meta.url));
  try {
    return fs.realpathSync(path.dirname(dist));
  } catch {
    return path.dirname(dist);
  }
}

/** The two WAL sidecars' identities, or null for one that is absent / not a regular file. */
function sidecarIds(dbPath: string): { wal: string | null; shm: string | null } {
  const id = (p: string): string | null => {
    try {
      const st = fs.lstatSync(p);
      return st.isFile() ? `${st.dev}:${st.ino}` : null;
    } catch {
      return null;
    }
  };
  return { wal: id(`${dbPath}-wal`), shm: id(`${dbPath}-shm`) };
}

/** Test seams: not reachable from the command line (dist/doorbell.js passes argv only). */
export interface DoorbellOptions {
  /** The log's file I/O (a short write, a failed fsync). */
  logIo?: LogIo;
  /** Runs after the DB's first read and BEFORE the post-open sidecar recheck. */
  afterDbOpen?: () => void;
  /** The log size cap (default LOG_CAP_BYTES). */
  logCapBytes?: number;
  /** The clocks (ruling 622689ba): wall for records and across restarts, monotonic within a lifetime. */
  clock?: { wallMs(): number; monoMs(): number };
  /** Runs at the start of every cycle (a test drives mail arrival with it). */
  beforeCycle?: (n: number) => void;
}

/** A wall step this large against the monotonic clock is a JUMP (ruling 622689ba (4)). */
export const CLOCK_JUMP_MS = 5000;

const realClock = { wallMs: () => Date.now(), monoMs: () => performance.now() };
const iso = (ms: number): string => new Date(ms).toISOString();


export async function runDoorbell(argv: string[], opts: DoorbellOptions = {}): Promise<number> {
  const args = parseArgs(argv);
  if (args === "help") {
    usage(process.stderr); // stderr: src/ keeps stdout for the MCP channel (tests/no-stdout-writes.test.ts)
    return 0;
  }
  if ("error" in args) {
    process.stderr.write(`doorbell: ${args.error}\n`);
    usage(process.stderr);
    return 2;
  }

  const resolution = resolveInstance();
  if (resolution.kind === "error") return fail(`the relay DB cannot be resolved (${resolution.reason})`);
  if (!resolution.exists) return fail(`no relay DB at ${resolution.dbPath}: nothing to watch (a missing DB is never "no mail")`);
  const dbPath = resolution.dbPath;

  // The log first: it does not depend on the DB being openable yet.
  let log: LogHandle;
  let state: LogState;
  try {
    const opened = openLog(stateDirFor(dbPath), opts.logIo);
    log = opened.handle;
    state = opened.state;
    if (opened.recoveredBytes > 0) process.stderr.write(`doorbell: recovered a torn log tail (${opened.recoveredBytes} bytes, never acted on)\n`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const clock = opts.clock ?? realClock;
  const startWall = clock.wallMs();
  const startMono = clock.monoMs();
  // Ruling 622689ba (2): every ring in the log is a PREVIOUS lifetime's; place it on this
  // lifetime's monotonic clock ONCE, here, before our header and before any compaction.
  const ringMono = effectiveRingMono(state.ringWalls, state.lastHeaderWall, startWall);
  try {
    appendRecord(log, {
      v: 1,
      type: "header",
      at: iso(startWall),
      pid: process.pid,
      build: { ...LOADED_BUILD },
      install_dir: ownInstallDir(),
      resolution: serializeResolution(resolution),
    });
  } catch (err) {
    closeLog(log);
    return fail(err instanceof Error ? err.message : String(err));
  }

  const { openPendingDb } = await import("./cli/pending.js");
  const { pendingMetadata, pendingSchemaGap, listAgentBindings } = await import("./db.js");
  let db: import("./sqlite-compat.js").CompatDatabase | null = null;

  /** Open the DB only with both sidecars present and unchanged across the open; else why not. */
  const tryOpenDb = async (): Promise<string | null> => {
    const before = sidecarIds(dbPath);
    if (!before.wal || !before.shm) {
      const missing = [!before.wal && "-wal", !before.shm && "-shm"].filter(Boolean).join(" and ");
      return `the relay DB has no ${missing} yet: waiting for a writer (the doorbell creates no sidecar)`;
    }
    const h = await openPendingDb(dbPath);
    let gap: string | null;
    try {
      gap = pendingSchemaGap(h); // the first read: SQLite maps the sidecars here
      opts.afterDbOpen?.();
    } catch (err) {
      h.close();
      throw err;
    }
    const after = sidecarIds(dbPath);
    if (after.wal !== before.wal || after.shm !== before.shm) {
      h.close();
      return "a WAL sidecar changed while the relay DB was being opened: closed at once, waiting for a writer";
    }
    if (gap) {
      h.close();
      throw new Error(`${dbPath} ${gap}`);
    }
    db = h;
    compactOnStart(h);
    return null;
  };

  /**
   * D-2 (ruling 8c83e4ce): COMPACT once, at the first successful DB open (the keep rule
   * needs the pending set). An intent is kept while ANY of its (reading session, id) is
   * STILL in that agent's pending set, read for every agent in ONE snapshot: a message
   * that left pending for a session never re-enters it, and a re-pend to a new session
   * is a new key (V4), so a dropped key can never be needed again. The last few headers
   * are kept. (Open escalations join the keep rule when they exist, PR 3.)
   */
  const compactOnStart = (handle: import("./sqlite-compat.js").CompatDatabase): void => {
    const pendingNow = new Map<string, { rs: string | null; ids: Set<string> }>();
    handle.transaction(() => {
      for (const r of state.records) {
        if (r.type !== "intent" || pendingNow.has(r.intent.agent_name)) continue;
        const m = pendingMetadata(handle, r.intent.agent_name);
        pendingNow.set(r.intent.agent_name, { rs: m.reading_session, ids: new Set(m.messages.map((x) => x.id)) });
      }
    })();
    // Ruling 622689ba (3): each agent's LAST N intents (N = the budget) are kept REGARDLESS of
    // wall age, as EVIDENCE (plausibility and audit): a wall jump can never erase them. They
    // are not automatically counted: counting is effectiveRingMono's rule.
    const lastN = new Set<string>();
    const byAgent = new Map<string, IntentRecord[]>();
    for (const r of state.records) if (r.type === "intent") byAgent.set(r.intent.agent_name, [...(byAgent.get(r.intent.agent_name) ?? []), r]);
    for (const list of byAgent.values()) for (const r of list.slice(-args.budgetPerHour)) lastN.add(r.intent.intent_id);
    const keep = (rec: IntentRecord): boolean => {
      if (lastN.has(rec.intent.intent_id)) return true;
      const p = pendingNow.get(rec.intent.agent_name);
      return !!p && p.rs === rec.covers.reading_session && rec.covers.message_ids.some((id) => p.ids.has(id));
    };
    const c = compactLog(log, keep);
    log = c.handle;
    state = c.state;
    if (c.afterBytes < c.beforeBytes) process.stderr.write(`doorbell: compacted the log, ${c.beforeBytes} → ${c.afterBytes} bytes\n`);
  };

  let stopping = false;
  let wake: (() => void) | null = null;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  let cycles = 0;
  let lastWall = startWall;
  let lastMono = 0;
  const cycle = (handle: import("./sqlite-compat.js").CompatDatabase): void => {
    opts.beforeCycle?.(cycles++);
    const nowWall = clock.wallMs();
    const nowMono = clock.monoMs() - startMono;
    // Ruling 622689ba (4): a wall step that disagrees with the monotonic one by > 5 s is a
    // JUMP: recorded (closed `clock` record), never acted on (the arithmetic is monotonic).
    const wallDelta = nowWall - lastWall;
    const monoDelta = nowMono - lastMono;
    if (Math.abs(wallDelta - monoDelta) > CLOCK_JUMP_MS) {
      appendRecord(log, { v: 1, type: "clock", at: iso(nowWall), mono_ms: Math.round(nowMono), wall_delta_ms: Math.round(wallDelta), mono_delta_ms: Math.round(monoDelta) });
      process.stderr.write(`doorbell: the wall clock jumped ${Math.round((wallDelta - monoDelta) / 1000)} s against the monotonic clock (recorded; timing is monotonic)\n`);
    }
    lastWall = nowWall;
    lastMono = nowMono;
    const plan = planCycle({
      bindings: listAgentBindings(handle),
      ownHostId: getOwnHostId(),
      pending: (name): PendingRead => {
        const m = pendingMetadata(handle, name);
        return { registered: m.registered, reading_session: m.reading_session, ids: m.messages.map((x) => x.id) };
      },
      rung: state.rung,
      ringMono,
      nowMono,
      budgetExhausted: state.budgetExhausted,
      windowMs: args.windowMs,
      budgetPerHour: args.budgetPerHour,
      newIntentId: () => randomUUID(),
      now: () => iso(nowWall),
    });
    for (const rec of plan.budget) {
      appendRecord(log, rec); // A3.2: once per state change, durable before the state moves
      if (rec.state === "exhausted") state.budgetExhausted.add(rec.agent_name);
      else state.budgetExhausted.delete(rec.agent_name);
      // Q4: surface it loudly (the board and the status verb read it from the log later).
      process.stderr.write(
        `doorbell: ring budget ${rec.state} for ${rec.agent_name} (${rec.rings_in_hour} rings in the last hour, budget ${rec.budget_per_hour})\n`,
      );
    }
    for (const rec of plan.intents) {
      appendRecord(log, rec); // write-ahead: complete and durable before it counts as rung
      for (const id of rec.covers.message_ids) state.rung.add(rungKey(rec.covers.reading_session, id));
      ringMono.set(rec.intent.agent_name, [...(ringMono.get(rec.intent.agent_name) ?? []), rec.mono_ms]);
    }
  };

  let code = 0;
  let waitingSaid: string | null = null;
  let logFullSaid = false;
  const cap = opts.logCapBytes ?? LOG_CAP_BYTES;
  try {
    while (!stopping) {
      try {
        if (!db) {
          const waiting = await tryOpenDb();
          if (waiting) {
            if (waiting !== waitingSaid) process.stderr.write(`doorbell: WAITING-FOR-WRITER: ${waiting}\n`); // once per state change
            waitingSaid = waiting;
          } else waitingSaid = null;
        }
        if (db) {
          // D-2: the cap, EVERY cycle. Over it, no ring at all: never grow, never drop silently.
          const size = fs.fstatSync(log.fd).size;
          if (size >= cap) {
            if (!logFullSaid) process.stderr.write(`doorbell: LOG-FULL: the log is ${size} bytes (cap ${cap}): not ringing until a restart compacts it\n`);
            logFullSaid = true;
          } else {
            if (logFullSaid) process.stderr.write("doorbell: the log is under its cap again: ringing resumes\n");
            logFullSaid = false;
            cycle(db);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof LogWriteError) {
          // FAIL-STOP: the record may already be on disk; never retry it from memory.
          process.stderr.write(`DOORBELL_FAILED: ${msg}; stopping (a restart rebuilds from the log)\n`);
          code = 1;
          break;
        }
        process.stderr.write(`doorbell: cycle failed: ${msg}\n`);
        if (args.once) {
          code = 1;
          break;
        }
      }
      if (args.once) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, args.intervalMs);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = null;
    }
  } finally {
    (db as import("./sqlite-compat.js").CompatDatabase | null)?.close();
    closeLog(log);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
  return code;
}
