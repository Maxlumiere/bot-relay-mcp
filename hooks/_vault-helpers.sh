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
