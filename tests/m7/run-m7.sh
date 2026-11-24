#!/usr/bin/env bash
# Doorbell PR 8, M7: run the measurement harness (tests/m7/m7-measure.test.ts) in a SANDBOX and print its report.
# Order: every refusal BEFORE any write. The real user's home comes from the passwd entry (os.userInfo, never $HOME,
# which a caller may point anywhere); the temp dir must resolve OUTSIDE the real relay home; dist must byte-match a
# fresh compile of HEAD's sources. Then it runs with a temp HOME, and lists the real relay instances directory's
# entry NAMES before and after (read-only) to show the run touched nothing there.
# Usage: tests/m7/run-m7.sh [REPORT_JSON]
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
for v in RELAY_HOME RELAY_INSTANCE_ID RELAY_DB_PATH RELAY_AGENT_TOKEN RELAY_HTTP_HOST; do
  if [ -n "${!v:-}" ]; then echo "m7: refusing: $v is set (a live relay selector); unset it" >&2; exit 2; fi
done
# The REAL home, from the passwd entry; its relay dir canonicalised (it may be a link).
real_home="$(node -e 'process.stdout.write(require("os").userInfo().homedir)')"
real_relay="$real_home/.bot-relay"
canon() { node -e 'const fs=require("fs"),p=require("path");let c=p.resolve(process.argv[1]),t=[];for(;;){try{process.stdout.write(p.join(fs.realpathSync.native(c),...t));break}catch{const u=p.dirname(c);if(u===c){process.stdout.write(p.resolve(process.argv[1]));break}t.unshift(p.basename(c));c=u}}' "$1"; }
inside() { case "$1/" in "$2"/*) return 0 ;; *) return 1 ;; esac; }
real_relay_c="$(canon "$real_relay")"
tmp_parent_c="$(canon "${TMPDIR:-/tmp}")"
if inside "$tmp_parent_c" "$real_relay_c"; then echo "m7: refusing: the temp dir resolves inside the real relay home" >&2; exit 2; fi
report="${1:-}"
if [ -n "$report" ] && inside "$(canon "$(dirname "$report")")" "$real_relay_c"; then echo "m7: refusing: the report path resolves inside the real relay home" >&2; exit 2; fi
harness="$(git -C "$here" rev-parse --short=12 HEAD)"
dirty="$(git -C "$here" status --porcelain --untracked-files=no -- src bin hooks package.json | grep -c . || true)"
[ "$dirty" -eq 0 ] || { echo "m7: refusing: src/bin/hooks/package.json have uncommitted changes; the report must name the code it measured" >&2; exit 2; }
# --- the first write: the sandbox, re-checked after creation ---
sandbox="$(mktemp -d "$tmp_parent_c/m7-home.XXXXXX")"
if inside "$(canon "$sandbox")" "$real_relay_c"; then echo "m7: refusing: the sandbox resolved inside the real relay home" >&2; rmdir "$sandbox"; exit 2; fi
report="${report:-$sandbox/m7-report.json}"
# DIST = HEAD: compile HEAD's sources into the sandbox and require every emitted .js to byte-match dist's.
(cd "$here" && npx tsc -p . --outDir "$sandbox/dist-check" >/dev/null) || { echo "m7: refusing: a fresh compile of HEAD failed" >&2; exit 2; }
mismatch=0
while IFS= read -r f; do
  cmp -s "$sandbox/dist-check/$f" "$here/dist/$f" || { echo "m7: dist differs from HEAD's sources: $f" >&2; mismatch=1; }
done < <(cd "$sandbox/dist-check" && find . -type f -name '*.js' ! -name 'build-info.js' | sort)
[ "$mismatch" -eq 0 ] || { echo "m7: refusing: dist is not a build of HEAD; run npm run build in THIS worktree" >&2; exit 2; }
# THE LABEL: the commit dist's build-info names, accepted only when its src/bin/hooks/package.json equal HEAD's.
built="$(grep -o '"commit":"[0-9a-f]*"' "$here/dist/build-info.js" 2>/dev/null | cut -d'"' -f4 || true)"
if [ -z "$built" ] || ! git -C "$here" diff --quiet "$built" HEAD -- src bin hooks package.json; then
  echo "m7: refusing: dist's build-info names '${built:-unknown}', whose code differs from HEAD" >&2; exit 2
fi
sha="$(git -C "$here" rev-parse --short=12 "$built")"
real_instances="$real_relay/instances"
list_instances() { if [ -d "$real_instances" ]; then (cd "$real_instances" && ls -1A); else echo "(no instances dir)"; fi; }
before="$(list_instances)"
echo "m7: measuring the code of $sha (dist byte-matches a fresh compile of HEAD; src/bin/hooks/package.json identical at the harness commit $harness)"
echo "m7: real instances dir BEFORE: $(printf '%s' "$before" | tr '\n' ' ')"
rc=0
(cd "$here" && HOME="$sandbox" M7_RUNNER=1 M7_SHA="$sha (harness $harness)" M7_REPORT="$report" npx vitest run --config vitest.m7.config.ts) || rc=$?
after="$(list_instances)"
echo "m7: real instances dir AFTER:  $(printf '%s' "$after" | tr '\n' ' ')"
if [ "$before" = "$after" ]; then echo "m7: the real instances dir is unchanged"; else echo "m7: WARNING: the real instances dir CHANGED during the run" >&2; rc=3; fi
echo "m7: report $report"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"));
console.log(`M7 on ${r.sha} (${r.platform}, node ${r.node}, ${r.at})`);
for (const x of r.results) {
  console.log(`check ${x.check}: ${x.verdict}`);
  for (const e of x.evidence) console.log(`  MEASURED: ${e}`);
  if (x.note) console.log(`  NOTE: ${x.note}`);
}' "$report"
exit "$rc"
