// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SUITE-WIDE USER-CONFIG TRIPWIRE (2026-07-23 worktree-clobber fix, layer 3;
 * predicate hardened 2026-07-25).
 *
 * Fails the run if a test writes the RELAY-OWNED region of the operator's real
 * user-scope config. It is the observation-level backstop behind the two
 * by-construction guards (the atomicWriteJson chokepoint and the
 * RELAY_CLAUDE_HOME sandbox in the init-exercising tests): those stop relay code
 * from clobbering; this catches ANY test writing our config by ANY means,
 * including code that doesn't exist yet.
 *
 * WHY IT COMPARES REGIONS, NOT WHOLE-FILE BYTES. The first cut fingerprinted the
 * whole file. That made it UNPASSABLE on any machine with a live Claude Code
 * session: ordinary Claude Code operation rewrites ~/.claude.json on a MINUTES
 * timescale (measured: stable 45s, then changed between two idle checks), and the
 * suite takes ~7 minutes — so it failed the publish whenever the fleet breathed,
 * reading as "a test clobbered your config" when nothing did. The docstring even
 * anticipated this ("another agent editing mid-suite also trips it… rare") — the
 * rarity assumption is false in a multi-agent fleet. So we compare only the parts
 * WE own:
 *   - ~/.claude.json          → the `mcpServers["bot-relay"]` subtree.
 *   - ~/.claude/settings.json → the SessionStart hook entries our hook owns,
 *                               classified by the SHARED, precise
 *                               `isRelayCheckHookCommand` (src/cli/config-merge.ts)
 *                               — NOT a local substring — each carried WITH its
 *                               group `matcher` (a matcher flip disables the hook).
 *   - ~/.bot-relay/config.json → the whole file: it is relay-owned by definition.
 * Comparison is order-independent (canonical key sort) so a rewrite that reorders
 * keys but preserves our region does not trip; a test that changes our region
 * still does.
 *
 * We deliberately do NOT warn on non-relay-region churn: on a live Claude Code
 * machine it changes every run, so a WARN would be pure noise and retrain readers
 * to ignore this line — the exact silence-as-noise failure we keep closing.
 *
 * Why it must FAIL the run rather than warn: the original clobber survived nine
 * days precisely because it was silent and every run was green. A guard that
 * cannot fail is decoration.
 *
 * Honest limitation: a genuine mid-suite write to OUR region by another agent (or
 * a human editing `mcpServers["bot-relay"]` while the suite runs) still trips it.
 * That is now narrow — the relay region, not the whole file — and a false alarm
 * there costs one re-run; the failure it exists to catch cost twelve days.
 */
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
// SHARED, precise ownership classifier — the SAME source of truth the installer
// uses (src/cli/config-merge.ts), so this guard's notion of "our SessionStart
// hook" cannot drift from what init/generate-hooks write. NOT a local substring.
import { isRelayCheckHookCommand } from "../src/cli/config-merge.js";

/**
 * RESIDUALS, deliberately out of scope (codex #139 asked they be named, not left
 * silent):
 *  - FILE PERMISSIONS are not fingerprinted for ~/.claude.json /
 *    ~/.claude/settings.json. Those files are SHARED (Claude Code owns most of
 *    them); a mode-only change there is not a relay-content clobber, and folding
 *    mode into the fingerprint would re-admit exactly the ambient false-trips
 *    this rewrite removed. ~/.bot-relay/config.json is relay-owned and its
 *    CONTENT is fingerprinted whole; a permission-only change without a content
 *    change is not the write-clobber class this guard exists to catch.
 *  - UNPARSEABLE files: handled, not ignored — a parse failure fingerprints as
 *    "UNPARSEABLE:<sha256 of raw>", so a test that corrupts a file two DIFFERENT
 *    ways trips (distinct hashes) rather than reading unchanged. A valid file
 *    never reaches this path, so it adds no ambient false-trips.
 */
function unparseable(raw: string): string {
  return "UNPARSEABLE:" + crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Deterministic JSON: recursively sort object keys so a semantically-equal region
 * serialized in a different key order compares equal. Arrays keep their order
 * (order is meaningful there); callers that need order-independent arrays sort the
 * elements' canonical forms first.
 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const obj = v as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/** ~/.claude.json relay region = the `mcpServers["bot-relay"]` subtree (canonical). */
export function claudeJsonRegion(raw: string): string {
  try {
    const c = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return stableStringify(c?.mcpServers?.["bot-relay"] ?? null);
  } catch {
    return unparseable(raw);
  }
}

/**
 * ~/.claude/settings.json relay region = the SessionStart hook entries whose
 * command invokes OUR hook (isRelayCheckHookCommand), each paired with its
 * enclosing group's `matcher`, order-independent. The matcher is INCLUDED because
 * it is load-bearing: flipping `matcher:"startup|resume"` → `"never"` DISABLES the
 * relay hook without touching the hook object — destructive config damage that a
 * hook-object-only region would wave through (codex #139 P1). Ignores every other
 * hook event and every non-relay SessionStart entry — those are the operator's /
 * other agents', and their churn must not trip us.
 */
export function claudeSettingsRegion(raw: string): string {
  let c: { hooks?: { SessionStart?: unknown[] } };
  try {
    c = JSON.parse(raw);
  } catch {
    return unparseable(raw);
  }
  const groups = Array.isArray(c?.hooks?.SessionStart) ? (c.hooks!.SessionStart as unknown[]) : [];
  const owned: string[] = [];
  for (const g of groups) {
    const matcher = (g as { matcher?: unknown })?.matcher ?? null;
    const inner = (g as { hooks?: unknown[] })?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (isRelayCheckHookCommand((h as { command?: unknown })?.command)) {
        owned.push(stableStringify({ matcher, hook: h })); // matcher carried with the hook
      }
    }
  }
  return "[" + owned.sort().join(",") + "]"; // sorted → array reorder doesn't trip
}

/** ~/.bot-relay/config.json is relay-owned in full → the whole file is the region. */
export function botRelayConfigRegion(raw: string): string {
  return raw;
}

interface ProtectedRegion {
  path: string;
  extract: (raw: string) => string;
  label: string;
}

export function protectedRegions(): ProtectedRegion[] {
  const home = os.homedir();
  return [
    { path: path.join(home, ".claude.json"), extract: claudeJsonRegion, label: 'mcpServers["bot-relay"]' },
    { path: path.join(home, ".claude", "settings.json"), extract: claudeSettingsRegion, label: "relay SessionStart hook (check-relay.sh)" },
    { path: path.join(home, ".bot-relay", "config.json"), extract: botRelayConfigRegion, label: "~/.bot-relay/config.json (whole file)" },
  ];
}

/** Read + extract the relay region of one protected file. Missing file → "ABSENT" (ABSENT→ABSENT is unchanged). */
export function regionOf(p: ProtectedRegion): string {
  let raw: string;
  try {
    raw = fs.readFileSync(p.path, "utf8");
  } catch {
    return "ABSENT";
  }
  return p.extract(raw);
}

export function snapshotRegions(): Map<string, string> {
  return new Map(protectedRegions().map((p) => [p.path, regionOf(p)]));
}

/** PURE decision: which protected files' RELAY-OWNED region changed (for the controls to exercise directly). */
export function changedRegions(before: Map<string, string>, after: Map<string, string>): ProtectedRegion[] {
  return protectedRegions().filter((p) => before.get(p.path) !== after.get(p.path));
}

export default function setup(): () => void {
  const before = snapshotRegions();
  return function teardown(): void {
    const changed = changedRegions(before, snapshotRegions());
    if (changed.length > 0) {
      const files = changed.map((c) => `${c.path} [${c.label}]`).join(", ");
      const msg =
        `[user-config-tripwire] the test run MODIFIED a RELAY-OWNED region of real user config: ${files}.\n` +
        `A test wrote outside its sandbox (the 2026-07-23 worktree-clobber class — see ` +
        `tests/user-config-write-guard.test.ts). Find the writer and give it RELAY_CLAUDE_HOME / ` +
        `RELAY_CONFIG_PATH sandboxes. If a human/another agent edited the relay entry while the ` +
        `suite ran, re-run to confirm. (Non-relay churn in these files is IGNORED by design.)`;
      // BOTH channels, deliberately: vitest logs a teardown throw as "error during
      // close" but still exits 0, so the throw alone is decoration. Setting
      // process.exitCode is what actually fails `npm test` / CI; the throw keeps
      // the loud red banner.
      process.exitCode = 1;
      throw new Error(msg);
    }
  };
}
