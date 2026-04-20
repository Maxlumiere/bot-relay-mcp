// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Per-platform spawn driver tests (v1.9).
 *
 * Drivers are pure — they only BUILD command objects. These tests mock
 * binary-presence probing and assert on the resulting SpawnCommand. No
 * child_process.spawn is called at this layer.
 *
 * Linux + Windows real-subprocess testing is documented manual-smoke only;
 * there is no CI infrastructure for those platforms. See
 * docs/cross-platform-spawn.md.
 */
import { describe, it, expect } from "vitest";
import { linuxDriver } from "../src/spawn/drivers/linux.js";
import { windowsDriver } from "../src/spawn/drivers/windows.js";
import { macosDriver } from "../src/spawn/drivers/macos.js";
import { resolveTerminalOverride, buildChildEnv, normalizeCwd } from "../src/spawn/validation.js";
import type { DriverContext } from "../src/spawn/types.js";
import type { SpawnAgentInput } from "../src/types.js";
import { SpawnAgentSchema } from "../src/types.js";

function makeCtx(
  availableBinaries: string[],
  terminalOverride: string | null = null
): DriverContext {
  const set = new Set(availableBinaries);
  return {
    hasBinary: (name) => set.has(name),
    terminalOverride,
  };
}

function baseInput(overrides: Partial<SpawnAgentInput> = {}): SpawnAgentInput {
  return {
    name: "worker-1",
    role: "builder",
    capabilities: ["build", "test"],
    cwd: "/tmp/project",
    ...overrides,
  } as SpawnAgentInput;
}

// --- Linux driver ---

describe("linux driver — fallback chain", () => {
  it("picks gnome-terminal when it is the only emulator on PATH", () => {
    const ctx = makeCtx(["gnome-terminal"]);
    const cmd = linuxDriver.buildCommand(baseInput(), ctx);
    expect(cmd.exec).toBe("gnome-terminal");
    expect(cmd.args[0]).toBe("--");
    expect(cmd.args[1]).toBe("bash");
    expect(cmd.args[2]).toBe("-lc");
    expect(cmd.args[3]).toContain("cd '/tmp/project'");
    expect(cmd.args[3]).toContain("exec claude");
    expect(cmd.driverName).toBe("gnome-terminal");
    expect(cmd.platform).toBe("linux");
  });

  it("falls back to konsole when gnome-terminal is missing", () => {
    const ctx = makeCtx(["konsole", "xterm"]);
    const cmd = linuxDriver.buildCommand(baseInput(), ctx);
    expect(cmd.exec).toBe("konsole");
    expect(cmd.args[0]).toBe("-e");
    expect(cmd.driverName).toBe("konsole");
  });

  it("falls back to xterm when neither gnome-terminal nor konsole available", () => {
    const ctx = makeCtx(["xterm", "tmux"]);
    const cmd = linuxDriver.buildCommand(baseInput(), ctx);
    expect(cmd.exec).toBe("xterm");
    expect(cmd.args[0]).toBe("-e");
    expect(cmd.driverName).toBe("xterm");
  });

  it("falls back to tmux (session-only, agent-name-<4hex> suffix) when no GUI emulator is present", () => {
    const ctx = makeCtx(["tmux"]);
    const cmd = linuxDriver.buildCommand(baseInput(), ctx);
    expect(cmd.exec).toBe("tmux");
    expect(cmd.args[0]).toBe("new-session");
    expect(cmd.args).toContain("-d"); // detached
    expect(cmd.args).toContain("-s");
    // v1.9.1: session name is "<agent-name>-<4hex>" to prevent silent
    // collision between two spawns that share the same relay name.
    const sessionName = cmd.args[cmd.args.indexOf("-s") + 1];
    expect(sessionName).toMatch(/^worker-1-[0-9a-f]{4}$/);
    expect(cmd.driverName).toBe("tmux");
  });

  it("throws a clear error when no terminal emulator is available", () => {
    const ctx = makeCtx([]);
    expect(linuxDriver.canHandle(ctx)).toBe(false);
    expect(() => linuxDriver.buildCommand(baseInput(), ctx)).toThrow(/no terminal emulator/i);
  });

  it("RELAY_TERMINAL_APP=xterm override is honored even when gnome-terminal is present", () => {
    const ctx = makeCtx(["gnome-terminal", "xterm"], "xterm");
    const cmd = linuxDriver.buildCommand(baseInput(), ctx);
    expect(cmd.exec).toBe("xterm");
    expect(cmd.driverName).toBe("xterm");
  });

  it("override falls through if the specified binary is missing (still picks what IS available)", () => {
    const ctx = makeCtx(["konsole"], "xterm");
    const cmd = linuxDriver.buildCommand(baseInput(), ctx);
    // xterm override specified but missing → falls through chain → konsole
    expect(cmd.exec).toBe("konsole");
  });
});

// --- Windows driver ---

describe("windows driver — fallback chain", () => {
  it("picks wt.exe when on PATH", () => {
    const ctx = makeCtx(["wt.exe", "powershell.exe", "cmd.exe"]);
    const cmd = windowsDriver.buildCommand(baseInput({ cwd: "C:\\Projects\\mine" }), ctx);
    expect(cmd.exec).toBe("wt.exe");
    // wt -d <cwd> claude
    expect(cmd.args).toEqual(["-d", "C:\\Projects\\mine", "claude"]);
    expect(cmd.driverName).toBe("wt");
    expect(cmd.platform).toBe("win32");
  });

  it("falls back to powershell.exe when wt.exe missing", () => {
    const ctx = makeCtx(["powershell.exe", "cmd.exe"]);
    const cmd = windowsDriver.buildCommand(baseInput({ cwd: "C:\\work" }), ctx);
    expect(cmd.exec).toBe("powershell.exe");
    expect(cmd.args[0]).toBe("-NoExit");
    expect(cmd.args[1]).toBe("-Command");
    expect(cmd.args[2]).toContain("Set-Location -LiteralPath 'C:\\work'");
    expect(cmd.args[2]).toContain("claude");
    expect(cmd.driverName).toBe("powershell");
  });

  it("falls back to cmd.exe when neither wt nor powershell available", () => {
    const ctx = makeCtx(["cmd.exe"]);
    const cmd = windowsDriver.buildCommand(baseInput({ cwd: "C:\\work" }), ctx);
    expect(cmd.exec).toBe("cmd.exe");
    expect(cmd.args[0]).toBe("/K");
    expect(cmd.args[1]).toContain("cd /D");
    expect(cmd.args[1]).toContain("C:\\work");
    expect(cmd.args[1]).toContain("claude");
    expect(cmd.driverName).toBe("cmd");
  });

  it("throws a clear error when no Windows terminal is available", () => {
    const ctx = makeCtx([]);
    expect(windowsDriver.canHandle(ctx)).toBe(false);
    expect(() => windowsDriver.buildCommand(baseInput(), ctx)).toThrow(/no terminal|wt\.exe|powershell/i);
  });

  it("normalizes forward-slash CWD to backslashes on Windows", () => {
    const ctx = makeCtx(["wt.exe"]);
    const cmd = windowsDriver.buildCommand(baseInput({ cwd: "C:/work/project" }), ctx);
    // The cwd passed into the wt.exe -d arg should be backslash-normalized
    expect(cmd.args).toContain("C:\\work\\project");
  });
});

// --- macOS driver ---

describe("macos driver — shells out to bin/spawn-agent.sh", () => {
  it("builds a command invoking the bash script with [name, role, caps, cwd]", () => {
    const ctx = makeCtx([]); // unused on darwin
    const cmd = macosDriver.buildCommand(baseInput(), ctx);
    expect(cmd.exec).toMatch(/bin\/spawn-agent\.sh$/);
    expect(cmd.args).toEqual(["worker-1", "builder", "build,test", "/tmp/project"]);
    expect(cmd.driverName).toBe("macos");
    expect(cmd.platform).toBe("darwin");
  });
});

// --- Terminal-app override resolution (platform-aware, v1.9.1) ---

describe("resolveTerminalOverride — platform-aware allowlist gating", () => {
  it("returns null for unset / empty (any platform)", () => {
    expect(resolveTerminalOverride(undefined, "linux")).toBeNull();
    expect(resolveTerminalOverride("", "darwin")).toBeNull();
    expect(resolveTerminalOverride("   ", "win32")).toBeNull();
  });

  it("accepts names valid for the current platform (case-insensitive)", () => {
    expect(resolveTerminalOverride("iterm2", "darwin")).toBe("iterm2");
    expect(resolveTerminalOverride("ITerm2", "darwin")).toBe("iterm2");
    expect(resolveTerminalOverride("gnome-terminal", "linux")).toBe("gnome-terminal");
    expect(resolveTerminalOverride("  tmux  ", "linux")).toBe("tmux");
    expect(resolveTerminalOverride("wt", "win32")).toBe("wt");
  });

  it("returns null for cross-platform names (v1.9.1 — no silent fallthrough)", () => {
    // Linux driver name on macOS → null + dispatcher warns
    expect(resolveTerminalOverride("gnome-terminal", "darwin")).toBeNull();
    // macOS driver name on Linux → null
    expect(resolveTerminalOverride("iterm2", "linux")).toBeNull();
    // Windows name on Linux → null
    expect(resolveTerminalOverride("wt", "linux")).toBeNull();
    // Linux name on Windows → null
    expect(resolveTerminalOverride("tmux", "win32")).toBeNull();
  });

  it("returns null (falls through) for values NOT on ANY allowlist", () => {
    expect(resolveTerminalOverride("bash", "linux")).toBeNull();
    expect(resolveTerminalOverride("zsh", "darwin")).toBeNull();
    expect(resolveTerminalOverride("; rm -rf /", "linux")).toBeNull();
    expect(resolveTerminalOverride("not-a-real-emulator", "win32")).toBeNull();
  });
});

// --- Env var propagation ---

describe("buildChildEnv — principle of least authority", () => {
  it("propagates RELAY_* prefix vars from parent env", () => {
    const parentEnv = {
      PATH: "/usr/bin",
      HOME: "/home/me",
      RELAY_AGENT_TOKEN: "tok-123",
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HTTP_PORT: "3777",
      AWS_SECRET_ACCESS_KEY: "should-not-propagate",
      GITHUB_TOKEN: "should-not-propagate",
    };
    const env = buildChildEnv("me", "r", ["c"], "linux", parentEnv);
    expect(env.RELAY_AGENT_TOKEN).toBe("tok-123");
    expect(env.RELAY_HTTP_HOST).toBe("127.0.0.1");
    expect(env.RELAY_HTTP_PORT).toBe("3777");
    // Principle of least authority — NOT passed through
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("sets RELAY_AGENT_NAME/ROLE/CAPABILITIES from the call args, overriding parent", () => {
    const parentEnv = {
      PATH: "/usr/bin",
      HOME: "/home/me",
      RELAY_AGENT_NAME: "someone-else",
      RELAY_AGENT_ROLE: "wrong-role",
    };
    const env = buildChildEnv("me", "builder", ["build"], "linux", parentEnv);
    expect(env.RELAY_AGENT_NAME).toBe("me");
    expect(env.RELAY_AGENT_ROLE).toBe("builder");
    expect(env.RELAY_AGENT_CAPABILITIES).toBe("build");
  });

  it("propagates Windows-specific system vars on win32", () => {
    const parentEnv = {
      PATH: "C:\\Windows\\System32",
      USERPROFILE: "C:\\Users\\me",
      APPDATA: "C:\\Users\\me\\AppData\\Roaming",
      HOME: "/unused-on-windows",
    };
    const env = buildChildEnv("me", "r", [], "win32", parentEnv);
    expect(env.USERPROFILE).toBe("C:\\Users\\me");
    expect(env.APPDATA).toBe("C:\\Users\\me\\AppData\\Roaming");
    // HOME is a POSIX-only pass-through
    expect(env.HOME).toBeUndefined();
  });
});

// --- CWD normalization ---

describe("normalizeCwd — platform-aware separator handling", () => {
  it("leaves POSIX paths untouched", () => {
    expect(normalizeCwd("/tmp/project", "linux")).toBe("/tmp/project");
    expect(normalizeCwd("/Users/me/work", "darwin")).toBe("/Users/me/work");
  });

  it("converts forward slashes to backslashes on Windows", () => {
    expect(normalizeCwd("C:/work/project", "win32")).toBe("C:\\work\\project");
    expect(normalizeCwd("D:/mixed\\style/path", "win32")).toBe("D:\\mixed\\style\\path");
  });

  // v1.9.1 fold-in 4 — platform-aware rejection
  it("rejects Windows-style drive-letter paths on POSIX (linux + darwin)", () => {
    expect(() => normalizeCwd("C:\\work", "linux")).toThrow(/drive-letter|Windows-style/i);
    expect(() => normalizeCwd("C:/work", "darwin")).toThrow(/drive-letter|Windows-style/i);
    expect(() => normalizeCwd("D:\\foo", "linux")).toThrow();
  });

  it("rejects non-absolute paths on Windows (no drive, not forward-slash-anchored)", () => {
    expect(() => normalizeCwd("relative/path", "win32")).toThrow(/not absolute/i);
    expect(() => normalizeCwd("just-a-name", "win32")).toThrow();
  });

  it("accepts Windows forward-slash-anchored absolute path", () => {
    // e.g., \\?\C:\... style or absolute posix-ish that Windows tolerates
    expect(normalizeCwd("/work/project", "win32")).toBe("\\work\\project");
  });
});

// v1.9.1 Blocker 1 — adversarial payload parity for Linux + Windows drivers.
// macOS has 22 real-subprocess adversarial tests in spawn-integration.test.ts.
// Linux + Windows now have mock-level parity here. Each test asserts either:
//   (a) zod rejects at the input boundary (SpawnAgentSchema.parse throws), OR
//   (b) the driver accepts bypass input (fabricated for the test) and the
//       resulting SpawnCommand is provably safe — payload appears as its own
//       argv element, never concatenated into a shell string (argv-separation
//       property).
describe("adversarial payloads — Linux driver parity (v1.9.1 Blocker 1)", () => {
  // SpawnAgentSchema imported at top of file

  // Class 1 — name/role injection at the zod layer
  it("rejects name with semicolon", () => {
    expect(() =>
      SpawnAgentSchema.parse({ name: "foo;rm -rf /", role: "r", capabilities: [] })
    ).toThrow();
  });
  it("rejects name with pipe", () => {
    expect(() => SpawnAgentSchema.parse({ name: "a|b", role: "r", capabilities: [] })).toThrow();
  });
  it("rejects name with ampersand", () => {
    expect(() => SpawnAgentSchema.parse({ name: "a&b", role: "r", capabilities: [] })).toThrow();
  });
  it("rejects name with $(cmd) substitution", () => {
    expect(() =>
      SpawnAgentSchema.parse({ name: "$(whoami)", role: "r", capabilities: [] })
    ).toThrow();
  });
  it("rejects name with backtick", () => {
    expect(() =>
      SpawnAgentSchema.parse({ name: "`id`", role: "r", capabilities: [] })
    ).toThrow();
  });
  it("rejects name with newline", () => {
    expect(() =>
      SpawnAgentSchema.parse({ name: "a\nb", role: "r", capabilities: [] })
    ).toThrow();
  });
  it("rejects name with double quote", () => {
    expect(() => SpawnAgentSchema.parse({ name: 'a"b', role: "r", capabilities: [] })).toThrow();
  });
  it("rejects name with single quote", () => {
    expect(() => SpawnAgentSchema.parse({ name: "a'b", role: "r", capabilities: [] })).toThrow();
  });

  // Class 2 — cwd injection at the zod layer
  it("rejects cwd with $(cmd) substitution", () => {
    expect(() =>
      SpawnAgentSchema.parse({ name: "x", role: "r", capabilities: [], cwd: "/tmp/$(id)" })
    ).toThrow();
  });
  it("rejects cwd with backtick", () => {
    expect(() =>
      SpawnAgentSchema.parse({ name: "x", role: "r", capabilities: [], cwd: "/tmp/`id`" })
    ).toThrow();
  });
  it("rejects cwd with semicolon", () => {
    expect(() =>
      SpawnAgentSchema.parse({ name: "x", role: "r", capabilities: [], cwd: "/tmp/a;b" })
    ).toThrow();
  });
  it("rejects relative cwd (no leading /)", () => {
    expect(() =>
      SpawnAgentSchema.parse({ name: "x", role: "r", capabilities: [], cwd: "relative/path" })
    ).toThrow();
  });
  it("rejects cwd with CRLF", () => {
    expect(() =>
      SpawnAgentSchema.parse({ name: "x", role: "r", capabilities: [], cwd: "/tmp/a\r\nb" })
    ).toThrow();
  });
  it("rejects cwd with null byte", () => {
    expect(() =>
      SpawnAgentSchema.parse({ name: "x", role: "r", capabilities: [], cwd: "/tmp/a\x00b" })
    ).toThrow();
  });

  // Class 3 — length limits
  it("rejects name > 64 chars", () => {
    expect(() =>
      SpawnAgentSchema.parse({ name: "a".repeat(65), role: "r", capabilities: [] })
    ).toThrow();
  });
  it("rejects cwd > 1024 chars", () => {
    const longCwd = "/" + "a".repeat(1024);
    expect(() =>
      SpawnAgentSchema.parse({ name: "x", role: "r", capabilities: [], cwd: longCwd })
    ).toThrow();
  });

  // Class 4 — defense-in-depth: fabricated input bypassing zod proves the
  // driver's embedding is still safe.
  it("(defense-in-depth) Linux tmux path escapes single-quoted cwd even if zod relaxes", () => {
    const tmuxCtx = makeCtx(["tmux"]);
    // Bypass zod by calling the driver directly with a hostile cwd that
    // would normally be rejected. Asserts the POSIX quote-escape pattern
    // '\'' (close, literal, reopen) is applied so the shell cannot be
    // broken out of.
    const hostileInput = { name: "safe-1", role: "r", capabilities: [], cwd: "/tmp/a'; rm -rf /; echo '" } as any;
    const cmd = linuxDriver.buildCommand(hostileInput, tmuxCtx);
    // The launch command is the LAST argv element for tmux (bash -lc "...").
    const launchArg = cmd.args[cmd.args.length - 1];
    // The hostile single-quote MUST be escaped with the POSIX idiom '\''
    expect(launchArg).toContain(`'\\''`);
    // And must NOT contain a bare unescaped single-quote break-out — the
    // raw payload `'; rm -rf /; echo '` should NOT appear as-is.
    expect(launchArg).not.toContain(`/tmp/a'; rm -rf /; echo '`);
  });

  it("(argv-separation) every other Linux sub-driver passes launch as own argv element, never concatenated", () => {
    for (const subEmulator of ["gnome-terminal", "konsole", "xterm"]) {
      const ctx = makeCtx([subEmulator]);
      const cmd = linuxDriver.buildCommand(baseInput(), ctx);
      // The launch string (cd '...' && exec claude) is one discrete argv
      // element — the emulator's own -e / -- flag separates it from the
      // emulator's binary. No shell interpolation of the agent identity.
      expect(cmd.args).toContain("-lc");
      const lcIdx = cmd.args.indexOf("-lc");
      expect(cmd.args[lcIdx + 1]).toMatch(/^cd '.*' && exec claude$/);
    }
  });
});

describe("adversarial payloads — Windows driver parity (v1.9.1 Blocker 1)", () => {
  // Windows driver reuses the same zod schema, so payload rejection at the
  // boundary is already covered by the Linux block above. Windows-specific
  // assertions focus on cmd.exe / powershell / wt argv-separation.

  it("(argv-separation) wt.exe receives cwd as its own argv element, not concatenated", () => {
    const ctx = makeCtx(["wt.exe"]);
    const cmd = windowsDriver.buildCommand(baseInput({ cwd: "C:\\work" }), ctx);
    // Expect: ["-d", "C:\\work", "claude"] — cwd as a discrete argv element
    expect(cmd.args).toEqual(["-d", "C:\\work", "claude"]);
    // cwd must be its own argv element (index 1), NOT merged with the flag
    expect(cmd.args[1]).toBe("C:\\work");
    expect(cmd.args.some((a) => a.includes("-d C:\\work"))).toBe(false);
  });

  it("(argv-separation) cmd.exe receives the whole compound command as one argv, no shell-meta leakage", () => {
    const ctx = makeCtx(["cmd.exe"]);
    const cmd = windowsDriver.buildCommand(baseInput({ cwd: "C:\\work" }), ctx);
    // /K is its own argv, the compound "cd /D ... && claude" is another single argv
    expect(cmd.args[0]).toBe("/K");
    expect(cmd.args.length).toBe(2);
    // The compound string should be exactly the expected form
    expect(cmd.args[1]).toBe('cd /D "C:\\work" && claude');
  });

  it("(defense-in-depth) PowerShell driver doubles single quotes inside cwd even if zod relaxes (v1.9.1)", () => {
    const ctx = makeCtx(["powershell.exe"]);
    // Fabricated input: zod would reject this, but we pass it directly to
    // prove the driver's PowerShell-literal embedding is safe.
    const hostile = { name: "safe-w", role: "r", capabilities: [], cwd: "C:\\a'; whoami; '" } as any;
    const cmd = windowsDriver.buildCommand(hostile, ctx);
    // The -Command arg must contain DOUBLED single quotes ('') — PowerShell's
    // own quote-escape rule — around the cwd
    expect(cmd.args[2]).toContain(`''`);
    // And the raw hostile payload must NOT appear as-is (i.e., no
    // successful quote-break into whoami)
    expect(cmd.args[2]).not.toContain(`C:\\a'; whoami; '`);
    // Command starts with Set-Location -LiteralPath ' (single quote begins literal)
    expect(cmd.args[2]).toMatch(/^Set-Location -LiteralPath '.*'; claude$/);
  });

  it("(zod parity) Windows driver is gated by the same allowlist — hostile name rejected", () => {
    expect(() =>
      SpawnAgentSchema.parse({ name: "$(whoami)", role: "r", capabilities: [] })
    ).toThrow();
  });

  it("(override case-variance) RELAY_TERMINAL_APP=WT on Windows → accepted as 'wt' (lowercased)", () => {
    expect(resolveTerminalOverride("WT", "win32")).toBe("wt");
    expect(resolveTerminalOverride("PowerShell", "win32")).toBe("powershell");
  });

  it("(override unknown) random string on Windows returns null (fallthrough)", () => {
    expect(resolveTerminalOverride("windows-explorer", "win32")).toBeNull();
    expect(resolveTerminalOverride("bash.exe", "win32")).toBeNull();
  });

  it("(CWD length bypass) Windows driver respects zod's 1024-char limit", () => {
    expect(() =>
      SpawnAgentSchema.parse({
        name: "x",
        role: "r",
        capabilities: [],
        cwd: "C:\\" + "a".repeat(1024),
      })
    ).toThrow();
  });

  it("(normalize) forward-slash cwd → backslash, even with mixed separators", () => {
    const ctx = makeCtx(["wt.exe"]);
    const cmd = windowsDriver.buildCommand(baseInput({ cwd: "C:/a\\b/c" }), ctx);
    expect(cmd.args).toContain("C:\\a\\b\\c");
  });
});

// v1.9.1 Blocker 3 — tmux collision: two same-named agents produce distinct sessions.
describe("tmux session-name collision safety (v1.9.1 Blocker 3)", () => {
  it("two spawns with the same agent name produce DIFFERENT tmux session names", () => {
    const tmuxCtx = makeCtx(["tmux"]);
    const cmd1 = linuxDriver.buildCommand(baseInput({ name: "dupe" }), tmuxCtx);
    const cmd2 = linuxDriver.buildCommand(baseInput({ name: "dupe" }), tmuxCtx);
    const session1 = cmd1.args[cmd1.args.indexOf("-s") + 1];
    const session2 = cmd2.args[cmd2.args.indexOf("-s") + 1];
    expect(session1).toMatch(/^dupe-[0-9a-f]{4}$/);
    expect(session2).toMatch(/^dupe-[0-9a-f]{4}$/);
    // Very high probability of being distinct (65,536 space); collision would
    // manifest as a flaky test, which is itself a signal of a problem.
    expect(session1).not.toBe(session2);
  });

  it("session name suffix ONLY appears in the tmux path — other sub-drivers untouched", () => {
    // gnome-terminal / konsole / xterm don't use a session name concept.
    // Their args should contain just the emulator flags + bash -lc launch.
    const gctx = makeCtx(["gnome-terminal"]);
    const gcmd = linuxDriver.buildCommand(baseInput({ name: "dupe" }), gctx);
    // The agent name "dupe" should NOT appear in gnome-terminal args
    // (session suffix is tmux-specific).
    expect(gcmd.args.some((a) => a.includes("dupe-"))).toBe(false);
  });
});
