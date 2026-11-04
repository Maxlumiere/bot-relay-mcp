#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ci.yml's scope job: what this run must cover. Prints `docs_only=<bool>` and `full=<bool>` (GITHUB_OUTPUT
 * lines).
 *   docs_only  a PULL REQUEST whose every changed file is Markdown or under docs/ (base...head). Never on a push,
 *              the nightly or a dispatch: main always runs the full scope. Unknown (a git error) is NOT docs-only.
 *   full       run the macOS, Windows and timing-bars jobs. False for a DRAFT pull request without the
 *              `ci-full` label, and for a docs-only change. Always true on a push to main, the nightly and a
 *              manual dispatch.
 * Fails SAFE: any doubt means docs_only=false and full=true.
 * Inputs (env): EVENT, PR_BASE, PR_HEAD, DRAFT ("true"/"false"), CI_FULL ("true"/"false").
 */
import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

export const isDocPath = (f) => /\.md$/i.test(f) || f.startsWith("docs/");

/** Pure: the scope for an event and its changed files (null = unknown). */
export function scope({ event, draft, ciFull, changed }) {
  const docsOnly = event === "pull_request" && Array.isArray(changed) && changed.length > 0 && changed.every(isDocPath);
  let full = true;
  if (event === "pull_request" && draft && !ciFull) full = false;
  if (docsOnly) full = false;
  return { docsOnly, full };
}

function changedFiles(env) {
  const sha = (s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s) && !/^0+$/.test(s);
  let range = null;
  if (env.EVENT === "pull_request" && sha(env.PR_BASE) && sha(env.PR_HEAD)) range = `${env.PR_BASE}...${env.PR_HEAD}`;
  if (range === null) return null;
  try {
    return execFileSync("git", ["diff", "--name-only", range], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const changed = changedFiles(env);
  const s = scope({ event: env.EVENT, draft: env.DRAFT === "true", ciFull: env.CI_FULL === "true", changed });
  process.stderr.write(`scope: event=${env.EVENT} draft=${env.DRAFT} ci-full=${env.CI_FULL} changed=${changed === null ? "unknown" : changed.length} -> docs_only=${s.docsOnly} full=${s.full}\n`);
  process.stdout.write(`docs_only=${s.docsOnly}\nfull=${s.full}\n`);
}
