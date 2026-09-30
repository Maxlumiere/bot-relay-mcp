# bot-relay-mcp v2.6.1 — bash mirror of TS path resolution + token vault.
#
# Single source of truth for hook bash helpers. Sourced by
# hooks/check-relay.sh, hooks/post-tool-use-check.sh, hooks/stop-check.sh,
# and scripts/migrate-existing-tokens-to-vault.sh. Tested directly via
# `bash -c "source <this-file>; ..."` in tests/v2-6-1-token-store.test.ts
# so any drift between this file and the TS implementation surfaces as a
# real test failure (not a silent inline-copy hide-out — the test path
# must match the shipped path).
#
# The relay DB path is NOT derived here (ADR-0048): it is the ONE resolver's
# answer (src/instance.ts resolveInstance), asked through `relay where --fields`
# (relay_where_load) or taken from what `relay pending --json` reported
# (relay_res_set_db). resolve_relay_db_path is a shim over that answer.
#
# Mirrors:
#   - src/token-store.ts:resolveAgentVaultDir +
#     FileTokenStore.{pathFor,read,write}            → resolve_relay_token_path
#                                                       read_relay_token_from_vault
#                                                       write_relay_token_to_vault
#
# Token shape regex matches src/token-store.ts:62 (TOKEN_SHAPE_RE) and
# bin/spawn-agent.sh's legacy isValidTokenShape allowlist.
#
# This file MUST NOT execute any top-level commands or rely on `set -e` —
# callers source it from many contexts (hooks running under Claude Code's
# event loop, the migration script, vitest test bash). Functions only.

# Whole-string match. `echo "$X" | grep -Eq '^RE$'` is LINE-oriented: a
# multi-line value passes if ANY line matches, and the rest rides along into
# whatever the value is used for (Codex round 2 on #280: a newline in
# RELAY_AGENT_NAME reached a sqlite heredoc as SQL). [[ =~ ]] anchors to the
# whole string.
relay_whole_match() { [[ "$1" =~ $2 ]]; }

# relay_helpers_cli — the relay CLI beside these hooks (hooks/../bin/relay). A
# function, not a top-level assignment: this file runs no top-level commands.
# Inside a function, BASH_SOURCE[0] is the file that defines it (this one).
relay_helpers_cli() {
  printf '%s/bin/relay' "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)"
}

# relay_where_load [CLI] — ask the ONE resolver, ONCE, through `relay where
# --fields`, and hold its answer in exported RELAY_RES_* variables (so every
# later $(...) subshell reuses it instead of starting node again):
#   RELAY_RES_KIND     explicit-db | instance | flat | error
#   RELAY_RES_DB_PATH  the DB path (empty on error)
#   RELAY_RES_EXISTS   true | false (empty on error)
#   RELAY_RES_REASON   why, on error
#   RELAY_RES_WARNING  the flat-fallback warning (RELAY_ALLOW_LEGACY_FALLBACK=1)
# Returns 0 when the resolver answered (the answer may be the error kind); 1
# when it could not be asked (no node, no CLI, no time left, a timeout, no
# answer), which is also recorded as the error kind with the reason. A path is
# exposed ONLY from a SUCCESSFUL, COMPLETE answer: exit 0, all six lines, a known
# kind, a DB path, `exists` true or false (an error answer must exit 1 with its
# reason); anything else (a failed or truncated run) is the error kind. The read
# is bounded by what is left of the hook's budget before the mail read
# (relay_premail_secs), or by an explicit cap in seconds as the 2nd argument.
relay_where_load() {
  local cli="${1:-$(relay_helpers_cli)}" cap="${2:-}" secs outf errf rc k="" d="" e="" why="" warn="" nlines=0
  export RELAY_RES_LOADED=1 RELAY_RES_KIND=error RELAY_RES_DB_PATH="" RELAY_RES_EXISTS="" RELAY_RES_REASON="" RELAY_RES_WARNING=""
  if ! command -v node >/dev/null 2>&1; then
    export RELAY_RES_REASON="node not found (the relay CLI runs on node)"
    return 1
  fi
  if [ ! -f "$cli" ]; then
    export RELAY_RES_REASON="no relay CLI beside this hook ($cli)"
    return 1
  fi
  # An explicit cap (PostToolUse/Stop, AFTER their mail read) replaces the
  # pre-mail budget; SessionStart asks BEFORE its mail read, so the default
  # reserves the mail read's time.
  case "$cap" in ''|*[!0-9]*) secs=$(relay_premail_secs) ;; *) secs="$cap" ;; esac
  if [ "$secs" -lt 1 ]; then
    export RELAY_RES_REASON="no time budget left to ask the resolver"
    return 1
  fi
  outf="$(mktemp 2>/dev/null || printf '')"
  errf="$(mktemp 2>/dev/null || printf '')"
  if [ -z "$outf" ] || [ -z "$errf" ]; then
    rm -f "$outf" "$errf" 2>/dev/null
    export RELAY_RES_REASON="could not create a private temp file to ask the resolver"
    return 1
  fi
  relay_run_pending "$secs" "$outf" "$errf" node "$cli" where --fields
  rc=$?
  { IFS= read -r k; IFS= read -r d; IFS= read -r e; IFS= read -r why; IFS= read -r warn; } < "$outf"
  nlines=$(wc -l < "$outf" 2>/dev/null | tr -d ' ')
  rm -f "$outf" "$errf" "$outf.timedout" 2>/dev/null
  if [ "$rc" -eq 124 ]; then
    export RELAY_RES_REASON="relay where timed out after ${secs}s"
    return 1
  fi
  if [ "${nlines:-0}" != 6 ]; then
    export RELAY_RES_REASON="relay where gave an incomplete answer (exit $rc, ${nlines:-0} of 6 lines)"
    return 1
  fi
  case "$k" in
    explicit-db|instance|flat)
      if [ "$rc" -ne 0 ] || [ -z "$d" ] || { [ "$e" != true ] && [ "$e" != false ]; }; then
        export RELAY_RES_REASON="relay where gave an invalid path answer (exit $rc)"
        return 1
      fi
      export RELAY_RES_KIND="$k" RELAY_RES_DB_PATH="$d" RELAY_RES_EXISTS="$e" RELAY_RES_WARNING="$warn"
      return 0
      ;;
    error)
      if [ "$rc" -ne 1 ]; then
        export RELAY_RES_REASON="relay where reported an error but exited $rc"
        return 1
      fi
      export RELAY_RES_REASON="${why:-the resolver reported an error without a reason}"
      return 0
      ;;
  esac
  export RELAY_RES_REASON="relay where gave no valid answer (exit $rc)"
  return 1
}

# relay_res_set_db PATH — the resolver's DB path as `relay pending --json`
# reported it (its embedded resolution): no second node start for the same fact.
relay_res_set_db() {
  export RELAY_RES_LOADED=1 RELAY_RES_KIND=reported RELAY_RES_DB_PATH="$1" RELAY_RES_EXISTS=true RELAY_RES_REASON="" RELAY_RES_WARNING=""
}

# relay_pending_resolution_db JSON — the DB path of the resolution a `relay
# pending --json` answer EMBEDS, echoed with return 0, ONLY when that resolution
# is valid: kind explicit-db | instance | flat, db_path a non-empty one-line
# string, exists a boolean. A missing or malformed resolution, the error kind or
# an unknown kind → return 1: an exit-0 answer without a valid resolution is not
# a trustworthy read (the caller reports DEGRADED and reads nothing through it).
# PostToolUse and Stop only (python3, which those hooks already require).
relay_pending_resolution_db() {
  command -v python3 >/dev/null 2>&1 || return 1
  printf '%s' "$1" | python3 -c '
import json, sys
try:
    r = json.load(sys.stdin).get("resolution")
except Exception:
    sys.exit(1)
if not isinstance(r, dict) or r.get("kind") not in ("explicit-db", "instance", "flat"):
    sys.exit(1)
p, e = r.get("db_path"), r.get("exists")
if not isinstance(p, str) or not p or "\n" in p or "\r" in p or not isinstance(e, bool):
    sys.exit(1)
sys.stdout.write(p)' 2>/dev/null
}

# resolve_relay_db_path — echo the resolver's DB path on stdout and return 0; on
# a resolver error (or when the resolver could not be asked), echo nothing, name
# the reason on stderr, return 1. Never a bash re-derivation: it asks
# relay_where_load when nothing has been loaded yet.
resolve_relay_db_path() {
  [ "${RELAY_RES_LOADED:-}" = 1 ] || relay_where_load || true
  if [ "${RELAY_RES_KIND:-error}" = error ] || [ -z "${RELAY_RES_DB_PATH:-}" ]; then
    echo "[bot-relay hook] instance resolution failed: ${RELAY_RES_REASON:-unknown}" >&2
    return 1
  fi
  echo "$RELAY_RES_DB_PATH"
  return 0
}

# resolve_relay_token_path <name> — echo absolute vault file path on
# stdout. Returns 0 on success; on bad name, stderr + return 1.
resolve_relay_token_path() {
  local name="$1"
  if ! relay_whole_match "$name" '^[A-Za-z0-9_.-]{1,64}$'; then
    echo "[bot-relay hook] invalid agent name \"$name\" for vault path (mirrors AGENT_NAME_RE in src/token-store.ts)" >&2
    return 1
  fi
  local db_path
  db_path=$(resolve_relay_db_path) || return 1
  echo "$(dirname "$db_path")/agents/${name}.token"
  return 0
}

# read_relay_token_from_vault <name> — echo token to stdout on success
# (return 0); on miss / malformed / unreadable, no output + return 1.
# Never throws on IO error — every failure is a clean cache miss for the
# caller to fall through.
read_relay_token_from_vault() {
  local name="$1"
  local token_path
  token_path=$(resolve_relay_token_path "$name") || return 1
  if [ ! -f "$token_path" ]; then
    return 1
  fi
  local token
  token=$(head -n 1 "$token_path" 2>/dev/null | tr -d '[:space:]')
  if [ -z "$token" ]; then
    return 1
  fi
  if ! relay_whole_match "$token" '^[A-Za-z0-9_=.-]{8,128}$'; then
    return 1
  fi
  echo "$token"
  return 0
}

# v2.7.2 — spawn-manifest helpers. The manifest is a defense-in-depth marker
# the spawn pipeline drops next to the per-instance vault so the SessionStart
# hook can recover identity if the typed-env transport (osascript write text
# → child shell → claude → hook subprocess) drops RELAY_AGENT_NAME between
# the parent script and the hook. The failure mode it guards against: the
# hook silently defaults to "default" on unset env, so mail dead-letters
# under the wrong agent.
#
# Format: key=value lines, ASCII only, terminated with \n. Atomic tmp+rename.
# Owner-only readable (0600) since the role + spawn_pid leak metadata about
# the operator's terminal layout.

# resolve_relay_spawn_manifest_path <name> — echo absolute manifest file
# path on stdout. Mirrors resolve_relay_token_path with .spawn-manifest
# suffix instead of .token. Returns 0 on success; bad name → stderr +
# return 1.
resolve_relay_spawn_manifest_path() {
  local name="$1"
  if ! relay_whole_match "$name" '^[A-Za-z0-9_.-]{1,64}$'; then
    echo "[bot-relay hook] invalid agent name \"$name\" for manifest path" >&2
    return 1
  fi
  local db_path
  db_path=$(resolve_relay_db_path) || return 1
  echo "$(dirname "$db_path")/agents/${name}.spawn-manifest"
  return 0
}

# write_relay_spawn_manifest <name> <role> — atomic key=value write at the
# resolved manifest path. Returns 0 on success; bad input / IO failure →
# stderr + return 1. Manifest carries name + role + spawn_pid + ISO8601
# timestamp. The role allowlist matches validate_token in bin/spawn-agent.sh
# so a manifest can never be persisted with metadata that the hook would
# later refuse to use.
write_relay_spawn_manifest() {
  local name="$1"
  local role="$2"
  if ! relay_whole_match "$name" '^[A-Za-z0-9_.-]{1,64}$'; then
    echo "[bot-relay hook] refusing to write manifest with malformed name \"$name\"" >&2
    return 1
  fi
  if ! relay_whole_match "$role" '^[A-Za-z0-9_.-]{1,64}$'; then
    echo "[bot-relay hook] refusing to write manifest with malformed role \"$role\"" >&2
    return 1
  fi
  local manifest_path
  manifest_path=$(resolve_relay_spawn_manifest_path "$name") || return 1
  local dir
  dir=$(dirname "$manifest_path")
  mkdir -p "$dir" 2>/dev/null || true
  chmod 0700 "$dir" 2>/dev/null || true
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local tmp="${manifest_path}.tmp.$$"
  {
    umask 0177
    printf 'name=%s\nrole=%s\nspawn_pid=%s\nspawned_at=%s\n' \
      "$name" "$role" "$$" "$now" > "$tmp"
  } || return 1
  chmod 0600 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$manifest_path" || {
    rm -f "$tmp" 2>/dev/null
    return 1
  }
  return 0
}

# find_fresh_relay_spawn_manifest [max_age_seconds] — scan the per-instance
# agents/ dir for *.spawn-manifest files modified within max_age_seconds
# (default 60). Returns 0 + echoes a single line `name=<n>;role=<r>` ONLY
# when exactly one fresh manifest exists. Returns 1 (no output) when:
#   - dir doesn't exist
#   - no fresh manifests
#   - MORE than one fresh manifest (ambiguous — caller must NOT guess)
#   - manifest file content malformed (defense against partial writes)
# The ambiguity-rejection branch is load-bearing: two concurrent spawns
# within the freshness window would otherwise let the hook pick the wrong
# identity. Better to fall through to "default" + loud warning.
#
# mtime granularity is real seconds (not rounded to minutes — `find -mmin`
# was tried and rejected, it can't distinguish 30s from 90s when the
# window is 60s). Uses stat(1) with cross-platform fallback: `-f %m` on
# macOS/BSD, `-c %Y` on GNU/Linux. If neither flag works (exotic stat),
# the manifest is skipped — safer to fall through than to mis-recover.
find_fresh_relay_spawn_manifest() {
  local max_age_seconds="${1:-60}"
  local db_path
  db_path=$(resolve_relay_db_path) || return 1
  local agents_dir
  agents_dir="$(dirname "$db_path")/agents"
  if [ ! -d "$agents_dir" ]; then
    return 1
  fi
  local now
  now=$(date +%s)
  local candidates=""
  local f mtime age
  # `nullglob` is bash-specific and not portable — guard the glob with a
  # check that the candidate is a regular file so the literal glob pattern
  # falls through cleanly when no matches exist.
  for f in "$agents_dir"/*.spawn-manifest; do
    [ -f "$f" ] || continue
    if mtime=$(stat -f %m "$f" 2>/dev/null) && [ -n "$mtime" ]; then :
    elif mtime=$(stat -c %Y "$f" 2>/dev/null) && [ -n "$mtime" ]; then :
    else
      continue
    fi
    age=$((now - mtime))
    if [ "$age" -ge 0 ] && [ "$age" -le "$max_age_seconds" ]; then
      candidates="$candidates$f
"
    fi
  done
  # Trim trailing newline; bail on empty.
  candidates=$(printf '%s' "$candidates" | sed '/^$/d')
  if [ -z "$candidates" ]; then
    return 1
  fi
  local count
  count=$(printf '%s\n' "$candidates" | grep -c .)
  if [ "$count" -ne 1 ]; then
    return 1
  fi
  # Validate filename + read+parse content
  local fname mname mrole
  fname=$(basename "$candidates" .spawn-manifest)
  if ! relay_whole_match "$fname" '^[A-Za-z0-9_.-]{1,64}$'; then
    return 1
  fi
  mname=$(grep -E '^name=' "$candidates" | head -n 1 | sed -E 's/^name=//')
  mrole=$(grep -E '^role=' "$candidates" | head -n 1 | sed -E 's/^role=//')
  # Filename + content name must agree — defends against a manifest file
  # that was renamed under us, and against partial writes that left the
  # name= line missing.
  if [ "$mname" != "$fname" ]; then
    return 1
  fi
  if ! relay_whole_match "$mname" '^[A-Za-z0-9_.-]{1,64}$'; then
    return 1
  fi
  if ! relay_whole_match "$mrole" '^[A-Za-z0-9_.-]{1,64}$'; then
    return 1
  fi
  printf 'name=%s;role=%s\n' "$mname" "$mrole"
  return 0
}

# count_fresh_relay_spawn_manifests [max_age_seconds] — echo the count of
# *.spawn-manifest files in the per-instance agents/ dir whose mtime is
# within max_age_seconds (default 60) on stdout. Always exits 0; on missing
# dir / no candidates echoes "0".
#
# v2.7.2 R1 — exposed as a sibling to find_fresh_relay_spawn_manifest so
# the hook can distinguish:
#   - 0 fresh manifests → silent (normal manual terminal, no spawn in
#     flight)
#   - 1 fresh manifest  → silent recovery (handled by find_fresh_*)
#   - >1 fresh manifest → LOUD stderr warning, fall through to "default"
# The shipped comments + CHANGELOG entry already promised loud-on-
# ambiguity behavior; a Codex R0 audit caught that the
# warning was missing. This helper is the instrumentation handle.
#
# Uses the same stat-second precision as find_fresh_relay_spawn_manifest
# so the count and the find agree on which files are "fresh".
count_fresh_relay_spawn_manifests() {
  local max_age_seconds="${1:-60}"
  local db_path
  db_path=$(resolve_relay_db_path) || { echo 0; return 0; }
  local agents_dir
  agents_dir="$(dirname "$db_path")/agents"
  if [ ! -d "$agents_dir" ]; then
    echo 0
    return 0
  fi
  local now
  now=$(date +%s)
  local count=0
  local f mtime age
  for f in "$agents_dir"/*.spawn-manifest; do
    [ -f "$f" ] || continue
    if mtime=$(stat -f %m "$f" 2>/dev/null) && [ -n "$mtime" ]; then :
    elif mtime=$(stat -c %Y "$f" 2>/dev/null) && [ -n "$mtime" ]; then :
    else
      continue
    fi
    age=$((now - mtime))
    if [ "$age" -ge 0 ] && [ "$age" -le "$max_age_seconds" ]; then
      count=$((count + 1))
    fi
  done
  echo "$count"
  return 0
}

# delete_relay_spawn_manifest <name> — best-effort removal. Returns 0
# whether or not the file existed. Used by the hook after successful
# identity recovery so a stale manifest can't be re-used by a later
# unintended terminal.
delete_relay_spawn_manifest() {
  local name="$1"
  local manifest_path
  manifest_path=$(resolve_relay_spawn_manifest_path "$name") || return 0
  rm -f "$manifest_path" 2>/dev/null || true
  return 0
}

# write_relay_token_to_vault <name> <token> — atomic tmp+rename, chmod
# 0o600. Returns 0 on success; on bad shape / IO failure, stderr + return 1.
write_relay_token_to_vault() {
  local name="$1"
  local token="$2"
  if ! relay_whole_match "$token" '^[A-Za-z0-9_=.-]{8,128}$'; then
    echo "[bot-relay hook] refusing to write malformed token to vault for \"$name\"" >&2
    return 1
  fi
  local token_path
  token_path=$(resolve_relay_token_path "$name") || return 1
  local dir
  dir=$(dirname "$token_path")
  mkdir -p "$dir" 2>/dev/null || true
  chmod 0700 "$dir" 2>/dev/null || true   # POSIX; no-op on Windows
  # Atomic write: tmp file in same dir, chmod, rename.
  local tmp="${token_path}.tmp.$$"
  {
    umask 0177  # restrict file to 0600 even before chmod
    printf '%s\n' "$token" > "$tmp"
  } || return 1
  chmod 0600 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$token_path" || {
    rm -f "$tmp" 2>/dev/null
    return 1
  }
  return 0
}

# --- v2.15.0: agent-process identity helpers (shared by check-relay.sh,
# codex/codex-session-start.sh, and post-tool-use-check.sh) ---------------

# Find the AGENT's OWN process PID (the claude/codex CLI) in this hook's
# ancestry, for presence liveness. Unlike relay_pid_chain (shell/terminal
# ancestors that OUTLIVE the agent — only good for Tether binding), this
# returns the process that dies exactly when the agent exits, so the relay can
# probe it. Matches on the executable's COMM (basename, NO path) — critical
# because the repo can live under a "Claude"-named dir, so an argv/path match
# would false-hit any process launched from there (incl. the hook itself).
# Node/bun/deno-hosted CLIs report comm=node/bun/deno; in this ancestry the
# only such runtime IS the agent (the relay's own node is excluded by its
# dist/index.js entrypoint). Starts from the hook's PARENT (the hook is never
# the agent). Extensible via RELAY_AGENT_PROCESS_PATTERN. Empty → agent_pid
# omitted → age-based fallback (graceful). POSIX only (Windows omit).
relay_agent_pid() {
  local pid ppid comm args depth=0 pat
  pat='claude|codex|node|bun|deno'
  [ -n "${RELAY_AGENT_PROCESS_PATTERN:-}" ] && pat="${pat}|${RELAY_AGENT_PROCESS_PATTERN}"
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) return ;;
  esac
  pid=$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' ')
  while [ "${pid:-0}" -gt 1 ] 2>/dev/null && [ "$depth" -lt 64 ]; do
    comm=$(ps -o comm= -p "$pid" 2>/dev/null); comm="${comm##*/}"
    if printf '%s' "$comm" | grep -qiE "^(${pat})$"; then
      args=$(ps -o args= -p "$pid" 2>/dev/null)
      case "$args" in *dist/index.js*) ;; *) printf '%s' "$pid"; return ;; esac
    fi
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    case "$ppid" in ''|*[!0-9]*) break ;; esac
    [ "$ppid" -le 1 ] && break
    pid="$ppid"; depth=$((depth+1))
  done
}

# Start-time token for a PID (the relay's PID-reuse guard). LC_ALL=C so the
# format is DETERMINISTIC + byte-identical to the daemon's probe (src/liveness.ts
# also pins LC_ALL=C) — a locale difference between this user shell and the
# launchd daemon would otherwise make a live agent read dead. Trimmed. Empty on
# any failure.
relay_pid_start() {
  local pid="$1"
  [ -n "$pid" ] || return
  LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

# Is PID a live process on THIS host? The signal-0 probe, mirroring src/liveness.ts
# isPidAlive() EXACTLY so the bash gate and the TS gate never disagree:
#   - signalable            → alive (0)
#   - EPERM (cross-user)    → alive — the process EXISTS, it just isn't ours
#   - ESRCH / anything else → dead (1)
#   - non-integer / non-positive pid → dead (1)
# The EPERM branch is not academic: without it a cross-user process at the
# recorded PID reads DEAD here while isPidAlive reads ALIVE — the exact TS/bash
# split that turns the diagnostic→release-binding handoff into a deadlock. Bare
# `kill -0` returns failure for BOTH EPERM and ESRCH, so we re-probe and inspect
# the strerror text; LC_ALL=C pins it to "Operation not permitted" (locale-stable,
# same pin relay_pid_start already relies on).
relay_pid_alive() {
  local pid="$1"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  [ "$pid" -gt 0 ] 2>/dev/null || return 1
  if kill -0 "$pid" 2>/dev/null; then return 0; fi
  case "$(LC_ALL=C kill -0 "$pid" 2>&1)" in
    *'not permitted'*) return 0 ;;
    *) return 1 ;;
  esac
}

# ANCHOR-ONLY liveness verdict — the bash TWIN of src/liveness.ts
# anchorLivenessVerdict(), pinned byte-for-verdict by the conformance test
# (tests/anchor-liveness-conformance). This is the SHARED rule for the dead-anchor
# diagnostic (below in check-relay.sh) AND the `relay release-binding` gate, so the
# thing the diagnostic tells the operator to run can never refuse what the
# diagnostic diagnosed.
#
# Args (all positional, no env, no ambient reads — a PURE function of its inputs so
# it is testable in isolation):
#   $1 agent_pid        the stored liveness anchor PID
#   $2 agent_pid_start  the stored start-time token (PID-reuse guard); may be empty
#   $3 row_host_id      the agent row's host_id
#   $4 own_host_id      THIS host's machine GUID (relay_machine_guid)
# Emits exactly one of: dead | alive | unverifiable  (on stdout, no newline).
#
# DELIBERATELY NOT the presence cascade (computeLivenessVerdict / relay_agent_pid's
# argv scan). PRESENCE asks "is there ANY process for this agent?" (argv-inclusive,
# for the dashboard); ELIGIBILITY asks "is THIS binding's anchor dead?"
# (anchor-only, for the gate + diagnostic). An argv-advertised agent (every codex
# terminal carries RELAY_AGENT_NAME in its argv) would read presence-alive on a
# dead anchor and make its stale binding unrecoverable. So this probes the anchor
# and NOTHING else. Mirrors isAgentProcessAlive's narrow-dead rule:
#   - cross-host / missing GUID / non-probe-able pid → unverifiable (never guess)
#   - pid not alive                                  → dead
#   - pid alive, no start anchor                     → alive (PID-liveness only)
#   - pid alive, start unreadable                    → alive (can't validate → trust PID)
#   - pid alive, start MATCHES                        → alive
#   - pid alive, start MISMATCH (PID reuse)           → dead
relay_anchor_liveness() {
  local agent_pid="$1" agent_pid_start="$2" row_host="$3" own_host="$4" cur
  if [ -z "$own_host" ] || [ -z "$row_host" ] || [ "$row_host" != "$own_host" ]; then
    printf 'unverifiable'; return
  fi
  case "$agent_pid" in ''|*[!0-9]*) printf 'unverifiable'; return ;; esac
  [ "$agent_pid" -gt 0 ] 2>/dev/null || { printf 'unverifiable'; return; }
  if ! relay_pid_alive "$agent_pid"; then printf 'dead'; return; fi
  if [ -z "$agent_pid_start" ]; then printf 'alive'; return; fi
  cur=$(relay_pid_start "$agent_pid")
  if [ -z "$cur" ]; then printf 'alive'; return; fi
  if [ "$cur" = "$agent_pid_start" ]; then printf 'alive'; else printf 'dead'; fi
}

# --- v2.16.3: Tether v0.3 PID-handshake helpers (shared — moved out of
# check-relay.sh so the Codex SessionStart hook can report the SAME handshake
# and Tether can PID-bind Codex terminals, not just Claude ones) --------------
#
# Compute the agent's machine GUID + process-ancestry PID chain so Tether can
# bind THIS terminal to THIS agent by process id (no manual naming). Both MUST
# match the extension's TypeScript readers (extensions/vscode/src/host-identity.ts)
# byte-for-byte — same OS source, same extraction — or the two host_ids won't
# agree and host-scoped matching silently fails. For a well-formed OS machine id
# (a 32-hex /etc/machine-id or a real IOPlatformUUID — the only case on a real
# host) the bash strip-whitespace here and the TS 32-hex-first-line extraction
# resolve the SAME value (exercised: tests/v2-16-3 C5, bash == TS on this host).
# A malformed id could diverge, but that only degrades to a host-scope miss →
# name-match fallback, never a wrong wake. POSIX is the real path
# (macOS / Linux); the Windows (git-bash) branches mirror the documented
# wmic/reg shapes but are not runtime-tested (no Windows host). Any failure →
# empty output → the field is omitted from the register call (graceful: Tether
# falls back to name matching).
relay_machine_guid() {
  case "$(uname -s 2>/dev/null)" in
    Darwin)
      ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null \
        | sed -nE 's/.*"IOPlatformUUID" = "([^"]+)".*/\1/p' | head -1 ;;
    Linux)
      head -1 /etc/machine-id 2>/dev/null | tr -d '[:space:]' ;;
    MINGW*|MSYS*|CYGWIN*)
      reg query 'HKLM\SOFTWARE\Microsoft\Cryptography' //v MachineGuid 2>/dev/null \
        | sed -nE 's/.*MachineGuid[[:space:]]+REG_SZ[[:space:]]+([^[:space:]]+).*/\1/p' | head -1 ;;
  esac
}

# Walk parent PIDs from this hook shell ($$) up toward init, emitting a JSON
# array "[pid1,pid2,...]". The hook is a descendant of the agent (claude/codex),
# which is a descendant of the controlling shell (= VS Code Terminal.processId),
# so that shell PID is always in the chain regardless of launch path. Bounded +
# stops at init.
relay_pid_chain() {
  local pid=$$ chain="" depth=0 ppid wtable
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*)
      wtable=$(wmic process get ProcessId,ParentProcessId /format:csv 2>/dev/null)
      [ -z "$wtable" ] && { printf '[]'; return; }
      while [ "${pid:-0}" -gt 1 ] 2>/dev/null && [ "$depth" -lt 64 ]; do
        chain="${chain:+$chain,}$pid"
        ppid=$(printf '%s\n' "$wtable" | awk -F, -v p="$pid" 'NR>1 && $3+0==p {gsub(/[^0-9]/,"",$2); print $2; exit}')
        case "$ppid" in ''|*[!0-9]*) break ;; esac
        [ "$ppid" -le 1 ] && break
        pid="$ppid"; depth=$((depth+1))
      done ;;
    *)
      while [ "${pid:-0}" -gt 1 ] 2>/dev/null && [ "$depth" -lt 64 ]; do
        chain="${chain:+$chain,}$pid"
        ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
        case "$ppid" in ''|*[!0-9]*) break ;; esac
        [ "$ppid" -le 1 ] && break
        pid="$ppid"; depth=$((depth+1))
      done ;;
  esac
  printf '[%s]' "$chain"
}

# relay_run_pending DEADLINE OUTFILE ERRFILE CMD...
# Runs CMD DIRECTLY (its own pid: no wrapper, no fork) with stdout and stderr in
# FILES, never a pipe: a command substitution waits for EVERY process that
# inherited its pipe, so a leftover child could hold it open long past any
# deadline. A bash watchdog sleeps to the deadline and kills THAT pid. Returns
# CMD's exit status, or 124 when the watchdog fired (the GNU `timeout`
# convention). No perl, no coreutils `timeout`: bash, sleep and kill only, on
# macOS and Linux alike. (An in-process timer cannot do this: better-sqlite3 is
# synchronous, so a JS timer cannot pre-empt a blocked native call.)
relay_run_pending() {
  local secs="$1" outf="$2" errf="$3"
  shift 3
  relay_run_bounded "$secs" /dev/null "$outf" "$errf" "$@"
}

# relay_run_bounded SECS INFILE OUTF ERRF CMD... — relay_run_pending's watchdog
# with a chosen stdin (the bind reads the hook payload on stdin): CMD runs
# directly into files, is killed at SECS, and 124 means it timed out.
relay_run_bounded() {
  local secs="$1" inf="$2" outf="$3" errf="$4"
  shift 4
  local mark="$outf.timedout"
  rm -f "$mark" 2>/dev/null
  "$@" >"$outf" 2>"$errf" <"$inf" &
  local pid=$!
  (
    trap 'kill "$s" 2>/dev/null; exit 0' TERM
    sleep "$secs" &
    s=$!
    wait "$s"
    : >"$mark"
    kill -TERM "$pid" 2>/dev/null
    sleep 1
    kill -KILL "$pid" 2>/dev/null
  ) >/dev/null 2>&1 &
  local wd=$!
  wait "$pid" 2>/dev/null
  local rc=$?
  if [ -e "$mark" ]; then
    # The watchdog fired and the target is gone: end the watchdog now rather than
    # wait out its KILL grace second (its stray `sleep` writes nowhere).
    kill -KILL "$wd" 2>/dev/null
    wait "$wd" 2>/dev/null
    rm -f "$mark" 2>/dev/null
    return 124
  fi
  kill -TERM "$wd" 2>/dev/null
  wait "$wd" 2>/dev/null
  return "$rc"
}

# relay_pending_deadline BUDGET
# Whole seconds `relay pending` may run in this hook. BUDGET is the hook's
# INSTALLED timeout (src/agent-cli-profiles.ts is the source of truth; each hook
# declares it as RELAY_HOOK_BUDGET_SECS, and a test holds the two equal). The
# deadline is what is LEFT of it (minus what this hook already spent, $SECONDS)
# minus a 3s margin to report the failure (SECONDS truncates, so up to 1s spent
# is unseen, and the watchdog's 1s KILL grace comes on top), so the harness never
# kills the hook before it can say why. RELAY_PENDING_TIMEOUT_SECS may only
# shorten it. NO FLOOR: below 1 means there is no time left, and the caller must
# SKIP the read and say so, never squeeze in a 1s read the harness would kill.
# relay_premail_secs — whole seconds the steps BEFORE the mail read (the resolver,
# the health check, registration, the bind) may still use: the hook's installed
# budget (RELAY_HOOK_BUDGET_SECS) minus what it already spent ($SECONDS), minus
# the report margin (3s, as relay_pending_deadline) and a RESERVE for the mail
# read itself (2s). Never negative. Every pre-mail step is capped by it, so those
# steps together can never eat the mail read's time or push the hook past its
# installed timeout.
relay_premail_secs() {
  local budget="${RELAY_HOOK_BUDGET_SECS:-10}" reserve=2 left
  case "$budget" in ''|*[!0-9]*) budget=10 ;; esac
  left=$(( budget - ${SECONDS:-0} - 3 - reserve ))
  [ "$left" -lt 0 ] && left=0
  printf '%s' "$left"
}

# relay_cap SECS — the smaller of a step's own cap and the pre-mail budget.
relay_cap() {
  local own="$1" left
  left=$(relay_premail_secs)
  if [ "$own" -lt "$left" ]; then printf '%s' "$own"; else printf '%s' "$left"; fi
}

relay_pending_deadline() {
  local budget="$1" margin=3 left v
  case "$budget" in ''|*[!0-9]*) budget=5 ;; esac
  left=$(( budget - ${SECONDS:-0} - margin ))
  v="${RELAY_PENDING_TIMEOUT_SECS:-}"
  case "$v" in ''|*[!0-9]*) v="" ;; esac
  if [ -n "$v" ] && [ "${#v}" -le 3 ] && [ "$((10#$v))" -ge 1 ] && [ "$((10#$v))" -lt "$left" ]; then
    left=$((10#$v))
  fi
  printf '%s' "$left"
}
