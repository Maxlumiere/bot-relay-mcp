// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A test WINDOW for doorbell PR 7's watch (ruling ffcaf608 D1: a watch belongs to the window it
 * descends from). The window is a real `bash -s` process reading commands from its stdin; each watch
 * it runs is its DESCENDANT (window → subshell → node), exactly the shape of a Claude window's
 * background task (claude → shell → node). Every file a run writes lives in the test's own dir.
 *
 * THE CONTRACT (#318, architect ruling 43899b6d), ENFORCED rather than commented:
 * - The window only runs TYPED commands: the relay watch CLI (runRelayWatch, runRelayWatchOrphaned,
 *   runPrintedRelayCommand, which accepts only the exact shape the relay prints), `sleep` (runSleep),
 *   and the named fixtures of the helper's own regression test. No arbitrary shell string. None of these
 *   detaches (the watch spawns only short synchronous probes: ps, sysctl).
 * - OWNERSHIP: a SUPERVISOR is the leader of the window's own process group (node's detached spawn:
 *   setsid in-process). It starts the killable `bash` window in that group and acknowledges it ("ready
 *   <bash pid>") before openWindow returns. Tests never kill it. While it lives, POSIX never reuses the
 *   group's id, so close() signals the group ONLY after verifying the supervisor is alive with the start
 *   token read at open (unreadable or gone → signal NOTHING and fail: "cannot verify the window's owner").
 * - close() SIGKILLs the whole group (the window, every run, every grandchild), waits, bounded, until it
 *   is empty (a zombie still counts), then SWEEPS for ESCAPES: a descendant that left the group
 *   (setsid/setpgid) still carries the window's random WATCH_WINDOW_ID in its ENVIRONMENT. Matched
 *   exactly, in the environment only (never argv text), never the runner or its ancestors; listed first,
 *   then only the listed pids are killed, and close() FAILS naming them. An environment that cannot be
 *   read is unreadable, never a hit.
 * - RESIDUAL (stated): a descendant that both detaches AND clears its environment escapes detection.
 * - POSIX only (a bash window, process groups): openWindow refuses win32. CI runs the helper's users on
 *   Linux and macOS; the Windows job runs a named subset that includes none of them.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { isPidAlive, processStartedAt } from "../../src/liveness.js";

const RELAY_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "relay");

export interface WindowRun {
  /** The run's id: its files are <id>.out/.err/.pid/.code in the window's dir. */
  id: string;
  /** The node (watch) process id, once it has started. */
  pid: () => Promise<number>;
  out: () => string;
  err: () => string;
  /** Resolves with the exit code once the run ends (polls its code file); -1 if the window closed first. */
  exited: Promise<number>;
}

export interface TestWindow {
  /** The killable window: the `bash` every run descends from. */
  pid: number;
  /** The group's leader (the supervisor): never killed by a test. */
  leaderPid: number;
  /** The random marker every process the window starts carries in its environment. */
  windowId: string;
  child: ChildProcess;
  /** `node bin/relay watch <args>` as a descendant of the window, in the background. */
  runRelayWatch: (args: readonly string[]) => WindowRun;
  /** The same, launched so that its parent exits at once (`& disown; exit 0`): the watch is ORPHANED. Output → `outFile`. */
  runRelayWatchOrphaned: (args: readonly string[], outFile: string) => void;
  /** A command the RELAY printed (its arm-check / re-arm line), run exactly as printed; any other shape is refused. */
  runPrintedRelayCommand: (printed: string) => WindowRun;
  runSleep: (seconds: number) => WindowRun;
  /** Every node pid this window ran (killing the window does not kill its children). */
  pids: number[];
  /**
   * Kill EVERYTHING the window started and return only once none of it is left (see the header). ONE
   * shutdown: every call returns the same promise, a rejection included.
   */
  close: () => Promise<void>;
}

/** The named fixtures of the helper's own regression test (tests/watch-window-close.test.ts). Never for other tests. */
export interface WindowFixtures {
  /** A compound command (`… && true`) whose GRANDCHILD writes `late` once `release` exists; it creates `ready` first. */
  compoundWriter: (f: { ready: string; release: string; late: string }) => WindowRun;
  /** A grandchild that LEAVES the group (node detached spawn: setsid) and writes `late` once `release` exists; `ready` first. */
  detachedWriter: (f: { ready: string; release: string; late: string; pidFile: string }) => WindowRun;
}

/** Test-only seams for the helper's own regression tests. */
export interface WindowOpts {
  /** Delay each run's subshell between its command ending and writing <id>.code (seconds). */
  codeWriteDelayS?: number;
  /** How long close() waits for the group to be empty (default 5000 ms). */
  closeWaitMs?: number;
  /** Does the group still have members? (default: kill(-pgid, 0)). */
  groupAlive?: (pgid: number) => boolean;
  /** The leader's start token now (default: liveness.processStartedAt). */
  leaderStart?: (pid: number) => string | null;
}

let seq = 0;
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number) => Atomics.wait(SLEEP_CELL, 0, 0, ms);

const realGroupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** pid → ppid for every process (one `ps`); null when the table cannot be read. */
function processTable(): Map<number, number> | null {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf-8", timeout: 2_000 });
  if (r.status !== 0 || !r.stdout) return null;
  const t = new Map<number, number>();
  for (const line of r.stdout.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length === 2 && /^\d+$/.test(f[0]) && /^\d+$/.test(f[1])) t.set(Number(f[0]), Number(f[1]));
  }
  return t.size > 0 ? t : null;
}

/** This process and every ancestor: NEVER selected by the sweep. */
export function selfAndAncestors(table: Map<number, number>, self = process.pid): Set<number> {
  const out = new Set<number>();
  for (let p: number | undefined = self; p !== undefined && p > 0 && !out.has(p); p = table.get(p)) out.add(p);
  return out;
}

/** One process's ENVIRONMENT, as entries; null = unreadable (never a hit). */
export type EnvReader = (pid: number) => string[] | null;

/**
 * One snapshot of every process's ENVIRONMENT. Linux: /proc/<pid>/environ (NUL-separated), read per pid.
 * macOS: TWO batch `ps` calls (argv only, then argv + `-E` environment); a pid's environment is only what
 * `-E` shows AFTER that pid's exact argv text. Anything else (the process changed or exited between the
 * calls, another user's process with no environment shown) is UNREADABLE, never a hit.
 */
export function snapshotProcessEnv(): EnvReader {
  if (process.platform === "linux") {
    return (pid) => {
      try {
        return fs.readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").filter(Boolean);
      } catch {
        return null;
      }
    };
  }
  const byPid = (args: string[]): Map<number, string> => {
    const r = spawnSync("ps", args, { encoding: "utf-8", timeout: 4_000, maxBuffer: 64 * 1024 * 1024 });
    const m = new Map<number, string>();
    if (r.status !== 0 || !r.stdout) return m;
    for (const line of r.stdout.split("\n")) {
      const g = /^\s*(\d+) (.*)$/.exec(line);
      if (g) m.set(Number(g[1]), g[2]);
    }
    return m;
  };
  const plain = byPid(["-A", "-ww", "-o", "pid=,command="]);
  const withEnv = byPid(["-A", "-ww", "-E", "-o", "pid=,command="]);
  return (pid) => {
    const a = plain.get(pid);
    const b = withEnv.get(pid);
    if (a === undefined || b === undefined || a.length === 0 || !b.startsWith(a)) return null;
    const tail = b.slice(a.length).trim();
    return tail.length === 0 ? null : tail.split(/\s+/);
  };
}

/**
 * The ESCAPE sweep, pure over its inputs: every pid whose ENVIRONMENT holds exactly WATCH_WINDOW_ID=<id>,
 * never one in `excluded` (the runner and its ancestors). An unreadable environment is not a hit.
 */
export function findEscapes(id: string, pids: Iterable<number>, readEnv: EnvReader, excluded: Set<number>): number[] {
  const marker = `WATCH_WINDOW_ID=${id}`;
  const hits: number[] = [];
  for (const pid of pids) {
    if (excluded.has(pid)) continue;
    const env = readEnv(pid);
    if (env !== null && env.includes(marker)) hits.push(pid);
  }
  return hits.sort((x, y) => x - y);
}

export function openWindow(dir: string, env: Record<string, string>, opts: WindowOpts = {}): TestWindow & { fixtures: WindowFixtures } {
  if (process.platform === "win32") throw new Error("openWindow: POSIX only (a bash window and process groups)");
  fs.mkdirSync(dir, { recursive: true });
  const delay = opts.codeWriteDelayS;
  if (delay !== undefined && !(Number.isFinite(delay) && delay >= 0)) throw new Error(`codeWriteDelayS must be a number >= 0, got ${delay}`);
  const closeWaitMs = opts.closeWaitMs ?? 5_000;
  const groupAlive = opts.groupAlive ?? realGroupAlive;
  const startOf = opts.leaderStart ?? ((pid: number) => processStartedAt(pid));
  const windowId = crypto.randomBytes(16).toString("hex");
  const readyFile = path.join(dir, `.window-${windowId}.ready`);

  // The SUPERVISOR: the group leader (detached = setsid). It starts the window (`bash -s`, reading OUR
  // pipe), acknowledges it only AFTER that fork ($! is set), then WAITS for it: a window a test kills is
  // REAPED at once (an unreaped zombie still shows its start in `ps`, so the watches under test would read
  // their window as alive forever). After that it idles, alive, so the group lives until close() kills it.
  const child = spawn("sh", ["-c", `bash -s <&0 & echo "ready $!" > ${sq(readyFile)}; wait; while :; do sleep 3600; done`], {
    env: { ...env, WATCH_WINDOW_ID: windowId },
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
  });
  const leaderPid = child.pid;
  if (!Number.isInteger(leaderPid) || (leaderPid as number) <= 1) throw new Error("openWindow: the supervisor did not start (no valid pid): nothing is signalled");
  let bashPid = 0;
  for (let i = 0; i < 400 && bashPid === 0; i++) {
    const m = /^ready (\d+)\s*$/.exec(fs.existsSync(readyFile) ? fs.readFileSync(readyFile, "utf-8") : "");
    if (m) bashPid = Number(m[1]);
    else sleepSync(10);
  }
  // Ownership proven, or nothing is exposed and nothing is signalled (we cannot prove the group is ours).
  const leaderStart = bashPid > 1 && isPidAlive(leaderPid as number) ? startOf(leaderPid as number) : null;
  if (bashPid <= 1 || leaderStart === null) {
    throw new Error(`openWindow (${dir}): the supervisor never acknowledged the window or its start is unreadable: nothing is signalled`);
  }

  const pids: number[] = [];
  let polling = true;
  let shutdown: Promise<void> | null = null;
  const read = (f: string) => {
    try {
      return fs.readFileSync(f, "utf-8");
    } catch {
      return "";
    }
  };
  // The ONE way a command reaches the window (private: callers use the typed entry points).
  const launch = (cmd: string): WindowRun => {
    const id = `r${++seq}`;
    const O = path.join(dir, `${id}.out`);
    const E = path.join(dir, `${id}.err`);
    const P = path.join(dir, `${id}.pid`);
    const C = path.join(dir, `${id}.code`);
    // The subshell (a child of the window) starts the command in the background, records its pid,
    // waits for it, then records its exit code: the command's parent is the subshell, whose parent
    // is the window.
    const pause = delay === undefined ? "" : `sleep ${delay}; `;
    child.stdin?.write(`( ${cmd} > ${sq(O)} 2> ${sq(E)} & p=$!; echo $p > ${sq(P)}; wait $p; rc=$?; ${pause}echo $rc > ${sq(C)} ) &\n`);
    const pid = async (): Promise<number> => {
      for (let i = 0; i < 200; i++) {
        const t = read(P).trim();
        if (/^\d+$/.test(t)) {
          if (!pids.includes(Number(t))) pids.push(Number(t));
          return Number(t);
        }
        await sleep(25);
      }
      throw new Error(`run ${id} never started`);
    };
    void pid().catch(() => {});
    const exited = (async () => {
      for (;;) {
        const t = read(C).trim();
        if (/^\d+$/.test(t)) return Number(t);
        if (!polling) return -1; // the window was closed under it: stop polling
        await sleep(50);
      }
    })();
    return { id, pid, out: () => read(O), err: () => read(E), exited };
  };
  const relayArgs = (args: readonly string[]) => {
    for (const a of args) if (typeof a !== "string" || a.length === 0) throw new Error(`runRelayWatch: invalid argument ${JSON.stringify(a)}`);
    return `node ${sq(RELAY_BIN)} watch ${args.map(sq).join(" ")}`;
  };
  // Exactly what the relay prints: rearmCommand / armCheckCommand (src/cli/watch-until-wake.ts, shq: always
  // single-quoted, ' as '\'') and the Stop hook's re-arm line (hooks/stop-check.sh, Python shlex.quote: bare
  // when only [\w@%+=:,./-], else single-quoted, ' as '"'"'): RELAY_DB_PATH=<word> <word> watch <agent> <mode>.
  const WORD = String.raw`(?:[A-Za-z0-9_@%+=:,./-]+|'(?:[^']|'\\''|'"'"')*')`;
  const PRINTED = new RegExp(`^RELAY_DB_PATH=${WORD} ${WORD} watch [A-Za-z0-9._-]+ --(?:until-wake|arm-check)$`);

  const doClose = async (): Promise<void> => {
    polling = false;
    // OWNERSHIP before any signal: the leader must be alive AND the process we started (its start token).
    const lp = leaderPid as number;
    if (!isPidAlive(lp)) throw new Error(`window close (${dir}): cannot verify the window's owner: its supervisor (pid ${lp}) is gone; nothing is signalled`);
    const deadline = Date.now() + closeWaitMs;
    let now = startOf(lp);
    while (now === null && isPidAlive(lp) && Date.now() < deadline) {
      await sleep(50); // unreadable: re-read (never decided on), within the same deadline
      now = startOf(lp);
    }
    if (now === null) throw new Error(`window close (${dir}): cannot verify the window's owner: the start of its supervisor (pid ${lp}) is unreadable; nothing is signalled`);
    if (now !== leaderStart) throw new Error(`window close (${dir}): cannot verify the window's owner: pid ${lp} is another process now; nothing is signalled`);
    try {
      process.kill(-lp, "SIGKILL"); // the supervisor, the window, every run, every grandchild
    } catch {
      /* the group is already empty */
    }
    while (groupAlive(lp) && Date.now() < deadline) await sleep(25);
    if (groupAlive(lp)) throw new Error(`window close (${dir}): process group ${lp} is not empty after ${closeWaitMs} ms: something it started may still write into this dir`);
    // ESCAPES: list first, then kill ONLY the listed pids, and fail naming them.
    const table = processTable();
    if (table === null) throw new Error(`window close (${dir}): the process table is unreadable: cannot sweep for escaped descendants`);
    const escapes = findEscapes(windowId, table.keys(), snapshotProcessEnv(), selfAndAncestors(table));
    for (const p of escapes) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (escapes.length > 0) throw new Error(`window close (${dir}): escaped the window's process group: pid ${escapes.join(", pid ")} (killed)`);
  };

  const w = {
    pid: bashPid,
    leaderPid: leaderPid as number,
    windowId,
    child,
    pids,
    runRelayWatch: (args: readonly string[]) => launch(relayArgs(args)),
    runRelayWatchOrphaned: (args: readonly string[], outFile: string) => {
      launch(`bash -c ${sq(`${relayArgs(args)} > ${sq(outFile)} 2>&1 & disown; exit 0`)}`);
    },
    runPrintedRelayCommand: (printed: string) => {
      if (!PRINTED.test(printed)) throw new Error(`runPrintedRelayCommand: not a command the relay prints: ${JSON.stringify(printed)}`);
      return launch(printed);
    },
    runSleep: (seconds: number) => {
      if (!(Number.isFinite(seconds) && seconds >= 0)) throw new Error(`runSleep: invalid seconds ${seconds}`);
      return launch(`sleep ${seconds}`);
    },
    close: () => (shutdown ??= doClose()),
    fixtures: {
      compoundWriter: (f: { ready: string; release: string; late: string }) =>
        launch(`sh -c ${sq(`: > ${sq(f.ready)}; while [ ! -e ${sq(f.release)} ]; do sleep 0.05; done; echo late > ${sq(f.late)}`)} && true`),
      detachedWriter: (f: { ready: string; release: string; late: string; pidFile: string }) =>
        launch(
          `node -e ${sq(
            `const { spawn } = require("child_process"); const c = spawn("sh", ["-c", ${JSON.stringify(`echo $$ > ${sq(f.pidFile)}; : > ${sq(f.ready)}; while [ ! -e ${sq(f.release)} ]; do sleep 0.05; done; echo late > ${sq(f.late)}`)}], { detached: true, stdio: "ignore" }); c.unref();`,
          )}`,
        ),
    },
  };
  return w;
}

/** Resolve with the value, or "timeout" after `ms`. */
export const within = <T>(p: Promise<T>, ms: number): Promise<T | "timeout"> => Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);
