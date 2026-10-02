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
 *   - Q3 COALESCING (PR 2): a per-agent last ring and a window W. Ring at once, then
 *     nothing for that agent until W has passed; what arrived in between is covered by
 *     ONE intent at the end of W. One ring per burst, never one per message.
 *   - Q4 BUDGET (PR 2): at most `budgetPerHour` rings per agent in the trailing hour.
 *     Over it, the agent is not rung. A3.2: the budget STATE is reported only when it
 *     changes (exhausted, then available again), never once per refused cycle.
 */
import type { BudgetRecord, Intent, IntentRecord } from "./doorbell-log.js";
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

/** ADR-0038 Q3 + Q4 defaults, and the bounds a tunable must stay inside. */
export const DEFAULT_WINDOW_MS = 60_000;
export const MIN_WINDOW_MS = 10_000;
export const MAX_WINDOW_MS = 600_000;
export const DEFAULT_BUDGET_PER_HOUR = 6;
export const MIN_BUDGET_PER_HOUR = 1;
export const MAX_BUDGET_PER_HOUR = 60;
/** The budget's window: ring times older than this no longer count. */
export const BUDGET_WINDOW_MS = 3_600_000;

/** Why these tunables are out of bounds, or null. */
export function tunablesFault(t: { windowMs: number; budgetPerHour: number }): string | null {
  if (!Number.isInteger(t.windowMs) || t.windowMs < MIN_WINDOW_MS || t.windowMs > MAX_WINDOW_MS) {
    return `the coalescing window must be an integer number of ms in ${MIN_WINDOW_MS}..${MAX_WINDOW_MS}`;
  }
  if (!Number.isInteger(t.budgetPerHour) || t.budgetPerHour < MIN_BUDGET_PER_HOUR || t.budgetPerHour > MAX_BUDGET_PER_HOUR) {
    return `the ring budget must be an integer in ${MIN_BUDGET_PER_HOUR}..${MAX_BUDGET_PER_HOUR} per hour`;
  }
  return null;
}

export interface CycleInput {
  bindings: readonly CandidateBinding[];
  ownHostId: string | null;
  /** The canonical pending set for an agent; a throw is that agent's read failing. */
  pending: (agentName: string) => PendingRead;
  /** Rung memory: rungKey(reading session, id). Not mutated. */
  rung: ReadonlySet<string>;
  /** Per agent: the time (ms) of every past intent (the window and the budget). Not mutated. */
  ringTimes: ReadonlyMap<string, readonly number[]>;
  /** Agents whose budget state is currently "exhausted" (as last logged). Not mutated. */
  budgetExhausted: ReadonlySet<string>;
  windowMs: number;
  budgetPerHour: number;
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
  /** Budget STATE changes this cycle (A3.2): empty when nothing changed. */
  budget: BudgetRecord[];
  skipped: CycleSkip[];
}

export function planCycle(input: CycleInput): CyclePlan {
  const intents: IntentRecord[] = [];
  const budget: BudgetRecord[] = [];
  const skipped: CycleSkip[] = [];
  const fault = tunablesFault(input);
  if (fault) throw new Error(fault);
  const at = input.now();
  const nowMs = Date.parse(at);
  if (!input.ownHostId) {
    for (const b of input.bindings) skipped.push({ binding_id: b.binding_id, agent_name: b.agent_name, why: "this host's identity is unknown: no binding can be shown to be local" });
    return { intents, budget, skipped };
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
    const name = b.agent_name;
    const times = input.ringTimes.get(name) ?? [];
    // Q4: the budget STATE, evaluated every cycle so its change is logged when it happens
    // (A3.2), whether or not this agent has new mail right now.
    const inHour = times.filter((t) => t > nowMs - BUDGET_WINDOW_MS).length;
    const exhaustedNow = inHour >= input.budgetPerHour;
    if (exhaustedNow !== input.budgetExhausted.has(name)) {
      budget.push({ v: 1, type: "budget", at, agent_name: name, state: exhaustedNow ? "exhausted" : "available", rings_in_hour: inHour, budget_per_hour: input.budgetPerHour });
    }
    // A SET, in canonical order: the drain order has no same-millisecond tie-break, so the
    // scan order of equal-time ids is not stable, and the record must not depend on it.
    const fresh = [...new Set(read.ids.filter((id) => !input.rung.has(rungKey(rs, id))))].sort(); // a canonical SET (#300 R1 #8)
    covered.add(name);
    if (fresh.length === 0) continue;
    // Q4 first: a refused ring is refused whatever the window says.
    if (exhaustedNow) {
      skip(`ring budget exhausted: ${inHour} rings in the last hour (budget ${input.budgetPerHour})`);
      continue;
    }
    // Q3: within W of the last ring, hold; the held ids stay un-rung, so ONE intent covers them once W has passed.
    const last = times.length > 0 ? Math.max(...times) : null;
    if (last !== null && nowMs - last < input.windowMs) {
      skip(`coalescing: ${fresh.length} new id(s) held until ${input.windowMs / 1000}s after the last ring`);
      continue;
    }
    const intent: Intent = { intent_id: input.newIntentId(), agent_name: name, binding_id: b.binding_id, reason: "new_mail" };
    intents.push({ v: 1, type: "intent", at, intent, covers: { reading_session: rs, message_ids: fresh } });
  }
  return { intents, budget, skipped };
}
