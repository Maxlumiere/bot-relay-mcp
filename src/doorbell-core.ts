// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The doorbell's decision, ONE cycle (ADR-0038 + A1/A2/A3; plan v3 PR 1). PURE: every
 * input is passed in, so each rule is tested directly.
 *
 *   - CANDIDATES (A2.1, A1 §A2): this edge's current bindings (listAgentBindings), and of
 *     those only the ones on THIS host, matched POSITIVELY: host_id must EQUAL our own,
 *     and an unknown own host means no candidate at all. A relay never rings a window on
 *     another machine, whatever its deployment.
 *   - THE SIGNAL (A2.2): F1's canonical pending set, through pendingMetadata, as an
 *     id-SET; never a count, never `seq`.
 *   - THE TRIGGER (V4): an id in that set that has NOT been rung for (reading session,
 *     id). The reading session is the PR 0b digest from the SAME read as the ids; it is
 *     never re-derived here.
 *   - A NULL or unbound reading session is NEVER a target (V4): delivery cannot be
 *     measured for it. It is skipped with its reason (the board case is PR 6).
 *   - One intent per agent per cycle, covering all of its new ids.
 */
import type { Intent, IntentRecord } from "./doorbell-log.js";
import { rungKey } from "./doorbell-log.js";

export interface CandidateBinding {
  binding_id: string;
  agent_name: string | null;
  host_id: string;
}

/** What the planner needs from one pending read (pendingMetadata). */
export interface PendingRead {
  registered: boolean;
  reading_session: string | null;
  ids: string[];
}

export interface CycleInput {
  bindings: readonly CandidateBinding[];
  ownHostId: string | null;
  /** The canonical pending set for an agent; a throw is that agent's read failing. */
  pending: (agentName: string) => PendingRead;
  /** Rung memory: rungKey(reading session, id). Not mutated. */
  rung: ReadonlySet<string>;
  newIntentId: () => string;
  now: () => string;
}

export interface CycleSkip {
  binding_id: string;
  agent_name: string | null;
  why: string;
}

export interface CyclePlan {
  intents: IntentRecord[];
  skipped: CycleSkip[];
}

export function planCycle(input: CycleInput): CyclePlan {
  const intents: IntentRecord[] = [];
  const skipped: CycleSkip[] = [];
  if (!input.ownHostId) {
    for (const b of input.bindings) skipped.push({ binding_id: b.binding_id, agent_name: b.agent_name, why: "this host's identity is unknown: no binding can be shown to be local" });
    return { intents, skipped };
  }
  const covered = new Set<string>(); // agents already given an intent this cycle
  for (const b of input.bindings) {
    const skip = (why: string) => skipped.push({ binding_id: b.binding_id, agent_name: b.agent_name, why });
    if (b.host_id !== input.ownHostId) {
      skip("the binding is on another host");
      continue;
    }
    if (!b.agent_name) {
      skip("the binding names no agent");
      continue;
    }
    if (covered.has(b.agent_name)) continue;
    let read: PendingRead;
    try {
      read = input.pending(b.agent_name);
    } catch (err) {
      skip(`its pending set cannot be read (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (!read.registered) {
      skip("the agent is not registered in this DB");
      continue;
    }
    if (!read.reading_session) {
      skip("no bound reading session: delivery cannot be measured, so it is never rung (a board case)");
      continue;
    }
    const rs = read.reading_session;
    // A SET, in canonical order: the drain order has no same-millisecond tie-break, so the
    // scan order of equal-time ids is not stable, and the record must not depend on it.
    const fresh = [...new Set(read.ids.filter((id) => !input.rung.has(rungKey(rs, id))))].sort(); // a canonical SET (#300 R1 #8)
    if (fresh.length === 0) continue;
    const intent: Intent = { intent_id: input.newIntentId(), agent_name: b.agent_name, binding_id: b.binding_id, reason: "new_mail" };
    intents.push({ v: 1, type: "intent", at: input.now(), intent, covers: { reading_session: rs, message_ids: fresh } });
    covered.add(b.agent_name);
  }
  return { intents, skipped };
}
