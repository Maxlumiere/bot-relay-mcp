#!/bin/bash
# bot-relay-mcp: Stop hook — turn-boundary WAKE (read-only). v2.23 rewrite.
#
# Fires at every clean turn end. Complements PostToolUse (which only fires
# after a tool call): mail that lands after a turn's last tool call, or during
# a text-only turn, reaches the agent here instead of waiting for the next
# tool call or SessionStart.
#
# DELIVERY MODEL — read-only wake, verified against the Claude Code hooks
# contract (code.claude.com/docs/en/hooks):
#   - `additionalContext` on a Stop hook DOES NOT wake: it is queued for the
#     next model request and surfaces only if a future turn starts. A hook
#     that marks mail read while emitting additionalContext converts pending
#     mail into read-mail-plus-queued-context for a turn that may never come —
#     if the session dies in that window the mail is dropped-as-read and
#     invisible to Sentinel (which keys on unread). That was this file's
#     original shape, and it was a silent data-loss path.
#   - `decision:"block"` + `reason` is the only Stop output that forces the
#     agent to continue immediately with the reason in front of it.
#
# So this hook:
#   1. PEEKS at pending mail (get_messages peek:true over HTTP, or a plain
#      SELECT over sqlite). It performs ZERO writes — there is no UPDATE
#      statement in this file, so it cannot consume mail it failed to deliver,
#      by construction. tests/hooks-stop.test.ts asserts both the behavior
#      (mail still pending after the hook fires) and the structure (no UPDATE
#      in the source).
#   2. If mail is pending, emits decision:"block" with a compact wake in
#      `reason`: the agent is told to call get_messages itself. Content
#      delivery rides that authenticated tool call — the one place mark-as-read
#      has always been correct — so read continues to mean received.
#   3. Loop guards, all of which leave the mail PENDING when they suppress
#      (suppression can delay a wake, never lose mail — PostToolUse, Tether
#      and Sentinel remain the floor WHERE INSTALLED; on a session with none
#      of them, a suppressed wake surfaces at the next natural stop or
#      SessionStart, which is honest delay, not loss):
#        a. `stop_hook_active` in the hook's stdin payload (read COMPLETELY,
#           not first-line-only): when this stop is itself the result of a
#           Stop-hook block, never block again — one wake per natural stop.
#           If the agent could not drain its inbox in the granted
#           continuation (e.g. broken token), it stops and the floor takes
#           over, loudly.
#        b. Fail-safe on a non-empty payload that does not parse as JSON:
#           suppress. We cannot rule out active, and a wrong guess in the
#           other direction is a block loop.
#        c. A time damper (default 120s, RELAY_STOP_WAKE_DAMPER_SECS to tune,
#           0 disables), applied ONLY when the payload lacked a parseable
#           stop_hook_active — on a trusted payload the field alone already
#           guarantees one wake per natural stop, and damping on top would
#           swallow the wake for a NEW batch after a continuation drained
#           the old one. Keyed on state-file mtime under
#           ~/.bot-relay/hook-state/.
#
# COST, stated for the operator: a block steals the turn boundary — the agent
# continues into mail processing before yielding, and anything the human types
# meanwhile queues behind that continuation. The guards bound it to one block
# per natural stop and one per damper window. Sessions without RELAY_AGENT_NAME
# are never touched.
#
# Output contract (Claude Code Stop hook):
#   - No mail, suppressed by a guard, or any error → empty stdout, exit 0.
#   - Mail pending → single-line JSON {"decision":"block","reason":"…"}, exit 0.
#   Stderr is operator-visible; use sparingly.
#
# Security / discipline:
#   - Never re-register. SessionStart handles that.
#   - Validate every env-var input against an allowlist BEFORE use.
#   - Never write partial JSON, error text, or stack traces to stdout.
#   - 2s total budget (1s health probe + 2s peek). Claude Code enforces
#     hook timeout from settings.json on top of this.
#
# Honest limitation:
#   - Does NOT wake a truly idle terminal. If no turn is in progress, the hook
#     does not fire. Idle wake is Tether's job (proven to self-submit on idle
#     agents); parked agents are Sentinel's.

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

# --- Hook input (stdin) — the ONE-WAKE-PER-NATURAL-STOP guard -----------------
# Claude Code writes the hook payload to stdin and closes it. The COMPLETE
# payload is read (bounded at 256KB), not just the first line — a pretty-printed
# payload with `stop_hook_active` on a later line must not parse as inactive
# (codex #124: first-line-only reading let a multi-line active:true payload
# defeat the guard and re-block every forced continuation). The per-line 1s
# timeout only guards a manual TTY invocation from hanging; on a closed pipe
# every read returns instantly. Concatenating lines is JSON-safe: newlines are
# inter-token whitespace and cannot occur inside JSON strings.
HOOK_INPUT=""
_line=""
_capped=0
while IFS= read -r -t 1 _line 2>/dev/null; do
  HOOK_INPUT="${HOOK_INPUT}${_line}"
  if [ ${#HOOK_INPUT} -ge 262144 ]; then
    _capped=1
    break
  fi
done
# On EOF-exit, `read` returns non-zero with the unterminated final line still
# in _line — append it. On cap-break it was ALREADY appended inside the loop;
# appending again would retain up to 2x the cap for a single giant line
# (codex #124 round 2). Then truncate, so the cap holds even for the
# EOF-remnant case and the 256KB claim is actually true.
if [ "$_capped" -eq 0 ]; then
  HOOK_INPUT="${HOOK_INPUT}${_line}"
fi
HOOK_INPUT="${HOOK_INPUT:0:262144}"
# Guard modes, decided by what the payload PROVES (fail-safe in every branch —
# suppression always leaves mail PENDING for the floor; nothing here writes):
#   active   → this stop is already our forced continuation: one wake per
#              natural stop, never block again.
#   invalid  → a non-empty payload we cannot parse: we cannot rule out
#              active, so suppress rather than risk a block loop.
#   inactive → the harness explicitly says this is a natural stop. TRUSTED:
#              the damper below is skipped — stop_hook_active alone already
#              guarantees one wake per natural stop, and damping on top of it
#              would swallow the wake for a NEW batch arriving after a
#              continuation drained the old one.
#   absent/empty → old harness or manual run: fall through with the damper as
#              the bounded-loudness backstop.
GUARD_TRUSTED=0
if [ -n "$HOOK_INPUT" ]; then
  command -v python3 >/dev/null 2>&1 || exit 0
  PARSE=$(HI="$HOOK_INPUT" python3 -c '
import json, os
try:
    d = json.loads(os.environ["HI"])
except Exception:
    print("invalid")
    raise SystemExit
if d.get("stop_hook_active"):
    print("active")
elif "stop_hook_active" in d:
    print("inactive")
else:
    print("absent")
' 2>/dev/null)
  case "$PARSE" in
    active) exit 0 ;;
    inactive) GUARD_TRUSTED=1 ;;
    absent) GUARD_TRUSTED=0 ;;
    *) exit 0 ;;
  esac
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
DAMPER_SECS="${RELAY_STOP_WAKE_DAMPER_SECS:-120}"

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

if ! echo "$DAMPER_SECS" | grep -Eq '^[0-9]{1,4}$' || [ "$DAMPER_SECS" -gt 3600 ]; then
  DAMPER_SECS=120
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

# --- Peek helpers — both emit "COUNT<US>LATEST_FROM<US>TOP_PRIORITY" ----------
# <US> = 0x1f. Neither path mutates message state: HTTP passes peek:true (the
# v2.2.2 non-mutating read), sqlite runs a bare SELECT. The sqlite connection
# is deliberately NOT opened with -readonly: readonly open of a WAL database
# is version-dependent (it fails with SQLITE_CANTOPEN on a cleanly-closed WAL
# DB under some sqlite3 builds because the readonly connection cannot create
# the -shm), and the relay DB is WAL by default — so -readonly silently
# degraded the whole fallback to no-wake on affected machines. The read-only
# guarantee is structural instead: no mutating SQL exists in this file, and
# tests/hooks-stop.test.ts asserts that against the source.

http_peek() {
  [ -z "$AGENT_TOKEN" ] && return 1
  command -v curl >/dev/null 2>&1 || return 1
  command -v python3 >/dev/null 2>&1 || return 1

  # Probe /health with a tight budget. If no response in 1s, assume no daemon.
  if ! curl -fsS --max-time 1 "http://${HTTP_HOST}:${HTTP_PORT}/health" >/dev/null 2>&1; then
    return 1
  fi

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

  RESP="$response" python3 <<'PYEOF' 2>/dev/null
import json, os, sys

raw = os.environ.get("RESP", "").strip()
# StreamableHTTP wraps the JSON-RPC response in SSE: "event: message\ndata: {..}".
payload = None
for line in raw.splitlines():
    line = line.strip()
    if line.startswith("data:"):
        payload = line[5:].strip()
        break
if payload is None:
    payload = raw
try:
    rpc = json.loads(payload)
    inner = rpc["result"]["content"][0]["text"]
    data = json.loads(inner)
except Exception:
    sys.exit(1)
msgs = data.get("messages", [])
if not msgs:
    sys.exit(0)  # empty — success but nothing to wake for
top = "high" if any(m.get("priority") == "high" for m in msgs) else "normal"
latest = msgs[0].get("from_agent", "?")
sys.stdout.write(f"{len(msgs)}\x1f{latest}\x1f{top}")
PYEOF
  return $?
}

sqlite_peek() {
  [ -z "$DB_PATH" ] && return 1
  [ -f "$DB_PATH" ] || return 1
  command -v sqlite3 >/dev/null 2>&1 || return 1
  command -v python3 >/dev/null 2>&1 || return 1

  # `resolved_at IS NULL` mirrors the authoritative get_messages pending
  # query: resolve_messages stamps resolved_at WITHOUT touching status, so a
  # status-only filter would wake the agent for mail get_messages will not
  # return — a block loop with nothing to drain (codex #124). The column
  # exists since v2.12; on a pre-v2.12 legacy DB the query errors and we
  # retry without the filter rather than silently losing the whole fallback.
  local rows
  rows=$(sqlite3 -separator $'\x1f' -newline $'\x1e' "$DB_PATH" <<SQL 2>/dev/null
.parameter set :name '$AGENT_NAME'
.parameter set :lim $MAX_MESSAGES
SELECT from_agent, priority
FROM messages WHERE to_agent = :name AND status = 'pending' AND resolved_at IS NULL
ORDER BY created_at DESC LIMIT :lim;
SQL
)
  if [ $? -ne 0 ]; then
    rows=$(sqlite3 -separator $'\x1f' -newline $'\x1e' "$DB_PATH" <<SQL 2>/dev/null
.parameter set :name '$AGENT_NAME'
.parameter set :lim $MAX_MESSAGES
SELECT from_agent, priority
FROM messages WHERE to_agent = :name AND status = 'pending'
ORDER BY created_at DESC LIMIT :lim;
SQL
) || return 1
  fi
  if [ -z "$rows" ]; then
    return 0  # empty — nothing to wake for
  fi

  ROWS="$rows" python3 <<'PYEOF' 2>/dev/null
import os, sys
raw = os.environ.get("ROWS", "")
records = []
for rec in raw.split("\x1e"):
    rec = rec.strip("\n\r")
    if not rec:
        continue
    parts = rec.split("\x1f", 1)
    if len(parts) != 2:
        continue
    records.append(parts)
if not records:
    sys.exit(0)
top = "high" if any(p == "high" for (_, p) in records) else "normal"
sys.stdout.write(f"{len(records)}\x1f{records[0][0]}\x1f{top}")
PYEOF
  return $?
}

# --- Main: peek (HTTP then sqlite), damper, then block-to-wake ---------------

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
# HTTP or via the sqlite fallback (both PEEKS now: this hook never consumes
# mail it cannot prove it delivered). An empty SUMMARY alone is NOT evidence:
# it is ambiguous between "no mail" and "could not read", and treating
# ambiguity as health is the exact conflation this whole mechanism removes.
# If both paths failed, CANNOT-JUDGE stands.
if [ "$READ_OK" -eq 1 ] && command -v relay_verdict_set >/dev/null 2>&1; then
  relay_verdict_set "HEALTHY" "mailbox read succeeded" " agent=\"${AGENT_NAME:-?}\""
fi

if [ -z "$SUMMARY" ]; then
  exit 0
fi

# Damper: at most one block per window per agent — applied ONLY when the
# payload did not carry a parseable stop_hook_active (GUARD_TRUSTED=0). On a
# trusted payload the field alone guarantees one wake per natural stop, and
# damping on top would swallow the wake for a NEW batch arriving after a
# continuation drained the old one. Suppression leaves the mail PENDING — a
# delayed wake, never a lost one. 0 disables (tests drive this).
if [ "$GUARD_TRUSTED" -eq 0 ] && [ "$DAMPER_SECS" -gt 0 ]; then
  STATE_DIR="$HOME/.bot-relay/hook-state"
  STATE_FILE="$STATE_DIR/stop-wake-$AGENT_NAME"
  NOW=$(date +%s)
  if [ -f "$STATE_FILE" ]; then
    # mtime, portably. GNU stat -f is "filesystem status" — it SUCCEEDS and
    # prints the MOUNT POINT for %m, so `stat -f || stat -c` never falls
    # through on Linux and the arithmetic below would compare against a path
    # (codex #124 HIGH). Accept the BSD answer only if it is numeric.
    LAST=$(stat -f %m "$STATE_FILE" 2>/dev/null)
    case "$LAST" in
      ''|*[!0-9]*) LAST=$(stat -c %Y "$STATE_FILE" 2>/dev/null) ;;
    esac
    case "$LAST" in
      ''|*[!0-9]*) LAST=0 ;;
    esac
    if [ $((NOW - LAST)) -lt "$DAMPER_SECS" ]; then
      exit 0
    fi
  fi
  mkdir -p "$STATE_DIR" 2>/dev/null && touch "$STATE_FILE" 2>/dev/null
fi

# Emit the wake. decision:"block" is the only Stop output the harness treats
# as "continue now with this in front of you". The reason tells the agent to
# fetch its own mail — the hook deliberately does NOT carry bodies, so the
# mark-as-read stays inside the agent's authenticated get_messages call.
command -v python3 >/dev/null 2>&1 || exit 0
SUMMARY="$SUMMARY" AN="$AGENT_NAME" python3 -c '
import json, os, sys
count, latest_from, top = os.environ["SUMMARY"].split("\x1f", 2)
an = os.environ["AN"]
plural = "s" if count != "1" else ""
prio = " (high priority)" if top == "high" else ""
reason = (
    f"[RELAY] {count} pending message{plural} for {an}{prio}, latest from {latest_from}. "
    f"Before stopping, call get_messages(agent_name=\"{an}\", status=\"pending\"), "
    f"act on every message, then continue. The mail is still unread in the relay; "
    f"this wake did not consume it."
)
sys.stdout.write(json.dumps({"decision": "block", "reason": reason}))
' 2>/dev/null
exit 0
