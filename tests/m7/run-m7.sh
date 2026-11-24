#!/usr/bin/env bash
# Doorbell PR 8, M7: run the measurement harness (tests/m7/m7-measure.test.ts) in a SANDBOX and print its report.
# It refuses to run with any live relay selector set, runs with a temp HOME, and lists the REAL relay instances
# directory's entry NAMES before and after (read-only) to show the run touched nothing there.
# Usage: tests/m7/run-m7.sh [REPORT_JSON]
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
for v in RELAY_HOME RELAY_INSTANCE_ID RELAY_DB_PATH RELAY_AGENT_TOKEN RELAY_HTTP_HOST; do
  if [ -n "${!v:-}" ]; then echo "m7: refusing: $v is set (a live relay selector); unset it" >&2; exit 2; fi
done
real_instances="$HOME/.bot-relay/instances"
sandbox="$(mktemp -d "${TMPDIR:-/tmp}/m7-home.XXXXXX")"
report="${1:-$sandbox/m7-report.json}"
harness="$(git -C "$here" rev-parse --short=12 HEAD)"
dirty="$(git -C "$here" status --porcelain --untracked-files=no -- src bin hooks | grep -c . || true)"
[ "$dirty" -eq 0 ] || { echo "m7: refusing: src/bin/hooks have uncommitted changes; the report must name the code it measured" >&2; exit 2; }
list_instances() { if [ -d "$real_instances" ]; then (cd "$real_instances" && ls -1A); else echo "(no instances dir)"; fi; }
before="$(list_instances)"
built="$(grep -o '"commit":"[0-9a-f]*"' "$here/dist/build-info.js" 2>/dev/null | cut -d'"' -f4 || true)"
# THE LABEL: the commit dist was built from, accepted only when its src/bin/hooks/package.json equal HEAD's
# (the harness's own commits change tests and configs only).
if [ -z "$built" ] || ! git -C "$here" diff --quiet "$built" HEAD -- src bin hooks package.json; then
  echo "m7: refusing: dist was built from '${built:-unknown}', whose code differs from HEAD; run npm run build in THIS worktree" >&2; exit 2
fi
sha="$(git -C "$here" rev-parse --short=12 "$built")"
echo "m7: measuring the code of $sha (dist built from it; src/bin/hooks/package.json identical at the harness commit $harness)"
echo "m7: real instances dir BEFORE: $(printf '%s' "$before" | tr '\n' ' ')"
rc=0
(cd "$here" && HOME="$sandbox" M7_SHA="$sha (harness $harness)" M7_REPORT="$report" npx vitest run --config vitest.m7.config.ts) || rc=$?
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
