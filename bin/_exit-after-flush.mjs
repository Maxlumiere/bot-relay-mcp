// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * bin/relay's ONE exit point (beside bin/relay, not in dist/: `relay help` works before a build).
 *
 * process.exit() drops whatever stdout/stderr still holds in the process. On a PIPE, Node writes stdout
 * asynchronously (POSIX): the first write fills the kernel pipe buffer and the rest waits in the process, so a bare
 * process.exit() cut every subcommand's piped output at 65,536 bytes (`relay list-instances --json | wc -c` =
 * 65536; the same command to a file wrote 327955), and the reader got a truncated answer with nothing saying so.
 *
 * Here each stream with queued bytes is drained first (a zero-length write's callback runs after every earlier write
 * is flushed), then the process exits with `code`. A reader that went away (EPIPE) cannot receive more: that stream
 * counts as finished, so the exit never hangs on it. process.exit is still called (rather than letting the event loop
 * drain) because a subcommand may leave handles open. The caller must `return` after calling this: it can return
 * before the process exits.
 */
export function exitAfterFlush(code) {
  process.exitCode = code;
  const streams = [process.stdout, process.stderr].filter((s) => !s.destroyed && s.writableLength > 0);
  let left = streams.length;
  if (left === 0) process.exit(code);
  for (const s of streams) {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (--left === 0) process.exit(code);
    };
    s.once("error", finish);
    s.write("", finish);
  }
}
