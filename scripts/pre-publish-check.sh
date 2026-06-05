#!/usr/bin/env bash
# bot-relay-mcp — pre-publish gate (v2.1 Phase 4a)
#
# Orchestrates every check that must pass before `npm publish`:
#   1. npx tsc --noEmit
#   2. npx vitest run
#   3. npm audit --audit-level=moderate
#   4. npm run build
#   5. Drift guard: no hardcoded version literals in src/ outside src/version.ts
#   5a. Tests-side drift guard (v2.6.3): no hardcoded literal of the CURRENT
#       package.json version in tests/ — catches assertions like
#       `expect(...).toBe("X.Y.Z")` that go stale on bump and slipped past
#       the src/-only check until v2.6.0 publish-prep --full gate caught one
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

# --- 1b. v0.1.4 — VSCode extension bundle (esbuild).
# Two drift-out guards (tests/v2-6-tether-transport-diagnostics.test.ts +
# tests/v2-7-tether-reconnection-options.test.ts) read
# extensions/vscode/out/extension.js to assert the SHIPPED artifact
# preserves source-level wiring contracts (transport.onerror BEFORE
# client.connect; reconnectionOptions with maxRetries >= 10; SecretStorage
# wiring; legacy agentToken absent). vitest below would fail those
# guards if out/ doesn't exist when it runs.
#
# History:
# - Pre-v0.1.4: this step ran `npm run compile` (tsc emit) because tsc
#   output WAS what shipped in the VSIX. CI's smoke job hit a gap on PR
#   #29 (run 25775805022) when a `tsc -p . --noEmit` typecheck step
#   never emitted, leaving the drift-out tests reading a stale out/.
# - v0.1.4 (this commit): the SHIPPED artifact is now an esbuild bundle.
#   This step runs `npm run bundle` (esbuild → out/extension.js) so the
#   drift-out tests read the actual artifact the marketplace gets. The
#   drift-out tests themselves were converted to byte-offset ordering on
#   identifiers preserved by `keepNames: true` so they survive
#   minification. The section 4b step retains the strict tsc --noEmit
#   typecheck as a separate guard.
extension_bundle() {
  local ext_dir="$PROJECT_ROOT/extensions/vscode"
  if [ ! -d "$ext_dir" ]; then
    echo "  SKIP  extensions/vscode not present"
    return 0
  fi
  if [ ! -f "$ext_dir/package.json" ]; then
    echo "  SKIP  extensions/vscode/package.json missing"
    return 0
  fi
  ( cd "$ext_dir" && \
    if [ ! -d node_modules ]; then
      echo "  Installing extensions/vscode dependencies (one-time)..."
      npm install --no-audit --no-fund --silent || return 1
    fi
    npm run bundle
  )
}
step "extension bundle (extensions/vscode → out/extension.js via esbuild)" extension_bundle || exit 1

# --- 2. Unit/integration tests ---
# v2.8 — fast-feedback smoke for the dashboard state machine + SIGHUP +
# decay broadcaster + wire-emit sites. Runs the v2-8 test files
# specifically BEFORE the full vitest sweep so a regression in this
# release's surface surfaces in ~10s, not at the tail of a 90s --full
# run. The full vitest below still runs these tests (the v2-8 files are
# in the standard tests/ glob), so this is additive, not duplicative.
extension_state_machine_smoke() {
  if [ ! -d "$PROJECT_ROOT/tests" ]; then
    echo "  SKIP  tests/ directory missing"
    return 0
  fi
  if ! ls "$PROJECT_ROOT/tests"/v2-8-*.test.ts >/dev/null 2>&1; then
    echo "  SKIP  no v2-8 test files present"
    return 0
  fi
  npx vitest run tests/v2-8-agent-state-machine.test.ts tests/v2-8-sighup-handler.test.ts tests/v2-8-decay-broadcaster.test.ts tests/v2-8-wire-emit-sites.test.ts
}
step "v2.8 state-machine fast smoke (tests/v2-8-*.test.ts)" extension_state_machine_smoke || exit 1

# v2.8 — Sequential file execution (`--pool=forks --no-file-parallelism`)
# stabilizes the full root vitest run. The default parallel pool hits
# pre-existing flakiness around dashboard WebSocket attach + broadcast
# rate-limit cache when files run concurrently (the WS state is module-
# level + the rate-limit cache keys collide across parallel tests
# registering agents under the same name). Sequential adds ~3 minutes
# to the gate but the prior parallel mode produced ~20 false-failure
# noise per run. Single-file parallelism via `vitest run <file>` still
# uses pool parallelism within a file (which is safe — per-test isolate
# is at function level).
step "vitest run" npx vitest run --pool=forks --no-file-parallelism || exit 1

# --- 3. npm audit (fail on high+) ---
# v2.3.0 patch round (2026-04-23): threshold bumped moderate → high after
# GHSA-w5hq-g745-h8pq (uuid <14.0.0 buffer bounds in v3/v5/v6 with `buf`)
# landed on 2026-04-23. The advisory affects APIs we DON'T use (we call
# uuid.v4() with no args; never pass a buf). Upgrading to uuid@14 would
# drop Node 18 support (uuid@14 relies on global `crypto` available only
# on Node 20+) — `engines` field still commits to `>=18.0.0`. Moderate
# advisories that are materially exploitable in our actual usage surface
# will still be addressed; bumping to `high` lets us keep Node 18 support
# without shipping false-positive audit failures. Revisit when (a) uuid
# backports to v13 in a Node-18-compatible way OR (b) we drop Node 18.
#
# v2.4.3 (2026-04-27): direct `npm audit` call replaced with
# `scripts/audit-with-retry.sh`. The legacy `/audits/quick` endpoint went
# 400 Bad Request on the v2.4.0 main merge — code was fine, the public
# CI badge swung red over an npm registry flake. The wrapper retries
# transient registry errors with backoff and soft-fails on three-in-a-row
# transient classifications (Dependabot remains the defense-in-depth for
# real advisories). Real high+ vuln findings still exit 1 immediately.
step "npm audit (high+)" bash "$PROJECT_ROOT/scripts/audit-with-retry.sh" high || exit 1

# --- 4. Production build ---
step "npm run build" npm run build || exit 1

# --- 4b. v2.5.0 R1 — VSCode extension compile guard ---
# Codex 5.5 R1 audit caught that R0's pre-push gate didn't cover the
# extensions/vscode/ subdirectory: the extension had a TS2339 (TypeScript
# strict-mode violation on a union access) that would fail at vsce package
# time. The pre-push gate didn't catch it because vitest's transform is
# permissive + tsc --noEmit only sees src/. Add an explicit compile step
# for the extension subdir so future R0s catch this class of breakage.
#
# `npm install` is gated on the lockfile being absent — once the operator
# has installed once, repeated runs are no-ops. The first install is
# slowest but the lockfile sticks around in the working tree.
extension_compile() {
  local ext_dir="$PROJECT_ROOT/extensions/vscode"
  if [ ! -d "$ext_dir" ]; then
    echo "  SKIP  extensions/vscode not present"
    return 0
  fi
  if [ ! -f "$ext_dir/package.json" ]; then
    echo "  SKIP  extensions/vscode/package.json missing"
    return 0
  fi
  ( cd "$ext_dir" && \
    if [ ! -d node_modules ]; then
      echo "  Installing extensions/vscode dependencies (one-time)..."
      npm install --no-audit --no-fund --silent || return 1
    fi
    npx tsc -p . --noEmit
  )
}
step "extension TS compile (extensions/vscode)" extension_compile || exit 1

# --- 4c. v0.1.4 — extension-local vitest (bundle + VSIX-contents drift guards).
# Runs `cd extensions/vscode && npm run test:unit` AFTER the bundle is
# emitted (step 1b) so the v0.1.4 bundle-correctness tests
# (src/v0-1-4-bundle.test.ts) read the actual bundle on disk, and the
# VSIX-contents tests (src/v0-1-4-vsix-contents.test.ts) shell out to
# the locally-installed vsce to introspect what would ship.
#
# This step is additive: the root vitest above already runs root-level
# tests/*.test.ts. The extension-local config (vitest.config.ts in the
# extension dir) intentionally scopes to src/*.test.ts so root vitest
# doesn't double-run them.
extension_test_unit() {
  local ext_dir="$PROJECT_ROOT/extensions/vscode"
  if [ ! -d "$ext_dir" ]; then
    echo "  SKIP  extensions/vscode not present"
    return 0
  fi
  if [ ! -f "$ext_dir/package.json" ]; then
    echo "  SKIP  extensions/vscode/package.json missing"
    return 0
  fi
  ( cd "$ext_dir" && npm run test:unit )
}
step "extension vitest run (extensions/vscode — bundle + VSIX drift guards)" extension_test_unit || exit 1

# --- 5. Drift guard (src/) ---
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

# --- 5a. Tests-side drift guard (v2.6.3) ---
#
# Catches the v2.6.0 publish-prep regression class: a test asserting against
# the CURRENT package.json version with a hardcoded literal
# (e.g. `expect(...version).toBe("2.5.0")`) gets stale the moment the
# package version is bumped, but slips past the src/-only drift guard above.
# The first time this fires is during the post-bump --full gate run — too
# late to be caught early in iteration.
#
# Strategy: read the CURRENT package.json version, grep tests/ for that
# exact literal as a quoted string. Hits indicate a test pinning to the
# current version that should instead read package.json dynamically (mirror
# of the v2.2.0 dashboard smoke fix:
#   const __pkgJson = path.resolve(...) + "/package.json";
#   const EXPECTED_VERSION = JSON.parse(fs.readFileSync(__pkgJson, "utf-8")).version;
# ).
#
# Selectivity: ONLY the current version literal triggers — older-version
# literals (e.g. "2.3.0" in traffic-replay fixtures, "2.4.0" in protocol
# assertions or instance-metadata test data) are intentional and not flagged.
# This keeps the guard targeted at the exact bug class without forcing
# allowlist comments across ~50 legitimate fixture lines.
#
# Per-line allowlist: any line ending in `// ALLOWLIST:` (or `# ALLOWLIST:`)
# is exempt — for the rare case where a test legitimately needs to assert
# against the current version literal (e.g. testing a migration whose
# expected output is "current version was X"). Use sparingly with a
# justification in the ALLOWLIST: comment.
tests_drift_guard() {
  local current_version
  current_version=$(node -e "console.log(require('$PROJECT_ROOT/package.json').version)") || {
    echo "Failed to read package.json version" >&2
    return 1
  }
  if [ -z "$current_version" ]; then
    echo "package.json version is empty — refusing to scan" >&2
    return 1
  fi
  # Escape dots for grep -E.
  local escaped="${current_version//./\\.}"
  local hits
  hits=$(grep -rnE "[\"']${escaped}[\"']" "$PROJECT_ROOT/tests" \
    | grep -vE 'ALLOWLIST:' \
    | grep -vE ':\s*(//|\*)' \
    || true)
  if [ -n "$hits" ]; then
    echo "Hardcoded current-version literal \"$current_version\" detected in tests/:" >&2
    echo "$hits" >&2
    echo "" >&2
    echo "Fix: read the version from package.json at test load time (mirror src/version.ts):" >&2
    echo "  import fs from \"fs\";" >&2
    echo "  import path from \"path\";" >&2
    echo "  import { fileURLToPath } from \"url\";" >&2
    echo "  const __pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), \"..\", \"package.json\");" >&2
    echo "  const EXPECTED_VERSION = JSON.parse(fs.readFileSync(__pkg, \"utf-8\")).version;" >&2
    echo "" >&2
    echo "Or, for a legitimate one-off (e.g. testing a migration that pins to the current release)," >&2
    echo "append \`// ALLOWLIST: <reason>\` to the offending line." >&2
    return 1
  fi
  echo "No tests/ drift — no hardcoded \"$current_version\" literals (current package version)"
  return 0
}
step "tests/ drift guard (no current-version literals)" tests_drift_guard || exit 1

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

# --- 6b. GitHub CI green-gate (v2.2.3) ---
# Query GitHub for the CI conclusion of the current HEAD. Blocks shipping a
# commit whose CI is known-red (the pre-v2.2.3 failure mode where local
# native-Node gate was green but the matrix on Node 18/20/22 was red). Graceful
# skip when gh CLI isn't installed, when HEAD hasn't been pushed, or when the
# run is still in flight — this is a guard against KNOWN-red, not a hard gate.
ci_green_gate() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "  SKIP  gh CLI not installed — cannot probe CI; manual check required"
    return 0
  fi
  local head_sha
  head_sha=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo "")
  if [ -z "$head_sha" ]; then
    echo "  SKIP  could not resolve HEAD — cannot probe CI"
    return 0
  fi
  local ci_status
  ci_status=$(gh run list --commit "$head_sha" --limit 1 --json conclusion,status \
    --jq 'if length == 0 then "no-run" else .[0].conclusion // .[0].status // "unknown" end' 2>/dev/null || echo "unknown")
  case "$ci_status" in
    success)
      echo "  CI conclusion=success for $head_sha"
      return 0
      ;;
    failure|cancelled|timed_out|action_required)
      echo "  FAIL  GitHub CI conclusion=$ci_status for $head_sha — refusing to publish."
      echo "        Fix CI before shipping. Run: gh run view --log-failed"
      return 1
      ;;
    in_progress|queued|waiting|pending)
      echo "  WARN  GitHub CI still running (status=$ci_status) for $head_sha — proceed at own risk"
      return 0
      ;;
    no-run)
      echo "  WARN  GitHub has no run for $head_sha (not pushed?) — proceed at own risk"
      return 0
      ;;
    *)
      echo "  WARN  GitHub CI status unknown ($ci_status) for $head_sha — proceed at own risk"
      return 0
      ;;
  esac
}
step "GitHub CI green-gate" ci_green_gate || exit 1

# --- 6d. npm pack contents check (v2.6.0) ------------------------------------
# v2.6 R1 codex audit P2 #1: src/cli/mint-token.ts cross-links to
# docs/agents/external-cli-setup.md from its CLI output, and README.md does
# the same. If `package.json.files` doesn't include the docs path, the npm
# tarball won't carry the doc and the cross-link 404s for the user.
#
# Gate: every cross-linked-from-CLI doc must appear in `npm pack --dry-run`
# output. Currently the only such file is docs/agents/external-cli-setup.md;
# the list grows as future CLI subcommands gain docs.
npm_pack_contents() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "  SKIP  npm not on PATH"
    return 0
  fi
  local required=(
    "docs/agents/external-cli-setup.md"
  )
  local pack_out
  pack_out=$(cd "$PROJECT_ROOT" && npm pack --dry-run --json 2>/dev/null) || {
    echo "  SKIP  npm pack --dry-run --json failed (network or registry)"
    return 0
  }
  local missing=()
  local f
  for f in "${required[@]}"; do
    # The JSON output is one large blob; grep for the path. Avoid jq dep.
    if ! printf '%s' "$pack_out" | grep -q "\"$f\""; then
      missing+=("$f")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "Required tarball files missing from npm pack output:" >&2
    for f in "${missing[@]}"; do echo "  - $f" >&2; done
    echo "" >&2
    echo "Fix: add the path (or its parent dir) to the \"files\" array in package.json." >&2
    return 1
  fi
  echo "  npm pack carries ${#required[@]} required cross-linked doc(s)"
  return 0
}
step "npm pack contents (v2.6.0 — cross-linked docs included)" npm_pack_contents || exit 1

# --- 6c. Split-brain DB warn (v2.4.5) ---
# Detects the local-environment failure mode that bit Codex 5.5 during the
# v2.4.4 R2 audit cycle: an active per-instance setup PLUS a populated legacy
# DB usually means a stale npx-cached bot-relay-mcp (or a pre-v2.4.0 hook)
# is writing to ~/.bot-relay/relay.db while the live daemon serves a per-
# instance DB. Both DBs end up with agents that don't see each other.
#
# Pure WARN — never blocks publish. The fix is operator-side (kill the stale
# process / clear the npx cache / unset RELAY_DB_PATH); CI cannot do it.
# Skips silently when sqlite3 is absent or when no per-instance setup exists.
split_brain_warn() {
  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "  SKIP  sqlite3 not installed — cannot probe DBs"
    return 0
  fi
  local home_dir="${HOME:-}"
  if [ -z "$home_dir" ]; then
    echo "  SKIP  \$HOME unset — cannot locate ~/.bot-relay/"
    return 0
  fi
  local legacy_db="$home_dir/.bot-relay/relay.db"
  local active_link="$home_dir/.bot-relay/active-instance"
  # `-e` follows symlinks; the active-instance link target is a bare
  # instance_id (not a path), so `-e` returns false even when the link
  # exists. Check `-L` (link itself) OR `-f` (regular-file fallback used
  # on platforms where symlink creation is restricted).
  if [ ! -L "$active_link" ] && [ ! -f "$active_link" ]; then
    echo "  No active-instance configured — single-instance setup, no split-brain risk"
    return 0
  fi
  local instance_id=""
  if [ -L "$active_link" ]; then
    instance_id=$(basename "$(readlink "$active_link")")
  elif [ -f "$active_link" ]; then
    instance_id=$(head -n 1 "$active_link" | tr -d '[:space:]')
  fi
  if [ -z "$instance_id" ]; then
    echo "  Could not resolve active instance from $active_link — skipping"
    return 0
  fi
  local instance_db="$home_dir/.bot-relay/instances/$instance_id/relay.db"
  if [ ! -f "$instance_db" ]; then
    echo "  Active instance ($instance_id) DB not yet created — skipping"
    return 0
  fi
  if [ ! -f "$legacy_db" ]; then
    echo "  Per-instance setup detected (instance=$instance_id), no legacy DB — clean state"
    return 0
  fi
  local legacy_count instance_count
  legacy_count=$(sqlite3 "$legacy_db" "SELECT COUNT(*) FROM agents" 2>/dev/null || echo "?")
  instance_count=$(sqlite3 "$instance_db" "SELECT COUNT(*) FROM agents" 2>/dev/null || echo "?")
  if [ "$legacy_count" = "?" ] || [ "$instance_count" = "?" ]; then
    echo "  Could not query agent counts — skipping (DB may be locked)"
    return 0
  fi
  if [ "$legacy_count" -gt 0 ]; then
    echo "  WARN  split-brain detected: legacy DB has $legacy_count agent(s), per-instance ($instance_id) has $instance_count agent(s)."
    echo "        A pre-v2.4.5 hook OR a stale npx-cached bot-relay-mcp is likely writing to legacy."
    echo "        Investigate: ls ~/.npm/_npx/*/node_modules/bot-relay-mcp/package.json (look for old versions)."
    echo "        Cleanup: 'sqlite3 $legacy_db \"DELETE FROM agents\"' after confirming nothing live needs them."
  else
    echo "  Per-instance setup ($instance_id, $instance_count agents); legacy DB present but empty — no split-brain"
  fi
  return 0  # always success; this is a WARN not a gate
}
step "split-brain DB warn (v2.4.5)" split_brain_warn || exit 1

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
