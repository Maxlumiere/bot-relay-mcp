// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// ADR-0048 PR D — version skew between the resolver Tether BUNDLES and the one
// the relay RUNS is VISIBLE: Tether compares the relay's /health
// `resolver_revision` with its own (BUNDLED_RESOLVER_REVISION) and says so, once
// per change (a match, a mismatch with a warning, or an older relay that does
// not report one).
import { describe, it, expect, vi } from "vitest";
import { compareResolverRevision, ResolverSkewReporter } from "./resolver-skew.js";
import { BUNDLED_RESOLVER_REVISION } from "./vault-path.js";

const body = (rev?: string) => JSON.stringify(rev === undefined ? { status: "ok" } : { status: "ok", resolver_revision: rev });

describe("compareResolverRevision", () => {
  it("the same revision → match", () => {
    expect(compareResolverRevision(body(BUNDLED_RESOLVER_REVISION))).toEqual({ status: "match", revision: BUNDLED_RESOLVER_REVISION });
  });
  it("a different revision → mismatch, naming both", () => {
    expect(compareResolverRevision(body("aaaaaaaaaaaa"))).toEqual({ status: "mismatch", relay: "aaaaaaaaaaaa", bundled: BUNDLED_RESOLVER_REVISION });
  });
  it("no revision in the body (a relay older than ADR-0048 PR D) → unknown, never a match", () => {
    expect(compareResolverRevision(body())).toMatchObject({ status: "unknown" });
  });
  it("an unreadable body → unknown", () => {
    expect(compareResolverRevision("not json")).toMatchObject({ status: "unknown" });
    expect(compareResolverRevision(null)).toMatchObject({ status: "unknown" });
  });
  it("a revision that is not 12 hex digits is not trusted → unknown", () => {
    expect(compareResolverRevision(body("<script>"))).toMatchObject({ status: "unknown" });
  });
});

describe("ResolverSkewReporter — says it once per CHANGE", () => {
  it("a mismatch is logged AND warned once; repeated polls stay quiet; a later match is said", () => {
    const log = vi.fn();
    const warn = vi.fn();
    const r = new ResolverSkewReporter({ log, warn });
    r.observe(body("aaaaaaaaaaaa"));
    r.observe(body("aaaaaaaaaaaa"));
    r.observe(body("aaaaaaaaaaaa"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/aaaaaaaaaaaa/);
    expect(warn.mock.calls[0][0]).toContain(BUNDLED_RESOLVER_REVISION);
    expect(log.mock.calls.filter((c) => /MISMATCH/.test(c[0]))).toHaveLength(1);
    r.observe(body(BUNDLED_RESOLVER_REVISION));
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/matches the relay/);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("an older relay (no revision) is logged once, no warning", () => {
    const log = vi.fn();
    const warn = vi.fn();
    const r = new ResolverSkewReporter({ log, warn });
    r.observe(body());
    r.observe(body());
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/does not report/);
    expect(warn).not.toHaveBeenCalled();
  });
});
