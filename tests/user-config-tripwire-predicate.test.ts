// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Controls for the hardened suite-wide user-config tripwire
 * (tests/global-user-config-tripwire.ts) — ADR-0015 two-leg discipline.
 *
 * EVERY guard is tested BOTH ways:
 *   HARM LEG    — attempt the harm through the SHIPPED predicate → assert it FAILS
 *                 (region CHANGES). Written FROM the harm, not the implementation.
 *   INNOCENT    — the benign near-neighbour → assert it PASSES (region unchanged).
 *
 * And every region control obtains its descriptor from the REAL registry
 * `protectedRegions()` (not a hand-built one): reverting a production registration
 * — e.g. `fingerprintMode:true` on config.json — must turn the matching HARM leg
 * RED (codex #139 v3 finding B; the #126 stale-metafile class).
 *
 * RUNNING IN A READ-ONLY / SYMLINKED CHECKOUT (codex could not start Vite —
 * `.vite-temp` EPERM): the PROVEN invocation is `--configLoader runner`, which
 * skips the config bundle that writes under node_modules. VITEST_CACHE_DIR alone
 * does NOT work (Vite bundles the config before cacheDir applies). Use:
 *   npx vitest run --configLoader runner tests/user-config-tripwire-predicate.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  claudeJsonRegion,
  botRelayConfigRegion,
  changedRegions,
  protectedRegions,
  regionOf,
  type ProtectedRegion,
} from "./global-user-config-tripwire.js";
import {
  isRelayCheckHookCommand,
  quoteForHookCommand,
  migrateRawHookCommand,
  upsertSessionStartHook,
} from "../src/cli/config-merge.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tripwire-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A production descriptor from the REAL registry, re-pathed at a sandbox file. */
function sourced(suffix: string, tmpName: string): ProtectedRegion & { path: string } {
  const real = protectedRegions().find((p) => p.path.endsWith(suffix));
  if (!real) throw new Error(`no protectedRegions() entry ending ${suffix}`);
  return { ...real, path: path.join(dir, tmpName) };
}
/** Read a region through the shipped regionOf using a registry-sourced descriptor. */
function regionAt(pr: ProtectedRegion): string {
  return regionOf(pr);
}

const RAW_SPACED = "/Users/x/LLMs/Claude AI/bot-relay-mcp/hooks/check-relay.sh"; // unquoted, spaced — a real init shape
const QUOTED_SPACED = `'${RAW_SPACED}'`;
const settingsJson = (hookCommand: string, matcher = "startup|resume") =>
  JSON.stringify({
    hooks: {
      SessionStart: [{ matcher, hooks: [{ type: "command", command: hookCommand, timeout: 10 }] }],
      PostToolUse: [{ hooks: [{ type: "command", command: "/other/pth.sh" }] }],
    },
    theme: "dark",
  });

describe("DETECTION predicate — isRelayCheckHookCommand (precise; reject cases FIRST)", () => {
  it("REJECTS: unquoted-whitespace is UNDECIDABLE → not owned (spaced path vs interpreter+arg)", () => {
    expect(isRelayCheckHookCommand(RAW_SPACED)).toBe(false); // raw spaced hook — NOT owned (watch handles it)
    expect(isRelayCheckHookCommand("/bin/bash /foreign/hooks/check-relay.sh")).toBe(false); // interpreter + ABSOLUTE foreign
    expect(isRelayCheckHookCommand("/bin/bash foreign/hooks/check-relay.sh")).toBe(false); // interpreter + RELATIVE foreign
    expect(isRelayCheckHookCommand("echo /foreign/hooks/check-relay.sh")).toBe(false); // command word first
  });

  it("REJECTS: name-mentions that are not our hook (#128 false-ownership class)", () => {
    expect(isRelayCheckHookCommand("echo check-relay.sh")).toBe(false);
    expect(isRelayCheckHookCommand("check-relay.sh")).toBe(false);
    expect(isRelayCheckHookCommand("/x/not-hooks/check-relay.sh")).toBe(false); // wrong parent dir
    expect(isRelayCheckHookCommand("/x/hooks/check-relay.sh.bak")).toBe(false); // wrong suffix
    expect(isRelayCheckHookCommand("/x/hooks/check-relay.sh/wrapper.sh")).toBe(false); // our name is a DIR
    expect(isRelayCheckHookCommand("/x/hooks/check-relay.sh; rm -rf /")).toBe(false); // shell metachar
    expect(isRelayCheckHookCommand("")).toBe(false);
    expect(isRelayCheckHookCommand(undefined)).toBe(false);
    expect(isRelayCheckHookCommand(42)).toBe(false);
  });

  it("ACCEPTS: the unambiguous shapes only — unquoted NO-SPACE, or QUOTED (spaced or not)", () => {
    expect(isRelayCheckHookCommand("/Users/x/bot-relay-mcp/hooks/check-relay.sh")).toBe(true); // init raw, no space
    expect(isRelayCheckHookCommand(QUOTED_SPACED)).toBe(true); // quoted spaced → quotes disambiguate
    expect(isRelayCheckHookCommand(`"/Users/x/bot-relay-mcp/hooks/check-relay.sh"`)).toBe(true); // double-quoted
    expect(isRelayCheckHookCommand("/Users/x/My%20Dir/bot-relay-mcp/hooks/check-relay.sh")).toBe(true); // %20, no literal space
  });

  it("DIVERGENCE GUARD: accepts EXACTLY what installHook now writes (quoteForHookCommand of the path)", () => {
    const noSpace = "/opt/relay/bot-relay-mcp/hooks/check-relay.sh";
    const spaced = "/Users/x/LLMs/Claude AI/bot-relay-mcp/hooks/check-relay.sh";
    expect(isRelayCheckHookCommand(quoteForHookCommand(noSpace))).toBe(true); // unchanged (no space)
    expect(isRelayCheckHookCommand(quoteForHookCommand(spaced))).toBe(true); // single-quoted
    // And what init would have written RAW for a spaced root is deliberately NOT owned:
    expect(isRelayCheckHookCommand(spaced)).toBe(false);
  });
});

describe("tripwire region — ~/.claude/settings.json (sourced from protectedRegions)", () => {
  const write = (f: string, content: string) => fs.writeFileSync(f, content);

  it("INNOCENT: a foreign SessionStart hook added + key reorder → region UNCHANGED", () => {
    const pr = sourced(".claude/settings.json", "settings.json");
    write(pr.path, settingsJson(QUOTED_SPACED));
    const before = regionAt(pr);
    write(
      pr.path,
      JSON.stringify({
        theme: "light",
        hooks: {
          PostToolUse: [{ hooks: [{ type: "command", command: "/other/pth.sh" }] }],
          SessionStart: [
            { matcher: "startup|resume", hooks: [{ type: "command", command: QUOTED_SPACED, timeout: 10 }] },
            { matcher: "startup", hooks: [{ type: "command", command: "/someone/else.sh" }] },
          ],
        },
      })
    );
    expect(regionAt(pr)).toBe(before);
  });

  it("HARM (quoted, owned): matcher flip → region CHANGES; deletion → region CHANGES", () => {
    const pr = sourced(".claude/settings.json", "settings.json");
    write(pr.path, settingsJson(QUOTED_SPACED, "startup|resume"));
    const before = regionAt(pr);
    write(pr.path, settingsJson(QUOTED_SPACED, "never")); // disable via matcher
    expect(regionAt(pr)).not.toBe(before);
    write(pr.path, JSON.stringify({ hooks: { SessionStart: [] } })); // delete
    expect(regionAt(pr)).not.toBe(before);
  });

  it("HARM (raw spaced, ambiguous-marked): deleting a REAL raw spaced hook → region CHANGES", () => {
    // The exact P1 whose absence let v3 ship: the classifier does not OWN this, but
    // the watch marker means its deletion still trips.
    const pr = sourced(".claude/settings.json", "settings.json");
    write(pr.path, settingsJson(RAW_SPACED));
    const before = regionAt(pr);
    expect(before).toMatch(/AMBIGUOUS-LEGACY-HOOK/); // it is watched, under the marker
    write(pr.path, JSON.stringify({ hooks: { SessionStart: [] } }));
    expect(regionAt(pr)).not.toBe(before);
  });

  it("the marker states only what is KNOWN — it does NOT claim ownership", () => {
    const pr = sourced(".claude/settings.json", "settings.json");
    write(pr.path, settingsJson(RAW_SPACED));
    const region = regionAt(pr);
    expect(region).toMatch(/MAY be a relay hook/); // honest
    expect(region).toMatch(/relay init/); // names the remedy
    expect(region).not.toMatch(/is (our|the relay) hook/i); // never asserts ownership
  });
});

describe("tripwire region — ~/.bot-relay/config.json mode (sourced; the codex #139 v2 P1)", () => {
  const writeConfig = (f: string, mode: number) =>
    fs.writeFileSync(f, '{"http_secret":"s3cr3t","http_port":3777}', { mode });

  it.skipIf(process.platform === "win32")("HARM: chmod 0644 with BYTE-IDENTICAL content → region CHANGES", () => {
    const pr = sourced(".bot-relay/config.json", "config.json");
    expect(pr.fingerprintMode, "the PRODUCTION registration must carry fingerprintMode").toBe(true);
    writeConfig(pr.path, 0o600);
    const before = regionAt(pr);
    fs.chmodSync(pr.path, 0o644); // do NOT touch bytes
    expect(regionAt(pr)).not.toBe(before);
    expect(before).toMatch(/::mode=600$/);
    expect(regionAt(pr)).toMatch(/::mode=644$/);
  });

  it.skipIf(process.platform === "win32")(
    "NEGATIVE CONTROL: the HARM leg depends on the PRODUCTION fingerprintMode — revert it and it goes GREEN",
    () => {
      const pr = sourced(".bot-relay/config.json", "config.json");
      writeConfig(pr.path, 0o600);
      // Simulate reverting the production registration (fingerprintMode -> false):
      const reverted = { ...pr, fingerprintMode: false };
      const before = regionAt(reverted);
      fs.chmodSync(pr.path, 0o644);
      expect(regionAt(reverted)).toBe(before); // mode widen is INVISIBLE without the flag → harm leg would be green
    }
  );

  it.skipIf(process.platform === "win32")("INNOCENT TWIN: a mode change on a SHARED Claude file → region UNCHANGED", () => {
    const pr = sourced(".claude.json", "claude.json"); // fingerprintMode NOT set for the shared file
    fs.writeFileSync(pr.path, JSON.stringify({ mcpServers: { "bot-relay": { command: "node" } } }), { mode: 0o600 });
    const before = regionAt(pr);
    fs.chmodSync(pr.path, 0o644);
    expect(regionAt(pr)).toBe(before);
  });
});

describe("tripwire region — ~/.claude.json (sourced; mcpServers['bot-relay'])", () => {
  it("INNOCENT: ambient churn (unrelated keys, server reorder) → region UNCHANGED", () => {
    const pr = sourced(".claude.json", "claude.json");
    const BR = { type: "stdio", command: "node", args: ["/x/dist/index.js"] };
    fs.writeFileSync(pr.path, JSON.stringify({ numStartups: 1, mcpServers: { "other": {}, "bot-relay": BR } }));
    const before = regionAt(pr);
    fs.writeFileSync(pr.path, JSON.stringify({ numStartups: 2, sess: 1, mcpServers: { "bot-relay": BR, "other": {} } }));
    expect(regionAt(pr)).toBe(before);
  });

  it("HARM: the bot-relay subtree changes → region CHANGES", () => {
    const pr = sourced(".claude.json", "claude.json");
    fs.writeFileSync(pr.path, JSON.stringify({ mcpServers: { "bot-relay": { command: "node" } } }));
    const before = regionAt(pr);
    fs.writeFileSync(pr.path, JSON.stringify({ mcpServers: { "bot-relay": { command: "CLOBBERED" } } }));
    expect(regionAt(pr)).not.toBe(before);
  });
});

describe("decision layer + ABSENT + UNPARSEABLE", () => {
  it("ABSENT→ABSENT unchanged; a relay-region change flagged", () => {
    const paths = protectedRegions().map((p) => p.path);
    const before = new Map(paths.map((p) => [p, "ABSENT"] as const));
    expect(changedRegions(before, new Map(before))).toHaveLength(0);
    const after = new Map(before);
    after.set(paths[0], "mutated");
    expect(changedRegions(before, after).map((p) => p.path)).toEqual([paths[0]]);
  });

  it("UNPARSEABLE hashes the raw bytes — two different corruptions trip", () => {
    const good = claudeJsonRegion(JSON.stringify({ mcpServers: { "bot-relay": {} } }));
    const a = claudeJsonRegion("{ not json");
    const b = claudeJsonRegion("also }{ not json");
    expect(good).not.toBe(a);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^UNPARSEABLE:/);
  });

  it("~/.bot-relay/config.json whole-file content change flagged", () => {
    expect(botRelayConfigRegion("a")).not.toBe(botRelayConfigRegion("b"));
  });
});

describe("installer — quote (init) + exact-match migration (no classifier)", () => {
  it("quoteForHookCommand: spaced path → single-quoted; no-space → unchanged", () => {
    expect(quoteForHookCommand("/opt/x/hooks/check-relay.sh")).toBe("/opt/x/hooks/check-relay.sh");
    expect(quoteForHookCommand(RAW_SPACED)).toBe(QUOTED_SPACED);
  });

  it("migrateRawHookCommand: rewrites EXACTLY the raw literal → canonical; leaves other shapes alone", () => {
    const canonical = quoteForHookCommand(RAW_SPACED);
    const root = {
      hooks: {
        SessionStart: [
          { matcher: "startup|resume", hooks: [{ type: "command", command: RAW_SPACED, timeout: 10 }] },
          { matcher: "x", hooks: [{ type: "command", command: "/someone/else.sh" }] }, // NOT ours
        ],
      },
    };
    const { root: out, changed } = migrateRawHookCommand(root, RAW_SPACED, canonical);
    expect(changed).toBe(true);
    const ss = (out.hooks as { SessionStart: { hooks: { command: string }[] }[] }).SessionStart;
    expect(ss[0].hooks[0].command).toBe(canonical); // migrated
    expect(ss[1].hooks[0].command).toBe("/someone/else.sh"); // untouched
  });

  it("migrateRawHookCommand: NO-OP when raw == canonical (no-space install)", () => {
    const noSpace = "/opt/x/hooks/check-relay.sh";
    const { changed } = migrateRawHookCommand({ hooks: { SessionStart: [] } }, noSpace, quoteForHookCommand(noSpace));
    expect(changed).toBe(false);
  });

  it("migrate + upsert composes to ONE canonical quoted relay hook, and it is precisely owned", () => {
    const canonical = quoteForHookCommand(RAW_SPACED);
    const existing = { hooks: { SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: RAW_SPACED, timeout: 10 }] }] } };
    const migrated = migrateRawHookCommand(existing, RAW_SPACED, canonical);
    const up = upsertSessionStartHook(migrated.root, { matcher: "startup|resume", command: canonical, timeout: 10 });
    const ss = (up.root.hooks as { SessionStart: { hooks: { command: string }[] }[] }).SessionStart;
    const relay = ss.flatMap((g) => g.hooks).filter((h) => isRelayCheckHookCommand(h.command));
    expect(relay).toHaveLength(1); // deduped to one
    expect(isRelayCheckHookCommand(relay[0].command)).toBe(true); // now precisely owned
  });
});
