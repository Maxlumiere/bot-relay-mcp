// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #48 — override inventory completeness guard.
 *
 * SECURITY.md claims its "Dependency overrides — rationale & retirement" table is
 * the COMPLETE inventory of every npm `override` (why an npm override matters:
 * it silently defeats Dependabot's security auto-fix for that package — see the
 * section). A hand-maintained completeness claim drifts silently the moment
 * someone adds override #14 — the exact class of the README masthead version that
 * went stale until a human spotted it, and the class codex caught in this very
 * table (born 4-of-13). So the claim is machine-enforced here: this test reds CI
 * if the set of override *names* across package.json + extensions/vscode/
 * package.json and the set documented in the table ever diverge.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

function overrideNames(manifestRelPath: string): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, manifestRelPath), "utf8"));
  return Object.keys(pkg.overrides ?? {});
}

/** Names documented in the SECURITY.md override table (first column, package name
 *  = the token before the version/reference inside the backticks). Scoped to the
 *  override-rationale section so unrelated tables can't satisfy it. */
function documentedNames(): string[] {
  const md = fs.readFileSync(path.join(REPO_ROOT, "SECURITY.md"), "utf8");
  const start = md.indexOf("Dependency `overrides` — rationale & retirement");
  expect(start, "override-rationale section not found in SECURITY.md").toBeGreaterThan(-1);
  const section = md.slice(start, md.indexOf("\n## ", start) === -1 ? undefined : md.indexOf("\n## ", start));
  const names: string[] = [];
  for (const line of section.split("\n")) {
    // A table data row whose first cell is `<name> <version-or-ref>`.
    const m = line.match(/^\|\s*`([^`]+)`\s*\|/);
    if (m) names.push(m[1].trim().split(/\s+/)[0]);
  }
  return names;
}

describe("#48 override inventory — SECURITY.md table matches the manifests exactly", () => {
  it("every npm override is documented, and every documented row is a real override", () => {
    const manifestSet = new Set([
      ...overrideNames("package.json"),
      ...overrideNames("extensions/vscode/package.json"),
    ]);
    const tableSet = new Set(documentedNames());

    const undocumented = [...manifestSet].filter((n) => !tableSet.has(n)).sort();
    const stale = [...tableSet].filter((n) => !manifestSet.has(n)).sort();

    expect(
      undocumented,
      `overrides present in a manifest but MISSING from the SECURITY.md table: ${undocumented.join(", ")} ` +
        `— add a row (why + retire condition), do not narrow the policy.`,
    ).toEqual([]);
    expect(
      stale,
      `rows in the SECURITY.md table with NO matching override in any manifest: ${stale.join(", ")} ` +
        `— remove the stale row (or restore the override).`,
    ).toEqual([]);

    // Sanity: the inventory is non-empty (guards against a parse that silently matches two empty sets).
    expect(tableSet.size).toBeGreaterThan(0);
  });
});
