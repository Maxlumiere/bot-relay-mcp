// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * REPORT-ONLY, OPT-IN (RELAY_TIMING_OFFCPU=1): SEE an off-CPU wait of the MAIN thread. The timing bars' A/A control has
 * breached its 500 ms ceiling on Linux with the main thread off-CPU and the idle sentinel unaffected (#366's header;
 * #450 f9dd87d): the sync-call recorder saw nothing (its stated blind spots). This asks the KERNEL instead.
 *
 * - The main thread publishes a heartbeat (Atomics.store into a SharedArrayBuffer) on its own 10 ms timer.
 * - Its OWN idle worker (never the bars' sentinel) polls the heartbeat every 10 ms. When it is older than `thresholdMs`,
 *   the main thread is stalled: the worker samples the main thread's kernel state every `sampleEveryMs` from
 *   /proc/self/task/<main tid>/ (the same thread group: no root, no ptrace right needed): `stat` (state), `wchan`,
 *   `syscall` (number + args), and, for a call whose first argument is a file descriptor, the file it names.
 * - On recovery, ONE stall record: start, duration, samples; the main thread drains them when the watch stops.
 * - Linux only: elsewhere the watch reports "not supported" (never a silent pass). Inert without the flag.
 * Nothing here is a verdict input. The extra main-thread work (one store per 10 ms) is measured, never assumed.
 */
import { Worker, isMainThread } from "node:worker_threads";

export interface ThreadSample {
  /** Milliseconds since the stall began. */
  atMs: number;
  /** The scheduler state letter from stat (R running, S sleeping, D uninterruptible, ...), or "?" if unreadable. */
  state: string;
  /** The kernel wait channel (or "0" / "" when none). */
  wchan: string;
  /** "running", the syscall's NAME (or "nr<N>" when unknown), "none" (blocked outside a syscall), or "?". */
  syscall: string;
  /** For a call whose first argument is a file descriptor: what that descriptor names (readlink), else absent. */
  fdTarget?: string;
  /** The process's child pids and commands at the moment, when any (a nested-loop sync call has one). */
  children?: string[];
}
export interface StallRecord {
  startedAtMs: number;
  durationMs: number;
  samples: ThreadSample[];
}
export interface OffCpuWatch {
  supported: boolean;
  /** Why there is no reading, when not supported. */
  why?: string;
  /** Stop the heartbeat and the worker, and return every stall recorded (report-only). */
  stop(): Promise<StallRecord[]>;
}

/** Syscall numbers that matter for a wait, per CPU family (x86_64 and arm64 differ). */
export const SYSCALL_NAMES: Record<string, Record<number, string>> = {
  x64: {
    0: "read", 1: "write", 7: "poll", 17: "pread64", 18: "pwrite64", 23: "select", 35: "nanosleep", 61: "wait4",
    72: "fcntl", 73: "flock", 74: "fsync", 75: "fdatasync", 202: "futex", 230: "clock_nanosleep", 232: "epoll_wait",
    247: "waitid", 257: "openat", 270: "pselect6", 271: "ppoll", 281: "epoll_pwait", 426: "io_uring_enter", 441: "epoll_pwait2",
  },
  arm64: {
    22: "epoll_pwait", 25: "fcntl", 32: "flock", 56: "openat", 63: "read", 64: "write", 67: "pread64", 68: "pwrite64",
    72: "pselect6", 73: "ppoll", 82: "fsync", 83: "fdatasync", 95: "waitid", 98: "futex", 101: "nanosleep",
    115: "clock_nanosleep", 260: "wait4", 426: "io_uring_enter", 441: "epoll_pwait2",
  },
};
/** The calls whose FIRST argument is a file descriptor (its target is named). */
export const FD_FIRST = new Set(["read", "write", "pread64", "pwrite64", "fsync", "fdatasync", "fcntl", "flock", "epoll_wait", "epoll_pwait", "epoll_pwait2"]);

/** The state letter from a /proc/.../stat line: the field after the LAST ")" (the command name may hold spaces or parens). */
export function parseProcStat(stat: string): string {
  const close = stat.lastIndexOf(")");
  if (close < 0) return "?";
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  return rest[0] && /^[A-Za-z]$/.test(rest[0]) ? rest[0] : "?";
}

/** A /proc/.../syscall line → its name and first argument: "running", "-1 sp pc" (blocked, no syscall), or "nr a0 ... a5 sp pc". */
export function parseProcSyscall(line: string, arch: string = process.arch): { syscall: string; arg0?: number } {
  const t = line.trim();
  if (t === "running") return { syscall: "running" };
  const parts = t.split(/\s+/);
  const nr = Number(parts[0]);
  if (!Number.isInteger(nr)) return { syscall: "?" };
  if (nr < 0) return { syscall: "none" };
  const name = SYSCALL_NAMES[arch]?.[nr] ?? `nr${nr}`;
  const arg0 = parts[1] !== undefined ? Number.parseInt(parts[1], 16) : undefined;
  return { syscall: name, arg0: Number.isFinite(arg0) ? arg0 : undefined };
}

/** The worker's body (plain JS, run with eval: it cannot import TS); its parsers mirror the exported ones above. */
const WORKER_SOURCE = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const { sab, tid, thresholdMs, sampleEveryMs, names, fdFirst } = workerData;
const beat = new BigInt64Array(sab);
const now = () => performance.timeOrigin + performance.now();
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const stateOf = (s) => { if (!s) return "?"; const c = s.lastIndexOf(")"); const f = s.slice(c + 1).trim().split(/\s+/)[0]; return /^[A-Za-z]$/.test(f || "") ? f : "?"; };
const children = () => {
  const out = [];
  const list = read("/proc/self/task/" + tid + "/children");
  for (const pid of (list || "").trim().split(/\s+/).filter(Boolean)) {
    const cmd = (read("/proc/" + pid + "/cmdline") || "").split("\0").filter(Boolean).join(" ").slice(0, 120);
    out.push(pid + " " + cmd);
  }
  return out;
};
const sample = (startedAt) => {
  const base = "/proc/self/task/" + tid + "/";
  const s = { atMs: Math.round(now() - startedAt), state: stateOf(read(base + "stat")), wchan: (read(base + "wchan") || "").trim(), syscall: "?" };
  const line = (read(base + "syscall") || "").trim();
  if (line === "running") s.syscall = "running";
  else if (line) {
    const parts = line.split(/\s+/);
    const nr = Number(parts[0]);
    if (Number.isInteger(nr)) {
      s.syscall = nr < 0 ? "none" : (names[nr] || ("nr" + nr));
      if (fdFirst.includes(s.syscall) && parts[1] !== undefined) {
        try { s.fdTarget = fs.readlinkSync("/proc/self/fd/" + parseInt(parts[1], 16)); } catch { s.fdTarget = "(unreadable)"; }
      }
    }
  }
  const kids = children();
  if (kids.length > 0) s.children = kids;
  return s;
};
const records = [];
let stall = null;
let lastSample = 0;
const timer = setInterval(() => {
  const last = Number(Atomics.load(beat, 0)) / 1000;
  const t = now();
  if (t - last >= thresholdMs) {
    if (!stall) stall = { startedAtMs: last, samples: [] };
    if (t - lastSample >= sampleEveryMs) { stall.samples.push(sample(stall.startedAtMs)); lastSample = t; }
  } else if (stall) {
    stall.durationMs = Math.round(last - stall.startedAtMs);
    records.push(stall);
    stall = null;
  }
}, 10);
parentPort.on("message", (m) => {
  if (m === "drain") {
    clearInterval(timer);
    if (stall) { stall.durationMs = Math.round(now() - stall.startedAtMs); records.push(stall); }
    parentPort.postMessage(records);
  }
});
`;

/**
 * Start the watch: null without RELAY_TIMING_OFFCPU=1 (nothing is created); not supported off Linux. `env` and
 * `platform` are seams for the rows.
 */
export function startOffCpuWatch(
  opts: { thresholdMs?: number; sampleEveryMs?: number; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): OffCpuWatch | null {
  const env = opts.env ?? process.env;
  if (env.RELAY_TIMING_OFFCPU !== "1") return null;
  if ((opts.platform ?? process.platform) !== "linux") return { supported: false, why: `not supported on ${opts.platform ?? process.platform} (Linux /proc only)`, stop: async () => [] };
  // The main thread's tid is the pid only on the process's MAIN thread: anywhere else this would sample another thread.
  if (!isMainThread) return { supported: false, why: "not on the process's main thread (its tid is unknown): no reading", stop: async () => [] };
  const sab = new SharedArrayBuffer(8);
  const beat = new BigInt64Array(sab);
  const stamp = () => Atomics.store(beat, 0, BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)));
  stamp();
  const heartbeat = setInterval(stamp, 10);
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      sab,
      tid: process.pid,
      thresholdMs: opts.thresholdMs ?? 150,
      sampleEveryMs: opts.sampleEveryMs ?? 25,
      names: SYSCALL_NAMES[process.arch] ?? {},
      fdFirst: [...FD_FIRST],
    },
  });
  worker.unref();
  return {
    supported: true,
    stop: () =>
      new Promise<StallRecord[]>((resolve) => {
        clearInterval(heartbeat);
        stamp();
        worker.once("message", (records: StallRecord[]) => {
          void worker.terminate();
          resolve(records);
        });
        worker.postMessage("drain");
      }),
  };
}

/** One report line per stall (report-only), or the "not supported" line. */
export function offCpuLines(label: string, watch: OffCpuWatch | null, records: StallRecord[]): string[] {
  if (watch === null) return [];
  if (!watch.supported) return [`OFFCPU ${label} | ${watch.why ?? "not supported"}: no reading`];
  if (records.length === 0) return [`OFFCPU ${label} | no main-thread stall of the threshold or more`];
  return records.map((r) => {
    const seen = r.samples.map((s) => `${s.atMs}ms ${s.state} ${s.syscall}${s.fdTarget ? ` fd→${s.fdTarget}` : ""}${s.wchan && s.wchan !== "0" ? ` wchan=${s.wchan}` : ""}${s.children ? ` children=[${s.children.join("; ")}]` : ""}`);
    return `OFFCPU ${label} | stall ${r.durationMs} ms | ${seen.join(" | ") || "no sample taken"}`;
  });
}
