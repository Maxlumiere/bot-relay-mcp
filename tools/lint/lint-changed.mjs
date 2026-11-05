#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The CI lint gate (BUG rules only: tools/lint/eslint.config.mjs), `node tools/lint/lint-changed.mjs <mode>`. After
 * `npm ci --prefix tools/lint` (the pinned toolchain) and the root `npm ci` (the types the rules need).
 *
 *   --canary                  lint tools/lint/canary/: every `// expect: <rule>` line must be reported by exactly that
 *                             rule, and nothing else may be reported. A rule that went silent (switched off, renamed,
 *                             broken by an upgrade) FAILS this, so the gate never runs blind. Exit 0 = every rule live.
 *   --pr <base> <head>        BLOCKING: lint the files the change touched (in the lint scope) and report only findings
 *   --push <before> <after>   on lines it ADDED. A pull request is judged from the merge base (what GitHub shows); a
 *                             push directly from `before` (a force-push back to an ancestor still differs). A push
 *                             that creates the branch is REFUSED. `head`/`after` must be the checked-out HEAD, since
 *                             the files are linted from the working tree. Exit 1 on any finding, and on any changed
 *                             file whose added lines cannot be mapped or that ESLint did not lint.
 *   --all                     REPORT ONLY: every finding in LINT_SCOPE across the tree, counted by rule. Exit 0.
 *   --plant-check             CI ONLY (refuses elsewhere: it commits into the checkout): commit the floating-promise
 *                             canary under a hostile name (a space, a tab, non-ASCII) and marked `-diff`, run --push on
 *                             that commit, and REQUIRE it to block with no-floating-promises on that file; then reset.
 *                             Proves names -> diff -> lint -> line filter -> block for a file built to slip past them.
 * Findings print as GitHub annotations, and a summary goes to $GITHUB_STEP_SUMMARY when set.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
// A STATIC import, resolved from tools/lint/node_modules (the pinned toolchain). This file lives here, outside the
// scripts/ and tests/ the parser-pin guard scans, because loading ESLint from scripts/ needs a computed import.
import { ESLint } from "eslint";
import { inLintScope, changeRange, changedFiles, addedLinesBetween, onAddedLines, canaryExpectations, gateGit, ghData, ghProperty } from "../../scripts/ci-lint-lib.mjs";

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS, "..", "..");

async function eslint() {
  // cwd = the repo root: with the tools directory as cwd every repo file was "outside of base path" and IGNORED,
  // with no line number, so a line filter would have passed every pull request having linted nothing (MEASURED).
  // globInputPaths: false, so a file name is never read as a glob pattern (`[`, `*`, `{` are legal in names).
  return new ESLint({ cwd: ROOT, overrideConfigFile: path.join(TOOLS, "eslint.config.mjs"), errorOnUnmatchedPattern: false, globInputPaths: false });
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}

function annotate(f, level = "error") {
  console.log(`::${level} file=${ghProperty(f.file)},line=${f.line}::${ghData(`${f.rule}: ${f.message}`)}`);
}

async function canary() {
  const dir = path.join(TOOLS, "canary");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => path.join(dir, f));
  const expected = files.flatMap((f) => canaryExpectations(path.relative(ROOT, f), fs.readFileSync(f, "utf8")));
  const results = await (await eslint()).lintFiles(files);
  const got = results.flatMap((r) => r.messages.map((m) => ({ file: path.relative(ROOT, r.filePath), line: m.line, rule: m.ruleId ?? "not-linted", message: m.message })));
  const key = (x) => `${x.file}:${x.line}:${x.rule}`;
  const gotKeys = new Set(got.map(key));
  const expKeys = new Set(expected.map(key));
  const missing = expected.filter((e) => !gotKeys.has(key(e)));
  const unexpected = got.filter((g) => !expKeys.has(key(g)));
  const rules = [...new Set(expected.map((e) => e.rule))].sort();
  console.log(`lint canary: ${expected.length} expected findings over ${rules.length} rules (${rules.join(", ")}); ${got.length} reported`);
  for (const m of missing) console.log(ghData(`FAIL: ${m.file}:${m.line} expected ${m.rule}, which did NOT fire (the rule is off or broken: the gate would run blind)`));
  for (const u of unexpected) console.log(ghData(`FAIL: ${u.file}:${u.line} unexpected ${u.rule}: ${u.message}`));
  if (missing.length || unexpected.length) process.exit(1);
  console.log("OK: every bug rule fired exactly where its canary says, and the clean canary is clean");
}

async function changed(kind, a, b) {
  let range;
  try {
    range = changeRange(ROOT, kind, a, b);
    const head = gateGit(ROOT, ["rev-parse", "HEAD"]).trim();
    const to = gateGit(ROOT, ["rev-parse", `${range.to}^{commit}`]).trim();
    if (to !== head) throw new Error(`the judged commit ${to} is not the checked-out HEAD ${head}: the files on disk are not that change`);
  } catch (e) {
    console.log(`lint: REFUSED: ${e.message}`);
    summary(["### Lint (bug rules, changed lines)", `REFUSED: ${e.message}`]);
    process.exit(1);
  }
  const files = changedFiles(ROOT, range.from, range.to).filter((f) => f.status !== "D" && inLintScope(f.to));
  if (files.length === 0) {
    console.log(`lint: no changed file in the lint scope (${range.from.slice(0, 7)}..${range.to.slice(0, 7)})`);
    summary(["### Lint (bug rules, changed lines)", "No changed file in the lint scope."]);
    return;
  }
  const { added, unmapped } = addedLinesBetween(ROOT, range.from, range.to, files);
  const names = files.map((f) => f.to);
  const results = await (await eslint()).lintFiles(names.map((f) => path.join(ROOT, f)));
  const kept = onAddedLines(results, added);
  for (const f of unmapped) kept.push({ file: f, line: 1, rule: "not-linted", message: "its content changed but git gave no textual hunk, so its added lines are unknown" });
  const linted = new Set(results.map((r) => path.relative(ROOT, r.filePath).split(path.sep).join("/")));
  for (const f of names) if (!linted.has(f)) kept.push({ file: f, line: 1, rule: "not-linted", message: "ESLint returned no result for this file" });
  const addedCount = [...added.values()].reduce((n, set) => n + set.size, 0);
  console.log(`lint: ${range.from.slice(0, 7)}..${range.to.slice(0, 7)}: ${names.length} changed file(s), ${addedCount} added line(s), ${kept.length} finding(s) on them`);
  kept.forEach((f) => annotate(f));
  summary([
    "### Lint (bug rules, changed lines)",
    `${names.length} changed file(s), ${addedCount} added line(s): **${kept.length} finding(s)**`,
    ...kept.map((f) => `- \`${f.file}:${f.line}\` ${f.rule}: ${f.message}`),
  ]);
  if (kept.length) process.exit(1);
}

async function all() {
  const names = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(inLintScope);
  const results = await (await eslint()).lintFiles(names.map((f) => path.join(ROOT, f)));
  const found = results.flatMap((r) => r.messages.map((m) => ({ file: path.relative(ROOT, r.filePath), line: m.line, rule: m.ruleId ?? "not-linted", message: m.message })));
  const byRule = {};
  for (const f of found) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  console.log(`lint (report only): ${names.length} files, ${found.length} finding(s): ${JSON.stringify(byRule)}`);
  for (const f of found) console.log(ghData(`${f.file}:${f.line} ${f.rule}: ${f.message}`));
  summary(["### Lint debt (report only, whole tree)", `${names.length} files, ${found.length} finding(s)`, ...Object.entries(byRule).map(([k, v]) => `- ${k}: ${v}`)]);
}

function plantCheck() {
  if (process.env.GITHUB_ACTIONS !== "true") {
    console.error("--plant-check runs only in GitHub Actions: it commits into the checkout");
    process.exit(2);
  }
  const git = (...args) => execFileSync("git", ["-c", "user.email=ci@example.invalid", "-c", "user.name=ci", "-c", "commit.gpgsign=false", ...args], { cwd: ROOT, encoding: "utf8" });
  // A name built to slip past a diff reader and the scope filter (a space, a tab, non-ASCII, a newline, U+2028: git
  // quotes or tab-suffixes such names in patch headers, and `.` in a regex does not match a line terminator), marked
  // `-diff` so a plain diff of it is "Binary files differ".
  const planted = "tests/zz-planted floating\tpromise \u00fc\nline\u2028sep.ts";
  const start = git("rev-parse", "HEAD").trim();
  fs.copyFileSync(path.join(TOOLS, "canary", "floating-promise.ts"), path.join(ROOT, planted));
  fs.appendFileSync(path.join(ROOT, ".gitattributes"), "tests/zz-planted* -diff\n");
  git("add", "--", planted, ".gitattributes");
  git("commit", "-q", "-m", "planted: a floating promise in a hostile file");
  let out = "";
  let blocked = false;
  try {
    out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--push", start, "HEAD"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } });
  } catch (e) {
    blocked = e.status === 1;
    out = String(e.stdout ?? "");
  } finally {
    git("reset", "-q", "--hard", start);
  }
  process.stdout.write(out);
  const onPlanted = out.split("\n").some((l) => l.includes(`file=${ghProperty(planted)},`) && l.includes("@typescript-eslint/no-floating-promises"));
  if (!blocked || !onPlanted) {
    console.log("FAIL: the planted floating promise in a hostile file (space, tab, non-ASCII, newline, U+2028 in its name; -diff) did NOT block the lint gate on that file");
    process.exit(1);
  }
  console.log("OK: the planted floating promise in a hostile file (space, tab, non-ASCII, newline, U+2028 in its name; -diff) blocked the lint gate (exit 1)");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === "--canary") await canary();
  else if (mode === "--plant-check") plantCheck();
  else if ((mode === "--pr" || mode === "--push") && b) await changed(mode.slice(2), a, b);
  else if (mode === "--all") await all();
  else { console.error("usage: lint-changed.mjs --canary | --pr <base> <head> | --push <before> <after> | --all | --plant-check"); process.exit(2); }
}
