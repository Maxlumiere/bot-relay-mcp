#!/bin/bash
# bot-relay-mcp: PostToolUse hook — near-real-time mailbox check (v1.8)
#
# Fires after every Claude Code tool call. If this agent (RELAY_AGENT_NAME)
# has pending mail in the relay, surface it as additionalContext so the
# running Claude Code session sees it WITHOUT waiting for SessionStart or a
# human-bridged "check mail".
#
# Transport selection:
#   1. HTTP (preferred) — if relay daemon responds on RELAY_HTTP_HOST:RELAY_HTTP_PORT
#      AND RELAY_AGENT_TOKEN is set. Goes through full auth/rate-limit/audit pipeline.
#   2. Sqlite direct (fallback) — direct read + mark-as-read on RELAY_DB_PATH.
#      Used when HTTP is unreachable or when no token is present (stdio-only setups).
#
# Output contract (Claude Code PostToolUse hook):
#   - No mail OR any error → empty stdout, exit 0. Silent no-op.
#   - Mail present → single-line JSON to stdout with additionalContext, exit 0.
#   Stderr is operator-visible; use sparingly.
#
# Security / discipline:
#   - Never re-register. SessionStart handles that.
#   - Validate every env-var input against an allowlist BEFORE use.
#   - Never write partial JSON, error text, or stack traces to stdout.
#   - 2s total budget (1s health probe + 2s get_messages). Claude Code enforces
#     hook timeout from settings.json on top of this.
#   - No stdin reading (the tool-call payload is ignored — mail check is tool-agnostic).

# v2.0 final (#19): self-check for path truncation. Stderr warn so operators
# see setup mistakes without breaking the hook contract (stdout stays clean).
# VERDICT BY CONSTRUCTION — first executable code, so none of the `exit 0`
# guards below can leave this session unaccounted for. STDERR, not stdout: this
# hook's stdout is a hookSpecificOutput JSON object the harness PARSES, and a
# trailing bare line would corrupt it — an alarm that corrupts the channel it
# rides on is worse than no alarm. Shared primitive; see hooks/_verdict.sh.
RELAY_VERDICT_STREAM=stderr
RELAY_VERDICT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_verdict.sh
if [ -f "$RELAY_VERDICT_DIR/_verdict.sh" ]; then
  . "$RELAY_VERDICT_DIR/_verdict.sh"
fi

if [[ "$0" != *"/bot-relay-mcp/hooks/"* ]]; then
  echo "[bot-relay hook WARNING] \$0 does not contain '/bot-relay-mcp/hooks/' — the install path may be truncated. Quote the command string in .claude/settings.json if the path contains spaces. \$0='$0'" >&2
fi

AGENT_NAME="${RELAY_AGENT_NAME:-}"
AGENT_TOKEN="${RELAY_AGENT_TOKEN:-}"
HTTP_PORT="${RELAY_HTTP_PORT:-3777}"
HTTP_HOST="${RELAY_HTTP_HOST:-127.0.0.1}"
# v2.6.1 — vault helpers + DB-path resolution sourced from a single file.
# Mirrors src/instance.ts:resolveInstanceDbPath + src/token-store.ts:
# resolveAgentVaultDir + FileTokenStore.{pathFor,read,write}. Drift surfaces
# directly as a test failure in tests/v2-6-1-token-store.test.ts (which
# sources this same file) — no inline-copy hide-out.
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_vault-helpers.sh
. "$HOOKS_DIR/_vault-helpers.sh"
DB_PATH=$(resolve_relay_db_path) || {
  # Malformed active-instance content — refuse to fall back silently. A
  # broken setup should be loud, not hidden under legacy. The hook's
  # other side effects (HTTP register/health, mail delivery) are gated
  # behind DB_PATH being readable below; null DB_PATH falls cleanly to
  # the existing "no DB → exit 0" path.
  DB_PATH=""
}
MAX_MESSAGES="${RELAY_HOOK_MAX_MESSAGES:-20}"

# --- Guard: no agent name means nothing to do ---

if [ -z "$AGENT_NAME" ]; then
  exit 0
fi

# --- Input validation (security hardening — same allowlist as check-relay.sh) ---

if ! echo "$AGENT_NAME" | grep -Eq '^[A-Za-z0-9_.-]{1,64}$'; then
  exit 0
fi

# v2.6.1 — vault hydration. If the env-supplied RELAY_AGENT_TOKEN is empty
# but a valid token sits in the vault for this agent, use it for HTTP-path
# authentication. Sqlite-direct fallback path below does not need a token.
if [ -z "$AGENT_TOKEN" ]; then
  if VAULT_TOKEN=$(read_relay_token_from_vault "$AGENT_NAME"); then
    AGENT_TOKEN="$VAULT_TOKEN"
    export RELAY_AGENT_TOKEN="$VAULT_TOKEN"
  fi
fi

if ! echo "$HTTP_HOST" | grep -Eq '^[A-Za-z0-9_.:-]{1,253}$'; then
  exit 0
fi

if ! echo "$HTTP_PORT" | grep -Eq '^[0-9]{1,5}$' || [ "$HTTP_PORT" -lt 1 ] || [ "$HTTP_PORT" -gt 65535 ]; then
  exit 0
fi

if ! echo "$MAX_MESSAGES" | grep -Eq '^[0-9]{1,3}$' || [ "$MAX_MESSAGES" -lt 1 ] || [ "$MAX_MESSAGES" -gt 100 ]; then
  MAX_MESSAGES=20
fi

# Token shape: base64url-ish, 8-128 chars, strictly alnum/_/=/./- (no whitespace,
# no control chars — blocks header-injection via newlines in env var).
if [ -n "$AGENT_TOKEN" ]; then
  if ! echo "$AGENT_TOKEN" | grep -Eq '^[A-Za-z0-9_=.-]{8,128}$'; then
    AGENT_TOKEN=""
  fi
fi

# DB path must live under $HOME or a test-tmp location — same policy as check-relay.sh.
RESOLVED_DB_PATH=$(cd "$(dirname "$DB_PATH")" 2>/dev/null && pwd)/$(basename "$DB_PATH")
if [ -z "$RESOLVED_DB_PATH" ] || { [[ "$RESOLVED_DB_PATH" != "$HOME"/* ]] && [[ "$RESOLVED_DB_PATH" != /tmp/* ]] && [[ "$RESOLVED_DB_PATH" != /private/tmp/* ]] && [[ "$RESOLVED_DB_PATH" != /var/folders/* ]]; }; then
  # DB path unusable — still try HTTP if available, but skip sqlite fallback.
  DB_PATH=""
else
  DB_PATH="$RESOLVED_DB_PATH"
fi

# --- Helper: emit the hook JSON with readable additionalContext ---
# Arg $1 is the plain-text block to inject. Uses python3 to escape safely.
emit_hook_json() {
  local body="$1"
  if [ -z "$body" ]; then return 0; fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi
  # Pass body via env var (not argv) to avoid any shell-quote surprises.
  BODY="$body" python3 -c '
import json, os, sys
out = {
  "continue": True,
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": os.environ.get("BODY", ""),
  },
}
sys.stdout.write(json.dumps(out))
' 2>/dev/null
}

# --- HTTP path (preferred) ---

http_try() {
  [ -z "$AGENT_TOKEN" ] && return 1
  command -v curl >/dev/null 2>&1 || return 1
  command -v python3 >/dev/null 2>&1 || return 1

  # Probe /health with a tight budget. If no response in 1s, assume no daemon.
  if ! curl -fsS --max-time 1 "http://${HTTP_HOST}:${HTTP_PORT}/health" >/dev/null 2>&1; then
    return 1
  fi

  # Compose the get_messages JSON-RPC payload via python3 so we don't have to
  # shell-escape AGENT_NAME/AGENT_TOKEN manually (they are already validated,
  # but json.dumps is belt-and-suspenders).
  local payload
  payload=$(AN="$AGENT_NAME" AT="$AGENT_TOKEN" LIM="$MAX_MESSAGES" python3 -c '
import json, os
print(json.dumps({
  "jsonrpc": "2.0", "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_messages",
    "arguments": {
      "agent_name": os.environ["AN"],
      "status": "pending",
      "limit": int(os.environ["LIM"]),
      "agent_token": os.environ["AT"],
    },
  },
}))
' 2>/dev/null) || return 1

  local response
  response=$(curl -fsS --max-time 2 \
    -X POST "http://${HTTP_HOST}:${HTTP_PORT}/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "X-Agent-Token: $AGENT_TOKEN" \
    --data "$payload" 2>/dev/null) || return 1

  # Parse the SSE-framed JSON-RPC result, extract messages array, format.
  RESP="$response" AN="$AGENT_NAME" python3 <<'PYEOF' 2>/dev/null
import json, os, sys

raw = os.environ.get("RESP", "").strip()
# StreamableHTTP wraps the JSON-RPC response in SSE: "event: message\ndata: {..}".
# Extract the data: line(s) — pick the first.
payload = None
for line in raw.splitlines():
    line = line.strip()
    if line.startswith("data:"):
        payload = line[5:].strip()
        break
if payload is None:
    # Maybe the server returned plain JSON (non-SSE). Try parsing whole body.
    payload = raw
try:
    rpc = json.loads(payload)
except Exception:
    sys.exit(1)
# Drill into result.content[0].text which is itself a JSON string.
try:
    inner = rpc["result"]["content"][0]["text"]
    data = json.loads(inner)
except Exception:
    sys.exit(1)
msgs = data.get("messages", [])
if not msgs:
    sys.exit(0)  # empty — success but nothing to surface
lines = [f"[RELAY] New mail for {os.environ['AN']} ({len(msgs)} message{'s' if len(msgs) != 1 else ''}):"]
for m in msgs:
    prio = m.get("priority", "normal")
    frm = m.get("from_agent", "?")
    when = m.get("created_at", "")
    content = m.get("content", "")
    # Trim absurdly long messages to keep context sane — 2KB per message cap.
    if len(content) > 2048:
        content = content[:2048] + "... [truncated]"
    lines.append(f"  [{prio}] from {frm} at {when}:")
    for l in content.splitlines() or [""]:
        lines.append(f"    {l}")
sys.stdout.write("\n".join(lines))
PYEOF
  local rc=$?
  return $rc
}

# --- Sqlite direct fallback ---

sqlite_try() {
  [ -z "$DB_PATH" ] && return 1
  [ -f "$DB_PATH" ] || return 1
  command -v sqlite3 >/dev/null 2>&1 || return 1

  # Select pending messages for this agent into a piped format: id|from|prio|created|content
  # Content may contain newlines, so use a field-separator SELECT then parse in python3.
  # -separator chosen to be a control char unlikely in content.
  local rows
  rows=$(sqlite3 -separator $'\x1f' -newline $'\x1e' "$DB_PATH" <<SQL 2>/dev/null
.parameter set :name '$AGENT_NAME'
.parameter set :lim $MAX_MESSAGES
SELECT id, from_agent, priority, created_at, content
FROM messages WHERE to_agent = :name AND status = 'pending'
ORDER BY created_at DESC LIMIT :lim;
SQL
)
  if [ -z "$rows" ]; then
    return 0  # empty — nothing to surface
  fi

  # Parse rows in python3. Emit two sections:
  #   "<<IDS>> id1 id2 ...\n<<BODY>>\n<text>"
  # Shell splits them back out via sed so mark-as-read knows which IDs to update.
  local combined
  combined=$(ROWS="$rows" AN="$AGENT_NAME" python3 <<'PYEOF' 2>/dev/null
import os, sys
raw = os.environ.get("ROWS", "")
if not raw.strip():
    sys.exit(0)
records = []
for rec in raw.split("\x1e"):
    rec = rec.strip("\n\r")
    if not rec:
        continue
    parts = rec.split("\x1f", 4)
    if len(parts) != 5:
        continue
    records.append(parts)
if not records:
    sys.exit(0)
lines = [f"[RELAY] New mail for {os.environ['AN']} ({len(records)} message{'s' if len(records) != 1 else ''}):"]
for (_, frm, prio, when, content) in records:
    if len(content) > 2048:
        content = content[:2048] + "... [truncated]"
    lines.append(f"  [{prio}] from {frm} at {when}:")
    for l in content.splitlines() or [""]:
        lines.append(f"    {l}")
ids = " ".join(r[0] for r in records)
# Sentinel: "<<IDS>> id1 id2 ...\n<<BODY>>\n<text>"
sys.stdout.write("<<IDS>> " + ids + "\n<<BODY>>\n" + "\n".join(lines))
PYEOF
)
  if [ -z "$combined" ]; then
    return 0
  fi

  local ids_line
  ids_line=$(echo "$combined" | sed -n '1s/^<<IDS>> //p')
  body=$(echo "$combined" | sed -n '/^<<BODY>>$/,$p' | sed '1d')

  if [ -z "$body" ]; then
    return 0
  fi

  # Mark the specific IDs we surfaced as read. Validate each ID is UUID-shape
  # before interpolating to avoid any SQL surprise (defense-in-depth — IDs come
  # from our own DB so should already be UUIDs, but be strict).
  for id in $ids_line; do
    if echo "$id" | grep -Eq '^[A-Za-z0-9-]{8,64}$'; then
      sqlite3 "$DB_PATH" <<SQL 2>/dev/null
.parameter set :id '$id'
UPDATE messages SET status = 'read' WHERE id = :id AND status = 'pending';
SQL
    fi
  done

  echo "$body"
  return 0
}

# --- v2.15.0: presence self-heal (narrow, metadata-only) ---
#
# Restamp our liveness anchor (agent_pid + start-time) via the narrow
# report_liveness tool IF the stored anchor doesn't match our CURRENT process —
# so an old/existing session that registered before the anchor mechanism
# becomes probe-able WITHOUT a re-register (register_agent rotates session_id +
# can re-surface already-read mail; report_liveness touches only agent_pid +
# start). Gated on a real mismatch → zero churn in steady state. Best-effort +
# silent: any failure is a no-op that never affects the hook contract or the
# mail delivery below. relay_agent_pid/relay_pid_start come from _vault-helpers.sh.
liveness_self_heal() {
  [ -z "$AGENT_TOKEN" ] && return 0
  command -v curl >/dev/null 2>&1 || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  command -v relay_agent_pid >/dev/null 2>&1 || return 0
  local cur_pid cur_start stored_pid stored_start
  cur_pid=$(relay_agent_pid 2>/dev/null || printf '')
  [ -z "$cur_pid" ] && return 0
  cur_start=$(relay_pid_start "$cur_pid" 2>/dev/null || printf '')
  # Read the stored anchor. Requires the sqlite fast-path; if unavailable we
  # can't compute the gate → skip (SessionStart still carries the anchor).
  { [ -n "$DB_PATH" ] && [ -f "$DB_PATH" ] && command -v sqlite3 >/dev/null 2>&1; } || return 0
  stored_pid=$(sqlite3 "$DB_PATH" <<SQL 2>/dev/null
.parameter set :name '$AGENT_NAME'
SELECT IFNULL(agent_pid,'') FROM agents WHERE name = :name LIMIT 1;
SQL
)
  stored_start=$(sqlite3 "$DB_PATH" <<SQL 2>/dev/null
.parameter set :name '$AGENT_NAME'
SELECT IFNULL(agent_pid_start,'') FROM agents WHERE name = :name LIMIT 1;
SQL
)
  # Gate: restamp on a real mismatch — pid changed, OR we have a READABLE
  # current start that differs from / fills the stored one. Do NOT downgrade a
  # present stored start to empty when the current start is transiently
  # unreadable (stays alive-by-PID; next run corrects it). Steady state = no-op.
  local need=0
  if [ "$stored_pid" != "$cur_pid" ]; then
    need=1
  elif [ -n "$cur_start" ] && [ "$stored_start" != "$cur_start" ]; then
    need=1
  fi
  [ "$need" -eq 0 ] && return 0
  # Only over a reachable daemon (tight budget).
  curl -fsS --max-time 1 "http://${HTTP_HOST}:${HTTP_PORT}/health" >/dev/null 2>&1 || return 0
  local payload
  payload=$(AN="$AGENT_NAME" AT="$AGENT_TOKEN" PID="$cur_pid" ST="$cur_start" python3 -c '
import json, os
args = {"agent_name": os.environ["AN"], "agent_pid": int(os.environ["PID"]), "agent_token": os.environ["AT"]}
st = os.environ.get("ST", "")
if st:
    args["agent_pid_start"] = st
print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"report_liveness","arguments":args}}))
' 2>/dev/null) || return 0
  curl -fsS --max-time 2 -X POST "http://${HTTP_HOST}:${HTTP_PORT}/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "X-Agent-Token: $AGENT_TOKEN" \
    --data "$payload" >/dev/null 2>&1 || return 0
  return 0
}

# --- Main: self-heal presence (best-effort), then try HTTP, fall back to sqlite ---

liveness_self_heal

BODY=$(http_try)
RC=$?
READ_OK=0
[ $RC -eq 0 ] && READ_OK=1
if [ $RC -ne 0 ] || [ -z "$BODY" ]; then
  BODY=$(sqlite_try)
  # sqlite_try returning 0 with empty BODY = empty mailbox, which is fine.
  [ $? -eq 0 ] && READ_OK=1
fi

# THE ONLY UPGRADE. Positive evidence is a mailbox read that SUCCEEDED — via
# HTTP or via the sqlite fallback. An empty BODY alone is NOT evidence: it is
# ambiguous between "no mail" and "could not read", and treating ambiguity as
# health is the exact conflation this whole mechanism removes. If both paths
# failed, CANNOT-JUDGE stands.
if [ "$READ_OK" -eq 1 ] && command -v relay_verdict_set >/dev/null 2>&1; then
  relay_verdict_set "HEALTHY" "mailbox read succeeded" " agent=\"${AGENT_NAME:-?}\""
fi

if [ -z "$BODY" ]; then
  exit 0
fi

emit_hook_json "$BODY"
exit 0
