#!/bin/bash
# bot-relay-mcp: SessionStart hook
# Registers this terminal as an agent and delivers any pending mail/tasks.
# Uses sqlite3 directly for the fast path (no daemon dependency). v2.1 Phase
# 4b.1 v2 adds an optional health_check probe to detect stale/revoked tokens
# when the HTTP daemon is reachable — closes MED F (silent-survive-revoke).
# Stdout becomes Claude's context at session start; stderr is shown to the user.
#
# Env vars:
#   RELAY_AGENT_NAME         — agent name (default: "default")
#   RELAY_AGENT_ROLE         — agent role (default: "user")
#   RELAY_AGENT_CAPABILITIES — comma-separated (default: empty)
#   RELAY_DB_PATH            — DB path (default: per-instance resolution, see below)
#   RELAY_INSTANCE_ID        — (v2.4.5) explicit per-instance override; mirrors
#                              src/instance.ts:resolveInstanceDbPath().
#   RELAY_AGENT_TOKEN        — (v1.7+) token for authenticated tool calls
#   RELAY_RECOVERY_TOKEN     — (v2.1 Phase 4b.1 v2) admin-issued one-time
#                              recovery secret. If the daemon reports the
#                              agent's state as recovery_pending, this is used
#                              to re-register and mint a fresh agent_token.
#   RELAY_HTTP_HOST          — daemon host (default: 127.0.0.1)
#   RELAY_HTTP_PORT          — daemon port (default: 3777)
#
# Example alias:
#   alias ai='RELAY_AGENT_NAME=victra RELAY_AGENT_ROLE=chief-of-staff claude'
#
# Security notes (v1.6):
# - All env-var inputs are validated against an allowlist regex BEFORE use.
# - Names/roles/caps that contain anything outside [A-Za-z0-9_.-] are rejected.
# - DB_PATH is resolved and must live under $HOME (no /etc/passwd shenanigans).
# - SQL is parameterised via sqlite3's `.parameter set` rather than string-interpolated.

# v2.0 final (#19): self-check for path truncation. When .claude/settings.json
# references this script with an unquoted path containing spaces, only the
# first word reaches $0 — the script silently fails to find itself.
if [[ "$0" != *"/bot-relay-mcp/hooks/"* ]]; then
  echo "[bot-relay hook WARNING] \$0 does not contain '/bot-relay-mcp/hooks/' — the install path may be truncated. Quote the command string in .claude/settings.json if the path contains spaces. \$0='$0'" >&2
fi

AGENT_NAME="${RELAY_AGENT_NAME:-default}"
AGENT_ROLE="${RELAY_AGENT_ROLE:-user}"
AGENT_CAPS="${RELAY_AGENT_CAPABILITIES:-}"
# v2.2.0: window title for the dashboard click-to-focus driver. Defaults to
# the agent name when the spawn chain didn't set it (e.g. manual terminal
# registrations). Empty → register_agent omits the field and the agent's
# focus button stays disabled in the UI per the graceful-degrade contract.
RELAY_TERMINAL_TITLE_VALUE="${RELAY_TERMINAL_TITLE:-}"
# v2.4.5 R1 — bash mirror of src/instance.ts:resolveInstanceDbPath. Closes the
# split-brain that bit Codex 5.5 during v2.4.4 R2 (HTTP daemon resolved per-
# instance correctly; this hook hardcoded legacy and silently read the wrong
# DB).
#
# This function is BYTE-IDENTICAL across hooks/check-relay.sh,
# hooks/post-tool-use-check.sh, and hooks/stop-check.sh. The
# tests/v2-4-5-stdio-per-instance-db.test.ts identity test fails on any
# divergence — change one, change all three.
#
# Mirrors TS semantics:
#   - botRelayRoot(): RELAY_HOME wins (test seam), else $HOME/.bot-relay
#                     (src/instance.ts:70).
#   - resolveActiveInstanceId(): RELAY_INSTANCE_ID > active-instance
#                                link/file (src/instance.ts:118).
#   - instanceDir(): malformed instance_id rejects with [A-Za-z0-9._-]+
#                    allowlist (src/instance.ts:149) — bash mirror emits
#                    stderr + returns 1 instead of throwing.
#
# Output: resolved DB path on stdout. On malformed instance_id, stderr
# error + return 1 (caller decides how to degrade — silent fallback is
# the wrong call, an attacker-controlled active-instance file would
# otherwise mask the operator's actual setup).
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
DB_PATH=$(resolve_relay_db_path) || {
  # Malformed active-instance content — refuse to fall back silently. A
  # broken setup should be loud, not hidden under legacy. The hook's
  # other side effects (HTTP register/health, mail delivery) are gated
  # behind DB_PATH being readable below; null DB_PATH falls cleanly to
  # the existing "no DB → exit 0" path.
  DB_PATH=""
}
HTTP_HOST="${RELAY_HTTP_HOST:-127.0.0.1}"
HTTP_PORT="${RELAY_HTTP_PORT:-3777}"

# --- Input validation (security hardening) ---

# Allowed character set for agent name and role
if ! [[ "$AGENT_NAME" =~ ^[A-Za-z0-9_.-]{1,64}$ ]]; then
  echo "[bot-relay] RELAY_AGENT_NAME has invalid characters or length. Allowed: [A-Za-z0-9_.-], 1-64 chars. Got: '$AGENT_NAME'" >&2
  exit 0
fi
if ! [[ "$AGENT_ROLE" =~ ^[A-Za-z0-9_.-]{1,64}$ ]]; then
  echo "[bot-relay] RELAY_AGENT_ROLE has invalid characters or length. Allowed: [A-Za-z0-9_.-], 1-64 chars. Got: '$AGENT_ROLE'" >&2
  exit 0
fi
# Capabilities: comma-separated tokens of the same character set.
# grep used instead of bash =~ for portability with macOS bash 3.2.
if [ -n "$AGENT_CAPS" ]; then
  if [ ${#AGENT_CAPS} -gt 256 ] || ! echo "$AGENT_CAPS" | grep -Eq '^[A-Za-z0-9_.,-]+$'; then
    echo "[bot-relay] RELAY_AGENT_CAPABILITIES has invalid characters or length. Allowed: [A-Za-z0-9_.,-], 1-256 chars." >&2
    exit 0
  fi
fi

# DB path must live under HOME (or under /tmp for tests). Resolve symlinks first.
RESOLVED_DB_PATH=$(cd "$(dirname "$DB_PATH")" 2>/dev/null && pwd)/$(basename "$DB_PATH")
if [ -z "$RESOLVED_DB_PATH" ] || { [[ "$RESOLVED_DB_PATH" != "$HOME"/* ]] && [[ "$RESOLVED_DB_PATH" != /tmp/* ]] && [[ "$RESOLVED_DB_PATH" != /private/tmp/* ]] && [[ "$RESOLVED_DB_PATH" != /var/folders/* ]]; }; then
  echo "[bot-relay] RELAY_DB_PATH must live under \$HOME or /tmp. Got: '$RESOLVED_DB_PATH'" >&2
  exit 0
fi
DB_PATH="$RESOLVED_DB_PATH"

# If there's no DB yet, nothing to do
if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# --- v2.1 Phase 4b.1 v2: token-validation pre-check via health_check ---
#
# When $RELAY_AGENT_TOKEN is set AND the HTTP daemon is reachable, we probe
# health_check with the token to detect stale/revoked credentials BEFORE any
# other action. If the daemon is not reachable, we skip silently and fall
# through to the existing sqlite3-based flow (best-effort — closes MED F
# whenever the daemon is up, which is the common case).
#
# Required deps for this block: curl (standard on macOS/Linux). jq is NOT
# required — we parse the fields we need with grep/sed.
AUTH_ERROR=0
AUTH_STATE=""
RECOVERY_COMPLETED=0
if [ -n "${RELAY_AGENT_TOKEN:-}" ] && command -v curl >/dev/null 2>&1; then
  HEALTH_BODY=$(curl -s -m 2 -X POST "http://${HTTP_HOST}:${HTTP_PORT}/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "X-Agent-Token: ${RELAY_AGENT_TOKEN}" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_check","arguments":{}}}' 2>/dev/null)
  if [ -n "$HEALTH_BODY" ]; then
    # Grep out auth_error + auth_state from the embedded JSON text. Tolerates
    # SSE framing ("event: message\ndata: {...}") via whole-body search.
    if echo "$HEALTH_BODY" | grep -q '"auth_error":true'; then
      AUTH_ERROR=1
    fi
    AUTH_STATE=$(echo "$HEALTH_BODY" | grep -oE '"auth_state":"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)".*/\1/')
  fi
fi

if [ "$AUTH_ERROR" -eq 1 ]; then
  # v2.1 Phase 4b.1 v2 recovery path: if operator set $RELAY_RECOVERY_TOKEN AND
  # the daemon reported recovery_pending, try to re-register with the recovery
  # token. On success, emit guidance for the operator to replace their token.
  if [ "$AUTH_STATE" = "recovery_pending" ] && [ -n "${RELAY_RECOVERY_TOKEN:-}" ]; then
    # Build capabilities JSON for the recovery register_agent call. Re-uses
    # the allowlist logic below (hoisted here so recovery path can call it).
    CAPS_JSON="[]"
    if [ -n "$AGENT_CAPS" ]; then
      CAPS_JSON=$(echo "$AGENT_CAPS" | awk -F',' '{
        printf "[";
        for (i=1; i<=NF; i++) {
          gsub(/^ +| +$/, "", $i);
          if ($i !~ /^[A-Za-z0-9_.-]+$/) next;
          printf "%s\"%s\"", (i==1 ? "" : ","), $i;
        }
        printf "]";
      }')
    fi
    RECOVERY_BODY=$(curl -s -m 4 -X POST "http://${HTTP_HOST}:${HTTP_PORT}/mcp" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"register_agent\",\"arguments\":{\"name\":\"${AGENT_NAME}\",\"role\":\"${AGENT_ROLE}\",\"capabilities\":${CAPS_JSON},\"recovery_token\":\"${RELAY_RECOVERY_TOKEN}\"}}}" 2>/dev/null)
    if echo "$RECOVERY_BODY" | grep -q '"recovery_completed":true'; then
      NEW_TOKEN=$(echo "$RECOVERY_BODY" | grep -oE '"agent_token":"[^"]*"' | head -1 | sed -E 's/.*:"([^"]*)".*/\1/')
      RECOVERY_COMPLETED=1
      echo "[relay] Recovery completed for \"$AGENT_NAME\". A fresh agent_token was minted." >&2
      echo "[relay] The relay cannot mutate your shell env; do this manually before next tool call:" >&2
      echo "[relay]   unset RELAY_RECOVERY_TOKEN" >&2
      echo "[relay]   export RELAY_AGENT_TOKEN=${NEW_TOKEN}" >&2
      echo "[relay] Persist the new token in your shell rc file if this terminal will survive restarts." >&2
    else
      echo "[relay] Recovery attempt failed for \"$AGENT_NAME\". Response: $(echo "$RECOVERY_BODY" | head -c 200)" >&2
      exit 1
    fi
  else
    # Stale or revoked token, no recovery credential available.
    echo "[relay] Agent \"$AGENT_NAME\" has a stale or revoked token (health_check returned auth_error)." >&2
    echo "[relay] If an admin issued a recovery token for this agent, set RELAY_RECOVERY_TOKEN=<token> and restart this terminal." >&2
    echo "[relay] Otherwise, request a recovery_token via revoke_token(issue_recovery=true) from an admin-capable agent." >&2
    exit 1
  fi
fi

# --- Build capabilities JSON safely (also used for the sqlite3 upsert path) ---
if [ "$RECOVERY_COMPLETED" -eq 0 ]; then
  CAPS_JSON="[]"
  if [ -n "$AGENT_CAPS" ]; then
    # Each token also matches our allowlist (already validated as a whole; re-check per-token)
    CAPS_JSON=$(echo "$AGENT_CAPS" | awk -F',' '{
      printf "[";
      for (i=1; i<=NF; i++) {
        gsub(/^ +| +$/, "", $i);
        if ($i !~ /^[A-Za-z0-9_.-]+$/) next;
        printf "%s\"%s\"", (i==1 ? "" : ","), $i;
      }
      printf "]";
    }')
  fi
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
UUID=$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]' || echo "hook-$$-$(date +%s)")

# v2.1 Phase 4j: if the parent pre-registered us (spawn_agent path), RELAY_AGENT_TOKEN
# is set in env AND an agent row already exists. Skip the register call — running it
# would overwrite role/capabilities from this env, which may differ from what
# the parent registered. Mail/task delivery below still proceeds normally.
# v2.1 Phase 4b.1 v2: also skip if we just completed a recovery above — the
# register_agent over HTTP already wrote the row.
SKIP_REGISTER=0
if [ "$RECOVERY_COMPLETED" -eq 1 ]; then
  SKIP_REGISTER=1
elif [ -n "${RELAY_AGENT_TOKEN:-}" ]; then
  EXISTS=$(sqlite3 "$DB_PATH" <<SQL 2>/dev/null
.parameter set :name '$AGENT_NAME'
SELECT 1 FROM agents WHERE name = :name LIMIT 1;
SQL
)
  if [ -n "$EXISTS" ]; then
    SKIP_REGISTER=1
  fi
fi

# --- Register via HTTP register_agent (Phase 7p HIGH #3) ---
#
# Prior to Phase 7p this block did a raw sqlite3 UPSERT. That created
# `auth_state='active' + token_hash IS NULL` rows — an impossible state per
# Phase 4b.1 v2 invariants (active MUST have a hash; null hash MUST be
# legacy_bootstrap). It also mutated `capabilities` on re-register,
# silently bypassing the v1.7.1 immutability rule. Codex caught both in the
# v2.1 final-gate audit.
#
# Fix: call the real register_agent over HTTP when the daemon is reachable.
# The handler enforces every invariant (state branching, CAS UPDATE,
# capability preservation). If the daemon is NOT reachable, we skip the
# register silently — we do NOT touch the DB directly. The mail/task
# delivery path below is read-only and stays via sqlite3 (the fast path is
# the point). Bootstrap without a daemon is deliberately not supported.
if [ "$SKIP_REGISTER" -eq 0 ] && command -v curl >/dev/null 2>&1; then
  # Carry the caller's token if they have one — active re-register requires
  # it; first-time bootstrap on a fresh row doesn't. Either way the request
  # reaches the server so the server decides which branch to take.
  REG_HEADERS=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
  if [ -n "${RELAY_AGENT_TOKEN:-}" ]; then
    REG_HEADERS+=(-H "X-Agent-Token: ${RELAY_AGENT_TOKEN}")
  fi
  REG_BODY=$(curl -s -m 4 -w "\nHTTP_STATUS:%{http_code}\n" \
    -X POST "http://${HTTP_HOST}:${HTTP_PORT}/mcp" \
    "${REG_HEADERS[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"register_agent\",\"arguments\":{\"name\":\"${AGENT_NAME}\",\"role\":\"${AGENT_ROLE}\",\"capabilities\":${CAPS_JSON}${RELAY_TERMINAL_TITLE_VALUE:+,\"terminal_title_ref\":\"${RELAY_TERMINAL_TITLE_VALUE}\"}}}}" \
    2>&1)
  # If $RELAY_HOOK_DEBUG is set, print the full response for troubleshooting.
  # Otherwise swallow silently — non-200 means the server refused (stale
  # token, revoked state, etc.), which is fine: the earlier health_check
  # probe will already have surfaced actionable messages to the operator.
  # We just don't want to corrupt the DB with a fallback sqlite3 write.
  if [ -n "${RELAY_HOOK_DEBUG:-}" ]; then
    echo "[bot-relay hook debug] register_agent response:" >&2
    echo "$REG_BODY" >&2
  fi
fi

# --- Deliver pending messages (parameter-bound) ---
MESSAGES=$(sqlite3 "$DB_PATH" <<SQL 2>/dev/null
.parameter set :name '$AGENT_NAME'
SELECT '  From: ' || from_agent || ' | ' || content || ' (' || created_at || ')'
FROM messages WHERE to_agent = :name AND status='pending'
ORDER BY created_at DESC LIMIT 10;
SQL
)

if [ -n "$MESSAGES" ]; then
  echo "[RELAY] Pending messages for $AGENT_NAME:"
  echo "$MESSAGES"
  echo ""
  echo "[bot-relay] $AGENT_NAME has pending messages (delivered to context)." >&2
fi

# --- Deliver active tasks (parameter-bound) ---
TASKS=$(sqlite3 "$DB_PATH" <<SQL 2>/dev/null
.parameter set :name '$AGENT_NAME'
SELECT '  [' || priority || '] ' || title || ' (from: ' || from_agent || ', id: ' || id || ')'
FROM tasks WHERE to_agent = :name AND status IN ('posted', 'accepted')
ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END
LIMIT 10;
SQL
)

if [ -n "$TASKS" ]; then
  echo "[RELAY] Active tasks for $AGENT_NAME:"
  echo "$TASKS"
  echo ""
  echo "[bot-relay] $AGENT_NAME has active tasks (delivered to context)." >&2
fi

exit 0
