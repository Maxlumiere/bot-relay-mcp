// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.2.2 P3 — deterministic terminal-targeting (the v0.3 multi-agent prereq).
//
// The inbox wake must type `inbox` into the terminal that BELONGS to the
// target agent — never whichever terminal happens to be focused. The pre-v0.2.2
// behaviour matched `terminal.name === agentName` and, on a miss, fell back to
// `vscode.window.activeTerminal`; because Tether names spawned terminals
// `Tether: <name>` the exact match never hit, so every wake landed on the
// focused terminal (the 2026-06-11 Half-B cross-agent mis-injection). For
// multi-agent setups (several agents, each in its own terminal) a wrong wake
// nudges the WRONG agent and corrupts coordination.
//
// This module is the pure, VSCode-free decision core (unit-tested in isolation):
// it takes an agent name + the list of terminals and returns a deterministic
// decision. It NEVER considers the active/focused terminal.

/** The minimal shape this module needs from a terminal. */
export interface NamedTerminal {
  readonly name: string;
}

export type WakeDecision<T extends NamedTerminal> =
  | { kind: "inject"; terminal: T }
  | { kind: "no-match"; agentName: string }
  | { kind: "ambiguous"; agentName: string; matches: T[] };

/**
 * The terminal name Tether gives a spawned agent. SINGLE SOURCE OF TRUTH —
 * `agent-manager.ts` spawns with this exact name so the spawn convention can
 * never drift from what the matcher looks for.
 */
export function tetherTerminalName(agentName: string): string {
  return `Tether: ${agentName}`;
}

/**
 * Decide which terminal to wake for `agentName`. A terminal owns the agent
 * when its name is EITHER the bare agent name (operator-opened — e.g. a
 * `vscode-<agent>` relaunch alias names its terminal `<agent>`) OR
 * the Tether spawn convention `Tether: <name>`.
 *
 * Rulings (v0.2.2, locked):
 *  - exactly 1 match → inject.
 *  - 0 matches      → no-inject (caller surfaces a status-bar hint; the mail is
 *                     still in the inbox to drain — a missed wake is recoverable).
 *  - >1 matches     → no-inject (NEVER wake a guess — a wrong wake corrupts
 *                     coordination; ambiguity is worse than silence).
 *  - the active/focused terminal is NEVER a fallback (it is not even an input).
 *
 * v0.3 will add a registration handshake (a terminal advertises its agent to
 * the extension) for object-identity + anti-spoofing; that handshake MUST honor
 * the transient-identity-governance rule (a terminal cannot claim a reserved
 * persona without that name's token). The convention here is the v0.2.2 contract.
 */
export function resolveWakeTarget<T extends NamedTerminal>(
  agentName: string,
  terminals: readonly T[],
): WakeDecision<T> {
  if (!agentName) return { kind: "no-match", agentName };
  const want = new Set([agentName, tetherTerminalName(agentName)]);
  const matches = terminals.filter((t) => want.has(t.name));
  if (matches.length === 1) return { kind: "inject", terminal: matches[0] };
  if (matches.length === 0) return { kind: "no-match", agentName };
  return { kind: "ambiguous", agentName, matches };
}
