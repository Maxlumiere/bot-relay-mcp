// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * An ARGV SAMPLER for "no process's argv ever holds the secret" rows: `ps -axww -o pid=,args=` in a loop, recording
 * any line that contains the secret.
 *
 * COVERAGE BY HANDSHAKE, never by timing (the standing rule for observer tests): the process under observation is
 * held alive by the test's own fake server, which calls `waitForSamples(n, deadlineMs)` before it answers. That
 * resolves `true` once n samples have STARTED inside the hold and COMPLETED while it was still held; past the
 * deadline it resolves `false`. A sample COUNTS only if it WITNESSES the target: a table line with a pid AND the
 * target's non-secret argv marker (an exit-0 empty or restricted table is a BLIND sample, never a sample). A FAILED
 * observation (spawn error, non-zero exit, timeout) is recorded in `failures`. `argvVerdict` turns a run into PASS,
 * FAIL or NOT_EVALUATED; every wait is bounded, and each observer runs in its own process group, killed and reaped as a
 * GROUP on timeout.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

/** Diagnostics are printed: strip control characters and cap the length (never more than a short reason). */
export function sanitizeDiagnostic(s: string, max = 160): string {
  const clean = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Does this `ps -o pid=,args=` table WITNESS the target (a line with a pid and the marker)? */
export function witnesses(table: string, marker: string): boolean {
  return table.split("\n").some((l) => /^\s*\d+\s/.test(l) && Number(/^\s*(\d+)/.exec(l)![1]) > 0 && l.includes(marker));
}

/**
 * The WINDOWS observer: ONE long-lived PowerShell loop over Win32_Process. Each request line (a sequence number) is
 * answered with one FRAME: `@@BEGIN <seq>`, one `<pid> <CommandLine>` line per process (CR/LF folded to spaces, a null
 * CommandLine printed empty), `@@END <seq>`; a failed query answers `@@ERROR <seq> <message>`. The same table shape as
 * `ps -o pid=,args=`, so the witness and the leak scan are unchanged.
 */
const PS_TABLE = [
  "$nl = [string][char]10",
  "function Table { $sb = New-Object System.Text.StringBuilder; foreach ($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId,CommandLine)) { $c = $p.CommandLine; if ($null -eq $c) { $c = '' }; [void]$sb.Append([string]$p.ProcessId + ' ' + ($c -replace '[\r\n]', ' ') + $nl) }; return $sb.ToString() }",
];
const PS_LOOP = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  ...PS_TABLE,
  "while ($true) {",
  "  $seq = [Console]::In.ReadLine()",
  "  if ($null -eq $seq) { break }",
  "  $seq = $seq.Trim()",
  "  try { $t = Table; [Console]::Out.Write('@@BEGIN ' + $seq + $nl + $t + '@@END ' + $seq + $nl) }",
  "  catch { [Console]::Out.Write('@@ERROR ' + $seq + ' ' + ($_.Exception.Message -replace '[\r\n]', ' ') + $nl) }",
  "  [Console]::Out.Flush()",
  "}",
].join("\n");
const PS_ONCE = ["$ErrorActionPreference = 'Stop'", "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)", ...PS_TABLE, "[Console]::Out.Write((Table))"].join("\n");
const encoded = (script: string): string => Buffer.from(script, "utf16le").toString("base64");
const psArgs = (script: string): string[] => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded(script)];
/** The long-lived Windows observer (a framed observer). */
export function windowsObserver(powershell = "powershell.exe"): [string, string[]] {
  return [powershell, psArgs(PS_LOOP)];
}

/** Kill an observer's whole TREE: its process group (POSIX, spawned detached) or `taskkill /T /F` (Windows). */
function killTree(p: ChildProcess): void {
  if (!p.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(p.pid)], { stdio: "ignore", timeout: 10_000, windowsHide: true });
    else process.kill(-p.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** The Windows probe: a marker child must appear in a PowerShell table with its pid AND its full command line. */
function windowsProbe(powershell: string): { visible: boolean; why: string } {
  const marker = `argv-probe-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", marker], { stdio: "ignore", windowsHide: true });
  try {
    for (let i = 0; i < 10; i++) {
      const r = spawnSync(powershell, psArgs(PS_ONCE), { encoding: "utf-8", timeout: 30_000, windowsHide: true });
      if (r.error) return { visible: false, why: sanitizeDiagnostic(`PowerShell could not start (${r.error.message})`) };
      if (r.status !== 0) return { visible: false, why: sanitizeDiagnostic(`PowerShell could not run the process query (exit ${r.status}: ${r.stderr ?? ""})`) };
      const lines = (r.stdout ?? "").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => /^\d+ /.test(l));
      const unreadable = lines.filter((l) => l.replace(/^\d+ /, "").trim() === "").length;
      const own = lines.find((l) => Number(/^(\d+)/.exec(l)![1]) === child.pid);
      if (own && own.includes(marker)) return { visible: true, why: `PowerShell shows a child's pid and full command line (Win32_Process, no elevation; ${unreadable} of ${lines.length} command lines unreadable)` };
      if (own) return { visible: false, why: `CommandLine unreadable for own-user processes (null for ${unreadable} of ${lines.length})` };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); // the child may not be listed yet
    }
    return { visible: false, why: "PowerShell ran but never listed the probe child's pid" };
  } finally {
    child.kill("SIGKILL");
  }
}

/**
 * Can `ps -axww -o pid=,args=` show a process's FULL argv here? A unique marker is put on a child's argv, and the
 * probe requires a table line with THAT child's pid and the marker. Where it cannot (e.g. a ps that rejects the
 * options, or shows no foreign argv), every row relying on the sampler would pass VACUOUSLY: it reports NOT_EVALUATED.
 * The reason is sanitized (never more than a short diagnostic; never argv content beyond the marker).
 */
export function argvSamplerProbe(opts: { powershell?: string } = {}): { visible: boolean; why: string } {
  if (process.platform === "win32") return windowsProbe(opts.powershell ?? "powershell.exe");
  const marker = `argv-probe-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)", marker], { stdio: "ignore" });
  try {
    for (let i = 0; i < 20; i++) {
      const r = spawnSync("ps", ["-axww", "-o", "pid=,args="], { encoding: "utf-8", timeout: 5_000 });
      if (r.error) return { visible: false, why: sanitizeDiagnostic(`ps could not run (${r.error.message})`) };
      if (r.status !== 0) return { visible: false, why: sanitizeDiagnostic(`ps -axww -o pid=,args= exited ${r.status}: ${r.stderr ?? ""}`) };
      const line = (r.stdout ?? "").split("\n").find((l) => l.includes(marker));
      if (line && Number(/^\s*(\d+)/.exec(line)?.[1]) === child.pid) return { visible: true, why: "ps shows a child's pid and full argv" };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // the child may not be listed yet
    }
    return { visible: false, why: "ps ran but never listed the probe child's pid with its argv marker" };
  } finally {
    child.kill("SIGKILL");
  }
}

export interface ArgvSampler {
  /** Successful samples that WITNESSED the target. */
  readonly sampled: number;
  /** Witnessing samples that started inside a hold and completed while that hold was still active. */
  readonly heldSamples: number;
  /** Successful observations that did NOT witness the target (an empty or restricted table): never samples. */
  readonly blindSamples: number;
  /** The table lines that held the secret ("" when none did). */
  readonly leaked: string;
  /** Every FAILED observation (never counted as a sample), sanitized. */
  readonly failures: readonly string[];
  /** true once `n` held samples completed inside this hold; false past `deadlineMs`. Settles exactly once. */
  waitForSamples(n: number, deadlineMs: number): Promise<boolean>;
  /** Stops the loop; kills and reaps the sample in flight (its whole group). Bounded. */
  stop(): Promise<void>;
}

interface Hold {
  need: number;
  got: number;
  active: boolean;
  settle: (ok: boolean) => void;
}

/** Kill an observer's whole process group (POSIX), or the process itself (Windows). */
function killGroup(p: ChildProcess): void {
  try {
    if (process.platform !== "win32" && p.pid) process.kill(-p.pid, "SIGKILL");
    else p.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * `witness`: the target's non-secret argv marker (a sample must show it with a pid). `opts.ps` replaces the observer
 * command (tests of the sampler itself: a failing, blind, slow or stuck observer).
 */
export function startArgvSampler(
  secret: string,
  witness: string,
  opts: { gapMs?: number; sampleTimeoutMs?: number; ps?: [string, string[]]; framed?: [string, string[]] } = {},
): ArgvSampler {
  let sampled = 0;
  let heldSamples = 0;
  let blindSamples = 0;
  let leaked = "";
  const failures: string[] = [];
  let done = false;
  let inFlight: ChildProcess | null = null;
  const holds = new Set<Hold>();

  /**
   * One observation, bounded; its own process group, killed and REAPED as a group on timeout. One that stop() ends is
   * neither a sample nor a failure (our own kill is not the observer failing).
   */
  const sample = (): Promise<{ out: string } | { failed: string } | { stopped: true }> =>
    new Promise((resolve) => {
      let settled = false;
      const [cmd, args] = opts.ps ?? ["ps", ["-axww", "-o", "pid=,args="]];
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32" });
      inFlight = p;
      let o = "";
      let timedOut = false;
      const finish = (r: { out: string } | { failed: string } | { stopped: true }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        inFlight = null;
        resolve(r);
      };
      p.stdout!.on("data", (d: Buffer) => (o += d));
      p.on("error", (e) => finish({ failed: sanitizeDiagnostic(`observer could not spawn (${e.message})`) }));
      // Reaped: "close" fires once the process exited and its stdio closed (the group is killed first on a timeout).
      p.on("close", (code, signal) => {
        if (done && !timedOut) finish({ stopped: true });
        else if (timedOut) finish({ failed: `observer timed out after ${opts.sampleTimeoutMs ?? 5_000} ms (its group killed and reaped)` });
        else finish(code === 0 ? { out: o } : { failed: sanitizeDiagnostic(`observer exited ${code ?? signal}`) });
      });
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(p);
      }, opts.sampleTimeoutMs ?? 5_000);
    });

  /**
   * The FRAMED observer (opts.framed; on Windows by default): ONE long-lived process, one request (a sequence number)
   * answered by one frame. A sample STARTS when its request is written and COMPLETES at its `@@END`. A malformed or
   * out-of-order frame, an `@@ERROR`, an exit or a timeout is a FAILURE: that observer's tree is killed and the next
   * sample starts a fresh one. A frame that stop() ends is neither a sample nor a failure.
   */
  const framed = opts.ps ? null : (opts.framed ?? (process.platform === "win32" ? windowsObserver() : null));
  interface Observer {
    p: ChildProcess;
    buf: string;
    dead: string | null;
    onLine: ((line: string) => void) | null;
    onExit: ((why: string) => void) | null;
  }
  let observer: Observer | null = null;
  let seq = 0;
  let stopFrame: (() => void) | null = null;
  const startObserver = (cmd: string, args: string[]): Observer => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32", windowsHide: true });
    const o: Observer = { p, buf: "", dead: null, onLine: null, onExit: null };
    p.stdout!.on("data", (d: Buffer) => {
      o.buf += d.toString("utf-8");
      for (let i = o.buf.indexOf("\n"); i >= 0; i = o.buf.indexOf("\n")) {
        const line = o.buf.slice(0, i).replace(/\r$/, "");
        o.buf = o.buf.slice(i + 1);
        o.onLine?.(line);
      }
    });
    const gone = (why: string) => {
      if (o.dead) return;
      o.dead = why;
      o.onExit?.(why);
    };
    p.on("error", (e) => gone(`observer could not spawn (${e.message})`));
    p.on("exit", (code, signal) => gone(`observer exited ${code ?? signal}`));
    p.stdin!.on("error", () => {}); // a write to an observer that just died: its exit is the failure
    return o;
  };
  const framedSample = (cmd: string, args: string[]): Promise<{ out: string } | { failed: string } | { stopped: true }> =>
    new Promise((resolve) => {
      if (!observer || observer.dead) observer = startObserver(cmd, args);
      const o = observer;
      const my = String(++seq);
      const lines: string[] = [];
      let inFrame = false;
      let settled = false;
      const timeoutMs = opts.sampleTimeoutMs ?? 5_000;
      const finish = (r: { out: string } | { failed: string } | { stopped: true }, broken: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        o.onLine = null;
        o.onExit = null;
        stopFrame = null;
        if (broken) {
          killTree(o.p);
          if (observer === o) observer = null;
        }
        resolve(r);
      };
      stopFrame = () => finish({ stopped: true }, true);
      o.onLine = (line) => {
        if (!inFrame) {
          if (line === `@@BEGIN ${my}`) {
            inFrame = true;
            return;
          }
          const err = /^@@ERROR (\S+) (.*)$/.exec(line);
          if (err && err[1] === my) return finish({ failed: sanitizeDiagnostic(`the observer's process query failed: ${err[2]}`) }, true);
          return finish({ failed: sanitizeDiagnostic(`observer frame malformed or out of order (expected @@BEGIN ${my}, got: ${line})`) }, true);
        }
        if (line === `@@END ${my}`) return finish({ out: lines.length ? `${lines.join("\n")}\n` : "" }, false);
        if (line.startsWith("@@")) return finish({ failed: sanitizeDiagnostic(`observer frame malformed or out of order (inside frame ${my}: ${line})`) }, true);
        lines.push(line);
      };
      o.onExit = (why) => finish(done ? { stopped: true } : { failed: sanitizeDiagnostic(why) }, true);
      const timer = setTimeout(() => finish({ failed: `observer timed out after ${timeoutMs} ms (its tree killed)` }, true), timeoutMs);
      if (o.dead) return o.onExit(o.dead);
      o.p.stdin!.write(`${my}\n`);
    });

  const loop = (async () => {
    while (!done) {
      const startedIn = [...holds].filter((h) => h.active); // the holds active when this sample STARTED
      const r = framed ? await framedSample(framed[0], framed[1]) : await sample();
      if ("stopped" in r) {
        break; // ended by stop(): neither a sample nor a failure
      } else if ("failed" in r) {
        failures.push(r.failed);
      } else if (!witnesses(r.out, witness)) {
        blindSamples++; // exit 0, but the target is not in the table: NOT a sample
      } else {
        sampled++;
        if (r.out.includes(secret)) leaked = r.out.split("\n").filter((l) => l.includes(secret)).join("\n");
        // Counted only for holds STILL active at completion (a sample finishing after a release proves nothing).
        const stillHeld = startedIn.filter((h) => h.active);
        if (stillHeld.length > 0) heldSamples++;
        for (const h of stillHeld) if (++h.got >= h.need) h.settle(true);
      }
      if (!done) await new Promise((res) => setTimeout(res, opts.gapMs ?? 20));
    }
  })();

  return {
    get sampled() {
      return sampled;
    },
    get heldSamples() {
      return heldSamples;
    },
    get blindSamples() {
      return blindSamples;
    },
    get leaked() {
      return leaked;
    },
    get failures() {
      return failures;
    },
    waitForSamples(n, deadlineMs) {
      return new Promise<boolean>((resolve) => {
        const h: Hold = { need: n, got: 0, active: true, settle: () => {} };
        const timer = setTimeout(() => h.settle(false), deadlineMs);
        h.settle = (ok) => {
          if (!h.active) return; // settles exactly once
          h.active = false;
          clearTimeout(timer);
          holds.delete(h);
          resolve(ok);
        };
        holds.add(h);
      });
    },
    async stop() {
      done = true;
      for (const h of [...holds]) h.settle(false);
      stopFrame?.();
      const p = inFlight as ChildProcess | null;
      if (p && p.exitCode === null && p.signalCode === null) killGroup(p);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([loop, new Promise((res) => (timer = setTimeout(res, 10_000)))]);
      } finally {
        clearTimeout(timer); // the losing race timer is cancelled
        const o = observer as Observer | null;
        if (o) {
          o.onExit = null;
          killTree(o.p); // the framed observer between frames
          observer = null;
        }
      }
    },
  };
}

export type ArgvVerdict = { kind: "PASS" } | { kind: "FAIL"; why: string } | { kind: "NOT_EVALUATED"; why: string };

/**
 * The run's verdict, BEFORE the leak assertion: FAIL on any failed observation or a missed handshake with a working
 * observer; NOT_EVALUATED when the handshake failed only because the table never witnessed the target (blind samples,
 * no failures); PASS otherwise (then the row asserts the leak).
 *
 * RE-RUN POLICY (the two FAIL kinds stay distinguishable by their messages):
 * - A FAIL here ("failed observations: …" or "the coverage handshake failed …") is a COVERAGE failure, not a code
 *   verdict: a re-run on the SAME SHA is allowed, and it still BLOCKS until a run evaluates.
 * - A FAIL of the LEAK assertion itself (the secret seen on an argv: "no argv held the secret") is a CODE verdict,
 *   FINAL for that SHA: never re-run it away.
 */
export function argvVerdict(handshakes: readonly boolean[], s: Pick<ArgvSampler, "failures" | "blindSamples" | "heldSamples">): ArgvVerdict {
  if (s.failures.length > 0) return { kind: "FAIL", why: `failed observations: ${s.failures.slice(0, 3).join("; ")}` };
  if (handshakes.length === 0 || !handshakes.every(Boolean)) {
    if (s.blindSamples > 0) return { kind: "NOT_EVALUATED", why: `${s.blindSamples} observation(s) did not witness the target (an empty or restricted process table)` };
    return { kind: "FAIL", why: `the coverage handshake failed (${JSON.stringify(handshakes)}; ${s.heldSamples} held samples)` };
  }
  return { kind: "PASS" };
}
