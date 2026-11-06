#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The secrets gate's audited gitleaks config: upstream's default config (pinned by commit AND SHA-256), with ONE
 * change, its global path allowlist. Upstream skips every file matching paths like `package-lock.json`, `*.svg`,
 * `node_modules/` or `gitleaks.toml` before any rule runs, so a credential in a lockfile URL or an SVG comment would
 * pass while the canaries stay green. `[extend] useDefault` cannot narrow that: an extended config INHERITS the
 * default's global allowlists (upstream config/config.go, `c.Allowlists = append(c.Allowlists, ...)`).
 *
 * Kept from upstream, unchanged: all 222 rules with their per-rule allowlists, and the global VALUE filters (regexes
 * such as `true|false|null` or `${{ secrets.X }}` templates, and the stopwords): they judge a candidate secret, not a
 * whole file.
 *
 *   node scripts/ci-gitleaks-config.mjs <upstream gitleaks.toml> <out.toml>
 *   node scripts/ci-gitleaks-config.mjs --url        the pinned upstream URL (by commit)
 * Refuses (exit 1) when the upstream file's SHA-256 is not the pinned one, or its shape is not the one this edits.
 */
import fs from "fs";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

export const UPSTREAM = {
  version: "8.30.1",
  commit: "83d9cd684c87d95d656c1458ef04895a7f1cbd8e",
  // MEASURED 5 Nov 2026: the same bytes by tag and by commit.
  sha256: "e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf",
};
export const UPSTREAM_URL = `https://raw.githubusercontent.com/gitleaks/gitleaks/${UPSTREAM.commit}/config/gitleaks.toml`;

/**
 * The files the gate may skip whole. EMPTY: this repo has never tracked an image, a font or an office file (every
 * path in its history, MEASURED 5 Nov 2026), and its two binary fixtures scan clean as text. Any entry needs a
 * reason and a measured false positive.
 */
export const ALLOWED_PATHS = [];

/** Upstream's text with the global `[allowlist]` paths replaced by `paths`. Throws on any shape it does not know. */
export function narrowConfig(text, paths) {
  const globals = [...text.matchAll(/^\[allowlist\]$|^\[\[allowlists\]\]$/gm)];
  if (globals.length !== 1 || globals[0][0] !== "[allowlist]") throw new Error(`expected exactly one global [allowlist] section, found ${globals.length}`);
  const start = globals[0].index;
  const end = text.indexOf("\n[[rules]]", start);
  if (end < 0) throw new Error("no [[rules]] after the global [allowlist]");
  const block = text.slice(start, end);
  const arrays = [...block.matchAll(/^paths = \[\n[\s\S]*?^\]$/gm)];
  if (arrays.length !== 1) throw new Error(`expected one paths array in the global [allowlist], found ${arrays.length}`);
  const body = paths.map((p) => `    '''${p}''',\n`).join("");
  const narrowed = block.replace(arrays[0][0], `paths = [\n${body}]`);
  return text.slice(0, start) + narrowed + text.slice(end);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [src, out] = process.argv.slice(2);
  if (src === "--url") { console.log(UPSTREAM_URL); process.exit(0); }
  if (!src || !out) { console.error("usage: ci-gitleaks-config.mjs <upstream gitleaks.toml> <out.toml>"); process.exit(2); }
  const bytes = fs.readFileSync(src);
  const got = crypto.createHash("sha256").update(bytes).digest("hex");
  if (got !== UPSTREAM.sha256) { console.error(`REFUSED: upstream gitleaks.toml has SHA-256 ${got}, pinned ${UPSTREAM.sha256}`); process.exit(1); }
  fs.writeFileSync(out, narrowConfig(bytes.toString("utf8"), ALLOWED_PATHS));
  console.log(`gitleaks config: upstream ${UPSTREAM.version} (${UPSTREAM.commit.slice(0, 7)}), global path allowlist narrowed to ${ALLOWED_PATHS.length} entr${ALLOWED_PATHS.length === 1 ? "y" : "ies"}`);
}
