#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

// CI guard: a vitest JSON report must hold EACH named row (a title substring) exactly once, with status "passed".
// A filter that matched nothing, a skip, or a renamed row fails, so a job cannot read green over a row it never ran.
// Usage: node tools/ci/require-rows-passed.mjs <report.json> "<title substring>" ["<title substring>" ...]
import fs from "fs";

const [report, ...names] = process.argv.slice(2);
if (!report || names.length === 0) {
  console.error("usage: require-rows-passed.mjs <report.json> <title substring>...");
  process.exit(2);
}
const rows = JSON.parse(fs.readFileSync(report, "utf-8")).testResults.flatMap((f) => f.assertionResults);
let bad = 0;
for (const n of names) {
  const hit = rows.filter((r) => r.fullName.includes(n));
  const ok = hit.length === 1 && hit[0].status === "passed";
  console.log(`${ok ? "PASSED" : "NOT PASSED"} | ${n} | ${hit.map((r) => r.status).join(",") || "no such row"}`);
  if (!ok) bad++;
}
if (bad > 0) {
  console.error(`${bad} of ${names.length} required rows did not pass`);
  process.exit(1);
}
