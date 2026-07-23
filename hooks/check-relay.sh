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
#   RELAY_INSTANCE_ID        — (v2.4.5) explicit per-instance override; mirrors
#                              src/instance.ts:resolveInstanceDbPath().
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
# - DB_PATH is resolved and must live under $HOME (no /etc/passwd shenanigans).
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

# v2.0 final (#19): self-check for path truncation. When .claude/settings.json
# references this script with an unquoted path containing spaces, only the
# first word reaches $0 — the script silently fails to find itself.
if [[ "$0" != *"/bot-relay-mcp/hooks/"* ]]; then
  echo "[bot-relay hook WARNING] \$0 does not contain '/bot-relay-mcp/hooks/' — the install path may be truncated. Quote the command string in .claude/settings.json if the path contains spaces. \$0='$0'" >&2
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
# v2.6.1 — vault helpers + DB-path resolution sourced from a single file.
# Mirrors src/instance.ts:resolveInstanceDbPath + src/token-store.ts:
# resolveAgentVaultDir + FileTokenStore.{pathFor,read,write}. Drift surfaces
# directly as a test failure in tests/v2-6-1-token-store.test.ts (which
# sources this same file) — no inline-copy hide-out.
HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_vault-helpers.sh
. "$HOOKS_DIR/_vault-helpers.sh"
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
DB_PATH=$(resolve_relay_db_path) || {
  # Malformed active-instance content — refuse to fall back silently. A
  # broken setup should be loud, not hidden under legacy. The hook's
  # other side effects (HTTP register/health, mail delivery) are gated
  # behind DB_PATH being readable below; null DB_PATH falls cleanly to
  # the existing "no DB → exit 0" path.
  DB_PATH=""
}
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
# grep used instead of bash =~ for portability with macOS bash 3.2.
if [ -n "$AGENT_CAPS" ]; then
  if [ ${#AGENT_CAPS} -gt 256 ] || ! echo "$AGENT_CAPS" | grep -Eq '^[A-Za-z0-9_.,-]+$'; then
    echo "[bot-relay] RELAY_AGENT_CAPABILITIES has invalid characters or length. Allowed: [A-Za-z0-9_.,-], 1-256 chars." >&2
    exit 0
  fi
fi

# DB path must live under HOME (or under /tmp for tests). Resolve symlinks first.
RESOLVED_DB_PATH=$(cd "$(dirname "$DB_PATH")" 2>/dev/null && pwd)/$(basename "$DB_PATH")
if [ -z "$RESOLVED_DB_PATH" ] || { [[ "$RESOLVED_DB_PATH" != "$HOME"/* ]] && [[ "$RESOLVED_DB_PATH" != /tmp/* ]] && [[ "$RESOLVED_DB_PATH" != /private/tmp/* ]] && [[ "$RESOLVED_DB_PATH" != /var/folders/* ]]; }; then
  echo "[bot-relay] RELAY_DB_PATH must live under \$HOME or /tmp. Got: '$RESOLVED_DB_PATH'" >&2
  exit 0
fi
DB_PATH="$RESOLVED_DB_PATH"

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
# RELAY_HOME mirrors botRelayRoot() in src/instance.ts — the hook and the server
# must agree on where the namespace lives or their diagnostics will contradict
# each other (codex HIGH: hardcoding $HOME/.bot-relay diverged from the server).
RELAY_ROOT="${RELAY_HOME:-${HOME}/.bot-relay}"
RELAY_LEGACY_DB="${RELAY_ROOT}/relay.db"
RELAY_INSTANCES_DIR="${RELAY_ROOT}/instances"

RELAY_INSTANCE_DIR_COUNT=0
if [ -d "$RELAY_INSTANCES_DIR" ]; then
  RELAY_INSTANCE_DIR_COUNT=$(find "$RELAY_INSTANCES_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
fi

# HARM 2 — the contradiction: instances exist, yet we resolved the flat legacy DB.
#
# An explicit RELAY_DB_PATH is a DELIBERATE OPERATOR CHOICE and must never be
# reported as a fault — assertInstanceResolution() already treats it that way,
# and the two halves contradicting each other is worse than either being wrong
# alone. Without this guard the hook tells a legitimate legacy-DB session that
# it has lost its mail (codex HIGH).
if [ -z "${RELAY_DB_PATH:-}" ] && [ "${RELAY_INSTANCE_DIR_COUNT:-0}" -gt 0 ] && [ "$DB_PATH" = "$RELAY_LEGACY_DB" ]; then
  # Set OUTSIDE the `{ ... } | tee` below: a pipeline runs in a SUBSHELL, so an
  # assignment made inside it is discarded when that subshell exits.
  relay_verdict_set "MUTE" "resolved the legacy DB while instances exist — inbox will read empty" " db=\"$DB_PATH\""
  RELAY_AVAILABLE_IDS=$(find "$RELAY_INSTANCES_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null | tr '\n' ' ')
  {
    echo "[RELAY] *** WRONG INSTANCE — DO NOT PROCEED AS CONNECTED ***"
    echo "[RELAY] Relay tools may work, but this session resolved the LEGACY database:"
    echo "[RELAY]     using     : $DB_PATH"
    echo "[RELAY]     instances : ${RELAY_AVAILABLE_IDS:-(unreadable)}"
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

# If there's no DB yet, nothing to do
if [ ! -f "$DB_PATH" ]; then
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
if [ -n "${RELAY_AGENT_TOKEN:-}" ] && command -v curl >/dev/null 2>&1; then
  HEALTH_BODY=$(curl -s -m 2 -X POST "http://${HTTP_HOST}:${HTTP_PORT}/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "X-Agent-Token: ${RELAY_AGENT_TOKEN}" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health_check","arguments":{}}}' 2>/dev/null)
  if [ -n "$HEALTH_BODY" ]; then
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
  if [ "$AUTH_STATE" = "recovery_pending" ] && [ -n "${RELAY_RECOVERY_TOKEN:-}" ]; then
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
    RECOVERY_BODY=$(curl -s -m 4 -X POST "http://${HTTP_HOST}:${HTTP_PORT}/mcp" \
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
      exit 1
    fi
  else
    # Stale or revoked token, no recovery credential available.
    echo "[relay] Agent \"$AGENT_NAME\" has a stale or revoked token (health_check returned auth_error)." >&2
    echo "[relay] If an admin issued a recovery token for this agent, set RELAY_RECOVERY_TOKEN=<token> and restart this terminal." >&2
    echo "[relay] Otherwise, request a recovery_token via revoke_token(issue_recovery=true) from an admin-capable agent." >&2
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
  LIVENESS=$(sqlite3 "$DB_PATH" <<SQL 2>/dev/null
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
if [ "$SKIP_REGISTER" -eq 0 ] && command -v curl >/dev/null 2>&1; then
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
  REG_BODY=$(curl -s -m 4 -w "\nHTTP_STATUS:%{http_code}\n" \
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
  # If $RELAY_HOOK_DEBUG is set, print the full response for troubleshooting.
  # Otherwise swallow silently — non-200 means the server refused (stale
  # token, revoked state, etc.), which is fine: the earlier health_check
  # probe will already have surfaced actionable messages to the operator.
  # We just don't want to corrupt the DB with a fallback sqlite3 write.
  if [ -n "${RELAY_HOOK_DEBUG:-}" ]; then
    echo "[bot-relay hook debug] register_agent response:" >&2
    echo "$REG_BODY" >&2
  fi
fi

# --- Deliver pending messages (parameter-bound) ---
MESSAGES=$(sqlite3 "$DB_PATH" <<SQL 2>/dev/null
.parameter set :name '$AGENT_NAME'
SELECT '  From: ' || from_agent || ' | ' || content || ' (' || created_at || ')'
FROM messages WHERE to_agent = :name AND status='pending'
ORDER BY created_at DESC LIMIT 10;
SQL
)

if [ -n "$MESSAGES" ]; then
  echo "[RELAY] Pending messages for $AGENT_NAME:"
  echo "$MESSAGES"
  echo ""
  echo "[bot-relay] $AGENT_NAME has pending messages (delivered to context)." >&2
fi

# --- Deliver active tasks (parameter-bound) ---
TASKS=$(sqlite3 "$DB_PATH" <<SQL 2>/dev/null
.parameter set :name '$AGENT_NAME'
SELECT '  [' || priority || '] ' || title || ' (from: ' || from_agent || ', id: ' || id || ')'
FROM tasks WHERE to_agent = :name AND status IN ('posted', 'accepted')
ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END
LIMIT 10;
SQL
)

if [ -n "$TASKS" ]; then
  echo "[RELAY] Active tasks for $AGENT_NAME:"
  echo "$TASKS"
  echo ""
  echo "[bot-relay] $AGENT_NAME has active tasks (delivered to context)." >&2
fi

# --- ADR-0002: opt-in team onboarding map (default OFF) ---
# Enable with RELAY_ONBOARD_TOPOLOGY=1. A compact who's-who grouped by
# coordination class, so a freshly-started agent knows its peers. Rough liveness
# proxy (agent_status, not the full verdict) — the authoritative view is
# `discover_agents view='topology'`. Visible classes mirror
# TOPOLOGY_VISIBLE_CLASSES in src/agent-class.ts (SSOT); transient + unclassified
# are excluded by omission from the IN-list.
if [ "${RELAY_ONBOARD_TOPOLOGY:-0}" = "1" ]; then
  TOPOLOGY=$(sqlite3 "$DB_PATH" <<'SQL' 2>/dev/null
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
