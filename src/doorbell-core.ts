// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The doorbell's decision, ONE cycle (ADR-0038 + A1/A2/A3; plan v3 PR 1-3). PURE: every
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
 *   - EFFECTIVENESS (PR 3; A2.3 as corrected by V4; ruling c04f463a), per (agent, reading
 *     session), from the log alone (`AgentLedger`):
 *       · PROGRESS: a rung id of this session LEFT its pending set (and that is not yet
 *         recorded). Every outstanding ring is judged effective, the counter resets.
 *       · HORIZON H: a ring still outstanding H after it rang is judged INEFFECTIVE and the
 *         counter goes up by one. A ring that was never made (refused by W or the budget)
 *         is never judged, so it ticks nothing.
 *       · ESCALATE_AFTER (3) ineffective rings in a row open ONE `agent_unresponsive`
 *         escalation, to the board and the log only (V1). While it is open the agent is not
 *         rung, except ONE ring for NEW mail (`during_escalation`). It closes on progress
 *         in the same session, or when the session changes, never because a binding went.
 *       · RE-RING: an id still pending H after its last ring is rung again (kind
 *         `still_pending`), at most RE_RING_CAP (K = 3) rings per (id, session) in all.
 *         At the cap it drops out of re-ring with ONE `id_stuck` escalation.
 *       · A changed reading session is the V4 rescue path, never effectiveness: the old
 *         session's outstanding rings are recorded `session_changed`, its escalations close.
 *     `operator` (V3) is attribution on escalation records only, never a ring target.
 */
import type { BudgetRecord, EffectRecord, EscalationRecord, IdKind, Intent, IntentRecord, LogRecord } from "./doorbell-log.js";
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
/**
 * The effectiveness horizon H (ruling c04f463a Q1): 15 min by default, 1..60 min, and never
 * shorter than W. PROVISIONAL until fitted from the doorbell's OWN log, by the rule
 * pre-registered in the ruling: H = clamp(p95 of ring→drain latency over ≥ 20 effective
 * rings, W, 60 min), the latency being an intent's time to the effect record that judged it
 * effective.
 */
export const DEFAULT_HORIZON_MS = 900_000;
export const MIN_HORIZON_MS = 60_000;
export const MAX_HORIZON_MS = 3_600_000;
/** Ineffective rings in a row, for one (agent, reading session), that open an escalation (plan PR 3). */
export const ESCALATE_AFTER = 3;
/** K: at most this many rings per (id, reading session), first ring included (ruling c04f463a Q2). */
export const RE_RING_CAP = 3;

/** Why these tunables are out of bounds, or null. */
export function tunablesFault(t: { windowMs: number; budgetPerHour: number; horizonMs: number }): string | null {
  if (!Number.isInteger(t.windowMs) || t.windowMs < MIN_WINDOW_MS || t.windowMs > MAX_WINDOW_MS) {
    return `the coalescing window must be an integer number of ms in ${MIN_WINDOW_MS}..${MAX_WINDOW_MS}`;
  }
  if (!Number.isInteger(t.budgetPerHour) || t.budgetPerHour < MIN_BUDGET_PER_HOUR || t.budgetPerHour > MAX_BUDGET_PER_HOUR) {
    return `the ring budget must be an integer in ${MIN_BUDGET_PER_HOUR}..${MAX_BUDGET_PER_HOUR} per hour`;
  }
  if (!Number.isInteger(t.horizonMs) || t.horizonMs < MIN_HORIZON_MS || t.horizonMs > MAX_HORIZON_MS) {
    return `the effectiveness horizon must be an integer number of ms in ${MIN_HORIZON_MS}..${MAX_HORIZON_MS}`;
  }
  if (t.horizonMs < t.windowMs) return "the effectiveness horizon (H) must be at least the coalescing window (W)";
  return null;
}

/** One agent's PR 3 history, in log order: its intents, effect records and escalation records. */
export type LedgerRecord = IntentRecord | EffectRecord | EscalationRecord;

/** The PR 3 state of ONE agent for ONE reading session, derived from its history alone. */
export interface AgentLedger {
  /** Every id rung for this session. */
  rungIds: Set<string>;
  /** Per id: how many rings covered it (first ring included). */
  ringCount: Map<string, number>;
  /** Per id: the monotonic time of its latest ring. */
  lastRing: Map<string, number>;
  /** Rings not judged yet, oldest first. */
  outstanding: { intent_id: string; mono: number }[];
  /** Rung ids whose leaving is already recorded (in an `effective` record). */
  recordedLeft: Set<string>;
  /** Ineffective rings in a row since the last progress. */
  counter: number;
  /** The open agent_unresponsive escalation, its episode's ids, and whether its one extra ring is spent. */
  unresponsive: { rec: EscalationRecord; episode: Set<string>; extraRung: boolean } | null;
  /** Open id_stuck escalations, by id. */
  stuck: Map<string, EscalationRecord>;
}

/** Rings outstanding and escalations open for OTHER sessions than `rs` (the V4 rescue path closes them). */
export interface OtherSessions {
  outstanding: Map<string, string[]>;
  open: EscalationRecord[];
}

/**
 * Derive one agent's ledger for the reading session `rs` (null = none is bound now). `monoOf`
 * places an intent on THIS lifetime's monotonic clock (ruling 622689ba; across a restart, an
 * implausible wall age places it "now", which restarts its horizon: the fail-safe direction).
 */
export function deriveLedger(history: readonly LedgerRecord[], rs: string | null, monoOf: (rec: IntentRecord) => number): { ledger: AgentLedger; other: OtherSessions } {
  const judged = new Set<string>();
  for (const r of history) if (r.type === "effect") for (const id of r.intent_ids) judged.add(id);
  const ledger: AgentLedger = { rungIds: new Set(), ringCount: new Map(), lastRing: new Map(), outstanding: [], recordedLeft: new Set(), counter: 0, unresponsive: null, stuck: new Map() };
  const other: OtherSessions = { outstanding: new Map(), open: [] };
  const open = new Map<string, { rec: EscalationRecord; episode: Set<string>; extraRung: boolean }>();
  for (const r of history) {
    if (r.type === "escalation") {
      if (r.state === "open") open.set(r.escalation_id, { rec: r, episode: new Set(r.message_ids), extraRung: false });
      else open.delete(r.escalation_id);
      continue;
    }
    const mine = (r.type === "intent" ? r.covers.reading_session : r.reading_session) === rs;
    if (r.type === "intent") {
      const irs = r.covers.reading_session;
      if (r.intent.during_escalation) {
        // The episode's ONE extra ring: it joins the episode's id set (the close predicate).
        for (const e of open.values()) if (e.rec.reason === "agent_unresponsive" && e.rec.reading_session === irs) {
          e.extraRung = true;
          for (const id of r.covers.message_ids) e.episode.add(id);
        }
      }
      if (!judged.has(r.intent.intent_id) && !mine) other.outstanding.set(irs, [...(other.outstanding.get(irs) ?? []), r.intent.intent_id]);
      if (!mine) continue;
      const mono = monoOf(r);
      for (const id of r.covers.message_ids) {
        ledger.rungIds.add(id);
        ledger.ringCount.set(id, (ledger.ringCount.get(id) ?? 0) + 1);
        ledger.lastRing.set(id, Math.max(ledger.lastRing.get(id) ?? -Infinity, mono));
      }
      if (!judged.has(r.intent.intent_id)) ledger.outstanding.push({ intent_id: r.intent.intent_id, mono });
    } else if (mine) {
      if (r.outcome === "effective") {
        ledger.counter = 0;
        for (const id of r.left) ledger.recordedLeft.add(id);
      } else if (r.outcome === "ineffective") ledger.counter += 1;
    }
  }
  for (const e of open.values()) {
    if (e.rec.reading_session !== rs) other.open.push(e.rec);
    else if (e.rec.reason === "agent_unresponsive") ledger.unresponsive = e;
    else ledger.stuck.set(e.rec.message_ids[0], e.rec);
  }
  ledger.outstanding.sort((a, b) => a.mono - b.mono);
  return { ledger, other };
}

/**
 * The planner's `ledger` input from the job's records, in ONE pass: each agent's history,
 * and the agents still owed a judgement (an outstanding ring or an open escalation), bound
 * or not. The job and the tests build it here, so they cannot disagree.
 */
export function ledgerInput(records: readonly LogRecord[], monoOf: (rec: IntentRecord) => number): NonNullable<CycleInput["ledger"]> {
  const history = new Map<string, LedgerRecord[]>();
  const judged = new Set<string>();
  const lastEscalation = new Map<string, EscalationRecord>();
  for (const r of records) {
    if (r.type !== "intent" && r.type !== "effect" && r.type !== "escalation") continue;
    const agent = r.type === "intent" ? r.intent.agent_name : r.agent_name;
    const list = history.get(agent);
    if (list) list.push(r);
    else history.set(agent, [r]);
    if (r.type === "effect") for (const id of r.intent_ids) judged.add(id);
    if (r.type === "escalation") lastEscalation.set(r.escalation_id, r);
  }
  const owed = new Set<string>();
  for (const r of records) if (r.type === "intent" && !judged.has(r.intent.intent_id)) owed.add(r.intent.agent_name);
  for (const e of lastEscalation.values()) if (e.state === "open") owed.add(e.agent_name);
  const agents = [...owed].sort();
  return { history: (name) => history.get(name) ?? [], monoOf, agents: () => agents };
}

/**
 * D-2's keep rule for INTENTS at a compaction (ruling 8c83e4ce; 622689ba; c04f463a), pure so
 * the job and the tests apply the SAME rule. An intent is kept if ANY of these holds:
 *   (a) it still counts toward the budget at this start (ringCountsAtStart, the ONE placement);
 *   (b) it is among its agent's last N (N = the budget), as evidence;
 *   (c) it is still OUTSTANDING (no effect record judged it): it is judged after the restart;
 *   (d) one of its ids is still pending for the SAME reading session (rung memory, re-ring, cap);
 *   (e) one of its ids LEFT that session's pending set while the job was down and the leaving
 *       is not recorded yet: the first cycle records the progress (else a reset is lost and a
 *       false escalation could follow). The next compaction drops it.
 * `pendingNow` is every agent's pending read from ONE snapshot.
 */
export function intentKeepRule(
  records: readonly LogRecord[],
  pendingNow: ReadonlyMap<string, { rs: string | null; ids: ReadonlySet<string> }>,
  at: { lastHeaderWall: number | null; startWall: number; budgetPerHour: number },
): (rec: IntentRecord) => boolean {
  const judged = new Set<string>();
  const recordedLeft = new Set<string>(); // agent \0 session \0 id
  const byAgent = new Map<string, IntentRecord[]>();
  for (const r of records) {
    if (r.type === "effect") {
      for (const id of r.intent_ids) judged.add(id);
      for (const id of r.left) recordedLeft.add(`${r.agent_name}\u0000${r.reading_session}\u0000${id}`);
    } else if (r.type === "intent") {
      const list = byAgent.get(r.intent.agent_name);
      if (list) list.push(r);
      else byAgent.set(r.intent.agent_name, [r]);
    }
  }
  const lastN = new Set<string>();
  for (const list of byAgent.values()) for (const r of list.slice(-at.budgetPerHour)) lastN.add(r.intent.intent_id);
  return (rec) => {
    if (ringCountsAtStart(Date.parse(rec.at), at.lastHeaderWall, at.startWall)) return true; // (a)
    if (lastN.has(rec.intent.intent_id)) return true; // (b)
    if (!judged.has(rec.intent.intent_id)) return true; // (c)
    const p = pendingNow.get(rec.intent.agent_name);
    if (!p || p.rs !== rec.covers.reading_session) return false;
    return rec.covers.message_ids.some((id) => p.ids.has(id) || !recordedLeft.has(`${rec.intent.agent_name}\u0000${rec.covers.reading_session}\u0000${id}`)); // (d), (e)
  };
}

export interface CycleInput {
  bindings: readonly CandidateBinding[];
  ownHostId: string | null;
  /** The canonical pending set for an agent; a throw is that agent's read failing. */
  pending: (agentName: string) => PendingRead;
  /** Rung memory: rungKey(reading session, id). Not mutated. */
  rung: ReadonlySet<string>;
  /**
   * Per agent: every past ring as a MONOTONIC time (ms) on THIS lifetime's clock (ruling
   * 622689ba): this lifetime's own rings at their offset; a previous lifetime's at the
   * effective time effectiveRingMono() gives it. The window and the budget never read the
   * wall clock. Not mutated.
   */
  ringMono: ReadonlyMap<string, readonly number[]>;
  /** Now, on this lifetime's monotonic clock (ms since its header). */
  nowMono: number;
  /** Agents whose budget state is currently "exhausted" (as last logged). Not mutated. */
  budgetExhausted: ReadonlySet<string>;
  windowMs: number;
  budgetPerHour: number;
  horizonMs: number;
  /**
   * PR 3: each agent's history from the log, and where each intent sits on this lifetime's
   * monotonic clock. `agents` lists every agent with an outstanding ring or an open
   * escalation, so it is judged even when it is no candidate now (no ring without one).
   * Absent = no history (every ring is a first ring).
   */
  ledger?: { history(agentName: string): readonly LedgerRecord[]; monoOf(rec: IntentRecord): number; agents(): readonly string[] };
  /** V3: the configured operator agent, ATTRIBUTION on escalation records only. Default none. */
  operator?: string | null;
  newIntentId: () => string;
  /** Escalation ids (default: newIntentId). */
  newEscalationId?: () => string;
  now: () => string;
}

export interface CycleSkip {
  binding_id: string;
  agent_name: string | null;
  why: string;
}

export interface CyclePlan {
  /** EVERY record to append, in order (effects, escalations and intents interleave per agent). */
  records: LogRecord[];
  intents: IntentRecord[];
  /** Budget STATE changes this cycle (A3.2): empty when nothing changed. */
  budget: BudgetRecord[];
  effects: EffectRecord[];
  escalations: EscalationRecord[];
  skipped: CycleSkip[];
}

const sortedSet = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

export function planCycle(input: CycleInput): CyclePlan {
  const records: LogRecord[] = [];
  const skipped: CycleSkip[] = [];
  const fault = tunablesFault(input);
  if (fault) throw new Error(fault);
  const at = input.now();
  const nowMono = input.nowMono;
  const operator = input.operator ?? null;
  const newEscalationId = input.newEscalationId ?? input.newIntentId;
  const view = () => ({
    records,
    intents: records.filter((r): r is IntentRecord => r.type === "intent"),
    budget: records.filter((r): r is BudgetRecord => r.type === "budget"),
    effects: records.filter((r): r is EffectRecord => r.type === "effect"),
    escalations: records.filter((r): r is EscalationRecord => r.type === "escalation"),
    skipped,
  });
  if (!input.ownHostId) {
    for (const b of input.bindings) skipped.push({ binding_id: b.binding_id, agent_name: b.agent_name, why: "this host's identity is unknown: no binding can be shown to be local" });
    return view();
  }

  const escalation = (name: string, rs: string, reason: EscalationRecord["reason"], ids: Iterable<string>, state: "open" | "closed", id: string, close: EscalationRecord["close_reason"]): EscalationRecord => ({
    v: 1, type: "escalation", at, escalation_id: id, agent_name: name, reading_session: rs, reason, state, message_ids: sortedSet(ids), operator, close_reason: close,
  });
  const closeOf = (e: EscalationRecord, why: "progress" | "session_changed"): EscalationRecord => escalation(e.agent_name, e.reading_session, e.reason, e.message_ids, "closed", e.escalation_id, why);

  /**
   * PR 3, for ONE agent and its current read: judge its rings and move its escalations.
   * Appends the records and returns the ledger AFTER them (what the ring step decides on).
   */
  const judge = (name: string, read: PendingRead): AgentLedger | null => {
    if (!input.ledger) return null;
    const rs = read.reading_session;
    const { ledger, other } = deriveLedger(input.ledger.history(name), rs, (r) => input.ledger!.monoOf(r));
    // The V4 rescue path: the old session's rings are moot and its escalations close.
    for (const [ors, ids] of other.outstanding) records.push({ v: 1, type: "effect", at, agent_name: name, reading_session: ors, outcome: "session_changed", intent_ids: sortedSet(ids), left: [] });
    for (const e of other.open) records.push(closeOf(e, "session_changed"));
    if (!rs) return null;
    const pending = new Set(read.ids);
    const absent = new Set([...ledger.rungIds].filter((id) => !pending.has(id)));
    // PROGRESS first, by THE judgement (ringEffect): a rung id of this session, not yet
    // recorded as left, has LEFT its pending set.
    const watch = [...ledger.rungIds].filter((id) => !ledger.recordedLeft.has(id));
    const effect = watch.length > 0 ? ringEffect({ reading_session: rs, message_ids: watch }, read) : null;
    const leftNow = effect?.outcome === "effective" ? effect.left : [];
    if (leftNow.length > 0) {
      records.push({ v: 1, type: "effect", at, agent_name: name, reading_session: rs, outcome: "effective", intent_ids: sortedSet(ledger.outstanding.map((o) => o.intent_id)), left: leftNow });
      ledger.outstanding = [];
      ledger.counter = 0;
      for (const id of leftNow) ledger.recordedLeft.add(id);
    }
    if (ledger.unresponsive && [...ledger.unresponsive.episode].some((id) => absent.has(id))) {
      records.push(closeOf(ledger.unresponsive.rec, "progress"));
      ledger.unresponsive = null;
    }
    for (const [id, e] of ledger.stuck) if (absent.has(id)) {
      records.push(closeOf(e, "progress"));
      ledger.stuck.delete(id);
    }
    // THE HORIZON: a ring still outstanding H after it rang was ineffective.
    for (const o of [...ledger.outstanding]) {
      if (nowMono - o.mono < input.horizonMs) continue;
      records.push({ v: 1, type: "effect", at, agent_name: name, reading_session: rs, outcome: "ineffective", intent_ids: [o.intent_id], left: [] });
      ledger.outstanding = ledger.outstanding.filter((x) => x !== o);
      ledger.counter += 1;
      if (ledger.counter >= ESCALATE_AFTER && !ledger.unresponsive) {
        const rec = escalation(name, rs, "agent_unresponsive", [...ledger.rungIds].filter((id) => pending.has(id)), "open", newEscalationId(), null);
        records.push(rec);
        ledger.unresponsive = { rec, episode: new Set(rec.message_ids), extraRung: false };
      }
    }
    return ledger;
  };

  const covered = new Set<string>(); // agents already planned this cycle
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
    covered.add(b.agent_name);
    const ledger = judge(b.agent_name, read);
    if (!read.reading_session) {
      skip("no bound reading session: delivery cannot be measured, so it is never rung (a board case)");
      continue;
    }
    const rs = read.reading_session;
    const name = b.agent_name;
    const times = input.ringMono.get(name) ?? [];
    // Q4: the budget STATE, evaluated every cycle so its change is logged when it happens
    // (A3.2), whether or not this agent has new mail right now.
    const inHour = times.filter((t) => t > nowMono - BUDGET_WINDOW_MS).length;
    const exhaustedNow = inHour >= input.budgetPerHour;
    if (exhaustedNow !== input.budgetExhausted.has(name)) {
      records.push({ v: 1, type: "budget", at, agent_name: name, state: exhaustedNow ? "exhausted" : "available", rings_in_hour: inHour, budget_per_hour: input.budgetPerHour });
    }
    // A SET, in canonical order: the drain order has no same-millisecond tie-break, so the
    // scan order of equal-time ids is not stable, and the record must not depend on it.
    const fresh = sortedSet(read.ids.filter((id) => !input.rung.has(rungKey(rs, id)))); // a canonical SET (#300 R1 #8)
    const kinds = new Map<string, IdKind>(fresh.map((id) => [id, "new"]));
    let duringEscalation = false;
    if (ledger?.unresponsive) {
      // Ruling c04f463a Q4: no rings while escalated, except ONE for the first new mail.
      if (ledger.unresponsive.extraRung) {
        if (fresh.length > 0) skip("escalated (agent_unresponsive): its one extra ring is spent, no more rings until it closes");
        continue;
      }
      duringEscalation = true;
    } else if (ledger) {
      // RE-RING (ruling c04f463a Q2/Q3): rung ids still pending H after their last ring, under the cap.
      for (const id of sortedSet(read.ids)) {
        const last = ledger.lastRing.get(id);
        if (last === undefined || kinds.has(id) || nowMono - last < input.horizonMs) continue;
        if ((ledger.ringCount.get(id) ?? 0) < RE_RING_CAP) kinds.set(id, "still_pending");
        else if (!ledger.stuck.has(id)) {
          const rec = escalation(name, rs, "id_stuck", [id], "open", newEscalationId(), null);
          records.push(rec);
          ledger.stuck.set(id, rec);
        }
      }
    }
    if (kinds.size === 0) continue;
    // Q4 first: a refused ring is refused whatever the window says. A refused ring is NOT a
    // ring: it writes nothing, so it is never judged and ticks no counter.
    if (exhaustedNow) {
      skip(`ring budget exhausted: ${inHour} rings in the last hour (budget ${input.budgetPerHour})`);
      continue;
    }
    // Q3: within W of the last ring, hold; the held ids stay un-rung, so ONE intent covers them once W has passed.
    const last = times.length > 0 ? Math.max(...times) : null;
    if (last !== null && nowMono - last < input.windowMs) {
      skip(`coalescing: ${kinds.size} id(s) held until ${input.windowMs / 1000}s after the last ring`);
      continue;
    }
    const ids = sortedSet(kinds.keys());
    const intent: Intent = { intent_id: input.newIntentId(), agent_name: name, binding_id: b.binding_id, during_escalation: duringEscalation };
    records.push({ v: 1, type: "intent", at, mono_ms: Math.max(0, Math.round(nowMono)), intent, covers: { reading_session: rs, message_ids: ids, kinds: ids.map((id) => kinds.get(id) as IdKind) } });
  }

  // Agents with an outstanding ring or an open escalation that are no candidate now: judged
  // (their escalations can close), never rung (there is no binding to ring).
  for (const name of input.ledger?.agents() ?? []) {
    if (covered.has(name)) continue;
    covered.add(name);
    let read: PendingRead;
    try {
      read = input.pending(name);
    } catch (err) {
      skipped.push({ binding_id: "", agent_name: name, why: `its pending set cannot be read (${err instanceof Error ? err.message : String(err)})` });
      continue;
    }
    if (read.registered) judge(name, read);
  }
  return view();
}

/**
 * What became of ONE ring, judged against ONE pending read (A2.3 as corrected by V4; plan v3
 * PR 3). Its ONLY inputs are the ring's (reading session, ids) and the canonical pending set
 * with the reading session it was read for, both from pendingMetadata: never `read_at` (stamped
 * once, by any session), never `last_drain_at` (agent-level), never a count.
 *
 *   - "effective": the reading session is UNCHANGED and at least one rung id has LEFT its
 *     pending set (read by that session, or resolved). `left` lists them, in canonical order.
 *   - "still_pending": the reading session is unchanged and every rung id is still pending.
 *   - "session_changed": the reading session moved (or is unbound now). That is the V4 rescue
 *     path, NEVER effectiveness: an id can be absent from the new session's set only because
 *     the new session read it earlier, which says nothing about this ring.
 */
export type RingEffect = { outcome: "effective"; left: string[] } | { outcome: "still_pending" } | { outcome: "session_changed" };

export function ringEffect(
  covers: { reading_session: string; message_ids: readonly string[] },
  read: { reading_session: string | null; ids: readonly string[] },
): RingEffect {
  if (read.reading_session !== covers.reading_session) return { outcome: "session_changed" };
  const pending = new Set(read.ids);
  const left = [...new Set(covers.message_ids.filter((id) => !pending.has(id)))].sort();
  return left.length > 0 ? { outcome: "effective", left } : { outcome: "still_pending" };
}

/**
 * Ruling 622689ba (2): a PREVIOUS lifetime's rings on THIS lifetime's monotonic clock. A ring
 * counts iff its wall age at this start is under the budget window, OR that age is
 * IMPLAUSIBLE (negative, or the log's last header is AHEAD of now: a detectable backward
 * jump), which fails SAFE: it counts as if it rang at this start. A plausible ring sits at
 * minus its wall age. A forward jump entirely inside the restart gap is a documented KNOWN
 * LIMIT (at most one extra budget window per restart).
 */
export function effectiveRingMono(
  ringWalls: ReadonlyMap<string, readonly number[]>,
  lastHeaderWall: number | null,
  startWall: number,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const [agent, walls] of ringWalls) out.set(agent, walls.map((w) => placeRing(w, lastHeaderWall, startWall)));
  return out;
}

/**
 * THE placement (rule 2), the ONE function the start-up counter AND compaction use, so they
 * can never disagree (#301 Codex R2 #1): a previous lifetime's ring at minus its wall age,
 * or at 0 ("just now", fail safe) when that age is implausible (negative, or the log's last
 * header is ahead of now).
 */
export function placeRing(wall: number, lastHeaderWall: number | null, startWall: number): number {
  const age = startWall - wall;
  return (lastHeaderWall !== null && lastHeaderWall > startWall) || age < 0 ? 0 : -age;
}

/** Does a previous lifetime's ring still count toward the budget at this start? (placeRing, inside the window) */
export function ringCountsAtStart(wall: number, lastHeaderWall: number | null, startWall: number): boolean {
  return placeRing(wall, lastHeaderWall, startWall) > -BUDGET_WINDOW_MS;
}
