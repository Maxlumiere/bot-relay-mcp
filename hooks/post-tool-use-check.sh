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
# The read path is chosen by CONFIGURATION, never by failure (the F1 mode rule,
# 28 Sep). `relay pending AGENT --json` (F1, ADR-0044) decides, on positive
# evidence only, from the connector's instance layout; this file re-implements none of it
# and holds no predicate SQL (ADR-0039):
#   1. LOCAL (F1 answered): the canonical pending set, metadata only, read-only.
#      A pure SELECT, so it stamps no seq either.
#   2. LOCAL but UNREADABLE (F1 exit 1, or no runnable CLI): a LOUD "relay
#      unreadable" notice and verdict. NEVER an HTTP request: a failure is not a
#      reason to change paths.
#   3. REMOTE (F1 exit 3 = no local instance, AND RELAY_HTTP_HOST configured): the
#      get_messages peek over HTTP, LABELED "via remote relay". KNOWN LIMIT: that
#      peek stamps seq (the ADR-0044 residual) until a remote F1 equivalent exists.
#   4. Neither (exit 3, no remote configured): nothing to read, CANNOT-JUDGE.
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
#   - Per-call budget: one `relay pending` run (local), or 1s health probe + 2s
#     get_messages (remote). Claude Code enforces the hook timeout from
#     settings.json on top of this.

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
# v2.6.1 — vault helpers (token vault, agent pid) sourced from a single file.
# The DB path is NOT resolved here: `relay pending` resolves it (the connector's
# instance layout, positive evidence only) and reports the path it read.
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_vault-helpers.sh
. "$HOOKS_DIR/_vault-helpers.sh"
# This hook's INSTALLED timeout in seconds. The source of truth is
# src/agent-cli-profiles.ts (the Claude profile's hook list); a test holds the two
# equal, so a budget change there cannot silently outrun the read deadline here.
RELAY_HOOK_BUDGET_SECS=5
RELAY_CLI="$(cd "$HOOKS_DIR/.." 2>/dev/null && pwd)/bin/relay"
MAX_MESSAGES="${RELAY_HOOK_MAX_MESSAGES:-20}"
REMIND_SECS="${RELAY_HOOK_NOTICE_REMIND_SECS:-600}"

# --- Guard: no agent name means nothing to do ---

if [ -z "$AGENT_NAME" ]; then
  exit 0
fi

# --- Input validation (security hardening — same allowlist as check-relay.sh) ---

# Whole-string match. `echo "$X" | grep -Eq '^RE$'` is LINE-oriented: a
# multi-line value passes if ANY line matches, and the rest rides along into
# whatever the value is used for (Codex round 2 on #280: a newline in
# RELAY_AGENT_NAME reached a sqlite heredoc as SQL). [[ =~ ]] anchors to the
# whole string.
relay_whole_match() { [[ "$1" =~ $2 ]]; }

if ! relay_whole_match "$AGENT_NAME" '^[A-Za-z0-9_.-]{1,64}$'; then
  exit 0
fi

# v2.6.1 — vault hydration. If the env-supplied RELAY_AGENT_TOKEN is empty
# but a valid token sits in the vault for this agent, use it for the remote
# read and the liveness self-heal. The local read needs no token.
if [ -z "$AGENT_TOKEN" ]; then
  if VAULT_TOKEN=$(read_relay_token_from_vault "$AGENT_NAME"); then
    AGENT_TOKEN="$VAULT_TOKEN"
    export RELAY_AGENT_TOKEN="$VAULT_TOKEN"
  fi
fi

if ! relay_whole_match "$HTTP_HOST" '^[A-Za-z0-9_.:-]{1,253}$'; then
  exit 0
fi

if ! relay_whole_match "$HTTP_PORT" '^[0-9]{1,5}$' || [ "$HTTP_PORT" -lt 1 ] || [ "$HTTP_PORT" -gt 65535 ]; then
  exit 0
fi

if ! relay_whole_match "$MAX_MESSAGES" '^[0-9]{1,3}$' || [ "$MAX_MESSAGES" -lt 1 ] || [ "$MAX_MESSAGES" -gt 100 ]; then
  MAX_MESSAGES=20
fi

# Only a plain decimal 0..3600 is honoured; anything else is the default, never
# "disabled". 10# strips leading zeros so shell arithmetic cannot read octal.
if ! relay_whole_match "$REMIND_SECS" '^[0-9]{1,4}$' || [ "$REMIND_SECS" -gt 3600 ]; then
  REMIND_SECS=600
fi
REMIND_SECS=$((10#$REMIND_SECS))

# Token shape: base64url-ish, 8-128 chars, strictly alnum/_/=/./- (no whitespace,
# no control chars — blocks header-injection via newlines in env var).
if [ -n "$AGENT_TOKEN" ]; then
  if ! relay_whole_match "$AGENT_TOKEN" '^[A-Za-z0-9_=.-]{8,128}$'; then
    AGENT_TOKEN=""
  fi
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

# --- Notice renderer: reads the read result on stdin, prints "FPR<US>TOP<US>NOTICE" --
# SRC=f1   → stdin is `relay pending --json`: the FULL canonical set, metadata only.
# SRC=http → stdin is the StreamableHTTP get_messages response (remote mode only).
# Exit 1 = the result is not trustworthy (never rendered as "no mail"); exit 0
# with no output = empty mailbox; exit 3 = an HTTP page that does not hold every
# pending message, so its top priority and newest arrival are unknown (the caller
# re-runs with AGG_KNOWN=1). FPR fingerprints the unread set for the damper.
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

# Every record is (id, sender, priority, created_at). NO content field is read on
# either path: the notice is metadata only.
# Priority is rendered, so it is held to the literals the relay itself uses BEFORE it is
# ranked or shown; anything else (a raw DB value, a stubbed response) is "unknown".
KNOWN = ("critical", "high", "normal", "low")
RANK = {"critical": 0, "high": 1, "normal": 2, "low": 3, "unknown": 4}
def prio(p):
    return p if p in KNOWN else "unknown"
recs, total, top_name, newest, windowed = [], None, None, None, False
if src == "http":
    payload = None
    for line in raw.strip().splitlines():
        line = line.strip()
        if line.startswith("data:"):
            payload = line[5:].strip()
            break
    if payload is None:
        payload = raw.strip()
    # A TOOL ERROR IS A FAILED READ, never an empty mailbox (isError, or error_code).
    try:
        rpc = json.loads(payload)
        if rpc["result"].get("isError"):
            sys.exit(1)
        data = json.loads(rpc["result"]["content"][0]["text"])
        if not isinstance(data, dict) or "error_code" in data:
            sys.exit(1)
        msgs = data["messages"]
    except SystemExit:
        raise
    except Exception:
        sys.exit(1)
    if not isinstance(msgs, list):
        sys.exit(1)
    for m in msgs:
        if isinstance(m, dict):
            recs.append((str(m.get("id", "")), str(m.get("from_agent", "")),
                         prio(m.get("priority")), str(m.get("created_at", ""))))
    # get_messages orders by PRIORITY first, so the highest priority of ALL
    # pending mail is always inside the returned page.
    # THE COUNT IS total_pending, the canonical full-set count, never the page
    # length: a page of N rows is truncated whatever its window. A response without
    # it is not trusted at all (exit 1), and the full-set reader answers instead.
    # type() is int, not isinstance: a JSON false/true is a Python bool, and bool IS
    # an int subclass, so isinstance would accept {"total_pending": false}.
    if type(data.get("total_pending")) is not int:
        sys.exit(1)
    total = data["total_pending"]
    if total < 0 or total < len(msgs) or (total > 0 and not msgs):
        sys.exit(1)
    # A page drawn through ANY window is never the full set, whatever its size.
    windowed = data.get("since_bound") is not None
elif src == "f1":
    # relay pending --json: the FULL canonical set (no page), so every aggregate
    # below is exact. Anything short of the documented shape is not trusted.
    try:
        d = json.loads(raw)
        msgs = d["messages"]
        total = d["count"]
        if d.get("ok") is not True or type(total) is not int or not isinstance(msgs, list) or len(msgs) != total:
            sys.exit(1)
        for m in msgs:
            a = m["age_seconds"]
            if type(a) is not int or a < 0:
                sys.exit(1)
            # The fourth field sorts newest first: a larger value is a newer message.
            recs.append((str(m["id"]), m["from"] if isinstance(m["from"], str) else "", prio(m.get("priority")), -a))
        top_name = prio(d.get("top_priority"))
        newest_age = min(-r[3] for r in recs) if recs else None
    except SystemExit:
        raise
    except Exception:
        sys.exit(1)
else:
    sys.exit(1)

if not recs:
    sys.exit(0)

n = len(recs)
count = "%d" % total
def fingerprint(ids):
    return hashlib.sha256("\n".join(sorted(ids)).encode("utf-8", "replace")).hexdigest()[:32]
newest_age = newest_age if src == "f1" else None
# AGGREGATES COME FROM THE FULL SET, NEVER A PAGE (truncated is not complete).
# The top priority and the newest arrival describe ALL pending mail. The sqlite
# reader computes them over the full canonical set. An HTTP page that holds every
# pending message IS the full set; a partial one proves nothing about what it
# left out, whatever its ordering, so the full-set reader answers (exit 3, the
# caller re-runs with AGG_KNOWN=1), and with no reader both read as unknown.
if src == "http":
    complete = (not windowed) and n >= total
    if complete:
        top_name = min((r[2] for r in recs), key=lambda p: RANK[p])
        newest = max(r[3] for r in recs)
    elif os.environ.get("AGG_KNOWN") != "1":
        sys.exit(3)
    else:
        top_name = prio(os.environ.get("AGG_TOP") or "unknown")
        newest = os.environ.get("AGG_NEWEST") or None
elif top_name is None:
    top_name = "unknown"
# THE DAMPER FINGERPRINT IS A FUNCTION OF THE FULL SET. F1 returns every pending id,
# so the fingerprint is the id set itself: any arrival, resolve or swap changes it.
# On a remote page it is (count, newest arrival, top priority), full-set aggregates;
# only when a partial page leaves newest unknown are the page ids folded in, so a
# same-count swap still registers.
if src == "f1":
    fpr = fingerprint(["total=%s" % total] + [r[0] for r in recs])
else:
    parts = ["total=%s" % total, "newest=%s" % (newest or "?"), "top=%s" % top_name]
    if newest is None:
        parts += [r[0] for r in recs]
    fpr = fingerprint(parts)
# The damper 120s remind applies to anything high or above, and to an UNKNOWN top:
# a set whose top cannot be established is reminded as if it were high, never damped
# on the assumption that it is not.
top = "high" if (RANK[top_name] <= 1 or top_name == "unknown") else "normal"
newest_first = sorted(recs, key=lambda r: r[3], reverse=True)
# Sender names are the ONLY sender-chosen field in the notice, so they are held to
# [a-z0-9-]; anything else shows as "unknown".
SENDER = re.compile(r"[a-z0-9-]{1,64}")
order, highs = [], {}
for r in newest_first:
    who = r[1] if SENDER.fullmatch(r[1] or "") else "unknown"
    if who not in highs:
        order.append(who)
        highs[who] = 0
    if RANK.get(r[2], 2) <= 1:
        highs[who] += 1
shown = [("%s (%d high)" % (w, highs[w])) if highs[w] else w for w in order[:5]]
if len(order) > 5:
    shown.append("+%d more" % (len(order) - 5))

def ago(secs):
    for unit, size in (("d", 86400), ("h", 3600), ("m", 60)):
        if secs >= size:
            return "%d%s ago" % (secs // size, unit)
    return "%ds ago" % secs

def age(iso):
    import datetime
    if not isinstance(iso, str) or not iso:
        return "at an unknown time"
    try:
        t = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
        secs = max(0, int((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()))
    except Exception:
        return "at an unknown time"
    return ago(secs)

# Remote mode says so: the agent can tell which relay answered, and that the
# remote read carries the known seq residual.
head = "relay (via remote relay): " if src == "http" else "relay: "
arrived = ago(newest_age) if src == "f1" else age(newest)
notice = ("%s%s unread for %s (highest priority: %s), from %s. newest arrived %s. "
          "Unread until get_messages is called.") % (head, count, an, top_name, ", ".join(shown), arrived)
sys.stdout.buffer.write(("%s\x1f%s\x1f%s" % (fpr, top, notice)).encode("utf-8", "replace"))
'

# --- HTTP peek (REMOTE mode only: never called when a local instance exists) ---

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
      # The canonical pending set has NO window. Explicit, never the server default:
      # a windowed page silently drops mail a prior session read, and would then be
      # mistaken for the whole set.
      "since": "all",
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

  local out rc
  out=$(printf '%s' "$response" | SRC=http AN="$AGENT_NAME" LIM="$MAX_MESSAGES" python3 -c "$NOTICE_PY" 2>/dev/null)
  rc=$?
  if [ $rc -eq 3 ]; then
    # A partial page, and no local full-set reader in remote mode: the top priority
    # and newest arrival read as unknown, never as the page's.
    out=$(printf '%s' "$response" | SRC=http AN="$AGENT_NAME" LIM="$MAX_MESSAGES" AGG_KNOWN=1 \
      python3 -c "$NOTICE_PY" 2>/dev/null)
    rc=$?
  fi
  printf '%s' "$out"
  return $rc
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
# $1 = the DB `relay pending` just READ successfully (local mode only). It fires
# ONLY on a POSITIVELY observed mismatch (the F1 mode rule): no DB read, or no row
# for this agent, means the anchor is UNKNOWN, which is cannot-judge, and sends
# nothing.
liveness_self_heal() {
  local db="$1"
  [ -z "$AGENT_TOKEN" ] && return 0
  command -v curl >/dev/null 2>&1 || return 0
  command -v relay_agent_pid >/dev/null 2>&1 || return 0
  local cur_pid cur_start stored_pid stored_start
  cur_pid=$(relay_agent_pid 2>/dev/null || printf '')
  [ -z "$cur_pid" ] && return 0
  cur_start=$(relay_pid_start "$cur_pid" 2>/dev/null || printf '')
  # Read the stored anchor from the DB F1 read; if unavailable we can't compute
  # the gate → skip (SessionStart still carries the anchor).
  { [ -n "$db" ] && [ -f "$db" ]; } || return 0
  # Read-only and parameter-bound (Codex round 2): the name is BOUND, never
  # interpolated into sqlite command text. One read for both fields.
  local stored
  stored=$(AN="$AGENT_NAME" DBP="$db" python3 -c '
import os, sqlite3, sys, urllib.parse
try:
    con = sqlite3.connect("file:" + urllib.parse.quote(os.environ["DBP"]) + "?mode=ro", uri=True, timeout=1)
    r = con.execute("SELECT IFNULL(agent_pid, \x27\x27), IFNULL(agent_pid_start, \x27\x27) FROM agents WHERE name = ? LIMIT 1", (os.environ["AN"],)).fetchone()
except Exception:
    sys.exit(1)
if not r:
    sys.exit(1)
sys.stdout.write("%s\x1f%s" % (r[0], r[1]))
' 2>/dev/null) || return 0
  stored_pid="${stored%%$'\x1f'*}"
  stored_start="${stored#*$'\x1f'}"
  [ "$stored_pid" = "$stored" ] && stored_start=""
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
if ! relay_whole_match "$HOOK_SESSION" '^[A-Za-z0-9_-]{1,128}$'; then
  HOOK_SESSION=""
fi

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

# --- The mail read: F1 decides the mode; a failure never changes the path ------
# The unresolved fallback name is never an identity (ADR-0044 point 5): no mail
# is read for it, and no judgement is made.
case "$AGENT_NAME" in
  [Dd][Ee][Ff][Aa][Uu][Ll][Tt])
    command -v relay_verdict_set >/dev/null 2>&1 && relay_verdict_set "CANNOT-JUDGE" "agent name unresolved (default): mail not read" " agent=\"${AGENT_NAME}\" remedy=\"relay init --agent <name>, or set RELAY_AGENT_NAME\""
    exit 0
    ;;
esac

F1_OUT="" F1_ERR="" F1_RC=127
_f1_outf=""
_f1_errf=""
# The TRUE cause when the read cannot even start: never phrased as an unreadable DB.
if ! command -v node >/dev/null 2>&1; then
  F1_ERR="node not found (the relay CLI runs on node)"
elif [ ! -f "$RELAY_CLI" ]; then
  F1_ERR="no relay CLI beside this hook ($RELAY_CLI)"
else
  _f1_outf="$(mktemp 2>/dev/null || printf '')"
  _f1_errf="$(mktemp 2>/dev/null || printf '')"
  if [ -z "$_f1_outf" ] || [ -z "$_f1_errf" ]; then
    F1_ERR="could not create a private temp file for the read"
  else
    # The read's files are removed on EVERY exit, then the verdict is emitted.
    trap 'rm -f "$_f1_outf" "$_f1_errf" "$_f1_outf.timedout" 2>/dev/null; relay_emit_verdict' EXIT
    # node runs DIRECTLY into files under a watchdog, inside this hook's installed
    # budget (relay_run_pending / relay_pending_deadline in _vault-helpers.sh).
    _f1_deadline=$(relay_pending_deadline "$RELAY_HOOK_BUDGET_SECS")
    relay_run_pending "$_f1_deadline" "$_f1_outf" "$_f1_errf" node "$RELAY_CLI" pending "$AGENT_NAME" --json
    F1_RC=$?
    F1_OUT=$(cat "$_f1_outf" 2>/dev/null)
    F1_ERR=$(grep -m 1 'PENDING_' "$_f1_errf" 2>/dev/null)
    if [ "$F1_RC" -eq 124 ]; then
      F1_ERR="timed out after ${_f1_deadline}s"
    elif [ "$F1_RC" -ne 0 ] && [ "$F1_RC" -ne 3 ] && [ -z "$F1_ERR" ]; then
      F1_ERR="node crashed (exit $F1_RC): relay pending gave no reason"
    fi
  fi
fi

SUMMARY=""
READ_OK=0
case "$F1_RC" in
  0)
    MODE=local
    SUMMARY=$(printf '%s' "$F1_OUT" | SRC=f1 AN="$AGENT_NAME" python3 -c "$NOTICE_PY" 2>/dev/null)
    if [ $? -eq 0 ]; then
      READ_OK=1
    else
      MODE=unreadable
      SUMMARY=""
      F1_ERR="relay pending returned output this hook could not parse"
    fi
    ;;
  3)
    if [ -n "${RELAY_HTTP_HOST:-}" ]; then
      MODE=remote
      SUMMARY=$(http_peek)
      [ $? -eq 0 ] && READ_OK=1
    else
      MODE=none
    fi
    ;;
  *)
    MODE=unreadable
    ;;
esac

# Only a SUCCESSFUL local read tells us which DB holds this agent's anchor.
if [ "$MODE" = local ] && [ "$READ_OK" -eq 1 ]; then
  F1_DB=$(printf '%s' "$F1_OUT" | python3 -c 'import json, sys
try:
    p = json.load(sys.stdin).get("db_path")
except Exception:
    p = None
sys.stdout.write(p if isinstance(p, str) else "")' 2>/dev/null)
  liveness_self_heal "$F1_DB"
fi

# THE ONLY UPGRADE. Positive evidence is a mailbox read that SUCCEEDED. An empty
# SUMMARY alone is NOT evidence: it is ambiguous between "no mail" and "could not
# read", and treating ambiguity as health is the exact conflation this whole
# mechanism removes.
if command -v relay_verdict_set >/dev/null 2>&1; then
  if [ "$READ_OK" -eq 1 ] && [ "$MODE" = remote ]; then
    relay_verdict_set "HEALTHY" "mailbox read succeeded" " agent=\"${AGENT_NAME:-?}\" via=\"remote relay\""
  elif [ "$READ_OK" -eq 1 ]; then
    relay_verdict_set "HEALTHY" "mailbox read succeeded" " agent=\"${AGENT_NAME:-?}\""
  elif [ "$MODE" = unreadable ]; then
    # The reason is F1's first stderr line, held to a safe character set so it can
    # never break the one-line verdict format.
    _f1_why=$(printf '%s' "$F1_ERR" | tr -cd 'A-Za-z0-9 _./:()=,-' | cut -c1-200)
    # DEGRADED = a concluded fault (the verdict contract in _verdict.sh): the
    # local read failed, and nothing was asked of any other relay.
    relay_verdict_set "DEGRADED" "relay unreadable: ${_f1_why:-the local relay mailbox could not be read}" " agent=\"${AGENT_NAME}\" http_fallback=\"none\""
  elif [ "$MODE" = remote ]; then
    relay_verdict_set "CANNOT-JUDGE" "remote relay read failed (unreachable, unauthorized or no token)" " agent=\"${AGENT_NAME}\""
  else
    relay_verdict_set "CANNOT-JUDGE" "no local relay instance and no remote relay configured" " agent=\"${AGENT_NAME}\""
  fi
fi

# LOUD, not silent: an unreadable local relay is told to the agent too, because
# its mail may be waiting. A fixed text (no reason: that is on the verdict line),
# damped like any notice under a fixed fingerprint with the high-priority remind.
if [ "$MODE" = unreadable ]; then
  SUMMARY="00000000000000000000000000000000"$'\x1f'"high"$'\x1f'"relay unreadable: this hook could not read the local relay mailbox for ${AGENT_NAME}, so mail may be waiting. Call get_messages to check; the relay CLI (relay pending ${AGENT_NAME}) shows the reason."
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
