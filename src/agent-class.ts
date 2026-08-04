// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0002 (v2.21.0) — agent coordination-class taxonomy. SINGLE SOURCE OF TRUTH.
 *
 * GOVERNING PRINCIPLE: `class` is an agent's COARSE COORDINATION POSTURE — the
 * tier it occupies in the team — NOT what it does. Three ORTHOGONAL axes, never
 * conflate:
 *   • role       — free-text human label (e.g. "planner", "ops"). Unchanged by
 *                  ADR-0002; the three existing role vocabularies stay as-is.
 *   • class      — THIS axis: a small, controlled coordination posture.
 *   • capability — what the agent DOES (routing / authz). NOT this.
 * Keep the set COARSE. If a value describes what an agent *does*, it belongs in
 * `capability`, not here — otherwise `class` collapses into `capability`.
 *
 * This file is the ONE place agent-class string literals may live. The
 * agent-class drift guard (scripts/agent-class-guard.mjs) rejects any parallel
 * agent-class vocabulary or class-branch defined elsewhere in src/ — mirroring
 * the agent-cli-profiles registry pattern — to prevent a taxonomy re-fork.
 * Every other file imports the values + the Zod enum from here.
 */

import { z } from "zod";

/**
 * The coordination classes an agent may SELF-DECLARE at `register_agent`
 * (immutable thereafter, like `managed`/`host_id`).
 *   - orchestrator: coordinates + dispatches; owns sequencing and gates.
 *   - builder:      implements changes; produces the diffs under review.
 *   - advisory:     advises on design/architecture; does not implement.
 *   - auditor:      independently reviews + verifies before work lands.
 *   - transient:    short-lived / task-scoped; not a standing team member.
 */
export const DECLARABLE_AGENT_CLASSES = [
  "orchestrator",
  "builder",
  "advisory",
  "auditor",
  "transient",
] as const;

/**
 * Sentinel for legacy/undeclared rows — NOT self-declarable. Assigned when
 * `class` is omitted at register. Its own bucket; hidden from the default
 * topology who's-who until the agent re-declares a real class.
 */
export const UNCLASSIFIED = "unclassified" as const;

/** The `transient` class as a const, so consumers branch on it WITHOUT hardcoding the literal (the drift guard rejects class-value literals outside this file). */
export const TRANSIENT = "transient" as const;

/**
 * Reserved-but-inactive class names — name-squatted so nothing re-purposes them.
 * `bridge` = a future funnel ingress/egress node (federation); reserved for a
 * later version, rejected at register in v1 (it's not in DECLARABLE_AGENT_CLASSES).
 */
export const RESERVED_AGENT_CLASSES = ["bridge"] as const;

/** Every value that may appear in `agents.class`: the declarable set + the sentinel. */
export const ALL_AGENT_CLASSES = [...DECLARABLE_AGENT_CLASSES, UNCLASSIFIED] as const;

export type DeclarableAgentClass = (typeof DECLARABLE_AGENT_CLASSES)[number];
export type AgentClass = (typeof ALL_AGENT_CLASSES)[number];

/** Zod enum for the register_agent input — ONLY the declarable classes are accepted. */
export const AgentClassEnum = z.enum(DECLARABLE_AGENT_CLASSES);

/**
 * Classes EXCLUDED from the default topology "who's-who" (discover_agents
 * view='topology'): `transient` (a live-but-ephemeral, non-standing member) and
 * `unclassified` (no declared posture). Dead/terminal agents are excluded
 * SEPARATELY via the liveness verdict — two distinct concepts.
 */
export const TOPOLOGY_HIDDEN_CLASSES: ReadonlySet<string> = new Set<string>([UNCLASSIFIED, "transient"]);

/**
 * The classes SHOWN in the default topology who's-who, in display order —
 * every declarable class that is NOT topology-hidden (i.e. the standing team:
 * orchestrator, builder, advisory, auditor). Derived so it can never drift from
 * DECLARABLE_AGENT_CLASSES / TOPOLOGY_HIDDEN_CLASSES.
 */
export const TOPOLOGY_VISIBLE_CLASSES = DECLARABLE_AGENT_CLASSES.filter(
  (c) => !TOPOLOGY_HIDDEN_CLASSES.has(c),
) as readonly DeclarableAgentClass[];

/** One-line description per class — feeds the SessionStart onboarding roster text. */
export const AGENT_CLASS_DESCRIPTIONS: Record<AgentClass, string> = {
  orchestrator: "Coordinates + dispatches work; owns sequencing and gates.",
  builder: "Implements changes; produces the diffs under review.",
  advisory: "Advises on design / architecture; does not implement.",
  auditor: "Independently reviews + verifies work before it lands.",
  transient: "Short-lived / task-scoped agent; not a standing team member.",
  unclassified: "No coordination class declared (legacy or undeclared).",
};

/** Normalize a stored/absent class to a valid AgentClass (NULL / unknown → unclassified). */
export function normalizeAgentClass(raw: string | null | undefined): AgentClass {
  if (raw && (ALL_AGENT_CLASSES as readonly string[]).includes(raw)) return raw as AgentClass;
  return UNCLASSIFIED;
}
