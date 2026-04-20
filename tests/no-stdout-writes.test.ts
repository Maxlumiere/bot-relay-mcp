// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, "..", "src");

/**
 * Walks src/ and returns every .ts file (excluding logger.ts which is allowed
 * to discuss the rule in its own comments).
 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("stdout discipline (stdio MCP safety)", () => {
  // v2.1 Phase 4h: the unified `relay` CLI is a separate entry point from
  // the stdio MCP server — its stdout is addressed at the terminal user, NOT
  // a JSON-RPC parser. src/cli/* + src/config.ts (stderr-only startup warn)
  // are allowlisted; everything else stays under the discipline so the stdio
  // MCP transport (src/transport/stdio.ts) can't be accidentally corrupted.
  const ALLOWED_PREFIXES = ["cli/", "config.ts"];
  function allowed(relPath: string): boolean {
    return ALLOWED_PREFIXES.some((p) => relPath === p || relPath.startsWith(p));
  }

  it("no console.log anywhere in src/", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      if (file.endsWith("logger.ts")) continue; // logger.ts mentions the rule in comments
      const content = fs.readFileSync(file, "utf-8");
      // Match console.log not in a comment line
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (/\bconsole\.log\b/.test(line)) {
          offenders.push(`${path.relative(SRC_DIR, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `console.log usage breaks stdio MCP. Use logger from src/logger.ts instead. Offenders:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no process.stdout.write anywhere in src/ except MCP transport internals (or CLI entries)", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      if (file.endsWith("logger.ts")) continue;
      const rel = path.relative(SRC_DIR, file);
      if (allowed(rel)) continue;
      // Transport files may legitimately write to stdout for the MCP protocol channel
      // but our own code shouldn't.
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (/\bprocess\.stdout\.write\b/.test(line)) {
          offenders.push(`${path.relative(SRC_DIR, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `process.stdout.write usage in user code breaks stdio MCP. Offenders:\n${offenders.join("\n")}`).toEqual([]);
  });
});
