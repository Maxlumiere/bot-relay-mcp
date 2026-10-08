// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * WHO OWNS A WATCH (doorbell PR 7, Codex R1 #1, architect ruling ffcaf608 D1): ownership by KERNEL
 * FACT, through process ANCESTRY. A watch belongs to the window it descends from, and only if that
 * window is the agent's ONE live bound window (the doorbell's own predicate, oneLiveWindow:
 * never guess). A process cannot fake its parent chain, so no other local process can claim another
 * agent's watch, and a stale window's watch cannot take the current window's mail.
 *   (i) every ancestor hop that matches a binding is verified by pid + process start (never a bare pid):
 *       the hop's start in the ps snapshot must equal its start read again now, AND the binding's
 *       recorded start must name that same process (compared by form, never as raw strings);
 *   (ii) a REPARENTED watch (its parent is init/launchd: nohup, disown, a dead shell) refuses to arm;
 *   (iii) the window found must be the agent's ONE live bound window, else refuse ("binding moved" once
 *       running);
 *   (iv) the lock key is (agent, window pid + start): src/watch-wake.ts watchWindowDir. The start is the
 *        KERNEL's (UTC form, from the same snapshot that proved the hop), never the stored token: a
 *        legacy-form migration rewrites the token under the same binding (Codex R2 (b)), and the key,
 *        the supervisor and stillOwner must all name the same window the same way.
 * No token is read: possession of a credential proves possession, not window ownership (ADR-0036: the
 * window anchor is the principal).
 */
import type { AnchorVerdict, ProcEntry } from "./liveness.js";
import { oneLiveWindow } from "./doorbell-core.js";

/** One binding row, as listAgentBindings returns it (the fields ownership reads). */
export interface OwnerBinding {
  binding_id: string;
  agent_name: string | null;
  host_id: string;
  window_pid?: number | null;
  window_pid_start?: string | null;
}
export type OwnerRefusal = "reparented" | "no_bound_ancestor" | "no_live_window" | "ambiguous_binding" | "not_this_window";
/** The window a watch belongs to: its pid and its start as the KERNEL reads it (UTC form). */
export interface OwnedWindow {
  pid: number;
  start: string;
}
export type Ownership = { ok: true; window: OwnedWindow } | { ok: false; why: OwnerRefusal };

export interface OwnerDeps {
  /** One consistent process snapshot (pid, ppid, start): liveness.buildProcessTable. */
  table: () => Map<number, ProcEntry>;
  /** A process's start token NOW, in the snapshot's (UTC) form: liveness.processStartedAt. */
  startNow: (pid: number) => string | null;
  /** Does `stored` (either token form) name the process at `pid` now? liveness.observeStartTokenForm. */
  sameProcess: (pid: number, stored: string) => boolean;
  /** A binding's window verdict: doorbell-run.bindingLiveness. */
  liveness: (b: OwnerBinding) => AnchorVerdict;
}

/** The human line for a refusal (each is distinguishable: "no-mail: refused (<why>)"). */
export const REFUSAL_TEXT: Record<OwnerRefusal, string> = {
  reparented: "this watch has no parent window (it was detached: nohup, disown, or its shell ended); arm it from the agent's own session",
  no_bound_ancestor: "this watch does not run inside a window bound to this agent; arm it from the agent's own session",
  no_live_window: "the agent has no live bound window",
  ambiguous_binding: "the agent has two or more windows not proven closed (never guessed)",
  not_this_window: "the agent's live window is another one (this one is not the agent's current window)",
};

/**
 * Resolve the window that owns a watch running as `selfPid` for `agent` (pure over its deps).
 * `bindings` = the agent's current bindings (every host; oneLiveWindow sets aside only the proven dead).
 */
export function resolveOwnership(selfPid: number, bindings: readonly OwnerBinding[], ownHostId: string | null, deps: OwnerDeps): Ownership {
  const table = deps.table();
  const self = table.get(selfPid);
  if (!self || self.ppid <= 1) return { ok: false, why: "reparented" }; // (ii)
  // Walk the ancestry (bounded); the FIRST hop that a binding of this agent names, verified (i).
  const mine = bindings.filter((b) => b.host_id === ownHostId && Number.isInteger(b.window_pid) && typeof b.window_pid_start === "string" && b.window_pid_start.length > 0);
  let found: { b: OwnerBinding; start: string } | null = null;
  let cur: ProcEntry | undefined = table.get(self.ppid);
  for (let depth = 0; cur && depth < 64 && !found; depth++) {
    const hop = cur;
    for (const b of mine) {
      if (b.window_pid !== hop.pid) continue;
      if (deps.startNow(hop.pid) !== hop.startedAt) continue; // the hop is no longer that process
      if (!deps.sameProcess(hop.pid, b.window_pid_start as string)) continue; // the binding names another process
      found = { b, start: hop.startedAt };
      break;
    }
    if (hop.ppid <= 1) break;
    cur = table.get(hop.ppid);
  }
  if (!found) return { ok: false, why: "no_bound_ancestor" };
  // (iii) the agent's ONE live window, by the doorbell's own predicate, must be this one.
  const one = oneLiveWindow(bindings, ownHostId, deps.liveness);
  if (one.kind === "none") return { ok: false, why: "no_live_window" };
  if (one.kind === "ambiguous") return { ok: false, why: "ambiguous_binding" };
  if (one.b.binding_id !== found.b.binding_id) return { ok: false, why: "not_this_window" };
  return { ok: true, window: { pid: hopPid(found.b), start: found.start } };
}

const hopPid = (b: OwnerBinding): number => b.window_pid as number;

/** Is the window itself still the same live process (pid + the kernel's start)? */
export const windowAlive = (w: OwnedWindow, startNow: (pid: number) => string | null): boolean => startNow(w.pid) === w.start;

/**
 * While running: is the agent's ONE live window still THIS window, compared by what the window IS
 * (pid + the kernel's start), never by a binding id (Codex R2 (b))? Each check; the ancestry itself is
 * re-proven by the caller (process.ppid unchanged). A "dead" verdict is permanent for a (pid, start),
 * so it is cached; any other verdict is read again. "window_gone" = this window's process ended.
 */
export function stillOwner(window: OwnedWindow, bindings: readonly OwnerBinding[], ownHostId: string | null, deps: Pick<OwnerDeps, "liveness" | "startNow">, deadCache: Set<string>): { ok: true } | { ok: false; why: OwnerRefusal | "window_gone" } {
  if (!windowAlive(window, deps.startNow)) return { ok: false, why: "window_gone" };
  const liveness = deps.liveness;
  const cached = (b: OwnerBinding): AnchorVerdict => {
    const key = `${b.host_id}|${b.window_pid}|${b.window_pid_start}`;
    if (deadCache.has(key)) return "dead";
    const v = liveness(b);
    if (v === "dead") deadCache.add(key);
    return v;
  };
  const one = oneLiveWindow(bindings, ownHostId, cached);
  if (one.kind === "none") return { ok: false, why: "no_live_window" };
  if (one.kind === "ambiguous") return { ok: false, why: "ambiguous_binding" };
  return one.b.window_pid === window.pid ? { ok: true } : { ok: false, why: "not_this_window" };
}
