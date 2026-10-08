// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A test WINDOW for doorbell PR 7's watch (ruling ffcaf608 D1: a watch belongs to the window it
 * descends from). The window is a real `bash -s` process reading commands from its stdin; each watch
 * it runs is its DESCENDANT (window → subshell → node), exactly the shape of a Claude window's
 * background task (claude → shell → node). Every file a run writes lives in the test's own dir.
 */
import fs from "fs";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";

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
  pid: number;
  child: ChildProcess;
  /** Run `cmd` (a shell command) as a descendant of this window, in the background. */
  run: (cmd: string) => WindowRun;
  /** Every node pid this window ran (killing the window does not kill its children). */
  pids: number[];
  /**
   * Kill EVERYTHING the window started and return only once none of it is left. The window is the
   * leader of its OWN process group, and every process it starts (each run's subshell, its node, any
   * grandchild of a compound command) stays in that group, so ONE group SIGKILL reaches all of them.
   * Killing processes one by one did not: a run's subshell outlived close() and wrote its code file into
   * the test's dir while the test was removing it (ENOTEMPTY in an afterAll). Bounded: a group that is
   * not empty within the bound fails close() LOUDLY, naming what is left (a hang is worse).
   */
  close: () => Promise<void>;
}

/** Test-only seams for the helper's own regression tests. */
export interface WindowOpts {
  /** Delay each run's subshell between its command ending and writing <id>.code (seconds). */
  codeWriteDelayS?: number;
  /** How long close() waits for the group to be empty (default 5000 ms). */
  closeWaitMs?: number;
  /** Does the group still have members? (default: kill(-pgid, 0)). */
  groupAlive?: (pgid: number) => boolean;
}

let seq = 0;
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const realGroupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The processes still in group `pgid`, for the loud failure (best-effort; bounded). */
const groupMembers = (pgid: number): string => {
  const r = spawnSync("ps", ["-A", "-o", "pid=,pgid=,stat=,comm="], { encoding: "utf-8", timeout: 2_000 });
  const rows = (r.stdout ?? "").split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 4 && Number(f[1]) === pgid);
  return rows.length ? rows.map((f) => `${f[0]} ${f[2]} ${f.slice(3).join(" ")}`).join(", ") : "none listed";
};

export function openWindow(dir: string, env: Record<string, string>, opts: WindowOpts = {}): TestWindow {
  // POSIX only: a `bash` window and process groups (node's detached spawn = setsid in-process, no
  // `setsid` binary). CI runs the helper's users on Linux and macOS; the Windows job runs a named subset
  // that includes none of them.
  if (process.platform === "win32") throw new Error("openWindow: POSIX only (a bash window and process groups)");
  fs.mkdirSync(dir, { recursive: true });
  const delay = opts.codeWriteDelayS;
  if (delay !== undefined && !(Number.isFinite(delay) && delay >= 0)) throw new Error(`codeWriteDelayS must be a number >= 0, got ${delay}`);
  const closeWaitMs = opts.closeWaitMs ?? 5_000;
  const groupAlive = opts.groupAlive ?? realGroupAlive;
  // detached: the window leads its own process group (setsid), which everything it starts inherits.
  const child = spawn("bash", ["-s"], { env, stdio: ["pipe", "ignore", "ignore"], detached: true });
  const pgid = child.pid as number;
  // The SENTINEL: a member that only close() kills, so the group (and with it its id: POSIX never reuses
  // a process group's id while the group exists) outlives the window and every run until close(). The
  // group kill below can therefore never reach a process this window did not start, even after a test
  // killed the window itself.
  child.stdin?.write("sleep 2147483647 < /dev/null > /dev/null 2>&1 &\n");
  const pids: number[] = [];
  let closed = false;
  const read = (f: string) => {
    try {
      return fs.readFileSync(f, "utf-8");
    } catch {
      return "";
    }
  };
  const w: TestWindow = {
    pid: pgid,
    child,
    pids,
    run(cmd: string): WindowRun {
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
          if (closed) return -1; // the window was closed under it: stop polling
          await sleep(50);
        }
      })();
      return { id, pid, out: () => read(O), err: () => read(E), exited };
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        process.kill(-pgid, "SIGKILL"); // the window, the sentinel, every run, every grandchild
      } catch {
        /* the group is already empty */
      }
      // Empty = every member died AND was reaped (a zombie still counts: until then it is not provably done).
      const deadline = Date.now() + closeWaitMs;
      while (groupAlive(pgid) && Date.now() < deadline) await sleep(25);
      if (groupAlive(pgid)) {
        throw new Error(`window close (${dir}): process group ${pgid} is not empty after ${closeWaitMs} ms (left: ${groupMembers(pgid)}): something it started may still write into this dir`);
      }
    },
  };
  return w;
}

/** Resolve with the value, or "timeout" after `ms`. */
export const within = <T>(p: Promise<T>, ms: number): Promise<T | "timeout"> => Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);
