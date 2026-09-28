#!/bin/bash
# bot-relay-mcp — ADR-0048 DEPLOY GATE (one step).
#
# Run this with the NEW build BEFORE restarting the daemon onto it. It proves the
# NEW instance resolver, run under the RUNNING daemon's own environment, names the
# SAME relay DB that daemon has open. If it does not, restarting would silently
# move the daemon to a different mailbox: the gate says FAIL and exits 1.
#
# usage: scripts/adr0048-deploy-gate.sh [--port 3777] [--pid PID]
#   --port N  find the daemon listening on this port (default 3777; needs lsof)
#   --pid P   use this daemon pid directly
# Reads: the daemon's open files (/proc/PID/fd on Linux, lsof elsewhere) and its
# environment (/proc/PID/environ on Linux, `ps -E` on macOS; same user only).
# Only the variables the resolver reads are passed on: HOME, RELAY_HOME,
# RELAY_DB_PATH, RELAY_INSTANCE_ID, RELAY_ALLOW_LEGACY_FALLBACK.
set -u

PORT=3777
PID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --pid) PID="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "deploy-gate: unknown argument: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "DEPLOY GATE: FAIL — $1" >&2; exit 1; }

RELAY_BIN="$(cd "$(dirname "$0")/.." && pwd)/bin/relay"
[ -f "$RELAY_BIN" ] || fail "no relay CLI at $RELAY_BIN"

if [ -z "$PID" ]; then
  command -v lsof >/dev/null 2>&1 || fail "lsof is needed to find the daemon on port $PORT (or pass --pid)"
  PID=$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1)
  [ -n "$PID" ] || fail "no daemon is listening on port $PORT"
fi
case "$PID" in ''|*[!0-9]*) fail "invalid pid: $PID" ;; esac
kill -0 "$PID" 2>/dev/null || fail "pid $PID is not a running process this user can inspect"

# The DB the daemon HAS OPEN (the fact the gate compares against).
OPEN_DB=""
if [ -d "/proc/$PID/fd" ]; then
  for fd in /proc/"$PID"/fd/*; do
    t=$(readlink "$fd" 2>/dev/null) || continue
    case "$t" in */relay.db) OPEN_DB="$t"; break ;; esac
  done
else
  command -v lsof >/dev/null 2>&1 || fail "lsof is needed to read the daemon's open files"
  OPEN_DB=$(lsof -nP -p "$PID" -Fn 2>/dev/null | sed -n 's/^n//p' | grep -E '/relay\.db$' | head -n 1)
fi
[ -n "$OPEN_DB" ] || fail "daemon pid $PID has no relay.db open"

# The daemon's OWN environment, reduced to what the resolver reads.
DAEMON_ENV=$(
  if [ -r "/proc/$PID/environ" ]; then
    tr '\0' '\n' < "/proc/$PID/environ"
  else
    ps -wwE -p "$PID" -o command= 2>/dev/null | python3 -c '
import re, sys
line = sys.stdin.read().rstrip("\n")
# `ps -E` appends NAME=value pairs after the command. Split before each NAME=.
for part in re.split(r" (?=[A-Za-z_][A-Za-z0-9_]*=)", line)[1:]:
    print(part)'
  fi | grep -E '^(HOME|RELAY_HOME|RELAY_DB_PATH|RELAY_INSTANCE_ID|RELAY_ALLOW_LEGACY_FALLBACK)='
)
ENV_ARGS=("PATH=$PATH")
while IFS= read -r kv; do
  [ -n "$kv" ] && ENV_ARGS+=("$kv")
done <<< "$DAEMON_ENV"
printf '%s\n' "${ENV_ARGS[@]}" | grep -q '^HOME=' || fail "could not read HOME from the daemon's environment (pid $PID)"

echo "DEPLOY GATE: daemon pid $PID has open: $OPEN_DB"
echo "DEPLOY GATE: its resolver environment:"
printf '  %s\n' "${ENV_ARGS[@]:1}"
OUT=$(env -i "${ENV_ARGS[@]}" node "$RELAY_BIN" where --json --expect-db "$OPEN_DB" 2>&1)
RC=$?
echo "$OUT"
if [ "$RC" -eq 0 ]; then
  echo "DEPLOY GATE: PASS — the new resolver names the SAME DB the running daemon holds."
  exit 0
fi
fail "the new resolver does NOT name the DB the running daemon holds (see above). Do NOT restart."
