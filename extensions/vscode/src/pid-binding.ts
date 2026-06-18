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
import { walkAncestry, walkDescendants } from "./host-identity.js";

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
 * v0.3.1 — host-scoped membership that tolerates the off-by-one between the PID
 * the hook recorded and the PID VS Code surfaces as `Terminal.processId`.
 *
 * THE v0.3.0 T-ACC FAILURE: the hook records the agent's full process-ancestry
 * CHAIN (own PID → … → controlling shell → ptyHost → Code). `Terminal.processId`
 * is *a* node on that same root-to-leaf spine — but WHICH node VS Code reports can
 * differ by a hop (login-vs-interactive shell, a shell-integration wrapper, or
 * Claude Code's own pty/daemon interposition). On Maxime's host the shell pid
 * 62903 WAS in the chain, yet the single `.includes(processId)` matched 0
 * terminals — because the pid VS Code actually exposed wasn't the literal chain
 * member. The chain was recorded for exactly this reason: match if `pid` itself
 * OR any ANCESTOR or any DESCENDANT of it is in the chain.
 *
 * Host-scoping is UNCHANGED — an equal PID on a different host must still never
 * match (the federation-safety boundary). When `table` is null/empty this degrades
 * to the exact `isHostScopedMember` check, so it can never be a false negative
 * relative to v0.3.0.
 */
export function isHostScopedTreeMember(
  binding: AgentPidBinding,
  localHostId: string | null,
  pid: number | undefined,
  table: ReadonlyMap<number, number> | null,
): boolean {
  // Exact, host-scoped — the v0.3.0 contract (and the cache fast-path primitive).
  if (isHostScopedMember(binding, localHostId, pid)) return true;
  // Tree widening only when we have a pid, a snapshot, and the same host-scoping
  // guarantees the exact check enforces (re-asserted so the tree path can never
  // bypass the federation boundary).
  if (pid === undefined || !table || table.size === 0) return false;
  if (!binding.hostShellPids || binding.hostShellPids.length === 0) return false;
  if (!binding.hostId || !localHostId || binding.hostId !== localHostId) return false;
  const chain = new Set(binding.hostShellPids);
  // Ancestors of pid (walkAncestry[0] is pid itself, which already failed the
  // exact check above — the useful members are its ancestors) …
  for (const a of walkAncestry(pid, table)) if (chain.has(a)) return true;
  // … and descendants of pid (the agent process typically lives BELOW the shell).
  for (const d of walkDescendants(pid, table)) if (chain.has(d)) return true;
  return false;
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
  table: ReadonlyMap<number, number> | null,
): WakeDecision<T> | null {
  const matches = terminals.filter((t) =>
    isHostScopedTreeMember(binding, localHostId, t.processId, table),
  );
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
  table: ReadonlyMap<number, number> | null = null,
): WakeDecision<T> {
  return (
    tryPidMatch(agentName, binding, localHostId, terminals, table) ??
    resolveWakeTarget(agentName, terminals)
  );
}

/**
 * Live-wake orchestration (VSCode-free; the extension supplies the impure deps).
 *
 * v0.3.0 R1 (codex P1): the binding MUST be fresh per wake — a stale cached
 * binding wakes the wrong terminal after a same-name re-register. So
 * `fetchBinding` is called every wake (the extension's getAgentBinding hits
 * discover_agents fresh, no TTL). The bound-terminal cache is the only cache,
 * and it's self-invalidating: the fast path re-validates the cached terminal's
 * processId against the FRESH binding via isHostScopedMember — if the agent
 * re-registered/moved, the stale terminal fails that check and we re-resolve.
 */
export interface WakeDeps<T> {
  /** ALWAYS-fresh agent binding (discover_agents per wake; never a stale cache). */
  fetchBinding(agentName: string): Promise<AgentPidBinding>;
  localHostId: string | null;
  openTerminals(): readonly T[];
  nameOf(t: T): string;
  processIdOf(t: T): Promise<number | undefined>;
  /** v0.3.1 — OS pid→ppid snapshot for tree-intersection matching. Called at
   *  most once per wake, and only when an exact PID match has already failed
   *  (so the common case pays no `ps`). Empty map = unavailable → the matcher
   *  degrades to the exact v0.3.0 check. */
  processTable(): ReadonlyMap<number, number>;
  cacheGet(agentName: string): T | undefined;
  cacheSet(agentName: string, t: T): void;
  cacheClear(agentName: string): void;
  wake(t: T): void;
  hint(message: string): void;
  log(line: string): void;
}

export async function resolveAndWake<T>(agentName: string, deps: WakeDeps<T>): Promise<void> {
  const binding = await deps.fetchBinding(agentName); // FRESH — no stale-cache window
  const open = deps.openTerminals();

  // Could a process-tree widening even help here? Only when a non-empty chain is
  // registered on THIS host. Gates the one `ps` snapshot so name-only / no-binding
  // wakes pay nothing, and re-asserts the host-scoping boundary up front.
  const hostScopable =
    !!binding.hostShellPids &&
    binding.hostShellPids.length > 0 &&
    !!binding.hostId &&
    !!deps.localHostId &&
    binding.hostId === deps.localHostId;

  // Fast path: a previously-bound terminal still open AND still a member of the
  // FRESH chain → wake without re-awaiting every processId. Exact check first
  // (sync, no `ps`); widen to the tree only if exact fails AND it could match.
  const cached = deps.cacheGet(agentName);
  if (cached && open.includes(cached)) {
    const cachedPid = await deps.processIdOf(cached);
    if (
      isHostScopedMember(binding, deps.localHostId, cachedPid) ||
      (hostScopable && isHostScopedTreeMember(binding, deps.localHostId, cachedPid, deps.processTable()))
    ) {
      deps.wake(cached);
      return;
    }
    deps.cacheClear(agentName); // stale (re-register / moved) → re-resolve
  }

  // Full resolve: await each open terminal's processId once, THEN decide.
  const wrappers = await Promise.all(
    open.map(async (t) => ({ t, name: deps.nameOf(t), processId: await deps.processIdOf(t) })),
  );

  // v0.3.1 instrumentation — ONE diagnostic line per wake. This is the
  // observability the v0.3.0 T-ACC lacked: the binding the ext actually resolved
  // (post-fetch + post-parse) plus every terminal's resolved processId. A bind
  // miss is now debuggable straight from the Output channel — no special build.
  deps.log(
    `pid-binding: resolve agent="${agentName}" localHostId=${deps.localHostId ?? "∅"} ` +
      `binding.hostId=${binding.hostId ?? "∅"} ` +
      `binding.hostShellPids=${binding.hostShellPids ? `[${binding.hostShellPids.join(",")}]` : "∅"} ` +
      `terminals=${JSON.stringify(wrappers.map((w) => ({ name: w.name, pid: w.processId ?? null })))}`,
  );

  // PID-primary with exact > tree > name precedence. Exact PID pass is sync; only
  // if it abstains (and a widening could help) do we pay for one process-table
  // snapshot and retry the tree-intersection matcher. Name matcher is the last
  // resort (pre-handshake compatibility), exactly as in v0.3.0.
  let matchVia: "pid-exact" | "pid-tree" | "name" = "pid-exact";
  let decision: WakeDecision<(typeof wrappers)[number]> | null = tryPidMatch(
    agentName,
    binding,
    deps.localHostId,
    wrappers,
    null,
  );
  if (!decision && hostScopable) {
    const table = deps.processTable();
    if (table.size > 0) {
      const treeMatch = tryPidMatch(agentName, binding, deps.localHostId, wrappers, table);
      if (treeMatch) {
        decision = treeMatch;
        matchVia = "pid-tree";
      }
    }
  }
  if (!decision) {
    decision = resolveWakeTarget(agentName, wrappers);
    matchVia = "name";
  }

  switch (decision.kind) {
    case "inject":
      deps.wake(decision.terminal.t);
      deps.cacheSet(agentName, decision.terminal.t);
      deps.log(
        `auto-inject: wrote "inbox\\n" to terminal "${decision.terminal.name}" ` +
          `(pid=${decision.terminal.processId ?? "?"}, match=${matchVia})`,
      );
      return;
    case "no-match":
      deps.cacheClear(agentName);
      deps.log(`auto-inject skipped: no terminal bound to agent "${agentName}" (by PID or name)`);
      deps.hint(`${agentName} has mail — no bound terminal; run it as "${agentName}" or where Tether can read its PID`);
      return;
    case "ambiguous":
      deps.log(`auto-inject skipped: ${decision.matches.length} terminals match agent "${agentName}" — ambiguous, not waking a guess`);
      deps.hint(`${agentName} has mail — multiple matching terminals, not waking a guess`);
      return;
  }
}
