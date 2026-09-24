#!/bin/bash
# bot-relay-mcp: PostToolUse hook — mid-task mail NOTICE (v1.8; peek-only since ADR-0037)
#
# Fires after every Claude Code tool call. If this agent (RELAY_AGENT_NAME)
# has unread mail in the relay, inject a short NOTICE as additionalContext:
# METADATA ONLY (the unread count, the highest priority, the sender names checked
# against [a-z0-9-], and the newest message's age). Never any message content,
# not even a first line, and never a read-mark. additionalContext is a
# HIGHER-TRUST channel than a get_messages tool result, so quoting a sender's
# words here would launder attacker-chosen text into it, and an excerpt stands in
# for actually reading the mail (design review, 24 Sep).
#
# ADR-0037 — ONLY THE MODEL MOVES MAIL TO READ. This hook used to DRAIN the
# mailbox (HTTP get_messages, or a sqlite UPDATE status='read') and inject the
# bodies. A hook cannot prove delivery: additionalContext has no acknowledgement,
# it can be truncated or dropped, and PostToolUse also fires for SUBAGENT tool
# calls. So mail was marked read while the model never saw it (measured
# 2026-09-15: a deploy GO landed in a subagent's context and vanished from the
# recipient's pending drain). Both paths now PEEK. The agent's own get_messages
# call is the delivery, and its tool result is the proof of receipt. Same
# contract as stop-check.sh (#124).
#
# Transport selection (both read-only):
#   1. HTTP (preferred) — get_messages with peek:true, if the daemon responds on
#      RELAY_HTTP_HOST:RELAY_HTTP_PORT AND a token is available. The same code
#      path as the agent's own drain minus the mark, so the notice clears exactly
#      when that drain takes the mail.
#   2. Sqlite direct (fallback) — a bare SELECT on RELAY_DB_PATH, mirroring
#      stop-check.sh's per-session pending predicate.
#
# Stdin (the PostToolUse payload) is read for two things only:
#   - agent_id / agent_type: present only on a SUBAGENT's tool call (measured on
#     Claude Code 2.1.272). A subagent call runs NO mail path. A non-empty payload
#     that cannot be parsed is treated the same way: a subagent cannot be ruled
#     out, and skipping only delays a notice — the mail stays pending.
#   - session_id: keys the notice damper per (agent, Claude session), so two
#     windows on one agent never silence each other and /clear re-notifies.
#
# Damper: a notice repeats only when the unread set changes, or once the remind
# interval has passed: RELAY_HOOK_NOTICE_REMIND_SECS (default 600, max 3600),
# capped at 120 while any unread message is high priority. 0 disables damping; a
# non-numeric, negative or oversized value falls back to the default, so damping
# is never unbounded. State lives in ${RELAY_HOME:-$HOME/.bot-relay}/hook-state/.
# If that state cannot be read or written, the notice is emitted: suppression
# needs durable evidence.
#
# Output contract (Claude Code PostToolUse hook):
#   - No mail, damped, subagent call, or any error → empty stdout, exit 0.
#   - Unread mail → single-line JSON to stdout with additionalContext, exit 0.
#   Stderr is operator-visible; use sparingly.
#
# Security / discipline:
#   - Never re-register. SessionStart handles that.
#   - Never mark, resolve or otherwise write message state (ADR-0037).
#   - Validate every env-var input against an allowlist BEFORE use.
#   - Never write partial JSON, error text, or stack traces to stdout.
#   - Per-call budget: 1s health probe + 2s get_messages. Claude Code enforces
#     the hook timeout from settings.json on top of this.

# v2.0 final (#19): self-check for path truncation. Stderr warn so operators
# see setup mistakes without breaking the hook contract (stdout stays clean).
# VERDICT BY CONSTRUCTION — first executable code, so none of the `exit 0`
# guards below can leave this session unaccounted for. STDERR, not stdout: this
# hook's stdout is a hookSpecificOutput JSON object the harness PARSES, and a
# trailing bare line would corrupt it — an alarm that corrupts the channel it
# rides on is worse than no alarm. Shared primitive; see hooks/_verdict.sh.
RELAY_VERDICT_STREAM=stderr
# FALLBACK VERDICT — installed BEFORE the shared helper is sourced, and this
# ordering is the whole point. A SHARED PRIMITIVE CANNOT GUARANTEE ITS OWN
# LOADER: if _verdict.sh is missing or unparseable, sourcing it fails and every
# verdict vanishes, which is the exact silence this mechanism exists to end
# (codex round 4 proved it by corrupting the helper — all four hooks then
# emitted ZERO verdicts and exited 0).
# These definitions are deliberately self-contained. Sourcing the helper
# REDEFINES them, so a healthy load transparently upgrades this fallback; the
# trap resolves `relay_emit_verdict` by name at exit time.
RELAY_VERDICT="CANNOT-JUDGE"
RELAY_VERDICT_REASON="verdict helper did not load"
RELAY_VERDICT_DETAIL=""
relay_emit_verdict() {
  _l="[RELAY] VERDICT=${RELAY_VERDICT} reason=\"${RELAY_VERDICT_REASON}\"${RELAY_VERDICT_DETAIL}"
  if [ "${RELAY_VERDICT_STREAM:-stdout}" = "stderr" ]; then echo "$_l" >&2; else echo "$_l"; fi
}
trap relay_emit_verdict EXIT
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
  # other side effects (HTTP health probe, peek) are gated behind DB_PATH
  # being readable below; null DB_PATH falls cleanly to the existing
  # "no DB → exit 0" path.
  DB_PATH=""
}
MAX_MESSAGES="${RELAY_HOOK_MAX_MESSAGES:-20}"
REMIND_SECS="${RELAY_HOOK_NOTICE_REMIND_SECS:-600}"

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

# Only a plain decimal 0..3600 is honoured; anything else is the default, never
# "disabled". 10# strips leading zeros so shell arithmetic cannot read octal.
if ! echo "$REMIND_SECS" | grep -Eq '^[0-9]{1,4}$' || [ "$REMIND_SECS" -gt 3600 ]; then
  REMIND_SECS=600
fi
REMIND_SECS=$((10#$REMIND_SECS))

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

# Everything below (stdin parse, notice rendering, JSON output) needs python3.
if ! command -v python3 >/dev/null 2>&1; then
  command -v relay_verdict_set >/dev/null 2>&1 && relay_verdict_set "CANNOT-JUDGE" "python3 unavailable" " agent=\"${AGENT_NAME}\""
  exit 0
fi

# --- Helper: emit the hook JSON with readable additionalContext ---
# Arg $1 is the plain-text block to inject. Body goes via env var (not argv) and
# is decoded as UTF-8 explicitly, so no locale can turn it into an error.
emit_hook_json() {
  local body="$1"
  if [ -z "$body" ]; then return 0; fi
  BODY="$body" python3 -c '
import json, os, sys
body = os.environb.get(b"BODY", b"").decode("utf-8", "replace")
out = {
  "continue": True,
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": body,
  },
}
sys.stdout.write(json.dumps(out))
' 2>/dev/null
}

# --- Stdin parser: prints "MODE<US>SESSION_ID" -----------------------------------
# MODE is main | subagent | absent | invalid. Python reads fd 0 in chunks with a
# 1s idle deadline: Claude Code writes the payload and closes the pipe, so this
# is instant in practice, and a caller that never closes stdin costs one second
# rather than a hang. Top-level keys only, from a real JSON parse: an "agent_id"
# string inside tool_response must not count.
STDIN_PY='
import json, os, re, select, sys
buf = bytearray()
cap = 16 * 1024 * 1024
while True:
    try:
        ready, _, _ = select.select([0], [], [], 1.0)
    except Exception:
        break
    if not ready:
        break
    chunk = os.read(0, 65536)
    if not chunk:
        break
    buf += chunk
    if len(buf) > cap:
        sys.stdout.write("invalid\x1f")
        sys.exit(0)
if not bytes(buf).strip():
    sys.stdout.write("absent\x1f")
    sys.exit(0)
try:
    d = json.loads(bytes(buf).decode("utf-8", "replace"))
except Exception:
    sys.stdout.write("invalid\x1f")
    sys.exit(0)
if not isinstance(d, dict):
    sys.stdout.write("invalid\x1f")
    sys.exit(0)
sid = d.get("session_id")
if not (isinstance(sid, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", sid)):
    sid = ""
sub = any(d.get(k) not in (None, "") for k in ("agent_id", "agent_type"))
sys.stdout.write(("subagent" if sub else "main") + "\x1f" + sid)
'

# --- Notice renderer: reads the peek result on stdin, prints "FPR<US>TOP<US>NOTICE" --
# SRC=http  → stdin is the StreamableHTTP get_messages response.
# SRC=sqlite → stdin is rows "id<US>from<US>priority<US>created_at<US>content<RS>...".
# Exit 1 = the read failed (caller falls back / stays CANNOT-JUDGE); exit 0 with
# no output = empty mailbox. FPR fingerprints the unread set for the damper.
# Piped rather than passed in an env var: a full get_messages response can exceed
# Linux's 128KB per-string exec limit.
NOTICE_PY='
import hashlib, json, os, re, sys

src = os.environ.get("SRC", "")
an = os.environ.get("AN", "?")
try:
    lim = int(os.environ.get("LIM", "20"))
except ValueError:
    lim = 20
raw = sys.stdin.buffer.read().decode("utf-8", "replace")

recs = []
if src == "http":
    payload = None
    for line in raw.strip().splitlines():
        line = line.strip()
        if line.startswith("data:"):
            payload = line[5:].strip()
            break
    if payload is None:
        payload = raw.strip()
    try:
        rpc = json.loads(payload)
        data = json.loads(rpc["result"]["content"][0]["text"])
        msgs = data["messages"]
    except Exception:
        sys.exit(1)
    if not isinstance(msgs, list):
        sys.exit(1)
    for m in msgs:
        if not isinstance(m, dict):
            continue
        c = m.get("content")
        recs.append((str(m.get("id", "")), str(m.get("from_agent", "?")),
                     str(m.get("priority", "normal")), str(m.get("created_at", "")),
                     c if isinstance(c, str) else ""))
elif src == "sqlite":
    for rec in raw.split("\x1e"):
        rec = rec.strip("\n\r")
        if not rec:
            continue
        parts = rec.split("\x1f", 4)
        if len(parts) == 5:
            recs.append(tuple(parts))
else:
    sys.exit(1)

if not recs:
    sys.exit(0)

n = len(recs)
count = ("%d+" % n) if n >= lim else ("%d" % n)
fpr = hashlib.sha256("\n".join(sorted(r[0] for r in recs)).encode("utf-8", "replace")).hexdigest()[:32]
top = "high" if any(r[2] == "high" for r in recs) else "normal"
newest_first = sorted(recs, key=lambda r: r[3], reverse=True)
# Sender names are the ONLY sender-chosen field in the notice, so they are held to
# [a-z0-9-]; anything else shows as "unknown". No content field is read at all.
SENDER = re.compile(r"[a-z0-9-]{1,64}")
order, highs = [], {}
for r in newest_first:
    who = r[1] if SENDER.fullmatch(r[1] or "") else "unknown"
    if who not in highs:
        order.append(who)
        highs[who] = 0
    if r[2] == "high":
        highs[who] += 1
shown = [("%s (%d high)" % (w, highs[w])) if highs[w] else w for w in order[:5]]
if len(order) > 5:
    shown.append("+%d more" % (len(order) - 5))

def age(iso):
    import datetime
    try:
        t = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
        secs = max(0, int((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()))
    except Exception:
        return "at an unknown time"
    for unit, size in (("d", 86400), ("h", 3600), ("m", 60)):
        if secs >= size:
            return "%d%s ago" % (secs // size, unit)
    return "%ds ago" % secs

notice = ("relay: %s unread for %s (highest priority: %s), from %s. newest arrived %s. "
          "Unread until get_messages is called.") % (count, an, top, ", ".join(shown), age(newest_first[0][3]))
sys.stdout.buffer.write(("%s\x1f%s\x1f%s" % (fpr, top, notice)).encode("utf-8", "replace"))
'

# --- HTTP peek (preferred) ---

http_peek() {
  [ -z "$AGENT_TOKEN" ] && return 1
  command -v curl >/dev/null 2>&1 || return 1

  # Probe /health with a tight budget. If no response in 1s, assume no daemon.
  if ! curl -fsS --max-time 1 "http://${HTTP_HOST}:${HTTP_PORT}/health" >/dev/null 2>&1; then
    return 1
  fi

  # peek:true is the whole fix on this path: the same get_messages the agent
  # calls, minus the read-mark. json.dumps is belt-and-suspenders on top of the
  # allowlist validation above.
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
      "peek": True,
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

  printf '%s' "$response" | SRC=http AN="$AGENT_NAME" LIM="$MAX_MESSAGES" python3 -c "$NOTICE_PY" 2>/dev/null
}

# --- Sqlite peek (fallback) ---
# SELECT only. #56 canonical per-session pending predicate (SSOT: src/db.ts
# pendingForSessionClause), the same replica stop-check.sh uses: unresolved AND
# (never read, OR read by a DIFFERENT session). On a legacy DB without those
# columns the query errors and the bare-status form runs instead.

sqlite_peek() {
  [ -z "$DB_PATH" ] && return 1
  [ -f "$DB_PATH" ] || return 1
  command -v sqlite3 >/dev/null 2>&1 || return 1

  local rows
  rows=$(sqlite3 -separator $'\x1f' -newline $'\x1e' "$DB_PATH" <<SQL 2>/dev/null
.parameter set :name '$AGENT_NAME'
.parameter set :lim $MAX_MESSAGES
SELECT id, from_agent, priority, created_at, substr(content, 1, 2048)
FROM messages WHERE to_agent = :name
  AND resolved_at IS NULL
  AND (read_by_session IS NULL
       OR read_by_session != COALESCE((SELECT session_id FROM agents WHERE name = :name), ''))
ORDER BY created_at DESC LIMIT :lim;
SQL
)
  if [ $? -ne 0 ]; then
    rows=$(sqlite3 -separator $'\x1f' -newline $'\x1e' "$DB_PATH" <<SQL 2>/dev/null
.parameter set :name '$AGENT_NAME'
.parameter set :lim $MAX_MESSAGES
SELECT id, from_agent, priority, created_at, substr(content, 1, 2048)
FROM messages WHERE to_agent = :name AND status = 'pending'
ORDER BY created_at DESC LIMIT :lim;
SQL
) || return 1
  fi
  if [ -z "$rows" ]; then
    return 0  # empty — nothing to surface
  fi

  printf '%s' "$rows" | SRC=sqlite AN="$AGENT_NAME" LIM="$MAX_MESSAGES" python3 -c "$NOTICE_PY" 2>/dev/null
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
# mail notice below. relay_agent_pid/relay_pid_start come from _vault-helpers.sh.
liveness_self_heal() {
  [ -z "$AGENT_TOKEN" ] && return 0
  command -v curl >/dev/null 2>&1 || return 0
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

# --- Damper helpers -------------------------------------------------------------
# notice_is_damped returns 0 (suppress) ONLY on positive evidence: a readable
# state file holding the SAME fingerprint, with an mtime inside the window and
# not in the future. Any missing or unreadable piece means emit.
notice_is_damped() {
  [ "$REMIND_SECS" -eq 0 ] && return 1
  case "$FPR" in ''|*[!0-9a-f]*) return 1 ;; esac
  [ -f "$STATE_FILE" ] || return 1
  local window="$REMIND_SECS" now last prev
  if [ "$TOP" = "high" ] && [ "$window" -gt 120 ]; then
    window=120
  fi
  prev=$(head -c 64 "$STATE_FILE" 2>/dev/null) || return 1
  [ "$prev" = "$FPR" ] || return 1
  now=$(date +%s)
  # mtime, portably. GNU stat -f is "filesystem status" and SUCCEEDS with the
  # mount point for %m, so accept the BSD answer only if it is numeric (codex #124).
  last=$(stat -f %m "$STATE_FILE" 2>/dev/null)
  case "$last" in ''|*[!0-9]*) last=$(stat -c %Y "$STATE_FILE" 2>/dev/null) ;; esac
  case "$last" in ''|*[!0-9]*) return 1 ;; esac
  [ "$now" -ge "$last" ] || return 1
  [ $((now - last)) -lt "$window" ]
}

# Records "notified" by writing the fingerprint atomically; the file's mtime is
# the notice time. Best-effort: a failure here only means the next call notifies.
record_notice() {
  mkdir -p "$STATE_DIR" 2>/dev/null || return 0
  local tmp="$STATE_FILE.$$"
  if printf '%s' "$FPR" > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$STATE_FILE" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  fi
  return 0
}

# --- Main ---------------------------------------------------------------------

# Hook input first, before anything else could read stdin.
HOOK_MODE="absent"
HOOK_SESSION=""
if [ ! -t 0 ]; then
  _parsed=$(python3 -c "$STDIN_PY" 2>/dev/null)
  HOOK_MODE="${_parsed%%$'\x1f'*}"
  HOOK_SESSION="${_parsed#*$'\x1f'}"
fi
if ! echo "$HOOK_SESSION" | grep -Eq '^[A-Za-z0-9_-]{1,128}$'; then
  HOOK_SESSION=""
fi

liveness_self_heal

# A subagent's tool call runs no mail path at all (ADR-0037 clause 2). Neither
# does a payload that cannot be parsed. The verdict says why nothing was judged.
case "$HOOK_MODE" in
  main|absent) ;;
  subagent)
    command -v relay_verdict_set >/dev/null 2>&1 && relay_verdict_set "CANNOT-JUDGE" "subagent tool call: mail check skipped (ADR-0037)" " agent=\"${AGENT_NAME}\""
    exit 0
    ;;
  *)
    command -v relay_verdict_set >/dev/null 2>&1 && relay_verdict_set "CANNOT-JUDGE" "hook stdin unparseable: mail check skipped (ADR-0037)" " agent=\"${AGENT_NAME}\""
    exit 0
    ;;
esac

SUMMARY=$(http_peek)
RC=$?
READ_OK=0
[ $RC -eq 0 ] && READ_OK=1
if [ $RC -ne 0 ] || [ -z "$SUMMARY" ]; then
  SUMMARY=$(sqlite_peek)
  # sqlite_peek returning 0 with empty SUMMARY = empty mailbox, which is fine.
  [ $? -eq 0 ] && READ_OK=1
fi

# THE ONLY UPGRADE. Positive evidence is a mailbox read that SUCCEEDED — via
# HTTP or via the sqlite fallback (both peeks). An empty SUMMARY alone is NOT
# evidence: it is ambiguous between "no mail" and "could not read", and treating
# ambiguity as health is the exact conflation this whole mechanism removes. If
# both paths failed, CANNOT-JUDGE stands.
if [ "$READ_OK" -eq 1 ] && command -v relay_verdict_set >/dev/null 2>&1; then
  relay_verdict_set "HEALTHY" "mailbox read succeeded" " agent=\"${AGENT_NAME:-?}\""
fi

# Damper state is keyed by (agent, Claude session). "@" is outside both
# allowlists, so an agent-only key can never collide with a session key.
STATE_DIR="${RELAY_HOME:-$HOME/.bot-relay}/hook-state"
if [ -n "$HOOK_SESSION" ]; then
  STATE_FILE="$STATE_DIR/ptu-notice-${AGENT_NAME}@${HOOK_SESSION}"
else
  STATE_FILE="$STATE_DIR/ptu-notice-${AGENT_NAME}"
fi

if [ -z "$SUMMARY" ]; then
  # A read that succeeded and found nothing retires this key's state.
  if [ "$READ_OK" -eq 1 ]; then
    rm -f "$STATE_FILE" 2>/dev/null
  fi
  exit 0
fi

FPR="${SUMMARY%%$'\x1f'*}"
_rest="${SUMMARY#*$'\x1f'}"
TOP="${_rest%%$'\x1f'*}"
NOTICE="${_rest#*$'\x1f'}"

if notice_is_damped; then
  exit 0
fi

emit_hook_json "$NOTICE" || exit 0
record_notice
exit 0
