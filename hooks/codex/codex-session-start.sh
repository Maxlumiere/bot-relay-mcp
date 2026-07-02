#!/bin/bash
# bot-relay-mcp: Codex CLI SessionStart hook
#
# Registers this Codex session as a relay agent and tells the model to check
# its inbox. Codex never runs the Claude `check-relay.sh` hook, so without this
# a Codex agent is never registered and can never receive relay mail.
#
# This is the Codex port of `hooks/check-relay.sh` (the Claude SessionStart
# hook). It mirrors the same HTTP register_agent call and the same per-instance
# token vault, so a Codex agent and a Claude agent on the same machine share one
# relay identity model. The Tether PID-handshake fields are NOT sent (Tether is
# Claude/VSCode-only); name-based addressing is all a Codex agent needs.
#
# Codex hook contract (codex-cli):
#   - stdin  : SessionStart payload JSON ({session_id, cwd, source, ...}). Read
#              and ignored — identity comes from env, not the payload.
#   - stdout : on success, a single-line JSON object
#                {"hookSpecificOutput":{"hookEventName":"SessionStart",
#                 "additionalContext":"<text>"}}
#              "additionalContext" is injected into the model's context.
#   - "do nothing": exit 0 with empty stdout (any error path does this — a hook
#              failure must never block the Codex session from starting).
#
# Env vars (same names as the Claude hooks):
#   RELAY_AGENT_NAME         — agent name (REQUIRED; no default — without it we
#                              cannot register a meaningful identity, so we no-op)
#   RELAY_AGENT_ROLE         — agent role (default: "user")
#   RELAY_AGENT_CAPABILITIES — comma-separated (default: empty)
#   RELAY_HTTP_HOST          — daemon host (default: 127.0.0.1)
#   RELAY_HTTP_PORT          — daemon port (default: 3777)
#   RELAY_AGENT_TOKEN        — existing token for re-register (optional; the
#                              daemon mints one on first register and we vault it)
#
# Example ~/.codex/config.toml:
#   [[hooks.SessionStart]]
#   matcher = "startup|resume"
#   [[hooks.SessionStart.hooks]]
#   type = "command"
#   command = "/path/to/bot-relay-mcp/hooks/codex/codex-session-start.sh"
#
# Setup walkthrough: docs/agents/codex-autowake.md

set -u

# Drain stdin (the SessionStart payload) so the writer never blocks on a full
# pipe. We don't need any field from it — identity is env-derived.
cat >/dev/null 2>&1 || true

AGENT_NAME="${RELAY_AGENT_NAME:-}"
AGENT_ROLE="${RELAY_AGENT_ROLE:-user}"
AGENT_CAPS="${RELAY_AGENT_CAPABILITIES:-}"
HTTP_HOST="${RELAY_HTTP_HOST:-127.0.0.1}"
HTTP_PORT="${RELAY_HTTP_PORT:-3777}"

# --- Guard + input validation (same allowlist as check-relay.sh) ------------
# Any rejection → silent no-op (exit 0, empty stdout). A SessionStart hook must
# never abort the session.
[ -z "$AGENT_NAME" ] && exit 0
echo "$AGENT_NAME" | grep -Eq '^[A-Za-z0-9_.-]{1,64}$' || exit 0
echo "$AGENT_ROLE" | grep -Eq '^[A-Za-z0-9_.-]{1,64}$' || AGENT_ROLE="user"
if [ -n "$AGENT_CAPS" ]; then
  if [ ${#AGENT_CAPS} -gt 256 ] || ! echo "$AGENT_CAPS" | grep -Eq '^[A-Za-z0-9_.,-]+$'; then
    AGENT_CAPS=""
  fi
fi
echo "$HTTP_HOST" | grep -Eq '^[A-Za-z0-9_.:-]{1,253}$' || exit 0
echo "$HTTP_PORT" | grep -Eq '^[0-9]{1,5}$' || exit 0

# --- Vault helpers (shared with the Claude hooks; one identity model) -------
HOOKS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$HOOKS_DIR/_vault-helpers.sh" ]; then
  # shellcheck source=../_vault-helpers.sh
  . "$HOOKS_DIR/_vault-helpers.sh"
fi

# Vault-first: if no token in env but one is on disk for this agent, reuse it
# (lossless restart — same as check-relay.sh).
if [ -z "${RELAY_AGENT_TOKEN:-}" ] && command -v read_relay_token_from_vault >/dev/null 2>&1; then
  if VAULT_TOKEN=$(read_relay_token_from_vault "$AGENT_NAME" 2>/dev/null); then
    export RELAY_AGENT_TOKEN="$VAULT_TOKEN"
  fi
fi

# --- Register via HTTP register_agent ---------------------------------------
# Auth-free on first register (the daemon mints a fresh token); the caller's
# token is carried when present so an active re-register is accepted. If the
# daemon is unreachable we skip silently and still emit the inbox nudge — the
# agent's own get_messages call will surface a clear auth/registration error.

# v2.14.1 — the agent's OWN process PID (this codex CLI) for presence
# liveness. Matches on COMM (executable basename, NO path) so a repo dir named
# "Claude"/"Codex" can't false-hit; starts from the hook's PARENT (the hook is
# never the agent); excludes the relay's own node by its entrypoint. Empty →
# agent_pid omitted → age-based fallback. POSIX only. Mirrors check-relay.sh.
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

# v2.14.1 — start-time token (PID-reuse guard). LC_ALL=C so it matches the
# daemon's probe byte-for-byte (src/liveness.ts also pins LC_ALL=C).
relay_pid_start() {
  local pid="$1"
  [ -n "$pid" ] || return
  LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

build_caps_json() {
  if [ -z "$AGENT_CAPS" ]; then printf '[]'; return; fi
  echo "$AGENT_CAPS" | awk -F',' '{
    printf "[";
    for (i=1; i<=NF; i++) {
      gsub(/^ +| +$/, "", $i);
      if ($i !~ /^[A-Za-z0-9_.-]+$/) next;
      printf "%s\"%s\"", (i==1 ? "" : ","), $i;
    }
    printf "]";
  }'
}

# Emit the SessionStart additionalContext JSON, then exit 0. Defined as a
# function so every code path (incl. "curl missing") funnels through it.
emit_context_and_exit() {
  local ctx
  ctx="You are bot-relay agent \"${AGENT_NAME}\" (role: ${AGENT_ROLE}) on a local relay at ${HTTP_HOST}:${HTTP_PORT}. Check your inbox now: call get_messages(agent_name=\"${AGENT_NAME}\", status=\"pending\") and act on anything you find. A Stop hook will keep waking you when new relay mail arrives."
  if command -v python3 >/dev/null 2>&1; then
    CTX="$ctx" AN="$AGENT_NAME" python3 -c '
import json, os, sys
sys.stdout.write(json.dumps({
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": os.environ.get("CTX", ""),
  }
}))
' 2>/dev/null
  fi
  exit 0
}

# curl is required to register; without it, still emit the inbox nudge so the
# model checks mail (its own get_messages call surfaces any error).
command -v curl >/dev/null 2>&1 || emit_context_and_exit

CAPS_JSON=$(build_caps_json)

# v2.14.1 — capture the agent's own process for presence (best-effort).
RELAY_AGENT_PID=$(relay_agent_pid 2>/dev/null || printf '')
RELAY_AGENT_PID_START=""
[ -n "$RELAY_AGENT_PID" ] && RELAY_AGENT_PID_START=$(relay_pid_start "$RELAY_AGENT_PID" 2>/dev/null || printf '')

REG_HEADERS=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
[ -n "${RELAY_AGENT_TOKEN:-}" ] && REG_HEADERS+=(-H "X-Agent-Token: ${RELAY_AGENT_TOKEN}")

REG_BODY=$(curl -s -m 4 -X POST "http://${HTTP_HOST}:${HTTP_PORT}/mcp" \
  "${REG_HEADERS[@]}" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"register_agent\",\"arguments\":{\"name\":\"${AGENT_NAME}\",\"role\":\"${AGENT_ROLE}\",\"capabilities\":${CAPS_JSON}${RELAY_AGENT_PID:+,\"agent_pid\":${RELAY_AGENT_PID}}${RELAY_AGENT_PID_START:+,\"agent_pid_start\":\"${RELAY_AGENT_PID_START}\"}}}}" \
  2>/dev/null)

# Capture a freshly-minted token (first register only) and persist it to the
# vault so the stdio MCP server's resolveToken can authenticate this agent's
# later get_messages calls. SSE-wrapped + JSON-stringified shape: \"key\": value
# (escaped quote + space after colon) — same parser as check-relay.sh.
if [ -n "$REG_BODY" ] && command -v write_relay_token_to_vault >/dev/null 2>&1; then
  REG_TOKEN=$(echo "$REG_BODY" | grep -oE '\\"agent_token\\":[[:space:]]*\\"[A-Za-z0-9_=.-]{8,128}\\"' | head -1 | sed -E 's/.*\\"([A-Za-z0-9_=.-]{8,128})\\"$/\1/')
  if [ -n "$REG_TOKEN" ]; then
    write_relay_token_to_vault "$AGENT_NAME" "$REG_TOKEN" >/dev/null 2>&1 || true
  fi
fi

emit_context_and_exit
