#!/bin/bash
# bot-relay-mcp: Stop hook — turn-end mailbox check (v2.1)
#
# Fires on every turn-end, regardless of whether the turn invoked any tool
# calls. Complements PostToolUse (which only fires after a tool call): a
# text-only turn doesn't trigger PostToolUse and would otherwise miss mail
# until the next tool call or SessionStart.
#
# If this agent (RELAY_AGENT_NAME) has pending mail in the relay, surface it
# as additionalContext so the running Claude Code session sees it on the NEXT
# turn without waiting for a SessionStart or a human-bridged "check mail".
#
# Transport selection:
#   1. HTTP (preferred) — if relay daemon responds on RELAY_HTTP_HOST:RELAY_HTTP_PORT
#      AND RELAY_AGENT_TOKEN is set. Goes through full auth/rate-limit/audit pipeline.
#   2. Sqlite direct (fallback) — direct read + mark-as-read on RELAY_DB_PATH.
#      Used when HTTP is unreachable or when no token is present (stdio-only setups).
#
# Output contract (Claude Code Stop hook):
#   - No mail OR any error → empty stdout, exit 0. Silent no-op.
#   - Mail present → single-line JSON to stdout with additionalContext and
#     hookEventName:"Stop", exit 0.
#   Stderr is operator-visible; use sparingly.
#
# Security / discipline:
#   - Never re-register. SessionStart handles that.
#   - Validate every env-var input against an allowlist BEFORE use.
#   - Never write partial JSON, error text, or stack traces to stdout.
#   - 2s total budget (1s health probe + 2s get_messages). Claude Code enforces
#     hook timeout from settings.json on top of this.
#   - No stdin reading (the Stop hook payload is ignored — mail check is event-agnostic).
#
# Honest limitation:
#   - Does NOT wake a truly idle terminal. If no turn is in progress, the hook
#     does not fire. For long-idle windows, use Layer 2 Managed Agent
#     (examples/managed-agent-reference/) or SessionStart + human attention.

# v2.0 final (#19): self-check for path truncation. Stderr warn so operators
# see setup mistakes without breaking the hook contract (stdout stays clean).
if [[ "$0" != *"/bot-relay-mcp/hooks/"* ]]; then
  echo "[bot-relay hook WARNING] \$0 does not contain '/bot-relay-mcp/hooks/' — the install path may be truncated. Quote the command string in .claude/settings.json if the path contains spaces. \$0='$0'" >&2
fi

AGENT_NAME="${RELAY_AGENT_NAME:-}"
AGENT_TOKEN="${RELAY_AGENT_TOKEN:-}"
HTTP_PORT="${RELAY_HTTP_PORT:-3777}"
HTTP_HOST="${RELAY_HTTP_HOST:-127.0.0.1}"
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
MAX_MESSAGES="${RELAY_HOOK_MAX_MESSAGES:-20}"

# --- Guard: no agent name means nothing to do ---

if [ -z "$AGENT_NAME" ]; then
  exit 0
fi

# --- Input validation (security hardening — same allowlist as check-relay.sh) ---

if ! echo "$AGENT_NAME" | grep -Eq '^[A-Za-z0-9_.-]{1,64}$'; then
  exit 0
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
    "hookEventName": "Stop",
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

# --- Main: try HTTP, fall back to sqlite ---

BODY=$(http_try)
RC=$?
if [ $RC -ne 0 ] || [ -z "$BODY" ]; then
  BODY=$(sqlite_try)
  # sqlite_try returning 0 with empty BODY = empty mailbox, which is fine.
fi

if [ -z "$BODY" ]; then
  exit 0
fi

emit_hook_json "$BODY"
exit 0
