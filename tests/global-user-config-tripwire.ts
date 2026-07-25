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
 *   - ~/.claude/settings.json → the SessionStart hook entries whose command
 *                               invokes our hook (check-relay.sh) — the SAME
 *                               command-path identity src/cli/config-merge.ts
 *                               (upsertSessionStartHook) dedups on.
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

/** The relay's SessionStart hook script — its command-path identity marker. */
const RELAY_HOOK_MARKER = "check-relay.sh";

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
    return "UNPARSEABLE";
  }
}

/**
 * ~/.claude/settings.json relay region = the SessionStart hook entries whose
 * command invokes our hook (check-relay.sh), order-independent. Ignores every
 * other hook event and every non-relay SessionStart entry — those are the
 * operator's / other agents', and their churn must not trip us.
 */
export function claudeSettingsRegion(raw: string): string {
  try {
    const c = JSON.parse(raw) as { hooks?: { SessionStart?: unknown[] } };
    const groups = Array.isArray(c?.hooks?.SessionStart) ? (c.hooks!.SessionStart as unknown[]) : [];
    const relay: string[] = [];
    for (const g of groups) {
      const inner = (g as { hooks?: unknown[] })?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        const cmd = (h as { command?: unknown })?.command;
        if (typeof cmd === "string" && cmd.includes(RELAY_HOOK_MARKER)) relay.push(stableStringify(h));
      }
    }
    return "[" + relay.sort().join(",") + "]"; // sorted → array reorder doesn't trip
  } catch {
    return "UNPARSEABLE";
  }
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
