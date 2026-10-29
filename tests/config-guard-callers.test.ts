// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A STALE-PREMISE LINK. The test-harness write guard (src/cli/config-merge.ts assertNotRealUserConfigWrite) reads its
 * verdict through isProtected, so "inconclusive" is refused: with a protected config MISSING, ANY guarded write whose
 * nearest existing directory is shared with it is refused, a sibling or another name included (the loud, safe
 * direction, accepted because every guarded writer today writes a PROTECTED name: ~/.claude.json, settings.json, the
 * relay config). That premise holds only while the guarded writers stay these. This pins them: atomicWriteJson is
 * called from exactly 3 sites, all in src/cli/init.ts, and is never passed on as a value. A new caller fails here
 * until the guard's scope is reviewed for it (see the #343 PR body, "the guard's stated over-block").
 */
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { srcProgram, pinnedReferences } from "./_helpers/ts-binding.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREMISE =
  "the protect-list over-blocks: with a protected config missing, any guarded write sharing its nearest existing directory " +
  "is refused (a sibling, another name). Review the guard's scope (the #343 PR body) before adding a caller of atomicWriteJson";

describe("the guarded writer's callers are exactly the ones the guard's scope was reviewed for", () => {
  // A precautionary 45 s budget aligned with #371; this test has no observed 15 s timeout (measured 2.1-7.2 s). It builds the
  // whole src/ TypeScript program (srcProgram()), the same work as tests/sec-22-system-binaries.test.ts:159, which timed
  // out at the 15 s default in a slow macOS-runner window. macOS CI, 28-29 Oct (42 test jobs, the reporter's per-file ms;
  // this file is this one test): 2,100-5,175 ms normally, 5,275 / 7,183 ms in that window (jobs 122799086386,
  // 122803027574), in which sec-22:159 took 20,303 / 18,498 ms. Investigate sustained increases from the measured
  // baseline even below this timeout.
  const SRC_PROGRAM_SCAN_BUDGET_MS = 45_000;
  it("atomicWriteJson: 3 calls, all in src/cli/init.ts, and no other use", () => {
    const rel = (f: string) => path.relative(REPO, f).split(path.sep).join("/");
    const refs = pinnedReferences(srcProgram(), rel, ["src/cli/config-merge.ts:atomicWriteJson"]);
    const calls = refs.filter((r) => r.how === "call");
    const others = refs.filter((r) => r.how !== "call");
    expect(others.map((r) => `${r.site} (${r.how})`), PREMISE).toEqual([]);
    expect(calls.every((r) => r.site.startsWith("src/cli/init.ts:")), `${PREMISE}: ${calls.map((r) => r.site).join(", ")}`).toBe(true);
    expect(calls.length, PREMISE).toBe(3);
  }, SRC_PROGRAM_SCAN_BUDGET_MS);
});
