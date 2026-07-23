// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// ADR-0010 — WAKE ROUTING BY OBSERVED AGENT-STATE (the minimal slice).
//
// The three wake mechanisms are PERMANENT properties of the host, not
// artefacts of our design: Tether injects into an IDLE agent's prompt, the
// PostToolUse hook delivers to a BUSY one (mail rides the next tool result),
// Sentinel is the floor for a PARKED one. What was missing was not fewer
// mechanisms but a ROUTING MODEL: observe each agent's state and which driver
// covers it, then dispatch to the right one — never two drivers at once.
//
// This module is that model's first instance, extracted pure so a control
// plane can later formalise it rather than delete it. It answers ONE
// question: given what Tether can OBSERVE about an agent right now, should
// Tether inject a wake?
//
// The concrete defect that forced it (2026-07-23): fourteen verbatim wake
// prompts stacked in the operator's input box during one 70-minute turn.
// Tether injected once per message; every injection queued (busy agents
// don't submit); the PostToolUse hook meanwhile delivered every message —
// each drain re-armed the naive per-message gate. The fix is not a better
// consumption heuristic — inbox-drain and injection-consumption are
// DIFFERENT EVENTS on a busy agent, and nothing relay-side distinguishes
// which path drained. The fix is routing: A BUSY AGENT WHOSE CLI INSTALLS A
// TOOL-RESULT HOOK IS ALREADY REACHABLE AND GETS NO INJECTION AT ALL.
//
// Anti-stranding invariant (the trap in every earlier design): suppression
// decisions are only safe if they are RE-EVALUATED when the observed state
// changes. Busy is transient; a suppressed wake must fire once the agent is
// observed idle. The caller guarantees that by re-routing on Tether's poll
// tick as well as on inbox events — never only on the arrival notification.

/** What Tether can observe about an agent at decision time. */
export type ObservedAgentState = "idle" | "busy" | "unknown";

export interface WakeRouteInput {
  /** Pending (undrained) mail exists — the only reason to wake at all. */
  readonly pendingMail: boolean;
  /** Observed liveness-derived state (v2.19 verdict: activity-inferred). */
  readonly state: ObservedAgentState;
  /** Does this agent's CLI install a tool-result (PostToolUse-class) hook —
   *  i.e. is a BUSY agent already covered by another driver? From the
   *  agent-CLI profile registry; claude: yes, codex: no. */
  readonly busyCoveredByHook: boolean;
  /** A previous injection is outstanding (queued, unconsumed as far as we
   *  can observe). */
  readonly outstanding: boolean;
}

export type WakeRoute =
  | { action: "inject"; reason: string }
  | { action: "suppress"; reason: string };

/**
 * The routing decision. Pure — all observation happens in the caller.
 *
 * Mis-observation costs are deliberately asymmetric and bounded:
 *  - busy read as idle → one redundant queued line (cosmetic);
 *  - idle read as busy → the wake fires on the next re-route tick (delay,
 *    never loss — the caller's re-evaluation invariant guarantees it).
 */
export function routeWake(input: WakeRouteInput): WakeRoute {
  if (!input.pendingMail) {
    return { action: "suppress", reason: "no pending mail" };
  }
  // A busy agent with tool-result hook coverage is ALREADY REACHABLE — its
  // mail rides the next tool call. Injecting would only queue noise it must
  // clear by hand. (ADR-0010: Tether's job is to wake an IDLE agent.)
  if (input.state === "busy" && input.busyCoveredByHook) {
    return { action: "suppress", reason: "busy + hook-covered — PostToolUse owns delivery" };
  }
  // One injection outstanding at a time. An IDLE observation is flush
  // evidence — the host submits queued input at the turn boundary, so an
  // idle agent cannot still hold our injection — and clears the flag in the
  // caller before this route runs.
  if (input.outstanding) {
    return { action: "suppress", reason: "an injection is already outstanding" };
  }
  return { action: "inject", reason: `state=${input.state} — Tether owns this wake` };
}
