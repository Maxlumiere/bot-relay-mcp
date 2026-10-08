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
import { spawn, type ChildProcess } from "child_process";

export interface WindowRun {
  /** The run's id: its files are <id>.out/.err/.pid/.spid/.code in the window's dir. */
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
  /** Every node pid this window ran (to clean up: killing the window does not kill its children). */
  pids: number[];
  /**
   * Kill every run and the window, and return only once every run's subshell has FINISHED (written its
   * <id>.code). Killing the window does not kill those subshells: one that outlived close() wrote its
   * code file into the test's dir while the test was removing it (ENOTEMPTY in an afterAll). A run
   * whose subshell does not finish within the bound fails close() LOUDLY, naming it (a hang is worse).
   */
  close: () => Promise<void>;
}

/** Test-only seams for the helper's own regression tests. */
export interface WindowOpts {
  /** Delay each run's subshell between its command ending and writing <id>.code (seconds). */
  codeWriteDelayS?: number;
  /** How long close() waits for every run's subshell to finish (default 5000 ms). */
  closeWaitMs?: number;
}

let seq = 0;
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function openWindow(dir: string, env: Record<string, string>, opts: WindowOpts = {}): TestWindow {
  fs.mkdirSync(dir, { recursive: true });
  const delay = opts.codeWriteDelayS;
  if (delay !== undefined && !(Number.isFinite(delay) && delay >= 0)) throw new Error(`codeWriteDelayS must be a number >= 0, got ${delay}`);
  const closeWaitMs = opts.closeWaitMs ?? 5_000;
  const child = spawn("bash", ["-s"], { env, stdio: ["pipe", "ignore", "ignore"] });
  const pids: number[] = [];
  const runs: { id: string; codeFile: string; spidFile: string; pid: () => Promise<number> }[] = [];
  let closed = false;
  const read = (f: string) => {
    try {
      return fs.readFileSync(f, "utf-8");
    } catch {
      return "";
    }
  };
  const w: TestWindow = {
    pid: child.pid as number,
    child,
    pids,
    run(cmd: string): WindowRun {
      const id = `r${++seq}`;
      const O = path.join(dir, `${id}.out`);
      const E = path.join(dir, `${id}.err`);
      const P = path.join(dir, `${id}.pid`);
      const C = path.join(dir, `${id}.code`);
      const SP = path.join(dir, `${id}.spid`);
      // The subshell (a child of the window) records its OWN pid (a child sh's $PPID: bash 3.2 has no
      // $BASHPID), starts the command in the background, records its pid, waits for it, then records its
      // exit code: the command's parent is the subshell, whose parent is the window.
      const pause = delay === undefined ? "" : `sleep ${delay}; `;
      child.stdin?.write(`( sh -c 'echo $PPID' > ${sq(SP)}; ${cmd} > ${sq(O)} 2> ${sq(E)} & p=$!; echo $p > ${sq(P)}; wait $p; rc=$?; ${pause}echo $rc > ${sq(C)} ) &\n`);
      const pid = async (): Promise<number> => {
        for (let i = 0; i < 200; i++) {
          const t = read(P).trim();
          if (/^\d+$/.test(t)) {
            if (!pids.includes(Number(t))) pids.push(Number(t));
            return Number(t);
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`run ${id} never started`);
      };
      void pid().catch(() => {});
      runs.push({ id, codeFile: C, spidFile: SP, pid });
      const exited = (async () => {
        for (;;) {
          const t = read(C).trim();
          if (/^\d+$/.test(t)) return Number(t);
          if (closed) return -1; // the window was closed under it: stop polling
          await new Promise((r) => setTimeout(r, 50));
        }
      })();
      return { id, pid, out: () => read(O), err: () => read(E), exited };
    },
    async close() {
      closed = true;
      // Every run's node pid first (it is known only once its subshell wrote it), so none escapes the kill.
      const neverStarted: string[] = [];
      for (const r of runs) await r.pid().catch(() => neverStarted.push(r.id));
      for (const p of pids) {
        try {
          process.kill(p, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      if (child.exitCode === null && child.signalCode === null) {
        const gone = new Promise((r) => child.once("close", r));
        child.kill("SIGKILL");
        await gone;
      }
      // Then every run's subshell must FINISH (its node is dead, so it is only writing <id>.code), or be
      // GONE: a test may kill the subshell itself (the watch's launching shell), and a dead one writes nothing.
      const subshellAlive = (r: (typeof runs)[number]): boolean => {
        const spid = Number(read(r.spidFile).trim());
        if (!Number.isInteger(spid) || spid <= 1) return true; // unknown: never assume it is gone
        try {
          process.kill(spid, 0);
          return true;
        } catch (err) {
          return (err as NodeJS.ErrnoException).code === "EPERM";
        }
      };
      const writing = (r: (typeof runs)[number]) => !fs.existsSync(r.codeFile) && subshellAlive(r);
      const deadline = Date.now() + closeWaitMs;
      let unfinished = runs.filter((r) => !neverStarted.includes(r.id) && writing(r));
      while (unfinished.length > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        unfinished = unfinished.filter(writing);
      }
      const faults = [
        ...neverStarted.map((id) => `${id} never started (no ${id}.pid)`),
        ...unfinished.map((r) => `${r.id} never finished (no ${r.id}.code within ${closeWaitMs} ms, its subshell alive)`),
      ];
      if (faults.length > 0) throw new Error(`window close (${dir}): ${faults.join("; ")}: its subshell may still write into this dir`);
    },
  };
  return w;
}

/** Resolve with the value, or "timeout" after `ms`. */
export const within = <T>(p: Promise<T>, ms: number): Promise<T | "timeout"> => Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);
