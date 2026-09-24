// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 — pure resolvers for window-bound identity.
 *
 * S1 (`relay bind`): resolve the window anchor, the cwd, the bind reason and the
 * agent name. S3-lite (continuity rebind, rows 1 and 4): decide whether a window
 * presenting a known conversation may take that conversation's identity.
 *
 * Kept OUT of the CLI on purpose. Several decisions here cannot be reached
 * through a spawned verb, so putting them in the IO layer would make them
 * untestable: a test process has no `claude` ancestor (detectAgentProcess()
 * returns null there), the "detected anchor disagrees with CLAUDE_PID" refusal
 * never fires when detection finds nothing, and a continuity claim needs a
 * liveness verdict that cannot be produced on demand. As pure functions every
 * branch is exercised directly — including the refusals, which victra required
 * be pinned as hard as the happy path.
 *
 * THE RULE THESE ENCODE (§8a amendment d): a bind writes the window's REAL
 * anchor or it writes nothing. It never guesses, never picks a side when two
 * sources disagree, and never records a pid without the start time that makes
 * it an anchor rather than a number the OS will hand to someone else.
 */
import { processStartedAt, type AgentProcess } from "./liveness.js";
import type { AnchorVerdict } from "./liveness.js";
import { randomBytes } from "crypto";
import { AGENT_NAME_PATTERN } from "./types.js";

/** A window anchor: the pid AND the start time that makes it reusable-proof. */
export interface WindowAnchor {
  pid: number;
  startedAt: string;
}

export type AnchorResolution =
  | { ok: true; anchor: WindowAnchor; source: "claude-pid" | "detected" | "agreed" }
  | { ok: false; reason: string };

export interface ResolveWindowAnchorInput {
  /** `CLAUDE_PID` from the hook environment, when Claude Code set it. */
  claudePid: number | null;
  /** What the ancestry walk found, or null when it found no agent process. */
  detected: AgentProcess | null;
  /** Reads a live pid's start-time token. Injectable for tests. */
  startedAtFor?: (pid: number) => string | null;
}

/**
 * Decide the window anchor, or refuse.
 *
 *   both, agreeing        → that anchor
 *   both, DISAGREEING     → refuse, naming BOTH pids (never pick one)
 *   CLAUDE_PID only       → use it (a failed detection is not a disagreement)
 *   detection only        → use it
 *   neither               → refuse
 *   any pid whose start time cannot be read → refuse (a pid alone is not an anchor)
 */
export function resolveWindowAnchor(input: ResolveWindowAnchorInput): AnchorResolution {
  const startedAtFor = input.startedAtFor ?? ((pid: number) => processStartedAt(pid));
  const { claudePid, detected } = input;

  if (claudePid != null && detected != null && claudePid !== detected.pid) {
    return {
      ok: false,
      reason:
        `the window anchor is ambiguous: CLAUDE_PID=${claudePid} but the process walk found pid ${detected.pid}. ` +
        `Refusing to pick one — a binding on the wrong window points the fleet list at the wrong terminal.`,
    };
  }

  if (detected != null) {
    const startedAt = detected.startedAt || startedAtFor(detected.pid);
    if (!startedAt) {
      return { ok: false, reason: `could not read the start time for pid ${detected.pid}; a pid alone is not an anchor` };
    }
    return { ok: true, anchor: { pid: detected.pid, startedAt }, source: claudePid != null ? "agreed" : "detected" };
  }

  if (claudePid != null) {
    const startedAt = startedAtFor(claudePid);
    if (!startedAt) {
      return {
        ok: false,
        reason: `could not read the start time for CLAUDE_PID=${claudePid}; the process is gone or unreadable, so there is no anchor to record`,
      };
    }
    return { ok: true, anchor: { pid: claudePid, startedAt }, source: "claude-pid" };
  }

  return {
    ok: false,
    reason: "no window anchor: CLAUDE_PID is unset and no agent process was found in this process's ancestry",
  };
}

export interface ResolveBindCwdInput {
  /** `CLAUDE_PROJECT_DIR` from the environment. */
  projectDir?: string | null;
  /** The `cwd` field of the hook payload. */
  stdinCwd?: string | null;
  /** `process.cwd()`. */
  processCwd: string;
}

/**
 * ONE cwd precedence, stated once (§8a amendment e): CLAUDE_PROJECT_DIR →
 * stdin cwd → process.cwd(). This is the directory the printed resume command
 * will `cd` into, so a wrong answer produces a command that does not resume.
 */
export function resolveBindCwd(input: ResolveBindCwdInput): string {
  const candidates = [input.projectDir, input.stdinCwd, input.processCwd];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return input.processCwd;
}

/**
 * How this binding came to exist, from the SessionStart `source` (S1 records;
 * it never rebinds — automatic rebind is S3-lite, rows 1/4/11).
 *   clear → clear-carry (the identity carries to the new conversation id)
 *   fork  → fork (a new conversation that must never share the parent's name)
 *   else  → launch-intent when the window carries a name, transient when it does not
 */
export function boundViaForSource(source: string | null | undefined, isNamed: boolean): string {
  if (source === "clear") return "clear-carry";
  if (source === "fork") return "fork";
  return isNamed ? "launch-intent" : "transient";
}

/**
 * ADR-0036 S3-lite (rows 1 and 4) — may this window take the conversation's
 * identity?
 *
 * ROW 1, verbatim: "Hook fires (resume, C). C is bound to X; X's anchor is dead.
 * Rebind X to this window under CAS on binding_version." ROW 4: "Same as row 1."
 *
 * §3 tier 1 (CONTINUITY) is the only automatic claim this resolver grants: the
 * relay's OWN record says conversation C held name X, and a window now presents
 * C. That is the strongest claim available on one machine, because the relay
 * wrote it — unlike a title, a rename, or an agent asking, all of which §3 tier 3
 * refuses outright.
 *
 * THE BRANCH TABLE, exhaustive:
 *   prior anchor DEAD            → claim X, CAS pinned to the version we READ
 *   prior anchor ALIVE           → REFUSE (another window holds X right now)
 *   prior anchor UNVERIFIABLE    → REFUSE (see below — this is the load-bearing one)
 *   prior binding has NO name    → REFUSE (an unnamed window is not an identity)
 *   prior anchor IS this window  → REFRESH, never a takeover against yourself
 *
 * WHY `unverifiable` REFUSES, and why it is a separate branch rather than a
 * footnote: `anchorLivenessVerdict` COLLAPSES "observed alive (start time
 * matched)" with "present but unverifiable (no or unreadable start anchor, so
 * PID reuse cannot be excluded)" into a single `alive`. So `alive` means NOT
 * OBSERVED DEAD. Gating the claim on `dead` therefore refuses the live case AND
 * the unverifiable one, which is the conservative direction: failing toward NOT
 * acting is the entire safety argument for an automatic takeover. Treating
 * `unverifiable` as "probably gone" is the one mistake that silently cuts a live
 * agent's token.
 *
 * IT DECIDES, IT DOES NOT ACT. The release-then-claim write lives in db.ts,
 * where the sanctioned-mutation guard requires every `agents` / `agent_bindings`
 * mutation to live. This function reads nothing and writes nothing.
 */
export interface ContinuityPriorBinding {
  binding_id: string;
  binding_version: number;
  agent_name: string | null;
  conversation_id: string;
  host_id: string;
  window_pid: number;
  window_pid_start: string;
}

export interface ResolveContinuityClaimInput {
  /** The CURRENT binding the relay holds for the conversation being presented. */
  priorBinding: ContinuityPriorBinding;
  /** `anchorLivenessVerdict` for that prior binding's anchor. */
  priorAnchorVerdict: AnchorVerdict;
  /** The window asking — this session's own resolved anchor. */
  thisAnchor: { hostId: string; pid: number; startedAt: string };
}

export type ContinuityClaim =
  | {
      ok: true;
      action: "claim";
      agentName: string;
      /** CAS value: the version we READ, so a concurrent rebind loses. */
      expectedBindingVersion: number;
      boundVia: "continuity";
    }
  | { ok: true; action: "refresh"; agentName: string | null }
  | { ok: false; reason: string };

export function resolveContinuityClaim(input: ResolveContinuityClaimInput): ContinuityClaim {
  const { priorBinding: prior, priorAnchorVerdict, thisAnchor } = input;

  // Same window, same conversation: this is the window that already holds it.
  // A release-then-claim here would rotate the session of a live, correct window
  // for no reason — so it is a refresh, whatever the verdict says.
  if (
    prior.host_id === thisAnchor.hostId &&
    prior.window_pid === thisAnchor.pid &&
    prior.window_pid_start === thisAnchor.startedAt
  ) {
    return { ok: true, action: "refresh", agentName: prior.agent_name };
  }

  if (!prior.agent_name || isTransientName(prior.agent_name)) {
    return {
      ok: false,
      reason:
        `conversation ${prior.conversation_id} is bound to an UNNAMED window, which is not an identity to ` +
        `inherit — this window binds as itself instead`,
    };
  }

  if (priorAnchorVerdict === "alive") {
    return {
      ok: false,
      reason:
        `"${prior.agent_name}" is held by a window that is ALIVE (pid ${prior.window_pid} on this host), so this ` +
        `window will not take it. Identity moves only when the holder is provably gone. If that window is in ` +
        `fact dead, clear it with \`relay release-binding ${prior.agent_name}\` and resume again.`,
    };
  }

  if (priorAnchorVerdict === "unverifiable") {
    return {
      ok: false,
      reason:
        `"${prior.agent_name}" holds conversation ${prior.conversation_id}, but its anchor CANNOT BE VERIFIED on ` +
        `this host (a different machine, or no readable start time — so pid reuse cannot be excluded). ` +
        `Unverifiable is NOT dead, and taking a name whose holder cannot be observed is how a live agent loses ` +
        `its token. Confirm the old window is gone, then ` +
        `\`relay release-binding ${prior.agent_name} --override\` and resume again.`,
    };
  }

  return {
    ok: true,
    action: "claim",
    agentName: prior.agent_name,
    expectedBindingVersion: prior.binding_version,
    boundVia: "continuity",
  };
}

/** Agent names the relay accepts — same allowlist the hooks enforce. */
const AGENT_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The window's claimed name, or null for an unnamed window. An invalid name is
 * NOT an error here: it simply is not a name, and the window binds as unnamed
 * rather than failing the whole bind (row 11 — every window ends up recorded).
 */
export function resolveAgentName(envName: string | null | undefined): string | null {
  if (typeof envName !== "string") return null;
  const trimmed = envName.trim();
  if (!trimmed || trimmed === "default") return null;
  return AGENT_NAME_RE.test(trimmed) ? trimmed : null;
}

/**
 * ADR-0036 row 11, pulled forward from S4 into S3-lite (victra ruling B,
 * provisional pending architect). A window that is nobody gets a unique
 * TRANSIENT LABEL instead of the shared `default` path. The label lives ONLY in
 * agent_bindings: never an agents row, never a token, never an inbox. So it is
 * not an identity, adds no auth surface, and needs no reaper.
 *
 * `tmp:<folder>:<4hex>`: the folder name so a human can tell windows apart in
 * `relay fleet`, and 4 random hex digits so two windows in the same folder
 * differ.
 *
 * OUTSIDE AGENT_NAME_PATTERN BY CONSTRUCTION (architect ruling B1): the colons
 * are not in [A-Za-z0-9_.-], so a transient label can never collide with, be
 * registered as, or be addressed as a real agent. The first form, `tmp-…`, was
 * inside the pattern, and 7 real agents already hold `tmp-` names (MEASURED on the
 * live DB, 24 Sep). The folder part is reduced to [a-z0-9-]; it is still data, so
 * any pasted line quotes it.
 */
export const TRANSIENT_PREFIX = "tmp:";

export function isTransientName(name: string | null | undefined): boolean {
  return typeof name === "string" && name.startsWith(TRANSIENT_PREFIX);
}

export function transientNameFor(cwd: string | null, randomHex4: () => string = () => randomBytes(2).toString("hex")): string {
  const base = (cwd ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "window";
  const hex = randomHex4();
  if (!/^[0-9a-f]{4}$/.test(hex)) throw new Error(`transient label suffix ${JSON.stringify(hex)} is not 4 hex digits`);
  const name = `${TRANSIENT_PREFIX}${slug}:${hex}`;
  // AGENT_NAME_PATTERN from types.ts, deliberately NOT a copy (binding.ts already
  // carries one duplicate of it; flagged, not refactored here). The label must
  // FAIL it: that is what keeps a label out of every name-keyed path.
  if (AGENT_NAME_PATTERN.test(name)) throw new Error(`transient label ${JSON.stringify(name)} would be a valid agent name`);
  return name;
}
