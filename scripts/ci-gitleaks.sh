#!/usr/bin/env bash
# bot-relay-mcp
# Copyright (c) 2026 Lumiere Ventures
# SPDX-License-Identifier: MIT
# See LICENSE for full terms.
#
# The CI secrets gate (gitleaks), pinned by HASH: one exact release asset, checked against the SHA-256 below before it
# is ever run (no floating tag, no installer script). Every report is --redact: a finding names the rule, file, line
# and commit, never the secret.
#
#   install                 download + verify the pinned binary into $GITLEAKS_DIR (default $RUNNER_TEMP/gitleaks)
#   canary                  a fake credential built AT RUNTIME (never committed) in a scratch repo MUST be found;
#                           exit 1 when it is not (the gate would be blind)
#   scan-event              BLOCKING: scan the commits this event adds (a pull request: base..head; a push:
#                           before..after; nothing to diff on schedule/dispatch). Exit 1 on any finding
#   baseline                REPORT ONLY: the whole history, counted by rule. Exit 0
#   plant-check             CI ONLY (refuses elsewhere: it commits into the checkout): commit a runtime-built fake
#                           credential, run scan-event as a push of that one commit, REQUIRE it to block; then reset
set -euo pipefail

GITLEAKS_VERSION="8.30.1"
GITLEAKS_ASSET="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
# SHA-256 of the asset above, MEASURED 5 Nov 2026 and equal to the release's own gitleaks_8.30.1_checksums.txt.
GITLEAKS_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"

GITLEAKS_DIR="${GITLEAKS_DIR:-${RUNNER_TEMP:-/tmp}/gitleaks}"
BIN="$GITLEAKS_DIR/gitleaks"
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"

summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; fi; }

# Print a redacted JSON report as one line per finding (rule, file:line, commit), plus a count by rule.
report() {
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "[]");
    const by = {};
    for (const f of r) { by[f.RuleID] = (by[f.RuleID] || 0) + 1; console.log(`${f.RuleID} ${f.File}:${f.StartLine} commit ${String(f.Commit || "").slice(0, 7)}`); }
    console.log(`findings: ${r.length} ${JSON.stringify(by)}`);
  ' "$1"
}

cmd_install() {
  mkdir -p "$GITLEAKS_DIR"
  local tgz="$GITLEAKS_DIR/$GITLEAKS_ASSET"
  curl -fsSL --retry 3 -o "$tgz" "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${GITLEAKS_ASSET}"
  local got
  got="$(sha256sum "$tgz" | cut -d' ' -f1)"
  if [ "$got" != "$GITLEAKS_SHA256" ]; then
    echo "REFUSED: $GITLEAKS_ASSET has SHA-256 $got, pinned $GITLEAKS_SHA256"
    exit 1
  fi
  tar -xzf "$tgz" -C "$GITLEAKS_DIR" gitleaks
  "$BIN" version
}

cmd_canary() {
  local dir rc out
  dir="$(mktemp -d)"
  out="$dir.json"
  git -C "$dir" init -q
  git -C "$dir" -c user.email=canary@example.invalid -c user.name=canary commit -q --allow-empty -m init
  # A GitHub personal-access-token SHAPE with random characters, assembled here so this file never holds one.
  local fake
  fake="ghp_$(head -c 200 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 36)"
  printf 'const token = "%s";\n' "$fake" > "$dir/config.js"
  git -C "$dir" add config.js
  git -C "$dir" -c user.email=canary@example.invalid -c user.name=canary commit -q -m "add config"
  set +e
  "$BIN" git "$dir" --redact --no-banner --exit-code 1 --report-format json --report-path "$out" >/dev/null 2>&1
  rc=$?
  set -e
  local n
  n="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "[]").length)' "$out" 2>/dev/null || echo 0)"
  rm -rf "$dir" "$out"
  if [ "$rc" -ne 1 ] || [ "$n" -lt 1 ]; then
    echo "FAIL: the secrets canary was NOT caught (exit $rc, $n finding(s)): the gate would run blind"
    exit 1
  fi
  echo "OK: the secrets canary was caught ($n finding(s), exit $rc)"
}

cmd_scan_event() {
  local range=""
  case "${EVENT:-}" in
    pull_request) range="${PR_BASE}..${PR_HEAD}" ;;
    push)
      if [ -n "${PUSH_BEFORE:-}" ] && [ "${PUSH_BEFORE}" != "0000000000000000000000000000000000000000" ]; then
        range="${PUSH_BEFORE}..${PUSH_AFTER}"
      else
        range="-1 ${PUSH_AFTER}"
      fi
      ;;
    *)
      echo "secrets: no commits to diff on a ${EVENT:-unknown} event (the baseline step covers the whole history)"
      summary "### Secrets (gitleaks ${GITLEAKS_VERSION})" "No commit range on a ${EVENT:-unknown} event."
      return 0
      ;;
  esac
  local out rc
  out="$(mktemp).json"
  set +e
  "$BIN" git "$ROOT" --log-opts="$range" --redact --no-banner --exit-code 1 --report-format json --report-path "$out"
  rc=$?
  set -e
  echo "secrets: scanned commits $range (exit $rc)"
  report "$out" | tee "$out.txt"
  summary "### Secrets (gitleaks ${GITLEAKS_VERSION}, blocking)" "Commits \`$range\`: $(tail -1 "$out.txt")" '```' "$(head -n -1 "$out.txt")" '```'
  if [ "$rc" -ne 0 ]; then
    echo "BLOCKED: a secret-shaped string in this change's commits (redacted above). Remove it from the history, rotate it if it is real, and never paste it anywhere."
    exit 1
  fi
}

cmd_baseline() {
  local out
  out="$(mktemp).json"
  set +e
  "$BIN" git "$ROOT" --redact --no-banner --exit-code 0 --report-format json --report-path "$out" >/dev/null 2>&1
  set -e
  echo "secrets baseline (report only, whole history):"
  report "$out" | tee "$out.txt"
  summary "### Secrets baseline (report only, whole history)" "$(tail -1 "$out.txt")" '```' "$(head -n -1 "$out.txt")" '```'
}

cmd_plant_check() {
  if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
    echo "plant-check runs only in GitHub Actions: it commits into the checkout"
    exit 2
  fi
  local fake rc
  fake="ghp_$(head -c 200 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 36)"
  printf 'export const token = "%s";\n' "$fake" > "$ROOT/zz-planted-secret.js"
  git -C "$ROOT" add zz-planted-secret.js
  git -C "$ROOT" -c user.email=ci@example.invalid -c user.name=ci commit -q -m "planted: a fake credential"
  set +e
  EVENT=push PUSH_BEFORE="$(git -C "$ROOT" rev-parse HEAD~1)" PUSH_AFTER="$(git -C "$ROOT" rev-parse HEAD)" GITHUB_STEP_SUMMARY="" \
    bash "$0" scan-event
  rc=$?
  set -e
  git -C "$ROOT" reset -q --hard HEAD~1
  if [ "$rc" -ne 1 ]; then
    echo "FAIL: the planted fake credential did NOT block the secrets gate (exit $rc)"
    exit 1
  fi
  echo "OK: the planted fake credential blocked the secrets gate (exit 1)"
}

case "${1:-}" in
  install) cmd_install ;;
  canary) cmd_canary ;;
  scan-event) cmd_scan_event ;;
  baseline) cmd_baseline ;;
  plant-check) cmd_plant_check ;;
  *) echo "usage: ci-gitleaks.sh install|canary|scan-event|baseline|plant-check"; exit 2 ;;
esac
