// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The relay CLI's ONE exit discipline (bin/relay's every exit, through bin/_exit-after-flush.mjs, and the signal exit of
 * `relay watch`, through installSignalExit).
 *
 * process.exit() drops whatever stdout/stderr still holds in the process. On a PIPE, Node writes stdout asynchronously
 * (POSIX): the first write fills the kernel pipe buffer and the rest waits in the process, so a bare process.exit() cut
 * piped output at 65,536 bytes (`relay list-instances --json | wc -c` = 65536; the same command to a file wrote 327955).
 *
 * Each stream with queued bytes is drained first (a zero-length write's callback runs after every earlier write is
 * flushed), then the process exits with `code`. A stream whose reader went away (EPIPE) cannot receive more: it counts
 * as finished, and its 'error' is handled here, so it can neither hang the exit nor crash the process before the OTHER
 * stream drains. process.exit is still called (rather than letting the event loop drain) because a caller may leave
 * handles open. The caller must `return` after calling this: it can return before the process exits.
 *
 * `boundMs` bounds the wait: when it elapses, one stderr line says so and the process exits anyway. Without it the
 * wait follows normal pipe semantics (a reader that stays open and never reads blocks the writer).
 */
export function exitAfterFlush(code: number, opts: { boundMs?: number } = {}): void {
  process.exitCode = code;
  const streams = [process.stdout, process.stderr].filter((s) => !s.destroyed && s.writableLength > 0);
  let left = streams.length;
  if (left === 0) process.exit(code);
  if (opts.boundMs !== undefined) {
    const bound = opts.boundMs;
    setTimeout(() => {
      try {
        process.stderr.write(`[relay] exit: output still queued after ${bound} ms (a reader that does not read); exiting anyway, some output is lost.\n`);
      } catch {
        /* stderr itself may be the stuck stream */
      }
      process.exit(code);
    }, bound);
  }
  for (const s of streams) {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (--left === 0) process.exit(code);
    };
    s.once("error", finish);
    s.write("", finish);
  }
}

/** How long a signal exit waits for queued output: a watch that hangs on SIGTERM keeps its lock and blocks the next arm. */
export const SIGNAL_DRAIN_BOUND_MS = 2000;

/**
 * SIGINT/SIGTERM → `stop()`, then a BOUNDED drain-then-exit with code 0 (`relay watch`'s continuous mode). The bound is
 * the hard condition (architect 90188964): if the stdout reader is stuck or gone, the process still exits within
 * SIGNAL_DRAIN_BOUND_MS.
 */
export function installSignalExit(stop: () => void, boundMs: number = SIGNAL_DRAIN_BOUND_MS): void {
  const onSignal = (): void => {
    stop();
    exitAfterFlush(0, { boundMs });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}
