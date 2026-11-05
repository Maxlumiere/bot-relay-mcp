#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ci.yml's aggregate verdicts, from the `needs` context (toJSON(needs) on stdin). Every SKIP is checked against
 * the Scope job's outputs: a job the Scope required must SUCCEED; a skip is accepted only for a job the Scope
 * excluded (full=false: macOS, Windows, timing bars). A skipped job otherwise reports Success to a required
 * check, so "skipped" is never accepted on its own.
 *   linux  "Test (Node 22)": Scope, the shards and Checks succeeded; the timing bars as the Scope requires.
 *   all    "ci-ok": the same, plus Test (Node 22), the smoke, the secrets scan and the lint gate (never scoped out),
 *          macOS and Windows.
 * usage: echo "$NEEDS" | node scripts/ci-verdict.mjs <linux|all>   (exit 0 = green)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/** The jobs the Scope may exclude (full=false); everything else must always succeed. */
export const SCOPED = ["timing-bars", "test-windows", "test-macos"];
// The blocking quality gates (secrets, lint) are never scoped out: they run on every change, docs-only included.
const ALWAYS = { linux: ["changes", "shard", "checks"], all: ["changes", "shard", "checks", "test", "smoke", "secrets", "lint"] };
const SCOPED_IN = { linux: ["timing-bars"], all: SCOPED };

/** Pure: { ok, problems } for a needs object ({ <job>: { result, outputs } }). */
export function verdict(needs, which) {
  const problems = [];
  if (!ALWAYS[which]) return { ok: false, problems: [`unknown verdict "${which}"`] };
  const res = (j) => (needs[j] ? needs[j].result : "missing");
  for (const j of ALWAYS[which]) if (res(j) !== "success") problems.push(`${j}=${res(j)} (must succeed)`);
  // Without a successful Scope there is nothing to excuse a skip with: every scoped job must then succeed.
  const full = res("changes") !== "success" || needs.changes.outputs?.full !== "false";
  for (const j of SCOPED_IN[which]) {
    const r = res(j);
    if (r === "success") continue;
    if (r === "skipped" && !full) continue;
    problems.push(`${j}=${r} (${full ? "the Scope required it" : "only success or a scope skip is accepted"})`);
  }
  // ci-ok needs every job: one it does not know is judged strictly.
  if (which === "all") {
    for (const j of Object.keys(needs)) {
      if (!ALWAYS.all.includes(j) && !SCOPED.includes(j) && res(j) !== "success") problems.push(`${j}=${res(j)} (must succeed)`);
    }
  }
  return { ok: problems.length === 0, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const needs = JSON.parse(fs.readFileSync(0, "utf8"));
  for (const [k, v] of Object.entries(needs)) console.log(`${k}: ${v.result}${v.outputs && Object.keys(v.outputs).length ? " " + JSON.stringify(v.outputs) : ""}`);
  const v = verdict(needs, process.argv[2]);
  if (!v.ok) {
    console.log(`FAIL: ${v.problems.join("; ")}`);
    process.exit(1);
  }
  console.log(`OK (${process.argv[2]})`);
}
