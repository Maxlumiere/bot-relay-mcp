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
 * and WRITE-AHEAD an intent per agent with new mail (src/doorbell-core.ts). PR 3: it also
 * judges each ring against that same read (effective, ineffective at the horizon, or moot
 * after a session change), re-rings what is still pending under the per-key cap, and opens
 * and closes escalations, all in this log (V1: never a relay message). There is no driver
 * yet, so nothing is rung: the intents only land in the log.
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
 * fault, DB unreadable, log refused) · 2 = usage · 4 = another live doorbell holds this instance
 * (EXIT_ALREADY_RUNNING; the instance lock, F5).
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { LOADED_BUILD } from "./loaded-build.js";
import { resolveInstance, serializeResolution } from "./instance.js";
import { anchorLivenessVerdict, getOwnHostId, processStartedAt } from "./liveness.js";
import { performance } from "perf_hooks";
import { watchableName, watchDirFor, watchSupervision } from "./watch-wake.js";
import { effectiveRingMono, intentKeepRule, placeRing, DEFAULT_BUDGET_PER_HOUR, DEFAULT_HORIZON_MS, DEFAULT_WINDOW_MS, MAX_HORIZON_MS, MAX_WINDOW_MS, MIN_HORIZON_MS, MIN_WINDOW_MS, ledgerInput, planCycle, tunablesFault, type PendingRead } from "./doorbell-core.js";
import { appendRecord, closeLog, compactLog, foldRecord, LogWriteError, openLog, RecordRefusedError, replaceStateFile, selectLedgerKeep, stateDirFor, type LogHandle, type LogIo, type LogRecord, type LogState } from "./doorbell-log.js";
import { conditionOf, FUTURE_TOLERANCE_MS, HEARTBEAT_FILENAME, MAX_COUNT, NOT_EVALUATED_MAX_NAMES, readHeartbeat, saturatingInc, type FailureKind, type Heartbeat } from "./doorbell-heartbeat.js";
import { acquireInstanceLock, EXIT_ALREADY_RUNNING, lockStillOurs, releaseInstanceLock, type LockHandle } from "./doorbell-lock.js";
import { AGENT_NAME_PATTERN } from "./types.js";

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
  horizonMs: number;
  /** V3: the operator agent named on escalation records (attribution only); null = none. */
  operator: string | null;
}

function usage(out: NodeJS.WriteStream): void {
  out.write(
    "Usage: node dist/doorbell.js [--once] [--interval-ms N]\n" +
      "  The doorbell job: logs a content-free intent per agent with new pending mail.\n" +
      `  --once           run one cycle and exit\n` +
      `  --interval-ms N  cycle period, ${MIN_INTERVAL_MS}..${MAX_INTERVAL_MS} (default ${DEFAULT_INTERVAL_MS})\n` +
      `  --window-s N     per-agent coalescing window, seconds (default ${DEFAULT_WINDOW_MS / 1000}; bounds enforced)\n` +
      `  --budget-per-hour N  per-agent ring budget (default ${DEFAULT_BUDGET_PER_HOUR}; bounds enforced)\n` +
      `  --horizon-s N    effectiveness horizon, seconds, ${MIN_HORIZON_MS / 1000}..${MAX_HORIZON_MS / 1000} and at least the window (default ${DEFAULT_HORIZON_MS / 1000})\n` +
      `  --operator NAME  the operator agent named on escalations (attribution only; default none)\n`,
  );
}

function parseArgs(argv: string[]): Args | { error: string } | "help" {
  const a: Args = { once: false, intervalMs: DEFAULT_INTERVAL_MS, windowMs: DEFAULT_WINDOW_MS, budgetPerHour: DEFAULT_BUDGET_PER_HOUR, horizonMs: DEFAULT_HORIZON_MS, operator: null };
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
    } else if (t === "--horizon-s") {
      // An INTEGER number of seconds, checked BEFORE scaling, like --window-s.
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < MIN_HORIZON_MS / 1000 || v > MAX_HORIZON_MS / 1000) {
        return { error: `--horizon-s must be an integer number of seconds in ${MIN_HORIZON_MS / 1000}..${MAX_HORIZON_MS / 1000}` };
      }
      a.horizonMs = v * 1000;
    } else if (t === "--operator") {
      const v = argv[++i];
      if (typeof v !== "string" || !AGENT_NAME_PATTERN.test(v)) return { error: "--operator needs a valid agent name" };
      a.operator = v;
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

/**
 * Open the relay DB READ-ONLY only when a writer has created BOTH WAL sidecars, and they are the
 * same files across the open (the doorbell never creates a sidecar, and never keeps a handle that
 * raced a writer's checkpoint). Returns the handle, or why it waits. A schema gap THROWS. Shared by
 * the job and by `relay doorbell status` (its live pending counts, PR 6), so both open it one way.
 */
export async function openRelayDbIfWritten(dbPath: string, afterFirstRead?: () => void): Promise<{ db: import("./sqlite-compat.js").CompatDatabase } | { waiting: string }> {
  const before = sidecarIds(dbPath);
  if (!before.wal || !before.shm) {
    const missing = [!before.wal && "-wal", !before.shm && "-shm"].filter(Boolean).join(" and ");
    return { waiting: `the relay DB has no ${missing} yet: waiting for a writer (the doorbell creates no sidecar)` };
  }
  const { openPendingDb } = await import("./cli/pending.js");
  const { pendingSchemaGap } = await import("./db.js");
  const h = await openPendingDb(dbPath);
  let gap: string | null;
  try {
    gap = pendingSchemaGap(h); // the first read: SQLite maps the sidecars here
    afterFirstRead?.();
  } catch (err) {
    h.close();
    throw err;
  }
  const after = sidecarIds(dbPath);
  if (after.wal !== before.wal || after.shm !== before.shm) {
    h.close();
    return { waiting: "a WAL sidecar changed while the relay DB was being opened: closed at once, waiting for a writer" };
  }
  if (gap) {
    h.close();
    throw new Error(`${dbPath} ${gap}`);
  }
  return { db: h };
}

/**
 * PR 6 (ruling 5dda2752): ONE binding's liveness, from its WINDOW anchor (pid + start token), exactly
 * as `relay fleet` judges a window (src/cli/fleet.ts). Never agents.agent_status or agents.session_id:
 * a window is alive or dead by kernel fact, whatever the relay last recorded about the agent.
 */
export function bindingLiveness(b: { host_id: string; window_pid?: number | null; window_pid_start?: string | null }, ownHostId: string | null): import("./liveness.js").AnchorVerdict {
  return anchorLivenessVerdict({ host_id: b.host_id, agent_pid: b.window_pid ?? null, agent_pid_start: b.window_pid_start ?? null }, ownHostId);
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
  /** After each heartbeat write (the structural test watches every write). */
  onHeartbeat?: (hb: Heartbeat) => void;
  /** Test seam: alter a cycle's plan before it is written (e.g. to make the writer refuse a record). */
  mutatePlan?: (plan: ReturnType<typeof planCycle>) => void;
  /** PR 6 (#310 Codex R1 #2): wrap the all-agent mail query (e.g. make it fail), to prove a failure is reported, not silent. */
  wrapMailAgents?: (real: () => readonly string[]) => () => readonly string[];
  /**
   * PR 7 (§v6): the watch supervisor's view of one agent (test seam). Default: the real watch dir beside
   * the relay DB (src/watch-wake.ts). `false` turns supervision off: PR 1-6's intent path (tests of it).
   */
  watchFit?: ((name: string, read: PendingRead) => { status: "live" | "stale" | "absent"; undeliveredAfterWake: boolean }) | false;
}

/** A wall step this large against the monotonic clock is a JUMP (ruling 622689ba (4)). */
export const CLOCK_JUMP_MS = 5000;

const realClock = { wallMs: () => Date.now(), monoMs: () => performance.now() };

/**
 * THE one read of an agent's pending set (A2.2, V4): the ids AND the reading session come from
 * ONE pendingMetadata call, so they are one snapshot, and the session is never re-derived. The
 * trigger (planCycle), compaction's keep rule and effectiveness (ringEffect) all read through it.
 */
export function pendingReadOf(dbm: Pick<typeof import("./db.js"), "pendingMetadata">, handle: import("./sqlite-compat.js").CompatDatabase, agentName: string): PendingRead {
  const m = dbm.pendingMetadata(handle, agentName);
  return { registered: m.registered, reading_session: m.reading_session, ids: m.messages.map((x) => x.id) };
}
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

  // F5 (ruling b556c011): the EXCLUSIVE instance lock, FIRST, before anything touches the state dir
  // (openLog's temp cleanup included). Another live doorbell here → refuse, loudly, distinct exit.
  const procStart = processStartedAt(process.pid); // the ONE UTC producer (#296), never its own ps
  let lock: ReturnType<typeof acquireInstanceLock>;
  try {
    lock = acquireInstanceLock(stateDirFor(dbPath), { pid: process.pid, proc_start: procStart, host_id: getOwnHostId() });
  } catch (err) {
    return fail(`the instance lock could not be taken (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!lock.ok) {
    const h = lock.holder;
    process.stderr.write(`DOORBELL_ALREADY_RUNNING: ${lock.reason}${h ? ` (held by pid ${h.pid} since ${h.since}, per its sidecar)` : ""}\n`);
    return EXIT_ALREADY_RUNNING;
  }
  try {
    return await runLocked(args, opts, resolution, dbPath, procStart, lock.handle);
  } finally {
    releaseInstanceLock(lock.handle);
  }
}

/** The job, with the instance lock HELD (released by the caller on every exit). */
async function runLocked(
  args: Args,
  opts: DoorbellOptions,
  resolution: Exclude<ReturnType<typeof resolveInstance>, { kind: "error" }>,
  dbPath: string,
  procStart: string | null,
  lockHandle: LockHandle,
): Promise<number> {
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
  const lastHeaderWallAtStart = state.lastHeaderWall;
  const ringMono = effectiveRingMono(state.ringWalls, lastHeaderWallAtStart, startWall);
  // PR 3: every intent on this lifetime's monotonic clock, by the SAME placement (placeRing):
  // a previous lifetime's at minus its wall age, or "now" when that age is implausible (the
  // horizon restarts from now: fewer rings, later escalation, the fail-safe direction).
  const intentMono = new Map<string, number>();
  for (const r of state.records) if (r.type === "intent") intentMono.set(r.intent.intent_id, placeRing(Date.parse(r.at), lastHeaderWallAtStart, startWall));
  /** THE write path: durable first (write-ahead), then the ONE reducer moves the state. */
  const write = (rec: LogRecord): void => {
    appendRecord(log, rec);
    foldRecord(state, rec);
  };
  try {
    write({
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

  // Q4 + F3 + F7: what carries across a restart, from the PREVIOUS heartbeat (read-only here; the
  // first cycle writes it): the start count, the failure STREAK and last failure (a restart loop
  // that fails every attempt must read failing), and the current condition with its start. An
  // UNREADABLE previous heartbeat resets all of them VISIBLY (starts_since moves; a stderr line).
  const prev = readHeartbeat(stateDirFor(dbPath));
  const prevHb = prev.kind === "ok" ? prev.heartbeat : null;
  let starts = 1;
  let startsSince = iso(startWall);
  if (prevHb && prevHb.starts < MAX_COUNT) {
    starts = prevHb.starts + 1;
    startsSince = prevHb.starts_since;
  } else if (prevHb) {
    process.stderr.write(`doorbell: the start count reached its bound (${MAX_COUNT}): it restarts at 1, from now\n`);
  }
  if (prev.kind === "unreadable") process.stderr.write(`doorbell: the previous heartbeat is unreadable (${prev.reason}): the start count and failure streak restart\n`);
  const installDir = ownInstallDir();

  const dbm = await import("./db.js");
  const { listAgentBindings, agentsWithPendingMail } = dbm;
  let db: import("./sqlite-compat.js").CompatDatabase | null = null;

  /** Open the DB only with both sidecars present and unchanged across the open; else why not. */
  const tryOpenDb = async (): Promise<string | null> => {
    const r = await openRelayDbIfWritten(dbPath, opts.afterDbOpen);
    if ("waiting" in r) return r.waiting;
    db = r.db;
    compactOnStart(r.db);
    return null;
  };

  /**
   * D-2 (ruling 8c83e4ce): COMPACT once, at the first successful DB open (the keep rule
   * needs the pending set). An intent is kept while ANY of its (reading session, id) is
   * STILL in that agent's pending set, read for every agent in ONE snapshot: a message
   * that left pending for a session never re-enters it, and a re-pend to a new session
   * is a new key (V4), so a dropped key can never be needed again. The last few headers
   * are kept. PR 3 (D-2 (b)): every OPEN escalation, every ring not judged yet, and the
   * effect records the counter and the progress detector still need (selectLedgerKeep).
   */
  const compactOnStart = (handle: import("./sqlite-compat.js").CompatDatabase): void => {
    const pendingNow = new Map<string, { rs: string | null; ids: Set<string> }>();
    handle.transaction(() => {
      for (const r of state.records) {
        if (r.type !== "intent" || pendingNow.has(r.intent.agent_name)) continue;
        const m = pendingReadOf(dbm, handle, r.intent.agent_name);
        pendingNow.set(r.intent.agent_name, { rs: m.reading_session, ids: new Set(m.ids) });
      }
    })();
    // THE keep rule (intentKeepRule): budget-relevant by the ONE placement; the last N as
    // evidence (ruling 622689ba (3)); still outstanding; still pending; or left while the job
    // was down and not recorded yet (PR 3). Effects and escalations: selectLedgerKeep.
    const keep = intentKeepRule(state.records, pendingNow, { lastHeaderWall: lastHeaderWallAtStart, startWall, budgetPerHour: args.budgetPerHour });
    const c = compactLog(log, keep, (records, kept) => selectLedgerKeep(records, kept, (agent) => pendingNow.get(agent)?.rs));
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
  /** What the current cycle attempt is doing, for the failure kind (Q5). */
  let phase: FailureKind = "other";
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
      write({ v: 1, type: "clock", at: iso(nowWall), mono_ms: Math.round(nowMono), wall_delta_ms: Math.round(wallDelta), mono_delta_ms: Math.round(monoDelta) });
      process.stderr.write(`doorbell: the wall clock jumped ${Math.round((wallDelta - monoDelta) / 1000)} s against the monotonic clock (recorded; timing is monotonic)\n`);
    }
    lastWall = nowWall;
    lastMono = nowMono;
    phase = "pending-read";
    const ownHostId = getOwnHostId();
    const plan = planCycle({
      bindings: listAgentBindings(handle),
      ownHostId,
      pending: (name) => pendingReadOf(dbm, handle, name),
      rung: state.rung,
      ringMono,
      nowMono,
      budgetExhausted: state.budgetExhausted,
      // PR 6: each binding's WINDOW anchor, exactly as `relay fleet` judges a window (src/cli/fleet.ts).
      liveness: (b) => bindingLiveness(b, ownHostId),
      mailAgents: (opts.wrapMailAgents ?? ((real) => real))(() => agentsWithPendingMail(handle)),
      boardOpen: state.boardOpen,
      // PR 7 (§v6): the WATCH SUPERVISOR. Each agent wakes through its own `relay watch --until-wake`
      // (zero doorbell tokens); the doorbell only boards a missing, hung or ineffective watch.
      ...(opts.watchFit === false ? {} : { watchFit: opts.watchFit ?? ((name: string, read: PendingRead) => (watchableName(name) ? watchSupervision(watchDirFor(dbPath, name), read, nowWall, args.horizonMs) : { status: "absent" as const, undeliveredAfterWake: false })) }),
      windowMs: args.windowMs,
      budgetPerHour: args.budgetPerHour,
      horizonMs: args.horizonMs,
      operator: args.operator,
      // PR 3: each agent's history, and the agents still owed a judgement, bound or not.
      ledger: ledgerInput(state.records, (rec) => {
        const m = intentMono.get(rec.intent.intent_id);
        if (m === undefined) throw new Error(`intent ${rec.intent.intent_id} has no place on this lifetime's clock`);
        return m;
      }),
      newIntentId: () => randomUUID(),
      now: () => iso(nowWall),
    });
    phase = "other";
    lastNotEvaluated = { names: plan.notEvaluated, mailQueryFailed: plan.mailQueryFailed !== null };
    if (plan.mailQueryFailed !== null) process.stderr.write(`doorbell: the mail query failed (${plan.mailQueryFailed}): agents with mail and no window could not be found this cycle\n`);
    opts.mutatePlan?.(plan);
    // In the planner's order: durable first (write-ahead), then the state moves (A3.2: each
    // record is a state change, written once).
    for (const rec of plan.records) {
      write(rec);
      if (rec.type === "budget") {
        // Q4: surface it loudly (the board and the status verb read it from the log later).
        process.stderr.write(`doorbell: ring budget ${rec.state} for ${rec.agent_name} (${rec.rings_in_hour} rings in the last hour, budget ${rec.budget_per_hour})\n`);
      } else if (rec.type === "board") {
        // The board and this log only (V1), like an escalation. Never a relay message.
        process.stderr.write(`doorbell: board ${rec.state} (${rec.case}) for ${rec.agent_name}${rec.close_reason ? `: ${rec.close_reason}` : ""}\n`);
      } else if (rec.type === "escalation") {
        // V1: the board and this log only; stderr is the job's own log. Never a relay message.
        process.stderr.write(`doorbell: escalation ${rec.state} (${rec.reason}) for ${rec.agent_name}${rec.close_reason ? `: ${rec.close_reason}` : ""}\n`);
      } else if (rec.type === "intent") {
        ringMono.set(rec.intent.agent_name, [...(ringMono.get(rec.intent.agent_name) ?? []), rec.mono_ms]);
        intentMono.set(rec.intent.intent_id, rec.mono_ms);
      }
    }
  };

  // THE heartbeat writer (ruling 9987c113 Q1 (i)): called ONLY from the loop above, once per cycle
  // attempt, with `cycles` incremented in the same write. Nothing else writes the heartbeat.
  let attempts = 0;
  /** PR 6: the agents THIS attempt's planned cycle could not evaluate; null when no cycle was planned. */
  let lastNotEvaluated: { names: string[]; mailQueryFailed: boolean } | null = null;
  let consecutiveFailures = prevHb?.consecutive_failures ?? 0;
  let lastFailure: Heartbeat["last_failure"] = prevHb?.last_failure ?? null;
  let cycleFailures = 0;
  let condition: Heartbeat["condition"] | null = prevHb?.condition ?? null;
  let conditionSince: string | null = prevHb?.condition_since ?? null;
  const writeHeartbeat = (attempt: { waiting: boolean; logFull: boolean; failed: FailureKind | null }): void => {
    const ne = lastNotEvaluated;
    const at = iso(clock.wallMs());
    attempts = saturatingInc(attempts);
    consecutiveFailures = attempt.failed ? saturatingInc(consecutiveFailures) : 0;
    if (attempt.failed) {
      cycleFailures = saturatingInc(cycleFailures);
      lastFailure = { at, kind: attempt.failed };
    }
    // F1: when the CURRENT condition began; it moves only on a change (carried across a restart).
    // A condition_since more than FUTURE_TOLERANCE_MS ahead of now (the wall clock went BACK) resets
    // to now, like the heartbeat's own future rule: carried, it would read as age 0 for as long as
    // the jump, and silence the waiting warning for hours, across restarts too (#304 R2 #4).
    const cond = conditionOf(attempt, consecutiveFailures);
    const sinceInFuture = conditionSince !== null && Date.parse(conditionSince) - Date.parse(at) > FUTURE_TOLERANCE_MS;
    if (cond !== condition || !conditionSince || sinceInFuture) {
      condition = cond;
      conditionSince = at;
    }
    const hb: Heartbeat = {
      v: 1,
      at,
      pid: process.pid,
      proc_start: procStart,
      started_at: iso(startWall),
      starts,
      starts_since: startsSince,
      cycles: attempts,
      interval_ms: args.intervalMs,
      condition: cond,
      condition_since: conditionSince,
      consecutive_failures: consecutiveFailures,
      cycle_failures: cycleFailures,
      last_failure: lastFailure,
      build: { ...LOADED_BUILD },
      install_dir: installDir,
      resolution: serializeResolution(resolution),
      not_evaluated: ne === null ? null : { count: ne.names.length, names: [...ne.names].sort().slice(0, NOT_EVALUATED_MAX_NAMES), mail_query_failed: ne.mailQueryFailed },
    };
    try {
      replaceStateFile(log, HEARTBEAT_FILENAME, JSON.stringify(hb) + "\n");
      opts.onHeartbeat?.(hb);
    } catch (err) {
      // Not fatal to ringing; LOUD: the status verb reads the stale heartbeat as `stale`.
      process.stderr.write(`doorbell: the heartbeat write failed (${err instanceof Error ? err.message : String(err)}): status will read stale\n`);
    }
  };

  let code = 0;
  let waitingSaid: string | null = null;
  let logFullSaid = false;
  const cap = opts.logCapBytes ?? LOG_CAP_BYTES;
  try {
    while (!stopping) {
      // ONE cycle ATTEMPT (ruling 9987c113): its outcome, then the ONE heartbeat write below.
      const attempt = { waiting: false, logFull: false, failed: null as FailureKind | null };
      lastNotEvaluated = null; // set only when THIS attempt plans a cycle
      let failStop = false;
      // F5: still the ONLY doorbell for this instance? Never act on a state dir we no longer own.
      if (!lockStillOurs(lockHandle)) {
        process.stderr.write("DOORBELL_FAILED: the instance lock file was removed or replaced (another doorbell could lock it): stopping\n");
        code = 1;
        break;
      }
      try {
        if (!db) {
          phase = "db-open";
          const waiting = await tryOpenDb();
          if (waiting) {
            attempt.waiting = true;
            if (waiting !== waitingSaid) process.stderr.write(`doorbell: WAITING-FOR-WRITER: ${waiting}\n`); // once per state change
            waitingSaid = waiting;
          } else waitingSaid = null;
        }
        if (db) {
          // D-2: the cap, EVERY cycle. Over it, no ring at all: never grow, never drop silently.
          phase = "other";
          const size = fs.fstatSync(log.fd).size;
          if (size >= cap) {
            attempt.logFull = true;
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
          // FAIL-STOP: the record may already be on disk; never retry it from memory. No heartbeat:
          // the job is stopping, and its heartbeat going stale is the loud signal.
          process.stderr.write(`DOORBELL_FAILED: ${msg}; stopping (a restart rebuilds from the log)\n`);
          code = 1;
          failStop = true;
          attempt.failed = "log-write";
        } else {
          attempt.failed = err instanceof RecordRefusedError ? "record-refused" : phase;
          process.stderr.write(`doorbell: cycle failed (${attempt.failed}): ${msg}\n`);
          if (args.once) code = 1;
        }
      }
      // ONE heartbeat per attempt, the fail-stop included (F2: best-effort, kind log-write; stale is the backstop).
      writeHeartbeat(attempt);
      if (failStop) break;
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
