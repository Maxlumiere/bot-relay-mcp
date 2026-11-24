#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Run a mutation fixture (tests/fixtures/*-mutants.json: [{name, file, find, replace, test}]): apply each mutant
 * ALONE to src/, rebuild dist (CLI rows run dist), run its test file, count the red rows, restore the file. Ends with
 * a clean rebuild. A mutant whose find text does not occur exactly once is an error (the fixture is stale).
 * REFUSES outside a linked git worktree: it rebuilds dist, and in the main checkout dist may be what a live relay
 * runs. Usage: node scripts/mutation-sweep.mjs <fixture.json> [name ...]
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const git = (...a) => execFileSync("git", a, { encoding: "utf-8" }).trim();
if (path.resolve(git("rev-parse", "--git-dir")) === path.resolve(git("rev-parse", "--git-common-dir"))) {
  console.error("mutation-sweep: refusing: run it in a linked worktree (it rebuilds dist)");
  process.exit(2);
}
// The dist it rebuilds must resolve INSIDE this worktree (a dist linked elsewhere would rebuild someone else's).
{
  const top = fs.realpathSync(git("rev-parse", "--show-toplevel"));
  const dist = fs.existsSync("dist") ? fs.realpathSync("dist") : path.join(fs.realpathSync("."), "dist");
  if (!(dist + path.sep).startsWith(top + path.sep)) {
    console.error("mutation-sweep: refusing: dist/ does not resolve inside this worktree");
    process.exit(2);
  }
}
const [fixture, ...only] = process.argv.slice(2);
if (!fixture) {
  console.error("usage: node scripts/mutation-sweep.mjs <fixture.json> [name ...]");
  process.exit(2);
}
const mutants = JSON.parse(fs.readFileSync(fixture, "utf-8")).filter((m) => only.length === 0 || only.includes(m.name));
const build = () => spawnSync("npm", ["run", "build"], { encoding: "utf-8" }).status === 0;
let survivors = 0;
for (const m of mutants) {
  const orig = fs.readFileSync(m.file, "utf-8");
  if (orig.split(m.find).length !== 2) throw new Error(`stale mutant ${m.name}: its find text does not occur exactly once in ${m.file}`);
  fs.writeFileSync(m.file, orig.replace(m.find, () => m.replace));
  try {
    if (!build()) {
      console.log(`${m.name}|BUILD-FAIL`);
      continue;
    }
    const r = spawnSync("npx", ["vitest", "run", m.test], { encoding: "utf-8" });
    // The fixture's own applicability row goes red under EVERY mutant (its find text is gone): never counted as a kill.
    const red = r.stdout.split("\n").filter((l) => l.trim().startsWith("×") && !l.includes("every mutant still applies")).length;
    if (red === 0) survivors++;
    console.log(`${m.name}|${red}`);
  } finally {
    fs.writeFileSync(m.file, orig);
  }
}
build();
console.log(`${mutants.length} mutant(s), ${survivors} survivor(s)`);
process.exit(survivors === 0 ? 0 : 1);
