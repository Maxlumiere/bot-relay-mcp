#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * prebuild PRODUCTION-TREE GUARD (stopgap ahead of the release-topology cutover).
 *
 * THE HARM: on this machine the launchd daemon AND the entire stdio MCP fleet run
 * `<dev-tree>/dist/index.js` by absolute path (measured, 2026-07-28). So `npm run
 * build` in that tree OVERWRITES the `dist` the live daemon loads on its next
 * restart and that EVERY new stdio terminal loads immediately — a build here is a
 * live fleet deploy, with no separate step to forget. That cost a full day of a
 * stale daemon serving inert, already-merged security fixes.
 *
 * WHAT THIS DOES: runs as npm's `prebuild` (the exact chokepoint — it fires right
 * before `build`, i.e. before tsc writes `dist`). It REFUSES the build only when
 * THIS tree is the live-serving one, unless the operator opts in with
 * RELAY_ALLOW_PROD_BUILD=1.
 *
 * DIRECTION OF FAILURE — POSITIVE MATCH ONLY, FAIL TOWARD BUILD. It refuses solely
 * on a positive signal that this exact tree is production; any uncertainty (a file
 * it cannot read, no match) lets the build proceed. A dev tool that blocked builds
 * whenever it "wasn't sure" would be disabled by the first person it annoyed, and
 * then it would protect no one. The whole detector is wrapped so it can NEVER break
 * a legitimate build (CI checkouts, throwaway worktrees) — those don't match, so
 * they build freely. The narrow harm (one specific serving tree) is what a
 * positive-match guard catches with zero collateral.
 *
 * TWO SIGNALS (either → production):
 *   1. a gitignored marker file `.relay-prod-tree` in the tree root (placed by hand
 *      in the serving tree — explicit, reliable, machine-local, never committed).
 *   2. auto-detect: a loaded launchd plist or `~/.claude.json` mcpServers entry
 *      whose path points at THIS tree's dist/index.js (covers an unmarked tree).
 *
 * NOT shipped to npm users: `scripts/` is excluded from package.json `files`, and a
 * consumer never runs `npm run build` (dist ships prebuilt). This is a repo/dev
 * guard only. The decision is a pure function so the harm/allow cases are tested
 * without touching launchd or the real config.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

/** Does `text` (a plist / claude.json body) reference THIS tree's dist entrypoint?
 *  Tolerant of the `%20` percent-encoded fossil form a spaced path can take. */
export function treePointsHere(text, cwd) {
  if (!text || !cwd) return false;
  const entry = path.join(cwd.replace(/\/+$/, ""), "dist", "index.js");
  return text.includes(entry) || text.includes(encodeURI(entry));
}

/**
 * Pure decision. `consumers` is a list of { label, text } (plist / config bodies).
 * Returns { action: "build" | "build-allowed" | "refuse", hits: string[] }.
 *   - "build"          — no positive production signal; proceed.
 *   - "refuse"         — this tree is production and no opt-in; block (exit 1).
 *   - "build-allowed"  — production, but RELAY_ALLOW_PROD_BUILD=1; proceed loudly.
 */
export function decideProdBuild({ cwd, hasSentinel, consumers = [], allow }) {
  const hits = [];
  if (hasSentinel) hits.push("marker file .relay-prod-tree");
  for (const c of consumers) {
    if (treePointsHere(c.text, cwd)) hits.push(c.label);
  }
  if (hits.length === 0) return { action: "build", hits };
  return { action: allow ? "build-allowed" : "refuse", hits };
}

// ── real-IO gathering (all defensive: any failure → treated as "no signal") ──────

function safeRealpath(p) { try { return fs.realpathSync(p); } catch { return p; } }
function safeRead(p) { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }
function safeReaddir(d) { try { return fs.readdirSync(d); } catch { return []; } }

function gatherConsumers(home) {
  const consumers = [];
  const laDir = path.join(home, "Library", "LaunchAgents");
  for (const f of safeReaddir(laDir)) {
    if (!f.endsWith(".plist")) continue;
    const text = safeRead(path.join(laDir, f));
    if (text) consumers.push({ label: `launchd plist ${f}`, text });
  }
  const cj = safeRead(path.join(home, ".claude.json"));
  if (cj) consumers.push({ label: "~/.claude.json mcpServers.bot-relay", text: cj });
  return consumers;
}

function main() {
  let decision;
  try {
    const cwd = safeRealpath(process.cwd());
    const home = os.homedir();
    decision = decideProdBuild({
      cwd,
      hasSentinel: fs.existsSync(path.join(cwd, ".relay-prod-tree")),
      consumers: gatherConsumers(home),
      allow: process.env.RELAY_ALLOW_PROD_BUILD === "1",
    });
  } catch (err) {
    // The guard itself must NEVER break a build. Any unexpected failure → build.
    process.stderr.write(`prebuild-guard: detector error (${err instanceof Error ? err.message : String(err)}) — allowing build.\n`);
    process.exit(0);
  }

  if (decision.action === "build") process.exit(0);

  if (decision.action === "build-allowed") {
    process.stderr.write(
      `⚠ prebuild-guard: this is the PRODUCTION relay tree (${decision.hits.join("; ")}), ` +
        `but RELAY_ALLOW_PROD_BUILD=1 — proceeding with an INTENTIONAL production build (a live fleet deploy).\n`,
    );
    process.exit(0);
  }

  // refuse
  process.stderr.write(
    `\n[1;31m✖ REFUSING to build in the PRODUCTION relay tree.[0m\n` +
      `  Positive signal: ${decision.hits.join("; ")}.\n` +
      `  Building here overwrites dist/, which the live launchd daemon (on its next restart)\n` +
      `  and EVERY new stdio MCP terminal load — so a build here is a live fleet deploy.\n\n` +
      `  If you TRULY intend to deploy from this tree, re-run with:\n` +
      `      RELAY_ALLOW_PROD_BUILD=1 npm run build\n` +
      `  Prefer: build in a throwaway git worktree, never the serving tree.\n\n`,
  );
  process.exit(1);
}

// Only run main() when invoked directly (not when imported by the test). Use
// fileURLToPath, NOT `new URL(...).pathname` — the latter percent-encodes a spaced
// path (the `%20` fossil) so the compare would fail on `…/Claude AI/…` and the
// guard would silently no-op in the exact tree it must protect.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
