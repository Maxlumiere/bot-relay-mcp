#!/bin/bash
# bot-relay-mcp: Codex CLI Stop hook — turn-end auto-wake
#
# The Codex port of `hooks/stop-check.sh`, but it does more than surface mail:
# it uses Codex's Stop "decision: block" continuation to AUTO-WAKE the agent.
# Where the Claude Stop hook injects mail as context for the *next* turn, Codex
# lets a Stop hook return {"decision":"block","reason":"<text>"} and re-prompts
# the model immediately with <text> as a fresh user turn. That is what makes a
# Codex agent self-continue when relay mail arrives — no Tether, no human nudge.
#
# Behaviour on each turn-end:
#   * pending mail (>0)  → block with a "ping-off" prompt telling the model to
#                          call get_messages and act. (Mail is PEEKED, not
#                          consumed, so the model's own get_messages sees it.)
#   * no mail (==0)      → keep-alive: wait `backoff` seconds, then block with a
#                          re-check prompt so the agent stays awake for incoming
#                          mail. Bounded so it never runs away (see GUARD below).
#   * any error / relay unreachable / no identity → exit 0, empty stdout. A Stop
#                          hook failure must NEVER trap the agent in a loop.
#
# GUARD (never runs away):
#   The keep-alive loop is bounded two ways. (1) `backoff` (default 90s) paces
#   it — never a tight spin. (2) A per-session idle counter caps CONSECUTIVE
#   empty polls at `max_idle_polls` (default 40 ≈ 1h at 90s); at the cap the
#   hook stops (exit 0) and the agent rests until the next real turn or mail.
#   The counter resets whenever real work happens: it is only accumulated while
#   `stop_hook_active` is true (a genuine, non-forced turn-end starts a fresh
#   window), and the pending>0 path clears it. Set `max_idle_polls=0` for an
#   unbounded 24/7 loop (accepts the per-poll model-turn token cost).
#
# Codex hook contract:
#   - stdin  : Stop payload JSON, incl. {"stop_hook_active":bool,"session_id":..}
#   - stdout : {"decision":"block","reason":"<text>"} to continue, OR empty to stop.
#   - exit 0 always (errors are silent no-ops).
#
# Env vars:
#   RELAY_AGENT_NAME            — agent name (REQUIRED)
#   RELAY_AGENT_TOKEN           — token (env or per-instance vault) for get_messages auth
#   RELAY_HTTP_HOST / _PORT     — daemon (default 127.0.0.1:3777)
#   RELAY_CODEX_POLL_BACKOFF    — idle keep-alive wait, seconds (default 90)
#   RELAY_CODEX_MAX_IDLE_POLLS  — cap on consecutive empty polls (default 40; 0=unbounded)
#
# Pair with codex-session-start.sh. Setup: docs/agents/codex-autowake.md

set -u

AGENT_NAME="${RELAY_AGENT_NAME:-}"
AGENT_TOKEN="${RELAY_AGENT_TOKEN:-}"
HTTP_HOST="${RELAY_HTTP_HOST:-127.0.0.1}"
HTTP_PORT="${RELAY_HTTP_PORT:-3777}"
BACKOFF="${RELAY_CODEX_POLL_BACKOFF:-90}"
MAX_IDLE_POLLS="${RELAY_CODEX_MAX_IDLE_POLLS:-40}"

# --- Read the Stop payload from stdin (stop_hook_active + session_id) --------
STOP_HOOK_ACTIVE="false"
SESSION_ID=""
PAYLOAD="$(cat 2>/dev/null)"
if [ -n "$PAYLOAD" ] && command -v python3 >/dev/null 2>&1; then
  PARSED=$(PL="$PAYLOAD" python3 -c '
import json, os, sys, re
try:
    d = json.loads(os.environ.get("PL", "") or "{}")
except Exception:
    d = {}
active = "true" if d.get("stop_hook_active") is True else "false"
sid = str(d.get("session_id") or "")
sid = re.sub(r"[^A-Za-z0-9_.-]", "", sid)[:64]
sys.stdout.write(active + " " + sid)
' 2>/dev/null)
  STOP_HOOK_ACTIVE="${PARSED%% *}"
  SESSION_ID="${PARSED#* }"
  [ "$SESSION_ID" = "$STOP_HOOK_ACTIVE" ] && SESSION_ID=""
fi

# --- Guards + validation (same allowlist as the Claude hooks) ---------------
# Every rejection → exit 0 silent (never block on a bad/partial setup).
[ -z "$AGENT_NAME" ] && exit 0
echo "$AGENT_NAME" | grep -Eq '^[A-Za-z0-9_.-]{1,64}$' || exit 0
echo "$HTTP_HOST"  | grep -Eq '^[A-Za-z0-9_.:-]{1,253}$' || exit 0
echo "$HTTP_PORT"  | grep -Eq '^[0-9]{1,5}$' || exit 0
echo "$BACKOFF"        | grep -Eq '^[0-9]{1,5}$' || BACKOFF=90
echo "$MAX_IDLE_POLLS" | grep -Eq '^[0-9]{1,5}$' || MAX_IDLE_POLLS=40

command -v curl >/dev/null 2>&1 || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

# --- Token: env, else per-instance vault (shared with the Claude hooks) -----
HOOKS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "$AGENT_TOKEN" ] && [ -f "$HOOKS_DIR/_vault-helpers.sh" ]; then
  # shellcheck source=../_vault-helpers.sh
  . "$HOOKS_DIR/_vault-helpers.sh"
  if command -v read_relay_token_from_vault >/dev/null 2>&1; then
    if VAULT_TOKEN=$(read_relay_token_from_vault "$AGENT_NAME" 2>/dev/null); then
      AGENT_TOKEN="$VAULT_TOKEN"
    fi
  fi
fi
# get_messages requires auth; without a token we cannot count mail → no-op.
[ -z "$AGENT_TOKEN" ] && exit 0
echo "$AGENT_TOKEN" | grep -Eq '^[A-Za-z0-9_=.-]{8,128}$' || exit 0

# --- Probe the daemon + PEEK the pending count (no consume) ------------------
# Tight 1s health probe; 2s get_messages. peek=true leaves the mail unread so
# the model's own get_messages call still receives it.
curl -fsS --max-time 1 "http://${HTTP_HOST}:${HTTP_PORT}/health" >/dev/null 2>&1 || exit 0

REQ=$(AN="$AGENT_NAME" AT="$AGENT_TOKEN" python3 -c '
import json, os
print(json.dumps({
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{"name":"get_messages","arguments":{
    "agent_name":os.environ["AN"],"status":"pending","limit":50,
    "peek":True,"since":"24h","agent_token":os.environ["AT"]}}}))
' 2>/dev/null) || exit 0

RESP=$(curl -fsS --max-time 2 -X POST "http://${HTTP_HOST}:${HTTP_PORT}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Agent-Token: $AGENT_TOKEN" \
  --data "$REQ" 2>/dev/null) || exit 0

# Pending count from the SSE-framed JSON-RPC result. -1 on any parse failure.
PENDING=$(RESP="$RESP" python3 <<'PYEOF' 2>/dev/null
import json, os, sys
raw = (os.environ.get("RESP","") or "").strip()
payload = None
for line in raw.splitlines():
    line = line.strip()
    if line.startswith("data:"):
        payload = line[5:].strip(); break
if payload is None:
    payload = raw
try:
    rpc = json.loads(payload)
    inner = rpc["result"]["content"][0]["text"]
    data = json.loads(inner)
    msgs = data.get("messages", [])
    print(len(msgs) if isinstance(msgs, list) else 0)
except Exception:
    print(-1)
PYEOF
)
echo "$PENDING" | grep -Eq '^-?[0-9]+$' || exit 0
[ "$PENDING" -lt 0 ] && exit 0   # parse failure → no-op (don't block)

# --- Emit a Stop "block" continuation ---------------------------------------
emit_block() {
  REASON="$1" python3 -c '
import json, os, sys
sys.stdout.write(json.dumps({"decision":"block","reason":os.environ.get("REASON","")}))
' 2>/dev/null
}

# Per-session idle counter (bounds the keep-alive loop). Safe filename.
IDLE_DIR="${TMPDIR:-/tmp}"
IDLE_FILE="${IDLE_DIR%/}/relay-codex-idle-${AGENT_NAME}-${SESSION_ID:-nosession}"

if [ "$PENDING" -gt 0 ]; then
  # Real work — clear the idle window and wake the agent to act on it.
  rm -f "$IDLE_FILE" 2>/dev/null || true
  emit_block "ping-off — you have ${PENDING} new relay message(s). Call get_messages(agent_name=\"${AGENT_NAME}\", status=\"pending\"), act on them, then continue."
  exit 0
fi

# --- pending == 0: keep-alive poll, bounded ---------------------------------
COUNT=0
if [ "$STOP_HOOK_ACTIVE" = "true" ] && [ -f "$IDLE_FILE" ]; then
  COUNT=$(cat "$IDLE_FILE" 2>/dev/null)
  echo "$COUNT" | grep -Eq '^[0-9]{1,6}$' || COUNT=0
fi

if [ "$MAX_IDLE_POLLS" -gt 0 ] && [ "$COUNT" -ge "$MAX_IDLE_POLLS" ]; then
  # Cap reached — stop the loop and let the agent rest. It re-wakes on the next
  # real turn (SessionStart) or when an orchestrator sends mail.
  rm -f "$IDLE_FILE" 2>/dev/null || true
  echo "[bot-relay codex hook] idle keep-alive cap reached (${MAX_IDLE_POLLS} empty polls); resting. Send relay mail or start a turn to re-wake. Raise RELAY_CODEX_MAX_IDLE_POLLS (0=unbounded) to extend." >&2
  exit 0
fi

echo $((COUNT + 1)) > "$IDLE_FILE" 2>/dev/null || true
sleep "$BACKOFF"
emit_block "ping-off poll — no new relay mail. Nothing to do this cycle; staying awake for incoming mail. If you have other work queued, continue it; otherwise wait for the next check."
exit 0
