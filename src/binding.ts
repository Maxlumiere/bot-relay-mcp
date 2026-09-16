// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 S1 — pure resolvers for `relay bind`.
 *
 * Kept OUT of the CLI on purpose. Two of the decisions below cannot be reached
 * through a spawned verb, so putting them in the IO layer would make them
 * untestable: a test process has no `claude` ancestor (detectAgentProcess()
 * returns null there), and the "detected anchor disagrees with CLAUDE_PID"
 * refusal never fires when detection finds nothing. As pure functions every
 * branch is exercised directly — including the refusals, which victra required
 * be pinned as hard as the happy path.
 *
 * THE RULE THESE ENCODE (§8a amendment d): a bind writes the window's REAL
 * anchor or it writes nothing. It never guesses, never picks a side when two
 * sources disagree, and never records a pid without the start time that makes
 * it an anchor rather than a number the OS will hand to someone else.
 */
import { processStartedAt, type AgentProcess } from "./liveness.js";

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
