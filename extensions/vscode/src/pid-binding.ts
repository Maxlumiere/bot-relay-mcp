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
 * Is `pid` a host-scoped member of the agent's chain? True only when: the agent
 * registered a non-empty PID chain; BOTH host ids are known AND equal (an equal
 * PID on a different host must NOT match — the federation-safety boundary); and
 * the pid is in the chain. The single-pid primitive shared by the full matcher
 * and the cache fast-path re-validation.
 */
export function isHostScopedMember(
  binding: AgentPidBinding,
  localHostId: string | null,
  pid: number | undefined,
): boolean {
  if (pid === undefined) return false;
  if (!binding.hostShellPids || binding.hostShellPids.length === 0) return false;
  if (!binding.hostId || !localHostId || binding.hostId !== localHostId) return false;
  return binding.hostShellPids.includes(pid);
}

/**
 * Try to bind by PID, host-scoped. Returns a decision only when the PID layer is
 * authoritative; returns null to mean "PID layer abstains — fall back to name".
 *
 * Abstains (null) when no live terminal's processId is a host-scoped member of
 * the chain (covers: no chain registered, host_id missing/mismatched, or no
 * matching live terminal). Exactly-one match → inject. >1 → ambiguous.
 */
function tryPidMatch<T extends PidNamedTerminal>(
  agentName: string,
  binding: AgentPidBinding,
  localHostId: string | null,
  terminals: readonly T[],
): WakeDecision<T> | null {
  const matches = terminals.filter((t) => isHostScopedMember(binding, localHostId, t.processId));
  if (matches.length === 1) return { kind: "inject", terminal: matches[0] };
  if (matches.length === 0) return null; // abstain → let name matching try
  return { kind: "ambiguous", agentName, matches };
}

/**
 * Pure parse of a `discover_agents` result into the inbox-owner agent's binding.
 * Tolerant of shape drift / junk (→ null fields, never throws). Returns null
 * when the agent isn't in the roster.
 */
export function parseAgentBinding(discoverResult: unknown, agentName: string): AgentPidBinding | null {
  const agents =
    discoverResult && typeof discoverResult === "object"
      ? (discoverResult as { agents?: unknown }).agents
      : undefined;
  if (!Array.isArray(agents)) return null;
  const row = agents.find(
    (a) => a && typeof a === "object" && (a as { name?: unknown }).name === agentName,
  ) as { host_shell_pids?: unknown; host_id?: unknown } | undefined;
  if (!row) return null;
  const pids =
    Array.isArray(row.host_shell_pids) && row.host_shell_pids.every((n) => typeof n === "number")
      ? (row.host_shell_pids as number[])
      : null;
  const hostId = typeof row.host_id === "string" ? row.host_id : null;
  return { hostShellPids: pids, hostId };
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
