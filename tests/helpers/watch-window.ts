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
  close: () => Promise<void>;
}

let seq = 0;
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function openWindow(dir: string, env: Record<string, string>): TestWindow {
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn("bash", ["-s"], { env, stdio: ["pipe", "ignore", "ignore"] });
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
    pid: child.pid as number,
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
      child.stdin?.write(`( ${cmd} > ${sq(O)} 2> ${sq(E)} & p=$!; echo $p > ${sq(P)}; wait $p; echo $? > ${sq(C)} ) &\n`);
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
      const exited = (async () => {
        for (;;) {
          const t = read(C).trim();
          if (/^\d+$/.test(t)) return Number(t);
          if (closed) return -1; // the window was closed under it: stop polling
          await new Promise((r) => setTimeout(r, 50));
        }
      })();
      return { pid, out: () => read(O), err: () => read(E), exited };
    },
    async close() {
      closed = true;
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
    },
  };
  return w;
}

/** Resolve with the value, or "timeout" after `ms`. */
export const within = <T>(p: Promise<T>, ms: number): Promise<T | "timeout"> => Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);
