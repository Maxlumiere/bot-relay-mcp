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

# Source the shared bash helpers — single source of truth shared with the
# 3 hooks under hooks/. Prevents drift between this migration script and
# the runtime path resolution + vault write semantics.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=../hooks/_vault-helpers.sh
. "$REPO_ROOT/hooks/_vault-helpers.sh"

if ! write_relay_token_to_vault "$NAME" "$TOKEN"; then
  echo "[migrate] vault write failed for \"$NAME\"" >&2
  exit 2
fi

VAULT_FILE=$(resolve_relay_token_path "$NAME") || VAULT_FILE="(unresolved)"
echo "[migrate] Migration complete." >&2
echo "[migrate] Token for \"$NAME\" written to: $VAULT_FILE" >&2
echo "[migrate] You can unset RELAY_AGENT_TOKEN in your shell config now;" >&2
echo "[migrate] the relay resolves identity from the file vault going forward." >&2
echo "[migrate] (The env var is still honored when set; vault is the fallback.)" >&2
