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
#   RELAY_INSTANCE_ID        — (v2.4.5) explicit per-instance override. Every DB
#                              path is the ONE resolver's answer (ADR-0048,
#                              src/instance.ts resolveInstance, via relay where).
#   RELAY_AGENT_TOKEN        — (v1.7+) token for authenticated tool calls
#   RELAY_RECOVERY_TOKEN     — (v2.1 Phase 4b.1 v2) admin-issued one-time
#                              recovery secret. If the daemon reports the
#                              agent's state as recovery_pending, this is used
#                              to re-register and mint a fresh agent_token.
#   RELAY_HTTP_HOST          — daemon host (default: 127.0.0.1)
#   RELAY_HTTP_PORT          — daemon port (default: 3777)
#
# Example alias:
#   alias ai='RELAY_AGENT_NAME=orchestrator RELAY_AGENT_ROLE=chief-of-staff claude'
#
# Security notes (v1.6):
# - All env-var inputs are validated against an allowlist regex BEFORE use.
# - Names/roles/caps that contain anything outside [A-Za-z0-9_.-] are rejected.
# - DB_PATH is the resolver's answer (`relay where`, which owns containment); a
#   resolver error skips this hook's OWN sqlite reads (DEGRADED in local mode), it
#   never ends the hook (the mail read is decided by relay pending).
# - SQL is parameterised via sqlite3's `.parameter set` rather than string-interpolated.

# VERDICT BY CONSTRUCTION — must be the FIRST executable code in this file.
# Shared with every other relay hook so there is ONE implementation and no
# inline copy can rot silently. See hooks/_verdict.sh for the full rationale,
# the two invariants, and the honest boundary (SIGKILL / hook-never-runs).
RELAY_VERDICT_STREAM=stdout
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
. "$RELAY_VERDICT_DIR/_verdict.sh"
# HEALTHY ONLY AFTER THE MAIL READ COMPLETED. This hook's HEALTHY is set early
# (the config diagnostic), so any exit before the session-start mail read
# finished (an early `exit`, a kill during a stalled read) would otherwise print
# a health that was never verified. The gate turns an unearned HEALTHY into
# CANNOT-JUDGE at exit. Defined here, after the helper, so a helper that failed
# to load still leaves the fallback trap in place.
RELAY_MAIL_READ_DONE=0
RELAY_TMP_FILES=""
relay_finalize_verdict() {
  # shellcheck disable=SC2086 # a space-separated list of mktemp paths
  [ -n "$RELAY_TMP_FILES" ] && rm -f $RELAY_TMP_FILES 2>/dev/null
  if [ "$RELAY_VERDICT" = "HEALTHY" ] && [ "${RELAY_MAIL_READ_DONE:-0}" != "1" ]; then
    RELAY_VERDICT="CANNOT-JUDGE"
    RELAY_VERDICT_REASON="health unverified: the session-start mail read did not complete"
    RELAY_VERDICT_DETAIL=""
  fi
  relay_emit_verdict
}
trap relay_finalize_verdict EXIT

# v2.0 final (#19): self-check for path truncation. When .claude/settings.json
# references this script with an unquoted path containing spaces, only the
# first word reaches $0 — the script silently fails to find itself.
if [[ "$0" != *"/bot-relay-mcp/hooks/"* ]]; then
  echo "[bot-relay hook WARNING] \$0 does not contain '/bot-relay-mcp/hooks/' — the install path may be truncated. Quote the command string in .claude/settings.json if the path contains spaces. \$0='$0'" >&2
fi

# --- ADR-0036 S1: capture the hook payload ONCE, with a BOUNDED read ----------
# This hook has never read its stdin (every prior `session_id` use is SQL against
# the agents table). `relay bind` needs the payload, so we capture it here — as
# early as possible, so nothing downstream can consume it first — and hand the
# text to the bind block further down.
#
# WHY NOT `cat`: SessionStart runs under a 10s hook timeout. A bare `cat` blocks
# until the writer closes; a hook that hangs costs the ENTIRE session start, which
# is a far worse failure than the silence the announce fixes. So:
#   - a TTY (manual run, no redirect) is "no payload", instantly;
#   - otherwise read with a SHORT idle deadline and take whatever arrived.
# `head -c` bounds the size so a hostile or runaway writer cannot balloon memory.
# Absent payload is NOT an error here (see the bind block): it is what a manual
# run or a non-SessionStart caller looks like.
# MEASURED, and this cost a red canary: a size bound is NOT a time bound.
# `head -c N` returns when it has N bytes OR when the writer closes — against a
# pipe nobody ever writes to it blocks forever. Node's `spawn(cmd, {})` with no
# stdio option hands the child exactly that pipe, which is how CANARY 6
# (regression-plug-and-play) spawns this hook. So the read must be bounded by
# TIME, not bytes. macOS has no `timeout`/`gtimeout` (verified: bash 3.2,
# /usr/bin/perl present), and perl's alarm interrupts a blocking slurp — measured
# at 2s against a FIFO with a live writer that never closes.
# v2.6.1 — vault helpers sourced from a single file (functions only: sourcing
# reads nothing, so stdin is still untouched). The DB path (and so the vault
# beside it) is the ONE resolver's answer (ADR-0048), never a bash derivation.
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_vault-helpers.sh
. "$HOOKS_DIR/_vault-helpers.sh"
# This hook's INSTALLED timeout in seconds. The source of truth is
# src/agent-cli-profiles.ts (the Claude profile's hook list); a test holds the two
# equal. Every blocking call below takes its timeout from what is LEFT of it
# (relay_budget_for in _vault-helpers.sh).
RELAY_HOOK_BUDGET_SECS=10
# A step skipped for want of time is a concluded fault: DEGRADED, "no time budget
# left for STEP" (relay_budget_for calls this by name).
relay_budget_skipped() {
  command -v relay_verdict_raise >/dev/null 2>&1 || return 0
  relay_verdict_raise "DEGRADED" "no time budget left for $1 (${SECONDS}s spent)" " agent=\"${AGENT_NAME:-}\"" other
}

RELAY_HOOK_PAYLOAD=""
if [ ! -t 0 ] && relay_budget_for "the hook payload read" 2; then
  if command -v perl >/dev/null 2>&1; then
    RELAY_HOOK_PAYLOAD=$(RELAY_STEP_SECS="$RELAY_STEP_SECS" perl -e '
      eval {
        local $SIG{ALRM} = sub { die "relay-stdin-timeout\n" };
        alarm $ENV{RELAY_STEP_SECS};
        my $d = do { local $/; <STDIN> };
        alarm 0;
        print substr($d, 0, 1048576) if defined $d;
      };
    ' 2>/dev/null || printf '')
  elif command -v timeout >/dev/null 2>&1; then
    RELAY_HOOK_PAYLOAD=$(timeout "$RELAY_STEP_SECS" head -c 1048576 2>/dev/null || printf '')
  elif command -v gtimeout >/dev/null 2>&1; then
    RELAY_HOOK_PAYLOAD=$(gtimeout "$RELAY_STEP_SECS" head -c 1048576 2>/dev/null || printf '')
  fi
  # NO unbounded fallback. With no way to bound the read, SKIP the payload: the
  # cost of no bind is one unrecorded window, and the cost of a hang is the whole
  # session start. A partial read that timed out is treated as absent too — a
  # truncated payload is not valid JSON and would only produce a confusing refusal.
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
# v2.18.0 — validate the title against the SERVER's allowlist (src/types.ts:
# [A-Za-z0-9_.- ], max 100) and DROP it if it doesn't match. The value is
# raw-interpolated into the register_agent JSON below; a hostile title (quote /
# backslash / newline / JSON fragment) would otherwise malform the payload or be
# server-rejected, failing the whole register + mail delivery. Dropping it keeps
# the handshake landing (focus button just stays disabled). `[[ =~ ]]` matches
# the WHOLE value (newline-safe, unlike line-based grep). Byte-parity with the
# Codex hook (codex-session-start.sh) + bin/codex-relay.
RELAY_TERMINAL_TITLE_RE='^[A-Za-z0-9_. -]{1,100}$'
if [ -n "$RELAY_TERMINAL_TITLE_VALUE" ] && ! [[ "$RELAY_TERMINAL_TITLE_VALUE" =~ $RELAY_TERMINAL_TITLE_RE ]]; then
  RELAY_TERMINAL_TITLE_VALUE=""
fi
# ADR-0048: ask the ONE resolver ONCE, before anything needs a path (the spawn
# manifest and the vault live beside the DB, and the mail read follows). Its
# answer is held in exported RELAY_RES_* variables for every helper below.
relay_where_load "$(cd "$HOOKS_DIR/.." 2>/dev/null && pwd)/bin/relay" || true
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
# The resolver's DB path, or none on a resolver error: never a fallback. The
# hook's own reads (liveness, register, bind, tasks) are gated on it below.
DB_PATH=""
if [ "${RELAY_RES_KIND:-error}" != error ]; then
  DB_PATH="$RELAY_RES_DB_PATH"
fi
HTTP_HOST="${RELAY_HTTP_HOST:-127.0.0.1}"
HTTP_PORT="${RELAY_HTTP_PORT:-3777}"

# v2.16.0 (gate 9) — config `default_agent_name` fallback. Fires ONLY when the
# name is STILL unresolved after env + spawn manifest (i.e. still "default" or
# empty) — so an explicit RELAY_AGENT_NAME and a spawn manifest both WIN (D2
# precedence; multiple terminals that set their own name never collapse into
# one identity). Lets `relay init --agent NAME` give a zero-shell-edit default
# identity. config.json is co-located with the DB (dirname(DB_PATH)/config.json),
# or RELAY_CONFIG_PATH. Parsed with a single-field sed — no jq dependency.
if [ "$AGENT_NAME" = "default" ] || [ -z "$AGENT_NAME" ]; then
  CFG_PATH="${RELAY_CONFIG_PATH:-}"
  if [ -z "$CFG_PATH" ] && [ -n "$DB_PATH" ]; then
    CFG_PATH="$(dirname "$DB_PATH")/config.json"
  fi
  if [ -n "$CFG_PATH" ] && [ -r "$CFG_PATH" ]; then
    CFG_NAME=$(sed -n 's/.*"default_agent_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CFG_PATH" | head -n1)
    if [ -n "$CFG_NAME" ]; then
      AGENT_NAME="$CFG_NAME"
      echo "[bot-relay hook] using default agent name from config: $AGENT_NAME (no RELAY_AGENT_NAME / spawn manifest — set RELAY_AGENT_NAME to override)" >&2
    fi
  fi
fi

# v2.6.1 — vault-first bootstrap. If RELAY_AGENT_TOKEN is unset in env BUT a
# vault file exists for this agent name, hydrate the env from disk before any
# auth-sensitive call below. Closes the spawn-without-pre-mint failure mode
# (3-min broken state hit 2026-05-04 during a builder spawn) and makes restart-of-
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
# Whole-string match via relay_whole_match (bash =~, which macOS bash 3.2 supports:
# MEASURED 25 Sep). The old `echo | grep` passed a multi-line value if any line matched.
# Whole-string match. `echo "$X" | grep -Eq '^RE$'` is LINE-oriented: a
# multi-line value passes if ANY line matches, and the rest rides along into
# whatever the value is used for (Codex round 2 on #280: a newline in
# RELAY_AGENT_NAME reached a sqlite heredoc as SQL). [[ =~ ]] anchors to the
# whole string.
relay_whole_match() { [[ "$1" =~ $2 ]]; }

if [ -n "$AGENT_CAPS" ]; then
  if [ ${#AGENT_CAPS} -gt 256 ] || ! relay_whole_match "$AGENT_CAPS" '^[A-Za-z0-9_.,-]+$'; then
    echo "[bot-relay] RELAY_AGENT_CAPABILITIES has invalid characters or length. Allowed: [A-Za-z0-9_.,-], 1-256 chars." >&2
    exit 0
  fi
fi

# The DB path THIS HOOK's own reads use (liveness, anchor, tasks, topology). The
# mail read does not use it: relay pending resolves its own, through the same
# resolver. Containment is the resolver's (ADR-0048): there is no bash guard.
#   usable     — the resolver named a DB path;
#   unresolved — the resolver reported an error (or could not be asked): this
#                hook's own reads are skipped, and in LOCAL mode that is DEGRADED
#                with the resolver's reason. Never a made-up path, never mute.
RELAY_LOCAL_DB_STATE="usable"
RELAY_LOCAL_DB_WHY=""
if [ -z "$DB_PATH" ]; then
  RELAY_LOCAL_DB_STATE="unresolved"
  # Held to a safe character set: the reason lands inside the one-line verdict.
  RELAY_LOCAL_DB_WHY="instance resolution failed: $(printf '%s' "${RELAY_RES_REASON:-unknown}" | tr -cd 'A-Za-z0-9 _./:()=,-' | cut -c1-200)"
  # LOUD, to the agent (stdout is its context) and the operator: the resolver's
  # own reason names the fix (for example `relay use-instance <id>`). One line:
  # the resolver's --fields answer carries no line break.
  echo "[RELAY] instance resolution FAILED: ${RELAY_RES_REASON:-unknown}" | tee /dev/stderr
fi

# --- SELF-DIAGNOSING MUTE DETECTION -----------------------------------------
# Standing rule: a failure that presents as normal operation must be converted
# into a loud one. Two harms are covered here, and the second is the dangerous
# one because the session looks perfectly healthy while it happens.
#
#   HARM 1 — MUTE. The bot-relay entry in ~/.claude.json points at a path that
#     does not exist, so the MCP server never starts and the session simply has
#     no relay tools. Looks like "nothing to report".
#   HARM 2 — CONNECTED BUT WRONG INSTANCE. Tools work, registration succeeds,
#     health is green — and the process resolved the flat legacy DB while the
#     real mailbox lives under ~/.bot-relay/instances/<id>/. The inbox is empty
#     forever. This is silent message loss; it cost nine days before anyone saw
#     it. Mirrors assertInstanceResolution() in src/instance.ts.
#
# Written to STDOUT deliberately: SessionStart hook stdout is injected into the
# session as context, so the agent itself reads the warning and can refuse to
# proceed as connected. A copy goes to stderr for the operator's terminal.
#
# HARM 2 — the contradiction: instances exist, yet the flat legacy DB is in use.
# Since ADR-0048 the resolver only chooses the flat DB then under the explicit
# RELAY_ALLOW_LEGACY_FALLBACK=1 opt-in, and says so in its warning (which names
# the instances); without the opt-in that state is a resolver error, reported
# above as DEGRADED. An explicit RELAY_DB_PATH is a deliberate operator choice and
# is never flagged (the resolver answers explicit-db then, with no warning).
if [ "${RELAY_RES_KIND:-}" = flat ] && [ -n "${RELAY_RES_WARNING:-}" ]; then
  # Set OUTSIDE the `{ ... } | tee` below: a pipeline runs in a SUBSHELL, so an
  # assignment made inside it is discarded when that subshell exits.
  relay_verdict_set "MUTE" "resolved the legacy DB while instances exist — inbox will read empty" " db=\"$DB_PATH\""
  {
    echo "[RELAY] *** WRONG INSTANCE — DO NOT PROCEED AS CONNECTED ***"
    echo "[RELAY] Relay tools may work, but this session resolved the LEGACY database:"
    echo "[RELAY]     using     : $DB_PATH"
    echo "[RELAY]     resolver  : $RELAY_RES_WARNING"
    echo "[RELAY] Your real mailbox lives under an instance directory, so your inbox will"
    echo "[RELAY] read EMPTY no matter how much mail is sent to you. This is silent message"
    echo "[RELAY] loss, not a quiet inbox."
    echo "[RELAY] FIX: set RELAY_INSTANCE_ID=<id>, or run \`relay use-instance <id>\`, then RESTART."
    echo "[RELAY] Report this to your orchestrator rather than working around it."
  } | tee /dev/stderr
fi

# HARM 1 — the configured MCP server path does not exist => this session is mute.
# Uses node (already a hard dependency of the relay) and stays silent if the
# config is absent or unreadable; a missing check must never break the hook.
if command -v node >/dev/null 2>&1 && [ -r "${HOME}/.claude.json" ]; then
  # SELF-CHECK THE SELF-CHECK. This block's job is to SPEAK UP, so it must not be
  # allowed to fail quietly. It already did once: a top-level `return` in the
  # script below is an Illegal Return SyntaxError, `2>/dev/null` swallowed it,
  # and the entire mute detector was silently disabled while every
  # must-stay-silent test still passed — dead code is silent too.
  # So stderr is captured rather than discarded, and a non-zero exit is reported
  # as a failure OF THE DIAGNOSTIC. A silence-detector that can die silently is
  # worse than none, because its quiet reads as "all clear".
  RELAY_DIAG_ERR=$(mktemp -t relay-diag 2>/dev/null || echo "/tmp/relay-diag.$$")
  RELAY_MUTE_PATH=$(node -e '
    const fs = require("fs");

    // PARSE is allowed to fail quietly: a malformed or unreadable config is a
    // legitimate "cannot judge", not a detector fault, and must not nag.
    // TRAVERSAL is NOT — codex found that a valid but deeply nested config
    // (12k wrappers) overflows the stack, and a broad catch turned that
    // RangeError into a successful zero-output run: no mute warning, no
    // self-check failure, complete silence. So the two are separated, and
    // anything unexpected below is rethrown to become a non-zero exit.
    let c = null;
    try {
      c = JSON.parse(fs.readFileSync(process.env.HOME + "/.claude.json", "utf8"));
    } catch (e) { c = null; }

    // Distinct sentinel: "could not read/parse" must NOT be mistaken for
    // "parsed fine, nothing wrong". Identical observables was the whole bug.
    if (c === null) { process.stdout.write("PARSE-FAILED"); }

    if (c !== null) {

      // Identify the CANONICAL bot-relay entry, not anything merely relay-NAMED.
      // Matching /relay/i on the key falsely accused an unrelated stale server
      // and told the agent to stop acting connected while a perfectly good relay
      // entry existed (codex HIGH). A false "you are mute" is worse than no
      // check at all, because the agent obeys it.
      // Canonical = the key `relay init` writes ("bot-relay"), or a stdio entry
      // whose command path is unmistakably this product.
      const isCanonical = (k, v) => {
        if (k === "bot-relay") return true;
        const args = (v && Array.isArray(v.args)) ? v.args : [];
        return args.some(a => typeof a === "string" && /bot-relay-mcp\/dist\/index\.js$/.test(a));
      };

      // ITERATIVE traversal with an explicit stack. A recursive walk overflows
      // on a deeply nested config, and an overflow here is indistinguishable
      // from "nothing wrong" — codex reproduced exactly that with 12k wrappers.
      // Depth is bounded as defence-in-depth; hitting the bound is reported as
      // a detector failure rather than silently truncating the search.
      const candidates = [];
      const MAX_NODES = 200000;
      let visited = 0;
      const stack = [c];
      while (stack.length > 0) {
        const o = stack.pop();
        if (!o || typeof o !== "object") continue;
        if (++visited > MAX_NODES) {
          throw new Error("relay mute scan aborted: config exceeds " + MAX_NODES + " nodes");
        }
        if (o.mcpServers && typeof o.mcpServers === "object") {
          for (const [k, v] of Object.entries(o.mcpServers)) {
            if (isCanonical(k, v)) candidates.push(v);
          }
        }
        for (const [k, v] of Object.entries(o)) {
          if (k !== "mcpServers" && v && typeof v === "object") stack.push(v);
        }
      }

      // An HTTP/SSE entry has no filesystem path to rot, so it is healthy by
      // construction here. A stdio entry is healthy iff its script exists.
      const pathOf = (v) => (Array.isArray(v.args) ? v.args.find(a => /index\.js$/.test(a)) : null) || null;
      const isHealthy = (v) => {
        if (v && (v.type === "http" || v.type === "sse" || v.url)) return true;
        const p = pathOf(v);
        return p ? fs.existsSync(p) : true; // no resolvable path => cannot judge => do not accuse
      };

      // Only warn when EVERY canonical entry is broken. If any one of them works,
      // this session has relay tools and must not be told otherwise.
      // NOTE: computed as an expression, NOT with early `return` — a top-level
      // return is an Illegal Return SyntaxError under `node -e`, and with the
      // stderr redirect below it fails SILENTLY, disabling this whole check.
      // That exact mistake shipped once and is why the positive control exists.
      const broken =
        (candidates.length === 0 || candidates.some(isHealthy))
          ? ""
          : (candidates.map(pathOf).filter(Boolean)[0] || "");
      process.stdout.write(broken);
    }
  ' 2>"$RELAY_DIAG_ERR")
  RELAY_DIAG_RC=$?
  if [ "$RELAY_DIAG_RC" -ne 0 ]; then
    RELAY_VERDICT_REASON="mute self-check failed to run (exit $RELAY_DIAG_RC)"
    # The detector itself failed to run. Say so — do NOT let this read as "no
    # problems found". This is the exact failure that shipped once.
    {
      echo "[RELAY] *** MUTE SELF-CHECK FAILED TO RUN (exit $RELAY_DIAG_RC) ***"
      echo "[RELAY] The relay-config diagnostic could not execute, so this session's"
      echo "[RELAY] connectivity is UNVERIFIED — treat its silence as unknown, not as healthy."
      RELAY_DIAG_MSG=$(head -c 400 "$RELAY_DIAG_ERR" 2>/dev/null | tr '\n' ' ')
      [ -n "${RELAY_DIAG_MSG:-}" ] && echo "[RELAY]   $RELAY_DIAG_MSG"
    } | tee /dev/stderr
    # DISCARD the partial stdout of a detector that failed. A process can write
    # a plausible-looking path AND THEN die; trusting that byte stream produced
    # two contradictory definitive banners at once — UNVERIFIED and "you are
    # mute" — off untrusted output (codex MED). When the detector failed, the
    # only honest verdict is UNVERIFIED, so the mute branch must not run.
    RELAY_MUTE_PATH=""
  fi
  rm -f "$RELAY_DIAG_ERR" 2>/dev/null
  if [ "${RELAY_MUTE_PATH:-}" = "PARSE-FAILED" ]; then
    RELAY_VERDICT_REASON="relay config could not be read or parsed"
    RELAY_MUTE_PATH=""
    # Blocks the HEALTHY upgrade below. "Could not parse" is CANNOT-JUDGE; the
    # detector ran but reached no conclusion, and treating that as healthy is
    # the exact conflation this redesign exists to remove.
    RELAY_PARSE_FAILED=1
  elif [ -n "${RELAY_MUTE_PATH:-}" ]; then
    # Hoisted out of the piped brace-group below — see subshell note above.
    relay_verdict_set "MUTE" "configured relay path does not exist" " path=\"$RELAY_MUTE_PATH\""
    {
      echo "[RELAY] *** RELAY MUTE — NO RELAY TOOLS THIS SESSION ***"
      echo "[RELAY] The bot-relay MCP entry in ~/.claude.json points at a path that does not exist:"
      echo "[RELAY]     $RELAY_MUTE_PATH"
      echo "[RELAY] The MCP server cannot start, so you have NO relay tools — you are unable to"
      echo "[RELAY] send or receive. Silence from you will look identical to having nothing to say."
      echo "[RELAY] FIX: re-add the server (\`claude mcp add\`) with a path that exists, then RESTART."
      echo "[RELAY] Until then, use the CLI fallback for every message you would have relayed:"
      echo "[RELAY]     node ~/bot-relay-mcp/bin/relay send <TO> \"<MSG>\" --from <YOUR_NAME>"
      echo "[RELAY] Announce this to your orchestrator immediately. Do not proceed as connected."
    } | tee /dev/stderr
  fi

  # THE ONLY UPGRADE TO HEALTHY, and it requires POSITIVE evidence on every
  # clause: the detector actually RAN (rc==0 — an unset rc means we never got
  # here, which is codex's node-absent case handled by construction), it found
  # no broken canonical entry, and nothing earlier downgraded the verdict.
  # Written as an upgrade-only step so no path can reach HEALTHY by default.
  if [ "${RELAY_DIAG_RC:-1}" -eq 0 ] && [ -z "${RELAY_MUTE_PATH:-}" ] \
     && [ -z "${RELAY_PARSE_FAILED:-}" ] && [ "$RELAY_VERDICT" = "CANNOT-JUDGE" ]; then
    relay_verdict_set "HEALTHY" "relay config resolves and instance is consistent" " db=\"$DB_PATH\""
  fi
fi

# --- Session-start mail delivery (F1: this hook selects no message rows) ------
# The ids, their ORDER (the drain's: priority first, then newest) and the bodies
# come from ONE read by `relay pending --with-content` (ADR-0044 point 6), and
# `relay pending` alone decides where the mail lives (the F1 mode rule, the same
# as the PostToolUse and Stop hooks): exit 0 = local, exit 3 = no local instance
# (the labeled remote path when RELAY_HTTP_HOST names one), anything else = a
# LOCAL read that failed, which is DEGRADED ("relay unreadable") and is NEVER
# retried over HTTP.
#   - bodies go through the TS decrypting accessor, so a keyring user sees
#     plaintext, and an undecryptable body shows a placeholder, never `enc:`;
#   - the read marks nothing (read-only handle, no seq), and is bounded by a
#     deadline inside this hook's installed budget (RELAY_HOOK_BUDGET_SECS, minus
#     what registration already used; RELAY_PENDING_TIMEOUT_SECS may only shorten
#     it): a stall is reported;
#   - the header says how many of the canonical total are shown, and an answer
#     whose count contradicts its messages is refused, never shown as no mail.
# This hook's own reads (liveness, anchor, tasks) use the SAME resolver's answer
# (relay where, loaded at the top): one resolution for everything.
#
# FRAMING (shared by the mail and task renderers). This stdout is the agent's
# context AND carries this hook's own "[RELAY] VERDICT=" line, so no sender-chosen
# text may start a line: every line of a body after the first gets a fixed
# continuation prefix. Every line terminator a reader might honour (CR, LF, VT,
# FF, FS/GS/RS, NEL, U+2028, U+2029) counts as a newline; other C0/C1 controls
# and ANSI escapes are stripped; a tab becomes a space. Single-line fields are
# folded onto one line. Framing does not make the content trusted.
RELAY_FRAME_JS='
const relayClean = (v) => String(v == null ? "" : v)
  .replace(/\r\n|[\r\x0b\x0c\x1c-\x1e\x85\u2028\u2029]/g, "\n")
  .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
  .replace(/\x1b[@-_]/g, "")
  .replace(/\u009b[0-?]*[ -\/]*[@-~]/g, "")
  .replace(/\t/g, " ")
  .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
const relayOneLine = (v) => relayClean(v).replace(/\n/g, " ");
const RELAY_CONT = "    | ";
const relayFramed = (v) => relayClean(v).split("\n").join("\n" + RELAY_CONT);
'
# One renderer for both answers. SRC=f1: `relay pending --json --with-content`.
# SRC=http: a get_messages peek from a remote relay. Exit 1 = an answer this hook
# cannot trust (a tool error, a missing field, a count that contradicts the list).
RELAY_MAIL_RENDER_JS='
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let count;
  let shown;
  try {
    if (process.env.SRC === "http") {
      let payload = null;
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (t.startsWith("data:")) { payload = t.slice(5).trim(); break; }
      }
      const rpc = JSON.parse(payload === null ? raw.trim() : payload);
      const result = rpc && rpc.result;
      if (!result || result.isError) process.exit(1);
      const d = JSON.parse(result.content[0].text);
      if (!d || typeof d !== "object" || "error_code" in d || !Array.isArray(d.messages)) process.exit(1);
      if (!Number.isInteger(d.total_pending) || d.total_pending < d.messages.length) process.exit(1);
      if (d.total_pending > 0 && d.messages.length === 0) process.exit(1);
      count = d.total_pending;
      shown = d.messages.map((m) => ({ from: m.from_agent, content: m.content, created_at: m.created_at }));
    } else {
      const d = JSON.parse(raw);
      if (!d || d.ok !== true || !Array.isArray(d.messages) || !Number.isInteger(d.count)) process.exit(1);
      if (d.messages.length !== d.count) process.exit(1);
      count = d.count;
      shown = d.messages.filter((m) => Object.prototype.hasOwnProperty.call(m, "content"));
    }
  } catch {
    process.exit(1);
  }
  if (count === 0) return;
  const via = process.env.SRC === "http" ? " via remote relay" : "";
  const out = ["[RELAY] Pending messages for " + process.env.AN + via + " (showing " + shown.length + " of " + count + "):"];
  for (const m of shown) {
    const body = typeof m.content === "string"
      ? relayFramed(m.content)
      : "[" + relayOneLine(m.content_error || "body unavailable") + "; call get_messages to read it]";
    out.push("  From: " + relayOneLine(m.from || "unknown") + " | " + body + " (" + relayOneLine(m.created_at || "?") + ")");
  }
  process.stdout.write(out.join("\n"));
});
'
RELAY_PENDING_SHOW=10

# Verdicts on the mail path go through the TOTAL ORDER (relay_verdict_raise in
# _verdict.sh): the most severe wins, and at the same level both reasons are
# kept, the mail-path one first. Without the helper (it failed to load), nothing
# is changed: the fallback verdict stands.
relay_mail_verdict() { # WORD REASON [mail|other]
  command -v relay_verdict_raise >/dev/null 2>&1 || return 0
  relay_verdict_raise "$1" "$2" " agent=\"$AGENT_NAME\"" "${3:-mail}"
}
# A concluded fault on the mail path: DEGRADED, "<reason>".
relay_degrade() {
  relay_mail_verdict "DEGRADED" "$1" mail
}

relay_mail_unreadable() {
  local why
  why=$(printf '%s' "$1" | tr -cd 'A-Za-z0-9 _./:()=,-' | cut -c1-200)
  echo "[RELAY] relay unreadable: pending mail for $AGENT_NAME could not be read at session start. Mail may be waiting: call get_messages. (relay pending $AGENT_NAME shows the reason.)"
  echo "[bot-relay] local mail read failed for $AGENT_NAME: $why. Pending mail NOT delivered to context; no HTTP fallback." >&2
  relay_degrade "relay unreadable: ${why:-the local relay mailbox could not be read}"
}

relay_remote_failed() {
  echo "[RELAY] remote relay read failed: pending mail for $AGENT_NAME could not be read at session start. Mail may be waiting: call get_messages."
  echo "[bot-relay] remote mail read failed for $AGENT_NAME: $1" >&2
  RELAY_MAIL_MODE="remote-failed"
  relay_mail_verdict "CANNOT-JUDGE" "remote relay read failed: $1" mail
}

# REMOTE mode only (relay pending said: no local instance; RELAY_HTTP_HOST set).
relay_deliver_remote_mail() {
  local host="$RELAY_HTTP_HOST" port="${RELAY_HTTP_PORT:-3777}" tok="${RELAY_AGENT_TOKEN:-}" payload resp block
  if ! relay_whole_match "$host" '^[A-Za-z0-9_.:-]{1,253}$' || ! relay_whole_match "$port" '^[0-9]{1,5}$' \
     || ! relay_whole_match "$tok" '^[A-Za-z0-9_=.-]{8,128}$' || ! command -v curl >/dev/null 2>&1; then
    relay_remote_failed "no usable remote relay settings, token or curl"
    return 0
  fi
  payload=$(AN="$AGENT_NAME" AT="$tok" LIM="$RELAY_PENDING_SHOW" node -e '
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "get_messages",
      arguments: { agent_name: process.env.AN, status: "pending", limit: Number(process.env.LIM), peek: true, since: "all", agent_token: process.env.AT },
    } }));' 2>/dev/null) || { relay_remote_failed "could not build the request"; return 0; }
  # The remote read IS the mail read: it draws on what is left (margin, no reserve).
  if ! relay_budget_for "the remote mail read" 4 margin; then
    relay_remote_failed "no time budget left for the remote mail read"
    return 0
  fi
  resp=$(curl -fsS -m "$RELAY_STEP_SECS" -X POST "http://${host}:${port}/mcp" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -H "X-Agent-Token: $tok" --data "$payload" 2>/dev/null) || { relay_remote_failed "the remote relay did not answer"; return 0; }
  block=$(printf '%s' "$resp" | SRC=http AN="$AGENT_NAME" node -e "$RELAY_FRAME_JS$RELAY_MAIL_RENDER_JS" 2>/dev/null) \
    || { relay_remote_failed "the remote relay answered with an error or an untrusted page"; return 0; }
  RELAY_MAIL_READ_DONE=1
  RELAY_MAIL_MODE="remote"
  if [ -n "$block" ]; then
    printf '%s\n\n' "$block"
    echo "[bot-relay] $AGENT_NAME has pending messages (delivered to context, via remote relay)." >&2
  fi
}

RELAY_MAIL_MODE="" # local | unreadable | remote | remote-failed | none | unresolved-name

relay_deliver_pending_mail() {
  local bin outf errf deadline out="" rc=127 why="" block=""
  # The unresolved fallback name is never an identity (ADR-0044 point 5): relay
  # pending refuses it, and no mail is read for it. That is no judgement, not a
  # fault of the relay.
  case "$AGENT_NAME" in
    [Dd][Ee][Ff][Aa][Uu][Ll][Tt])
      echo "[bot-relay] mail not read at session start: this window's agent name is unresolved (\"default\"). Run: relay init --agent <name> (or set RELAY_AGENT_NAME)." >&2
      RELAY_MAIL_MODE="unresolved-name"
      relay_mail_verdict "CANNOT-JUDGE" "agent name unresolved (default): mail not read; run relay init --agent <name>, or set RELAY_AGENT_NAME" mail
      return 0
      ;;
  esac
  bin="$(cd "$HOOKS_DIR/.." 2>/dev/null && pwd)/bin/relay"
  # The TRUE cause when the read cannot even start: never phrased as an unreadable DB.
  if ! command -v node >/dev/null 2>&1; then
    why="node not found (the relay CLI runs on node)"
  elif [ ! -f "$bin" ]; then
    why="no relay CLI beside this hook ($bin)"
  else
    outf="$(mktemp 2>/dev/null || printf '')"
    errf="$(mktemp 2>/dev/null || printf '')"
    if [ -z "$outf" ] || [ -z "$errf" ]; then
      why="could not create a private temp file for the read"
    else
      RELAY_TMP_FILES="$RELAY_TMP_FILES $outf $errf $outf.timedout"
      # node runs DIRECTLY into files under a watchdog, inside what is LEFT of this
      # hook's installed budget (relay_run_pending / relay_pending_deadline).
      if relay_budget_for "the mail read" "$(relay_pending_deadline "$RELAY_HOOK_BUDGET_SECS")" margin; then
        deadline="$RELAY_STEP_SECS"
      else
        # No time left for the read: SKIP it and say so (never a floored 1s read).
        rc=125
        why="no time budget left (${SECONDS}s spent before the mail read)"
      fi
      if [ "$rc" -ne 125 ]; then
        relay_run_pending "$deadline" "$outf" "$errf" node "$bin" pending "$AGENT_NAME" --json --with-content "$RELAY_PENDING_SHOW"
        rc=$?
        out=$(cat "$outf" 2>/dev/null)
        why=$(grep -m 1 'PENDING_' "$errf" 2>/dev/null)
      fi
      if [ "$rc" -eq 125 ]; then
        :
      elif [ "$rc" -eq 124 ]; then
        why="timed out after ${deadline}s"
      elif [ "$rc" -ne 0 ] && [ "$rc" -ne 3 ] && [ -z "$why" ]; then
        why="node crashed (exit $rc): relay pending gave no reason"
      fi
    fi
  fi
  case "$rc" in
    0)
      block=$(printf '%s' "$out" | SRC=f1 AN="$AGENT_NAME" node -e "$RELAY_FRAME_JS$RELAY_MAIL_RENDER_JS" 2>/dev/null) \
        || { RELAY_MAIL_MODE="unreadable"; relay_mail_unreadable "relay pending returned an answer this hook cannot trust"; return 0; }
      ;;
    3)
      if [ -n "${RELAY_HTTP_HOST:-}" ]; then
        relay_deliver_remote_mail
        return 0
      fi
      # Nothing to read, and no judgement made about the mail.
      RELAY_MAIL_MODE="none"
      relay_mail_verdict "CANNOT-JUDGE" "no local relay instance and no remote relay configured" mail
      return 0
      ;;
    *)
      RELAY_MAIL_MODE="unreadable"
      relay_mail_unreadable "${why:-relay pending failed (exit $rc)}"
      return 0
      ;;
  esac
  RELAY_MAIL_READ_DONE=1
  RELAY_MAIL_MODE="local"
  if [ -n "$block" ]; then
    printf '%s\n\n' "$block"
    echo "[bot-relay] $AGENT_NAME has pending messages (delivered to context)." >&2
  fi
}

# No usable local DB file for THIS hook's own reads: the rest of this hook
# (liveness, register, bind, tasks) needs one, but the MAIL DECISION does not.
# The order (the F1 mode rule, D2): the name is resolved; relay pending decides
# the source (a configured DB that is missing is a loud local failure; no local
# instance at all is the labeled remote path when one is configured); and only in
# LOCAL mode does a resolver error count here, as DEGRADED with its reason,
# because its liveness and task reads were skipped. Never a mute exit.
if [ "$RELAY_LOCAL_DB_STATE" != "usable" ] || [ ! -f "$DB_PATH" ]; then
  relay_deliver_pending_mail
  if [ "$RELAY_LOCAL_DB_STATE" = "unresolved" ]; then
    case "$RELAY_MAIL_MODE" in
      local|unreadable)
        relay_mail_verdict "DEGRADED" "$RELAY_LOCAL_DB_WHY: liveness and task reads skipped" other
        ;;
    esac
  fi
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
# ADR-0036 S1 (§8a D7 f): did the daemon answer? Recorded by the first HTTP call that
# proves it either way ("" = not known yet, 1 = answered, 0 = unreachable). The verdict
# block after register reads it, so a daemon that never came up cannot print HEALTHY.
DAEMON_REACHABLE=""
if [ -n "${RELAY_AGENT_TOKEN:-}" ] && command -v curl >/dev/null 2>&1 && relay_budget_for "the token health check" 2; then
  HEALTH_BODY=$(curl -s -m "$RELAY_STEP_SECS" -X POST "http://${HTTP_HOST}:${HTTP_PORT}/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "X-Agent-Token: ${RELAY_AGENT_TOKEN}" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_check","arguments":{}}}' 2>/dev/null)
  if [ -n "$HEALTH_BODY" ]; then
    # A body proves the daemon answered. An EMPTY body proves nothing (refused or timed
    # out), so it leaves DAEMON_REACHABLE unknown for the later checks to settle.
    DAEMON_REACHABLE=1
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
  if [ "$AUTH_STATE" = "recovery_pending" ] && [ -n "${RELAY_RECOVERY_TOKEN:-}" ] && relay_budget_for "the recovery registration" 4; then
    # Build capabilities JSON for the recovery register_agent call. Re-uses
    # the allowlist logic below (hoisted here so recovery path can call it).
    CAPS_JSON="[]"
    if [ -n "$AGENT_CAPS" ]; then
      CAPS_JSON=$(echo "$AGENT_CAPS" | awk -F',' '{
        printf "[";
        n = 0;
        for (i=1; i<=NF; i++) {
          gsub(/^ +| +$/, "", $i);
          if ($i !~ /^[A-Za-z0-9_.-]+$/) continue;
          printf "%s\"%s\"", (n++ ? "," : ""), $i;
        }
        printf "]";
      }')
    fi
    RECOVERY_BODY=$(curl -s -m "$RELAY_STEP_SECS" -X POST "http://${HTTP_HOST}:${HTTP_PORT}/mcp" \
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
      # ADR-0036 S1 (D7): the EXIT trap would otherwise print the HEALTHY set above.
      [ "$RELAY_VERDICT" = "HEALTHY" ] && command -v relay_verdict_set >/dev/null 2>&1 \
        && relay_verdict_set "AUTH_FAILED" "recovery with RELAY_RECOVERY_TOKEN failed" " agent=\"$AGENT_NAME\""
      exit 1
    fi
  else
    # Stale or revoked token, no recovery credential available.
    echo "[relay] Agent \"$AGENT_NAME\" has a stale or revoked token (health_check returned auth_error)." >&2
    echo "[relay] If an admin issued a recovery token for this agent, set RELAY_RECOVERY_TOKEN=<token> and restart this terminal." >&2
    echo "[relay] Otherwise, request a recovery_token via revoke_token(issue_recovery=true) from an admin-capable agent." >&2
    # ADR-0036 S1 (D7): the EXIT trap would otherwise print the HEALTHY set above.
    [ "$RELAY_VERDICT" = "HEALTHY" ] && command -v relay_verdict_set >/dev/null 2>&1 \
      && relay_verdict_set "AUTH_FAILED" "stale or revoked token (health_check returned auth_error)" " agent=\"$AGENT_NAME\""
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
      n = 0;
      for (i=1; i<=NF; i++) {
        gsub(/^ +| +$/, "", $i);
        if ($i !~ /^[A-Za-z0-9_.-]+$/) continue;
        printf "%s\"%s\"", (n++ ? "," : ""), $i;
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
# v2.11.0 GAP 1: the skip is now LIVENESS-scoped (see the SKIP_REGISTER block
# below) — it fires only for a fresh+live row (true spawn handoff), not for a
# relaunch of an offline/stale row, so the Tether PID-handshake can refresh.
# v2.1 Phase 4b.1 v2: also skip if we just completed a recovery above — the
# register_agent over HTTP already wrote the row.
SKIP_REGISTER=0
if [ "$RECOVERY_COMPLETED" -eq 1 ]; then
  SKIP_REGISTER=1
elif [ -n "${RELAY_AGENT_TOKEN:-}" ]; then
  # v2.11.0 GAP 1: only skip the re-register when the existing row is FRESH +
  # LIVE — i.e. a session was claimed within the last 120s. That is the
  # spawn-handoff / concurrent-terminal case Phase 4j was protecting (don't let
  # this hook clobber a row the parent JUST pre-registered, and don't race a
  # second concurrent terminal of the same name).
  #
  # When the row's session is OFFLINE (session_id NULL/empty) or STALE
  # (last_seen > 120s), this is a genuine RELAUNCH: fall through and call
  # register_agent so the Tether PID-handshake fields (host_shell_pids,
  # host_id) refresh to THIS terminal's live process chain and session_id is
  # repopulated. Without this, a long-lived persona-builder relaunch never
  # re-sends its PID chain → Tether can't bind it → no autowake (the exact
  # bug a long-lived builder hit: pre-existing row + token → permanent skip → empty
  # host_shell_pids). The re-register is auth-gated server-side (enforceAuth
  # requires the row's own token) + collision-guarded (handler rejects a row
  # that is genuinely live), so falling through is safe.
  #
  # v2.14.1 — a row is only treated as LIVE (skip) when it ALSO already carries
  # host_shell_pids. A freshly pre-registered/spawned child (or any row that
  # never captured its PID handshake) has EMPTY host_shell_pids → treated as
  # STALE → we fall through and register, so the child's FIRST hook run captures
  # host_shell_pids + host_id + agent_pid. Paired with the spawn-side offline
  # pre-register (src/tools/spawn.ts), which keeps that register from tripping
  # the collision guard. Populated-live rows still skip as before.
  # Every sqlite3 read runs under the watchdog, at what is left of the budget.
  LIVENESS=""
  relay_budget_for "the liveness read" 1 && LIVENESS=$(relay_run_capture "$RELAY_STEP_SECS" /dev/stdin sqlite3 "$DB_PATH" <<SQL 2>/dev/null
.parameter set :name '$AGENT_NAME'
SELECT CASE
  WHEN session_id IS NOT NULL AND session_id != ''
       AND (julianday('now') - julianday(last_seen)) * 86400 < 120
       AND host_shell_pids IS NOT NULL AND host_shell_pids != ''
  THEN 'LIVE' ELSE 'STALE' END
FROM agents WHERE name = :name LIMIT 1;
SQL
)
  if [ "$LIVENESS" = "LIVE" ]; then
    SKIP_REGISTER=1

    # --- Fork B (ADR-0012 amended): DEAD-ANCHOR DIAGNOSTIC ------------------
    # The 120s LIVE gate SKIPS re-register — correct for a true spawn handoff /
    # concurrent terminal. But on a FAST (<120s) resummon of a NEW terminal
    # whose PRIOR terminal died, the row still carries the dead prior session's
    # session_id + host_shell_pids + agent_pid, so it reads LIVE and we skip →
    # this terminal stays bound to a DEAD chain → no wake reaches it and Tether
    # cannot bind a terminal to it → UNWAKEABLE. And the config-level HEALTHY
    # verdict above LIES about it — the exact silence-as-health bug this arc
    # exists to kill.
    #
    # Fork B does NOT auto-refresh the binding (safe automatic takeover needs
    # session-bound mailbox auth too = ADR-0013, NOT this build). Instead: probe
    # the STORED anchor (anchor-only, same-host — relay_anchor_liveness, the bash
    # twin of TS anchorLivenessVerdict, pinned by the conformance test) and:
    #   dead        → KILL the false-HEALTHY, name the exact non-destructive
    #                 remedy (`relay release-binding`, which PROCEEDS on a dead
    #                 anchor — diagnostic and remedy agree by construction).
    #   unverifiable→ can't assert HEALTHY, but can't assert dead either: emit
    #                 TAKEOVER_LIVENESS_UNVERIFIABLE and point at the --override
    #                 remedy (release-binding REFUSES here without it, so naming
    #                 the bare command would deadlock — name --override instead).
    #   alive       → genuinely-live 2nd terminal / same agent → skip is correct,
    #                 leave the verdict untouched. This is the no-false-fire crux.
    # NEVER auto-forces. Suppressed when already MUTE (a bigger, more-actionable
    # problem dominates the verdict line).
    # With no time left for the anchor read there is no diagnosis to make (the skip
    # is DEGRADED on its own): never a verdict from an anchor that was not read.
    if [ "$RELAY_VERDICT" != "MUTE" ] && relay_budget_for "the anchor read" 1; then
      RELAY_OWN_GUID=$(relay_machine_guid 2>/dev/null || printf '')
      RELAY_ANCHOR_ROW=$(relay_run_capture "$RELAY_STEP_SECS" /dev/stdin sqlite3 -separator '|' "$DB_PATH" <<SQL 2>/dev/null
.parameter set :name '$AGENT_NAME'
SELECT COALESCE(agent_pid,''), COALESCE(agent_pid_start,''), COALESCE(host_id,'')
FROM agents WHERE name = :name LIMIT 1;
SQL
)
      RELAY_A_PID="${RELAY_ANCHOR_ROW%%|*}"
      RELAY_A_REST="${RELAY_ANCHOR_ROW#*|}"
      RELAY_A_START="${RELAY_A_REST%%|*}"
      RELAY_A_HOST="${RELAY_A_REST##*|}"
      RELAY_ANCHOR_VERDICT=$(relay_anchor_liveness "$RELAY_A_PID" "$RELAY_A_START" "$RELAY_A_HOST" "$RELAY_OWN_GUID")

      # The exact remedy command, path-quoted (the repo path can contain spaces).
      RELAY_BIN_ABS="$(cd "$HOOKS_DIR/.." 2>/dev/null && pwd)/bin/relay"
      if [ -f "$RELAY_BIN_ABS" ]; then
        RELAY_RELEASE_CMD="node \"$RELAY_BIN_ABS\" release-binding $AGENT_NAME"
      else
        RELAY_RELEASE_CMD="relay release-binding $AGENT_NAME"
      fi

      case "$RELAY_ANCHOR_VERDICT" in
        dead)
          {
            echo "[RELAY] ============== UNWAKEABLE: STALE BINDING =============="
            echo "[RELAY] \"$AGENT_NAME\" reads live (session claimed <120s ago) but its recorded"
            echo "[RELAY] agent process (pid $RELAY_A_PID) is DEAD on this host. This terminal is"
            echo "[RELAY] bound to a dead session chain: NO wake will reach you and Tether cannot"
            echo "[RELAY] bind a terminal to it. The relay LOOKS healthy and is NOT."
            echo "[RELAY] FIX (non-destructive — preserves your token, name, capabilities):"
            echo "[RELAY]     $RELAY_RELEASE_CMD"
            echo "[RELAY] Then relaunch this agent; its next SessionStart re-binds cleanly."
          } | tee /dev/stderr
          relay_verdict_set "UNWAKEABLE" "stale binding: session reads live but agent_pid $RELAY_A_PID is dead on this host" " agent=\"$AGENT_NAME\" remedy=\"release-binding\""
          ;;
        unverifiable)
          {
            echo "[RELAY] ============ LIVENESS UNVERIFIABLE (live-skip) ============"
            echo "[RELAY] \"$AGENT_NAME\" reads live but its binding anchor cannot be verified on"
            echo "[RELAY] this host (no probe-able agent_pid, or a cross-host row). You may be fine,"
            echo "[RELAY] OR an unwakeable resummon — this hook cannot tell them apart, so it will"
            echo "[RELAY] NOT guess and will NOT take over."
            echo "[RELAY] If you are NOT receiving wakes AND have confirmed the prior process is gone:"
            echo "[RELAY]     $RELAY_RELEASE_CMD --override"
          } | tee /dev/stderr
          relay_verdict_set "TAKEOVER_LIVENESS_UNVERIFIABLE" "live-reading binding for \"$AGENT_NAME\" has no verifiable same-host anchor" " agent=\"$AGENT_NAME\""
          ;;
        alive)
          : # genuinely live — skip is correct; leave the verdict as-is
          ;;
      esac
    fi
    # --- end dead-anchor diagnostic ----------------------------------------
  fi
fi

# v2.16.3 — relay_machine_guid + relay_pid_chain (Tether v0.3 PID-handshake)
# moved to _vault-helpers.sh (sourced above) so the Codex SessionStart hook
# shares ONE copy and reports the SAME handshake → Tether can PID-bind Codex
# terminals, not just Claude. Byte-identical behavior here (no inline copy).
#
# v2.15.0 — relay_agent_pid + relay_pid_start moved to _vault-helpers.sh (sourced
# above) so check-relay.sh, the Codex hook, and post-tool-use-check.sh share one
# copy. No inline definition here.

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
REGISTER_RAN=0
if [ "$SKIP_REGISTER" -eq 0 ] && command -v curl >/dev/null 2>&1 && relay_budget_for "registration" 4; then
  REGISTER_RAN=1
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
  # v2.14.1 — the agent's OWN process (presence). Best-effort: empty →
  # field omitted → age-based fallback (like host_shell_pids). agent_pid_start
  # is only sent when agent_pid resolved.
  RELAY_AGENT_PID=$(relay_agent_pid 2>/dev/null || printf '')
  RELAY_AGENT_PID_START=""
  [ -n "$RELAY_AGENT_PID" ] && RELAY_AGENT_PID_START=$(relay_pid_start "$RELAY_AGENT_PID" 2>/dev/null || printf '')
  REG_BODY=$(curl -s -m "$RELAY_STEP_SECS" -w "\nHTTP_STATUS:%{http_code}\n" \
    -X POST "http://${HTTP_HOST}:${HTTP_PORT}/mcp" \
    "${REG_HEADERS[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"register_agent\",\"arguments\":{\"name\":\"${AGENT_NAME}\",\"role\":\"${AGENT_ROLE}\",\"capabilities\":${CAPS_JSON},\"cli_profile\":\"claude\"${RELAY_TERMINAL_TITLE_VALUE:+,\"terminal_title_ref\":\"${RELAY_TERMINAL_TITLE_VALUE}\"}${RELAY_HOST_PID_CHAIN:+,\"host_shell_pids\":${RELAY_HOST_PID_CHAIN}}${RELAY_HOST_GUID:+,\"host_id\":\"${RELAY_HOST_GUID}\"}${RELAY_AGENT_PID:+,\"agent_pid\":${RELAY_AGENT_PID}}${RELAY_AGENT_PID_START:+,\"agent_pid_start\":\"${RELAY_AGENT_PID_START}\"}}}}" \
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
  # vault was never written on first-spawn — the first-spawn bug hit
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
  # Silent-failure class (onboarding launch gate): a FIRST-spawn registration that
  # FAILED leaves the agent token-less and mute. On a first spawn there is no token,
  # so the health_check auth probe above was skipped; if register_agent then fails
  # for a non-auth reason — realistically NAME_COLLISION_ACTIVE, another live agent
  # already holds the name — the daemon returns `isError:true` with NO agent_token
  # (a 200-with-isError, NOT a non-200), we mint nothing, and RELAY_AGENT_TOKEN
  # stays empty. The agent can still READ mail (the sqlite3 path below) but every
  # SEND fails AUTH_FAILED — registered-looking, mute, and until now unannounced.
  # Announce it: an agent that cannot send must not read as connected. Gated on
  # token-STILL-empty AND isError, so a successful re-register (token preserved,
  # isError absent) and a clean first-mint (token now set) both stay silent.
  # NOTE: `isError` sits at the JSON-RPC RESULT level, so it is UNESCAPED
  # (`"isError":true`) — unlike error_code/auth_error which live inside the
  # stringified tool content and carry `\"…\"`. Verified against the live wire.
  if [ -z "${RELAY_AGENT_TOKEN:-}" ] && printf '%s' "$REG_BODY" | grep -qE '"isError":[[:space:]]*true'; then
    echo "[RELAY] *** REGISTRATION FAILED — you can read mail but CANNOT SEND ***" >&2
    echo "[relay] register_agent issued no token for \"$AGENT_NAME\" (the server returned an error)." >&2
    echo "[relay] You can READ mail, but every SEND this session will fail with AUTH_FAILED." >&2
    echo "[relay] Most likely: the name \"$AGENT_NAME\" is already held by another ACTIVE agent." >&2
    echo "[relay] Choose a unique RELAY_AGENT_NAME and restart, or set RELAY_HOOK_DEBUG=1 to see the server's reason." >&2
  fi
  # If $RELAY_HOOK_DEBUG is set, print the full response for troubleshooting.
  # Otherwise stay quiet: the token-less failure case is announced just above, and
  # a stale/revoked-token case was already surfaced (with exit 1) by the earlier
  # health_check probe. We just don't want to corrupt the DB with a fallback
  # sqlite3 write.
  if [ -n "${RELAY_HOOK_DEBUG:-}" ]; then
    echo "[bot-relay hook debug] register_agent response:" >&2
    echo "$REG_BODY" >&2
  fi
fi

# --- ADR-0036 S1 (§8a D7 f): the verdict reflects what register actually did ---
# The config self-check above may already have upgraded to HEALTHY, before register ran.
# Settle whether the daemon answered, then REPLACE HEALTHY (never a louder verdict) when
# it did not, or when register itself failed. A HEALTHY printed after a reboot where the
# daemon never came up is the false-comfort class this exists to remove.
REGISTER_ATTEMPTED=0
if [ "$REGISTER_RAN" -eq 1 ]; then
  REGISTER_ATTEMPTED=1
  # The register curl appends "HTTP_STATUS:<code>"; 000 = connection refused or timed out.
  if printf '%s\n' "${REG_BODY:-}" | grep -q '^HTTP_STATUS:000$'; then
    DAEMON_REACHABLE=0
  elif printf '%s\n' "${REG_BODY:-}" | grep -qE '^HTTP_STATUS:[1-9][0-9]{2}$'; then
    DAEMON_REACHABLE=1
  fi
fi
if [ -z "$DAEMON_REACHABLE" ] && command -v curl >/dev/null 2>&1 && relay_budget_for "the daemon probe" 1; then
  # Register was skipped (a LIVE row or a completed recovery), so nothing above proved
  # the daemon is up. One bounded probe settles it.
  if curl -fsS --max-time "$RELAY_STEP_SECS" "http://${HTTP_HOST}:${HTTP_PORT}/health" >/dev/null 2>&1; then
    DAEMON_REACHABLE=1
  else
    DAEMON_REACHABLE=0
  fi
fi
if [ "$RELAY_VERDICT" = "HEALTHY" ] && command -v relay_verdict_set >/dev/null 2>&1; then
  if ! command -v curl >/dev/null 2>&1; then
    relay_verdict_set "DEGRADED" "curl unavailable: register skipped, wake may be unavailable" " agent=\"$AGENT_NAME\""
  elif [ "$DAEMON_REACHABLE" = "0" ]; then
    relay_verdict_set "DEGRADED" "daemon unreachable: register skipped, wake may be unavailable" " agent=\"$AGENT_NAME\" port=\"$HTTP_PORT\""
  elif [ "$REGISTER_ATTEMPTED" -eq 1 ] && printf '%s' "${REG_BODY:-}" | grep -qE '"isError":[[:space:]]*true'; then
    relay_verdict_set "REGISTER_FAILED" "register_agent returned an error (for example the name is held by another live agent)" " agent=\"$AGENT_NAME\""
  fi
fi

# --- ADR-0036 S1: RECORD this window's binding, and SAY SO ---------------------
# A window that becomes X without saying so is the same silence-as-health failure
# the rest of this hook exists to end. So the bind ANNOUNCES on stdout, where both
# a human and the next agent read it.
#
# PLACED HERE deliberately: after register has run and after the verdict above
# has settled what the daemon actually did, but BEFORE mail delivery — so the
# context reads "who am I" before "what is waiting for me".
#
# DB-DIRECT, NEVER THROUGH THE DAEMON (ADR-0036 §2.2): a daemon slow to start
# after a reboot must not be able to cause a missed bind. Nothing below contacts
# the daemon, and the bind is expected to succeed with the daemon down.
#
# THREE OUTCOMES, deliberately NOT treated alike:
#   absent payload      → silent. A manual run or a non-SessionStart caller is
#                         not a failure, and warning on it would train the
#                         operator to ignore this line.
#   refused (malformed, → LOUD on stderr, verdict UNTOUCHED. This session is
#   no session_id, bad    otherwise fine; degrading it would mask a real
#   anchor)               problem behind a payload quirk.
#   schema not migrated → SYSTEMIC (RULING 1): mid-rollout, NO window anywhere is
#                         being recorded, so it goes into the VERDICT. Only
#                         replaces HEALTHY/DEGRADED-for-a-softer-reason; it never
#                         masks a louder verdict such as MUTE or UNWAKEABLE.
# STREAM DISCIPLINE: the announcement is stdout (it is context); every refusal is
# stderr. The one-VERDICT-line contract on stdout is unchanged.
if [ -n "$RELAY_HOOK_PAYLOAD" ]; then
  RELAY_BIND_BIN="$(cd "$HOOKS_DIR/.." 2>/dev/null && pwd)/bin/relay"
  RELAY_BIND_OUT=""
  RELAY_BIND_ERR=""
  RELAY_BIND_RC=1
  RELAY_BIND_ERRFILE="$(mktemp 2>/dev/null || printf '')"
  RELAY_BIND_INFILE="$(mktemp 2>/dev/null || printf '')"
  RELAY_BIND_OUTFILE="$(mktemp 2>/dev/null || printf '')"
  if [ -f "$RELAY_BIND_BIN" ] && command -v node >/dev/null 2>&1 && [ -n "$RELAY_BIND_ERRFILE" ] && [ -n "$RELAY_BIND_INFILE" ] && [ -n "$RELAY_BIND_OUTFILE" ]; then
    if relay_budget_for "the window bind" 3; then
      # Bounded like every pre-mail step: the payload goes in through a private
      # file, and the run is killed at its share of the budget (124 = timed out).
      printf '%s' "$RELAY_HOOK_PAYLOAD" > "$RELAY_BIND_INFILE"
      relay_run_bounded "$RELAY_STEP_SECS" "$RELAY_BIND_INFILE" "$RELAY_BIND_OUTFILE" "$RELAY_BIND_ERRFILE" node "$RELAY_BIND_BIN" bind
      RELAY_BIND_RC=$?
      RELAY_BIND_OUT=$(cat "$RELAY_BIND_OUTFILE" 2>/dev/null || printf '')
      RELAY_BIND_ERR=$(cat "$RELAY_BIND_ERRFILE" 2>/dev/null || printf '')
      [ "$RELAY_BIND_RC" -eq 124 ] && RELAY_BIND_ERR="BIND_FAILED: timed out after ${RELAY_STEP_SECS}s"
    else
      RELAY_BIND_RC=125
      RELAY_BIND_ERR="BIND_FAILED: no time budget left for the window bind"
    fi
    rm -f "$RELAY_BIND_ERRFILE" "$RELAY_BIND_INFILE" "$RELAY_BIND_OUTFILE" "$RELAY_BIND_OUTFILE.timedout" 2>/dev/null
  elif [ -f "$RELAY_BIND_BIN" ] && command -v node >/dev/null 2>&1; then
    rm -f "$RELAY_BIND_ERRFILE" "$RELAY_BIND_INFILE" "$RELAY_BIND_OUTFILE" 2>/dev/null
    RELAY_BIND_RC=1
    RELAY_BIND_ERR="BIND_FAILED: could not create a private temp file for the bind"
  else
    RELAY_BIND_RC=127
    RELAY_BIND_ERR="BIND_FAILED: no runnable relay CLI beside this hook (looked for $RELAY_BIND_BIN)"
  fi

  if [ "$RELAY_BIND_RC" -eq 0 ]; then
    # One line, already shaped as "[RELAY] bound <who> to conversation <id> (...)".
    # Collapse any stray CR/LF so a crafted conversation title can never inject an
    # extra stdout line into the verdict-only contract (same guard the wake-coverage
    # line applies at this boundary).
    RELAY_BIND_LINE=$(printf '%s' "$RELAY_BIND_OUT" | tr '\r\n' '  ')
    case "$RELAY_BIND_LINE" in
      "[RELAY]"*) printf '%s\n' "$RELAY_BIND_LINE" ;;
    esac
  else
    # Loud, never silent — the operator sees WHY this window was not recorded.
    [ -n "$RELAY_BIND_ERR" ] && printf '%s\n' "$RELAY_BIND_ERR" >&2
    case "$RELAY_BIND_ERR" in
      *"schema not migrated"*)
        if command -v relay_verdict_set >/dev/null 2>&1; then
          case "$RELAY_VERDICT" in
            HEALTHY|DEGRADED)
              relay_verdict_set "DEGRADED" "bind failed: schema not migrated (binding tables missing or pre-edge-identity) — this window is NOT recorded" " agent=\"$AGENT_NAME\""
              ;;
          esac
        fi
        ;;
    esac
  fi
fi
# --- end ADR-0036 S1 bind ------------------------------------------------------

# --- Deliver pending messages (defined above: relay_deliver_pending_mail) ---
relay_deliver_pending_mail

# --- Deliver active tasks (parameter-bound) ---
# Every field leaves sqlite3 HEX-encoded, so no byte of a title can forge a row or
# a line boundary on the way out; node decodes and FRAMES it (RELAY_FRAME_JS).
TASKS=""
RELAY_TASKS_FAILED=0
TASKS_HEX=""
# After the mail read: what is left minus the margin (no reserve to keep). A task
# read that was skipped or timed out is TOLD: tasks may exist that are not shown.
RELAY_TASKS_RC=0
if relay_budget_for "the task read" 2 margin; then
  TASKS_HEX=$(relay_run_capture "$RELAY_STEP_SECS" /dev/stdin sqlite3 -separator '|' "$DB_PATH" <<SQL 2>/dev/null
.parameter set :name '$AGENT_NAME'
SELECT hex(priority), hex(title), hex(from_agent), hex(id)
FROM tasks WHERE to_agent = :name AND status IN ('posted', 'accepted')
ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END
LIMIT 10;
SQL
)
  RELAY_TASKS_RC=$?
else
  RELAY_TASKS_RC=125
fi
if [ "$RELAY_TASKS_RC" -eq 124 ] || [ "$RELAY_TASKS_RC" -eq 125 ]; then
  echo "[RELAY] active tasks for $AGENT_NAME were not read in this hook's time budget. Call get_tasks to see them."
  [ "$RELAY_TASKS_RC" -eq 124 ] && relay_mail_verdict "DEGRADED" "the task read timed out after ${RELAY_STEP_SECS}s" other
  TASKS_HEX=""
fi
if [ -n "$TASKS_HEX" ] && command -v node >/dev/null 2>&1; then
  TASKS=$(printf '%s' "$TASKS_HEX" | node -e "$RELAY_FRAME_JS"'
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      const dec = (h) => Buffer.from(/^[0-9A-Fa-f]*$/.test(h || "") ? h : "", "hex").toString("utf8");
      const out = [];
      for (const row of raw.split("\n")) {
        if (!row) continue;
        const [p, t, f, i] = row.split("|").map(dec);
        out.push("  [" + relayOneLine(p) + "] " + relayFramed(t) + " (from: " + relayOneLine(f) + ", id: " + relayOneLine(i) + ")");
      }
      process.stdout.write(out.join("\n"));
    });' 2>/dev/null) || RELAY_TASKS_FAILED=1
elif [ -n "$TASKS_HEX" ]; then
  RELAY_TASKS_FAILED=1
fi
if [ "$RELAY_TASKS_FAILED" = "1" ]; then
  # LOUD: tasks exist that the agent is not being shown.
  echo "[RELAY] active tasks for $AGENT_NAME could not be rendered safely. Call get_tasks to see them."
  echo "[bot-relay] task rendering failed for $AGENT_NAME — active tasks NOT delivered to context." >&2
  relay_mail_verdict "DEGRADED" "tasks could not be rendered at session start" other
  TASKS=""
fi

if [ -n "$TASKS" ]; then
  echo "[RELAY] Active tasks for $AGENT_NAME:"
  echo "$TASKS"
  echo ""
  echo "[bot-relay] $AGENT_NAME has active tasks (delivered to context)." >&2
fi

# --- ADR-0026 item 1: wake-coverage briefing line (READ the durable sink) ---
# Reached only on the SUCCESS path (valid identity + DB present; the invalid-name / out-of-
# bounds / missing-DB guards above all `exit 0` before here), so it honors the hook's output
# contract: stdout stays verdict-only when the session is degraded. On a healthy start it emits
# ONE [RELAY] line via the SAME tested SSOT the daemon-briefing uses (formatWakeCoverageStatusLine
# in the db-free dist/wake-coverage-status.js) — a missing/stale/unparseable sink reads UNKNOWN
# (silence-as-failure, never "all clear"), and a poisoned/ancient finding is never shown as a
# live alert. Non-fatal and node-only; it never opens the DB or contacts the daemon. The status
# module is import-light on purpose (fs/path/os): importing the full detector here would drag
# native better-sqlite3 into every session start and silently drop this line on wasm machines.
if command -v node >/dev/null 2>&1; then
  RELAY_REPO_ROOT="$(cd "$HOOKS_DIR/.." 2>/dev/null && pwd)"
  RELAY_WC_MODULE="$RELAY_REPO_ROOT/dist/wake-coverage-status.js"
  if [ -n "$RELAY_REPO_ROOT" ] && [ -r "$RELAY_WC_MODULE" ]; then
    # Gate on node's EXIT (via `if`) AND validate the [RELAY] shape before echoing: a node that
    # fails or is hijacked (wrong binary on PATH) must never have its partial stdout leaked into
    # session context — the same untrusted-partial-output class the mute self-check guards. The
    # `if` also keeps a non-zero node exit from tripping any errexit.
    if RELAY_WC_LINE=$(RELAY_WC_MODULE="$RELAY_WC_MODULE" node -e '
      const { pathToFileURL } = require("node:url");
      import(pathToFileURL(process.env.RELAY_WC_MODULE).href).then((mod) => {
        const status = mod.readWakeCoverageStatus();     // honors RELAY_WAKE_COVERAGE_STATUS_PATH, else the default sink
        const STALE_AFTER_MS = 3 * 60 * 60 * 1000;        // hourly sweep => older than 3h reads UNKNOWN
        const line = mod.formatWakeCoverageStatusLine(status, Date.now(), STALE_AFTER_MS);
        // Single-line guarantee at the hook boundary (codex P2): the formatter already sanitizes
        // finding data; collapse any residual CR/LF here so a crafted/corrupt record can never
        // inject an extra stdout line into the verdict-only contract.
        const oneLine = String(line == null ? "" : line).replace(/[\r\n]+/g, " ").trim();
        if (oneLine) process.stdout.write(oneLine + "\n");
      }).catch(() => {});
    ' 2>/dev/null); then
      # Emit ONLY the first [RELAY] line (codex P2) — node already collapsed CR/LF; taking the
      # first line here enforces the one-line/verdict contract at the hook boundary itself.
      case "$RELAY_WC_LINE" in
        "[RELAY]"*) printf '%s\n' "${RELAY_WC_LINE%%$'\n'*}" ;;
      esac
    fi
  fi
fi

# --- ADR-0002: opt-in team onboarding map (default OFF) ---
# Enable with RELAY_ONBOARD_TOPOLOGY=1. A compact who's-who grouped by
# coordination class, so a freshly-started agent knows its peers. Rough liveness
# proxy (agent_status, not the full verdict) — the authoritative view is
# `discover_agents view='topology'`. Visible classes mirror
# TOPOLOGY_VISIBLE_CLASSES in src/agent-class.ts (SSOT); transient + unclassified
# are excluded by omission from the IN-list.
if [ "${RELAY_ONBOARD_TOPOLOGY:-0}" = "1" ] && relay_budget_for "the team map read" 1 margin; then
  TOPOLOGY=$(relay_run_capture "$RELAY_STEP_SECS" /dev/stdin sqlite3 "$DB_PATH" <<'SQL' 2>/dev/null
SELECT '  ' || class || ': ' || GROUP_CONCAT(name, ', ')
FROM agents
WHERE class IN ('orchestrator','builder','advisory','auditor')
  AND agent_status NOT IN ('offline','closed','abandoned','stale')
GROUP BY class
ORDER BY CASE class WHEN 'orchestrator' THEN 0 WHEN 'builder' THEN 1 WHEN 'advisory' THEN 2 WHEN 'auditor' THEN 3 ELSE 4 END;
SQL
)
  if [ -n "$TOPOLOGY" ]; then
    echo "[RELAY] Team (by class):"
    echo "$TOPOLOGY"
    echo ""
  fi
fi

exit 0
