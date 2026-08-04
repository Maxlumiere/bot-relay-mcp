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
# Mirrors:
#   - src/instance.ts:resolveInstanceDbPath          → resolve_relay_db_path
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

# resolve_relay_db_path — echo absolute DB path on stdout. Returns 0; on
# malformed instance_id, echoes nothing + returns 1 + stderr message.
#
# Mirrors:
#   - botRelayRoot()              src/instance.ts:70   (RELAY_HOME wins, else $HOME/.bot-relay)
#   - resolveActiveInstanceId()   src/instance.ts:118  (RELAY_INSTANCE_ID > active-instance link/file)
#   - instanceDir()               src/instance.ts:149  ([A-Za-z0-9._-]+ allowlist)
resolve_relay_db_path() {
  if [ -n "${RELAY_DB_PATH:-}" ]; then
    echo "$RELAY_DB_PATH"
    return 0
  fi
  local root="${RELAY_HOME:-$HOME/.bot-relay}"
  local id=""
  if [ -n "${RELAY_INSTANCE_ID:-}" ]; then
    id="$RELAY_INSTANCE_ID"
  elif [ -L "$root/active-instance" ]; then
    # readlink target may be a bare instance_id or an absolute/relative
    # path; basename normalizes both shapes (mirrors path.basename in
    # src/instance.ts:135).
    id=$(basename "$(readlink "$root/active-instance")")
  elif [ -f "$root/active-instance" ]; then
    # File-fallback for platforms where symlink creation is restricted
    # (Windows non-admin); src/instance.ts:setActiveInstance writes a
    # regular file in that case.
    id=$(head -n 1 "$root/active-instance" | tr -d '[:space:]')
  fi
  if [ -n "$id" ]; then
    if ! echo "$id" | grep -qE '^[A-Za-z0-9._-]+$'; then
      echo "[bot-relay hook] invalid instance_id \"$id\" — must match [A-Za-z0-9._-]+ (mirrors src/instance.ts:instanceDir)" >&2
      return 1
    fi
    echo "$root/instances/$id/relay.db"
    return 0
  fi
  echo "$root/relay.db"
  return 0
}

# resolve_relay_token_path <name> — echo absolute vault file path on
# stdout. Returns 0 on success; on bad name, stderr + return 1.
resolve_relay_token_path() {
  local name="$1"
  if ! echo "$name" | grep -qE '^[A-Za-z0-9_.-]{1,64}$'; then
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
  if ! echo "$token" | grep -qE '^[A-Za-z0-9_=.-]{8,128}$'; then
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
  if ! echo "$name" | grep -qE '^[A-Za-z0-9_.-]{1,64}$'; then
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
  if ! echo "$name" | grep -qE '^[A-Za-z0-9_.-]{1,64}$'; then
    echo "[bot-relay hook] refusing to write manifest with malformed name \"$name\"" >&2
    return 1
  fi
  if ! echo "$role" | grep -qE '^[A-Za-z0-9_.-]{1,64}$'; then
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
  if ! echo "$fname" | grep -qE '^[A-Za-z0-9_.-]{1,64}$'; then
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
  if ! echo "$mname" | grep -qE '^[A-Za-z0-9_.-]{1,64}$'; then
    return 1
  fi
  if ! echo "$mrole" | grep -qE '^[A-Za-z0-9_.-]{1,64}$'; then
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
  if ! echo "$token" | grep -qE '^[A-Za-z0-9_=.-]{8,128}$'; then
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
