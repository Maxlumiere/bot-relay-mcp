// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect } from "vitest";
import cp from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT = path.resolve(__dirname, "..", "bin", "spawn-agent.sh");

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run bin/spawn-agent.sh with RELAY_SPAWN_DRY_RUN=1 so it emits the final
 * commands without actually opening a terminal. This lets us feed attack
 * payloads and verify the hardening layers REALLY keep executable shell out.
 */
function runSpawn(args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(SCRIPT, args, {
      env: { ...process.env, RELAY_SPAWN_DRY_RUN: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
  });
}

describe("spawn-agent.sh integration — legitimate input", () => {
  it("accepts a well-formed name/role/caps/cwd", async () => {
    const r = await runSpawn(["builder-1", "builder", "build,test", "/tmp/workspace"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("CMD=");
    expect(r.stdout).toContain("RELAY_AGENT_NAME=builder-1");
    expect(r.stdout).toContain("RELAY_AGENT_ROLE=builder");
    // Literal newlines and unexpected shell-exec markers should be absent
    expect(r.stdout.split("\n").length).toBeLessThan(10);
  });
});

describe("spawn-agent.sh integration — attack payloads blocked", () => {
  const REJECT_EXIT = 2;

  // v1.6.4: extended helper. Every attack test uses this for consistency.
  //   - exit code MUST be REJECT_EXIT
  //   - stderr MUST be non-empty (silent failures fail the test)
  //   - stderr MAY be asserted to contain a specific keyword
  //   - stdout MAY be asserted to NOT contain a leaked attack payload
  interface AssertBlockedOpts {
    stderrContains?: string;
    stdoutNotContains?: string;
  }
  function assertBlocked(r: SpawnResult, opts: AssertBlockedOpts = {}) {
    expect(r.code, `expected exit ${REJECT_EXIT} got ${r.code}. stderr: ${r.stderr}`).toBe(REJECT_EXIT);
    expect(r.stderr.trim().length, "expected non-empty stderr (no silent failures)").toBeGreaterThan(0);
    if (opts.stderrContains) {
      expect(r.stderr).toContain(opts.stderrContains);
    }
    if (opts.stdoutNotContains) {
      expect(r.stdout).not.toContain(opts.stdoutNotContains);
    }
  }

  it("blocks semicolon command chaining in name", async () => {
    const r = await runSpawn(["a; rm -rf /", "builder"]);
    assertBlocked(r, { stderrContains: "invalid", stdoutNotContains: "rm -rf" });
  });

  it("blocks pipe operator in name", async () => {
    const r = await runSpawn(["a|wall", "builder"]);
    assertBlocked(r);
  });

  it("blocks ampersand background-exec in name", async () => {
    const r = await runSpawn(["a&curl evil.com", "builder"]);
    assertBlocked(r);
  });

  it("blocks $() command substitution in name", async () => {
    const r = await runSpawn(["$(whoami)", "builder"]);
    assertBlocked(r, { stdoutNotContains: "whoami" });
  });

  it("blocks backtick command substitution in name", async () => {
    const r = await runSpawn(["`whoami`", "builder"]);
    assertBlocked(r, { stdoutNotContains: "whoami" });
  });

  it("blocks newline injection in role", async () => {
    const r = await runSpawn(["agent", "builder\nrm -rf /"]);
    assertBlocked(r, { stdoutNotContains: "rm -rf" });
  });

  it("blocks double-quote injection in name", async () => {
    const r = await runSpawn(['a"b', "builder"]);
    assertBlocked(r);
  });

  it("blocks single-quote injection in name", async () => {
    const r = await runSpawn(["a'b", "builder"]);
    assertBlocked(r);
  });

  it("blocks AppleScript quote-mixing via embedded backslash-quote", async () => {
    // Even if shell quoting passed, the AppleScript layer would break.
    // Our allowlist doesn't accept backslash anyway.
    const r = await runSpawn(['a\\"b', "builder"]);
    assertBlocked(r);
  });

  it("blocks dollar-sign variable expansion in capabilities", async () => {
    const r = await runSpawn(["agent", "builder", "$HOME,test"]);
    assertBlocked(r);
  });

  it("blocks relative cwd (path traversal)", async () => {
    const r = await runSpawn(["agent", "builder", "", "../../etc"]);
    assertBlocked(r, { stderrContains: "absolute path" });
  });

  it("blocks cwd with command substitution", async () => {
    const r = await runSpawn(["agent", "builder", "", "/tmp/$(touch /tmp/pwn)"]);
    assertBlocked(r);
  });

  it("blocks cwd with backtick", async () => {
    const r = await runSpawn(["agent", "builder", "", "/tmp/`id`"]);
    assertBlocked(r);
  });

  it("blocks cwd with semicolon", async () => {
    const r = await runSpawn(["agent", "builder", "", "/tmp;ls"]);
    assertBlocked(r);
  });

  it("blocks name exceeding 64 chars", async () => {
    const r = await runSpawn(["a".repeat(65), "builder"]);
    assertBlocked(r, { stderrContains: "exceeds" });
  });

  it("blocks RELAY_TERMINAL_APP injection via env var", async () => {
    const child = cp.spawn(SCRIPT, ["agent", "builder"], {
      env: { ...process.env, RELAY_SPAWN_DRY_RUN: "1", RELAY_TERMINAL_APP: "iTerm2; rm -rf /" },
    });
    const result = await new Promise<SpawnResult>((resolve) => {
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
    assertBlocked(result, { stderrContains: "Unsupported" });
  });

  // --- v1.6.3 new attack payloads ---

  it("blocks CRLF mixed injection in role", async () => {
    const r = await runSpawn(["agent", "builder\r\nrm -rf /"]);
    assertBlocked(r, { stdoutNotContains: "rm -rf" });
  });

  it("blocks Unicode NFD normalization attempt in name (non-ASCII rejected)", async () => {
    // Decomposed "é" is 'e' + U+0301 combining acute accent. Our allowlist
    // is ASCII-only ([A-Za-z0-9_.-]) so the combining char is rejected.
    // This test documents the guard and catches any future regression that
    // accidentally broadens the regex to allow Unicode.
    const decomposedE = "e\u0301valuator"; // "évaluator" via NFD
    const r = await runSpawn([decomposedE, "builder"]);
    assertBlocked(r);
  });

  it("blocks symlink path traversal in cwd", async () => {
    // Create a symlink in /tmp pointing to /etc, pass it as cwd, assert rejection
    // by the path-resolution guard (resolved path is outside approved roots).
    const linkPath = `/tmp/v163-bad-link-${process.pid}`;
    try {
      try { fs.unlinkSync(linkPath); } catch {}
      fs.symlinkSync("/etc", linkPath);
      const r = await runSpawn(["agent", "builder", "", linkPath]);
      assertBlocked(r);
      expect(r.stderr.toLowerCase()).toMatch(/resolve|approved|outside/);
    } finally {
      try { fs.unlinkSync(linkPath); } catch {}
    }
  });

  it("blocks long-payload DoS (cwd > 1024 chars)", async () => {
    const longPath = "/tmp/" + "a".repeat(1100);
    const r = await runSpawn(["agent", "builder", "", longPath]);
    assertBlocked(r, { stderrContains: "exceeds" });
  });

  // v1.6.4: bare-path approved root acceptance
  it("accepts cwd that resolves EXACTLY to an approved root (no subpath)", async () => {
    // /tmp is an approved root; passing it bare should not be rejected.
    const r = await runSpawn(["agent", "builder", "", "/tmp"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("CMD=");
  });
});

// ---------------------------------------------------------------------------
// v2.1.2: spawn-agent.sh plug-and-play defaults
// ---------------------------------------------------------------------------
// Helper that runs the spawn script with an optional env override map on top
// of the standard dry-run env. Mirrors runSpawn but lets us flip the new
// RELAY_SPAWN_* knobs without sharing state across tests.
function runSpawnWithEnv(
  args: string[],
  env: Record<string, string>,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(SCRIPT, args, {
      env: { ...process.env, RELAY_SPAWN_DRY_RUN: "1", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
  });
}

describe("spawn-agent.sh — v2.1.2 plug-and-play defaults", () => {
  it("default invocation includes kickstart + bypassPermissions + --name + --effort high", async () => {
    const r = await runSpawn(["builder-1", "builder", "", "/tmp"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--permission-mode bypassPermissions");
    expect(r.stdout).toContain("--effort high");
    expect(r.stdout).toContain("--name builder-1");
    // Default kickstart phrase must reach the claude invocation as a
    // positional. printf %q escapes spaces to `\ `, so we match a contiguous
    // single-word fragment from the default prompt.
    expect(r.stdout).toContain("mcp__bot-relay__get_messages");
  });

  it("RELAY_SPAWN_NO_KICKSTART=1 omits kickstart prompt but keeps flags", async () => {
    const r = await runSpawnWithEnv(["builder-1", "builder", "", "/tmp"], {
      RELAY_SPAWN_NO_KICKSTART: "1",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("mcp__bot-relay__get_messages");
    expect(r.stdout).toContain("--permission-mode bypassPermissions");
    expect(r.stdout).toContain("--effort high");
    expect(r.stdout).toContain("--name builder-1");
  });

  it("RELAY_SPAWN_KICKSTART overrides the default prompt verbatim", async () => {
    const r = await runSpawnWithEnv(["builder-1", "builder", "", "/tmp"], {
      RELAY_SPAWN_KICKSTART: "doSomethingSpecific",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("mcp__bot-relay__get_messages");
    expect(r.stdout).toContain("doSomethingSpecific");
  });

  it("RELAY_SPAWN_PERMISSION_MODE=default restores interactive ask-everything", async () => {
    const r = await runSpawnWithEnv(["builder-1", "builder", "", "/tmp"], {
      RELAY_SPAWN_PERMISSION_MODE: "default",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--permission-mode default");
    expect(r.stdout).not.toContain("--permission-mode bypassPermissions");
  });

  it("invalid RELAY_SPAWN_PERMISSION_MODE rejects with exit 2", async () => {
    const r = await runSpawnWithEnv(["builder-1", "builder", "", "/tmp"], {
      RELAY_SPAWN_PERMISSION_MODE: "evilmode; rm -rf /",
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid RELAY_SPAWN_PERMISSION_MODE");
    // Attack payload must not have leaked into the assembled command.
    expect(r.stdout).not.toContain("rm -rf");
  });

  it("RELAY_SPAWN_DISPLAY_NAME overrides the --name value", async () => {
    const r = await runSpawnWithEnv(["builder-1", "builder", "", "/tmp"], {
      RELAY_SPAWN_DISPLAY_NAME: "medical-phase3",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--name medical-phase3");
    expect(r.stdout).not.toContain("--name builder-1");
  });

  it("RELAY_SPAWN_EFFORT=medium passes --effort medium", async () => {
    const r = await runSpawnWithEnv(["builder-1", "builder", "", "/tmp"], {
      RELAY_SPAWN_EFFORT: "medium",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--effort medium");
    expect(r.stdout).not.toContain("--effort high");
  });

  it("invalid RELAY_SPAWN_EFFORT rejects with exit 2", async () => {
    const r = await runSpawnWithEnv(["builder-1", "builder", "", "/tmp"], {
      RELAY_SPAWN_EFFORT: "ultraturbo; rm -rf /",
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid RELAY_SPAWN_EFFORT");
    expect(r.stdout).not.toContain("rm -rf");
  });
});
