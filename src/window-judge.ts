// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE window judgement (ruling 5dda2752), pure apart from the liveness read it is given: shared by the doorbell
 * (src/doorbell-core.ts and src/doorbell-run.ts re-export it), the watch (PR 7, ruling ffcaf608 D1 (iii)) and the
 * daemon's wake-coverage sweep (PR 8b), which must not reach the doorbell itself (the A1 §A2 entrypoint guard).
 */
import { anchorLivenessVerdict, type AnchorVerdict } from "./liveness.js";

export interface CandidateBinding {
  binding_id: string;
  agent_name: string | null;
  host_id: string;
  /** The window's anchor (pid + start token): what `liveness` judges. */
  window_pid?: number | null;
  window_pid_start?: string | null;
}

/**
 * Each binding's window on its own; only the PROVEN dead are set aside; another host's window cannot be judged
 * from here (unverifiable, never dead).
 */
export function judgeWindows<B extends CandidateBinding>(bs: readonly B[], ownHostId: string | null, liveness: (b: B) => AnchorVerdict) {
  const judged = bs.map((x) => ({ b: x, v: x.host_id === ownHostId ? liveness(x) : ("unverifiable" as AnchorVerdict) }));
  const notDead = judged.filter((x) => x.v !== "dead");
  const liveWindows = notDead.filter((x) => x.v === "alive");
  return { judged, notDead, liveWindows, deadCount: judged.length - notDead.length };
}
/**
 * The agent's ONE live window, by the doorbell's own predicate (Q4: never guess): exactly one binding not proven
 * dead, and it is alive. Otherwise none (no live window) or ambiguous (2+ not proven dead).
 */
export function oneLiveWindow<B extends CandidateBinding>(bs: readonly B[], ownHostId: string | null, liveness: (b: B) => AnchorVerdict): { kind: "one"; b: B } | { kind: "none" } | { kind: "ambiguous" } {
  const { notDead, liveWindows } = judgeWindows(bs, ownHostId, liveness);
  if (notDead.length >= 2) return { kind: "ambiguous" };
  return liveWindows.length === 1 ? { kind: "one", b: liveWindows[0].b } : { kind: "none" };
}

/** A binding's window verdict (its anchor: pid + start token, on its own host). */
export function bindingLiveness(b: { host_id: string; window_pid?: number | null; window_pid_start?: string | null }, ownHostId: string | null): AnchorVerdict {
  return anchorLivenessVerdict({ host_id: b.host_id, agent_pid: b.window_pid ?? null, agent_pid_start: b.window_pid_start ?? null }, ownHostId);
}
