#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ci.yml's aggregate verdicts, from the `needs` context (toJSON(needs) on stdin).
 *   linux  "Test (Node 22)": Scope, the shards and Checks succeeded; the timing bars succeeded or were skipped.
 *   all    "ci-ok": every job succeeded or was skipped.
 * usage: echo "$NEEDS" | node scripts/ci-verdict.mjs <linux|all>   (exit 0 = green)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ok = (r) => r === "success";
const okOrSkipped = (r) => r === "success" || r === "skipped";

/** Pure: { ok, problems } for a needs object ({ <job>: { result, outputs } }). */
export function verdict(needs, which) {
  const problems = [];
  const res = (j) => (needs[j] ? needs[j].result : "missing");
  const must = (j) => { if (!ok(res(j))) problems.push(`${j}=${res(j)} (must succeed)`); };
  const may = (j) => { if (!okOrSkipped(res(j))) problems.push(`${j}=${res(j)}`); };
  if (which === "linux") {
    for (const j of ["changes", "shard", "checks"]) must(j);
    may("timing-bars");
  } else if (which === "all") {
    for (const j of ["changes", "shard", "test"]) must(j);
    for (const j of Object.keys(needs)) if (!["changes", "shard", "test"].includes(j)) may(j);
  } else {
    problems.push(`unknown verdict "${which}"`);
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
