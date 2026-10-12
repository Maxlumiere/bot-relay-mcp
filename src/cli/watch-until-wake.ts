// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay watch <agent> --until-wake`, `--arm-check` and `--lock-status` (doorbell PR 7, plan §v6;
 * Codex R1/R2 rulings ffcaf608, 9becb599).
 *
 * THE INVARIANT (ruling 9becb599): a watch process EXITS ONLY
 *   (a) to DELIVER A WAKE: one line, exit 0 (the harness's completion notification IS the wake), or
 *   (b) because its WINDOW IS GONE: silently (there is no session left to notify).
 * Every other terminal state goes DORMANT instead of exiting: lost race, superseded, lock lost, the
 * binding moved, the agent unregistered, a refusal or an instance-resolution failure discovered after
 * launch. Dormant = release everything, record the reason in `dormant/<pid>-<start>`, then block with
 * zero CPU, re-checking only whether the window (its anchor) is alive, and exit silently once it is
 * gone. An exit costs the agent a turn; dormancy costs nothing. A signal (a deliberate TaskStop, or
 * the session ending) exits, with a "no-mail: stopped" line.
 *
 * Arming, inside the agent's turn:
 *   1. `relay watch <agent> --arm-check` (FOREGROUND): decides every arm-time refusal (D1 ownership:
 *      the watch must descend from the agent's ONE live bound window, src/watch-owner.ts) and whether a
 *      live watch already runs. It prints `arm: …` (exit 0), `live: …` (exit 0, nothing to do) or
 *      `no-mail: refused (<why>): …` (exit 2).
 *   2. Only on `arm`: the command it prints, run in the BACKGROUND (run_in_background).
 *
 * The running watch:
 *   - ONE per (agent, window), OLDEST WINS. A HUNG holder (no heartbeat for HEARTBEAT_STALE_MS of AWAKE
 *     time) is ABANDONED, never signalled (D2): the new watch advances the generation (an O_EXCL create
 *     of gen-<N+1>) and takes that generation's lock. A holder checks for a later generation (and that
 *     its lock file is still its own) on every check AND immediately before every write. RESIDUAL
 *     (stated): a stale holder resuming between its check and its write can cause at worst a
 *     DUPLICATE wake.
 *   - EMIT FIRST, then persist (Codex R1 #3): a death between them costs at worst a duplicate wake.
 *   - READ-ONLY on the relay DB (opened only once a writer's WAL sidecars exist). Its writes go to its
 *     own dirs (src/watch-wake.ts).
 *
 * --lock-status: one word for the agent's ONE live window: live | stale | absent | never | no_window |
 * unknown (the window's start cannot be read right now: never reported as no window).
 *
 * UNREADABLE IS NOT GONE (INV-LIVE-01, rulings 476e65f1 + fedac068): a `ps` that times out, fails or
 * prints nothing is never "the window is gone". Only the kernel says gone (ESRCH, a different process on
 * the pid, or, for the launching shell, a reparent). On an unreadable start the watch takes no action.
 */
import fs from "fs";
import path from "path";

export const RETRY_BUSY = { attempts: 5, delayMs: 100 } as const;
export const HEARTBEAT_EVERY_MS = 60_000;
export const FALLBACK_POLL_MS = 3_000;
/** How often a DORMANT watch re-checks its window (ruling 9becb599: once a minute). */
export const DORMANT_CHECK_MS = 60_000;
/**
 * INV-LIVE-01 BOUNDEDNESS (architect ruling a98ec836, provisional): how long a watch accepts its window
 * being unobservable (every read unreadable, the kernel never saying gone), in AWAKE time, before it says
 * so loudly: a running watch goes DORMANT, and a dormant one rewrites its record (ANCHOR_UNOBSERVED_PREFIX).
 */
export const ANCHOR_UNKNOWN_BOUND_MS = 2 * 60 * 60 * 1000;

/**
 * THE BOUND, measured (Codex R2 N1 on #324): a run of unknown window reads starts at the FIRST unknown
 * read and is reached when the AWAKE clock (watch-wake awakeNowMs: darwin mach time without sleep, linux
 * CLOCK_MONOTONIC) shows the whole bound since then. ANY readable read ends the run. How often reads
 * happen (the immediate first check, marker events, overlapping checks) cannot matter: NEVER EARLY, by
 * construction, and a timer that fires late only makes it later.
 *   - An awake clock unreadable at a read cannot reach the bound (late, never early); a run cannot start
 *     without one.
 *   - UNCOVERED residual (stated, covered by nothing else): on darwin while the sysctl awake read itself
 *     keeps failing, and on win32 always (no awake clock), the bound never fires. node's hrtime is NOT a
 *     substitute: on darwin it counts sleep (MEASURED 12 Oct: hrtime 837832 s, awake 322290 s since boot).
 */
export class AnchorUnknownBound {
  private since: number | null = null;
  constructor(
    readonly boundMs: number,
    private readonly awakeNow: () => number | null,
  ) {}
  /** One read of the window: true once it has been unknown for the whole bound of awake time. */
  observe(read: "same" | "unknown"): boolean {
    if (read === "same") {
      this.since = null;
      return false;
    }
    const now = this.awakeNow();
    if (now === null) return false;
    if (this.since === null) this.since = now;
    return now - this.since >= this.boundMs;
  }
}

/**
 * The reason a watch blind to its window records (Codex R2 N5): built from the CAPTURED window anchor (pid
 * + start), whatever the watch was doing; `base` says why it is dormant at all.
 */
export const blindReason = (prefix: string, window: { pid: number; start: string }, boundMs: number, base: string): string =>
  `${prefix} its window (pid ${window.pid}, start ${window.start}) could not be observed for ${Math.round(boundMs / 1000)} s of awake time in a row (the bound): it is not judged gone and is never re-anchored; dormant because: ${base}`;
/** Why a RUNNING watch went dormant at the bound (the `base` of its blind reason). */
export const STOPPED_AT_BOUND = "it stopped watching at the bound";
/** Generation takeovers attempted in one arming before going dormant as "already watched". */
export const MAX_TAKEOVER_ROUNDS = 3;

/** POSIX single-quoting: safe for any path (the install path may contain spaces). */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/**
 * The exact command, as the agent must run it (in the background). It names THIS CLI by absolute path
 * (`relay` may not be on the agent's PATH) and THIS relay DB (the instance is never re-resolved
 * differently, so the watch takes the SAME lock the supervisor probes).
 */
export const rearmCommand = (agent: string, dbPath: string, cli: string = path.resolve(process.argv[1] ?? "relay")): string => `RELAY_DB_PATH=${shq(dbPath)} ${shq(cli)} watch ${agent} --until-wake`;
/** The foreground pre-check the agent runs first (same DB, same CLI). */
export const armCheckCommand = (agent: string, dbPath: string, cli: string = path.resolve(process.argv[1] ?? "relay")): string => `RELAY_DB_PATH=${shq(dbPath)} ${shq(cli)} watch ${agent} --arm-check`;

/** One line to stdout, SYNCHRONOUSLY (a pipe is asynchronous on macOS; the line must be out before anything else happens). */
function emitLine(line: string): void {
  fs.writeSync(1, `${line}\n`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Handle = import("../sqlite-compat.js").CompatDatabase;

/** The real ownership deps (kernel facts through ps). */
async function realOwnerDeps(ownHostId: string | null): Promise<import("../watch-owner.js").OwnerDeps> {
  const L = await import("../liveness.js");
  const { bindingLiveness } = await import("../doorbell-run.js");
  return {
    table: () => L.buildProcessTable(),
    startNow: (pid) => L.processStartedAt(pid),
    sameProcess: (pid, stored) => {
      const o = L.observeStartTokenForm(pid, stored);
      return o === "unreadable" ? "unreadable" : o === "utc" || o === "legacy";
    },
    liveness: (b) => bindingLiveness({ host_id: b.host_id, window_pid: b.window_pid, window_pid_start: b.window_pid_start }, ownHostId),
  };
}
async function agentBindings(db: Handle, agent: string): Promise<import("../watch-owner.js").OwnerBinding[]> {
  const { listAgentBindings } = await import("../db.js");
  return listAgentBindings(db).filter((b) => b.agent_name === agent);
}

/**
 * The agent's watch status, for its ONE live window (other processes only: --lock-status, --arm-check,
 * `relay pending --watch-status`). `never` = the agent dir does not exist (it never armed one). The
 * window dir is keyed by the window process's start as the KERNEL reads it (Codex R2 (b)).
 */
export async function agentWatchStatus(db: Handle, dbPath: string, agent: string): Promise<"live" | "stale" | "absent" | "never" | "no_window" | "unknown"> {
  const W = await import("../watch-wake.js");
  if (!W.watchableName(agent)) return "never";
  const agentDir = W.watchAgentDir(dbPath, agent);
  if (!fs.existsSync(agentDir)) return "never";
  const { getOwnHostId, processStartedAt } = await import("../liveness.js");
  const { oneLiveWindow } = await import("../doorbell-core.js");
  const { bindingLiveness } = await import("../doorbell-run.js");
  const own = getOwnHostId();
  const one = oneLiveWindow(await agentBindings(db, agent), own, (b) => bindingLiveness(b, own));
  if (one.kind !== "one" || !one.b.window_pid) return "no_window";
  const start = processStartedAt(one.b.window_pid);
  if (start.kind === "gone") return "no_window";
  if (start.kind === "unreadable") return "unknown"; // its key cannot be read: never "no window"
  return W.watchStatus(W.watchWindowDir(dbPath, agent, { pid: one.b.window_pid, start: start.start }));
}

/** Open the relay DB read-only, waiting while no writer has created its WAL sidecars (never creating one). */
async function openDbWaiting(dbPath: string, intervalMs: number, say: (l: string) => void, agent: string): Promise<Handle> {
  const { openRelayDbIfWritten } = await import("../doorbell-run.js");
  for (;;) {
    try {
      const r = await openRelayDbIfWritten(dbPath);
      if (!("waiting" in r)) return r.db;
    } catch (err) {
      say(`[sentinel] DEGRADED: the watch for ${agent} cannot open its relay DB yet (${err instanceof Error ? err.message : String(err)}): retrying`);
    }
    await sleep(intervalMs);
  }
}

/**
 * `--arm-check` (FOREGROUND, inside the agent's turn): every arm-time refusal, and whether a watch is
 * already live in this window. Same ancestry as the background watch it precedes (both are started by
 * the agent's own shell). Never writes anything.
 */
export async function runArmCheck(agent: string): Promise<number> {
  const { pinResolvedDbPath } = await import("./_instance-db.js");
  const fault = await pinResolvedDbPath();
  if (fault) {
    emitLine(`no-mail: refused (instance_unresolved): the relay instance cannot be resolved here (${fault})`);
    return 2;
  }
  const dbPath = process.env.RELAY_DB_PATH as string;
  const W = await import("../watch-wake.js");
  const O = await import("../watch-owner.js");
  if (!W.watchableName(agent)) {
    emitLine(`no-mail: refused (not_watchable): ${JSON.stringify(agent)} cannot have a watch`);
    return 2;
  }
  const { openRelayDbIfWritten } = await import("../doorbell-run.js");
  const r = await openRelayDbIfWritten(dbPath);
  if ("waiting" in r) {
    emitLine(`no-mail: refused (relay_not_started): no relay has written ${dbPath} yet`);
    return 2;
  }
  try {
    const { getOwnHostId } = await import("../liveness.js");
    const own = getOwnHostId();
    const owner = O.resolveOwnership(process.pid, await agentBindings(r.db, agent), own, await realOwnerDeps(own));
    if (!owner.ok) {
      emitLine(`no-mail: refused (${owner.why}): ${O.REFUSAL_TEXT[owner.why]}. Do not start a watch for ${agent}.`);
      return 2;
    }
    const status = W.watchStatus(W.watchWindowDir(dbPath, agent, owner.window));
    if (status === "live") {
      emitLine(`live: a watch for ${agent} is already running in this window. Nothing to do.`);
      return 0;
    }
    emitLine(`arm: start it now as a BACKGROUND task (run_in_background), once: ${rearmCommand(agent, dbPath)}`);
    return 0;
  } finally {
    r.db.close();
  }
}

/** How many times the birth start is read again at once when the first read fails (fedac068 (a)). */
export const BIRTH_START_RETRIES = 3;

/** A dormant watch's anchor: the window, or (`parent`) the shell that launched it, whose start may be unknown. */
export interface DormantAnchor {
  pid: number;
  start: string | null;
  parent?: boolean;
}

type StartReader = (pid: number) => import("../liveness.js").ProcessStart;

/** The birth start: read now, retried at once up to BIRTH_START_RETRIES times; null when gone or never readable. */
export function captureBirthStart(pid: number, read: StartReader): string | null {
  for (let i = 0; i <= BIRTH_START_RETRIES; i++) {
    const r = read(pid);
    if (r.kind === "start") return r.start;
    if (r.kind === "gone") return null;
  }
  return null;
}

/**
 * A dormant watch's anchor, by kernel fact only. GONE: the launching shell, when we were reparented
 * (POSIX: our ppid is no longer it), or ESRCH, or its pid holds another start (only when one was
 * captured at birth); the window, on ESRCH or another start on its pid. UNKNOWN: the window's start
 * cannot be read (never gone). The launching shell is never unknown: while it is still our parent it
 * is alive (a parent's death reparents us), so the reparent rule bounds it.
 */
export function dormantAnchorState(anchor: DormantAnchor, read: StartReader, ppid: number = process.ppid): "same" | "gone" | "unknown" {
  if (anchor.parent && ppid !== anchor.pid) return "gone";
  const r = read(anchor.pid);
  if (r.kind === "gone") return "gone";
  if (r.kind === "unreadable") return anchor.parent ? "same" : "unknown";
  return anchor.start !== null && r.start !== anchor.start ? "gone" : "same";
}
/** Is a dormant watch's anchor GONE (dormantAnchorState)? An unreadable start is never gone. */
export const anchorGone = (anchor: DormantAnchor, read: StartReader, ppid: number = process.ppid): boolean => dormantAnchorState(anchor, read, ppid) === "gone";

export async function runUntilWake(agent: string, opts: { intervalMs?: number; dormantCheckMs?: number; anchorUnknownBoundMs?: number; now?: () => number } = {}): Promise<number> {
  const now = opts.now ?? (() => Date.now());
  const intervalMs = opts.intervalMs ?? FALLBACK_POLL_MS;
  const anchorUnknownBoundMs = opts.anchorUnknownBoundMs ?? ANCHOR_UNKNOWN_BOUND_MS;
  const dormantCheckMs = opts.dormantCheckMs ?? DORMANT_CHECK_MS;
  const say = (line: string) => process.stderr.write(`${line}\n`);
  const L = await import("../liveness.js");
  const W = await import("../watch-wake.js");
  // THE BIRTH ANCHOR (architect fedac068 (a)): the launching shell, its start captured ONCE, now (up to
  // BIRTH_START_RETRIES immediate retries), and NEVER adopted later: a start read after the shell could
  // have died might be an impostor's, which would make a dormant watch immortal. Not captured = the
  // shell is judged by the reparent and ESRCH alone.
  const birth: DormantAnchor = { pid: process.ppid, start: captureBirthStart(process.ppid, L.processStartedAt), parent: true };
  // Identity for the holder sidecar and the dormant record name: null = unknown (display only).
  const me = { pid: process.pid, proc_start: L.startOrNull(L.processStartedAt(process.pid)), host_id: L.getOwnHostId() };

  // DORMANCY (ruling 9becb599). `anchor` is the window when known, else the process that started us.
  // Zero CPU: one timer per check. Exits SILENTLY once the anchor is gone; a signal exits with a line.
  let dormantFile: string | null = null;
  // `blindAtStart`: the record carries ANCHOR_UNOBSERVED_PREFIX at once (a running watch reached the bound).
  // `recordDir` is where the record BELONGS; null only where there is none (instance unresolved, a name
  // that cannot be a dir). Every write that fails is RETRIED on later ticks (Codex R2 N4): the state the
  // record SHOULD say (`desiredBlind`) is kept apart from what it was last WRITTEN to say (`persisted`).
  const dormant = async (reason: string, anchor: DormantAnchor | import("../watch-owner.js").OwnedWindow, recordDir: string | null, blindAtStart = false): Promise<number> => {
    const { ensurePrivateDir: ensurePrivate } = await import("../doorbell-log.js");
    // Only a WINDOW anchor can be unobservable (dormantAnchorState: the launching shell never is).
    const win = (anchor as DormantAnchor).parent ? null : { pid: anchor.pid, start: anchor.start as string };
    const reasonFor = (blind: boolean): string => (blind && win ? blindReason(W.ANCHOR_UNOBSERVED_PREFIX, win, anchorUnknownBoundMs, reason) : reason);
    say(`[sentinel] relay watch for ${agent} is DORMANT (${reasonFor(blindAtStart)}): it will not wake anyone; it ends when its window does.`);
    /** Write the record (the same name each time: a rewrite REPLACES it atomically). True when it landed. */
    const record = (blind: boolean): boolean => {
      if (!recordDir) return false;
      try {
        // The chain may be gone (the lock-lost case) or unusable (a planted link): recreate it privately,
        // component by component; a link or a non-dir is refused, and the next tick tries again.
        const root = path.join(path.dirname(process.env.RELAY_DB_PATH as string), "watch");
        const rel = path.relative(root, recordDir).split(path.sep).filter(Boolean);
        let cur = root;
        ensurePrivate(cur);
        for (const part of rel) ensurePrivate((cur = path.join(cur, part)));
        dormantFile = W.writeDormant(recordDir, { pid: me.pid, proc_start: me.proc_start, reason: reasonFor(blind), at: new Date(now()).toISOString(), anchor: win });
        return true;
      } catch (err) {
        say(`[sentinel] DEGRADED: the dormant record for ${agent} could not be written (${err instanceof Error ? err.message : String(err)}): retrying on the next check`);
        return false;
      }
    };
    let desiredBlind = blindAtStart;
    let persisted: boolean | null = null; // what the record on disk says (null: nothing written yet)
    const sync = (): void => {
      if (persisted !== desiredBlind && record(desiredBlind)) persisted = desiredBlind;
    };
    sync();
    return await new Promise<number>((resolve) => {
      let done = false;
      const end = (code: number, line?: string) => {
        if (done) return;
        done = true;
        W.removeDormant(dormantFile);
        if (line) emitLine(line);
        resolve(code);
      };
      process.once("SIGTERM", () => end(0, `no-mail: stopped (signal) while dormant: ${reason}`));
      process.once("SIGINT", () => end(0, `no-mail: stopped (signal) while dormant: ${reason}`));
      // BOUNDEDNESS (ruling a98ec836): a dormant watch blind to its window for the bound (in AWAKE time) is
      // made LOUD (its record rewritten), and quiet again once it can see it. It stays dormant either way:
      // an unobservable window is never "gone".
      const bound = new AnchorUnknownBound(anchorUnknownBoundMs, () => W.awakeNowMs());
      const tick = () => {
        if (done) return;
        const st = dormantAnchorState(anchor, L.processStartedAt);
        if (st === "gone") return end(0); // (b) the window is gone: SILENT (no session left to notify)
        if (st === "same") {
          bound.observe("same");
          desiredBlind = false;
        } else if (bound.observe("unknown")) desiredBlind = true;
        sync(); // a write that failed before is retried here
        setTimeout(tick, dormantCheckMs);
      };
      setTimeout(tick, dormantCheckMs);
    });
  };

  const { pinResolvedDbPath } = await import("./_instance-db.js");
  const fault = await pinResolvedDbPath();
  // EXEMPT from a record (Codex R2 N4): the instance (so the DB path, so the watch dir) cannot be resolved.
  if (fault) return dormant(`instance_unresolved: ${fault}`, birth, null);
  const dbPath = process.env.RELAY_DB_PATH as string;
  // EXEMPT from a record: this name cannot be a directory (watchableName), so there is no dir to write in.
  if (!W.watchableName(agent)) return dormant("not_watchable", birth, null);
  const { currentWakePolicy } = await import("../wake-policy.js");
  const { acquireInstanceLock, lockStillOurs, releaseInstanceLock } = await import("../doorbell-lock.js");
  const { ensurePrivateDir } = await import("../doorbell-log.js");
  const { pendingMetadata } = await import("../db.js");
  const O = await import("../watch-owner.js");
  const ownHost = me.host_id;
  const ownerDeps = await realOwnerDeps(ownHost);
  const agentDir = W.watchAgentDir(dbPath, agent);
  const privateAgentDir = (): string | null => {
    try {
      ensurePrivateDir(path.dirname(agentDir));
      ensurePrivateDir(agentDir);
      return agentDir;
    } catch (err) {
      say(`[sentinel] DEGRADED: the watch dir for ${agent} is unusable (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }
  };

  // PHASE 1 (no lock held): a readable relay DB, then OWNERSHIP (D1). It never creates a sidecar.
  let db: Handle | null = await openDbWaiting(dbPath, intervalMs, say, agent);
  const closeDb = () => {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    db = null;
  };
  const owner = O.resolveOwnership(process.pid, await agentBindings(db, agent), ownHost, ownerDeps);
  if (!owner.ok) {
    closeDb();
    privateAgentDir(); // says DEGRADED when it cannot be made; the record is retried there either way
    return dormant(`refused (${owner.why}): ${O.REFUSAL_TEXT[owner.why]}`, birth, agentDir); // the arm-check should have caught it
  }
  const window = owner.window;
  if (!privateAgentDir()) {
    closeDb();
    return dormant("the watch dir is unusable", window, W.watchWindowDir(dbPath, agent, window)); // retried until usable
  }
  const dir = W.watchWindowDir(dbPath, agent, window);
  try {
    ensurePrivateDir(dir);
  } catch (err) {
    closeDb();
    return dormant(`the window dir is unusable (${err instanceof Error ? err.message : String(err)})`, window, dir); // retried until usable
  }
  const birthPpid = process.ppid;

  // PHASE 2: the lock of the CURRENT generation; OLDEST wins; a HUNG holder is abandoned (D2), never signalled.
  let lock: { handle: import("../doorbell-lock.js").LockHandle; gen: number } | null = null;
  for (let round = 0; round <= MAX_TAKEOVER_ROUNDS && !lock; round++) {
    const gen = W.currentGen(dir);
    const names = { lockFile: W.watchLockFile(gen), holderFile: W.watchHolderFile(gen), heldBy: `a watch for ${agent} is already live` };
    let r: import("../doorbell-lock.js").LockResult | null = null;
    for (let i = 0; i < RETRY_BUSY.attempts; i++) {
      r = acquireInstanceLock(dir, me, () => new Date(now()).toISOString(), names);
      if (r.ok) break;
      await sleep(RETRY_BUSY.delayMs); // a liveness PROBE holds the lock for an instant: never mistake it for a holder
    }
    if (r && r.ok) {
      if (W.superseded(dir, gen)) {
        releaseInstanceLock(r.handle); // a later generation appeared meanwhile: contest that one
        continue;
      }
      lock = { handle: r.handle, gen };
      break;
    }
    if (W.watchStatus(dir) !== "stale") break; // a LIVE holder: oldest wins
    const advanced = W.advanceGen(dir, gen); // exactly one creator per generation (kernel-decided)
    say(`[sentinel] DEGRADED: the watch for ${agent} (generation ${gen}) is hung: ${advanced ? "abandoned it" : "another watch abandoned it"}; contesting generation ${gen + 1} (nothing is signalled)`);
  }
  if (!lock) {
    closeDb();
    return dormant("already watched: a watch for this agent is already live in this window", window, dir);
  }
  const { handle, gen } = lock;
  // The FIRST heartbeat at once: until it exists, no observer can judge this holder stale (fail-safe).
  try {
    W.writeHeartbeat(dir, { pid: me.pid, gen, at: new Date(now()).toISOString() });
  } catch (err) {
    say(`[sentinel] DEGRADED: the watch heartbeat for ${agent} could not be written (${err instanceof Error ? err.message : String(err)})`);
  }
  W.pruneGenerations(dir, gen);

  let lastBeat = now();
  let degraded = false;
  const deadCache = new Set<string>();
  // BOUNDEDNESS in AWAKE time (Codex R2 N1): any check may read the window; only awake time reaches the bound.
  const anchorBound = new AnchorUnknownBound(anchorUnknownBoundMs, () => W.awakeNowMs());

  // The RUNNING watch. Its outcome: a wake line (exit), the window gone (silent exit), a signal (exit),
  // or a reason to go dormant.
  type Outcome = { kind: "exit"; code: number; line?: string } | { kind: "dormant"; reason: string; blind?: boolean };
  const outcome = await new Promise<Outcome>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let watcher: fs.FSWatcher | null = null;
    const settle = (o: Outcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      try {
        watcher?.close();
      } catch {
        /* already closed */
      }
      closeDb();
      releaseInstanceLock(handle);
      resolve(o);
    };
    const onSignal = () => settle({ kind: "exit", code: 0, line: `no-mail: stopped (signal): the watch for ${agent} was stopped.` });
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);

    /**
     * Still the RIGHTFUL holder? Checked on every check AND immediately before every write (D2).
     * Superseded FIRST: the new holder prunes the old generation's lock file, so a resumed stale holder
     * also sees its lock "lost"; superseded is the true reason.
     */
    const rightful = (): boolean => {
      if (settled) return false;
      if (W.superseded(dir, gen)) {
        settle({ kind: "dormant", reason: "superseded: a newer watch took over (this one had stopped checking)" });
        return false;
      }
      if (!lockStillOurs(handle)) {
        settle({ kind: "dormant", reason: "lock lost: its lock file was removed or replaced" });
        return false;
      }
      if (process.ppid !== birthPpid) {
        settle({ kind: "dormant", reason: "reparented: it lost its parent shell" });
        return false;
      }
      return true;
    };

    const check = async (): Promise<void> => {
      if (!rightful()) return;
      const t = now();
      try {
        if (!db) db = await openDbWaiting(dbPath, intervalMs, say, agent);
        // D1 (iii): the agent's ONE live window must still be this one (by pid + the kernel's start).
        const own = O.stillOwner(window, await agentBindings(db, agent), ownHost, ownerDeps, deadCache);
        if (!own.ok) {
          const why = (own as { why: import("../watch-owner.js").OwnerRefusal | "window_gone" }).why;
          if (why === "window_gone") settle({ kind: "exit", code: 0 }); // (b): silent
          else settle({ kind: "dormant", reason: `binding moved (${why}): ${O.REFUSAL_TEXT[why]}` });
          return;
        }
        // BOUNDEDNESS (ruling a98ec836): a window unobservable for the whole bound ends the RUNNING watch
        // loudly (dormant, named), never as window_gone and never by re-anchoring. A readable read resets.
        if (anchorBound.observe(own.window)) {
          settle({ kind: "dormant", blind: true, reason: STOPPED_AT_BOUND });
          return;
        }
        if (t - lastBeat >= HEARTBEAT_EVERY_MS) {
          if (!rightful()) return;
          try {
            W.writeHeartbeat(dir, { pid: me.pid, gen, at: new Date(t).toISOString() });
            lastBeat = t;
          } catch (err) {
            say(`[sentinel] DEGRADED: the watch heartbeat for ${agent} could not be written (${err instanceof Error ? err.message : String(err)})`);
          }
        }
        const m = pendingMetadata(db, agent);
        if (degraded) say(`[sentinel] recovered: the watch for ${agent} reads its mailbox again`);
        degraded = false;
        if (!m.registered) {
          settle({ kind: "dormant", reason: `unregistered: ${agent} is not registered in this relay` });
          return;
        }
        const meta = new Map(m.messages.map((x) => [x.id, { from: x.from, lane: "direct" as const }]));
        const read = { registered: true, reading_session: m.reading_session, ids: m.messages.map((x) => x.id), meta };
        const woken = W.readWoken(dir);
        const d = W.decideWake(read, agent, woken, t, currentWakePolicy());
        if (d.wake.length === 0) return; // nothing new to wake for (or a NULL session: keep waiting)
        const senders = d.wake.flatMap((id) => (meta.get(id)?.from ? [meta.get(id)!.from as string] : []));
        if (!rightful()) return;
        // EMIT FIRST, then persist (Codex R1 #3): the line IS the wake. A death in between costs at worst
        // ONE duplicate wake for these ids, never a missed one.
        emitLine(`relay mail pending for ${agent}: ${d.wake.length} new message(s). Call get_messages, then re-arm: run ${armCheckCommand(agent, dbPath)} and, if it says arm, the command it gives in the background.`);
        if (!W.superseded(dir, gen) && lockStillOurs(handle)) {
          try {
            W.writeWoken(dir, W.recordWake(woken, m.reading_session as string, d.wake, read.ids, senders, t));
          } catch (err) {
            say(`[sentinel] DEGRADED: the watch for ${agent} could not record what it woke for (${err instanceof Error ? err.message : String(err)}): the next watch may wake once more for the same mail`);
          }
        }
        settle({ kind: "exit", code: 0 });
      } catch (err) {
        if (!degraded) say(`[sentinel] DEGRADED: the watch for ${agent} cannot read its mailbox (${err instanceof Error ? err.message : String(err)}): retrying`);
        degraded = true;
        closeDb();
      }
    };

    void check();
    timer = setInterval(() => void check(), intervalMs);
    // The daemon's delivery marker, when markers are on: a prompt wake without waiting for the poll.
    void import("../filesystem-marker.js").then((mk) => {
      if (settled || !mk.markersEnabled()) return;
      const mp = mk.markerPath(agent);
      if (!mp) return;
      void import("./watch.js").then(({ watchMarkerDir }) => {
        if (settled) return;
        watcher = watchMarkerDir({ agent, dir: path.dirname(mp), onEvent: () => void check(), onFallback: () => {}, write: (l) => process.stderr.write(l) });
      });
    });
  });
  if (outcome.kind === "exit") {
    if (outcome.line) emitLine(outcome.line);
    return outcome.code;
  }
  return dormant(outcome.reason, window, dir, outcome.blind === true);
}

export async function runLockStatus(agent: string): Promise<number> {
  const { pinResolvedDbPath } = await import("./_instance-db.js");
  const fault = await pinResolvedDbPath();
  if (fault) {
    process.stderr.write(`relay watch: instance resolution failed: ${fault}\n`);
    return 1;
  }
  const dbPath = process.env.RELAY_DB_PATH as string;
  const { openRelayDbIfWritten } = await import("../doorbell-run.js");
  const r = await openRelayDbIfWritten(dbPath);
  if ("waiting" in r) {
    emitLine("absent");
    return 0;
  }
  try {
    emitLine(await agentWatchStatus(r.db, dbPath, agent));
  } finally {
    r.db.close();
  }
  return 0;
}
