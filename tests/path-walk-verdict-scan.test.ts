// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A path-walk verdict is read ONLY through isProtected(...) or isTrustedMatch(...) (ruled on #357 R2): a
 * caller that wrote `comparePaths(a, b) === "same"` would silently treat "inconclusive" as "not the same" (a write
 * guard then lets a protected config through), and `if (comparePaths(a, b))` is always true. The static scan
 * (tests/_helpers/verdict-sites.ts, the pinned parser) fails on any other use in src/ outside src/path-walk.ts.
 * Virtual fixtures prove it catches each form, planted, and passes the sanctioned shape.
 */
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { srcProgram, virtualProgram } from "./_helpers/ts-binding.js";
import { verdictSites } from "./_helpers/verdict-sites.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("a path-walk verdict is read only through isProtected / isTrustedMatch", () => {
  it("src/ (outside path-walk.ts) has no other use of comparePaths", () => {
    const rel = (f: string) => path.relative(REPO, f).split(path.sep).join("/");
    const sites = verdictSites(srcProgram(), rel, (f) => f.startsWith("src/") && f !== "src/path-walk.ts");
    expect(sites.filter((s) => !s.ok).map((s) => `${s.site} (${s.why})`)).toEqual([]);
  });

  const fixtures: Record<string, string> = {
    "src/path-walk.ts":
      'export type Comparison = "same" | "different" | "inconclusive"; export function comparePaths(a: string, b: string): Comparison { return a === b ? "same" : "inconclusive"; } export function isProtected(r: Comparison) { return r !== "different"; } export function isTrustedMatch(r: Comparison) { return r === "same"; }',
    "src/ok-protected.ts": 'import { comparePaths, isProtected } from "./path-walk.js"; export const f = (a: string, b: string) => isProtected(comparePaths(a, b));',
    "src/ok-trusted.ts": 'import { comparePaths, isTrustedMatch } from "./path-walk.js"; export const f = (a: string, b: string) => isTrustedMatch(comparePaths(a, b));',
    "src/ok-namespace.ts": 'import * as pw from "./path-walk.js"; export const f = (a: string, b: string) => pw.isProtected(pw.comparePaths(a, b));',
    "src/bad-eq.ts": 'import { comparePaths } from "./path-walk.js"; export const f = (a: string, b: string) => comparePaths(a, b) === "same";',
    "src/bad-truthy.ts": 'import { comparePaths } from "./path-walk.js"; export function f(a: string, b: string) { if (comparePaths(a, b)) return 1; return 0; }',
    "src/bad-stored.ts": 'import { comparePaths, isProtected } from "./path-walk.js"; export function f(a: string, b: string) { const r = comparePaths(a, b); return isProtected(r); }',
    "src/bad-alias.ts": 'import { comparePaths as cp } from "./path-walk.js"; export const f = (a: string, b: string) => cp(a, b) !== "different";',
    "src/bad-namespace.ts": 'import * as pw from "./path-walk.js"; export const f = (a: string, b: string) => pw.comparePaths(a, b) === "same";',
    "src/bad-element.ts": 'import * as pw from "./path-walk.js"; export const f = (a: string, b: string) => (pw as any)["comparePaths"](a, b);',
    "src/bad-value.ts": 'import { comparePaths } from "./path-walk.js"; export const g = [comparePaths];',
    "src/bad-reexport.ts": 'export { comparePaths } from "./path-walk.js";',
    "src/bad-switch.ts": 'import { comparePaths } from "./path-walk.js"; export function f(a: string, b: string) { switch (comparePaths(a, b)) { case "same": return 1; default: return 0; } }',
  };
  const virtualRel = (f: string) => f.replace(/\\/g, "/").replace(/^(?:[A-Za-z]:)?\/virtual\//, "");
  let cached: ReturnType<typeof verdictSites> | undefined;
  const sites = () => (cached ??= verdictSites(virtualProgram(fixtures), virtualRel, (f) => f.startsWith("src/") && f !== "src/path-walk.ts"));
  const of = (file: string) => sites().filter((s) => s.site.startsWith(`src/${file}:`));

  it.each(["bad-eq.ts", "bad-truthy.ts", "bad-stored.ts", "bad-alias.ts", "bad-namespace.ts", "bad-element.ts", "bad-value.ts", "bad-reexport.ts", "bad-switch.ts"])(
    "CAUGHT (planted): %s",
    (f) => expect(of(f).some((s) => !s.ok), JSON.stringify(of(f))).toBe(true),
  );
  it.each(["ok-protected.ts", "ok-trusted.ts", "ok-namespace.ts"])("PASSED (the sanctioned shape): %s", (f) => {
    expect(of(f).length, "the scan saw the call").toBeGreaterThan(0);
    expect(of(f).every((s) => s.ok)).toBe(true);
  });
});
