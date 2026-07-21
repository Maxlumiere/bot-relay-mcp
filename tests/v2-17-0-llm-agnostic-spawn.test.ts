// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.17.0 (P2 — LLM-agnostic spawn) — the `cli` field + registry-driven launch
 * across all three drivers. Drivers are pure (they only BUILD commands), so
 * these assert on the SpawnCommand / thrown errors — no child_process.spawn.
 * The real-bash hardening for the codex launcher path lives in
 * tests/spawn-integration.test.ts.
 *
 * Invariants:
 *   - `cli` defaults to "claude" and is validated against the profile registry;
 *   - claude spawn is UNCHANGED whether cli is omitted or "claude" (back-compat);
 *   - codex spawn is registry-driven: macOS/Linux run bin/codex-relay (the
 *     cold-start handshake launcher), Windows rejects with a clear error;
 *   - selection is data-driven (launch.strategy) — no hardcoded claude|codex
 *     branch (kept clean by the P3 drift guard).
 */
import { describe, it, expect } from "vitest";
import { macosDriver } from "../src/spawn/drivers/macos.js";
import { linuxDriver } from "../src/spawn/drivers/linux.js";
import { windowsDriver } from "../src/spawn/drivers/windows.js";
import { buildSpawnCommand } from "../src/spawn/dispatcher.js";
import type { DriverContext } from "../src/spawn/types.js";
import type { SpawnAgentInput } from "../src/types.js";
import { SpawnAgentSchema } from "../src/types.js";

function makeCtx(available: string[] = [], terminalOverride: string | null = null): DriverContext {
  const set = new Set(available);
  return { hasBinary: (n) => set.has(n), terminalOverride };
}

/** Build via the schema (fills the cli default), like the MCP boundary. */
function parsed(over: Record<string, unknown> = {}): SpawnAgentInput {
  return SpawnAgentSchema.parse({
    name: "worker-1",
    role: "builder",
    capabilities: ["build", "test"],
    cwd: "/tmp/project",
    ...over,
  });
}

/** Build a raw input literal (bypasses schema validation — for defense-in-depth). */
function raw(over: Partial<SpawnAgentInput> = {}): SpawnAgentInput {
  return {
    name: "worker-1",
    role: "builder",
    capabilities: ["build"],
    cwd: "/tmp/project",
    ...over,
  } as SpawnAgentInput;
}

describe("v2.17.0 P2 — SpawnAgentSchema.cli", () => {
  it("defaults to 'claude' when omitted", () => {
    expect(parsed().cli).toBe("claude");
  });

  it("accepts 'codex'", () => {
    expect(parsed({ cli: "codex" }).cli).toBe("codex");
  });

  it("accepts registry ids case-insensitively", () => {
    expect(parsed({ cli: "CODEX" }).cli).toBe("CODEX"); // preserved; driver lowercases via lookup
    expect(parsed({ cli: "Claude" }).cli).toBe("Claude");
  });

  it("rejects an unknown CLI at the MCP boundary", () => {
    expect(() => parsed({ cli: "gpt" })).toThrow();
    expect(() => parsed({ cli: "gemini" })).toThrow();
  });

  it("rejects a shell-metachar CLI value (regex allowlist)", () => {
    expect(() => parsed({ cli: "co;dex" })).toThrow();
    expect(() => parsed({ cli: "codex codex" })).toThrow();
    expect(() => parsed({ cli: "codex$(id)" })).toThrow();
  });
});

describe("v2.17.0 P2 — macOS driver (spawn-agent.sh)", () => {
  const ctx = makeCtx();

  it("claude (default): no RELAY_SPAWN_LAUNCHER, RELAY_SPAWN_CLI=claude", () => {
    const c = macosDriver.buildCommand(parsed(), ctx);
    expect(c.env.RELAY_SPAWN_LAUNCHER).toBeUndefined();
    expect(c.env.RELAY_SPAWN_CLI).toBe("claude");
    expect(c.exec).toMatch(/bin\/spawn-agent\.sh$/);
  });

  it("codex: RELAY_SPAWN_LAUNCHER points at bin/codex-relay, RELAY_SPAWN_CLI=codex", () => {
    const c = macosDriver.buildCommand(parsed({ cli: "codex" }), ctx);
    expect(c.env.RELAY_SPAWN_LAUNCHER).toMatch(/\/bin\/codex-relay$/);
    expect(c.env.RELAY_SPAWN_CLI).toBe("codex");
    // The positional args (name/role/caps/cwd) are UNCHANGED — identity + cwd
    // hardening in spawn-agent.sh is CLI-agnostic and reused.
    expect(c.args.slice(0, 4)).toEqual(["worker-1", "builder", "build,test", "/tmp/project"]);
  });

  it("unknown cli (bypassing the schema) throws in the driver too", () => {
    expect(() => macosDriver.buildCommand(raw({ cli: "gpt" }), ctx)).toThrow(/unknown cli/i);
  });
});

describe("v2.17.0 P2 — Linux driver", () => {
  const SUBS: Array<[string, string[]]> = [
    ["gnome-terminal", ["gnome-terminal"]],
    ["konsole", ["konsole"]],
    ["xterm", ["xterm"]],
    ["tmux", ["tmux"]],
  ];

  it("claude (default): launches `exec claude`, no codex-relay", () => {
    for (const [, bins] of SUBS) {
      const c = linuxDriver.buildCommand(parsed(), makeCtx(bins));
      const joined = c.args.join(" ");
      expect(joined).toContain("exec claude");
      expect(joined).not.toContain("codex-relay");
    }
  });

  it("codex: launches `exec '<abs>/bin/codex-relay' '<name>'` on every sub-driver, RELAY_SPAWN_CLI=codex", () => {
    for (const [, bins] of SUBS) {
      const c = linuxDriver.buildCommand(parsed({ cli: "codex" }), makeCtx(bins));
      const joined = c.args.join(" ");
      expect(joined).toMatch(/exec '.*\/bin\/codex-relay' 'worker-1'/);
      expect(joined).not.toContain("exec claude");
      expect(c.env.RELAY_SPAWN_CLI).toBe("codex");
    }
  });

  it("unknown cli (bypassing schema) throws", () => {
    expect(() => linuxDriver.buildCommand(raw({ cli: "gpt" }), makeCtx(["xterm"]))).toThrow(/unknown cli/i);
  });
});

describe("v2.17.0 P2 — Windows driver", () => {
  const ctx = makeCtx(["wt.exe", "powershell.exe", "cmd.exe"]);

  it("claude (default): builds normally (contains `claude`)", () => {
    const c = windowsDriver.buildCommand(parsed(), ctx);
    expect(c.args.join(" ")).toContain("claude");
  });

  it("codex: throws a clear 'not supported on Windows' error (codex-relay is POSIX)", () => {
    expect(() => windowsDriver.buildCommand(parsed({ cli: "codex" }), ctx)).toThrow(
      /not supported on Windows|POSIX/i,
    );
  });

  it("unknown cli (bypassing schema) throws", () => {
    expect(() => windowsDriver.buildCommand(raw({ cli: "gpt" }), ctx)).toThrow(/unknown cli/i);
  });
});

describe("v2.17.0 P2 — back-compat (claude unchanged)", () => {
  it("buildSpawnCommand for cli omitted === cli='claude' on every platform", () => {
    // gnome-terminal is first in the Linux chain, so tmux (random session
    // suffix) is never picked — the comparison stays deterministic.
    const ctx = makeCtx(["gnome-terminal", "xterm", "tmux", "wt.exe", "powershell.exe", "cmd.exe"]);
    for (const plat of ["darwin", "linux", "win32"] as const) {
      // Identical inputs except cli: omitted (→ default claude) vs explicit claude.
      const omitted = buildSpawnCommand(raw({}), undefined, ctx, plat);
      const explicit = buildSpawnCommand(raw({ cli: "claude" }), undefined, ctx, plat);
      expect(omitted.exec).toBe(explicit.exec);
      expect(omitted.args).toEqual(explicit.args);
      expect(omitted.driverName).toBe(explicit.driverName);
      // No launcher env on the claude path, either way.
      expect(omitted.env.RELAY_SPAWN_LAUNCHER).toBeUndefined();
      expect(explicit.env.RELAY_SPAWN_LAUNCHER).toBeUndefined();
    }
  });
});
