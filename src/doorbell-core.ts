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
 *     measured for it. It is a BOARD case (PR 6, below).
 *   - THE BOARD (PR 6; plan §v4, architect ruling 5dda2752). Bindings are GROUPED by agent first
 *     ("current" is per window anchor, not per name: a dead window's binding stays current by
 *     design, so an agent typically holds several). Each binding's window anchor is judged on
 *     its own (anchorLivenessVerdict), and only a binding PROVEN dead is set aside. Then, for an
 *     agent with pending mail, in this precedence:
 *       · ambiguous_binding: 2 or more not-dead bindings (alive OR unverifiable: an anchor that
 *         cannot be shown dead is never discarded). Q4: refused, never a guess;
 *       · no_live_window: no ALIVE binding (all dead, a sole unverifiable one, or none at all;
 *         an agent with mail and no binding is found through `mailAgents`);
 *       · session_unbound: exactly one alive binding and no reading session (V4);
 *       · otherwise the one alive binding is the ring candidate.
 *     A board case writes NO intent. Its record is written only when the agent's board state
 *     CHANGES (A3.2), from the state the LOG holds (`boardOpen`), so a restart writes nothing
 *     new. An agent with nothing pending is never a board case (ruling Q6); its open case closes
 *     (`no_mail`). An agent this cycle could NOT evaluate (its pending read failed, or this
 *     host is unknown) is a HOLD: its board state neither closes nor re-opens, and it is listed
 *     in `notEvaluated` (a HOLD is never silent).
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
 *       · A NEW, NON-NULL reading session is the V4 rescue path, never effectiveness: the old
 *         session's outstanding rings are recorded `session_changed`, its escalations close.
 *       · NO reading session (a window close NULLs it) is a HOLD (B1): nothing is judged,
 *         written or closed, and outstanding rings stay outstanding until a session exists.
 *     `operator` (V3) is attribution on escalation records only, never a ring target.
 */
import type { BoardCase, BoardRecord, BudgetRecord, EffectRecord, EscalationRecord, IdKind, Intent, IntentRecord, LogRecord, NoDriverWhy } from "./doorbell-log.js";
import { MAX_IDS_PER_INTENT, rungKey } from "./doorbell-log.js";
import type { AnchorVerdict } from "./liveness.js";

export interface CandidateBinding {
  binding_id: string;
  agent_name: string | null;
  host_id: string;
  /** The window's anchor (pid + start token): what `liveness` judges. */
  window_pid?: number | null;
  window_pid_start?: string | null;
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
/**
 * Ineffective rings in a row, for one (agent, reading session), that open an escalation (plan PR 3).
 * INVARIANT (architect eb70f58a): ESCALATE_AFTER <= RE_RING_CAP, asserted below. See RE_RING_CAP.
 */
export const ESCALATE_AFTER = 3;
/**
 * K: at most this many rings per (id, reading session), first ring included (ruling c04f463a Q2).
 * INVARIANT (architect eb70f58a): ESCALATE_AFTER <= RE_RING_CAP. A DEAF agent (nothing drains) must
 * reach agent_unresponsive before any of its ids reaches the cap; with the cap lower, the id would
 * get id_stuck first and the deaf agent would never be called unresponsive (ruling 478083e0 F3).
 * Both are 3 today, so it holds by value; it becomes load-bearing the moment either is tunable.
 */
export const RE_RING_CAP = 3;
if (!(ESCALATE_AFTER <= RE_RING_CAP)) {
  throw new Error(`doorbell invariant violated: ESCALATE_AFTER (${ESCALATE_AFTER}) must be <= RE_RING_CAP (${RE_RING_CAP})`);
}

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
 * and EVERY agent with a ledger record, to be reconciled whether or not it is bound now. The job and the tests build it here, so they cannot disagree.
 */
export function ledgerInput(records: readonly LogRecord[], monoOf: (rec: IntentRecord) => number): NonNullable<CycleInput["ledger"]> {
  const history = new Map<string, LedgerRecord[]>();
  for (const r of records) {
    if (r.type !== "intent" && r.type !== "effect" && r.type !== "escalation") continue;
    const agent = r.type === "intent" ? r.intent.agent_name : r.agent_name;
    const list = history.get(agent);
    if (list) list.push(r);
    else history.set(agent, [r]);
  }
  // SUPERSET BY CONSTRUCTION (#302 Codex R2 F1; architect e2718659): EVERY agent with ANY ledger
  // record in the log is reconciled every cycle, bound or not. No hand-enumerated "who is owed"
  // predicate to drift (outstanding rings, open escalations, a counter at the threshold whose
  // escalation a crash lost, ...): reconciliation itself decides what to emit. Compaction bounds
  // the set; the cost is one pending read per such agent per cycle. The NULL-session HOLD is
  // unchanged (judge() writes nothing for an unbound session).
  const agents = [...history.keys()].sort();
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
 *       KNOWN, ACCEPTED (review 2fda069b D3): an agent whose session is unchanged but which
 *       has no binding (so it is no candidate) and nothing owed (so it is never read) never
 *       records that progress, and (e) holds its intent indefinitely. It is bounded per agent
 *       (at most K rings per id, none added while it is not rung) and ends at its next
 *       re-registration (a new session; a NULLed one is never restored: register mints one).
 *   (f) it is the during_escalation (extra) ring of an OPEN agent_unresponsive escalation
 *       (ruling 478083e0): its ids belong to the episode the close predicate tests, so an
 *       episode that progressed ONLY through the extra ring's id keeps that id. At most one
 *       per escalation. (Today (b) also keeps it, since nothing else rings an escalated agent;
 *       (f) does not depend on that.)
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
  // (f): the extra ring of each agent_unresponsive escalation STILL OPEN at the end of the log,
  // tied to ITS escalation (log order: the extra ring follows its open record).
  const extraOf = new Map<string, string>(); // escalation_id → its extra ring's intent_id
  const openU = new Map<string, string>(); // escalation_id → agent \0 session, while open
  for (const r of records) {
    if (r.type === "escalation" && r.reason === "agent_unresponsive") {
      if (r.state === "open") openU.set(r.escalation_id, `${r.agent_name}\u0000${r.reading_session}`);
      else openU.delete(r.escalation_id);
    } else if (r.type === "intent" && r.intent.during_escalation) {
      for (const [eid, key] of openU) if (key === `${r.intent.agent_name}\u0000${r.covers.reading_session}`) extraOf.set(eid, r.intent.intent_id);
    }
  }
  const keepExtra = new Set([...openU.keys()].map((eid) => extraOf.get(eid)).filter((x): x is string => !!x));
  return (rec) => {
    if (keepExtra.has(rec.intent.intent_id)) return true; // (f)
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
  /** PR 6: ONE binding's window-anchor liveness (production: anchorLivenessVerdict on window_pid + window_pid_start). */
  liveness: (b: CandidateBinding) => AnchorVerdict;
  /** PR 6: registered agents with at least one pending message (PENDING_FOR_AGENT_ROW_SQL), bound or not. */
  mailAgents: () => readonly string[];
  /** PR 6: each agent's OPEN board case, as the log holds it. Not mutated. */
  boardOpen: ReadonlyMap<string, BoardRecord>;
  /**
   * PR 7 (plan §v6): THE WATCH SUPERVISOR. When given, the doorbell forms NO intents at all: each agent
   * wakes through its own `relay watch --until-wake` (zero doorbell tokens). For the ONE live,
   * session-bound window it reports: a live watch → nothing (or `undelivered_with_watch` when mail it
   * already woke the agent for is still undelivered after the horizon); no watch → no_driver(watch_absent);
   * a hung one → no_driver(watch_stale). Absent (tests, a future active driver): PR 1-6's intent path.
   */
  watchFit?: (agentName: string, read: PendingRead) => { status: "live" | "stale" | "absent"; undeliveredAfterWake: boolean };
  /**
   * Ruling 1a8fc7c4 (1): the ACTUATING driver, if one is registered. An intent is formed ONLY for an
   * agent it fits (an intent is a ring PR 3 will judge). NONE in production today → zero intents; the
   * PR 1-6 tests pass one to exercise the intent path. A live watch still wins over it (ruling (3)).
   */
  actuator?: { fits: (agentName: string) => boolean };
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
  /** PR 6: board-state CHANGES this cycle (empty when nothing changed). */
  board: BoardRecord[];
  /** PR 6: agents this cycle could not evaluate (a HOLD: their board state is untouched). */
  notEvaluated: string[];
  /**
   * PR 6 (#310 Codex R1 #2): why the all-agent mail query failed this cycle, or null. When it fails,
   * agents with mail and NO binding cannot even be found, so they cannot be named: this says so
   * explicitly. Every agent that CAN be named (bound, or with an open case) is still evaluated.
   */
  mailQueryFailed: string | null;
  skipped: CycleSkip[];
}

const sortedSet = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

export function planCycle(input: CycleInput): CyclePlan {
  const records: LogRecord[] = [];
  const skipped: CycleSkip[] = [];
  const notEvaluated: string[] = [];
  let mailQueryFailed: string | null = null;
  /** The agents with pending mail (bound or not), or [] with mailQueryFailed set: never a silent gap. */
  const mailAgents = (): readonly string[] => {
    try {
      return input.mailAgents();
    } catch (err) {
      mailQueryFailed = err instanceof Error ? err.message : String(err);
      return [];
    }
  };
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
    board: records.filter((r): r is BoardRecord => r.type === "board"),
    notEvaluated,
    mailQueryFailed,
    skipped,
  });
  if (!input.ownHostId) {
    for (const b of input.bindings) skipped.push({ binding_id: b.binding_id, agent_name: b.agent_name, why: "this host's identity is unknown: no binding can be shown to be local" });
    // A HOLD, never a change: nothing is judged, every board state stays as it is. Every agent that
    // WOULD have been evaluated is named, the unbound ones with mail included (#310 Codex R1 #2).
    notEvaluated.push(...sortedSet([...input.bindings.flatMap((b) => (b.agent_name ? [b.agent_name] : [])), ...mailAgents(), ...input.boardOpen.keys()]));
    return view();
  }

  const escalation = (name: string, rs: string, reason: EscalationRecord["reason"], ids: Iterable<string>, state: "open" | "closed", id: string, close: EscalationRecord["close_reason"]): EscalationRecord => ({
    v: 1, type: "escalation", at, escalation_id: id, agent_name: name, reading_session: rs, reason, state, message_ids: sortedSet(ids), operator, close_reason: close,
  });
  const closeOf = (e: EscalationRecord, why: "progress" | "session_changed"): EscalationRecord => escalation(e.agent_name, e.reading_session, e.reason, e.message_ids, "closed", e.escalation_id, why);

  /**
   * An effect as one or more records, each within the per-record id bound (#302 Codex R1 F4: an
   * aggregated effect over MAX_IDS_PER_INTENT ids was refused by the writer and stalled every
   * later cycle). Chunk k carries the k-th slice of each list; every chunk of an `effective`
   * batch is progress (deriveLedger resets on each), so the split changes no decision.
   */
  const effectRecords = (name: string, rs: string, outcome: EffectRecord["outcome"], intentIds: Iterable<string>, left: Iterable<string>): EffectRecord[] => {
    const ii = sortedSet(intentIds);
    const ll = sortedSet(left);
    const n = Math.max(1, Math.ceil(ii.length / MAX_IDS_PER_INTENT), Math.ceil(ll.length / MAX_IDS_PER_INTENT));
    return Array.from({ length: n }, (_, k) => ({
      v: 1 as const, type: "effect" as const, at, agent_name: name, reading_session: rs, outcome,
      intent_ids: ii.slice(k * MAX_IDS_PER_INTENT, (k + 1) * MAX_IDS_PER_INTENT),
      left: ll.slice(k * MAX_IDS_PER_INTENT, (k + 1) * MAX_IDS_PER_INTENT),
    }));
  };

  /**
   * PR 3, for ONE agent and its current read: judge its rings and move its escalations.
   * Appends the records and returns the ledger AFTER them (what the ring step decides on).
   */
  const judge = (name: string, read: PendingRead): AgentLedger | null => {
    if (!input.ledger) return null;
    const rs = read.reading_session;
    // B1 (review 2fda069b): NEVER JUDGE WHERE IT CANNOT BE MEASURED. An unbound session (every
    // window close NULLs agents.session_id) is a HOLD: write nothing, close nothing, judge
    // nothing; outstanding rings stay outstanding. Only a NEW NON-NULL session is the rescue.
    if (!rs) return null;
    const { ledger, other } = deriveLedger(input.ledger.history(name), rs, (r) => input.ledger!.monoOf(r));
    // The V4 rescue path: the old session's rings are moot and its escalations close.
    for (const [ors, ids] of other.outstanding) records.push(...effectRecords(name, ors, "session_changed", ids, []));
    for (const e of other.open) records.push(closeOf(e, "session_changed"));
    const pending = new Set(read.ids);
    // PROGRESS first, by THE judgement (ringEffect): a rung id of this session, not yet
    // recorded as left, has LEFT its pending set.
    const watch = [...ledger.rungIds].filter((id) => !ledger.recordedLeft.has(id));
    const effect = watch.length > 0 ? ringEffect({ reading_session: rs, message_ids: watch }, read) : null;
    const leftNow = effect?.outcome === "effective" ? effect.left : [];
    if (leftNow.length > 0) {
      records.push(...effectRecords(name, rs, "effective", ledger.outstanding.map((o) => o.intent_id), leftNow));
      ledger.outstanding = [];
      ledger.counter = 0;
      for (const id of leftNow) ledger.recordedLeft.add(id);
    }
    // THE CLOSE (ruling c04f463a Q4): an episode id has LEFT pending in this same session. It is
    // judged against the PENDING READ itself, never through rung memory, which a compaction may
    // drop (#302 Codex R1 F1: a crash between the effective record and the close, then a
    // compaction, stranded the escalation open forever). The episode is the open record's own
    // ids plus its one extra ring's; that intent is retained by keep rule (f) (ruling 478083e0).
    if (ledger.unresponsive && [...ledger.unresponsive.episode].some((id) => !pending.has(id))) {
      records.push(closeOf(ledger.unresponsive.rec, "progress"));
      ledger.unresponsive = null;
    }
    for (const [id, e] of ledger.stuck) if (!pending.has(id)) {
      records.push(closeOf(e, "progress"));
      ledger.stuck.delete(id);
    }
    // THE HORIZON: a ring still outstanding H after it rang was ineffective.
    for (const o of [...ledger.outstanding]) {
      if (nowMono - o.mono < input.horizonMs) continue;
      records.push({ v: 1, type: "effect", at, agent_name: name, reading_session: rs, outcome: "ineffective", intent_ids: [o.intent_id], left: [] });
      ledger.outstanding = ledger.outstanding.filter((x) => x !== o);
      ledger.counter += 1;
    }
    // THE THRESHOLD, reconciled from the RECOVERED state on every cycle, not only at the moment a
    // ring is judged (#302 Codex R1 F2: a crash between the 3rd ineffective record and the
    // escalation lost it forever). A counter at the threshold with no open escalation opens one.
    // (Progress resets the counter in the same record that closes an episode, and a session
    // change is a new key, so this state means exactly "the escalation was never written".)
    if (ledger.counter >= ESCALATE_AFTER && !ledger.unresponsive) {
      // A WITNESS SUBSET (ruling 97ced827 (3)): at most MAX ids, the first in canonical order, so the
      // record stays within the writer's bound; any sampled id leaving closes it. Same stale-premise
      // dependency on random (v4) ids as the intent cap.
      const ids = sortedSet([...ledger.rungIds].filter((id) => pending.has(id))).slice(0, MAX_IDS_PER_INTENT);
      if (ids.length > 0) {
        const rec = escalation(name, rs, "agent_unresponsive", ids, "open", newEscalationId(), null);
        records.push(rec);
        ledger.unresponsive = { rec, episode: new Set(rec.message_ids), extraRung: false };
      }
    }
    return ledger;
  };

  // PR 6: GROUP by agent first. A binding with no agent name is not an agent: it can hold no mail.
  const groups = new Map<string, CandidateBinding[]>();
  for (const b of input.bindings) {
    if (!b.agent_name) {
      skipped.push({ binding_id: b.binding_id, agent_name: null, why: "the binding names no agent" });
      continue;
    }
    groups.set(b.agent_name, [...(groups.get(b.agent_name) ?? []), b]);
  }
  const boardOpen = new Map(input.boardOpen);
  /** Move ONE agent's board state; a record ONLY when it changes (A3.2). */
  const boardTo = (name: string, next: { case: BoardCase; binding_ids: string[]; dead_count: number; why?: NoDriverWhy } | null, pendingCount: number, closeWhy: "resolved" | "no_mail"): void => {
    const cur = boardOpen.get(name);
    if (next && cur && cur.case === next.case && cur.why === next.why) return; // unchanged: written once per state change (no_driver's state includes its why)
    if (cur) {
      records.push({ ...cur, at, state: "closed", pending_count: pendingCount, close_reason: next ? "resolved" : closeWhy });
      boardOpen.delete(name);
    }
    if (next) {
      const rec: BoardRecord = { v: 1, type: "board", at, board_id: newEscalationId(), agent_name: name, case: next.case, state: "open", binding_ids: next.binding_ids.slice(0, MAX_IDS_PER_INTENT), dead_count: next.dead_count, pending_count: pendingCount, close_reason: null, ...(next.case === "no_driver" ? { why: next.why } : {}) };
      records.push(rec);
      boardOpen.set(name, rec);
    }
  };
  const BOARD_WHY: Record<BoardCase, string> = {
    ambiguous_binding: "ambiguous: 2 or more bindings whose window is not proven dead (Q4: never guess; a board case)",
    no_live_window: "no live window: no binding whose window is alive (a board case)",
    session_unbound: "no bound reading session: delivery cannot be measured, so it is never rung (a board case: re-register or relaunch)",
    no_driver: "no live relay watch for this window (a board case: re-arm `relay watch <agent> --until-wake`)",
    undelivered_with_watch: "the watch woke this agent and the mail is still undelivered after the horizon (a board case)",
  };

  const covered = new Set<string>(); // agents evaluated this cycle
  for (const name of sortedSet([...groups.keys(), ...mailAgents(), ...boardOpen.keys()])) {
    const bs = groups.get(name) ?? [];
    const skip = (why: string, at?: CandidateBinding) => skipped.push({ binding_id: (at ?? bs[0])?.binding_id ?? "", agent_name: name, why });
    let read: PendingRead;
    try {
      read = input.pending(name);
    } catch (err) {
      skip(`its pending set cannot be read (${err instanceof Error ? err.message : String(err)})`);
      notEvaluated.push(name); // a HOLD: its board state is untouched
      continue;
    }
    covered.add(name);
    if (!read.registered) {
      boardTo(name, null, 0, "no_mail");
      if (bs.length > 0) skip("the agent is not registered in this DB");
      continue;
    }
    const ledger = judge(name, read);
    const rs = read.reading_session;
    const times = input.ringMono.get(name) ?? [];
    // Q4: the budget STATE, evaluated every cycle for an agent bound on THIS host with a reading
    // session, so its change is logged when it happens (A3.2), with or without new mail.
    const inHour = times.filter((t) => t > nowMono - BUDGET_WINDOW_MS).length;
    const exhaustedNow = inHour >= input.budgetPerHour;
    if (rs && bs.some((x) => x.host_id === input.ownHostId) && exhaustedNow !== input.budgetExhausted.has(name)) {
      records.push({ v: 1, type: "budget", at, agent_name: name, state: exhaustedNow ? "exhausted" : "available", rings_in_hour: inHour, budget_per_hour: input.budgetPerHour });
    }
    if (read.ids.length === 0) {
      boardTo(name, null, 0, "no_mail"); // never a board case without pending mail (ruling Q6)
      continue;
    }
    // THE DECISION (ruling 5dda2752): each binding's window on its own; only the PROVEN dead are set
    // aside. Another host's window cannot be judged from here: unverifiable, never dead.
    const judged = bs.map((x) => ({ b: x, v: x.host_id === input.ownHostId ? input.liveness(x) : ("unverifiable" as AnchorVerdict) }));
    const notDead = judged.filter((x) => x.v !== "dead");
    const alive = notDead.filter((x) => x.v === "alive");
    const deadCount = judged.length - notDead.length;
    const idsOf = (xs: typeof judged) => sortedSet(xs.map((x) => x.b.binding_id));
    let next: { case: BoardCase; binding_ids: string[]; dead_count: number; why?: NoDriverWhy } | null =
      notDead.length >= 2
        ? { case: "ambiguous_binding", binding_ids: idsOf(notDead), dead_count: deadCount }
        : alive.length === 0
          ? { case: "no_live_window", binding_ids: idsOf(notDead), dead_count: deadCount }
          : !rs
            ? { case: "session_unbound", binding_ids: idsOf(alive), dead_count: deadCount }
            : null;
    // PR 7 (§v6): the WATCH SUPERVISOR. With it, the ONE live, session-bound window is never rung by the
    // doorbell: its own watch wakes it. The doorbell only reports a missing, hung or ineffective watch.
    // Ruling 7224605e (3): NO intent for a watch-armed agent (the watch is the wake).
    // Ruling 1a8fc7c4 (1): NO intent at all unless an ACTUATING driver fits: PR 3 judges every intent
    // as a ring, so an intent nothing actuates would be judged ineffective and open a FALSE
    // agent_unresponsive escalation. With no actuator registered (production today) an unarmed agent
    // is boarded no_driver only; the seam stays for a future actuator.
    const actuated = !next && !!rs && !!input.actuator?.fits(name);
    if (!next && rs && input.watchFit) {
      const wf = input.watchFit(name, read);
      if (wf.status === "live") next = wf.undeliveredAfterWake ? { case: "undelivered_with_watch", binding_ids: idsOf(alive), dead_count: deadCount } : null;
      else if (!actuated) next = { case: "no_driver", binding_ids: idsOf(alive), dead_count: deadCount, why: wf.status === "stale" ? "watch_stale" : "watch_absent" };
      boardTo(name, next, read.ids.length, "resolved");
      if (next) skip(`${BOARD_WHY[next.case]}${next.why ? ` (${next.why})` : ""}`);
      if (wf.status === "live" || next) continue; // the watch is the wake, or there is no driver: NO intent
    } else boardTo(name, next, read.ids.length, "resolved");
    if (!next && rs && !actuated) {
      skip("no actuating driver: no intent (an un-actuated ring would be judged ineffective)");
      continue;
    }
    if (next || !rs) {
      skip(BOARD_WHY[next ? next.case : "session_unbound"]);
      continue;
    }
    const b = alive[0].b; // the ONE live window: the ring candidate
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
    // THE INTENT CAP (ruling 97ced827): one intent covers at most MAX_IDS_PER_INTENT ids: the FIRST
    // MAX, in CANONICAL (string) order, of every id due this cycle (new ∪ due still_pending), with NO
    // class priority. The rest are simply not rung now (a new id rings on the next ring after W; a
    // still_pending one stays due). Not still_pending-first: a responsive agent drains newest-first,
    // so the oldest ids first would make a working ring look ineffective and open a FALSE
    // agent_unresponsive exactly under overflow. With no overflow, nothing changes.
    // ⚠ STALE-PREMISE DEPENDENCY: canonical order is an UNBIASED sample of the backlog only because
    // relay message ids are RANDOM (v4 UUIDs; pinned by tests/doorbell-pr3-effect.test.ts). If ids
    // ever become time-ordered (UUIDv7, federation-minted, sequential), canonical order turns into
    // oldest-first and this rule (and the escalation witness cap below) must be REVISITED.
    const ids = sortedSet(kinds.keys()).slice(0, MAX_IDS_PER_INTENT);
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
 *   - "session_changed": a NEW, NON-NULL reading session. That is the V4 rescue path, NEVER
 *     effectiveness: an id can be absent from the new session's set only because the new
 *     session read it earlier, which says nothing about this ring.
 *   - "unbound": no reading session now (a window close NULLs it). Delivery cannot be measured,
 *     so it is NEITHER effective NOR a change: a HOLD (B1, review 2fda069b).
 */
export type RingEffect = { outcome: "effective"; left: string[] } | { outcome: "still_pending" } | { outcome: "session_changed" } | { outcome: "unbound" };

export function ringEffect(
  covers: { reading_session: string; message_ids: readonly string[] },
  read: { reading_session: string | null; ids: readonly string[] },
): RingEffect {
  if (read.reading_session === null) return { outcome: "unbound" };
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
