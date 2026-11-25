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
 * resolves once n samples have STARTED after the call (and finished), so each one is a snapshot taken while the
 * request (and the client that sent it) was provably in flight; it REJECTS past the deadline (a coverage failure
 * blocks, it never passes). `heldSamples` counts those samples, and a row asserts it against its bar.
 */
import { spawn } from "node:child_process";

export interface ArgvSampler {
  /** Every completed sample. */
  readonly sampled: number;
  /** Completed samples that STARTED inside a `waitForSamples` hold. */
  readonly heldSamples: number;
  /** The `ps` lines that held the secret ("" when none did). */
  readonly leaked: string;
  /** Resolves once `n` samples have started after this call and finished; rejects past `deadlineMs`. */
  waitForSamples(n: number, deadlineMs: number): Promise<void>;
  /** Stops the loop and waits for the sample in flight. */
  stop(): Promise<void>;
}

export function startArgvSampler(secret: string, opts: { gapMs?: number } = {}): ArgvSampler {
  let sampled = 0;
  let heldSamples = 0;
  let leaked = "";
  let done = false;
  let holds = 0; // active waitForSamples calls
  const waiters: { need: number; got: number; resolve: () => void }[] = [];
  const loop = (async () => {
    while (!done) {
      const startedInHold = holds > 0;
      const startedFor = waiters.slice(); // only the waiters already waiting when this sample STARTED
      const out = await new Promise<string>((resolve) => {
        const p = spawn("ps", ["-axww", "-o", "args="], { stdio: ["ignore", "pipe", "ignore"] });
        let o = "";
        p.stdout.on("data", (d: Buffer) => (o += d));
        p.on("close", () => resolve(o));
        p.on("error", () => resolve(""));
      });
      sampled++;
      if (startedInHold) heldSamples++;
      if (out.includes(secret)) leaked = out.split("\n").filter((l) => l.includes(secret)).join("\n");
      for (const w of startedFor) if (++w.got >= w.need) w.resolve();
      await new Promise((r) => setTimeout(r, opts.gapMs ?? 20));
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
    waitForSamples(n, deadlineMs) {
      holds++;
      return new Promise<void>((resolve, reject) => {
        const w = { need: n, got: 0, resolve: () => {} };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          holds--;
          reject(new Error(`argv sampler: ${w.got} of ${n} samples within ${deadlineMs} ms: coverage NOT guaranteed`));
        }, deadlineMs);
        w.resolve = () => {
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(w), 1);
          holds--;
          resolve();
        };
        waiters.push(w);
      });
    },
    async stop() {
      done = true;
      await loop;
    },
  };
}
