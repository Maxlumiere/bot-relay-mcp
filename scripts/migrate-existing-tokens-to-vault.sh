#!/bin/bash
# bot-relay-mcp v2.6.1 — one-shot migration: env-baked RELAY_AGENT_TOKEN
# → per-instance file vault.
#
# For operators who have RELAY_AGENT_TOKEN baked into ~/.zshrc / ~/.bashrc /
# ~/.envrc / a shell profile fragment, this script writes the env-resolved
# token to <instanceDir>/agents/<name>.token so the v2.6.1+ hooks resolve
# identity from disk going forward. After running this once, the operator
# can remove the env line from their shell config.
#
# Usage:
#   RELAY_AGENT_NAME=victra RELAY_AGENT_TOKEN=<token> ./scripts/migrate-existing-tokens-to-vault.sh
#   (or run from a shell where both env vars are already set)
#
# Cross-platform: pure bash + standard POSIX utilities. Runs unmodified on
# macOS / Linux / Windows-with-bash (Git Bash, WSL, MSYS2). Vault directory
# created under the same path-resolution rules as the live daemon
# (src/instance.ts:resolveInstanceDbPath via the byte-identical bash mirror
# in hooks/check-relay.sh).
set -eu

NAME="${RELAY_AGENT_NAME:-}"
TOKEN="${RELAY_AGENT_TOKEN:-}"

if [ -z "$NAME" ] || [ -z "$TOKEN" ]; then
  echo "[migrate] RELAY_AGENT_NAME and RELAY_AGENT_TOKEN must both be set in env." >&2
  echo "[migrate] Example:" >&2
  echo "[migrate]   RELAY_AGENT_NAME=victra RELAY_AGENT_TOKEN=... $0" >&2
  exit 1
fi

if ! echo "$NAME" | grep -qE '^[A-Za-z0-9_.-]{1,64}$'; then
  echo "[migrate] RELAY_AGENT_NAME has invalid characters: $NAME" >&2
  exit 2
fi

if ! echo "$TOKEN" | grep -qE '^[A-Za-z0-9_=.-]{8,128}$'; then
  echo "[migrate] RELAY_AGENT_TOKEN has invalid shape (must match /^[A-Za-z0-9_=.-]{8,128}$/)." >&2
  echo "[migrate] If your token was minted before v2.6.1 and is shorter than 8 chars," >&2
  echo "[migrate] rotate it via the rotate_token MCP tool first." >&2
  exit 2
fi

# Mirror the daemon's path resolution. Single source of truth lives in
# src/instance.ts:resolveInstanceDbPath; this is the same bash mirror used
# by hooks/check-relay.sh (kept byte-identical via discipline).
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
    id=$(basename "$(readlink "$root/active-instance")")
  elif [ -f "$root/active-instance" ]; then
    id=$(head -n 1 "$root/active-instance" | tr -d '[:space:]')
  fi
  if [ -n "$id" ]; then
    if ! echo "$id" | grep -qE '^[A-Za-z0-9._-]+$'; then
      echo "[migrate] invalid instance_id \"$id\"" >&2
      return 1
    fi
    echo "$root/instances/$id/relay.db"
    return 0
  fi
  echo "$root/relay.db"
  return 0
}

DB_PATH=$(resolve_relay_db_path) || exit 2
VAULT_DIR="$(dirname "$DB_PATH")/agents"
VAULT_FILE="$VAULT_DIR/${NAME}.token"

mkdir -p "$VAULT_DIR" 2>/dev/null || true
chmod 0700 "$VAULT_DIR" 2>/dev/null || true   # POSIX; no-op on Windows

# Atomic write via tmp + rename — same shape as the hook helpers.
TMP="${VAULT_FILE}.tmp.$$"
{
  umask 0177
  printf '%s\n' "$TOKEN" > "$TMP"
} || {
  echo "[migrate] failed to write tmp file at $TMP" >&2
  exit 2
}
chmod 0600 "$TMP" 2>/dev/null || true
mv -f "$TMP" "$VAULT_FILE" || {
  rm -f "$TMP" 2>/dev/null
  echo "[migrate] failed to move tmp file into place at $VAULT_FILE" >&2
  exit 2
}

echo "[migrate] Migration complete." >&2
echo "[migrate] Token for \"$NAME\" written to: $VAULT_FILE" >&2
echo "[migrate] You can unset RELAY_AGENT_TOKEN in your shell config now;" >&2
echo "[migrate] the relay resolves identity from the file vault going forward." >&2
echo "[migrate] (The env var is still honored when set; vault is the fallback.)" >&2
