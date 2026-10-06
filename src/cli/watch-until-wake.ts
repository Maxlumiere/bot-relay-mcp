// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay watch <agent> --until-wake` and `relay watch <agent> --lock-status` (doorbell PR 7, plan §v6).
 *
 * --until-wake: the agent arms it ONCE as a background task (run_in_background). It holds the agent's
 * watch lock, waits with ZERO model tokens, and EXITS 0 with one line when there is mail to wake for
 * (src/watch-wake.ts decides). The harness's completion notification is the wake, i.e. the one inherent
 * turn; the agent re-arms inside it. MEASURED (M5a): a background task ran 7 400 s with zero turns and
 * one completion turn.
 *   - ONE watch per agent, OLDEST WINS (ruling 7224605e (2)): a second watch that finds the lock held
 *     exits 0 at once, quietly. It retries briefly first, because a liveness PROBE holds the lock for
 *     microseconds and must not be mistaken for a live watch.
 *   - READ-ONLY: the relay DB is opened read-only, and only once a writer's WAL sidecars exist (the
 *     doorbell's own open, openRelayDbIfWritten); it never creates a sidecar. All its writes go to its
 *     own dir: <instance>/watch/<agent>/ (the lock, the heartbeat, the woken-for state).
 *   - A heartbeat while it holds the lock (at most once a minute), so a HUNG watch shows as stale.
 *   - A NULL reading session, a DB with no writer yet, or a failed read: it keeps waiting (a failed read
 *     says DEGRADED on stderr once per streak); it exits only to wake, on a signal, or on a fatal fault.
 *   - Its lock file removed or replaced under it (lockStillOurs): it exits 1 with a re-arm line, since
 *     a second watch could otherwise take a NEW lock beside it.
 *
 * --lock-status: for the arming pre-check and the Stop hook. Prints one word and exits 0:
 * `live` (a watch holds the lock, heartbeat fresh), `stale` (held, heartbeat old: hung) or `absent`.
 */
import path from "path";

export const RETRY_BUSY = { attempts: 5, delayMs: 100 } as const;
export const HEARTBEAT_EVERY_MS = 60_000;
export const FALLBACK_POLL_MS = 3_000;

/** POSIX single-quoting: safe for any path (the install path may contain spaces). */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/**
 * The exact re-arm command, as the agent must run it (in the background). It names THIS CLI by absolute
 * path (`relay` may not be on the agent's PATH) and THIS relay DB (the instance is never re-resolved
 * differently, so the re-armed watch takes the SAME lock the supervisor probes).
 */
export const rearmCommand = (agent: string, dbPath: string, cli: string = path.resolve(process.argv[1] ?? "relay")): string => `RELAY_DB_PATH=${shq(dbPath)} ${shq(cli)} watch ${agent} --until-wake`;

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
  const dir = W.watchDirFor(dbPath, agent);
  ensurePrivateDir(path.dirname(dir));
  ensurePrivateDir(dir);

  // ONE watch per agent, OLDEST wins. Retry briefly: a liveness probe holds the lock for an instant.
  const names: import("../doorbell-lock.js").LockNames = { lockFile: W.WATCH_LOCK_FILE, holderFile: W.WATCH_HOLDER_FILE, heldBy: `a watch for ${agent} is already live` };
  const me = { pid: process.pid, proc_start: processStartedAt(process.pid), host_id: getOwnHostId() };
  let lock: Awaited<ReturnType<typeof acquireInstanceLock>> | null = null;
  for (let i = 0; i < RETRY_BUSY.attempts; i++) {
    lock = acquireInstanceLock(dir, me, () => new Date(now()).toISOString(), names);
    if (lock.ok) break;
    await new Promise((r) => setTimeout(r, RETRY_BUSY.delayMs));
  }
  if (!lock || !lock.ok) {
    process.stdout.write(`relay watch: a watch for ${agent} is already live (one per agent): nothing to do.\n`);
    return 0;
  }
  const handle = lock.handle;

  const { openRelayDbIfWritten } = await import("../doorbell-run.js");
  const { pendingMetadata } = await import("../db.js");
  type Handle = import("../sqlite-compat.js").CompatDatabase;
  let db: Handle | null = null;
  let lastBeat = 0;
  let degraded = false;
  let finished = false;

  return await new Promise<number>((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    let watcher: import("fs").FSWatcher | null = null;
    const finish = (code: number, line?: string) => {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      try {
        watcher?.close();
      } catch {
        /* already closed */
      }
      try {
        db?.close();
      } catch {
        /* already closed */
      }
      releaseInstanceLock(handle);
      if (line) process.stdout.write(`${line}\n`);
      resolve(code);
    };
    const onSignal = () => finish(0);
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);

    const check = async (): Promise<void> => {
      if (finished) return;
      // The lock file at the path must still be the one we hold: if the dir was removed or the file
      // replaced, a second watch could take a NEW lock and two watches would run. Stop, loudly.
      if (!lockStillOurs(handle)) {
        finish(1, `relay watch: the watch lock for ${agent} was removed or replaced under this watch: it stopped. Re-arm in the background: ${rearmCommand(agent, dbPath)}`);
        return;
      }
      const t = now();
      if (t - lastBeat >= HEARTBEAT_EVERY_MS) {
        try {
          W.writeHeartbeat(dir, process.pid, new Date(t).toISOString());
          lastBeat = t;
        } catch (err) {
          say(`[sentinel] DEGRADED: the watch heartbeat for ${agent} could not be written (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      try {
        if (!db) {
          const r = await openRelayDbIfWritten(dbPath);
          if ("waiting" in r) return; // no writer yet: keep waiting (never create a sidecar)
          db = r.db;
        }
        const m = pendingMetadata(db, agent);
        if (degraded) say(`[sentinel] recovered: the watch for ${agent} reads its mailbox again`);
        degraded = false;
        if (!m.registered) {
          finish(1);
          say(`[sentinel] DEGRADED: ${agent} is not registered in this relay: nothing to watch`);
          return;
        }
        const meta = new Map(m.messages.map((x) => [x.id, { from: x.from, lane: "direct" as const }]));
        const read = { registered: true, reading_session: m.reading_session, ids: m.messages.map((x) => x.id), meta };
        const woken = W.readWoken(dir);
        const d = W.decideWake(read, agent, woken, t, currentWakePolicy());
        if (d.wake.length === 0) return; // nothing new to wake for (or a NULL session: keep waiting)
        const senders = d.wake.flatMap((id) => (meta.get(id)?.from ? [meta.get(id)!.from as string] : []));
        W.writeWoken(dir, W.recordWake(woken, m.reading_session as string, d.wake, read.ids, senders, t));
        finish(0, `relay mail pending for ${agent}: ${d.wake.length} new message(s). Call get_messages, then re-arm in the background: ${rearmCommand(agent, dbPath)}`);
      } catch (err) {
        if (!degraded) say(`[sentinel] DEGRADED: the watch for ${agent} cannot read its mailbox (${err instanceof Error ? err.message : String(err)}): retrying`);
        degraded = true;
        try {
          db?.close();
        } catch {
          /* already closed */
        }
        db = null;
      }
    };

    void check();
    timer = setInterval(() => void check(), opts.intervalMs ?? FALLBACK_POLL_MS);
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
  const W = await import("../watch-wake.js");
  process.stdout.write(`${W.watchStatus(W.watchDirFor(process.env.RELAY_DB_PATH as string, agent))}\n`);
  return 0;
}
