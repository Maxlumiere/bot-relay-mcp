// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.3 R1 HIGH 1 regression guard.
 *
 * Codex caught that v2.4.3 R0 wired the audit-with-retry wrapper into
 * scripts/pre-publish-check.sh but left `.github/workflows/ci.yml`
 * calling raw `npm audit --audit-level=high`. Same class of registry-
 * endpoint flake (the v2.4.0 main 400 Bad Request) could still take
 * the public CI badge red. This test fails CI loudly if any
 * .github/workflows/*.yml file contains a raw `npm audit` invocation
 * not routed through scripts/audit-with-retry.sh.
 *
 * Pattern matches the existing drift-grep guards in
 * scripts/pre-publish-check.sh: cheap regex sweep, narrow allowlist
 * (only the wrapper's own filename, plus comment lines), fail loudly
 * if anything new appears.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const WORKFLOWS_DIR = path.join(PROJECT_ROOT, ".github", "workflows");

function listYamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => path.join(dir, f));
}

describe("v2.4.3 R1 — CI audit bypass guard", () => {
  it("(G1) every `npm audit` invocation in .github/workflows/* is routed through audit-with-retry.sh", () => {
    const files = listYamlFiles(WORKFLOWS_DIR);
    expect(files.length).toBeGreaterThan(0);

    const violations: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        // Strip trailing YAML comments + leading whitespace + the optional
        // list-item dash so step-name lines (`- name: …`) don't trip the
        // metadata allowlist below.
        const stripped = line
          .replace(/#.*$/, "")
          .replace(/^\s*-\s*/, "")
          .trim();
        if (!stripped) return;

        // We only flag actual shell invocations, not YAML metadata (step
        // `name:` fields, `description:` strings, etc.). The literal token
        // `npm audit` appearing in a name field is documentation, not a
        // command. The narrow signal we care about is `run:` blocks
        // executing the command — those present `npm audit` as a bare
        // command without a leading `name:` / `description:` / `id:` key.
        if (/^(name|description|id|key|env|with|uses):/.test(stripped)) return;

        if (!/\bnpm\s+audit\b/.test(stripped)) return;

        // The only sanctioned shape is `bash scripts/audit-with-retry.sh
        // <level>` which does NOT contain the literal `npm audit` token.
        // So any line that reaches here is a raw `npm audit` invocation
        // and must be flagged.
        violations.push({ file: path.relative(PROJECT_ROOT, file), line: idx + 1, text: stripped });
      });
    }

    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  ${v.file}:${v.line}: ${v.text}`)
        .join("\n");
      throw new Error(
        `Raw \`npm audit\` invocations found in workflow files. Route them through ` +
          `\`bash scripts/audit-with-retry.sh <level>\` so registry-side flakes don't ` +
          `take the public CI badge red.\n\nViolations:\n${detail}`,
      );
    }
  });

  it("(G2) the wrapper itself exists and is executable", () => {
    const wrapper = path.join(PROJECT_ROOT, "scripts", "audit-with-retry.sh");
    expect(fs.existsSync(wrapper)).toBe(true);
    const stat = fs.statSync(wrapper);
    // Owner-execute bit set. Same shape check the pre-publish gate uses
    // for bin/relay + bin/spawn-agent.sh.
    expect((stat.mode & 0o100) !== 0).toBe(true);
  });
});
