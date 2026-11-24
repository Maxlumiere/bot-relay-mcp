#!/usr/bin/env bash
# Doorbell PR 8, M7: run the measurement harness (tests/m7/m7-measure.test.ts) in a SANDBOX and print its report.
# Order: every refusal BEFORE any write. The real user's home comes from the passwd entry (os.userInfo, never $HOME,
# which a caller may point anywhere); the temp dir must resolve OUTSIDE the real relay home; dist must be a
# clean build of a CLEAN HEAD in a linked worktree. Then it runs with a temp HOME, and lists the real relay instances directory's
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
# The SAME isolation rule the config and the test apply (tests/m7/isolation.mjs): the temp root outside the whole home.
iso="$(node -e 'import(require("url").pathToFileURL(process.argv[1]).href).then((m) => process.stdout.write(m.isolationFault(process.env) ?? ""))' "$here/tests/m7/isolation.mjs")"
if [ -n "$iso" ]; then echo "m7: refusing: $iso" >&2; exit 2; fi
report="${1:-}"
# THE REPORT: a NEW path only (the test opens it O_CREAT|O_EXCL|O_NOFOLLOW too): an existing file or a link is refused.
if [ -n "$report" ]; then
  if [ -e "$report" ] || [ -L "$report" ]; then echo "m7: refusing: the report path already exists (or is a link); name a new file" >&2; exit 2; fi
  if inside "$(canon "$(dirname "$report")")" "$real_relay_c"; then echo "m7: refusing: the report path resolves inside the real relay home" >&2; exit 2; fi
fi
# PROVENANCE: a linked worktree only (the clean build deletes dist/, which in the main checkout may be what a live
# relay runs), a CLEAN tree (nothing modified, nothing untracked), then a clean build of HEAD.
if [ "$(cd "$here" && git rev-parse --path-format=absolute --git-dir)" = "$(cd "$here" && git rev-parse --path-format=absolute --git-common-dir)" ]; then
  echo "m7: refusing: run it in a linked worktree (it deletes and rebuilds dist)" >&2; exit 2
fi
if [ -n "$(git -C "$here" status --porcelain --untracked-files=all)" ]; then
  echo "m7: refusing: the tree is not clean (git status --porcelain --untracked-files=all is not empty)" >&2; exit 2
fi
sha="$(git -C "$here" rev-parse HEAD)"
# --- the first write: the sandbox, re-checked after creation ---
sandbox="$(mktemp -d "$tmp_parent_c/m7-home.XXXXXX")"
if inside "$(canon "$sandbox")" "$real_relay_c"; then echo "m7: refusing: the sandbox resolved inside the real relay home" >&2; rmdir "$sandbox"; exit 2; fi
report="${report:-$sandbox/m7-report.json}"
(cd "$here" && rm -rf dist && npm run build >"$sandbox/build.log" 2>&1) || { echo "m7: refusing: the clean build of HEAD failed (see $sandbox/build.log)" >&2; exit 2; }
real_instances="$real_relay/instances"
list_instances() { if [ -d "$real_instances" ]; then (cd "$real_instances" && ls -1A); else echo "(no instances dir)"; fi; }
before="$(list_instances)"
echo "m7: measuring $sha (clean tree, clean build)"
echo "m7: real instances dir BEFORE: $(printf '%s' "$before" | tr '\n' ' ')"
rc=0
(cd "$here" && HOME="$sandbox" M7_RUNNER=1 M7_SHA="$sha (clean tree, clean build)" M7_REPORT="$report" npx vitest run --config vitest.m7.config.ts) || rc=$?
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
