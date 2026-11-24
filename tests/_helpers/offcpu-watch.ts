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
  /** The process's child pids and commands at the moment, when any (a nested-loop sync call has one), or ["unavailable"]. */
  children?: string[];
  /** The main thread recovered while this sample's reads ran: it may describe the recovered thread, never evidence. */
  inconclusive?: boolean;
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
const { sab, tid, thresholdMs, sampleEveryMs, names, fdFirst, procRoot, sampleDelayMs } = workerData;
const beat = new BigInt64Array(sab);
const now = () => performance.timeOrigin + performance.now();
const base = procRoot + "/self/task/" + tid + "/";
// A per-field read: the value, or null when the file could not be read (labelled "unavailable", never silently empty).
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const stateOf = (s) => { if (s === null) return "unavailable"; const c = s.lastIndexOf(")"); const f = s.slice(c + 1).trim().split(/\s+/)[0]; return /^[A-Za-z]$/.test(f || "") ? f : "?"; };
// Probed ONCE, up front: without a readable stat for the main thread, nothing here can be read (never "no stall").
if (read(base + "stat") === null) { parentPort.postMessage({ unavailable: "the main thread's " + base + "stat is not readable" }); }
else {
const children = () => {
  const list = read(base + "children");
  if (list === null) return "unavailable";
  const out = [];
  for (const pid of list.trim().split(/\s+/).filter(Boolean)) {
    const raw = read(procRoot + "/" + pid + "/cmdline");
    out.push(pid + " " + (raw === null ? "(command unavailable)" : raw.split("\0").filter(Boolean).join(" ").slice(0, 120)));
  }
  return out;
};
const sample = (startedAt) => {
  const s = { atMs: Math.round(now() - startedAt), state: stateOf(read(base + "stat")), wchan: "", syscall: "?" };
  const w = read(base + "wchan");
  s.wchan = w === null ? "unavailable" : w.trim();
  const raw = read(base + "syscall");
  const line = raw === null ? null : raw.trim();
  if (line === null) s.syscall = "unavailable";
  else if (line === "running") s.syscall = "running";
  else if (line) {
    const parts = line.split(/\s+/);
    const nr = Number(parts[0]);
    if (Number.isInteger(nr)) {
      s.syscall = nr < 0 ? "none" : (names[nr] || ("nr" + nr));
      if (fdFirst.includes(s.syscall) && parts[1] !== undefined) {
        try { s.fdTarget = fs.readlinkSync(procRoot + "/self/fd/" + parseInt(parts[1], 16)); } catch { s.fdTarget = "unavailable"; }
      }
    }
  }
  const kids = children();
  if (kids === "unavailable") s.children = ["unavailable"];
  else if (kids.length > 0) s.children = kids;
  return s;
};
const records = [];
let stall = null;
let lastSample = 0;
const timer = setInterval(() => {
  const before = Atomics.load(beat, 0);
  const last = Number(before) / 1000;
  const t = now();
  if (t - last >= thresholdMs) {
    if (!stall) stall = { startedAtMs: last, samples: [] };
    if (t - lastSample >= sampleEveryMs) {
      const s = sample(stall.startedAtMs);
      if (sampleDelayMs > 0) { const until = now() + sampleDelayMs; while (now() < until) {} } // TESTS ONLY
      // The heartbeat RE-CHECKED after the reads: if the main thread recovered while they ran, the sample may describe
      // the recovered thread (an idle epoll_wait, an unrelated child), so it is marked inconclusive, never evidence.
      if (Atomics.load(beat, 0) !== before) s.inconclusive = true;
      stall.samples.push(s);
      lastSample = t;
    }
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
    parentPort.postMessage({ records });
  }
});
}
`;

/** How long stop() waits for the worker's records before it reports the reading unavailable (never a hang). */
export const DRAIN_DEADLINE_MS = 2000;

/** A worker for the watch (a seam: the rows pass one that throws, exits early or never answers). */
export type WorkerFactory = (source: string, workerData: unknown) => Worker;
const defaultFactory: WorkerFactory = (source, workerData) => new Worker(source, { eval: true, workerData });

/**
 * Start the watch: null without RELAY_TIMING_OFFCPU=1 (nothing is created); not supported off Linux or off the main
 * thread. It NEVER throws and its stop() NEVER rejects or hangs: any failure of the instrument (the worker cannot start,
 * errors, exits before answering, or does not answer within DRAIN_DEADLINE_MS; /proc unreadable) is a labelled
 * "unavailable" reading, so a bar's verdict can never depend on it. `env`, `platform`, `workerFactory`, `procRoot`
 * and `sampleDelayMs` are seams for the rows.
 */
export function startOffCpuWatch(
  opts: {
    thresholdMs?: number;
    sampleEveryMs?: number;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    workerFactory?: WorkerFactory;
    procRoot?: string;
    sampleDelayMs?: number;
    drainDeadlineMs?: number;
  } = {},
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
  heartbeat.unref();
  let worker: Worker;
  try {
    worker = (opts.workerFactory ?? defaultFactory)(WORKER_SOURCE, {
      sab,
      tid: process.pid,
      thresholdMs: opts.thresholdMs ?? 150,
      sampleEveryMs: opts.sampleEveryMs ?? 25,
      names: SYSTEM_NAMES_FOR_ARCH(),
      fdFirst: [...FD_FIRST],
      procRoot: opts.procRoot ?? "/proc",
      sampleDelayMs: opts.sampleDelayMs ?? 0,
    });
  } catch (err) {
    clearInterval(heartbeat);
    return { supported: false, why: `unavailable: the watch's worker could not start (${err instanceof Error ? err.message : String(err)})`, stop: async () => [] };
  }
  worker.unref();
  // The worker's own answer, captured from the start: an early "unavailable" (no /proc), records, an error, an exit.
  let settled: { records?: StallRecord[]; unavailable?: string } | null = null;
  const waiters: Array<() => void> = [];
  const settle = (v: { records?: StallRecord[]; unavailable?: string }) => {
    if (settled === null) settled = v;
    for (const w of waiters.splice(0)) w();
  };
  worker.on("message", (m: { records?: StallRecord[]; unavailable?: string }) => settle(m));
  worker.on("error", (err: Error) => settle({ unavailable: `the watch's worker failed (${err.message})` }));
  worker.on("exit", (code: number) => settle({ unavailable: `the watch's worker exited (code ${code}) before answering` }));
  const watch: OffCpuWatch = {
    supported: true,
    stop: () =>
      new Promise<StallRecord[]>((resolve) => {
        clearInterval(heartbeat);
        stamp();
        const finish = () => {
          clearTimeout(deadline);
          const v = settled ?? { unavailable: `the watch's worker did not answer within ${opts.drainDeadlineMs ?? DRAIN_DEADLINE_MS} ms` };
          if (v.unavailable !== undefined) {
            watch.supported = false;
            watch.why = `unavailable: ${v.unavailable}`;
          }
          void worker.terminate().catch(() => undefined);
          resolve(v.records ?? []);
        };
        const deadline = setTimeout(finish, opts.drainDeadlineMs ?? DRAIN_DEADLINE_MS);
        if (settled !== null) return finish();
        waiters.push(finish);
        try {
          worker.postMessage("drain");
        } catch {
          finish();
        }
      }),
  };
  return watch;
}
const SYSTEM_NAMES_FOR_ARCH = (): Record<number, string> => SYSCALL_NAMES[process.arch] ?? {};

/** One report line per stall (report-only), the "unavailable" or "not supported" line, or a no-stall line. */
export function offCpuLines(label: string, watch: OffCpuWatch | null, records: StallRecord[]): string[] {
  if (watch === null) return [];
  if (!watch.supported) return [`OFFCPU ${label} | ${watch.why ?? "not supported"}: no reading`];
  if (records.length === 0) return [`OFFCPU ${label} | no main-thread stall of the threshold or more`];
  return records.map((r) => {
    const seen = r.samples.map((s) => `${s.atMs}ms ${s.state} ${s.syscall}${s.fdTarget ? ` fd→${s.fdTarget}` : ""}${s.wchan && s.wchan !== "0" ? ` wchan=${s.wchan}` : ""}${s.children ? ` children=[${s.children.join("; ")}]` : ""}${s.inconclusive ? " (inconclusive: the thread recovered during this sample)" : ""}`);
    return `OFFCPU ${label} | stall ${r.durationMs} ms | ${seen.join(" | ") || "no sample taken"}`;
  });
}
