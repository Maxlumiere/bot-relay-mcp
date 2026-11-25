// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * An ARGV SAMPLER for "no process's argv ever holds the secret" rows: `ps -axww -o args=` in a loop, recording any
 * line that contains the secret.
 *
 * COVERAGE BY HANDSHAKE, never by timing (the standing rule for observer tests): the process under observation is
 * held alive by the test's own fake server, which calls `waitForSamples(n, deadlineMs)` before it answers. That
 * resolves `true` once n samples have STARTED inside the hold and COMPLETED while it was still held, so each one is a
 * snapshot taken while the request (and the client that sent it) was provably in flight; past the deadline it
 * resolves `false` (the row must assert the handshake: a coverage failure blocks, it never passes).
 * A FAILED observation (ps could not spawn, exited non-zero, or timed out) is never counted as a sample: it is recorded
 * in `failures`, and the row asserts there are none. Every wait is bounded, including `stop()`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

/**
 * Can `ps -axww -o args=` show a process's FULL argv on this machine? A unique marker is put on a child's argv, and the
 * probe asks `ps` for it. Where it cannot (e.g. a ps that rejects `-o args=`, or shows no foreign argv), every row that
 * relies on the sampler would pass VACUOUSLY: such a row must report NOT_EVALUATED, never PASS.
 */
export function argvSamplerProbe(): { visible: boolean; why: string } {
  const marker = `argv-probe-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)", marker], { stdio: "ignore" });
  try {
    for (let i = 0; i < 20; i++) {
      const r = spawnSync("ps", ["-axww", "-o", "args="], { encoding: "utf-8", timeout: 5_000 });
      if (r.error) return { visible: false, why: `ps could not run (${r.error.message})` };
      if (r.status !== 0) return { visible: false, why: `ps -axww -o args= exited ${r.status}: ${(r.stderr ?? "").trim().slice(0, 120)}` };
      if ((r.stdout ?? "").includes(marker)) return { visible: true, why: "ps -axww -o args= shows a child's full argv" };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // the child may not be listed yet
    }
    return { visible: false, why: "ps -axww -o args= ran but never listed a child's argv marker" };
  } finally {
    child.kill("SIGKILL");
  }
}

export interface ArgvSampler {
  /** Every SUCCESSFUL sample. */
  readonly sampled: number;
  /** Successful samples that started inside a hold and completed while that hold was still active. */
  readonly heldSamples: number;
  /** The `ps` lines that held the secret ("" when none did). */
  readonly leaked: string;
  /** Every FAILED observation (never counted as a sample). */
  readonly failures: readonly string[];
  /** true once `n` held samples completed inside this hold; false past `deadlineMs`. Settles exactly once. */
  waitForSamples(n: number, deadlineMs: number): Promise<boolean>;
  /** Stops the loop; kills and reaps a sample in flight. Bounded. */
  stop(): Promise<void>;
}

interface Hold {
  need: number;
  got: number;
  active: boolean;
  settle: (ok: boolean) => void;
}

/** `opts.ps` replaces the observer command (tests of the sampler itself: a failing, slow or stuck observer). */
export function startArgvSampler(secret: string, opts: { gapMs?: number; sampleTimeoutMs?: number; ps?: [string, string[]] } = {}): ArgvSampler {
  let sampled = 0;
  let heldSamples = 0;
  let leaked = "";
  const failures: string[] = [];
  let done = false;
  let inFlight: ChildProcess | null = null;
  const holds = new Set<Hold>();

  /** One `ps` run, bounded; resolves its stdout, or a failure reason. */
  const sample = (): Promise<{ out: string } | { failed: string }> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (r: { out: string } | { failed: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        inFlight = null;
        resolve(r);
      };
      const [cmd, args] = opts.ps ?? ["ps", ["-axww", "-o", "args="]];
      const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
      inFlight = p;
      let o = "";
      p.stdout!.on("data", (d: Buffer) => (o += d));
      p.on("error", (e) => finish({ failed: `ps could not spawn (${e.message})` }));
      p.on("close", (code, signal) => finish(code === 0 ? { out: o } : { failed: `ps exited ${code ?? signal}` }));
      const timer = setTimeout(() => {
        p.kill("SIGKILL");
        finish({ failed: `ps timed out after ${opts.sampleTimeoutMs ?? 5_000} ms` });
      }, opts.sampleTimeoutMs ?? 5_000);
    });

  const loop = (async () => {
    while (!done) {
      const startedIn = [...holds].filter((h) => h.active); // the holds active when this sample STARTED
      const r = await sample();
      if ("failed" in r) {
        failures.push(r.failed);
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
      const p = inFlight as ChildProcess | null;
      if (p && p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
      await Promise.race([loop, new Promise((res) => setTimeout(res, 10_000))]);
    },
  };
}
