#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SHIPPED-CONTENT GUARD — the npm tarball must not carry internal personas,
 * codenames, or the maintainer's name/home path.
 *
 * WHY it inspects the PACKED TARBALL, not the source tree: a source-tree scan
 * reports clean while the shipped artifact still carries the strings — that is
 * exactly how internal names lived in compiled `dist/*.js` (tsc keeps comments)
 * for three weeks while `src/` "looked" scrubbed. This packs the package,
 * EXTRACTS it, and scans what actually ships. Verify the deployment, not the
 * working tree.
 *
 * WHY it is a distinct category from the secret-value guard: the existing
 * pre-publish gate asks "is it broken?" (tsc/build/tests/audit/smoke) and the
 * secret-register guard asks "does it leak a token?". Neither asks "what does
 * this say ABOUT US?". Names/personas/internal-process are that third category,
 * and a guard built to the shape of the last incident (tokens) never covered it.
 *
 * Pattern list: scripts/forbidden-shipped-strings.txt — one regex per line,
 * adding a future persona is one line, not a code change.
 *
 * Exports scanDir / scanPackedTarball / loadPatterns for the both-ways control
 * test (tests/shipped-surface-persona-free.test.ts).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PATTERN_FILE = path.join(HERE, "forbidden-shipped-strings.txt");
const NUL = String.fromCharCode(0);

/** Parse the pattern file into compiled regexes. */
export function loadPatterns(file = PATTERN_FILE) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((src) => ({ src, re: new RegExp(src) }));
}

/** Scan an extracted package directory. Returns [{file,line,pattern,text}]. */
export function scanDir(dir, patterns) {
  const offenders = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(abs).sort()) walk(rel ? path.join(rel, e) : e);
      return;
    }
    let content;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      return;
    }
    if (content.includes(NUL)) return; // binary
    content.split("\n").forEach((line, i) => {
      for (const p of patterns) {
        if (p.re.test(line)) {
          offenders.push({ file: rel, line: i + 1, pattern: p.src, text: line.trim().slice(0, 100) });
        }
      }
    });
  };
  walk("");
  return offenders;
}

/** `npm pack` the package at `cwd`, extract, scan. Returns offenders[]. */
export function scanPackedTarball(cwd, patterns) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipscan-"));
  try {
    const packed = execFileSync("npm", ["pack", "--silent"], { cwd, encoding: "utf8" }).trim();
    const tb = packed.split("\n").filter(Boolean).pop();
    const tbPath = path.join(cwd, tb);
    execFileSync("tar", ["xzf", tbPath, "-C", tmp]);
    fs.rmSync(tbPath, { force: true });
    return scanDir(path.join(tmp, "package"), patterns);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── CLI (used by the pre-publish gate) ────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const ROOT = path.resolve(HERE, "..");
  const patterns = loadPatterns();
  const offenders = scanPackedTarball(ROOT, patterns);
  if (offenders.length > 0) {
    process.stderr.write(`\n✗ shipped-content guard: ${offenders.length} forbidden reference(s) in the npm tarball:\n`);
    for (const o of offenders) {
      process.stderr.write(`  ${o.file}:${o.line}  matches /${o.pattern}/  — ${o.text}\n`);
    }
    process.stderr.write(
      `\nThese must not ship. dist personas come from src comments (tsconfig removeComments strips them); ` +
        `docs/bin/CHANGELOG are scrubbed directly; internal docs are excluded via package.json files[]. ` +
        `Pattern list: scripts/forbidden-shipped-strings.txt.\n\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`✓ shipped-content guard: npm tarball clean of ${patterns.length} forbidden patterns.\n`);
}
