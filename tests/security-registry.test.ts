// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The security invariant registry (security/invariants.json) is checked, not trusted. A security rule with no test is
 * not a rule (the release security gate, R1):
 *   - an ACTIVE invariant names at least one test, and every test id it names RESOLVES (vitest's own `list --json`,
 *     never a regex over source);
 *   - every release test (tests/release/*.release.ts) belongs to an invariant: no orphan that the gate never reports;
 *   - an active invariant with no test against the INSTALLED package carries a waiver { reason, ruling_id,
 *     revisit_when } (ruled 13 Oct), and the gate prints every waiver on every run;
 *   - a PENDING invariant names its reason, owner and what blocks it;
 *   - the KNOWN-BAD control (security/known-bad.json) pins an integrity, and each must_fail entry is the exact title
 *     of ONE registry HARM test.
 * The rules live in ONE module (scripts/release-registry.mjs), which the gate runner also runs as its mandatory first
 * step, so the two cannot drift. Here: each check on the real registry, and a fixture per rule that must be CAUGHT.
 * (Whether every security RULING names an invariant is a fleet-governance check, run outside this public repo.)
 */
import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { CHECKS, collectPools, loadRegistry, validateRegistry } from "../scripts/release-registry.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // never URL.pathname: it keeps %20

type Pools = { releaseTests: Set<string>; inProcessTests: Set<string> };
type Fault = { check: string; msg: string };
const { invariants, knownBad } = loadRegistry(REPO);
let pools: Pools;
beforeAll(() => {
  pools = collectPools(REPO, invariants);
}, 120_000);

describe("the security invariant registry (the real one)", () => {
  for (const check of CHECKS) {
    it(`check ${check}: no fault`, () => {
      const faults = (validateRegistry(invariants, knownBad, pools) as Fault[]).filter((f) => f.check === check).map((f) => f.msg);
      expect(faults).toEqual([]);
    });
  }
});

describe("each registry rule CATCHES its violation (a fixture per rule, on a copy of the real registry)", () => {
  const copy = () => JSON.parse(JSON.stringify(invariants)) as Array<Record<string, any>>;
  const faultsOf = (inv: unknown, kb: unknown = knownBad) => (validateRegistry(inv, kb, pools) as Fault[]).map((f) => `${f.check}: ${f.msg}`);
  const byId = (inv: Array<Record<string, any>>, id: string) => inv.find((i) => i.id === id)!;

  it("TWIN the real registry, copied unchanged, has no fault", () => {
    expect(faultsOf(copy())).toEqual([]);
  });
  it("CAUGHT an unknown status (it never reads as pending)", () => {
    const inv = copy();
    byId(inv, "SEC-11").status = "activ";
    expect(faultsOf(inv)).toContain('shape: SEC-11: unknown status "activ" (one of active, pending)');
  });
  it("CAUGHT an unknown test mode", () => {
    const inv = copy();
    byId(inv, "SEC-11").tests[0].mode = "installd";
    expect(faultsOf(inv).some((f) => f.startsWith('shape: SEC-11: unknown test mode "installd"'))).toBe(true);
  });
  it("CAUGHT an active invariant whose LAST test was removed", () => {
    const inv = copy();
    byId(inv, "SEC-11").tests = [];
    expect(faultsOf(inv)).toContain("active-coverage: SEC-11: active with no test");
  });
  it("CAUGHT a test id that resolves to no collected test", () => {
    const inv = copy();
    byId(inv, "SEC-11").tests[0].id += " (renamed)";
    expect(faultsOf(inv).some((f) => f.startsWith("active-coverage: SEC-11: installed test"))).toBe(true);
  });
  it("CAUGHT a release test that belongs to no invariant (an orphan)", () => {
    const inv = copy().filter((i) => i.id !== "SEC-11");
    expect(faultsOf(inv).some((f) => f.startsWith("orphans: release test tests/release/sec-11.release.ts::"))).toBe(true);
  });
  it("CAUGHT an active invariant with only in-process tests and NO waiver (it would print WAIVED)", () => {
    const inv = copy();
    const s22 = byId(inv, "SEC-22");
    s22.tests = s22.tests.filter((t: { mode: string }) => t.mode === "in-process");
    const faults = faultsOf(inv).filter((f) => !f.startsWith("orphans:")); // SEC-22's installed tests are now orphans too
    expect(faults).toContain("waivers: SEC-22: only in-process tests and no waiver");
  });
  it("CAUGHT a test title vitest cannot resolve statically, with the fix named (a template or an it.each title)", () => {
    // Pure: a collected release title that kept its `${...}` (what `vitest list` printed for a loop, 20 Oct), and a
    // registry id written with an it.each `%s`.
    const tmpl = "tests/release/x.release.ts::SEC-20.T2 HARM ${v.what} does not bring a REVOKED agent back";
    const fake = { releaseTests: new Set([...pools.releaseTests, tmpl]), inProcessTests: pools.inProcessTests };
    const inv = copy();
    byId(inv, "SEC-11").tests.push({ id: "tests/release/sec-11.release.ts::SEC-11.T2 %s", mode: "installed" });
    const faults = (validateRegistry(inv, knownBad, fake) as Fault[]).map((f) => `${f.check}: ${f.msg}`);
    const hint = "title not statically resolvable: use a literal title";
    expect(faults.filter((f) => f.startsWith(`orphans: release test ${tmpl}: ${hint}`))).toHaveLength(1);
    expect(faults.filter((f) => f.startsWith(`active-coverage: SEC-11: installed test tests/release/sec-11.release.ts::SEC-11.T2 %s: ${hint}`))).toHaveLength(1);
  });
  it("CAUGHT an incomplete waiver", () => {
    const inv = copy();
    byId(inv, "SEC-11").waiver = { reason: "r", ruling_id: "", revisit_when: "w" };
    expect(faultsOf(inv)).toContain("waivers: SEC-11: waiver.ruling_id missing");
  });
  it("CAUGHT a pending invariant with no owner, and a not_yet gap on an os it claims", () => {
    const inv = copy();
    delete byId(inv, "SEC-03").pending.owner;
    byId(inv, "SEC-22").os.push("linux");
    const faults = faultsOf(inv);
    expect(faults).toContain("pending: SEC-03: pending.owner missing");
    expect(faults).toContain("pending: SEC-22: not_yet.linux, but os includes linux");
  });
  it("CAUGHT a known-bad control with no integrity, a must_fail entry that is no registry HARM test, or a TWIN", () => {
    expect(faultsOf(copy(), { ...knownBad, integrity: "3.0.1" }).some((f) => f.startsWith("known-bad: the known-bad control pins no sha512 integrity"))).toBe(true);
    expect(faultsOf(copy(), { ...knownBad, must_fail: [...knownBad.must_fail, "SEC-99.T1 HARM nothing"] })).toContain('known-bad: must_fail "SEC-99.T1 HARM nothing" names 0 registry tests (exactly 1 expected)');
    expect(faultsOf(copy(), { ...knownBad, must_fail: ["SEC-20.T1 TWIN relay send --from an ACTIVE agent delivers"] })).toContain('known-bad: must_fail "SEC-20.T1 TWIN relay send --from an ACTIVE agent delivers" is not a HARM test title');
  });
});
