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
# v2.7.2 — manifest-fallback for the silent "default" failure mode. When the
# typed-env transport (osascript write text → child shell → claude → hook
# subprocess) drops RELAY_AGENT_NAME between the spawn and us, the bash :-
# default above silently picks "default" and the hook re-registers under the
# wrong name (mail dead-letters). Defense-in-depth: if name is unset OR
# literal "default", scan the per-instance agents/ dir for a single fresh
# (<60s) spawn manifest and recover identity from it. Loud warning on
# ambiguity or stale state; silent recovery when unambiguous.
# Helpers are sourced below at HOOKS_DIR/_vault-helpers.sh; we defer the
# recovery check until after sourcing so the function definitions exist.
# v2.2.0: window title for the dashboard click-to-focus driver. Defaults to
# the agent name when the spawn chain didn't set it (e.g. manual terminal
# registrations). Empty → register_agent omits the field and the agent's
# focus button stays disabled in the UI per the graceful-degrade contract.
RELAY_TERMINAL_TITLE_VALUE="${RELAY_TERMINAL_TITLE:-}"
# v2.6.1 — vault helpers + DB-path resolution sourced from a single file.
# Mirrors src/instance.ts:resolveInstanceDbPath + src/token-store.ts:
# resolveAgentVaultDir + FileTokenStore.{pathFor,read,write}. Drift surfaces
# directly as a test failure in tests/v2-6-1-token-store.test.ts (which
# sources this same file) — no inline-copy hide-out.
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_vault-helpers.sh
. "$HOOKS_DIR/_vault-helpers.sh"
# v2.7.2 — manifest-fallback (see comment above the AGENT_NAME default). Only
# kicks in when env-derived name is empty or literal "default" — operators who
# explicitly want the "default" agent (rare, but legitimate) can opt out by
# setting RELAY_DISABLE_MANIFEST_FALLBACK=1.
if [ -z "${RELAY_DISABLE_MANIFEST_FALLBACK:-}" ] && { [ "$AGENT_NAME" = "default" ] || [ -z "$AGENT_NAME" ]; }; then
  if MANIFEST_KV=$(find_fresh_relay_spawn_manifest 60 2>/dev/null); then
    # KV shape is exactly `name=<n>;role=<r>` (find_fresh validates both).
    M_NAME=$(printf '%s' "$MANIFEST_KV" | sed -E 's/^name=([^;]+);role=.*$/\1/')
    M_ROLE=$(printf '%s' "$MANIFEST_KV" | sed -E 's/^name=[^;]+;role=(.*)$/\1/')
    if [ -n "$M_NAME" ] && [ -n "$M_ROLE" ]; then
      AGENT_NAME="$M_NAME"
      # Only override role if the env-derived value was the bash default
      # ("user"); a caller that explicitly set RELAY_AGENT_ROLE keeps it.
      if [ "$AGENT_ROLE" = "user" ]; then
        AGENT_ROLE="$M_ROLE"
      fi
      echo "[bot-relay hook] recovered identity from spawn manifest: name=$AGENT_NAME role=$AGENT_ROLE (RELAY_AGENT_NAME was unset/default — defense-in-depth recovery; the typed-env transport from bin/spawn-agent.sh likely dropped this between spawn and hook)" >&2
      # Best-effort cleanup so the manifest can't be re-used by a later
      # unrelated terminal. If delete fails (e.g. permissions), the 60s
      # freshness window still bounds the damage.
      delete_relay_spawn_manifest "$AGENT_NAME" >/dev/null 2>&1 || true
    fi
  else
    # v2.7.2 R1 — ambiguity-loud branch. find_fresh returned non-zero, so
    # we got 0, >1, or a malformed/mismatched manifest. Only the >1 case
    # gets a loud warning — 0 (no manifest) is the normal manual-terminal
    # path and would be log noise. The count helper here MUST use the same
    # 60s window the find call above used, otherwise the two can disagree
    # on a file modified at exactly the boundary.
    FRESH_MANIFEST_COUNT=$(count_fresh_relay_spawn_manifests 60 2>/dev/null || echo 0)
    if [ "${FRESH_MANIFEST_COUNT:-0}" -gt 1 ]; then
      echo "[bot-relay hook] WARNING: ambiguous spawn manifest — found $FRESH_MANIFEST_COUNT fresh manifests in the per-instance agents/ directory, not guessing identity, falling back to default. This usually means two spawn_agent calls landed within 60s. Either set RELAY_AGENT_NAME explicitly for this terminal, or wait ~60s for the older manifest(s) to age out and re-open the terminal." >&2
    fi
  fi
fi
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

# v2.6.1 — vault-first bootstrap. If RELAY_AGENT_TOKEN is unset in env BUT a
# vault file exists for this agent name, hydrate the env from disk before any
# auth-sensitive call below. Closes the spawn-without-pre-mint failure mode
# (3-min broken state hit 2026-05-04 with gaming-build) and makes restart-of-
# closed-terminal lossless: identity persists even when the operator did not
# bake RELAY_AGENT_TOKEN into a shell rc file.
if [ -z "${RELAY_AGENT_TOKEN:-}" ]; then
  if VAULT_TOKEN=$(read_relay_token_from_vault "$AGENT_NAME"); then
    export RELAY_AGENT_TOKEN="$VAULT_TOKEN"
  fi
fi

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
    # v2.6.4 — daemon's SSE-wrapped MCP response stringifies the inner JSON
    # via JSON.stringify with pretty-printing. The bytes the grep sees are
    # `\"key\": value` (escaped quote + space after colon), NOT the
    # unescaped `"key":value` form pre-v2.6.4 patterns expected. Match the
    # actual byte sequence: backslash + quote + key + backslash + quote +
    # colon + optional whitespace + value. SSE framing (`event: message\n
    # data: {...}`) is on a single physical line of stdout so a whole-body
    # grep still works.
    if echo "$HEALTH_BODY" | grep -qE '\\"auth_error\\":[[:space:]]*true'; then
      AUTH_ERROR=1
    fi
    AUTH_STATE=$(echo "$HEALTH_BODY" | grep -oE '\\"auth_state\\":[[:space:]]*\\"[A-Za-z_]+\\"' | head -1 | sed -E 's/.*\\"([A-Za-z_]+)\\"$/\1/')
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
    # v2.6.4 — same SSE-escape fix as the health_check parsing above. Inner
    # JSON is stringified with `\"key\": value` shape; the unescaped pattern
    # never matched, so this entire branch was silently dead pre-v2.6.4.
    if echo "$RECOVERY_BODY" | grep -qE '\\"recovery_completed\\":[[:space:]]*true'; then
      NEW_TOKEN=$(echo "$RECOVERY_BODY" | grep -oE '\\"agent_token\\":[[:space:]]*\\"[A-Za-z0-9_=.-]{8,128}\\"' | head -1 | sed -E 's/.*\\"([A-Za-z0-9_=.-]{8,128})\\"$/\1/')
      RECOVERY_COMPLETED=1
      # v2.6.1 — persist to vault + export inline. Operators no longer need
      # to manually paste the new token into their shell config; the next
      # spawn picks it up via FileTokenStore.read.
      if [ -n "$NEW_TOKEN" ]; then
        if write_relay_token_to_vault "$AGENT_NAME" "$NEW_TOKEN"; then
          export RELAY_AGENT_TOKEN="$NEW_TOKEN"
          echo "[relay] Recovery completed for \"$AGENT_NAME\". Fresh agent_token written to vault and exported." >&2
          echo "[relay]   You may unset RELAY_RECOVERY_TOKEN now; the new token is persisted at:" >&2
          if VPATH=$(resolve_relay_token_path "$AGENT_NAME"); then echo "[relay]     $VPATH" >&2; fi
        else
          echo "[relay] Recovery completed for \"$AGENT_NAME\" but vault write failed. Set manually:" >&2
          echo "[relay]   unset RELAY_RECOVERY_TOKEN" >&2
          echo "[relay]   export RELAY_AGENT_TOKEN=${NEW_TOKEN}" >&2
        fi
      fi
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

# --- Tether v0.3 PID-handshake helpers ---
#
# Compute the agent's machine GUID + process-ancestry PID chain so Tether can
# bind THIS terminal to THIS agent by process id (no manual naming). Both MUST
# match the extension's TypeScript readers (extensions/vscode/src/host-identity.ts)
# byte-for-byte — same OS source, same extraction — or the two host_ids won't
# agree and host-scoped matching silently fails. POSIX is the real path
# (the maintainer's Mac); the Windows (git-bash) branches mirror the documented
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
# array "[pid1,pid2,...]". The hook is a descendant of the agent (claude),
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
  # Tether v0.3 PID-handshake: best-effort PID chain + machine GUID. Empty/[] →
  # the field is omitted (graceful — registration never fails over the handshake).
  RELAY_HOST_PID_CHAIN=$(relay_pid_chain 2>/dev/null || printf '')
  [ "$RELAY_HOST_PID_CHAIN" = "[]" ] && RELAY_HOST_PID_CHAIN=""
  RELAY_HOST_GUID=$(relay_machine_guid 2>/dev/null || printf '')
  REG_BODY=$(curl -s -m 4 -w "\nHTTP_STATUS:%{http_code}\n" \
    -X POST "http://${HTTP_HOST}:${HTTP_PORT}/mcp" \
    "${REG_HEADERS[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"register_agent\",\"arguments\":{\"name\":\"${AGENT_NAME}\",\"role\":\"${AGENT_ROLE}\",\"capabilities\":${CAPS_JSON}${RELAY_TERMINAL_TITLE_VALUE:+,\"terminal_title_ref\":\"${RELAY_TERMINAL_TITLE_VALUE}\"}${RELAY_HOST_PID_CHAIN:+,\"host_shell_pids\":${RELAY_HOST_PID_CHAIN}}${RELAY_HOST_GUID:+,\"host_id\":\"${RELAY_HOST_GUID}\"}}}}" \
    2>&1)
  # v2.6.1 — capture fresh agent_token from the response body and persist
  # to the vault. register_agent only returns `agent_token` on first-mint
  # paths (legacy_bootstrap → active or fresh INSERT); subsequent re-
  # registers preserve the existing hash and omit the field. So the
  # presence of `\"agent_token\": \"...\"` (SSE-escaped + spaced) here
  # means "the daemon just minted a fresh credential for us, capture it."
  # Closes the v2.1 Phase 4j latent bug where this token was discarded,
  # leaving the agent registered but unable to authenticate.
  #
  # v2.6.4 — match the actual SSE-wrapped + JSON-stringified shape the
  # daemon emits (verified via curl against the live :3777 endpoint —
  # `\"agent_token\": \"<token>\"` with a backslash before each quote
  # and a space after the colon). The pre-v2.6.4 pattern
  # `'"agent_token":"[^"]*"'` never matched the actual bytes, so the
  # vault was never written on first-spawn — the bug news-intel-build hit
  # 2026-05-06 despite the v2.6.1 R3 cumulative arc. Token-shape charset
  # `[A-Za-z0-9_=.-]+` mirrors src/token-store.ts:67 TOKEN_SHAPE_RE so
  # tightening from `[^\"]*` to the allowlist also defends against any
  # future change in escaping that would otherwise pass-through corrupt
  # bytes.
  REG_TOKEN=$(echo "$REG_BODY" | grep -oE '\\"agent_token\\":[[:space:]]*\\"[A-Za-z0-9_=.-]{8,128}\\"' | head -1 | sed -E 's/.*\\"([A-Za-z0-9_=.-]{8,128})\\"$/\1/')
  if [ -n "$REG_TOKEN" ]; then
    if write_relay_token_to_vault "$AGENT_NAME" "$REG_TOKEN"; then
      export RELAY_AGENT_TOKEN="$REG_TOKEN"
      if [ -n "${RELAY_HOOK_DEBUG:-}" ]; then
        echo "[bot-relay hook debug] persisted fresh agent_token to vault for \"$AGENT_NAME\"" >&2
      fi
    else
      echo "[relay] Bootstrap failed for $AGENT_NAME — register_agent succeeded but vault write failed. Run \`relay recover $AGENT_NAME\` and re-spawn." >&2
    fi
  fi
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
