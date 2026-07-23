// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * check-relay.sh mute / wrong-instance diagnostics.
 *
 * These diagnostics tell an agent to STOP ACTING CONNECTED, so a false positive
 * is more harmful than no check at all — the agent obeys it. codex found two on
 * the first cut, both regression-tested here:
 *
 *   HIGH 1 — an explicit RELAY_DB_PATH is a deliberate operator choice.
 *     assertInstanceResolution() already treats it as valid; the hook shouted
 *     WRONG INSTANCE anyway, telling a legitimate legacy-DB session it had lost
 *     its mail. The two halves must not contradict each other.
 *   HIGH 2 — the mute scan matched ANY mcpServers key containing "relay", so an
 *     unrelated stale entry triggered "NO RELAY TOOLS" even while a perfectly
 *     good relay entry existed alongside it.
 *
 * The POSITIVE controls matter as much as the negative ones. The first patch for
 * HIGH 2 used a top-level `return` inside `node -e`, which is an Illegal Return
 * SyntaxError; combined with the hook's `2>/dev/null` it failed SILENTLY and
 * disabled the entire mute check. Every "must stay silent" test still passed,
 * because dead code is silent too. Only a test asserting the warning DOES fire
 * catches that — which is the same silence-as-failure lesson the feature exists
 * to enforce, turned on the feature itself.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks",
  "check-relay.sh",
);

let home: string;

/** Run the hook against a synthetic HOME; returns merged stdout+stderr. */
function runHook(env: Record<string, string> = {}): string {
  try {
    return execFileSync("bash", [HOOK], {
      env: { ...process.env, HOME: home, RELAY_AGENT_NAME: "probe", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

function writeConfig(obj: unknown): void {
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify(obj));
}

const instanceDb = (): string => path.join(home, ".bot-relay", "instances", "work", "relay.db");

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-hook-diag-"));
  fs.mkdirSync(path.join(home, ".bot-relay", "instances", "work"), { recursive: true });
  fs.writeFileSync(path.join(home, ".bot-relay", "relay.db"), "");
  fs.writeFileSync(instanceDb(), "");
});

afterEach(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("codex HIGH 1 — explicit RELAY_DB_PATH is an operator choice, not a fault", () => {
  it("does NOT shout WRONG INSTANCE when RELAY_DB_PATH explicitly selects the legacy DB", () => {
    const out = runHook({ RELAY_DB_PATH: path.join(home, ".bot-relay", "relay.db") });
    expect(out).not.toContain("WRONG INSTANCE");
  });

  it("still shouts WRONG INSTANCE when the legacy DB is reached WITHOUT an explicit override", () => {
    // Positive control for the same guard: removing the override must restore
    // the warning, or the test above could pass simply because it never fires.
    const out = runHook();
    expect(out).toContain("WRONG INSTANCE");
  });
});

describe("codex HIGH 2 — only the CANONICAL relay entry can trigger a mute claim", () => {
  it("does NOT claim mute for an unrelated relay-NAMED server when a real relay entry is healthy", () => {
    writeConfig({
      mcpServers: {
        "relay-status": { command: "node", args: ["/definitely/missing/index.js"] },
        "botrelay-prod": { type: "http", url: "https://relay.example/mcp" },
      },
    });
    const out = runHook({ RELAY_DB_PATH: instanceDb() });
    expect(out).not.toContain("RELAY MUTE");
  });

  it("does NOT claim mute when the canonical entry is a healthy HTTP entry", () => {
    // An HTTP entry carries a URL, not a filesystem path — nothing to rot.
    writeConfig({ mcpServers: { "bot-relay": { type: "http", url: "http://127.0.0.1:3777/mcp" } } });
    const out = runHook({ RELAY_DB_PATH: instanceDb() });
    expect(out).not.toContain("RELAY MUTE");
  });

  it("DOES claim mute when the canonical `bot-relay` entry points at a missing path", () => {
    // POSITIVE CONTROL — this is the test that catches dead code.
    writeConfig({
      mcpServers: {
        "bot-relay": { type: "stdio", command: "node", args: ["/nonexistent/bot-relay-mcp/dist/index.js"] },
      },
    });
    const out = runHook({ RELAY_DB_PATH: instanceDb() });
    expect(out).toContain("RELAY MUTE");
    expect(out).toContain("/nonexistent/bot-relay-mcp/dist/index.js");
    // It must hand over the working fallback, not just complain.
    expect(out).toContain("relay send");
  });

  it("DOES claim mute for a differently-named entry that is unmistakably our binary", () => {
    // Identity is the canonical key OR our dist path — a renamed entry pointing
    // at bot-relay-mcp/dist/index.js is still us.
    writeConfig({
      mcpServers: {
        "weird-name": { type: "stdio", command: "node", args: ["/nonexistent/bot-relay-mcp/dist/index.js"] },
      },
    });
    const out = runHook({ RELAY_DB_PATH: instanceDb() });
    expect(out).toContain("RELAY MUTE");
  });
});

describe("the detector must announce its OWN death", () => {
  it("reports MUTE SELF-CHECK FAILED when the diagnostic itself cannot run", () => {
    // The nastiest failure this feature can have is being disabled without
    // anyone noticing — which already happened once (Illegal Return + the
    // hook's own 2>/dev/null). A silence-detector that dies quietly is worse
    // than none, because its quiet reads as "all clear".
    //
    // Simulate the detector failing WITHOUT editing the hook: shadow `node`
    // with a stub that always exits non-zero.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fakebin-"));
    const fakeNode = path.join(binDir, "node");
    fs.writeFileSync(fakeNode, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(fakeNode, 0o755);

    writeConfig({ mcpServers: { "bot-relay": { type: "http", url: "http://127.0.0.1:3777/mcp" } } });
    const out = runHook({
      RELAY_DB_PATH: instanceDb(),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    try {
      expect(out).toContain("MUTE SELF-CHECK FAILED TO RUN");
      // It must say the state is UNKNOWN, not healthy — the whole point.
      expect(out).toContain("UNVERIFIED");
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("does NOT report a self-check failure when the detector runs normally", () => {
    // Negative half of the pair: proves the assertion above is not simply
    // always-on.
    writeConfig({ mcpServers: { "bot-relay": { type: "http", url: "http://127.0.0.1:3777/mcp" } } });
    const out = runHook({ RELAY_DB_PATH: instanceDb() });
    expect(out).not.toContain("MUTE SELF-CHECK FAILED");
  });
});

describe("codex round 2 — the detector must not be silently bypassable", () => {
  it("HIGH: a deeply nested but VALID config still produces a verdict, never silence", () => {
    // codex's repro: 12k nested wrappers around a canonical entry with a dead
    // path. JSON.parse succeeded, the RECURSIVE walk overflowed the stack, and
    // a broad catch turned that RangeError into a successful zero-output run —
    // no mute warning, no self-check failure, nothing. Traversal is now
    // iterative, so this resolves properly rather than merely failing loudly.
    // Built as a string: generating it with a recursive encoder overflows too.
    const N = 12000;
    const inner = JSON.stringify({
      mcpServers: {
        "bot-relay": { type: "stdio", command: "node", args: ["/nonexistent/bot-relay-mcp/dist/index.js"] },
      },
    });
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      '{"x":'.repeat(N) + inner + "}".repeat(N),
    );

    const out = runHook({ RELAY_DB_PATH: instanceDb() });

    // Either verdict is acceptable; SILENCE is not. That is the whole contract.
    expect(out === "" || (!out.includes("RELAY MUTE") && !out.includes("SELF-CHECK FAILED"))).toBe(false);
    // With an iterative walk it should find the entry and give the real answer.
    expect(out).toContain("RELAY MUTE");
  });

  it("MED: a detector that writes stdout then FAILS must not produce a mute verdict", () => {
    // codex's repro: a node stub that prints a plausible path and exits 23.
    // The hook previously emitted BOTH "UNVERIFIED" and a definitive "you are
    // mute" — the second built entirely on untrusted partial output. When the
    // detector failed, UNVERIFIED is the only honest verdict.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fakebin2-"));
    const fakeNode = path.join(binDir, "node");
    fs.writeFileSync(fakeNode, '#!/bin/sh\nprintf "/untrusted/index.js"\nexit 23\n');
    fs.chmodSync(fakeNode, 0o755);

    writeConfig({ mcpServers: { "bot-relay": { type: "http", url: "http://127.0.0.1:3777/mcp" } } });
    const out = runHook({
      RELAY_DB_PATH: instanceDb(),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    try {
      expect(out).toContain("MUTE SELF-CHECK FAILED TO RUN");
      // The contradictory second banner must be gone.
      expect(out).not.toContain("NO RELAY TOOLS THIS SESSION");
      expect(out).not.toContain("/untrusted/index.js");
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe("the diagnostics must never break the hook they ride on", () => {
  const shapes: Array<[string, () => void]> = [
    ["config absent", () => { /* no file at all */ }],
    ["config malformed", () => fs.writeFileSync(path.join(home, ".claude.json"), "{ not json")],
    ["config empty", () => fs.writeFileSync(path.join(home, ".claude.json"), "")],
    ["no relay entry", () => writeConfig({ mcpServers: { other: { type: "http", url: "http://x" } } })],
    ["relay entry without args", () => writeConfig({ mcpServers: { "bot-relay": { type: "stdio", command: "node" } } })],
  ];

  for (const [label, setup] of shapes) {
    it(`degrades quietly: ${label}`, () => {
      setup();
      const out = runHook({ RELAY_DB_PATH: instanceDb() });
      expect(out).not.toContain("RELAY MUTE");
      expect(out).not.toContain("WRONG INSTANCE");
    });
  }
});
