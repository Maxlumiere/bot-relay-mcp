#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ci.yml's sharded Linux suite dropped nothing and ran nothing twice. Each shard writes a vitest JSON report of
 * the files it RAN (.vitest-shard/shard-<i>.json); this compares them with the suite's file list
 * (`vitest list --filesOnly --json`, the same config, so the same include/exclude):
 *   - there are exactly N reports;
 *   - no file ran in two shards;
 *   - the union of the shards' files IS the suite's file list (nothing missing, nothing extra);
 *   - a file that has test titles (`vitest list --json`, a STATIC read of the titles) ran at least one test in its
 *     shard (passed, failed or skipped): membership alone is not execution.
 * It prints each shard's files/tests and the totals. The static list cannot give the suite's TEST count (it
 * counts a title once even when a loop makes many tests: MEASURED 4064 static entries against 5309 tests run),
 * so the summed count is reported, not compared; the same commit's unsharded sweep (main and nightly) gives
 * that number. `vitest list` itself ignores --shard (MEASURED, vitest
 * 5.0.3: `list --filesOnly --shard=1/4` printed all 373 files), so the evidence is what the shards report they
 * ran, not what a list would predict.
 *
 * usage: node scripts/ci-shard-parity.mjs <N> [reportDir] [--suite-list <file.json>]
 * Exit 0 = parity holds; 1 = it does not (the reason is printed).
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A path relative to the repo, from an absolute path reported on any runner (the checkout dir may differ). */
export function repoRelative(file) {
  const norm = file.split(path.sep).join("/");
  const i = norm.lastIndexOf("/tests/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/**
 * The parity verdict for shard reports ({ files: string[], tests: number, results?: { [file]: number } }[])
 * against the suite's files, and (optionally) each file's static title count.
 */
export function shardParity(n, shards, suiteFiles, staticCounts = new Map()) {
  const problems = [];
  if (shards.length !== n) problems.push(`expected ${n} shard reports, found ${shards.length}`);
  const seen = new Map();
  shards.forEach((s, i) => {
    for (const f of s.files) {
      if (seen.has(f)) problems.push(`${f} ran in shard ${seen.get(f) + 1} AND shard ${i + 1}`);
      else seen.set(f, i);
    }
  });
  const suite = new Set(suiteFiles);
  const missing = [...suite].filter((f) => !seen.has(f)).sort();
  const extra = [...seen.keys()].filter((f) => !suite.has(f)).sort();
  if (missing.length) problems.push(`in the suite but in NO shard (${missing.length}): ${missing.join(", ")}`);
  if (extra.length) problems.push(`in a shard but not in the suite (${extra.length}): ${extra.join(", ")}`);
  for (const s of shards) {
    if (!s.results) continue;
    for (const f of s.files) {
      if ((staticCounts.get(f) ?? 0) > 0 && !(s.results[f] > 0)) problems.push(`${f} has ${staticCounts.get(f)} test title(s) but ran 0 tests`);
    }
  }
  return { ok: problems.length === 0, problems, files: seen.size, tests: shards.reduce((a, s) => a + s.tests, 0) };
}

function readShard(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(j.testResults) || typeof j.numTotalTests !== "number") throw new Error(`${file}: not a vitest JSON report`);
  const results = {};
  for (const t of j.testResults) results[repoRelative(t.name)] = Array.isArray(t.assertionResults) ? t.assertionResults.length : 0;
  return { files: j.testResults.map((t) => repoRelative(t.name)), tests: j.numTotalTests, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const n = Number(process.argv[2]);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write("usage: ci-shard-parity.mjs <N> [reportDir] [--suite-list <file.json>]\n");
    process.exit(2);
  }
  const dir = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : path.join(ROOT, ".vitest-shard");
  const li = process.argv.indexOf("--suite-list");
  const listJson = li > 0
    ? fs.readFileSync(process.argv[li + 1], "utf8")
    : execFileSync("npx", ["vitest", "list", "--filesOnly", "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const suiteFiles = JSON.parse(listJson).map((e) => repoRelative(e.file));
  const staticCounts = new Map();
  const titles = JSON.parse(execFileSync("npx", ["vitest", "list", "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  for (const t of titles) staticCounts.set(repoRelative(t.file), (staticCounts.get(repoRelative(t.file)) ?? 0) + 1);
  const reports = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^shard-\d+\.json$/.test(f)).sort() : [];
  const shards = reports.map((f) => readShard(path.join(dir, f)));
  shards.forEach((s, i) => console.log(`${reports[i]}: ${s.files.length} files, ${s.tests} tests`));
  const v = shardParity(n, shards, suiteFiles, staticCounts);
  console.log(`suite: ${suiteFiles.length} files; shards together: ${v.files} files, ${v.tests} tests`);
  if (!v.ok) {
    for (const p of v.problems) console.log(`FAIL: ${p}`);
    process.exit(1);
  }
  console.log(`OK: the ${n} shards are disjoint, together are exactly the suite's ${suiteFiles.length} files, and every file with test titles ran tests`);
}
