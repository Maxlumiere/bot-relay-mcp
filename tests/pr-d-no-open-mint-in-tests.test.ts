// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR-D (architect fd2f6b9f Q-D), BY CONSTRUCTION: the suite exercises the REAL registration gate. No test,
 * harness, setup or config file may set RELAY_ALLOW_OPEN_MINT (the development escape hatch), or the suite's
 * default path would quietly become the open one. The only exceptions are the tests OF the flag itself,
 * each named with its reason (the HASH_EXCEPTIONS pattern). Tests send the secret with tests/_helpers/mint.ts.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPEN_MINT_EXCEPTIONS: Record<string, string> = {
  "tests/pr-d-mint-gate.test.ts": "tests OF the flag: open-dev on loopback, and the refusal on a non-loopback bind",
  "tests/pr-d-no-open-mint-in-tests.test.ts": "this guard names the variable it forbids",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe("no test or harness opens the registration gate (Q-D)", () => {
  it("RELAY_ALLOW_OPEN_MINT appears only in the named exceptions", () => {
    const files = [
      ...walk(path.join(REPO, "tests")),
      ...fs.readdirSync(REPO).filter((f) => /^vitest.*\.config\./.test(f)).map((f) => path.join(REPO, f)),
      ...[".github/workflows"].flatMap((d) => (fs.existsSync(path.join(REPO, d)) ? walk(path.join(REPO, d)) : [])),
    ];
    const hits = files
      .filter((f) => fs.readFileSync(f, "utf-8").includes("RELAY_ALLOW_OPEN_MINT"))
      .map((f) => path.relative(REPO, f).split(path.sep).join("/"));
    expect(hits.length, "the scan saw the exceptions themselves (it reads the files)").toBeGreaterThanOrEqual(1);
    expect(hits.filter((h) => !(h in OPEN_MINT_EXCEPTIONS)), "files setting the open-mint flag outside the named exceptions").toEqual([]);
  });

  it("every named exception still exists and still mentions the flag (no stale allowlist)", () => {
    for (const f of Object.keys(OPEN_MINT_EXCEPTIONS)) {
      expect(fs.readFileSync(path.join(REPO, f), "utf-8"), f).toContain("RELAY_ALLOW_OPEN_MINT");
    }
  });
});
