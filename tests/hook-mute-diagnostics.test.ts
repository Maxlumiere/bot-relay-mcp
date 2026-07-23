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
