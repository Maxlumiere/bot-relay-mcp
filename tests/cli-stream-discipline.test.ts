// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * CLI STREAM DISCIPLINE — usage/errors to stderr, DATA to stdout.
 *
 * THE BUG THIS LOCKS OUT. The CLI wrote usage text to STDOUT, so a failed
 * command substitution captured it as if it were a value:
 *
 *     RELAY_AGENT_TOKEN=$(relay mint-token NAME --force --json | sed ...)
 *
 * On any failure that captured 1549 bytes of help text instead of yielding
 * empty. The agent then launched with a garbage token, every MCP call returned
 * AUTH_FAILED, and IT LOOKED HEALTHY THE WHOLE TIME. Two real broken launches
 * came from this in one afternoon, including one where RELAY_AGENT_TOKEN was
 * literally the string "Usage:".
 *
 * A failure whose symptom is a PLAUSIBLE WRONG VALUE is the worst shape
 * available, because nothing downstream can distinguish it from a real one. An
 * empty capture, by contrast, fails loudly and immediately.
 *
 * Every documented pattern we ship for external CLIs uses this substitution
 * shape, so this is a first-run experience defect, not an internal papercut.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY = path.join(REPO_ROOT, "bin", "relay");

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, [RELAY, ...args], { encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

/** Subcommands whose usage text previously poisoned stdout on the error path. */
const AFFECTED = ["send", "watch", "list-instances", "use-instance", "mint-token"];

describe("a failed capture yields EMPTY, never a plausible-looking value", () => {
  it("bare `relay` writes nothing to stdout and exits NON-ZERO", () => {
    // Exit 0 here was half the reason the failure was silent: `set -e` and `||`
    // guards both saw success while the caller captured 1549 bytes of usage.
    const r = run([]);
    expect(r.stdout).toBe("");
    expect(r.status).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0); // still reaches the operator
  });

  it("an unknown subcommand writes nothing to stdout", () => {
    const r = run(["definitely-not-a-subcommand"]);
    expect(r.stdout).toBe("");
    expect(r.status).not.toBe(0);
  });

  for (const sub of AFFECTED) {
    it(`\`relay ${sub}\` with a bad flag writes nothing to stdout`, () => {
      const r = run([sub, "--definitely-bad-flag-xyz"]);
      expect(r.stdout, `${sub} poisoned stdout with ${r.stdout.length} bytes`).toBe("");
      expect(r.status).not.toBe(0);
    });
  }

  it("the ACTUAL poisoning shape now yields an empty token", () => {
    // The end-to-end contract, expressed the way a user's script would hit it.
    const r = run(["mint-token"]); // missing required name → failure
    const captured = r.stdout.trim();
    expect(captured).toBe("");
    // and specifically NOT the help text that used to land here
    expect(captured).not.toMatch(/Usage:/);
  });
});

describe("usage still reaches humans — the fix must not break --help", () => {
  for (const sub of AFFECTED) {
    it(`\`relay ${sub} --help\` writes usage to STDOUT`, () => {
      // An explicitly requested help IS the data, so stdout is correct here.
      // Routing everything to stderr would have "fixed" the bug by breaking
      // documentation and every human workflow.
      const r = run([sub, "--help"]);
      expect(r.stdout.length, `${sub} --help produced no stdout`).toBeGreaterThan(0);
      expect(r.stdout).toMatch(/Usage:/);
    });
  }

  it("`relay --help` writes to stdout and exits 0", () => {
    const r = run(["--help"]);
    expect(r.stdout).toMatch(/Usage:/);
    expect(r.status).toBe(0);
  });
});

describe("data paths stay on stdout — the fix must not silence real output", () => {
  it("`cli-profiles` still prints the registry to stdout", () => {
    // Guards over-correction: these were flagged as suspicious during the sweep
    // but they emit REAL DATA at exit 0, which belongs on stdout. Redirecting
    // them would have been the opposite mistake.
    const r = run(["cli-profiles"]);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });
});
