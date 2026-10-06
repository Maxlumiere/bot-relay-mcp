// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay watch <agent> --until-wake` and `relay watch <agent> --lock-status` (doorbell PR 7, plan §v6;
 * Codex R1 rulings ffcaf608).
 *
 * --until-wake: the agent arms it ONCE as a background task (run_in_background), from its own session.
 * It waits with ZERO model tokens and EXITS 0 with one line when there is mail to wake for
 * (src/watch-wake.ts decides). The harness's completion notification is the wake (the inherent turn);
 * the agent re-arms inside it.
 *   - OWNERSHIP (D1): the watch belongs to the window it descends from, and only if that window is the
 *     agent's ONE live bound window (src/watch-owner.ts). Otherwise it refuses to arm; once running, it
 *     stops when the agent's live window becomes another one ("binding moved"), or when it is
 *     reparented.
 *   - ONE watch per (agent, window), OLDEST WINS: a second watch that finds a live holder exits with
 *     "no-mail: already watched" (the arming pre-check, --lock-status, keeps that rare).
 *   - A HUNG holder (no sign of life for HEARTBEAT_STALE_MS of AWAKE time) is ABANDONED, never signalled
 *     (D2): the new watch advances the generation (an O_EXCL create of gen-<N+1>) and takes that
 *     generation's lock. A holder checks for a later generation (and that its lock file is still its
 *     own) on every check AND immediately before every write; superseded, it stops. RESIDUAL (stated):
 *     a stale holder resuming between its check and its write can cause at worst a DUPLICATE wake.
 *   - EMIT FIRST, then persist (Codex R1 #3): a death between them costs at worst a duplicate wake.
 *   - READ-ONLY on the relay DB (opened only once a writer's WAL sidecars exist). Its writes go to its own
 *     dirs (src/watch-wake.ts).
 *   - Every exit WITHOUT mail prints a line starting "no-mail:" (distinguishable); a signal exits 0 with
 *     no line (a deliberate stop).
 *
 * --lock-status: for the arming pre-check. Prints one word for the agent's ONE live window and exits 0:
 * live | stale | absent, or never (it never armed one) or no_window (no single live window).
 */
import fs from "fs";
import path from "path";

export const RETRY_BUSY = { attempts: 5, delayMs: 100 } as const;
export const HEARTBEAT_EVERY_MS = 60_000;
export const FALLBACK_POLL_MS = 3_000;
/** Generation takeovers attempted in one arming before giving up as "already watched". */
export const MAX_TAKEOVER_ROUNDS = 3;

/** POSIX single-quoting: safe for any path (the install path may contain spaces). */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/**
 * The exact re-arm command, as the agent must run it (in the background). It names THIS CLI by absolute
 * path (`relay` may not be on the agent's PATH) and THIS relay DB (the instance is never re-resolved
 * differently, so the re-armed watch takes the SAME lock the supervisor probes).
 */
export const rearmCommand = (agent: string, dbPath: string, cli: string = path.resolve(process.argv[1] ?? "relay")): string => `RELAY_DB_PATH=${shq(dbPath)} ${shq(cli)} watch ${agent} --until-wake`;

/** One line to stdout, SYNCHRONOUSLY (a pipe is asynchronous on macOS; the line must be out before anything else happens). */
function emitLine(line: string): void {
  fs.writeSync(1, `${line}\n`);
}

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
      return o === "utc" || o === "legacy";
    },
    liveness: (b) => bindingLiveness({ host_id: b.host_id, window_pid: b.window_pid, window_pid_start: b.window_pid_start }, ownHostId),
  };
}
async function agentBindings(db: Handle, agent: string): Promise<import("../watch-owner.js").OwnerBinding[]> {
  const { listAgentBindings } = await import("../db.js");
  return listAgentBindings(db).filter((b) => b.agent_name === agent);
}

/**
 * The agent's watch status, for its ONE live window (other processes only: the --lock-status pre-check
 * and `relay pending --watch-status`). `never` = the agent dir does not exist (it never armed one).
 */
export async function agentWatchStatus(db: Handle, dbPath: string, agent: string): Promise<"live" | "stale" | "absent" | "never" | "no_window"> {
  const W = await import("../watch-wake.js");
  if (!W.watchableName(agent)) return "never";
  const agentDir = W.watchAgentDir(dbPath, agent);
  if (!fs.existsSync(agentDir)) return "never";
  const { getOwnHostId } = await import("../liveness.js");
  const { oneLiveWindow } = await import("../doorbell-core.js");
  const { bindingLiveness } = await import("../doorbell-run.js");
  const own = getOwnHostId();
  const one = oneLiveWindow(await agentBindings(db, agent), own, (b) => bindingLiveness(b, own));
  if (one.kind !== "one" || !one.b.window_pid || !one.b.window_pid_start) return "no_window";
  return W.watchStatus(W.watchWindowDir(dbPath, agent, { pid: one.b.window_pid, start: one.b.window_pid_start }));
}

export async function runUntilWake(agent: string, opts: { intervalMs?: number; now?: () => number } = {}): Promise<number> {
  const now = opts.now ?? (() => Date.now());
  const say = (line: string) => process.stderr.write(`${line}\n`);
  const { pinResolvedDbPath } = await import("./_instance-db.js");
  const fault = await pinResolvedDbPath();
  if (fault) {
    say(`[sentinel] DEGRADED: no watch for ${agent}: instance resolution failed: ${fault}`);
    return 1;
  }
  const dbPath = process.env.RELAY_DB_PATH as string;
  const W = await import("../watch-wake.js");
  const { currentWakePolicy } = await import("../wake-policy.js");
  const { acquireInstanceLock, lockStillOurs, releaseInstanceLock } = await import("../doorbell-lock.js");
  const { ensurePrivateDir } = await import("../doorbell-log.js");
  const { processStartedAt, getOwnHostId } = await import("../liveness.js");
  const { openRelayDbIfWritten } = await import("../doorbell-run.js");
  const { pendingMetadata } = await import("../db.js");
  const O = await import("../watch-owner.js");
  if (!W.watchableName(agent)) {
    emitLine(`no-mail: refused (not_watchable): ${JSON.stringify(agent)} cannot have a watch`);
    return 2;
  }
  const ownHost = getOwnHostId();
  const ownerDeps = await realOwnerDeps(ownHost);
  const intervalMs = opts.intervalMs ?? FALLBACK_POLL_MS;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // PHASE 1 (no lock held): a readable relay DB, then OWNERSHIP (D1). It never creates a sidecar.
  let db: Handle | null = null;
  for (;;) {
    try {
      const r = await openRelayDbIfWritten(dbPath);
      if (!("waiting" in r)) {
        db = r.db;
        break;
      }
    } catch (err) {
      say(`[sentinel] DEGRADED: the watch for ${agent} cannot open its relay DB yet (${err instanceof Error ? err.message : String(err)}): retrying`);
    }
    await sleep(intervalMs);
  }
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
    emitLine(`no-mail: refused (${owner.why}): ${O.REFUSAL_TEXT[owner.why]}. No watch for ${agent}.`);
    return 2;
  }
  const agentDir = W.watchAgentDir(dbPath, agent);
  ensurePrivateDir(path.dirname(agentDir));
  ensurePrivateDir(agentDir);
  const dir = W.watchWindowDir(dbPath, agent, owner.window);
  ensurePrivateDir(dir);
  const birthPpid = process.ppid;

  // PHASE 2: the lock of the CURRENT generation; OLDEST wins; a HUNG holder is abandoned (D2), never signalled.
  const me = { pid: process.pid, proc_start: processStartedAt(process.pid), host_id: ownHost };
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
    if (W.watchStatus(dir, W.realAwakeClock(now())) !== "stale") break; // a LIVE holder: oldest wins
    const advanced = W.advanceGen(dir, gen); // exactly one creator per generation (kernel-decided)
    say(`[sentinel] DEGRADED: the watch for ${agent} (generation ${gen}) is hung: ${advanced ? "abandoned it" : "another watch abandoned it"}; contesting generation ${gen + 1} (nothing is signalled)`);
  }
  if (!lock) {
    closeDb();
    emitLine(`no-mail: already watched: a watch for ${agent} is already live in this window (one per window). Nothing to do.`);
    return 0;
  }
  const { handle, gen } = lock;
  W.pruneGenerations(dir, gen);

  let lastBeat = 0;
  let degraded = false;
  let finished = false;
  const deadCache = new Set<string>();

  return await new Promise<number>((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    let watcher: fs.FSWatcher | null = null;
    const finish = (code: number, line?: string) => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      try {
        watcher?.close();
      } catch {
        /* already closed */
      }
      closeDb();
      releaseInstanceLock(handle);
      if (line) emitLine(line);
      resolve(code);
    };
    const onSignal = () => finish(0); // a deliberate stop (TaskStop, the session ending): no line
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);

    /**
     * Still the RIGHTFUL holder? Checked on every check AND immediately before every write (D2): the
     * lock file is still the one we locked, no later generation exists, and we were not reparented.
     */
    const rightful = (): boolean => {
      if (finished) return false;
      // Superseded FIRST: the new holder prunes the old generation's lock file, so a resumed stale
      // holder also sees its lock "lost"; superseded is the true (and benign) reason.
      if (W.superseded(dir, gen)) {
        finish(0, `no-mail: superseded: a newer watch for ${agent} took over (this one had stopped checking). Nothing to do.`);
        return false;
      }
      if (!lockStillOurs(handle)) {
        finish(1, `no-mail: lock lost: the watch lock for ${agent} was removed or replaced under this watch. Re-arm in the background: ${rearmCommand(agent, dbPath)}`);
        return false;
      }
      if (process.ppid !== birthPpid) {
        finish(0, `no-mail: reparented: this watch lost its parent session. Nothing to do.`);
        return false;
      }
      return true;
    };

    const check = async (): Promise<void> => {
      if (!rightful()) return;
      const t = now();
      try {
        if (!db) {
          const r = await openRelayDbIfWritten(dbPath);
          if ("waiting" in r) return; // no writer: keep waiting (never create a sidecar)
          db = r.db;
        }
        // D1 (iii): the agent's ONE live window must still be this one.
        const own = O.stillOwner(owner.window, await agentBindings(db, agent), ownHost, ownerDeps.liveness, deadCache);
        if (!own.ok) {
          const why = (own as { why: import("../watch-owner.js").OwnerRefusal }).why;
          finish(0, `no-mail: binding moved (${why}): ${O.REFUSAL_TEXT[why]}. This watch stopped.`);
          return;
        }
        if (t - lastBeat >= HEARTBEAT_EVERY_MS) {
          if (!rightful()) return;
          try {
            W.writeHeartbeat(dir, { pid: process.pid, gen, at: new Date(t).toISOString() });
            lastBeat = t;
          } catch (err) {
            say(`[sentinel] DEGRADED: the watch heartbeat for ${agent} could not be written (${err instanceof Error ? err.message : String(err)})`);
          }
        }
        const m = pendingMetadata(db, agent);
        if (degraded) say(`[sentinel] recovered: the watch for ${agent} reads its mailbox again`);
        degraded = false;
        if (!m.registered) {
          finish(1, `no-mail: unregistered: ${agent} is not registered in this relay; nothing to watch.`);
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
        emitLine(`relay mail pending for ${agent}: ${d.wake.length} new message(s). Call get_messages, then re-arm in the background: ${rearmCommand(agent, dbPath)}`);
        if (!W.superseded(dir, gen) && lockStillOurs(handle)) {
          try {
            W.writeWoken(dir, W.recordWake(woken, m.reading_session as string, d.wake, read.ids, senders, t));
          } catch (err) {
            say(`[sentinel] DEGRADED: the watch for ${agent} could not record what it woke for (${err instanceof Error ? err.message : String(err)}): the next watch may wake once more for the same mail`);
          }
        }
        finish(0);
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
      if (finished || !mk.markersEnabled()) return;
      const mp = mk.markerPath(agent);
      if (!mp) return;
      void import("./watch.js").then(({ watchMarkerDir }) => {
        if (finished) return;
        watcher = watchMarkerDir({ agent, dir: path.dirname(mp), onEvent: () => void check(), onFallback: () => {}, write: (l) => process.stderr.write(l) });
      });
    });
  });
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
