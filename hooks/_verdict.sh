# bot-relay-mcp: shared VERDICT primitive — sourced by every relay hook.
# Copyright (c) 2026 Lumiere Ventures. SPDX-License-Identifier: MIT
#
# WHY THIS EXISTS. Four separate audit findings all reached ONE state: "the hook
# produced no output", which was read as healthy. An illegal `return` in
# `node -e`; a detector that failed to execute at all; a stack overflow converted
# into a successful zero-output run; and `command -v node` skipping the check
# entirely. Four mechanisms, one destination. Each fix closed a ROUTE and left
# the STATE reachable, because the premise underneath was SILENCE MEANS HEALTHY
# — which makes a hook's success and its failure the same observable, and turns
# this into an enumeration problem that cannot converge.
#
# So it is inverted. Every hook emits EXACTLY ONE explicit verdict per run, and
# the ABSENCE of a verdict is failure rather than health. Two invariants make
# that hold without anyone predicting failure modes:
#
#   1. PESSIMISTIC DEFAULT — set the moment this file is sourced, which must be
#      the first executable line of the sourcing hook. Only ever UPGRADED by
#      positive evidence, so nothing can leave it unset and a partial run cannot
#      forge a verdict it never earned.
#   2. EMITTED FROM AN EXIT TRAP — so it is the LAST thing written on every exit
#      path the shell can observe: normal return, an early `exit 0` guard, an
#      uncaught error, a `set -e` abort, or a catchable signal.
#
# SHARED RATHER THAN COPIED, deliberately: this repo already learned that lesson
# with _vault-helpers.sh. An inline copy in each hook would drift, and a hook
# whose copy rotted would fail SILENTLY — the exact class being fixed. One
# implementation means a new hook opts in with a single `.` line, and the
# cross-hook contract test fails if it does not.
#
# HONEST BOUNDARY, stated rather than papered over:
#   * SIGKILL emits nothing. Uncatchable by anything, anywhere.
#   * A hook that NEVER RUNS cannot speak for itself. Only a party that knows a
#     verdict was OWED can notice one missing — that is the server-side absence
#     check (channel 2), scoped to profiles that actually install a hook.
#
# USAGE (must be the first executable code in the hook):
#   HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
#   . "$HOOKS_DIR/_verdict.sh"          # or ../_verdict.sh from a subdirectory
# then upgrade with relay_verdict_set on positive evidence.

RELAY_VERDICT="CANNOT-JUDGE"
RELAY_VERDICT_REASON="hook did not reach a conclusion"
RELAY_VERDICT_DETAIL=""

# relay_verdict_set VERDICT REASON [DETAIL]
# Upgrade the verdict. Kept as a function so no caller hand-rolls the shape, and
# so a future consumer format change lands in exactly one place.
#
# CALLER WARNING, learned the hard way: a `{ ... } | tee` block is a PIPELINE,
# and a pipeline runs in a SUBSHELL. Calling this inside one sets the variables
# in a child that then exits, discarding them — which once produced a full MUTE
# banner followed by a CANNOT-JUDGE verdict. Call it OUTSIDE any pipeline.
relay_verdict_set() {
  RELAY_VERDICT="$1"
  RELAY_VERDICT_REASON="$2"
  RELAY_VERDICT_DETAIL="${3:-}"
}

# Single machine-parseable line so Tether, Sentinel, the server-side absence
# check and the tests all consume the same artifact a human reads.
# Deliberately NOT wrapped in any conditional.
# WHICH STREAM. Default stdout, because for check-relay.sh stdout IS the
# channel injected into the agent's context — the agent must be able to read its
# own diagnosis. But a hook whose stdout is a STRUCTURED channel (the Codex hook
# emits a hookSpecificOutput JSON object) would be CORRUPTED by a trailing bare
# line, so those hooks set RELAY_VERDICT_STREAM=stderr before sourcing. Getting
# this wrong would break the very integration the verdict exists to protect.
RELAY_VERDICT_STREAM="${RELAY_VERDICT_STREAM:-stdout}"

relay_emit_verdict() {
  _relay_verdict_line="[RELAY] VERDICT=${RELAY_VERDICT} reason=\"${RELAY_VERDICT_REASON}\"${RELAY_VERDICT_DETAIL}"
  if [ "$RELAY_VERDICT_STREAM" = "stderr" ]; then
    echo "$_relay_verdict_line" >&2
  else
    echo "$_relay_verdict_line"
  fi
}

trap relay_emit_verdict EXIT
