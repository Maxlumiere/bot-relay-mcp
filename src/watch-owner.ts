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
 * INV-LIVE-01 (ruling 476e65f1): a start that cannot be READ is never "another process" nor "gone". At arm
 * time it refuses as `cannot_judge` (fail closed, named); while running it is no verdict on the window.
 */
import type { AnchorVerdict, ProcEntry, ProcessStart } from "./liveness.js";
import { anchorState } from "./liveness.js";
import { oneLiveWindow } from "./doorbell-core.js";

/** One binding row, as listAgentBindings returns it (the fields ownership reads). */
export interface OwnerBinding {
  binding_id: string;
  agent_name: string | null;
  host_id: string;
  window_pid?: number | null;
  window_pid_start?: string | null;
}
export type OwnerRefusal = "reparented" | "no_bound_ancestor" | "no_live_window" | "ambiguous_binding" | "not_this_window" | "cannot_judge";
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
  startNow: (pid: number) => ProcessStart;
  /** Does `stored` (either token form) name the process at `pid` now? liveness.observeStartTokenForm; "unreadable" = cannot say. */
  sameProcess: (pid: number, stored: string) => boolean | "unreadable";
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
  cannot_judge: "a process start time on this watch's ancestry cannot be read right now (ps failed or timed out), so ownership cannot be proven; try again",
};

/**
 * Resolve the window that owns a watch running as `selfPid` for `agent` (pure over its deps).
 * `bindings` = the agent's current bindings (every host; oneLiveWindow sets aside only the proven dead).
 */
export function resolveOwnership(selfPid: number, bindings: readonly OwnerBinding[], ownHostId: string | null, deps: OwnerDeps): Ownership {
  const table = deps.table();
  const self = table.get(selfPid);
  // INCOMPLETE data is never a fact (Codex R1 P2): our own row missing (an EMPTY snapshot, i.e. a failed
  // read; or a row that was malformed and dropped; or a partial read) cannot be judged. `reparented` is
  // only an OBSERVED parent of init/launchd.
  if (!self) return { ok: false, why: "cannot_judge" };
  if (self.ppid <= 1) return { ok: false, why: "reparented" }; // (ii)
  // Walk the ancestry (bounded); the FIRST hop that a binding of this agent names, verified (i).
  const mine = bindings.filter((b) => b.host_id === ownHostId && Number.isInteger(b.window_pid) && typeof b.window_pid_start === "string" && b.window_pid_start.length > 0);
  let found: { b: OwnerBinding; start: string } | null = null;
  let cur: ProcEntry | undefined = table.get(self.ppid);
  if (!cur) return { ok: false, why: "cannot_judge" }; // our parent is alive (ppid > 1) but missing: incomplete
  for (let depth = 0; cur && depth < 64 && !found; depth++) {
    const hop: ProcEntry = cur;
    for (const b of mine) {
      if (b.window_pid !== hop.pid) continue;
      const now = anchorState(deps.startNow(hop.pid), hop.startedAt);
      if (now === "unknown") return { ok: false, why: "cannot_judge" };
      if (now === "gone") continue; // the hop is no longer that process
      const same = deps.sameProcess(hop.pid, b.window_pid_start as string);
      if (same === "unreadable") return { ok: false, why: "cannot_judge" };
      if (!same) continue; // the binding names another process
      found = { b, start: hop.startedAt };
      break;
    }
    if (hop.ppid <= 1 || found) break;
    cur = table.get(hop.ppid);
    if (!cur) return { ok: false, why: "cannot_judge" }; // an ancestor hop missing from the snapshot: incomplete, never "no bound ancestor"
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

/** Is the window itself still the same process (pid + the kernel's start)? `unknown` = its start cannot be read now. */
export const windowState = (w: OwnedWindow, startNow: (pid: number) => ProcessStart) => anchorState(startNow(w.pid), w.start);

/**
 * While running: is the agent's ONE live window still THIS window, compared by what the window IS
 * (pid + the kernel's start), never by a binding id (Codex R2 (b))? Each check; the ancestry itself is
 * re-proven by the caller (process.ppid unchanged). A "dead" verdict is permanent for a (pid, start),
 * so it is cached; any other verdict is read again. "window_gone" = this window's process ended, by kernel
 * fact (ESRCH, or its pid holds another process). A window whose start cannot be READ is no verdict
 * (INV-LIVE-01): the binding checks below still run, the next check reads it again, and `window:
 * "unknown"` tells the caller, which bounds how long it accepts that (architect ruling a98ec836).
 */
export function stillOwner(window: OwnedWindow, bindings: readonly OwnerBinding[], ownHostId: string | null, deps: Pick<OwnerDeps, "liveness" | "startNow">, deadCache: Set<string>): { ok: true; window: "same" | "unknown" } | { ok: false; why: OwnerRefusal | "window_gone" } {
  const ws = windowState(window, deps.startNow);
  if (ws === "gone") return { ok: false, why: "window_gone" };
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
  return one.b.window_pid === window.pid ? { ok: true, window: ws } : { ok: false, why: "not_this_window" };
}
