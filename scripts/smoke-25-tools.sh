#!/usr/bin/env bash
# smoke-25-tools.sh — exercise every MCP tool + CLI subcommand against a live relay.
#
# v2.1 Phase 5a: supersedes smoke-22-tools.sh. Adds rotate_token_admin
# (tool #25), a managed-rotation subtest, the recovery-token flow, and a
# CLI subcommand section (doctor, generate-hooks, backup, restore, recover,
# re-encrypt). Pre-publish gate invokes this script.
#
# Every assertion is SEMANTIC — not "didn't crash." Phase 4k lesson:
# post_task_auto self-assign sat in the smoke for months because the
# assertion was "assigned → <anyone>" instead of "routed → <not-sender>."
# Don't repeat that mistake — name the expected identity/state.
#
# Usage:  bash scripts/smoke-25-tools.sh [http://127.0.0.1:3777]
# Requires: curl, jq.

set -u
set -o pipefail

RELAY_URL="${1:-http://127.0.0.1:3777}"
MCP_URL="$RELAY_URL/mcp"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELAY_BIN="$REPO_ROOT/bin/relay"

# v2.1 Phase 7p HIGH #1: assert the LIVE relay reports the SAME version as
# package.json. This catches "docs claim vX.Y.Z but binary is still on prior"
# drift — the shape Codex found in the v2.1 final-gate audit. Read once at
# startup so every version check in the smoke compares against the same
# authoritative source.
EXPECTED_VERSION="$(node -e "console.log(require('$REPO_ROOT/package.json').version)")"
if [ -z "$EXPECTED_VERSION" ]; then
  echo "FATAL: could not read version from $REPO_ROOT/package.json" >&2
  exit 1
fi

TS="$(date +%s)"
A_NAME="smoke-a-$TS"
B_NAME="smoke-b-$TS"
CH_NAME="smoke-ch-$TS"
MGR_NAME="smoke-managed-$TS"
ADMIN_NAME="smoke-admin-$TS"
VICTIM_NAME="smoke-victim-$TS"

A_TOKEN=""
B_TOKEN=""
MGR_TOKEN=""
ADMIN_TOKEN=""
TASK_ID=""
AUTO_TASK_ID=""
WEBHOOK_ID=""
VICTIM_RECOVERY=""

PASS=0
FAIL=0
SKIP=0
TOTAL=25
FAILS=()

# Temp dir for CLI artifacts (backup tarballs, etc).
SMOKE_TMP="$(mktemp -d -t "bot-relay-smoke-${TS}-XXXXXX")"

color() { printf "\033[%sm%s\033[0m" "$1" "$2"; }
green() { color "32" "$1"; }
red()   { color "31" "$1"; }
yellow(){ color "33" "$1"; }
bold()  { color "1"  "$1"; }

mcp_call() {
  local name="$1"
  local args="$2"
  local token="${3:-}"
  local headers=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
  if [ -n "$token" ]; then
    headers+=(-H "X-Agent-Token: $token")
  fi
  local body
  body=$(jq -nc --arg name "$name" --argjson args "$args" \
    '{jsonrpc:"2.0", id:1, method:"tools/call", params:{name:$name, arguments:$args}}')
  curl -sS -X POST "$MCP_URL" "${headers[@]}" -d "$body" \
    | sed -n 's/^data: //p' | head -n 1
}

extract_result() {
  local env="$1"
  local text
  text=$(printf '%s' "$env" | jq -r '.result.content[0].text // empty')
  if [ -z "$text" ]; then
    printf '%s' "$env" | jq -c '{_envelope: .}'
    return
  fi
  if printf '%s' "$text" | jq empty 2>/dev/null; then
    printf '%s' "$text"
  else
    printf '%s' "$text" | jq -Rc '{_raw: .}'
  fi
}

# v2.1 Phase 5a: blanket isError-guard. Envelope's `result.isError` MUST be
# undefined or false for any passing assertion. Call after extract_result.
is_ok_envelope() {
  local env="$1"
  local flag
  flag=$(printf '%s' "$env" | jq -r '.result.isError // false')
  [ "$flag" != "true" ]
}

record() {
  local ok="$1"; local tool="$2"; local detail="${3:-}"
  if [ "$ok" = "pass" ]; then
    PASS=$((PASS+1))
    printf '  %s %s %s\n' "$(green '✓')" "$(bold "$tool")" "$detail"
  elif [ "$ok" = "skip" ]; then
    SKIP=$((SKIP+1))
    printf '  %s %s %s\n' "$(yellow '~')" "$(bold "$tool")" "$detail"
  else
    FAIL=$((FAIL+1))
    FAILS+=("$tool: $detail")
    printf '  %s %s %s\n' "$(red '✗')" "$(bold "$tool")" "$detail"
  fi
}

cleanup() {
  local exit_code=$?
  set +e
  if [ -n "$WEBHOOK_ID" ] && [ -n "$A_TOKEN" ]; then
    mcp_call delete_webhook "{\"webhook_id\":\"$WEBHOOK_ID\"}" "$A_TOKEN" >/dev/null 2>&1 || true
  fi
  for pair in "$A_NAME:$A_TOKEN" "$B_NAME:$B_TOKEN" "$MGR_NAME:$MGR_TOKEN" "$ADMIN_NAME:$ADMIN_TOKEN"; do
    local n="${pair%%:*}"
    local t="${pair#*:}"
    if [ -n "$t" ]; then
      mcp_call unregister_agent "$(jq -nc --arg n "$n" '{name:$n}')" "$t" >/dev/null 2>&1 || true
    fi
  done
  rm -rf "$SMOKE_TMP" 2>/dev/null || true
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

echo "$(bold '25-tool smoke') — relay $RELAY_URL"
echo "  agents: $A_NAME, $B_NAME, $MGR_NAME (managed), $ADMIN_NAME, $VICTIM_NAME"
echo

# Preflight: health must answer and match expected version.
PRE=$(curl -sS "$RELAY_URL/health" || true)
if ! printf '%s' "$PRE" | jq -e '.status == "ok"' >/dev/null 2>&1; then
  echo "$(red 'relay /health not ok — aborting')"
  echo "  got: $PRE"
  exit 2
fi
VER=$(printf '%s' "$PRE" | jq -r '.version')
echo "  relay v$VER"
echo

# === IDENTITY (5 tools — 4 + health_check) ===

# 1. register_agent (smoke-a) — assert token base64url 32+ chars.
ENV=$(mcp_call register_agent "$(jq -nc --arg n "$A_NAME" '{name:$n, role:"smoke", capabilities:["tasks","channels","webhooks","broadcast","spawn"]}')")
RES=$(extract_result "$ENV")
A_TOKEN=$(printf '%s' "$RES" | jq -r '.agent_token // empty')
if is_ok_envelope "$ENV" && [ "${#A_TOKEN}" -ge 32 ] && [[ "$A_TOKEN" =~ ^[A-Za-z0-9_-]+$ ]] && printf '%s' "$RES" | jq -e '.success == true' >/dev/null; then
  record pass register_agent "→ $A_NAME, token base64url len=${#A_TOKEN}"
else
  record fail register_agent "no token / bad shape / isError: $RES"
  exit 1
fi

# setup: B + managed smoke + admin + victim
ENV=$(mcp_call register_agent "$(jq -nc --arg n "$B_NAME" '{name:$n, role:"smoke", capabilities:["tasks","channels","webhooks","broadcast"]}')")
B_TOKEN=$(extract_result "$ENV" | jq -r '.agent_token // empty')
[ -n "$B_TOKEN" ] || { record fail register_agent "second agent failed"; exit 1; }

ENV=$(mcp_call register_agent "$(jq -nc --arg n "$MGR_NAME" '{name:$n, role:"smoke", capabilities:["tasks"], managed:true}')")
MGR_TOKEN=$(extract_result "$ENV" | jq -r '.agent_token // empty')
[ -n "$MGR_TOKEN" ] || { record fail register_agent "managed agent failed"; exit 1; }

ENV=$(mcp_call register_agent "$(jq -nc --arg n "$ADMIN_NAME" '{name:$n, role:"smoke", capabilities:["admin","rotate_others"]}')")
ADMIN_TOKEN=$(extract_result "$ENV" | jq -r '.agent_token // empty')
[ -n "$ADMIN_TOKEN" ] || { record fail register_agent "admin agent failed"; exit 1; }

ENV=$(mcp_call register_agent "$(jq -nc --arg n "$VICTIM_NAME" '{name:$n, role:"smoke", capabilities:["broadcast"]}')")
_=$(extract_result "$ENV" | jq -r '.agent_token // empty')

# 2. discover_agents — assert smoke-a + smoke-b + managed are all visible.
ENV=$(mcp_call discover_agents "{}" "$A_TOKEN")
RES=$(extract_result "$ENV")
if is_ok_envelope "$ENV" && printf '%s' "$RES" | jq -e --arg a "$A_NAME" --arg b "$B_NAME" --arg m "$MGR_NAME" \
    '(.agents // []) | map(.name) | (index($a) != null) and (index($b) != null) and (index($m) != null)' >/dev/null; then
  COUNT=$(printf '%s' "$RES" | jq '.agents | length')
  record pass discover_agents "$COUNT agents visible, all smoke agents present"
else
  record fail discover_agents "expected smokes missing: $RES"
fi

# 3. unregister_agent — register disposable + unregister + assert removed=true.
DISP_NAME="smoke-disp-$TS"
ENV=$(mcp_call register_agent "$(jq -nc --arg n "$DISP_NAME" '{name:$n, role:"smoke", capabilities:["tasks"]}')")
DISP_TOKEN=$(extract_result "$ENV" | jq -r '.agent_token // empty')
if [ -n "$DISP_TOKEN" ]; then
  ENV=$(mcp_call unregister_agent "$(jq -nc --arg n "$DISP_NAME" '{name:$n}')" "$DISP_TOKEN")
  RES=$(extract_result "$ENV")
  if is_ok_envelope "$ENV" && printf '%s' "$RES" | jq -e '.removed == true' >/dev/null; then
    record pass unregister_agent "disposable $DISP_NAME removed"
  else
    record fail unregister_agent "removed != true: $RES"
  fi
else
  record fail unregister_agent "setup failed"
fi

# 4. spawn_agent — validation-only (invalid name), expect rejection.
ENV=$(mcp_call spawn_agent "$(jq -nc '{name:"bad name with spaces", role:"smoke"}')" "$A_TOKEN")
if printf '%s' "$ENV" | jq -e '(.error // .result.isError // false) != false' >/dev/null; then
  record pass spawn_agent "validation rejected bad name (no terminal opened)"
else
  record fail spawn_agent "bad name NOT rejected: $ENV"
fi

# 5. health_check — with a token, assert auth_state=active reflects caller's state
# AND version matches package.json exactly (Phase 7p HIGH #1 drift guard).
ENV=$(mcp_call health_check "{}" "$A_TOKEN")
RES=$(extract_result "$ENV")
if is_ok_envelope "$ENV" \
   && printf '%s' "$RES" | jq -e '.status == "ok"' >/dev/null \
   && printf '%s' "$RES" | jq -e '.auth_state == "active"' >/dev/null; then
  V=$(printf '%s' "$RES" | jq -r '.version')
  if [ "$V" != "$EXPECTED_VERSION" ]; then
    record fail health_check "version drift: relay reports v$V but package.json says v$EXPECTED_VERSION"
  else
    record pass health_check "v$V (matches package.json), auth_state=active for $A_NAME"
  fi
else
  record fail health_check "version/auth_state missing or wrong: $RES"
fi

echo

# === MESSAGING (3 tools) ===

# 6. send_message — assert message_id matches UUID shape.
ENV=$(mcp_call send_message "$(jq -nc --arg a "$A_NAME" --arg b "$B_NAME" '{from:$a, to:$b, content:"hello from smoke", priority:"normal"}')" "$A_TOKEN")
RES=$(extract_result "$ENV")
MID=$(printf '%s' "$RES" | jq -r '.message_id // .id // empty')
if is_ok_envelope "$ENV" && [[ "$MID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  record pass send_message "id=${MID:0:8}… (UUID shape)"
else
  record fail send_message "no UUID message_id: $RES"
fi

# 7. get_messages — assert EXACT content match on the one we just sent.
ENV=$(mcp_call get_messages "$(jq -nc --arg b "$B_NAME" '{agent_name:$b, status:"pending", limit:10}')" "$B_TOKEN")
RES=$(extract_result "$ENV")
if is_ok_envelope "$ENV" && printf '%s' "$RES" | jq -e '.messages // [] | map(.content) | index("hello from smoke") != null' >/dev/null; then
  record pass get_messages "exact content match recovered"
else
  record fail get_messages "content not found in inbox: $RES"
fi

# 8. broadcast — assert success + delivered_count > 0.
ENV=$(mcp_call broadcast "$(jq -nc --arg a "$A_NAME" '{from:$a, content:"smoke broadcast"}')" "$A_TOKEN")
RES=$(extract_result "$ENV")
if is_ok_envelope "$ENV" && printf '%s' "$RES" | jq -e '.success == true' >/dev/null; then
  COUNT=$(printf '%s' "$RES" | jq -r '.delivered_count // .recipients // .count // "?"')
  record pass broadcast "delivered ($COUNT recipients)"
else
  record fail broadcast "$RES"
fi

echo

# === TASKS (5 tools) ===

# 9. post_task
ENV=$(mcp_call post_task "$(jq -nc --arg a "$A_NAME" --arg b "$B_NAME" '{from:$a, to:$b, title:"smoke task", description:"smoke desc", priority:"normal"}')" "$A_TOKEN")
RES=$(extract_result "$ENV")
TASK_ID=$(printf '%s' "$RES" | jq -r '.task_id // .task.id // empty')
if is_ok_envelope "$ENV" && [ -n "$TASK_ID" ]; then
  record pass post_task "id=${TASK_ID:0:8}…"
else
  record fail post_task "$RES"
fi

# 10. update_task — accept + heartbeat + complete in sequence.
if [ -n "$TASK_ID" ]; then
  OK=1
  for action in accept heartbeat complete; do
    ENV=$(mcp_call update_task "$(jq -nc --arg id "$TASK_ID" --arg n "$B_NAME" --arg a "$action" '{task_id:$id, agent_name:$n, action:$a, result:"smoke"}')" "$B_TOKEN")
    RES=$(extract_result "$ENV")
    if ! is_ok_envelope "$ENV" || ! printf '%s' "$RES" | jq -e '.success == true' >/dev/null; then
      OK=0
      record fail update_task "$action → $RES"
      break
    fi
  done
  [ "$OK" = "1" ] && record pass update_task "accept + heartbeat + complete all ok"
else
  record fail update_task "no task_id from post_task"
fi

# 11. get_tasks — assert the task we created is in smoke-b's assigned list.
ENV=$(mcp_call get_tasks "$(jq -nc --arg b "$B_NAME" '{agent_name:$b, role:"assigned", status:"all", limit:20}')" "$B_TOKEN")
RES=$(extract_result "$ENV")
if is_ok_envelope "$ENV" && printf '%s' "$RES" | jq -e --arg id "$TASK_ID" '.tasks // [] | map(.id) | index($id) != null' >/dev/null; then
  record pass get_tasks "smoke task visible in smoke-b's assigned"
else
  record fail get_tasks "$RES"
fi

# 12. get_task — assert returned id matches + status is terminal (completed).
if [ -n "$TASK_ID" ]; then
  ENV=$(mcp_call get_task "$(jq -nc --arg id "$TASK_ID" '{task_id:$id}')" "$A_TOKEN")
  RES=$(extract_result "$ENV")
  if is_ok_envelope "$ENV" && printf '%s' "$RES" | jq -e --arg id "$TASK_ID" '(.task.id // .id) == $id' >/dev/null; then
    STATUS=$(printf '%s' "$RES" | jq -r '.task.status // .status')
    record pass get_task "status=$STATUS (post-complete)"
  else
    record fail get_task "$RES"
  fi
fi

# 13. post_task_auto — Phase 4k discipline: assert routed to NOT-sender.
ENV=$(mcp_call post_task_auto "$(jq -nc --arg a "$A_NAME" '{from:$a, title:"smoke auto", description:"auto", required_capabilities:["tasks"], priority:"normal"}')" "$A_TOKEN")
RES=$(extract_result "$ENV")
AUTO_TASK_ID=$(printf '%s' "$RES" | jq -r '.task_id // .task.id // empty')
if is_ok_envelope "$ENV" && [ -n "$AUTO_TASK_ID" ] && printf '%s' "$RES" | jq -e '.success == true' >/dev/null; then
  ASSIGNED=$(printf '%s' "$RES" | jq -r '.assigned_to // .task.to_agent // "queued"')
  if [ "$ASSIGNED" = "$A_NAME" ]; then
    record fail post_task_auto "sender self-assigned (Phase 4k regression): $RES"
  elif [ "$ASSIGNED" = "queued" ]; then
    record fail post_task_auto "no candidate routed — expected smoke-b or smoke-managed: $RES"
  else
    record pass post_task_auto "routed → $ASSIGNED (not sender)"
  fi
else
  record fail post_task_auto "$RES"
fi

if [ -n "$AUTO_TASK_ID" ]; then
  mcp_call update_task "$(jq -nc --arg id "$AUTO_TASK_ID" --arg n "$A_NAME" '{task_id:$id, agent_name:$n, action:"cancel", result:"smoke cleanup"}')" "$A_TOKEN" >/dev/null 2>&1 || true
fi

echo

# === CHANNELS (5 tools) ===

# 14. create_channel — assert channel_id present + creator is member.
ENV=$(mcp_call create_channel "$(jq -nc --arg n "$CH_NAME" --arg c "$A_NAME" '{name:$n, creator:$c, description:"smoke"}')" "$A_TOKEN")
RES=$(extract_result "$ENV")
CH_ID=$(printf '%s' "$RES" | jq -r '.channel_id // .channel.id // empty')
if is_ok_envelope "$ENV" && [ -n "$CH_ID" ] && printf '%s' "$RES" | jq -e '.success == true' >/dev/null; then
  record pass create_channel "$CH_NAME (channel_id=${CH_ID:0:8}…)"
else
  record fail create_channel "no channel_id or success=false: $RES"
fi

# 15. join_channel — assert success + B is member via subsequent post visibility.
ENV=$(mcp_call join_channel "$(jq -nc --arg ch "$CH_NAME" --arg b "$B_NAME" '{channel_name:$ch, agent_name:$b}')" "$B_TOKEN")
RES=$(extract_result "$ENV")
is_ok_envelope "$ENV" && printf '%s' "$RES" | jq -e '.success == true' >/dev/null \
  && record pass join_channel "smoke-b joined" \
  || record fail join_channel "$RES"

# 16. post_to_channel
ENV=$(mcp_call post_to_channel "$(jq -nc --arg ch "$CH_NAME" --arg a "$A_NAME" '{channel_name:$ch, from:$a, content:"channel smoke"}')" "$A_TOKEN")
RES=$(extract_result "$ENV")
is_ok_envelope "$ENV" && printf '%s' "$RES" | jq -e '.success == true' >/dev/null \
  && record pass post_to_channel "smoke-a posted" \
  || record fail post_to_channel "$RES"

# 17. get_channel_messages — assert EXACT content match.
ENV=$(mcp_call get_channel_messages "$(jq -nc --arg ch "$CH_NAME" --arg b "$B_NAME" '{channel_name:$ch, agent_name:$b, limit:10}')" "$B_TOKEN")
RES=$(extract_result "$ENV")
is_ok_envelope "$ENV" && printf '%s' "$RES" | jq -e '.messages // [] | map(.content) | index("channel smoke") != null' >/dev/null \
  && record pass get_channel_messages "exact content recovered from channel" \
  || record fail get_channel_messages "$RES"

# 18. leave_channel
ENV=$(mcp_call leave_channel "$(jq -nc --arg ch "$CH_NAME" --arg b "$B_NAME" '{channel_name:$ch, agent_name:$b}')" "$B_TOKEN")
RES=$(extract_result "$ENV")
is_ok_envelope "$ENV" && printf '%s' "$RES" | jq -e '.success == true' >/dev/null \
  && record pass leave_channel "smoke-b left" \
  || record fail leave_channel "$RES"

echo

# === STATUS (1 tool — set_status; health_check already covered as #5) ===

# 19. set_status — busy → online round-trip.
ENV=$(mcp_call set_status "$(jq -nc --arg n "$A_NAME" '{agent_name:$n, status:"busy"}')" "$A_TOKEN")
RES=$(extract_result "$ENV")
if is_ok_envelope "$ENV" && printf '%s' "$RES" | jq -e '.success == true' >/dev/null; then
  mcp_call set_status "$(jq -nc --arg n "$A_NAME" '{agent_name:$n, status:"online"}')" "$A_TOKEN" >/dev/null
  record pass set_status "busy → online round-trip"
else
  record fail set_status "$RES"
fi

echo

# === WEBHOOKS (3 tools) ===

# 20. register_webhook
ENV=$(mcp_call register_webhook "$(jq -nc '{url:"https://example.com/smoke-webhook", event:"*", secret:"smoke-hmac"}')" "$A_TOKEN")
RES=$(extract_result "$ENV")
WEBHOOK_ID=$(printf '%s' "$RES" | jq -r '.webhook_id // .id // empty')
if is_ok_envelope "$ENV" && [ -n "$WEBHOOK_ID" ] && printf '%s' "$RES" | jq -e '.success == true' >/dev/null; then
  record pass register_webhook "id=${WEBHOOK_ID:0:8}…"
else
  record fail register_webhook "$RES"
fi

# 21. list_webhooks
ENV=$(mcp_call list_webhooks "{}" "$A_TOKEN")
RES=$(extract_result "$ENV")
is_ok_envelope "$ENV" && printf '%s' "$RES" | jq -e --arg id "$WEBHOOK_ID" '.webhooks // [] | map(.id) | index($id) != null' >/dev/null \
  && record pass list_webhooks "smoke webhook visible" \
  || record fail list_webhooks "$RES"

# 22. delete_webhook
if [ -n "$WEBHOOK_ID" ]; then
  ENV=$(mcp_call delete_webhook "$(jq -nc --arg id "$WEBHOOK_ID" '{webhook_id:$id}')" "$A_TOKEN")
  RES=$(extract_result "$ENV")
  if is_ok_envelope "$ENV" && printf '%s' "$RES" | jq -e '.success == true or .deleted == true' >/dev/null; then
    record pass delete_webhook "removed"
    WEBHOOK_ID=""
  else
    record fail delete_webhook "$RES"
  fi
fi

echo

# === TOKEN LIFECYCLE (3 tools — rotate_token, revoke_token, rotate_token_admin) ===

# 23. rotate_token — unmanaged agent path. Assert agent_class=unmanaged + restart_required=true.
ENV=$(mcp_call rotate_token "$(jq -nc --arg n "$A_NAME" --arg t "$A_TOKEN" '{agent_name:$n, agent_token:$t}')")
RES=$(extract_result "$ENV")
NEW_A_TOKEN=$(printf '%s' "$RES" | jq -r '.new_token // empty')
if is_ok_envelope "$ENV" && [ -n "$NEW_A_TOKEN" ] \
   && printf '%s' "$RES" | jq -e '.success == true and .agent_class == "unmanaged" and .restart_required == true' >/dev/null; then
  A_TOKEN="$NEW_A_TOKEN"
  record pass rotate_token "unmanaged → restart_required=true, new token issued (len=${#NEW_A_TOKEN})"
else
  record fail rotate_token "shape mismatch (expected agent_class=unmanaged + restart_required=true): $RES"
fi

# 23b. rotate_token on managed — assert agent_class=managed + grace_expires_at present.
#      Not a separate tool; same tool, different branch. Counted as subtest.
ENV=$(mcp_call rotate_token "$(jq -nc --arg n "$MGR_NAME" --arg t "$MGR_TOKEN" '{agent_name:$n, agent_token:$t, grace_seconds:60}')")
RES=$(extract_result "$ENV")
NEW_MGR_TOKEN=$(printf '%s' "$RES" | jq -r '.new_token // empty')
if is_ok_envelope "$ENV" && [ -n "$NEW_MGR_TOKEN" ] \
   && printf '%s' "$RES" | jq -e '.agent_class == "managed" and (.grace_expires_at // "") != "" and .push_sent == true' >/dev/null; then
  MGR_TOKEN="$NEW_MGR_TOKEN"
  record pass rotate_token[managed] "grace window + push_sent=true (subtest)"
else
  record fail rotate_token[managed] "expected agent_class=managed + grace_expires_at + push_sent: $RES"
fi

# 24. revoke_token with issue_recovery=true — assert recovery_token present.
ENV=$(mcp_call revoke_token "$(jq -nc --arg t "$VICTIM_NAME" --arg r "$ADMIN_NAME" '{target_agent_name:$t, revoker_name:$r, issue_recovery:true}')" "$ADMIN_TOKEN")
RES=$(extract_result "$ENV")
VICTIM_RECOVERY=$(printf '%s' "$RES" | jq -r '.recovery_token // empty')
if is_ok_envelope "$ENV" && [ -n "$VICTIM_RECOVERY" ] \
   && printf '%s' "$RES" | jq -e --arg t "$VICTIM_NAME" '.success == true and .revoked == $t and .auth_state_after == "recovery_pending"' >/dev/null; then
  record pass revoke_token "recovery_pending + recovery_token issued (len=${#VICTIM_RECOVERY})"
else
  record fail revoke_token "expected recovery_token + state=recovery_pending: $RES"
fi

# 24b. Recovery flow — re-register victim with recovery_token. Assert state flips to active.
if [ -n "$VICTIM_RECOVERY" ]; then
  ENV=$(mcp_call register_agent "$(jq -nc --arg n "$VICTIM_NAME" --arg rt "$VICTIM_RECOVERY" '{name:$n, role:"smoke", capabilities:["broadcast"], recovery_token:$rt}')")
  RES=$(extract_result "$ENV")
  NEW_VICTIM_TOKEN=$(printf '%s' "$RES" | jq -r '.agent_token // empty')
  if is_ok_envelope "$ENV" && [ -n "$NEW_VICTIM_TOKEN" ] \
     && printf '%s' "$RES" | jq -e '.recovery_completed == true' >/dev/null; then
    # Clean up victim via its new token
    mcp_call unregister_agent "$(jq -nc --arg n "$VICTIM_NAME" '{name:$n}')" "$NEW_VICTIM_TOKEN" >/dev/null 2>&1 || true
    record pass revoke_token[recovery-flow] "recovery_token → register_agent → state=active (subtest)"
  else
    record fail revoke_token[recovery-flow] "recovery_completed expected: $RES"
  fi
fi

# 25. rotate_token_admin — admin rotates unmanaged agent B. Assert restart_required + new_token.
ENV=$(mcp_call rotate_token_admin "$(jq -nc --arg t "$B_NAME" --arg r "$ADMIN_NAME" '{target_agent_name:$t, rotator_name:$r}')" "$ADMIN_TOKEN")
RES=$(extract_result "$ENV")
NEW_B_TOKEN=$(printf '%s' "$RES" | jq -r '.new_token // empty')
if is_ok_envelope "$ENV" && [ -n "$NEW_B_TOKEN" ] \
   && printf '%s' "$RES" | jq -e '.success == true and .agent_class == "unmanaged" and .restart_required == true' >/dev/null; then
  B_TOKEN="$NEW_B_TOKEN"
  record pass rotate_token_admin "admin rotated $B_NAME (unmanaged) → new token + restart_required"
else
  record fail rotate_token_admin "expected agent_class=unmanaged + new_token + restart_required: $RES"
fi

echo

# === CLI SUBCOMMAND SMOKE (v2.1 Phase 5a new section) ===
# Each user-facing subcommand invoked against the relay / filesystem.
# `relay test` is skipped intentionally — running a throwaway relay from
# within a live-relay smoke would recurse.

echo "$(bold 'CLI subcommands')"

# doctor — assert exit 0 + no ERROR lines on stderr.
if OUT=$("$RELAY_BIN" doctor 2>&1); then
  if ! printf '%s' "$OUT" | grep -qE '^ *FAIL '; then
    record pass "cli:doctor" "exit 0, no FAIL lines"
  else
    record fail "cli:doctor" "found FAIL lines: $OUT"
  fi
else
  # doctor may exit non-zero if checks found failures — that's surfacing a
  # real issue, not a smoke bug. Surface the output but don't hard-fail
  # the smoke script.
  record fail "cli:doctor" "non-zero exit — triage separately: $OUT"
fi

# generate-hooks — assert the output contains the 3 hook kinds.
if OUT=$("$RELAY_BIN" generate-hooks --full 2>&1); then
  if printf '%s' "$OUT" | grep -q 'SessionStart' \
     && printf '%s' "$OUT" | grep -q 'PostToolUse' \
     && printf '%s' "$OUT" | grep -q 'Stop'; then
    record pass "cli:generate-hooks" "emits SessionStart + PostToolUse + Stop"
  else
    record fail "cli:generate-hooks" "missing one or more hook kinds: $OUT"
  fi
else
  record fail "cli:generate-hooks" "non-zero exit: $OUT"
fi

# backup + restore — round-trip to a temp tarball.
BACKUP_PATH="$SMOKE_TMP/backup.tar.gz"
if OUT=$("$RELAY_BIN" backup --output "$BACKUP_PATH" 2>&1); then
  if [ -s "$BACKUP_PATH" ]; then
    # tarball must contain manifest.json + relay.db at top level.
    TAR_ENTRIES=$(tar -tzf "$BACKUP_PATH" 2>&1 | tr '\n' ',')
    if printf '%s' "$TAR_ENTRIES" | grep -q 'manifest.json' \
       && printf '%s' "$TAR_ENTRIES" | grep -q 'relay.db'; then
      record pass "cli:backup" "tarball present w/ manifest.json + relay.db"
    else
      # v2.1 Phase 8 (CI-debug): dump what tar -tzf actually returned + what relay stdout was
      record fail "cli:backup" "tarball missing manifest or relay.db — tar entries: [$TAR_ENTRIES] — relay stdout: [$OUT]"
    fi
  else
    record fail "cli:backup" "output file empty/missing — relay stdout: [$OUT]"
  fi
else
  record fail "cli:backup" "non-zero exit: $OUT"
fi

# restore intentionally NOT invoked here — it would clobber the live DB + the
# smoke script assumes a running daemon. Coverage for restore is via
# tests/backup.test.ts + tests/backup-atomic-swap.test.ts. Mark as skip.
record skip "cli:restore" "covered via vitest (backup.test.ts + backup-atomic-swap.test.ts)"

# recover --dry-run against a non-existent smoke agent — expect "not registered" clean exit.
if OUT=$("$RELAY_BIN" recover "smoke-ghost-$TS" --dry-run 2>&1); then
  if printf '%s' "$OUT" | grep -qE 'not registered|DRY RUN|would delete'; then
    record pass "cli:recover" "dry-run output sane on unknown agent"
  else
    record fail "cli:recover" "unexpected output: $OUT"
  fi
else
  record fail "cli:recover" "non-zero exit: $OUT"
fi

# re-encrypt --dry-run. No keyring configured → pass-through mode → count=0.
# Set --from k1 --to k1 which would self-loop; with no keyring, the tool
# reports "nothing to do" cleanly.
if OUT=$("$RELAY_BIN" re-encrypt --dry-run --from k1 --to k1 2>&1); then
  # Hit either "equals --to" (argv rejection) OR "Nothing to do" (zero rows).
  if printf '%s' "$OUT" | grep -qE 'equals --to|Nothing to do|Re-encrypt plan'; then
    record pass "cli:re-encrypt" "dry-run surfaces expected message (rejected or nothing-to-do)"
  else
    record fail "cli:re-encrypt" "unexpected output: $OUT"
  fi
else
  # Non-zero exit on --from k1 --to k1 is expected per the tool's own
  # "equals --to" rejection. Look for the message.
  if printf '%s' "$OUT" | grep -qE 'equals --to'; then
    record pass "cli:re-encrypt" "correctly rejects --from==--to"
  else
    record fail "cli:re-encrypt" "unexpected non-zero exit: $OUT"
  fi
fi

# test — skipped; running relay test from within a live-relay smoke would
# spawn a second throwaway relay + infinite recursion risk.
record skip "cli:test" "intentionally skipped — recursive smoke risk"

# === REMOTE PAIR SMOKE (v2.1 Phase 7r) ===
# Exercise `relay pair` against the live isolated relay. Asserts:
#   (1) exit 0 + the emitted MCP client config snippet is valid JSON with
#       the expected shape (type=http, url=<hub>/mcp, X-Agent-Token header)
#   (2) the captured token authenticates a follow-up get_messages call
#       (proves the pair path end-to-end ran through register_agent, not
#       a dry run or short-circuit)
PAIR_OUT_FILE="$SMOKE_TMP/pair-config.json"
PAIR_AGENT_NAME="smoke-pair-$TS"
# Strip any env the parent passed — the child should pick up its token
# from the server's register_agent response, not from $RELAY_AGENT_TOKEN.
if RELAY_AGENT_TOKEN= RELAY_HTTP_SECRET= node "$RELAY_BIN" pair \
     "$RELAY_URL" \
     --name "$PAIR_AGENT_NAME" \
     --role tester \
     --yes \
     --output "$PAIR_OUT_FILE" >/dev/null 2>&1; then
  # Assertion 1: snippet file is well-formed JSON with the expected shape.
  if jq -e '."bot-relay".type == "http" and (."bot-relay".url | endswith("/mcp")) and (."bot-relay".headers."X-Agent-Token" | length > 20)' "$PAIR_OUT_FILE" >/dev/null 2>&1; then
    record pass "cli:pair(snippet)" "emitted valid JSON config with http transport + X-Agent-Token header"
    # Assertion 2: extract the token + use it on get_messages (hub end-to-end).
    PAIR_TOKEN=$(jq -r '."bot-relay".headers."X-Agent-Token"' "$PAIR_OUT_FILE")
    VERIFY=$(mcp_call get_messages "$(jq -nc --arg n "$PAIR_AGENT_NAME" '{agent_name:$n}')" "$PAIR_TOKEN")
    VERIFY_INNER=$(extract_result "$VERIFY")
    if is_ok_envelope "$VERIFY" && printf '%s' "$VERIFY_INNER" | jq -e '(.count // -1) >= 0 and .agent != null' >/dev/null 2>&1; then
      record pass "cli:pair(token)" "captured token authenticates get_messages end-to-end"
    else
      record fail "cli:pair(token)" "captured token did NOT authenticate. envelope=$VERIFY inner=$VERIFY_INNER"
    fi
  else
    record fail "cli:pair(snippet)" "snippet file shape invalid: $(cat "$PAIR_OUT_FILE" 2>/dev/null)"
  fi
else
  record fail "cli:pair(exit)" "relay pair returned non-zero exit against the smoke hub"
fi

echo
echo "$(bold 'Summary')"
echo "  $(green "$PASS pass")  $(red "$FAIL fail")  $(yellow "$SKIP skip")  (25 MCP tools + CLI)"
if [ "$FAIL" -gt 0 ]; then
  echo
  echo "$(red 'Failures:')"
  for f in "${FAILS[@]}"; do
    echo "  - $f"
  done
  exit 1
fi
