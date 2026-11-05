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
 *   --changed <base> <head>   BLOCKING: lint the files the change touched (LINT_SCOPE) and report only findings on
 *                             lines the change ADDED (`git diff -U0 base...head`). Exit 1 on any.
 *   --all                     REPORT ONLY: every finding in LINT_SCOPE across the tree, counted by rule. Exit 0.
 *   --plant-check             CI ONLY (refuses elsewhere: it commits into the checkout): commit the floating-promise
 *                             canary as a new file under tests/, run --changed on that commit, and REQUIRE it to block
 *                             with no-floating-promises; then reset. Proves diff -> lint -> line filter -> block.
 * Findings print as GitHub annotations, and a summary goes to $GITHUB_STEP_SUMMARY when set.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
// A STATIC import, resolved from tools/lint/node_modules (the pinned toolchain). This file lives here, outside the
// scripts/ and tests/ the parser-pin guard scans, because loading ESLint from scripts/ needs a computed import.
import { ESLint } from "eslint";
import { inLintScope, parseAddedLines, onAddedLines, canaryExpectations } from "../../scripts/ci-lint-lib.mjs";

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOLS, "..", "..");

async function eslint() {
  // cwd = the repo root: with the tools directory as cwd every repo file was "outside of base path" and IGNORED,
  // with no line number, so a line filter would have passed every pull request having linted nothing (MEASURED).
  return new ESLint({ cwd: ROOT, overrideConfigFile: path.join(TOOLS, "eslint.config.mjs"), errorOnUnmatchedPattern: false });
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}

function annotate(f, level = "error") {
  console.log(`::${level} file=${f.file},line=${f.line}::${f.rule}: ${f.message.replace(/\r?\n/g, " ")}`);
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
  for (const m of missing) console.log(`FAIL: ${m.file}:${m.line} expected ${m.rule}, which did NOT fire (the rule is off or broken: the gate would run blind)`);
  for (const u of unexpected) console.log(`FAIL: ${u.file}:${u.line} unexpected ${u.rule}: ${u.message}`);
  if (missing.length || unexpected.length) process.exit(1);
  console.log("OK: every bug rule fired exactly where its canary says, and the clean canary is clean");
}

async function changed(base, head) {
  const names = execFileSync("git", ["diff", "--name-only", "--diff-filter=AMR", `${base}...${head}`], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean).filter(inLintScope).filter((f) => fs.existsSync(path.join(ROOT, f)));
  if (names.length === 0) {
    console.log("lint: no changed file in the lint scope");
    summary(["### Lint (bug rules, changed lines)", "No changed file in the lint scope."]);
    return;
  }
  const diff = execFileSync("git", ["diff", "--unified=0", "--no-color", `${base}...${head}`, "--", ...names], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const added = parseAddedLines(diff);
  const results = await (await eslint()).lintFiles(names.map((f) => path.join(ROOT, f)));
  const kept = onAddedLines(results, added);
  const linted = new Set(results.map((r) => path.relative(ROOT, r.filePath).split(path.sep).join("/")));
  for (const f of names) if (!linted.has(f)) kept.push({ file: f, line: 1, rule: "not-linted", message: "ESLint returned no result for this file" });
  const addedCount = [...added.values()].reduce((a, s) => a + s.size, 0);
  console.log(`lint: ${names.length} changed file(s), ${addedCount} added line(s), ${kept.length} finding(s) on them`);
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
  for (const f of found) console.log(`${f.file}:${f.line} ${f.rule}: ${f.message}`);
  summary(["### Lint debt (report only, whole tree)", `${names.length} files, ${found.length} finding(s)`, ...Object.entries(byRule).map(([k, v]) => `- ${k}: ${v}`)]);
}

function plantCheck() {
  if (process.env.GITHUB_ACTIONS !== "true") {
    console.error("--plant-check runs only in GitHub Actions: it commits into the checkout");
    process.exit(2);
  }
  const git = (...args) => execFileSync("git", ["-c", "user.email=ci@example.invalid", "-c", "user.name=ci", ...args], { cwd: ROOT, encoding: "utf8" });
  const planted = "tests/zz-planted-floating-promise.ts";
  fs.copyFileSync(path.join(TOOLS, "canary", "floating-promise.ts"), path.join(ROOT, planted));
  git("add", planted);
  git("commit", "-q", "-m", "planted: a floating promise on an added line");
  let out = "";
  let blocked = false;
  try {
    out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--changed", "HEAD~1", "HEAD"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } });
  } catch (e) {
    blocked = e.status === 1;
    out = String(e.stdout ?? "");
  } finally {
    git("reset", "-q", "--hard", "HEAD~1");
  }
  process.stdout.write(out);
  if (!blocked || !out.includes("@typescript-eslint/no-floating-promises")) {
    console.log("FAIL: the planted floating promise on an added line did NOT block the lint gate");
    process.exit(1);
  }
  console.log("OK: the planted floating promise on an added line blocked the lint gate (exit 1)");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === "--canary") await canary();
  else if (mode === "--plant-check") plantCheck();
  else if (mode === "--changed" && a && b) await changed(a, b);
  else if (mode === "--all") await all();
  else { console.error("usage: lint-changed.mjs --canary | --changed <base> <head> | --all | --plant-check"); process.exit(2); }
}
