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
 *   - a BRANCHING drift guard: no hardcoded `(claude|codex)` alternation or
 *     `=== "codex"`-style id comparison in src/ outside the registry;
 *   - a BASH-MIRROR drift guard: the _vault-helpers.sh PID-finder pattern's CLI
 *     tokens match the registry (Q1-b — a mirror kept honest by a test, not read
 *     on the per-hook hot path).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
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

  it("DRIFT-GUARD (branching): no hardcoded (claude|codex) alternation or id-equality in src/ outside the registry", () => {
    // Targets the DANGEROUS branching forms the registry replaces — a regex
    // alternation of the CLI ids, or an id-equality / switch-case comparison.
    // Deliberately NOT prose, file paths (~/.claude/…), --flag strings, or
    // registry lookups by id. Escape hatch: `// CLI-PROFILE-ALLOWLIST: <reason>`.
    const PATTERN =
      "\\(claude\\|codex\\)|\\(codex\\|claude\\)|(===|!==|==|!=|case)[[:space:]]*[\"'](claude|codex)[\"']";
    const r = spawnSync("grep", ["-rnE", PATTERN, path.join(REPO, "src"), "--include=*.ts"], {
      encoding: "utf-8",
    });
    const hits = (r.stdout ?? "")
      .split("\n")
      .filter((l) => l && !l.includes("/agent-cli-profiles.ts:") && !l.includes("// CLI-PROFILE-ALLOWLIST:"));
    expect(hits, `hardcoded CLI branching outside src/agent-cli-profiles.ts:\n${hits.join("\n")}`).toEqual([]);
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
