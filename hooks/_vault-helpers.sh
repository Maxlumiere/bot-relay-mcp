# bot-relay-mcp v2.6.1 — bash mirror of TS path resolution + token vault.
#
# Single source of truth for hook bash helpers. Sourced by
# hooks/check-relay.sh, hooks/post-tool-use-check.sh, hooks/stop-check.sh,
# and scripts/migrate-existing-tokens-to-vault.sh. Tested directly via
# `bash -c "source <this-file>; ..."` in tests/v2-6-1-token-store.test.ts
# so any drift between this file and the TS implementation surfaces as a
# real test failure (not a silent inline-copy hide-out, per
# memory/feedback_test_path_must_match_shipped_path.md).
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
