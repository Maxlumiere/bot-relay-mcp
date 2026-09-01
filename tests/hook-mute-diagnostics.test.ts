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
  // #226 — test isolation. The hook resolves its relay root + DB path from HOME and
  // the RELAY_* environment (RELAY_ROOT="${RELAY_HOME:-$HOME/.bot-relay}"; RELAY_DB_PATH
  // is honoured as a deliberate operator override). Inheriting the *ambient* RELAY_* —
  // a developer shell that exports RELAY_DB_PATH, or a sibling test that set it on
  // process.env during a full-suite run — silently redirected the hook off this test's
  // temp HOME and flipped the two default-resolution verdicts (WRONG INSTANCE / MUTE).
  // The suite was therefore green only on a clean CI runner (no ambient RELAY_*, no real
  // ~/.bot-relay) and flaky on the machine where people actually work.
  //
  // Fix is STRUCTURAL, not detective: scrub the entire RELAY_* namespace from the
  // inherited env so the ONLY relay state the hook can reach is this test's temp HOME
  // plus whatever the test explicitly passes. Reaching the real root is unreachable, not
  // merely unlikely. This changes WHERE the hook reads from — never what the verdicts
  // mean; the hook's RELAY_DB_PATH-honouring (codex HIGH 1) is intentionally left intact.
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("RELAY_")) inherited[k] = v;
  }
  try {
    return execFileSync("bash", [HOOK], {
      env: { ...inherited, HOME: home, RELAY_AGENT_NAME: "probe", ...env },
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

describe("VERDICT BY CONSTRUCTION — exactly one verdict on every run", () => {
  const OK = { mcpServers: { "bot-relay": { type: "http", url: "http://127.0.0.1:3777/mcp" } } };
  const DEAD = {
    mcpServers: {
      "bot-relay": { type: "stdio", command: "node", args: ["/nonexistent/bot-relay-mcp/dist/index.js"] },
    },
  };

  /** Extract the single verdict token, or null if the hook emitted none. */
  function verdictOf(out: string): string | null {
    const m = out.match(/VERDICT=([A-Z-]+)/);
    return m ? m[1] : null;
  }

  function linkInstance(): void {
    fs.symlinkSync("work", path.join(home, ".bot-relay", "active-instance"));
  }

  it("HEALTHY when the config resolves and the instance is consistent", () => {
    linkInstance(); writeConfig(OK);
    expect(verdictOf(runHook({ RELAY_DB_PATH: instanceDb() }))).toBe("HEALTHY");
  });

  it("MUTE when the canonical entry points at a missing path", () => {
    linkInstance(); writeConfig(DEAD);
    expect(verdictOf(runHook({ RELAY_DB_PATH: instanceDb() }))).toBe("MUTE");
  });

  it("MUTE when we resolved the legacy DB while instances exist", () => {
    writeConfig(OK); // no active-instance link, no RELAY_DB_PATH
    expect(verdictOf(runHook())).toBe("MUTE");
  });

  it("CANNOT-JUDGE when there is no config to judge", () => {
    linkInstance();
    expect(verdictOf(runHook({ RELAY_DB_PATH: instanceDb() }))).toBe("CANNOT-JUDGE");
  });

  it("CANNOT-JUDGE when the config cannot be parsed — NOT healthy", () => {
    // "Could not parse" and "parsed fine, nothing wrong" previously produced
    // identical observables (empty stdout, exit 0), so this reached HEALTHY.
    // That conflation is the entire bug class this redesign removes.
    linkInstance();
    fs.writeFileSync(path.join(home, ".claude.json"), "{ not json");
    expect(verdictOf(runHook({ RELAY_DB_PATH: instanceDb() }))).toBe("CANNOT-JUDGE");
  });

  it("CANNOT-JUDGE when the detector crashes", () => {
    linkInstance(); writeConfig(DEAD);
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-vbin1-"));
    fs.writeFileSync(path.join(binDir, "node"), "#!/bin/sh\nexit 1\n");
    fs.chmodSync(path.join(binDir, "node"), 0o755);
    try {
      const out = runHook({ RELAY_DB_PATH: instanceDb(), PATH: `${binDir}:${process.env.PATH ?? ""}` });
      expect(verdictOf(out)).toBe("CANNOT-JUDGE");
    } finally { fs.rmSync(binDir, { recursive: true, force: true }); }
  });

  it("CANNOT-JUDGE when node is absent entirely (codex round 3, by construction)", () => {
    // Previously `command -v node` skipped the whole check and emitted NOTHING.
    // Nothing special-cases this now — it simply never earns a HEALTHY upgrade.
    linkInstance(); writeConfig(DEAD);
    expect(verdictOf(runHook({ RELAY_DB_PATH: instanceDb(), PATH: "/usr/bin:/bin" }))).toBe("CANNOT-JUDGE");
  });

  it("emits EXACTLY ONE verdict — never two, never zero", () => {
    linkInstance(); writeConfig(DEAD);
    const out = runHook({ RELAY_DB_PATH: instanceDb() });
    expect((out.match(/VERDICT=/g) ?? []).length).toBe(1);
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

describe("#226 — the harness isolates ambient RELAY_*, so a polluted env cannot flip a verdict", () => {
  // Regression guard for the exact full-suite flake this file caused: a sibling test (or
  // the developer's own shell) exports RELAY_DB_PATH / RELAY_HOME on process.env, which —
  // before the RELAY_* scrub in runHook — leaked into the hook and silenced the two
  // default-resolution verdicts. The suite was then green only on a clean CI runner and
  // red where people work. Here we DELIBERATELY seed that pollution and assert the two
  // verdicts still fire, so re-introducing the leak (e.g. reverting runHook to spread
  // ...process.env) reddens instead of going quietly green.
  const POLLUTION: Record<string, string> = {
    RELAY_DB_PATH: "/private/tmp/relay-226-ambient-leak.db",
    RELAY_HOME: "/private/tmp/relay-226-ambient-home/.bot-relay",
    RELAY_INSTANCE_ID: "ambient-leak-instance",
  };
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of Object.keys(POLLUTION)) { saved[k] = process.env[k]; process.env[k] = POLLUTION[k]; }
  });
  afterEach(() => {
    for (const k of Object.keys(POLLUTION)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it("still shouts WRONG INSTANCE despite an ambient RELAY_DB_PATH leak (no explicit override)", () => {
    const out = runHook();
    expect(out).toContain("WRONG INSTANCE");
  });

  it("still resolves MUTE despite an ambient RELAY_DB_PATH leak (legacy DB while instances exist)", () => {
    writeConfig({ mcpServers: { "bot-relay": { type: "http", url: "http://127.0.0.1:3777/mcp" } } });
    const m = runHook().match(/VERDICT=([A-Z-]+)/);
    expect(m && m[1]).toBe("MUTE");
  });
});
