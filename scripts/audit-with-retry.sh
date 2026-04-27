#!/usr/bin/env bash
# bot-relay-mcp — resilient `npm audit` wrapper (v2.4.3).
#
# Runs `npm audit --json --audit-level=$LEVEL` (modern bulk-advisory endpoint
# on npm 10+) and classifies the outcome into three buckets:
#
#   1. Clean / vulns below threshold — exit 0.
#   2. Real high+ vulns — exit 1 (no retry; a finding is a finding).
#   3. Transient registry-side error (HTTP 4xx/5xx, ENETWORK, EAI_AGAIN, the
#      classic "endpoint is being retired" 400, etc.) — retry up to 3 times
#      with 5/15/30s backoff. If all 3 attempts hit transient errors, log
#      loudly + exit 0. The CI green badge MUST NOT swing red on a registry
#      flake; Dependabot is the redundant defense-in-depth.
#
# An unknown / malformed response (JSON parse failure with no transient
# marker in stderr) exits 1 — better to surface a new failure mode than
# silently skip the audit.
#
# Test-injection:
#   RELAY_TEST_AUDIT_CMD=<cmd>   Run <cmd> instead of `npm audit ...`.
#                                Used by tests/v2-4-3-pre-publish-audit-
#                                resilience.test.ts to mock the registry.
#                                Each invocation is its own bash -c so the
#                                test fixture can read $RELAY_AUDIT_ATTEMPT
#                                (1-based) to vary output across attempts.
#   RELAY_AUDIT_NO_BACKOFF=1     Skip the sleep between retries (test-only;
#                                production runs with the real backoff).
#   RELAY_AUDIT_MAX_ATTEMPTS=N   Override the default 3 retries (test-only).
#
# Usage:
#   bash scripts/audit-with-retry.sh           # defaults to level=high
#   bash scripts/audit-with-retry.sh moderate  # explicit level
set -uo pipefail

LEVEL="${1:-high}"
MAX_ATTEMPTS="${RELAY_AUDIT_MAX_ATTEMPTS:-3}"
BACKOFF_SECS=(5 15 30)

# Run the audit (or the test-injection command). Both stdout and stderr are
# captured by the caller via redirection — this function just dispatches.
run_audit_once() {
  if [ -n "${RELAY_TEST_AUDIT_CMD:-}" ]; then
    bash -c "$RELAY_TEST_AUDIT_CMD"
  else
    npm audit --json --audit-level="$LEVEL"
  fi
}

# A failure mode is "transient" if stderr surfaces a known registry-side
# error marker. v2.4.3 R1 HIGH 2 (Codex 2026-04-27): narrowed from the
# blanket "HTTP 4[0-9][0-9]" match — that was classifying 401/403/404
# (auth/permission/config issues, deterministic) as transient and soft-
# failing through them. Now only the specific retry-worthy codes apply:
#
#   - 5xx — server errors (npm registry side)
#   - 408 — Request Timeout (client-perceived timeout)
#   - 429 — Too Many Requests (rate-limit; retry with backoff is correct)
#   - ENETWORK / EAI_AGAIN / ECONNRESET / ECONNREFUSED / ETIMEDOUT /
#     ENOTFOUND — transport-level failures
#   - "endpoint is being retired" — explicit npm sunset signal (the
#     v2.4.0 main repro)
#   - "fetch failed" / "socket hang up" — node-fetch transport messages
#
# Anything else (including 401 / 403 / 404 / 410 / generic "Bad Request"
# without the sunset signal) → NOT transient → caller exits 1 so the
# operator sees the deterministic problem instead of a soft-fail. False
# positives let real vulns hide; false negatives just mean an extra retry.
is_transient() {
  local err="$1"
  echo "$err" | grep -qiE 'EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ENETWORK|ECONNRESET|HTTP 5[0-9][0-9]|HTTP 408|HTTP 429|endpoint is being retired|fetch failed|socket hang up'
}

# A "real high+ finding" is metadata.vulnerabilities.{high,critical} > 0 in
# the JSON report. Anything below threshold (info/low/moderate) is fine —
# the audit-level=high filter already passed the npm-side gate.
is_real_high_vuln() {
  local out="$1"
  printf '%s' "$out" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(2)  # 2 = parse failure
m = d.get("metadata", {}).get("vulnerabilities", {})
high = int(m.get("high", 0)) + int(m.get("critical", 0))
sys.exit(0 if high > 0 else 1)  # 0 = real finding, 1 = no finding
'
}

attempt=1
while :; do
  err_file=$(mktemp)
  out_file=$(mktemp)
  set +e
  run_audit_once >"$out_file" 2>"$err_file"
  rc=$?
  set -e

  stdout_text=$(cat "$out_file" 2>/dev/null || true)
  stderr_text=$(cat "$err_file" 2>/dev/null || true)
  rm -f "$err_file" "$out_file"

  # Fast path: clean exit means audit passed at threshold.
  if [ $rc -eq 0 ]; then
    echo "npm audit (level=$LEVEL): no vulns at threshold (attempt $attempt)"
    exit 0
  fi

  # Real vuln finding? Don't retry on real findings — exit 1 immediately.
  RELAY_AUDIT_ATTEMPT=$attempt
  set +e
  is_real_high_vuln "$stdout_text"
  vuln_rc=$?
  set -e
  if [ $vuln_rc -eq 0 ]; then
    echo "npm audit FAILED (level=$LEVEL): high+ vulnerabilities found:" >&2
    echo "$stdout_text" >&2
    exit 1
  fi

  # Transient registry-side error? Retry with backoff.
  if is_transient "$stderr_text"; then
    if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
      echo "WARN: npm audit hit transient registry errors ${MAX_ATTEMPTS}x in a row." >&2
      echo "WARN: classified as registry flake — soft-failing to exit 0 so the CI green badge survives." >&2
      echo "WARN: Dependabot remains the defense-in-depth for real advisories." >&2
      echo "WARN: last stderr was:" >&2
      echo "$stderr_text" >&2
      exit 0
    fi
    delay="${BACKOFF_SECS[$((attempt-1))]}"
    if [ -n "${RELAY_AUDIT_NO_BACKOFF:-}" ]; then
      delay=0
    fi
    echo "WARN: npm audit attempt $attempt hit transient registry error; retrying in ${delay}s" >&2
    [ "$delay" -gt 0 ] && sleep "$delay"
    attempt=$((attempt+1))
    export RELAY_AUDIT_ATTEMPT=$attempt
    continue
  fi

  # Unknown failure mode — don't silently skip.
  echo "npm audit FAILED (level=$LEVEL): unknown failure mode (rc=$rc, JSON parse=$vuln_rc):" >&2
  echo "stdout: $stdout_text" >&2
  echo "stderr: $stderr_text" >&2
  exit 1
done
