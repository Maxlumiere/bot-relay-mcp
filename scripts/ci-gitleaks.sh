#!/usr/bin/env bash
# bot-relay-mcp
# Copyright (c) 2026 Lumiere Ventures
# SPDX-License-Identifier: MIT
# See LICENSE for full terms.
#
# The CI secrets gate (gitleaks), pinned by HASH: one exact release asset, checked against the SHA-256 below before it
# is ever run (no floating tag, no installer script). Every report is --redact: a finding names the rule, file, line
# and commit, never the secret. The config is upstream's default, pinned by commit and SHA-256, with its global PATH
# allowlist removed (scripts/ci-gitleaks-config.mjs): upstream skips lockfiles, SVGs, node_modules and more unseen.
#
# Every scan reads git with GIT_LOG_OPTS: merge commits are diffed against each parent (a credential added while
# resolving a merge is otherwise never shown), and every file is diffed as TEXT with no textconv or external driver
# (a `-diff` attribute would otherwise turn the file into "Binary files differ", which gitleaks skips).
#
# A change cannot exempt itself: inline `gitleaks:allow` comments are ignored, and the .gitleaksignore that applies
# is the TRUSTED side's (a pull request's base, a push's before, main itself for the baseline), never the one in
# the change. gitleaks reads a .gitleaksignore from its source directory and from its working directory, so its
# source is the repository's git dir (no commit can write there) and it runs from an empty directory.
#
#   install                 download + verify the pinned binary and the pinned upstream config into $GITLEAKS_DIR
#                           (default $RUNNER_TEMP/gitleaks); write the narrowed config there
#   canary                  fake credentials built AT RUNTIME (never committed) in a scratch repo MUST each be found,
#                           including in the paths upstream skips, behind a `gitleaks:allow` comment, and listed in
#                           the scratch repo's own .gitleaksignore; exit 1 when one is not (the gate would be blind)
#   scan-event              BLOCKING: scan the commits this event adds (a pull request: base..head; a push:
#                           before..after, or, when the push CREATES the branch, every commit no other branch or tag
#                           holds; nothing to diff on schedule/dispatch). Exit 1 on any finding
#   baseline                REPORT ONLY: the whole history, counted by rule. Exit 0
#   plant-check             CI ONLY (refuses elsewhere: it commits into the checkout): plant a runtime-built fake
#                           credential six ways (a plain commit, a merge resolution, a file marked `-diff`, the first
#                           of two commits pushed as a new branch, behind `gitleaks:allow`, and allowlisted by the
#                           change's own .gitleaksignore), REQUIRE each to block on the planted file; then reset
set -euo pipefail

GITLEAKS_VERSION="8.30.1"
GITLEAKS_ASSET="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
# SHA-256 of the asset above, MEASURED 5 Nov 2026 and equal to the release's own gitleaks_8.30.1_checksums.txt.
GITLEAKS_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"

GITLEAKS_DIR="${GITLEAKS_DIR:-${RUNNER_TEMP:-/tmp}/gitleaks}"
BIN="$GITLEAKS_DIR/gitleaks"
CONFIG="$GITLEAKS_DIR/gitleaks.toml"
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
# gitleaks splits --log-opts on spaces and appends them to `git log -p -U0`.
GIT_LOG_OPTS="--diff-merges=separate --text --no-textconv --no-ext-diff"
ZERO_SHA="0000000000000000000000000000000000000000"

# leaks <repo> <trusted .gitleaksignore file, or ""> <gitleaks args...>: the narrowed config (never gitleaks' built-in
# default, which carries the path allowlist), no inline allow, and only the trusted ignore file.
leaks() {
  local repo="$1" ignore="$2" gitdir cwd rc
  shift 2
  if [ ! -s "$CONFIG" ]; then echo "REFUSED: no narrowed config at $CONFIG (run install)"; exit 1; fi
  gitdir="$(git -C "$repo" rev-parse --absolute-git-dir)"
  cwd="$(mktemp -d)"
  (cd "$cwd" && "$BIN" git "$gitdir" --config "$CONFIG" --ignore-gitleaks-allow --gitleaks-ignore-path "${ignore:-$cwd/none}" --redact --no-banner "$@")
  rc=$?
  rm -rf "$cwd"
  return "$rc"
}

# The .gitleaksignore of a TRUSTED commit, copied to a temp file; prints its path, or nothing when there is none.
trusted_ignore() {
  local ref="$1" f
  [ -n "$ref" ] || return 0
  f="$(mktemp)"
  if git -C "$ROOT" show "$ref:.gitleaksignore" > "$f" 2>/dev/null; then echo "$f"; else rm -f "$f"; fi
}

summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; fi; }

# Print a redacted JSON report as one line per finding (rule, file:line, commit), plus a count by rule. A file name
# is attacker-controlled: %, CR and LF are escaped as in a workflow command, so a newline in a name cannot start one,
# and `##[` (the runner's legacy command form, recognised anywhere in a line) becomes `##%5B`.
report() {
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "[]");
    const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/##\[/g, "##%5B");
    const by = {};
    for (const f of r) { by[f.RuleID] = (by[f.RuleID] || 0) + 1; console.log(esc(`${f.RuleID} ${f.File}:${f.StartLine} commit ${String(f.Commit || "").slice(0, 7)}`)); }
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
  curl -fsSL --retry 3 -o "$GITLEAKS_DIR/upstream.toml" "$(node "$ROOT/scripts/ci-gitleaks-config.mjs" --url)"
  node "$ROOT/scripts/ci-gitleaks-config.mjs" "$GITLEAKS_DIR/upstream.toml" "$CONFIG"
}

fake_token() { echo "ghp_$(head -c 300 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 36)"; }

cmd_canary() {
  local dir rc out
  dir="$(mktemp -d)"
  out="$dir.json"
  git -C "$dir" init -q
  git -C "$dir" -c user.email=canary@example.invalid -c user.name=canary commit -q --allow-empty -m init
  # GitHub personal-access-token SHAPES with random characters, assembled here so this file never holds one. One in
  # an ordinary file, and one in each kind of path upstream's default allowlist skips whole.
  local expected="config.js package-lock.json icon.svg node_modules/x/index.js my.gitleaks.toml inline.js selfignored.js"
  printf 'const token = "%s";\n' "$(fake_token)" > "$dir/config.js"
  printf '{"resolved": "https://%s@registry.example.invalid/x.tgz"}\n' "$(fake_token)" > "$dir/package-lock.json"
  printf '<svg><!-- %s --></svg>\n' "$(fake_token)" > "$dir/icon.svg"
  mkdir -p "$dir/node_modules/x"
  printf 'module.exports = "%s";\n' "$(fake_token)" > "$dir/node_modules/x/index.js"
  printf 'token = "%s"\n' "$(fake_token)" > "$dir/my.gitleaks.toml"
  # The two ways a change could exempt itself: an inline comment, and its own .gitleaksignore.
  printf 'const token = "%s"; // gitleaks:allow\n' "$(fake_token)" > "$dir/inline.js"
  printf 'const token = "%s";\n' "$(fake_token)" > "$dir/selfignored.js"
  printf 'selfignored.js:github-pat:1\n' > "$dir/.gitleaksignore"
  git -C "$dir" add -A -f
  git -C "$dir" -c user.email=canary@example.invalid -c user.name=canary commit -q -m "add config"
  set +e
  leaks "$dir" "" --log-opts="$GIT_LOG_OPTS HEAD" --exit-code 1 --report-format json --report-path "$out" >/dev/null 2>&1
  rc=$?
  set -e
  local found missing=""
  found="$(node -e 'console.log([...new Set(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "[]").map((f) => f.File))].join(" "))' "$out" 2>/dev/null || true)"
  rm -rf "$dir" "$out"
  for f in $expected; do case " $found " in *" $f "*) ;; *) missing="$missing $f" ;; esac; done
  if [ "$rc" -ne 1 ] || [ -n "$missing" ]; then
    echo "FAIL: the secrets canary was NOT caught in:${missing:- (exit $rc)}. The gate would run blind there"
    exit 1
  fi
  echo "OK: the secrets canary was caught in every planted path ($expected; exit $rc)"
}

cmd_scan_event() {
  local range="" trusted=""
  case "${EVENT:-}" in
    pull_request) range="${PR_BASE}..${PR_HEAD}"; trusted="$PR_BASE" ;;
    push)
      if [ -n "${PUSH_BEFORE:-}" ] && [ "${PUSH_BEFORE}" != "$ZERO_SHA" ]; then
        range="${PUSH_BEFORE}..${PUSH_AFTER}"
        trusted="$PUSH_BEFORE"
      else
        # The push CREATED the branch: every commit it makes reachable that no other branch or tag already holds.
        # (An --exclude pattern for --remotes is written WITHOUT its refs/remotes/ prefix.)
        range="${PUSH_AFTER} --not --exclude=origin/${PUSH_REF_NAME:?} --remotes --tags"
      fi
      ;;
    *)
      echo "secrets: no commits to diff on a ${EVENT:-unknown} event (the baseline step covers the whole history)"
      summary "### Secrets (gitleaks ${GITLEAKS_VERSION})" "No commit range on a ${EVENT:-unknown} event."
      return 0
      ;;
  esac
  local out rc ignore
  out="$(mktemp).json"
  ignore="$(trusted_ignore "$trusted")"
  set +e
  leaks "$ROOT" "$ignore" --log-opts="$GIT_LOG_OPTS $range" --exit-code 1 --report-format json --report-path "$out"
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
  leaks "$ROOT" "$(trusted_ignore HEAD)" --log-opts="$GIT_LOG_OPTS --all --full-history --diff-filter=tuxdb" --exit-code 0 --report-format json --report-path "$out" >/dev/null 2>&1
  set -e
  echo "secrets baseline (report only, whole history):"
  report "$out" | tee "$out.txt"
  summary "### Secrets baseline (report only, whole history)" "$(tail -1 "$out.txt")" '```' "$(head -n -1 "$out.txt")" '```'
}

# Commit in the checkout as CI. Every planted commit is undone by plant_one's reset.
ci_git() { git -C "$ROOT" -c user.email=ci@example.invalid -c user.name=ci -c commit.gpgsign=false "$@"; }

# plant_one <label> <planted file> <setup function> [zero]: run the setup on top of HEAD, scan it as a push (from the
# old HEAD, or as a NEW branch with `zero`), reset to the old HEAD, and require exit 1 with a finding in that file.
plant_one() {
  local label="$1" file="$2" setup="$3" mode="${4:-}" start out rc
  start="$(git -C "$ROOT" rev-parse HEAD)"
  "$setup"
  set +e
  if [ "$mode" = zero ]; then
    out="$(EVENT=push PUSH_BEFORE="$ZERO_SHA" PUSH_AFTER="$(git -C "$ROOT" rev-parse HEAD)" PUSH_REF_NAME="zz-planted-new-branch" GITHUB_STEP_SUMMARY="" bash "$0" scan-event 2>&1)"
  else
    out="$(EVENT=push PUSH_BEFORE="$start" PUSH_AFTER="$(git -C "$ROOT" rev-parse HEAD)" GITHUB_STEP_SUMMARY="" bash "$0" scan-event 2>&1)"
  fi
  rc=$?
  set -e
  git -C "$ROOT" reset -q --hard "$start"
  git -C "$ROOT" clean -qfd -- "$file" .gitattributes >/dev/null 2>&1 || true
  printf '%s\n' "$out" | grep -vE '^(secrets: scanned|BLOCKED)' || true
  if [ "$rc" -ne 1 ] || ! printf '%s\n' "$out" | grep -qF " $file:"; then
    echo "FAIL: planted ($label): the fake credential in $file did NOT block the secrets gate (exit $rc)"
    exit 1
  fi
  echo "OK: planted ($label): blocked on $file (exit 1)"
}

setup_plain() {
  printf 'export const token = "%s";\n' "$(fake_token)" > "$ROOT/zz-planted-secret.js"
  ci_git add zz-planted-secret.js
  ci_git commit -q -m "planted: a fake credential"
}

# Two clean branches, merged; the credential appears ONLY in the merge commit (a conflict resolution, an evil merge).
setup_merge() {
  local start
  start="$(git -C "$ROOT" rev-parse HEAD)"
  printf 'side\n' > "$ROOT/zz-planted-side.txt"
  ci_git add zz-planted-side.txt
  ci_git commit -q -m "planted: side"
  local side
  side="$(git -C "$ROOT" rev-parse HEAD)"
  ci_git reset -q --hard "$start"
  printf 'main\n' > "$ROOT/zz-planted-main.txt"
  ci_git add zz-planted-main.txt
  ci_git commit -q -m "planted: main"
  ci_git merge -q --no-ff --no-commit "$side" >/dev/null
  printf 'export const token = "%s";\n' "$(fake_token)" > "$ROOT/zz-planted-merge.js"
  ci_git add zz-planted-merge.js
  ci_git commit -q -m "planted: merge"
}

# The file is marked `-diff`, so a plain `git log -p` prints "Binary files differ" for it.
setup_attr() {
  printf 'zz-planted-attr.js -diff\n' >> "$ROOT/.gitattributes"
  printf 'export const token = "%s";\n' "$(fake_token)" > "$ROOT/zz-planted-attr.js"
  ci_git add .gitattributes zz-planted-attr.js
  ci_git commit -q -m "planted: a fake credential in a -diff file"
}

# Two commits pushed as a NEW branch (no before): the credential is in the FIRST, not the tip.
setup_zero() {
  printf 'export const token = "%s";\n' "$(fake_token)" > "$ROOT/zz-planted-first.js"
  ci_git add zz-planted-first.js
  ci_git commit -q -m "planted: first"
  printf 'later\n' > "$ROOT/zz-planted-later.txt"
  ci_git add zz-planted-later.txt
  ci_git commit -q -m "planted: later"
}

# The change marks its own credential `gitleaks:allow`.
setup_inline() {
  printf 'export const token = "%s"; // gitleaks:allow\n' "$(fake_token)" > "$ROOT/zz-planted-inline.js"
  ci_git add zz-planted-inline.js
  ci_git commit -q -m "planted: a fake credential marked gitleaks:allow"
}

# The change adds a credential, then allowlists it in its OWN .gitleaksignore (by commit and by global fingerprint).
setup_selfignore() {
  printf 'export const token = "%s";\n' "$(fake_token)" > "$ROOT/zz-planted-selfignore.js"
  ci_git add zz-planted-selfignore.js
  ci_git commit -q -m "planted: a fake credential"
  printf '%s:zz-planted-selfignore.js:github-pat:1\nzz-planted-selfignore.js:github-pat:1\n' "$(git -C "$ROOT" rev-parse HEAD)" >> "$ROOT/.gitleaksignore"
  ci_git add .gitleaksignore
  ci_git commit -q -m "planted: allowlist it"
}

cmd_plant_check() {
  if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
    echo "plant-check runs only in GitHub Actions: it commits into the checkout"
    exit 2
  fi
  plant_one "a plain commit" zz-planted-secret.js setup_plain
  plant_one "only in a merge commit" zz-planted-merge.js setup_merge
  plant_one "a file marked -diff" zz-planted-attr.js setup_attr
  plant_one "the first of two commits pushed as a new branch" zz-planted-first.js setup_zero zero
  plant_one "marked gitleaks:allow" zz-planted-inline.js setup_inline
  plant_one "allowlisted by the change's own .gitleaksignore" zz-planted-selfignore.js setup_selfignore
}

case "${1:-}" in
  install) cmd_install ;;
  canary) cmd_canary ;;
  scan-event) cmd_scan_event ;;
  baseline) cmd_baseline ;;
  plant-check) cmd_plant_check ;;
  *) echo "usage: ci-gitleaks.sh install|canary|scan-event|baseline|plant-check"; exit 2 ;;
esac
