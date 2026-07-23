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
# relay identity model. As of v2.16.3 it ALSO sends the Tether v0.3 PID-handshake
# (host_shell_pids + host_id + terminal_title_ref), byte-parity with check-relay.sh,
# so Tether can PID-bind a Codex terminal and wake it token-free — exactly like
# Claude. (Tether went LLM-agnostic in v0.4.0; the old "Claude/VSCode-only" note
# was frozen from before that and was the root cause of "Tether stopped waking Codex.")
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

# VERDICT BY CONSTRUCTION — first executable code after `set -u`, so no exit
# path below can leave this session unaccounted for. LLM-AGNOSTIC PARITY: a
# Codex agent that comes up mute was, until now, exactly as invisible as a
# Claude agent was before the Claude hook got this. Shipping observability that
# only worked for one CLI would re-open the asymmetry the July autowake arc
# closed. Shared implementation — see hooks/_verdict.sh for the rationale, the
# two invariants, and the honest boundary.
# STDERR, not stdout: this hook's stdout is a hookSpecificOutput JSON object
# that Codex parses. A trailing bare verdict line would corrupt it.
RELAY_VERDICT_STREAM=stderr
RELAY_VERDICT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../_verdict.sh
if [ -f "$RELAY_VERDICT_DIR/_verdict.sh" ]; then
  . "$RELAY_VERDICT_DIR/_verdict.sh"
fi

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

# v2.15.0 — relay_agent_pid + relay_pid_start now live in _vault-helpers.sh
# (sourced above), shared with check-relay.sh + post-tool-use-check.sh.

build_caps_json() {
  if [ -z "$AGENT_CAPS" ]; then printf '[]'; return; fi
  echo "$AGENT_CAPS" | awk -F',' '{
    printf "[";
    n = 0;
    for (i=1; i<=NF; i++) {
      gsub(/^ +| +$/, "", $i);
      if ($i !~ /^[A-Za-z0-9_.-]+$/) continue;
      printf "%s\"%s\"", (n++ ? "," : ""), $i;
    }
    printf "]";
  }'
}

# Emit the SessionStart additionalContext JSON, then exit 0. Defined as a
# function so every code path (incl. "curl missing") funnels through it.
emit_context_and_exit() {
  local ctx
  ctx="You are bot-relay agent \"${AGENT_NAME}\" (role: ${AGENT_ROLE}) on a local relay at ${HTTP_HOST}:${HTTP_PORT}. Check your inbox now: call get_messages(agent_name=\"${AGENT_NAME}\", status=\"pending\") and act on anything you find. Tether wakes this terminal when new relay mail arrives — no polling, no idle turns."
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

# v2.16.3 — Tether v0.3 PID-handshake (shared helpers from _vault-helpers.sh).
# Best-effort: empty / [] → the field is omitted (graceful — registration never
# fails over the handshake, Tether falls back to name matching). Byte-parity with
# check-relay.sh so a Codex agent's host_id agrees with the extension's reader.
RELAY_HOST_PID_CHAIN=$(relay_pid_chain 2>/dev/null || printf '')
[ "$RELAY_HOST_PID_CHAIN" = "[]" ] && RELAY_HOST_PID_CHAIN=""
RELAY_HOST_GUID=$(relay_machine_guid 2>/dev/null || printf '')
# terminal_title_ref: only sent when the launcher exports RELAY_TERMINAL_TITLE
# (the name-match fallback path); omitted otherwise. HARDENED — validate against
# the SAME allowlist the server enforces (TERMINAL_TITLE_REF_PATTERN in
# src/types.ts: [A-Za-z0-9_.- ], max 100) and DROP the title if it doesn't match.
# A hostile title (quote / backslash / newline / JSON fragment) would otherwise
# either malform the register JSON or be rejected server-side, failing the WHOLE
# register — taking host_shell_pids/host_id down with it (silent wake breakage).
# Dropping it keeps the handshake landing. `[[ =~ ]]` matches the whole value
# (newline-safe, unlike line-based grep); an allowlisted title has no JSON-special
# chars, so the raw interpolation below is safe and byte-identical to
# check-relay.sh for every well-formed title.
RELAY_TERMINAL_TITLE_VALUE="${RELAY_TERMINAL_TITLE:-}"
RELAY_TERMINAL_TITLE_RE='^[A-Za-z0-9_. -]{1,100}$'
if [ -n "$RELAY_TERMINAL_TITLE_VALUE" ] && ! [[ "$RELAY_TERMINAL_TITLE_VALUE" =~ $RELAY_TERMINAL_TITLE_RE ]]; then
  RELAY_TERMINAL_TITLE_VALUE=""
fi

# v2.14.1 — capture the agent's own process for presence (best-effort).
RELAY_AGENT_PID=$(relay_agent_pid 2>/dev/null || printf '')
RELAY_AGENT_PID_START=""
[ -n "$RELAY_AGENT_PID" ] && RELAY_AGENT_PID_START=$(relay_pid_start "$RELAY_AGENT_PID" 2>/dev/null || printf '')

REG_HEADERS=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
[ -n "${RELAY_AGENT_TOKEN:-}" ] && REG_HEADERS+=(-H "X-Agent-Token: ${RELAY_AGENT_TOKEN}")

# v2.16.4 cold-start handoff: if bin/codex-relay pre-registered this launch it
# exports RELAY_LAUNCH_SESSION = the session_id it registered. SKIP our register
# ONLY when that marker matches OUR row's CURRENT session_id — proof THIS
# launch's launcher registered THIS agent's row. NEVER skip on DB-state alone:
# a stale / other-terminal live session would otherwise let us stamp our pid onto
# someone else's row (the cross-terminal corruption the collision guard exists to
# prevent). No marker / mismatch / unreadable → register normally (fallback = the
# pre-launcher first-turn behavior, WITH host_shell_pids). Reading OUR row's
# session_id (filtered by AGENT_NAME) also means a marker for a DIFFERENT agent
# can never make us skip (no cross-agent leakage).
SKIP_REGISTER_HANDOFF=0
if echo "${RELAY_LAUNCH_SESSION:-}" | grep -Eq '^[0-9a-fA-F-]{8,64}$'; then
  DISCOVER_BODY=$(curl -fsS --connect-timeout 1 --max-time 2 -X POST "http://${HTTP_HOST}:${HTTP_PORT}/mcp" \
    "${REG_HEADERS[@]}" \
    --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"discover_agents","arguments":{}}}' 2>/dev/null) || DISCOVER_BODY=""
  if [ -n "$DISCOVER_BODY" ] && command -v python3 >/dev/null 2>&1; then
    CUR_SID=$(RESP="$DISCOVER_BODY" AN="$AGENT_NAME" python3 -c '
import json, os
raw = (os.environ.get("RESP", "") or "").strip()
payload = None
for line in raw.splitlines():
    line = line.strip()
    if line.startswith("data:"):
        payload = line[5:].strip(); break
if payload is None:
    payload = raw
try:
    rpc = json.loads(payload)
    inner = json.loads(rpc["result"]["content"][0]["text"])
    for a in inner.get("agents", []):
        if a.get("name") == os.environ["AN"]:
            print(a.get("session_id") or "")
            break
except Exception:
    pass
' 2>/dev/null)
    if [ -n "$CUR_SID" ] && [ "$CUR_SID" = "$RELAY_LAUNCH_SESSION" ]; then
      SKIP_REGISTER_HANDOFF=1
    fi
  fi
fi

if [ "$SKIP_REGISTER_HANDOFF" -eq 0 ]; then
  REG_BODY=$(curl -s -m 4 -X POST "http://${HTTP_HOST}:${HTTP_PORT}/mcp" \
    "${REG_HEADERS[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"register_agent\",\"arguments\":{\"name\":\"${AGENT_NAME}\",\"role\":\"${AGENT_ROLE}\",\"capabilities\":${CAPS_JSON},\"cli_profile\":\"codex\"${RELAY_TERMINAL_TITLE_VALUE:+,\"terminal_title_ref\":\"${RELAY_TERMINAL_TITLE_VALUE}\"}${RELAY_HOST_PID_CHAIN:+,\"host_shell_pids\":${RELAY_HOST_PID_CHAIN}}${RELAY_HOST_GUID:+,\"host_id\":\"${RELAY_HOST_GUID}\"}${RELAY_AGENT_PID:+,\"agent_pid\":${RELAY_AGENT_PID}}${RELAY_AGENT_PID_START:+,\"agent_pid_start\":\"${RELAY_AGENT_PID_START}\"}}}}" \
    2>/dev/null)

  # Capture a freshly-minted token (first register only) and persist it to the
  # vault so the stdio MCP server's resolveToken can authenticate this agent's
  # later get_messages calls. SSE-wrapped + JSON-stringified shape: \"key\": value
  # (escaped quote + space after colon) — same parser as check-relay.sh.
  # The ONLY upgrade path: the relay answered our register call, which is
  # direct evidence this session can reach it. A curl timeout, a refused
  # connection or an empty body all leave CANNOT-JUDGE standing.
  if [ -n "$REG_BODY" ] && command -v relay_verdict_set >/dev/null 2>&1; then
    relay_verdict_set "HEALTHY" "registered with the relay over HTTP" " agent=\"$AGENT_NAME\""
  fi
  if [ -n "$REG_BODY" ] && command -v write_relay_token_to_vault >/dev/null 2>&1; then
    REG_TOKEN=$(echo "$REG_BODY" | grep -oE '\\"agent_token\\":[[:space:]]*\\"[A-Za-z0-9_=.-]{8,128}\\"' | head -1 | sed -E 's/.*\\"([A-Za-z0-9_=.-]{8,128})\\"$/\1/')
    if [ -n "$REG_TOKEN" ]; then
      write_relay_token_to_vault "$AGENT_NAME" "$REG_TOKEN" >/dev/null 2>&1 || true
    fi
  fi
fi

emit_context_and_exit
