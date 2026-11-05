#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The pure parts of the CI lint gate (tools/lint/lint-changed.mjs): the scope, the diff parser, the added-line
 * filter and the canary markers. Kept apart from the gate, which loads the pinned ESLint with a computed import, so
 * a test can reach these without reaching that import (tests/v2-25-1-guard-test-parser-pin-gate.test.ts).
 */
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The files the gate lints: the root package's TypeScript and the scripts. Fixtures may hold bad code on purpose. */
export function inLintScope(file) {
  if (/^tests\/fixtures\//.test(file)) return false;
  return /^src\/.+\.(ts|mts)$/.test(file) || /^tests\/.+\.(ts|mts)$/.test(file) || /^scripts\/.+\.mjs$/.test(file);
}

/** Lines ADDED per file, from `git diff --unified=0` text: Map<file, Set<line>>. */
export function parseAddedLines(diff) {
  const out = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    const f = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (f) { file = f[1] === "/dev/null" ? null : f[1]; continue; }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && file) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      if (!out.has(file)) out.set(file, new Set());
      for (let i = 0; i < count; i++) out.get(file).add(start + i);
    }
  }
  return out;
}

/**
 * ESLint results kept to the added lines. A message with NO rule (a parse error, or "File ignored ...") means the
 * file was not checked: it is kept wherever it is, as "not-linted", so the gate cannot pass on an unlinted file.
 */
export function onAddedLines(results, added, rel = (p) => path.relative(ROOT, p).split(path.sep).join("/")) {
  const kept = [];
  for (const r of results) {
    const file = rel(r.filePath);
    const lines = added.get(file) ?? new Set();
    for (const m of r.messages) {
      if (m.ruleId === null || m.ruleId === undefined) kept.push({ file, line: m.line ?? 1, rule: "not-linted", message: m.message });
      else if (lines.has(m.line)) kept.push({ file, line: m.line, rule: m.ruleId, message: m.message });
    }
  }
  return kept;
}

/** `// expect: <rule>` markers in canary sources: [{ file, line, rule }]. */
export function canaryExpectations(file, text) {
  const out = [];
  text.split("\n").forEach((l, i) => {
    const m = l.match(/\/\/ expect: (\S+)/);
    if (m) out.push({ file, line: i + 1, rule: m[1] });
  });
  return out;
}
