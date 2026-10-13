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
 *   - the KNOWN-BAD control (security/known-bad.json) pins an integrity, and each must_fail tag names HARM tests that
 *     exist.
 * (Whether every security RULING names an invariant is a fleet-governance check, run outside this public repo.)
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // never URL.pathname: it keeps %20
const OSES = ["darwin", "linux", "win32"];

interface TestRef {
  id: string;
  mode: "installed" | "in-process";
}
interface Invariant {
  id: string;
  statement: string;
  source: string;
  os: string[];
  status: "active" | "pending";
  tests: TestRef[];
  pending?: { reason: string; owner: string; blocked_by: string };
  waiver?: { reason: string; ruling_id: string; revisit_when: string };
  not_yet?: Record<string, { reason: string; owner: string; blocked_by: string }>;
  conditional_on?: string[];
}
const registry = (JSON.parse(fs.readFileSync(path.join(REPO, "security", "invariants.json"), "utf-8")) as { invariants: Invariant[] }).invariants;
const knownBad = JSON.parse(fs.readFileSync(path.join(REPO, "security", "known-bad.json"), "utf-8")) as { integrity: string; must_fail: string[]; version: string };

/** "<repo-relative file>::<test title>" for every test vitest collects under `config` (list only: nothing runs). */
function listTests(config: string, files: string[] = []): Set<string> {
  const r = spawnSync(process.execPath, [path.join(REPO, "node_modules", "vitest", "vitest.mjs"), "list", "--json", "--config", path.join(REPO, config), ...files], {
    cwd: REPO,
    encoding: "utf-8",
    env: { ...process.env, RELAY_RELEASE_LIST_ONLY: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`vitest list (${config}) failed: ${r.stderr.slice(-1500)}`);
  const out = new Set<string>();
  for (const t of JSON.parse(r.stdout) as Array<{ name: string; file: string }>) {
    const title = t.name.split(" > ").at(-1)!;
    out.add(`${path.relative(REPO, t.file).split(path.sep).join("/")}::${title}`);
  }
  return out;
}

let releaseTests: Set<string>;
let inProcessTests: Set<string>;
beforeAll(() => {
  releaseTests = listTests("vitest.release.config.ts");
  const inProcFiles = [...new Set(registry.flatMap((i) => i.tests.filter((t) => t.mode === "in-process").map((t) => t.id.split("::")[0]!)))];
  inProcessTests = inProcFiles.length ? listTests("vitest.config.ts", inProcFiles) : new Set();
}, 120_000);

describe("the security invariant registry", () => {
  it("ids are unique, and every entry has a statement, a source and a known OS list", () => {
    const ids = registry.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of registry) {
      expect(i.statement.length, i.id).toBeGreaterThan(10);
      expect(i.source.length, i.id).toBeGreaterThan(0);
      expect(i.os.length, i.id).toBeGreaterThan(0);
      for (const o of i.os) expect(OSES, `${i.id} os`).toContain(o);
      expect(["active", "pending"], i.id).toContain(i.status);
    }
  });

  it("an ACTIVE invariant names at least one test, and each one RESOLVES to a collected test", () => {
    const unresolved: string[] = [];
    for (const i of registry.filter((x) => x.status === "active")) {
      expect(i.tests.length, `${i.id} is active with no test`).toBeGreaterThan(0);
      for (const t of i.tests) {
        const pool = t.mode === "installed" ? releaseTests : inProcessTests;
        if (!pool.has(t.id)) unresolved.push(`${i.id}: ${t.mode} ${t.id}`);
      }
    }
    expect(unresolved, "registry test ids that no collected test matches").toEqual([]);
  });

  it("every release test belongs to an invariant (no orphan the gate would never report)", () => {
    const named = new Set(registry.flatMap((i) => i.tests.map((t) => t.id)));
    expect([...releaseTests].filter((t) => !named.has(t))).toEqual([]);
    expect(releaseTests.size, "the release suite collected tests at all").toBeGreaterThan(0);
  });

  it("an active invariant with no INSTALLED-package test carries a complete waiver; every waiver is complete", () => {
    for (const i of registry) {
      if (i.status === "active" && !i.tests.some((t) => t.mode === "installed")) {
        expect(i.waiver, `${i.id} has only in-process tests and no waiver`).toBeDefined();
      }
      if (i.waiver) for (const k of ["reason", "ruling_id", "revisit_when"] as const) expect(i.waiver[k], `${i.id} waiver.${k}`).toBeTruthy();
    }
  });

  it("a PENDING invariant names its reason, owner and blocker (and a per-OS gap does too)", () => {
    for (const i of registry) {
      if (i.status === "pending") for (const k of ["reason", "owner", "blocked_by"] as const) expect(i.pending?.[k], `${i.id} pending.${k}`).toBeTruthy();
      for (const [o, gap] of Object.entries(i.not_yet ?? {})) {
        expect(OSES, `${i.id} not_yet`).toContain(o);
        expect(i.os, `${i.id}: not_yet.${o} but os includes it`).not.toContain(o);
        for (const k of ["reason", "owner", "blocked_by"] as const) expect(gap[k], `${i.id} not_yet.${o}.${k}`).toBeTruthy();
      }
      for (const c of i.conditional_on ?? []) expect(registry.map((x) => x.id), `${i.id} conditional_on`).toContain(c);
    }
  });

  it("the known-bad control pins an INTEGRITY, and each must_fail tag names HARM tests in the registry", () => {
    expect(knownBad.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    const ids = registry.flatMap((i) => i.tests.map((t) => t.id.split("::")[1]!));
    for (const tag of knownBad.must_fail) expect(ids.filter((t) => t.startsWith(`${tag} HARM`)).length, `${tag} HARM tests`).toBeGreaterThan(0);
  });
});
