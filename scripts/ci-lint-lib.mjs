#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The CI lint gate's parts that need no ESLint (tools/lint/lint-changed.mjs): the scope, the change range, the changed
 * files and their added lines, the added-line filter and the canary markers. Kept apart from the gate, which imports
 * the pinned ESLint from tools/lint/node_modules, so the tests reach these directly.
 */
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The files the gate lints: the root package's TypeScript and the scripts. Fixtures may hold bad code on purpose. */
export function inLintScope(file) {
  if (/^tests\/fixtures\//.test(file)) return false;
  return /^src\/.+\.(ts|mts)$/.test(file) || /^tests\/.+\.(ts|mts)$/.test(file) || /^scripts\/.+\.mjs$/.test(file);
}

export const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const ZERO_SHA = /^0{40}$/;

/**
 * git for the gate: pathspecs are literal (a name is never a glob), and every diff is TEXT with no textconv or
 * external driver: a `-diff` attribute would otherwise turn a source file into "Binary files differ", with no hunk.
 */
export function gateGit(root, args) {
  return execFileSync("git", ["--literal-pathspecs", ...args], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/**
 * The range a change is judged on, as a direct tree compare `from` -> `to`.
 *   pull request: from = the merge base of base and head (what the PR adds, as GitHub shows it);
 *   push: from = before, compared DIRECTLY (a force-push back to an ancestor still differs); a push that CREATES the
 *   branch has no before and is REFUSED: there is no change to lint, only a whole tree.
 */
export function changeRange(root, kind, a, b) {
  if (kind === "pr") {
    let base;
    try { base = gateGit(root, ["merge-base", a, b]).trim(); } catch { base = ""; }
    if (!base) throw new Error(`no merge base between ${a} and ${b}: refusing to guess what the pull request adds`);
    return { from: base, to: b };
  }
  if (kind === "push") {
    if (!a || ZERO_SHA.test(a)) throw new Error("this push CREATED the branch (no before commit): there is no change range to lint, refusing");
    try { gateGit(root, ["cat-file", "-e", `${a}^{commit}`]); } catch { throw new Error(`the push's before commit ${a} is not in this checkout: refusing`); }
    return { from: a, to: b };
  }
  throw new Error(`unknown range kind ${kind}`);
}

/** Changed files from `git diff --raw -z` (names verbatim: never quoted, any byte but NUL). Renames are paired. */
export function changedFiles(root, from, to) {
  const parts = gateGit(root, ["diff", "--raw", "-z", "-M", "--no-abbrev", from, to]).split("\0");
  const files = [];
  for (let i = 0; i < parts.length; ) {
    const meta = parts[i++];
    if (!meta) continue;
    const m = meta.match(/^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/);
    if (!m) throw new Error(`unreadable git diff --raw record: ${JSON.stringify(meta)}`);
    const status = m[5];
    const a = parts[i++];
    const b = status === "R" || status === "C" ? parts[i++] : a;
    files.push({ status, from: a, to: b, oldBlob: m[3], newBlob: m[4] });
  }
  return files;
}

/** Added line numbers from ONE file's `git diff --unified=0` text: the hunk headers only, no file header is read. */
export function hunkAddedLines(diff) {
  const lines = new Set();
  let hunks = 0;
  for (const line of diff.split("\n")) {
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!h) continue;
    hunks++;
    const start = Number(h[1]);
    const count = h[2] === undefined ? 1 : Number(h[2]);
    for (let i = 0; i < count; i++) lines.add(start + i);
  }
  return { lines, hunks, binary: /^Binary files .* differ$/m.test(diff) };
}

/**
 * Lines ADDED per changed file, each file diffed on its own (its name comes from changedFiles, never from a patch
 * header). FAIL CLOSED: a file whose content changed but whose diff has no hunk (or says "Binary files differ") is
 * returned in `unmapped`, because its added lines are unknown.
 */
export function addedLinesBetween(root, from, to, files, diffOf = (paths) => gateGit(root, ["diff", "--unified=0", "--no-color", "--text", "--no-textconv", "--no-ext-diff", "-M", from, to, "--", ...paths])) {
  const added = new Map();
  const unmapped = [];
  for (const f of files) {
    if (f.status === "D") continue;
    const diff = diffOf(f.from === f.to ? [f.to] : [f.from, f.to]);
    const { lines, hunks, binary } = hunkAddedLines(diff);
    const changed = f.oldBlob !== f.newBlob && f.newBlob !== EMPTY_BLOB;
    if (binary || (changed && hunks === 0)) unmapped.push(f.to);
    added.set(f.to, lines);
  }
  return { added, unmapped };
}

/**
 * GitHub workflow-command escaping. A file name is attacker-controlled (a pull request names its files): unescaped, a
 * newline in it would end the annotation and start a NEW workflow command line. `ghProperty` is for `file=...`
 * (also `:` and `,`, which end a property), `ghData` for the message and any plain log line that prints a name.
 */
export function ghData(s) {
  return String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
export function ghProperty(s) {
  return ghData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/**
 * ESLint results kept to the added lines. A message with NO rule (a parse error, or "File ignored ...") means the
 * file was not checked: it is kept wherever it is, as "not-linted", so the gate cannot pass on an unlinted file.
 */
export function onAddedLines(results, added, rel = (p) => path.relative(ROOT, p).split(path.sep).join("/")) {
  const kept = [];
  for (const r of results) {
    const file = rel(r.filePath);
    const lines = added.get(file) ?? new Set();
    for (const m of r.messages) {
      if (m.ruleId === null || m.ruleId === undefined) kept.push({ file, line: m.line ?? 1, rule: "not-linted", message: m.message });
      else if (lines.has(m.line)) kept.push({ file, line: m.line, rule: m.ruleId, message: m.message });
    }
  }
  return kept;
}

/** `// expect: <rule>` markers in canary sources: [{ file, line, rule }]. */
export function canaryExpectations(file, text) {
  const out = [];
  text.split("\n").forEach((l, i) => {
    const m = l.match(/\/\/ expect: (\S+)/);
    if (m) out.push({ file, line: i + 1, rule: m[1] });
  });
  return out;
}
