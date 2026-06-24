// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.2.2 P3 — deterministic terminal-targeting. The matcher is the contract:
// wake ONLY the terminal that owns the agent, never the focused one. These
// tests assert the contract directly (not a proxy), including the Half-B
// regression (the focused "✳ Restart…" terminal must NOT be woken).

import { describe, it, expect } from "vitest";
import { resolveWakeTarget, tetherTerminalName } from "./terminal-targeting.js";

const term = (name: string) => ({ name });

describe("tetherTerminalName — single source of the spawn convention", () => {
  it("prefixes the agent name with 'Tether: '", () => {
    expect(tetherTerminalName("build-agent")).toBe("Tether: build-agent");
  });
});

describe("resolveWakeTarget — deterministic wake targeting", () => {
  it("matches the BARE agent name (the `vscode-build-agent` relaunch alias case)", () => {
    const t = term("build-agent");
    const d = resolveWakeTarget("build-agent", [term("codex"), t, term("zsh")]);
    expect(d.kind).toBe("inject");
    if (d.kind === "inject") expect(d.terminal).toBe(t);
  });

  it("matches the `Tether: <name>` spawn convention", () => {
    const t = term("Tether: build-agent");
    const d = resolveWakeTarget("build-agent", [term("Tether: codex"), t]);
    expect(d.kind).toBe("inject");
    if (d.kind === "inject") expect(d.terminal).toBe(t);
  });

  it("★ HALF-B REGRESSION: does NOT wake the focused/unrelated terminal when nothing matches", () => {
    // The exact 2026-06-11 mis-injection: a focused terminal named
    // "✳ Restart build-agent agent in VS Code" is NOT the agent's terminal.
    const d = resolveWakeTarget("build-agent", [
      term("✳ Restart build-agent agent in VS Code"),
      term("codex"),
    ]);
    expect(d.kind).toBe("no-match"); // never inject to the focused guess
  });

  it("0 matches → no-match (no inject; mail stays in the inbox)", () => {
    const d = resolveWakeTarget("build-agent", [term("codex"), term("zsh")]);
    expect(d).toEqual({ kind: "no-match", agentName: "build-agent" });
  });

  it(">1 matches (two same-named terminals) → ambiguous, no inject", () => {
    const d = resolveWakeTarget("build-agent", [term("build-agent"), term("build-agent")]);
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") expect(d.matches).toHaveLength(2);
  });

  it(">1 matches (bare + `Tether:` both present) → ambiguous, no inject", () => {
    const d = resolveWakeTarget("build-agent", [
      term("build-agent"),
      term("Tether: build-agent"),
    ]);
    expect(d.kind).toBe("ambiguous");
  });

  it("empty agent name → no-match (idle, nothing to target)", () => {
    expect(resolveWakeTarget("", [term("Tether: build-agent")]).kind).toBe("no-match");
  });

  it("substring/partial names do NOT match (exact name only)", () => {
    // "build-agent-2" and "build" must not be woken for agent "build-agent".
    const d = resolveWakeTarget("build-agent", [term("build-agent-2"), term("build")]);
    expect(d.kind).toBe("no-match");
  });

  it("multi-agent isolation: a wake for A never targets B's terminal", () => {
    const a = term("Tether: build-agent");
    const b = term("Tether: codex");
    const d = resolveWakeTarget("codex", [a, b]);
    expect(d.kind).toBe("inject");
    if (d.kind === "inject") expect(d.terminal).toBe(b);
  });
});
