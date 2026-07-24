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
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY = path.join(REPO_ROOT, "bin", "relay");

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, [RELAY, ...args], { encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

/** Subcommands whose usage text previously poisoned stdout on the error path.
 *  recover / purge-history / pair were MISSED by the original sweep — they kept
 *  a `printUsage()` that wrote to stdout unconditionally, so a missing-arg error
 *  still leaked 690–1109 bytes of "Usage:" to stdout (2026-07-24 fix). */
const AFFECTED = [
  "send",
  "resolve",
  "watch",
  "list-instances",
  "use-instance",
  "mint-token",
  "recover",
  "purge-history",
  "pair",
];

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

describe("a MISSING required argument writes nothing to stdout (the leak the bad-flag cases missed)", () => {
  // The bad-FLAG cases above never caught this: recover/purge-history/pair
  // REJECT an unknown flag before printing usage (silent exit 1), but a
  // MISSING required positional fell through to `printUsage()` which wrote to
  // stdout. `$(relay recover)` captured 690 bytes of help as if it were a value.
  const cases: Array<[string, string[]]> = [
    ["send", ["send"]], // missing <to>/<content>
    ["resolve", ["resolve"]], // missing <message-id>
    ["recover", ["recover"]], // missing <agent-name>
    ["purge-history", ["purge-history"]], // missing <agent-name>
    ["pair", ["pair"]], // missing <hub-url>
  ];
  for (const [name, argv] of cases) {
    it(`\`relay ${name}\` with no required arg → stdout EMPTY, non-zero exit, usage on stderr`, () => {
      const r = run(argv);
      expect(r.stdout, `${name} leaked ${r.stdout.length} bytes to stdout`).toBe("");
      expect(r.status).not.toBe(0);
      expect(r.stderr.length).toBeGreaterThan(0); // the operator still sees the error/usage
    });
  }
});

describe("`relay send` puts a CLEAN id on stdout, the confirmation on stderr", () => {
  it("a successful send writes ONLY the message id to stdout; the ✓ line goes to stderr", async () => {
    // In-process so we can mock the daemon fetch. A shape-valid env token makes
    // send use it directly (no DB/vault), so the only stdout write is the id.
    const { run: sendRun } = await import("../src/cli/send.js");
    const saved = process.env.RELAY_AGENT_TOKEN;
    process.env.RELAY_AGENT_TOKEN = "AbCd1234efGH5678ijKL9012mnOP3456"; // matches TOKEN_SHAPE_RE
    const out: string[] = [];
    const err: string[] = [];
    const outSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((c: unknown) => {
        out.push(String(c));
        return true;
      }) as typeof process.stdout.write);
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((c: unknown) => {
        err.push(String(c));
        return true;
      }) as typeof process.stderr.write);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, message_id: "m-abc-123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    try {
      const code = await sendRun(["rcpt", "hello world", "--from", "sender"]);
      expect(code).toBe(0);
      // STDOUT: exactly the id — cleanly parseable, nothing else.
      expect(out.join("").trim()).toBe("m-abc-123");
      expect(out.join("")).not.toMatch(/sent|✓/);
      // STDERR: the human-facing confirmation (still visible interactively).
      expect(err.join("")).toMatch(/✓ sent .*message from "sender" to "rcpt"/);
    } finally {
      fetchSpy.mockRestore();
      outSpy.mockRestore();
      errSpy.mockRestore();
      if (saved === undefined) delete process.env.RELAY_AGENT_TOKEN;
      else process.env.RELAY_AGENT_TOKEN = saved;
    }
  });

  it("a success response WITHOUT a message_id → NON-ZERO exit + EMPTY stdout (never a silent empty capture)", async () => {
    // codex-5-5's #130 re-audit repro: HTTP 200 + {success:true} but NO
    // message_id. The old default path printed the id only when present yet
    // returned 0 unconditionally → `id=$(relay send …)` captured "" at exit 0 —
    // the exact silent-capture failure the id-only contract exists to prevent.
    const { run: sendRun } = await import("../src/cli/send.js");
    const saved = process.env.RELAY_AGENT_TOKEN;
    process.env.RELAY_AGENT_TOKEN = "AbCd1234efGH5678ijKL9012mnOP3456";
    const out: string[] = [];
    const err: string[] = [];
    const outSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((c: unknown) => {
        out.push(String(c));
        return true;
      }) as typeof process.stdout.write);
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((c: unknown) => {
        err.push(String(c));
        return true;
      }) as typeof process.stderr.write);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          // success — but NO message_id in the body
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    try {
      const code = await sendRun(["rcpt", "hello world", "--from", "sender"]);
      // Non-zero exit so `set -e` / `||` guards and $()-capture checks fail loudly.
      expect(code).not.toBe(0);
      // STDOUT stays EMPTY — nothing capturable, so "" is never bound as an id.
      expect(out.join(""), `stdout leaked ${out.join("").length} bytes`).toBe("");
      // The operator still sees WHY, on STDERR.
      expect(err.join("")).toMatch(/no usable message_id/);
    } finally {
      fetchSpy.mockRestore();
      outSpy.mockRestore();
      errSpy.mockRestore();
      if (saved === undefined) delete process.env.RELAY_AGENT_TOKEN;
      else process.env.RELAY_AGENT_TOKEN = saved;
    }
  });
});
