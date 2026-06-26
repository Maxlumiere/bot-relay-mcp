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
 * v0.3.2 — resolve an agent's PID binding with the discover → snapshot SEAM.
 *
 * PRIMARY: discover_agents over the MCP client. FALLBACK: the auth-free
 * GET /api/snapshot. Tether connects TOKEN-FREE and the relay token-gates
 * discover_agents (it doubles as a token-validity probe), so for Tether the
 * primary read returns no binding (AUTH_FAILED → no `agents` array → null) and
 * the snapshot — which serves the same host_shell_pids/host_id — populates it.
 * That empty-binding-on-token-free-discover was the real v0.3.0 T-ACC failure.
 *
 * VSCode-free + injectable so the SEAM (not just the parse) is unit-tested; the
 * extension supplies the impure fetchers. Each fetcher returns parsed JSON or
 * null (unavailable / failed / non-200); parseAgentBinding tolerates either
 * source's `{agents:[…]}` shape and junk, so a fetch failure degrades cleanly to
 * the empty binding (→ the name matcher downstream), never a throw or wrong wake.
 */
export interface BindingFetchDeps {
  /** discover_agents result as parsed JSON, or null when unavailable/failed. */
  discover(): Promise<unknown | null>;
  /** GET /api/snapshot result as parsed JSON, or null when unreachable/non-200. */
  snapshot(): Promise<unknown | null>;
}

export async function resolveAgentBinding(
  agentName: string,
  deps: BindingFetchDeps,
): Promise<AgentPidBinding> {
  const empty: AgentPidBinding = { hostShellPids: null, hostId: null };
  const discovered = await deps.discover();
  const fromDiscover = discovered ? parseAgentBinding(discovered, agentName) : null;
  if (fromDiscover) return fromDiscover; // agent listed via the live MCP roster
  // discover_agents unavailable / AUTH_FAILED (token-free Tether) / agent not
  // listed → fall back to the auth-free snapshot (the load-bearing v0.3.2 seam).
  const snap = await deps.snapshot();
  const fromSnapshot = snap ? parseAgentBinding(snap, agentName) : null;
  return fromSnapshot ?? empty;
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
  cacheGet(agentName: string): T | undefined;
  cacheSet(agentName: string, t: T): void;
  cacheClear(agentName: string): void;
  wake(t: T): void;
  /** Wake word, for the diagnostic log only (default "inbox"). The actual
   *  injection (incl. submit quirks) lives entirely in `wake`. */
  wakeWord?: string;
  hint(message: string): void;
  log(line: string): void;
}

export async function resolveAndWake<T>(agentName: string, deps: WakeDeps<T>): Promise<void> {
  const binding = await deps.fetchBinding(agentName); // FRESH — no stale-cache window
  const open = deps.openTerminals();
  // Fast path: a previously-bound terminal still open AND still a host-scoped
  // member of the FRESH chain → wake it without re-awaiting every processId.
  const cached = deps.cacheGet(agentName);
  if (cached && open.includes(cached)) {
    if (isHostScopedMember(binding, deps.localHostId, await deps.processIdOf(cached))) {
      deps.wake(cached);
      return;
    }
    deps.cacheClear(agentName); // stale (re-register / moved) → re-resolve
  }
  // Full resolve: await each open terminal's processId once, THEN decide.
  const wrappers = await Promise.all(
    open.map(async (t) => ({ t, name: deps.nameOf(t), processId: await deps.processIdOf(t) })),
  );
  // v0.3.1 instrumentation — ONE diagnostic line per wake: the binding the
  // extension actually resolved (post-fetch + post-parse) plus every terminal's
  // resolved processId. This is the observability the v0.3.0 T-ACC lacked — it
  // is exactly what surfaced the real bug (binding arriving EMPTY because the
  // token-free discover_agents read was AUTH_FAILED). A bind miss is now
  // debuggable straight from the Output channel, no special build.
  deps.log(
    `pid-binding: resolve agent="${agentName}" localHostId=${deps.localHostId ?? "∅"} ` +
      `binding.hostId=${binding.hostId ?? "∅"} ` +
      `binding.hostShellPids=${binding.hostShellPids ? `[${binding.hostShellPids.join(",")}]` : "∅"} ` +
      `terminals=${JSON.stringify(wrappers.map((w) => ({ name: w.name, pid: w.processId ?? null })))}`,
  );
  const decision = resolveWakeTargetByPid(agentName, binding, deps.localHostId, wrappers);
  switch (decision.kind) {
    case "inject":
      deps.wake(decision.terminal.t);
      deps.cacheSet(agentName, decision.terminal.t);
      deps.log(
        `auto-inject: woke terminal "${decision.terminal.name}" with wake word "${deps.wakeWord ?? "inbox"}" (pid=${decision.terminal.processId ?? "?"})`,
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
