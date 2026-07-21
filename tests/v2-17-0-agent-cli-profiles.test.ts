// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.17.0 (P3) — the agent-CLI profile registry + its drift guards.
 *
 * The registry (src/agent-cli-profiles.ts) is the single source of truth for
 * supported agent CLIs. These tests assert:
 *   - it ships claude + codex only, each structurally well-formed;
 *   - launch{} / wake{} are populated + typed (Q3 — behavior is exercised in
 *     P2 / P4, but the fields get a structural assertion in P3);
 *   - a BRANCHING drift guard (shared TS-AST walk, scripts/cli-profile-guard.mjs):
 *     no hardcoded id-equality (either operand), switch/case on a CLI id, or
 *     regex alternation of the ids in src/ outside the registry — plus planted
 *     regressions for each dangerous form (incl. codex's 3 audit bypasses);
 *   - a BASH-MIRROR drift guard: the _vault-helpers.sh PID-finder pattern's CLI
 *     tokens match the registry (Q1-b — a mirror kept honest by a test, not read
 *     on the per-hook hot path).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import {
  AGENT_CLI_PROFILES,
  getAgentCliProfile,
  profileProcessPatternSource,
} from "../src/agent-cli-profiles.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("v2.17.0 P3 — agent-cli-profiles registry", () => {
  it("ships claude + codex only, each structurally well-formed", () => {
    expect(AGENT_CLI_PROFILES.map((p) => p.id).sort()).toEqual(["claude", "codex"]);
    for (const p of AGENT_CLI_PROFILES) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.binary).toBe("string");
      expect(typeof p.displayName).toBe("string");
      expect(p.processPattern.length).toBeGreaterThan(0);
      expect(typeof p.hookInstall.target).toBe("string");
      expect(["claude-settings-json", "codex-config-toml"]).toContain(p.hookInstall.format);
      expect(p.hookInstall.events.length).toBeGreaterThan(0);
      for (const e of p.hookInstall.events) {
        expect(["SessionStart", "PostToolUse", "Stop"]).toContain(e.event);
        expect(typeof e.matcher).toBe("string");
        expect(e.script).toMatch(/^hooks\//); // repo-relative under hooks/
      }
    }
  });

  it("(Q3) launch{} + wake{} are populated + correctly typed for BOTH profiles", () => {
    for (const p of AGENT_CLI_PROFILES) {
      expect(p.launch.kickstartArg === null || typeof p.launch.kickstartArg === "string").toBe(true);
      expect(Array.isArray(p.launch.flags)).toBe(true);
      p.launch.flags.forEach((f) => expect(typeof f).toBe("string"));
      expect(p.launch.titleFlag === null || typeof p.launch.titleFlag === "string").toBe(true);
      expect(p.wake.wakeText === null || typeof p.wake.wakeText === "string").toBe(true);
      expect(["\r", "\n"]).toContain(p.wake.submitKey);
      expect(["sendSequence", "sendText"]).toContain(p.wake.submitMethod);
      expect(typeof p.wake.nativeSelfWake).toBe("boolean");
    }
  });

  it("codex is register-only (SessionStart); claude has all three hook events; codex nativeSelfWake=false (no poller)", () => {
    const codex = getAgentCliProfile("codex")!;
    expect(codex.hookInstall.events.map((e) => e.event)).toEqual(["SessionStart"]);
    expect(codex.wake.nativeSelfWake).toBe(false);
    const claude = getAgentCliProfile("claude")!;
    expect(claude.hookInstall.events.map((e) => e.event).sort()).toEqual([
      "PostToolUse",
      "SessionStart",
      "Stop",
    ]);
  });

  it("getAgentCliProfile is case-insensitive; unknown → undefined; pattern source = registry", () => {
    expect(getAgentCliProfile("CLAUDE")?.id).toBe("claude");
    expect(getAgentCliProfile("gemini")).toBeUndefined();
    expect(profileProcessPatternSource()).toBe("claude|codex");
  });

  // The branching guard is a narrow TS-AST walk (scripts/cli-profile-guard.mjs)
  // shared VERBATIM with the pre-publish gate — one implementation, both
  // surfaces. A regex proved too leaky (codex's audit found 3 bypasses:
  // reversed equality, bare + noncapturing alternation), so the detector works
  // on the AST FORM, not on syntax spelling.
  const GUARD = path.join(REPO, "scripts", "cli-profile-guard.mjs");
  const runGuard = (dir: string) => spawnSync("node", [GUARD, dir], { encoding: "utf-8" });

  it("DRIFT-GUARD (branching): the shared AST guard reports src/ clean", () => {
    const r = runGuard(path.join(REPO, "src"));
    expect(r.status, `guard flagged src/:\nstdout=${r.stdout}\nstderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("registry consolidated");
  });

  it("DRIFT-GUARD (branching) regression: catches every dangerous form, spares legit code, honors the allowlist", () => {
    // Hermetic fixtures — never written into the repo tree. DANGEROUS covers
    // codex's 3 audit bypasses (reversed equality, bare + noncapturing
    // alternation) PLUS switch/case and the RegExp() constructor.
    const DANGEROUS: Record<string, string> = {
      "eq-right.ts": 'export const f = (id: string) => id === "codex";',
      "eq-left-reversed.ts": 'export const f = (id: string) => "codex" === id;',
      "neq-right.ts": 'export const f = (id: string) => id !== "claude";',
      "neq-left-reversed.ts": 'export const f = (id: string) => "claude" !== id;',
      "switch-case.ts": 'export function f(x: string){ switch(x){ case "codex": return 1; default: return 0; } }',
      "regex-bare.ts": "export const f = (id: string) => /claude|codex/.test(id);",
      "regex-noncapturing.ts": "export const r = /(?:claude|codex)/;",
      "regex-capturing.ts": "export const r = /(claude|codex)/i;",
      "regex-reversed.ts": "export const r = /(codex|claude)/;",
      "regexp-ctor.ts": 'export const r = new RegExp("^(claude|codex)$");',
    };

    // 1) All dangerous forms fire — assert each fixture basename shows up in the
    // violation report (proves each was individually caught, not just one).
    const dangerDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-guard-danger-"));
    try {
      for (const [name, code] of Object.entries(DANGEROUS)) {
        fs.writeFileSync(path.join(dangerDir, name), code + "\n");
      }
      const dr = runGuard(dangerDir);
      expect(dr.status, "guard should reject the dangerous fixtures").toBe(1);
      for (const name of Object.keys(DANGEROUS)) {
        expect(dr.stderr, `guard MISSED dangerous form: ${name}`).toContain(name);
      }
    } finally {
      fs.rmSync(dangerDir, { recursive: true, force: true });
    }

    // 2) Legit code is spared; 3) the allowlist marker suppresses a real hit.
    const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-guard-clean-"));
    try {
      fs.writeFileSync(
        path.join(cleanDir, "legit.ts"),
        [
          'export const p = getAgentCliProfile("codex");', // registry lookup by id
          'export const p2 = "~/.claude/settings.json";', // path
          'export const dn = "Codex CLI";', // display string (capitalized)
          'export const lbl = "claude-scope-planner";', // longer identifier
          "// choose claude or codex from config", // prose
          'export const flags = ["--codex-mode"];', // flag token
          "export const single = /^codex-/;", // single-id regex (not a branch)
        ].join("\n") + "\n",
      );
      fs.writeFileSync(
        path.join(cleanDir, "allowed.ts"),
        'export const f = (id: string) => id === "codex"; // CLI-PROFILE-ALLOWLIST: legacy shim, P2 migrates\n',
      );
      const cr = runGuard(cleanDir);
      expect(cr.status, `guard false-positive or allowlist ignored:\n${cr.stderr}`).toBe(0);
    } finally {
      fs.rmSync(cleanDir, { recursive: true, force: true });
    }
  });

  it("DRIFT-GUARD (bash mirror): _vault-helpers.sh PID pattern's CLI tokens == the registry processPatterns", () => {
    const helpers = fs.readFileSync(path.join(REPO, "hooks", "_vault-helpers.sh"), "utf-8");
    const m = helpers.match(/pat='([^']+)'/);
    expect(m, "could not find pat='…' in hooks/_vault-helpers.sh").toBeTruthy();
    const patTokens = m![1].split("|");
    // Runtime hosts (a script CLI reports comm=node/bun/deno) are NOT CLI-specific
    // and stay literal in bash; the CLI tokens must track the registry.
    const RUNTIME_HOSTS = new Set(["node", "bun", "deno"]);
    const cliTokens = patTokens.filter((t) => !RUNTIME_HOSTS.has(t)).sort();
    expect(cliTokens, "the bash PID pattern's CLI tokens drifted from the registry").toEqual(
      AGENT_CLI_PROFILES.map((p) => p.processPattern).sort(),
    );
  });
});
