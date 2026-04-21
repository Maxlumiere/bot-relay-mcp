#!/usr/bin/env bash
# bot-relay-mcp — pre-publish gate (v2.1 Phase 4a)
#
# Orchestrates every check that must pass before `npm publish`:
#   1. npx tsc --noEmit
#   2. npx vitest run
#   3. npm audit --audit-level=moderate
#   4. npm run build
#   5. Drift guard: no hardcoded version literals in src/ outside src/version.ts
#   6. End-to-end 25-tool smoke + CLI subcommand smoke against an isolated relay
#
# Wired via package.json "prepublishOnly" so `npm publish` will refuse to ship
# unless every check passes. Also runnable standalone for operator confidence.
#
# Exit 0 only if every step is green. On failure, prints a PASS/FAIL summary
# and exits 1 at the first red step to keep feedback tight.

set -u
set -o pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# v2.1 Phase 5b: --full flag runs load / chaos / cross-version on top of
# the default gate. REQUIRED before npm publish, NOT required on dev loops
# (chaos tests spawn subprocesses + take 30-60s end-to-end).
FULL_MODE=0
for arg in "$@"; do
  if [ "$arg" = "--full" ]; then FULL_MODE=1; fi
done

FAIL=0
STEPS=()
step() {
  local label="$1"; shift
  echo ""
  echo "=== pre-publish: ${label} ==="
  if "$@"; then
    STEPS+=("PASS  ${label}")
    return 0
  else
    STEPS+=("FAIL  ${label}")
    FAIL=1
    return 1
  fi
}

# --- 1. TypeScript ---
step "tsc --noEmit" npx tsc --noEmit || exit 1

# --- 2. Unit/integration tests ---
step "vitest run" npx vitest run || exit 1

# --- 3. npm audit (fail on moderate+) ---
# --audit-level=moderate fails with a non-zero exit code if any advisory at
# moderate severity or higher is present. Dev-only advisories count — we want
# the signal.
step "npm audit (moderate+)" npm audit --audit-level=moderate || exit 1

# --- 4. Production build ---
step "npm run build" npm run build || exit 1

# --- 5. Drift guard ---
# Any string literal matching /["']\d+\.\d+\.\d+["']/ inside src/ that is NOT
# in one of the two authoritative version files (src/version.ts for package
# VERSION, src/protocol.ts for PROTOCOL_VERSION) fails the gate. Grep for
# quoted semver-ish strings, drop the allowed files, drop comments
# (approximate — lines starting with `//` or `*`). If anything remains,
# print it and fail.
drift_guard() {
  local hits
  hits=$(grep -rnE "[\"']([0-9]+\.[0-9]+\.[0-9]+)[\"']" "$PROJECT_ROOT/src" \
    | grep -v "^$PROJECT_ROOT/src/version.ts:" \
    | grep -v "^$PROJECT_ROOT/src/protocol.ts:" \
    | grep -vE ':\s*(//|\*)' \
    || true)
  if [ -n "$hits" ]; then
    echo "Hardcoded version literals detected in src/ outside the allowed files (src/version.ts, src/protocol.ts):" >&2
    echo "$hits" >&2
    echo "Fix: import { VERSION } from \"./version.js\" or { PROTOCOL_VERSION } from \"./protocol.js\"." >&2
    return 1
  fi
  echo "No drift — all versions route through src/version.ts or src/protocol.ts"
  return 0
}
step "drift guard (no hardcoded versions)" drift_guard || exit 1

# --- 5b. Sanctioned-helper guard (v2.1 Phase 7q) -----------------------------
# Reject raw `UPDATE agents` / `DELETE FROM agents` / `UPDATE agent_capabilities`
# / `DELETE FROM agent_capabilities` tokens in src/*.ts OUTSIDE src/db.ts, which
# is the single sanctioned mutation site for the agents table. A genuine
# one-off can escape the guard with a trailing `// ALLOWLIST: <reason>`
# comment — that's the "you must explicitly acknowledge you're mutating agents"
# surface Codex asked for. If that comment starts appearing in a third file,
# extract a new helper instead.
#
# Not checking hooks/, scripts/, tests/ — hooks are external clients that now
# go through register_agent over HTTP (Phase 7p HIGH #3), scripts don't touch
# this schema, tests legitimately seed raw rows.
sanctioned_helper_guard() {
  local hits
  hits=$(grep -rnE "(UPDATE[[:space:]]+agents|DELETE[[:space:]]+FROM[[:space:]]+agents|UPDATE[[:space:]]+agent_capabilities|DELETE[[:space:]]+FROM[[:space:]]+agent_capabilities)" "$PROJECT_ROOT/src" \
    --include='*.ts' \
    | grep -v "^$PROJECT_ROOT/src/db\.ts:" \
    | grep -v "// ALLOWLIST:" \
    || true)
  if [ -n "$hits" ]; then
    echo "Raw agents/agent_capabilities mutations found outside src/db.ts:" >&2
    echo "$hits" >&2
    echo "" >&2
    echo "Fix: route the mutation through one of the sanctioned helpers in src/db.ts:" >&2
    echo "  - teardownAgent(name, reason)          — DELETE + cascade to agent_capabilities" >&2
    echo "  - applyAuthStateTransition(name, ...)  — CAS UPDATE on auth_state + related fields" >&2
    echo "  - updateAgentMetadata(name, fields)    — UPDATE last_seen / agent_status / busy_expires_at" >&2
    echo "  - markAgentOffline(name, sessionId)    — CAS offline transition on stdio SIGINT/SIGTERM (v2.1.3)" >&2
    echo "  - expandAgentCapabilities(name, caps)  — additive cap expansion (v2.1.4)" >&2
    echo "" >&2
    echo "If you genuinely need a one-off, append '// ALLOWLIST: <reason>' to the line." >&2
    return 1
  fi
  echo "No raw agents-table mutations outside src/db.ts — invariant surface consolidated"
  return 0
}
step "sanctioned-helper guard (no raw agents mutations)" sanctioned_helper_guard || exit 1

# --- 5c. IP-classifier consolidation guard (v2.2.0 Phase 5 / Codex Item 9) ---
# Classification CIDR literals (like "127.0.0.0/8", "fe80::/10") belong in
# src/ip-classifier.ts only. src/cidr.ts has the low-level matcher + a few
# CIDR examples in doc comments, so it's also allowlisted. Every other src/
# file MUST import from src/ip-classifier.ts instead of hardcoding ranges.
#
# The regex matches `"<v4>/<prefix>"` or `"<v6ish>/<prefix>"`. Tests + doc
# strings in other files are allowed via the `// CIDR-ALLOWLIST: <reason>`
# comment escape hatch.
ip_classifier_guard() {
  local hits
  hits=$(grep -rnE '"[0-9a-fA-F:.]+/[0-9]+"' "$PROJECT_ROOT/src" \
    --include='*.ts' \
    | grep -v "^$PROJECT_ROOT/src/ip-classifier\.ts:" \
    | grep -v "^$PROJECT_ROOT/src/cidr\.ts:" \
    | grep -v "// CIDR-ALLOWLIST:" \
    | grep -vE ':\s*(//|\*)' \
    || true)
  if [ -n "$hits" ]; then
    echo "CIDR literals detected in src/ outside the allowed classifier files:" >&2
    echo "$hits" >&2
    echo "" >&2
    echo "Fix: add the range to src/ip-classifier.ts + call isBlockedForSsrf / classifyIp." >&2
    echo "If you genuinely need a one-off, append '// CIDR-ALLOWLIST: <reason>' to the line." >&2
    return 1
  fi
  echo "No CIDR literals outside src/ip-classifier.ts + src/cidr.ts — classifier consolidated"
  return 0
}
step "ip-classifier guard (no duplicate CIDR logic)" ip_classifier_guard || exit 1

# --- 6. 25-tool + CLI smoke against an isolated relay (v2.1 Phase 5a) ---
# Inline cleanup (no RETURN trap) — simpler + avoids set-u pitfalls around
# deferred variable lookup in trap strings.
smoke_25_isolated() {
  local port="${RELAY_SMOKE_PORT:-39999}"
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/relay-prepub-XXXXXX")"
  local pid=""
  local rc=0

  if [ ! -f "$PROJECT_ROOT/dist/index.js" ]; then
    echo "dist/index.js missing — build must have failed silently." >&2
    rm -rf "$tmp_dir"
    return 1
  fi

  # Spawn an isolated relay.
  RELAY_TRANSPORT=http \
  RELAY_HTTP_PORT="$port" \
  RELAY_HTTP_HOST=127.0.0.1 \
  RELAY_DB_PATH="$tmp_dir/relay.db" \
  RELAY_CONFIG_PATH="$tmp_dir/config.json" \
  node "$PROJECT_ROOT/dist/index.js" >"$tmp_dir/relay.log" 2>&1 &
  pid=$!

  # Wait up to 5s for /health.
  local healthy=0 i
  for i in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 0.1
  done
  if [ "$healthy" -ne 1 ]; then
    echo "isolated relay did not come up on port $port within 5s" >&2
    tail -30 "$tmp_dir/relay.log" >&2 || true
    rc=1
  fi

  # Run the smoke script against the isolated relay.
  # v2.1 Phase 5a: smoke-22 superseded by smoke-25 (adds rotate_token_admin +
  # managed rotation + recovery flow + CLI subcommands). Export the isolated
  # DB + config paths so the CLI subcommands in smoke-25 (doctor, backup,
  # recover, re-encrypt) operate on the throwaway state, not Maxime's live DB.
  if [ "$rc" -eq 0 ]; then
    if ! RELAY_DB_PATH="$tmp_dir/relay.db" \
         RELAY_CONFIG_PATH="$tmp_dir/config.json" \
         RELAY_HTTP_PORT="$port" \
         bash "$PROJECT_ROOT/scripts/smoke-25-tools.sh" "http://127.0.0.1:$port"; then
      rc=1
    fi
  fi

  # Teardown — always runs.
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 0.2
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
  return $rc
}
step "25-tool + CLI smoke (isolated relay)" smoke_25_isolated || exit 1

# --- 7. (--full only) load / chaos / cross-version — Phase 5b ---
# These run a subset of tests/*.test.ts files that are NOT included in the
# default vitest run (they spawn subprocesses, produce load, or take 30-60s).
# REQUIRED before npm publish; opt-in otherwise.
if [ "$FULL_MODE" = "1" ]; then
  # --config vitest.full.config.ts overrides the default exclude list so the
  # load/chaos/cross-version files are picked up. They're opt-in because
  # each spawns subprocesses or runs for 30-60s.
  step "load-smoke (--full)" npx vitest run --config vitest.full.config.ts tests/load-smoke.test.ts || exit 1
  step "chaos (--full)" npx vitest run --config vitest.full.config.ts tests/chaos.test.ts || exit 1
  step "cross-version (--full)" npx vitest run --config vitest.full.config.ts tests/cross-version.test.ts || exit 1
fi

# --- Summary ---
echo ""
echo "=== pre-publish summary ==="
for s in "${STEPS[@]}"; do echo "  $s"; done
if [ "$FAIL" -eq 0 ]; then
  echo ""
  echo "pre-publish: PASS (safe to npm publish)"
  exit 0
else
  echo ""
  echo "pre-publish: FAIL"
  exit 1
fi
