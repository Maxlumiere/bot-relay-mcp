#!/usr/bin/env bash
#
# flake-load-harness.sh — spawn N CPU stressors, run a command under that load,
# and clean the stressors up SAFELY. Built after an incident (2026-09-01): an
# ad-hoc flake measurement spawned inline `node -e "while(true){…}"` stressors
# whose cleanup depended on the launching process surviving. It did not survive
# (it was orchestrated in the background and orphaned), so across ~7 re-runs
# 168 stressors leaked and ran for TEN HOURS on the dev laptop — load average
# 396 on 12 cores, the relay daemon starved, "is it stuck or slow?" made
# unanswerable. This harness makes that class impossible:
#
#   1. SELF-TERMINATING stressors. Each stressor exits on its own after
#      MAX_SECONDS regardless of what happens to this script — so even a
#      SIGKILL of the harness (which no trap can catch) leaves stressors that
#      die by themselves. Cleanup does NOT depend on the measuring process
#      surviving. This is the load-bearing property; everything else is
#      promptness.
#   2. TRAP cleanup on EVERY normal exit path (EXIT/INT/TERM) kills the
#      stressors immediately by recorded PID + a marker-scoped pkill fallback,
#      so a normal run cleans up in milliseconds, not after MAX_SECONDS.
#   3. COUNT ASSERTION — after spawning, the harness counts the stressors it
#      ACTUALLY started (by unique marker) and aborts if it != the intended N.
#      The incident was a 7x gap (24 intended, 168 actual) that nothing
#      observed; here a mismatch is a hard, immediate failure.
#   4. PRE-FLIGHT — refuses to start if stressors from a PRIOR run are still
#      alive (the cross-run accumulation that turned 24 into 168), naming them.
#
# Usage:
#   scripts/flake-load-harness.sh <N> <MAX_SECONDS> -- <command...>
#   scripts/flake-load-harness.sh --self-test        # spawns 2 for 3s, proves cleanup
#
# Example (measure relay startup under 8x oversubscription on a 12-core box):
#   scripts/flake-load-harness.sh 96 120 -- node scripts/measure-startup.mjs
#
set -uo pipefail

MARKER_PREFIX="flakeload-stressor"
# Per-invocation marker so pgrep/pkill target ONLY this run's stressors.
MARKER="${MARKER_PREFIX}-$$"

stressor_cmd() {
  # Busy-loop that self-terminates after MAX_SECONDS. The marker string is a
  # harmless literal so `pgrep -f`/`pkill -f` can find exactly these processes.
  local secs="$1"
  # NOTE: the marker must be a JS STRING LITERAL (wrapped in quotes in the format
  # string) — not bash %q, which does not quote a plain hyphenated token and
  # yields `const _tag=flake-load-…` → a JS subtraction / ReferenceError. MARKER
  # contains no double-quote, so "%s" is safe.
  printf 'const _tag="%s"; const end=Date.now()+%d*1000; while(Date.now()<end){Math.sqrt(Math.random());}' "$MARKER" "$secs"
}

PIDS=()
cleanup() {
  local p
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  # Fallback: marker-scoped pkill catches any stressor whose PID we lost.
  pkill -f "$MARKER" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ "${1:-}" = "--self-test" ]; then
  N=2; MAX_SECONDS=3; set -- ; CMD=( sleep 1 )
else
  N="${1:?usage: flake-load-harness.sh <N> <MAX_SECONDS> -- <command...>}"
  MAX_SECONDS="${2:?usage: flake-load-harness.sh <N> <MAX_SECONDS> -- <command...>}"
  shift 2
  [ "${1:-}" = "--" ] && shift
  CMD=( "$@" )
  [ "${#CMD[@]}" -gt 0 ] || { echo "flake-load: no command given after --" >&2; exit 2; }
fi

case "$N" in (*[!0-9]*|'') echo "flake-load: N must be a positive integer, got '$N'" >&2; exit 2;; esac
case "$MAX_SECONDS" in (*[!0-9]*|'') echo "flake-load: MAX_SECONDS must be a positive integer, got '$MAX_SECONDS'" >&2; exit 2;; esac

# (4) PRE-FLIGHT: refuse to add load on top of a prior leak.
STALE="$(pgrep -f "$MARKER_PREFIX" 2>/dev/null | wc -l | tr -d ' ')"
if [ "$STALE" -gt 0 ]; then
  echo "flake-load: REFUSING — $STALE stressor(s) from a prior run are still alive (pgrep -f '$MARKER_PREFIX'). Kill them first: pkill -f '$MARKER_PREFIX'" >&2
  exit 1
fi

echo "flake-load: spawning $N self-terminating stressors (max ${MAX_SECONDS}s each), marker=$MARKER" >&2
for _ in $(seq 1 "$N"); do
  node -e "$(stressor_cmd "$MAX_SECONDS")" &
  PIDS+=("$!")
done

# (3) COUNT what actually spawned vs intended.
sleep 1
ACTUAL="$(pgrep -f "$MARKER" 2>/dev/null | wc -l | tr -d ' ')"
if [ "$ACTUAL" -ne "$N" ]; then
  echo "flake-load: FATAL — intended $N stressors, counted $ACTUAL (marker=$MARKER). Aborting + cleaning up." >&2
  exit 1   # trap cleanup fires
fi
echo "flake-load: $N stressors confirmed up; running: ${CMD[*]}" >&2

"${CMD[@]}"
rc=$?

echo "flake-load: command exited rc=$rc; cleaning up $N stressors" >&2
# trap EXIT runs cleanup; exit with the command's code.
exit "$rc"
