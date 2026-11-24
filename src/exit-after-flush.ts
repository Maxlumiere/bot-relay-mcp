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
/**
 * The process-wide TERMINATING state (ruling c07c9674, Codex #443 R2 P2-a). The FIRST SIGINT/SIGTERM sets it; from
 * then on EVERY exitAfterFlush is bounded by SIGNAL_DRAIN_BOUND_MS, whichever path exits (the continuous watch's own
 * handler, or `--until-wake` returning its code to bin/relay). A normal, non-signal exit keeps plain pipe semantics
 * (`relay x | less` waits for the reader).
 */
let terminating = false;
let marking = false;

/** Whether a SIGINT/SIGTERM has been received (only once markTerminatingOnSignals() is installed). */
export function isTerminating(): boolean {
  return terminating;
}

/**
 * Install the PERSISTENT, idempotent SIGINT/SIGTERM listeners that set the terminating state. Persistent (`on`, never
 * `once`): once another listener has taken a signal, a second signal during the drain is ABSORBED, the bound still
 * governs, and the exit status stays the code the path chose (SIGKILL is the escape). When NO other listener handles a
 * signal (a phase that is not listening yet), it is re-raised, so Node's default "terminate by the signal" applies
 * exactly as before: a signal no code acts on is never swallowed.
 */
export function markTerminatingOnSignals(): void {
  if (marking) return;
  marking = true;
  const mark = (sig: NodeJS.Signals): void => {
    if (terminating) return; // a later signal, during the drain: absorbed; the bound governs
    if (process.listenerCount(sig) > 1) {
      terminating = true; // another listener (the watch's phase handler) takes this signal: its exit is bounded
      return;
    }
    // NOTHING else handles it (e.g. --until-wake still setting up): Node's default, terminate by the signal, exactly
    // as without this listener. Never swallow a signal no code acts on.
    process.removeListener("SIGINT", mark);
    process.removeListener("SIGTERM", mark);
    process.kill(process.pid, sig);
  };
  process.on("SIGINT", mark);
  process.on("SIGTERM", mark);
}

/** How long a signal exit waits for queued output: a watch that hangs on SIGTERM keeps its lock and blocks the next arm. */
export const SIGNAL_DRAIN_BOUND_MS = 2000;

/** Exit with `code` after `boundMs` regardless; one stderr line, unless stderr ITSELF still has queued bytes. */
function armBound(code: number, boundMs: number): void {
  setTimeout(() => {
    if (process.stderr.writableLength === 0) {
      try {
        process.stderr.write(`[relay] exit: output still queued after ${boundMs} ms (a reader that does not read); exiting anyway, some output is lost.\n`);
      } catch {
        /* nothing more to do */
      }
    }
    process.exit(code);
  }, boundMs);
}

export function exitAfterFlush(code: number, opts: { boundMs?: number } = {}): void {
  process.exitCode = code;
  const boundMs = opts.boundMs ?? (terminating ? SIGNAL_DRAIN_BOUND_MS : undefined);
  const streams = [process.stdout, process.stderr].filter((s) => !s.destroyed && s.writableLength > 0);
  let left = streams.length;
  if (left === 0) process.exit(code);
  if (boundMs !== undefined) armBound(code, boundMs);
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

/**
 * SIGINT/SIGTERM → a BOUNDED drain-then-exit with code 0 (`relay watch`'s continuous mode). The bound is ARMED FIRST,
 * then `stop()` runs at most once, inside try/catch (a throw becomes one stderr line and the exit continues with code
 * 0). A second signal is absorbed. ACCEPTED BOUNDARY: a SYNCHRONOUS stall inside stop() (the local SQLite close) cannot
 * be bounded by a JS timer; SIGKILL is the escape.
 */
export function installSignalExit(stop: () => void, boundMs: number = SIGNAL_DRAIN_BOUND_MS): void {
  markTerminatingOnSignals();
  let fired = false;
  const onSignal = (): void => {
    if (fired) return;
    fired = true;
    armBound(0, boundMs);
    try {
      stop();
    } catch (err) {
      try {
        process.stderr.write(`[relay] exit: cleanup failed (${err instanceof Error ? err.message : String(err)}); exiting anyway.\n`);
      } catch {
        /* nothing more to do */
      }
    }
    exitAfterFlush(0, { boundMs });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}
