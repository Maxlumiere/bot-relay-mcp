// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SUITE-WIDE USER-CONFIG TRIPWIRE (2026-07-23 worktree-clobber fix, layer 3;
 * predicate hardened 2026-07-25).
 *
 * ═══ GUARD CONTRACT (ADR-0015 L1) ═══
 *  HARM it prevents: a test (or an ambient process) silently writes the RELAY's
 *    OWN user-scope config and every suite run stays green, so the clobber ships
 *    (the 2026-07-23 class — nine days silent). Concretely: mcpServers["bot-relay"]
 *    rewritten/removed; our check-relay.sh SessionStart hook's command OR matcher
 *    changed (matcher:"never" DISABLES it); ~/.bot-relay/config.json content
 *    changed, OR its mode widened to expose http_secret.
 *  PREDICATE it enforces: after the suite, the RELAY-OWNED REGION of each
 *    protected file is byte-identical to before — region = the bot-relay
 *    mcpServers subtree; the SessionStart hook entries (command + group matcher)
 *    that isRelayCheckHookCommand owns; and the whole CONTENT + ACCESS MODE of
 *    ~/.bot-relay/config.json.
 *  WHY the predicate implies prevention: every harm above IS a change to one of
 *    those regions, and nothing the suite legitimately does touches them — relay
 *    code writes user config only through the sandbox-guarded atomicWriteJson
 *    chokepoint, and ambient Claude Code churn lives OUTSIDE these regions (other
 *    mcpServers, other hooks, session keys, and the mode of the SHARED Claude
 *    files, all deliberately excluded). So region-unchanged ⟺ our config was not
 *    clobbered. (If that third sentence could not be written honestly, the
 *    predicate would be a proxy — which is exactly how "file-bytes" once stood in
 *    for "the hook fires" and let a matcher flip through.)
 *
 * COVERAGE BOUNDARY (codex #139 — stated plainly, not left to inference):
 *  COVERED: every form the installer EMITS. init writes only canonical
 *    single-quoted, non-CR/LF hook commands (it refuses an unquotable root before
 *    any write), and those are in the precise-owned region — so the biconditional
 *    above holds for anything WE write. mcpServers["bot-relay"] and the config.json
 *    content+mode are covered whole.
 *  NOT COVERED — known residuals, outside BOTH the precise-owned and the
 *    ambiguous-legacy buckets. Two kinds, and the distinction is the honest part:
 *    TRANSIENT (repaired by the next `relay init`):
 *      · a LEGACY RAW UNQUOTED command with shell metacharacters and no whitespace
 *        (`/x/$(id)/…/check-relay.sh`, `;`, backtick) — a pre-2.23.0 install could
 *        store one, precise-detect rejects the metachar and the ambiguous bucket
 *        needs whitespace, so it is in NEITHER. But migrateRawHookCommand exact-
 *        matches the raw literal THIS root writes, so the next `relay init` REWRITES
 *        it to the covered single-quoted canonical (verified: a raw `$(id)` command
 *        migrates and becomes precisely owned). Uncovered until the next init,
 *        which repairs it — not permanent.
 *    PERMANENT (the relay never emits or migrates these):
 *      · a `sh -c <script>` / interpreter-wrapped hook, or a DOUBLE-quoted command
 *        (we never emit one; double quotes don't stop $()/backtick). A newline/CR
 *        command can no longer be created (init refuses it, atomically).
 *    QUIRK: a raw (unquoted) APOSTROPHE-bearing path (`/x/O'Hare/…/check-relay.sh`)
 *    has no metachar in the reject set, so it is misclassified as bare-safe and
 *    WATCHED — even though as shell it is a broken (unbalanced-quote) command. The
 *    watch is harmless (deletion still trips) and the next init migrates it to the
 *    correct single-quoted form. Stated as a known gap + quirk, not completeness.
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
 *  - FILE PERMISSIONS: fingerprinted ONLY for ~/.bot-relay/config.json (relay-
 *    owned + secret-bearing — a mode-only widening there exposes http_secret, so
 *    its access mode IS in the region; regionOf folds it in, and the mode-harm
 *    control covers it). NOT fingerprinted for the two SHARED Claude files
 *    (~/.claude.json, ~/.claude/settings.json): Claude Code owns most of those,
 *    a mode change there is not a relay-content clobber, and folding mode in would
 *    re-admit the ambient false-trips this rewrite removed.
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
 * WATCH-only predicate (tripwire-local, NOT exported as ownership). The
 * AMBIGUOUS-LEGACY bucket: a command that MIGHT be our raw spaced install hook but
 * is genuinely undecidable — unquoted, absolute, ends with our tail, contains
 * whitespace. The DETECTION predicate (isRelayCheckHookCommand) refuses to OWN
 * these (owning would let a heuristic authorize the destructive migration — the
 * #128 defect), so a hook-object-only region would miss deleting a raw spaced
 * hook (codex #139 v3 P1). The tripwire WATCHES them anyway: a false positive here
 * is a false ALARM, never a destructive write, so a BROADER predicate is
 * acceptable — ADR-0015, the required certainty scales with the consequence.
 */
function isAmbiguousLegacyRelayCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const s = command.trim();
  if (s.startsWith("'") || s.startsWith('"')) return false; // quoted → the precise predicate handles it
  if (!s.startsWith("/")) return false; // `echo <x>` / a relative call start with a command WORD
  if (!s.endsWith("/hooks/check-relay.sh")) return false;
  if (/[|;&$<>`\r\n]/.test(s)) return false; // a shell metachar means a command LINE, not even an ambiguous path
  return /\s/.test(s); // the ambiguous bit: UNQUOTED whitespace
}

/**
 * ~/.claude/settings.json relay region = OWNED SessionStart hooks (precise,
 * isRelayCheckHookCommand) each paired with its group `matcher` (a matcher flip
 * "startup|resume"→"never" DISABLES the hook — load-bearing, codex #139 P1);
 * PLUS, under a loud marker, any AMBIGUOUS-LEGACY hooks (undecidable raw-spaced
 * shapes) so deleting a real raw spaced hook still trips. Ignores every other hook
 * event and every non-relay SessionStart entry — their churn must not trip us.
 *
 * The marker text is itself a CLAIM (ADR-0015: L1 applies to the message, not just
 * the predicate). It states only what is KNOWN — that this MAY be ours and cannot
 * be determined — never that it IS ours; the watch predicate also matches genuine
 * foreign commands, and a guard that overstates what it knows fails in the
 * reader's head instead of the code.
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
  const ambiguous: string[] = [];
  for (const g of groups) {
    const matcher = (g as { matcher?: unknown })?.matcher ?? null;
    const inner = (g as { hooks?: unknown[] })?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      const cmd = (h as { command?: unknown })?.command;
      if (isRelayCheckHookCommand(cmd)) owned.push(stableStringify({ matcher, hook: h }));
      else if (isAmbiguousLegacyRelayCommand(cmd)) ambiguous.push(stableStringify({ matcher, hook: h }));
    }
  }
  const region = "[" + owned.sort().join(",") + "]"; // sorted → array reorder doesn't trip
  if (ambiguous.length === 0) return region; // common case: no marker, no noise
  return (
    region +
    "::AMBIGUOUS-LEGACY-HOOK(unquoted path ending /hooks/check-relay.sh — MAY be a relay hook from a" +
    " spaced install root; undecidable without quoting; run `relay init` to migrate, or ignore if not ours):[" +
    ambiguous.sort().join(",") +
    "]"
  );
}

/** ~/.bot-relay/config.json is relay-owned in full → the whole file is the region. */
export function botRelayConfigRegion(raw: string): string {
  return raw;
}

export interface ProtectedRegion {
  path: string;
  extract: (raw: string) => string;
  label: string;
  /**
   * Fold the file's access mode into the region. ONLY for ~/.bot-relay/config.json:
   * it is relay-owned AND can hold `http_secret` (src/config.ts) — a mode-only
   * widening (chmod 0644 with identical bytes) exposes that secret to every local
   * user with NO content change, direct harm a content-only fingerprint waves
   * through (codex #139 P1; the codebase already warns "mode 0644, wider than
   * recommended 0600"). Deliberately FALSE for the two shared Claude files: those
   * are Claude-Code-owned + ambient, a mode change there is not a relay-content
   * clobber, and folding mode in would re-admit the false-trips this rewrite
   * removed. relay-owned+secret-bearing vs shared+ambient — never collapse them.
   */
  fingerprintMode?: boolean;
}

export function protectedRegions(): ProtectedRegion[] {
  const home = os.homedir();
  return [
    { path: path.join(home, ".claude.json"), extract: claudeJsonRegion, label: 'mcpServers["bot-relay"]' },
    { path: path.join(home, ".claude", "settings.json"), extract: claudeSettingsRegion, label: "relay SessionStart hook (check-relay.sh)" },
    { path: path.join(home, ".bot-relay", "config.json"), extract: botRelayConfigRegion, label: "~/.bot-relay/config.json (content + mode)", fingerprintMode: true },
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
  let region = p.extract(raw);
  if (p.fingerprintMode) {
    let mode = "?";
    try {
      mode = (fs.statSync(p.path).mode & 0o777).toString(8);
    } catch {
      /* keep "?" — a stat failure is itself a change from a readable file */
    }
    region = `${region}::mode=${mode}`;
  }
  return region;
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
