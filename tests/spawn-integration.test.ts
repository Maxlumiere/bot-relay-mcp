// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect } from "vitest";
import cp from "child_process";
import fs from "fs";
import os from "os";
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
    // v2.1.3 (I7): self-history verification reflex. Before rejecting a
    // relay message as injection, the spawned agent must re-check its own
    // history. The phrase "rejecting" + "injection" + "verify your own
    // history" disambiguates this from the basic "check inbox" phrasing.
    expect(r.stdout).toContain("rejecting");
    expect(r.stdout).toContain("injection");
    expect(r.stdout).toContain("verify");
    expect(r.stdout).toMatch(/your\\? own\\? history/);
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

// ---------------------------------------------------------------------------
// v2.1.4 (I10): brief_file_path — durable task-brief pointer
// ---------------------------------------------------------------------------
describe("spawn-agent.sh — v2.1.4 brief_file_path (I10)", () => {
  function writeBrief(name: string, contents: string): string {
    const p = path.join(
      path.join("/tmp", `relay-brief-${process.pid}-${name}`)
    );
    fs.writeFileSync(p, contents, "utf8");
    return p;
  }

  // v2.1.5: brief_file_path KICKSTART now wired into Linux + Windows drivers
  // too (see tests/spawn-drivers.test.ts for TS-level coverage). This integration
  // test still asserts against bin/spawn-agent.sh stdout, which is the macOS path
  // — keep it macOS-only at the assertion level (the bash script doesn't run on
  // Linux/Windows runners). Linux/Windows assertions live in spawn-drivers.test.ts.
  it.skipIf(process.platform !== "darwin")("default spawn with valid brief path embeds the pointer sentence in KICKSTART", async () => {
    const brief = writeBrief("ok", "# Task brief\n\nDo the thing.");
    try {
      // v2.6.1: brief_file_path is arg 5 (was arg 6 pre-v2.6.1 when token was arg 5).
      const r = await runSpawn(["builder-1", "builder", "", "/tmp", brief]);
      expect(r.code).toBe(0);
      // The default KICKSTART is still present
      expect(r.stdout).toContain("mcp__bot-relay__get_messages");
      // v2.7.4 — the kickstart is now wrapped by shell_escape_double
      // ("..." quoted form) instead of printf '%q' ($'...' form). The
      // bash-script-internal backticks around the brief path stay literal
      // in the KICKSTART variable but get backslash-escaped by the helper
      // (backticks inside "..." would otherwise trigger command substitution).
      // When bash actually parses CMD, the backslash-backtick collapses
      // back to a literal backtick, so claude still sees `<brief>`.
      expect(r.stdout).toContain("Your full brief lives at");
      expect(r.stdout).toContain(`\\\`${brief}\\\``);
      expect(r.stdout).toContain("canonical source");
    } finally {
      try { fs.unlinkSync(brief); } catch {}
    }
  });

  it("non-existent brief path rejects with exit 2", async () => {
    const ghost = `/tmp/relay-brief-ghost-${process.pid}-does-not-exist.md`;
    const r = await runSpawn(["builder-1", "builder", "", "/tmp", ghost]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("does not exist");
  });

  it("path-injection attempt rejects with exit 2", async () => {
    const r = await runSpawn([
      "builder-1",
      "builder",
      "",
      "/tmp",
      "/tmp/$(whoami).md",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr.toLowerCase()).toMatch(/brief_file_path|metachar|allowlist/);
    expect(r.stdout).not.toContain("whoami");
  });

  it("relative brief path rejects with exit 2", async () => {
    const r = await runSpawn([
      "builder-1",
      "builder",
      "",
      "/tmp",
      "./brief.md",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("absolute path");
  });

  it("oversized brief (>10KB) rejects with exit 2", async () => {
    const big = writeBrief("big", "x".repeat(10241));
    try {
      const r = await runSpawn(["builder-1", "builder", "", "/tmp", big]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("10240 bytes");
    } finally {
      try { fs.unlinkSync(big); } catch {}
    }
  });

  it("RELAY_SPAWN_NO_KICKSTART=1 + brief_file_path → no brief pointer in CMD (no-kickstart wins)", async () => {
    const brief = writeBrief("nokickstart", "# brief");
    try {
      const r = await runSpawnWithEnv(
        ["builder-1", "builder", "", "/tmp", brief],
        { RELAY_SPAWN_NO_KICKSTART: "1" }
      );
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("Your full brief lives at");
      expect(r.stdout).not.toContain("mcp__bot-relay__get_messages");
    } finally {
      try { fs.unlinkSync(brief); } catch {}
    }
  });

  it("RELAY_SPAWN_KICKSTART override + brief_file_path → override wins, no brief pointer", async () => {
    const brief = writeBrief("override", "# brief");
    try {
      const r = await runSpawnWithEnv(
        ["builder-1", "builder", "", "/tmp", brief],
        { RELAY_SPAWN_KICKSTART: "customPromptFromOperator" }
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("customPromptFromOperator");
      // Operator override is preserved verbatim — we do NOT silently append.
      expect(r.stdout).not.toContain("Your full brief lives at");
    } finally {
      try { fs.unlinkSync(brief); } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// v2.7.2 — RELAY_AGENT_NAME propagation contract test
// ---------------------------------------------------------------------------
//
// The bug behind v2.7.2: a spawn via mcp__bot-relay__spawn_agent produces a
// child terminal where the SessionStart hook reports identity unresolved.
// The investigation hypothesized five candidate causes; this
// test pins the *script-side* contract end-to-
// end so any future drift inside bin/spawn-agent.sh that breaks the export-
// before-claude ordering, the printf %q escaping, or the inline AS_CMD
// structure fails LOUDLY here, not silently in a 20-minute live spawn.
//
// What this DOES test:
//   - bin/spawn-agent.sh's dry-run CMD, when executed in a clean subshell,
//     puts RELAY_AGENT_NAME=<expected> into the env that `claude` would
//     inherit AND into any subprocess `claude` forks.
//   - Plain, hyphenated, and dotted names all survive printf %q round-trip.
//
// What this does NOT test:
//   - Whether the real `claude` binary preserves RELAY_* in hook subprocess
//     env. That layer is opaque from outside and is the suspected root
//     cause; the v2.7.2 defense-in-depth manifest fallback in
//     hooks/check-relay.sh is what closes it.
//   - iTerm2 `write text` truncation. That's a transport-layer concern
//     between osascript and the child shell that no unit test can hit.
describe("spawn-agent.sh — v2.7.2 RELAY_AGENT_NAME propagation contract", () => {
  // Execute the CMD produced by RELAY_SPAWN_DRY_RUN=1 in a clean subshell,
  // substituting `claude` with a stub that dumps env to a file AND forks a
  // subprocess whose env is also dumped. Returns the captured envs.
  async function runCmdWithClaudeStub(args: string[]): Promise<{
    parentEnv: string;
    childEnv: string;
    cmdExitCode: number | null;
    cmdStderr: string;
  }> {
    const dry = await runSpawn(args);
    expect(dry.code, `dry-run failed for args ${JSON.stringify(args)}: ${dry.stderr}`).toBe(0);

    // Extract the CMD line (single line of bash separated by ; tokens).
    const cmdMatch = dry.stdout.match(/^CMD=(.*)$/m);
    expect(cmdMatch, `CMD= line missing from dry-run stdout`).not.toBeNull();
    const cmd = cmdMatch![1];

    // Build a temp stub directory containing a `claude` script that:
    //   1. dumps its own env to parent-env.txt
    //   2. forks `bash -c 'env > child-env.txt'` to mirror the case where
    //      claude invokes hooks/check-relay.sh as a subprocess.
    // Then prepend the stub dir to PATH so the CMD's `claude` invocation
    // resolves to the stub, not the real claude binary.
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), `relay-v272-stub-${process.pid}-`));
    try {
      const parentEnvFile = path.join(stubDir, "parent-env.txt");
      const childEnvFile = path.join(stubDir, "child-env.txt");
      const claudeStub = path.join(stubDir, "claude");
      const stubScript =
        `#!/bin/bash\n` +
        `env > "${parentEnvFile}"\n` +
        `bash -c 'env > "${childEnvFile}"'\n` +
        `exit 0\n`;
      fs.writeFileSync(claudeStub, stubScript, { mode: 0o755 });

      // Execute the CMD in a minimal env. We deliberately do NOT inherit
      // RELAY_AGENT_* from the test process so a stale env can't contaminate
      // the assertion.
      const minimalEnv: NodeJS.ProcessEnv = {
        PATH: `${stubDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: process.env.HOME ?? "/tmp",
        // No RELAY_AGENT_NAME, no RELAY_AGENT_TOKEN — must be set by CMD.
      };

      const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const proc = cp.spawn("bash", ["-c", cmd], { env: minimalEnv });
        let stderr = "";
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("exit", (code) => resolve({ code, stderr }));
      });

      const parentEnv = fs.existsSync(parentEnvFile)
        ? fs.readFileSync(parentEnvFile, "utf8")
        : "";
      const childEnv = fs.existsSync(childEnvFile)
        ? fs.readFileSync(childEnvFile, "utf8")
        : "";

      return {
        parentEnv,
        childEnv,
        cmdExitCode: result.code,
        cmdStderr: result.stderr,
      };
    } finally {
      try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch {}
    }
  }

  // Asserting on the env's literal line `RELAY_AGENT_NAME=<expected>` is the
  // contract: every reader of the env, including any hook subprocess, sees
  // exactly the requested name. This is NOT a proxy assertion against the
  // CMD string — the CMD-string assertions exist elsewhere in this file. By
  // executing CMD in a real shell and reading the resulting env, we exercise
  // the same code path the iTerm2 child shell would. The only delta between
  // this test and the live spawn is the osascript `write text` transport,
  // which is outside the script's contract.
  it.each([
    ["plain", "worker1"],
    ["hyphenated", "mem-build-agent"],
    ["dotted", "pod.alpha"],
  ])("[contract] %s name '%s' reaches both claude env AND its subprocess env", async (_label, name) => {
    const { parentEnv, childEnv, cmdExitCode, cmdStderr } = await runCmdWithClaudeStub([
      name,
      "builder",
      "build,test",
      "/tmp",
    ]);

    expect(cmdExitCode, `cmd exit non-zero. stderr: ${cmdStderr}`).toBe(0);
    expect(parentEnv, `parent-env capture empty — claude stub did not run`).not.toBe("");
    expect(childEnv, `child-env capture empty — claude stub did not fork subprocess`).not.toBe("");

    // Exact toBe-equivalent line match — RELAY_AGENT_NAME must equal the
    // requested name verbatim, no surrounding quoting artifacts, no shell
    // substitution residue.
    const parentLine = parentEnv.split("\n").find((l) => l.startsWith("RELAY_AGENT_NAME="));
    const childLine = childEnv.split("\n").find((l) => l.startsWith("RELAY_AGENT_NAME="));
    expect(parentLine, `RELAY_AGENT_NAME not in parent env for ${name}`).toBe(`RELAY_AGENT_NAME=${name}`);
    expect(childLine, `RELAY_AGENT_NAME not in subprocess env for ${name}`).toBe(`RELAY_AGENT_NAME=${name}`);
  });

  it("[contract] RELAY_AGENT_ROLE + RELAY_AGENT_CAPABILITIES also propagate", async () => {
    const { parentEnv } = await runCmdWithClaudeStub([
      "worker1",
      "researcher",
      "search,summarize",
      "/tmp",
    ]);
    const roleLine = parentEnv.split("\n").find((l) => l.startsWith("RELAY_AGENT_ROLE="));
    const capsLine = parentEnv.split("\n").find((l) => l.startsWith("RELAY_AGENT_CAPABILITIES="));
    expect(roleLine).toBe("RELAY_AGENT_ROLE=researcher");
    expect(capsLine).toBe("RELAY_AGENT_CAPABILITIES=search,summarize");
  });
});

// ---------------------------------------------------------------------------
// v2.7.4 — kickstart apostrophe-quoting fix (Bug 1: spawn-agent
// kickstart-quoting).
//
// Pre-fix, the script wrapped KICKSTART via `printf '%q'` which emits
// values in `$'...'` ANSI-C-quoted form. Inside `$'...'`, a literal `'`
// terminates the string — any kickstart containing an apostrophe wedged
// the spawned subshell at `quote>` continuation, forever.
//
// Fix (Option C from brief — defense in depth):
//   (A) sanitize the DEFAULT kickstart so it has zero apostrophes
//       (status=all instead of status='all', etc.)
//   (B) replace `printf '%q'` with `shell_escape_double` for the
//       kickstart specifically, which emits `"..."`-quoted output where
//       `'` is just a literal.
// ---------------------------------------------------------------------------
describe("spawn-agent.sh — v2.7.4 kickstart apostrophe-quoting fix", () => {
  /** Extract the CMD line from dry-run stdout. */
  function extractCmd(stdout: string): string {
    const line = stdout.split("\n").find((l) => l.startsWith("CMD="));
    if (!line) throw new Error(`no CMD= line in dry-run stdout:\n${stdout}`);
    return line.replace(/^CMD=/, "");
  }

  it("(K1) default kickstart contains NO apostrophes — Bug 1 safety net", async () => {
    // Option A: the default prompt must never contain a literal `'` so
    // that even if a future maintainer reverts the helper (Option B),
    // the default at least stays parseable.
    const r = await runSpawn(["builder-1", "builder", "build", "/tmp"]);
    expect(r.code).toBe(0);
    const cmd = extractCmd(r.stdout);
    // The brief specifically called out three offending substrings; the
    // sanitized form replaces the quoted enum values with unquoted ones.
    expect(cmd).toContain("status=all");
    expect(cmd).toContain("since=session_start");
    expect(cmd).toContain("since=1h");
    expect(cmd).not.toContain("status='all'");
    expect(cmd).not.toContain("since='session_start'");
    expect(cmd).not.toContain("since='1h'");
  });

  it("(K2) default-kickstart CMD parses cleanly under `bash -n` — no quote> wedge", async () => {
    // The regression that actually mattered: pre-fix, the assembled CMD
    // wedged any subshell that tried to parse it because of unbalanced
    // $'...' quoting. `bash -n` (syntax-check, no execute) returns
    // non-zero on unbalanced quotes. Post-fix, it must succeed.
    const r = await runSpawn(["builder-1", "builder", "build", "/tmp"]);
    expect(r.code).toBe(0);
    const cmd = extractCmd(r.stdout);
    const parse = cp.spawnSync("bash", ["-n"], { input: cmd, encoding: "utf8" });
    expect(parse.status, `bash -n stderr: ${parse.stderr}`).toBe(0);
  });

  it("(K3) RELAY_SPAWN_KICKSTART with apostrophes parses cleanly — root-cause fix", async () => {
    // The original bug repro: an apostrophe-laden kickstart used to
    // produce a CMD with unbalanced $'...' quoting that wedged at
    // quote>. With shell_escape_double, apostrophes are literal inside
    // "..." and the CMD parses without issue.
    const r = await runSpawnWithEnv(["builder-1", "builder", "build", "/tmp"], {
      RELAY_SPAWN_KICKSTART:
        "poll inbox with status='all' since='session_start' limit='20'",
    });
    expect(r.code).toBe(0);
    const cmd = extractCmd(r.stdout);
    // The full kickstart content must reach claude — verify the literal
    // substrings (including the apostrophes) survive the quoting.
    expect(cmd).toContain("status='all'");
    expect(cmd).toContain("since='session_start'");
    const parse = cp.spawnSync("bash", ["-n"], { input: cmd, encoding: "utf8" });
    expect(parse.status, `bash -n stderr: ${parse.stderr}`).toBe(0);
  });

  it("(K4) RELAY_SPAWN_KICKSTART containing every shell-special char parses cleanly", async () => {
    // The defense the helper was designed for: `, $, ", \, and ` all
    // need escaping inside "...". Apostrophes don't, but they're the
    // ones that hit the original bug. Pre-fix output for this input
    // would have wedged on multiple counts.
    const messy = `payload with ' and " and \\ and $ and \`backtick\` and 'multiple' 'quotes'`;
    const r = await runSpawnWithEnv(["builder-1", "builder", "build", "/tmp"], {
      RELAY_SPAWN_KICKSTART: messy,
    });
    expect(r.code).toBe(0);
    const cmd = extractCmd(r.stdout);
    // Verify the shell parses the assembled CMD without any quoting
    // errors. We deliberately don't assert "the literal string equals
    // X" — that requires modeling the helper's escape table here, which
    // is brittle. The contract that matters is "bash -n is happy".
    const parse = cp.spawnSync("bash", ["-n"], { input: cmd, encoding: "utf8" });
    expect(parse.status, `bash -n stderr: ${parse.stderr}`).toBe(0);
  });

  it("(K5) RELAY_SPAWN_KICKSTART round-trip: literal content reaches claude", async () => {
    // End-to-end check that the shell-level escaping is undone when
    // bash parses the CMD. We execute the assembled command in a
    // controlled subshell (with claude stubbed) and capture what
    // argument actually reaches the program. The kickstart content
    // (literal apostrophes and all) must arrive intact.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "k5-"));
    try {
      const stubDir = path.join(tmpRoot, "stub");
      fs.mkdirSync(stubDir);
      const stubPath = path.join(stubDir, "claude");
      const argDumpPath = path.join(tmpRoot, "args.txt");
      fs.writeFileSync(
        stubPath,
        "#!/bin/bash\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > " +
          JSON.stringify(argDumpPath) +
          "\nexit 0\n",
        { mode: 0o755 },
      );
      const kickstart =
        "round-trip with apostrophe: status='all', since='1h'. Done.";
      const dry = await runSpawnWithEnv(
        ["k5-agent", "builder", "build", "/tmp"],
        { RELAY_SPAWN_KICKSTART: kickstart },
      );
      expect(dry.code).toBe(0);
      const cmd = extractCmd(dry.stdout);
      // Run the assembled CMD in a controlled subshell with the stub on PATH.
      const run = cp.spawnSync("bash", ["-c", cmd], {
        env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });
      expect(run.status, `subshell stderr: ${run.stderr}`).toBe(0);
      const args = fs.readFileSync(argDumpPath, "utf8");
      // The kickstart is passed as ONE argument to claude. The last
      // dumped arg must equal the original kickstart string verbatim.
      const lastArg = args.split("\n").filter(Boolean).pop();
      expect(lastArg).toBe(kickstart);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
