// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.3.0 PID-handshake — Tether-side wake resolution (VSCode-free, unit-tested).
//
// PID-PRIMARY, name-FALLBACK. Given the inbox-owner agent's registered binding
// (host_shell_pids + host_id, from discover_agents), THIS VS Code instance's own
// machine GUID, and the open terminals with their resolved processId, bind the
// wake to the terminal whose processId is in the agent's ancestry chain — no
// naming, no rename, regardless of how the agent was launched. When the PID
// layer can't decide (no binding, different host, or no live terminal matches),
// fall back to the v0.2.2 deterministic NAME matcher. The 0/>1 safety (no-inject
// + status-bar hint) is applied downstream by the caller, exactly as in v0.2.2.

import {
  resolveWakeTarget,
  type WakeDecision,
  type NamedTerminal,
} from "./terminal-targeting.js";

export interface AgentPidBinding {
  /** The agent's registered process-ancestry PID chain (null/empty = not reported). */
  readonly hostShellPids: number[] | null;
  /** The agent's registered machine GUID (null = not reported). */
  readonly hostId: string | null;
}

/** A terminal plus its resolved `vscode.Terminal.processId` (undefined until the
 *  shell spawns, or for extension-pty terminals — treated as "no PID"). */
export interface PidNamedTerminal extends NamedTerminal {
  readonly processId: number | undefined;
}

/**
 * Try to bind by PID, host-scoped. Returns a decision only when the PID layer is
 * authoritative; returns null to mean "PID layer abstains — fall back to name".
 *
 * Abstains (null) when: no PID chain registered; OR host-scoping can't be
 * guaranteed (either host_id missing, or they differ — a different host's equal
 * PID must NOT match); OR no live terminal's processId is in the chain.
 * Exactly-one match → inject. >1 → ambiguous (never guess).
 */
function tryPidMatch<T extends PidNamedTerminal>(
  agentName: string,
  binding: AgentPidBinding,
  localHostId: string | null,
  terminals: readonly T[],
): WakeDecision<T> | null {
  const pids = binding.hostShellPids;
  if (!pids || pids.length === 0) return null;
  // Host-scoping is a correctness boundary: only intersect PIDs when BOTH host
  // ids are known AND equal. Equal PIDs on different hosts never false-match.
  if (!binding.hostId || !localHostId || binding.hostId !== localHostId) return null;
  const want = new Set(pids);
  const matches = terminals.filter((t) => t.processId !== undefined && want.has(t.processId));
  if (matches.length === 1) return { kind: "inject", terminal: matches[0] };
  if (matches.length === 0) return null; // no live terminal → let name matching try
  return { kind: "ambiguous", agentName, matches };
}

/**
 * Resolve the wake target: PID-primary (host-scoped) then the v0.2.2 name
 * matcher. The name fallback keeps every pre-handshake case working (agents that
 * haven't reported PIDs, or before discover_agents has the binding).
 */
export function resolveWakeTargetByPid<T extends PidNamedTerminal>(
  agentName: string,
  binding: AgentPidBinding,
  localHostId: string | null,
  terminals: readonly T[],
): WakeDecision<T> {
  return (
    tryPidMatch(agentName, binding, localHostId, terminals) ??
    resolveWakeTarget(agentName, terminals)
  );
}
