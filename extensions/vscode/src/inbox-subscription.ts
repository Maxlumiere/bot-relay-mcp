// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// The inbox-subscription seam.
//
// Extracted from connect() so the SHIPPED subscribe→notify→wake path is
// exercisable without a VSCode host (the v0.2.3 R0 integration test proved
// decideWake in isolation but never drove the real subscription wiring, so a
// regression in the handler would not have failed it — the "test-path-must-
// match-shipped-path" trap). subscribeInboxes + WakeGate are VSCode-free (they
// take the MCP Client + plain callbacks), so the integration test runs the REAL
// handler against the real HTTP daemon with only the terminal keystroke spied.
//
// MULTI-AGENT: Tether watches a LIST of agents at once. ONE ResourceUpdated
// handler dispatches by inbox URI to the matching agent's per-agent WakeGate, so
// a Claude agent and a Codex agent (each with its own adapter) stay awake side by
// side with no switching. subscribeInbox is the single-agent shim over it.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { decideWake, type WakeInboxView } from "./catch-up-wake.js";
import { routeWake, type ObservedAgentState } from "./wake-routing.js";

/** What the router needs to observe at decision time (ADR-0010). Supplied by
 *  the caller per consideration — the gate stays pure of VSCode + MCP. */
export interface WakeObservation {
  /** Liveness-derived agent state (v2.19 verdict; activity-inferred). */
  state: ObservedAgentState;
  /** Does this agent's CLI install a tool-result hook (busy already covered)? */
  busyCoveredByHook: boolean;
}

/**
 * Owns the catch-up/live high-water mark (the newest-message timestamp we last
 * woke for) so the catch-up path and the live notification path never
 * double-wake each other. ONE instance PER AGENT, created at activate/connect and
 * reused across reconnects so the mark survives reconnects (no re-wake with no
 * new mail). A window reload re-creates the instance → the mark resets → still-
 * pending mail re-wakes (A1, intended).
 */
/**
 * TTL BACKSTOP for the outstanding-wake flag — deliberately LONG (3h), and
 * only a backstop. The primary clear signals are DECIDABLE EVENTS (idle
 * evidence: an agent observed idle cannot still hold our injection, the host
 * submits queued input at the turn boundary; loss evidence: the injected-into
 * terminal closes, the injection fails, a window reload recreates the gate).
 * NOT a drain — pending_count returning to 0 is NOT consumption (a busy
 * agent's hook drains without touching the queued injection). Time is only
 * for losses none of the decidable signals can observe. It must exceed a long
 * build turn with margin: 70-minute single turns are NORMAL deep-build
 * behavior here, and a TTL shorter than a turn re-injects repeatedly through
 * it — recreating the exact stacked-wake wall this exists to remove.
 */
export const DEFAULT_WAKE_OUTSTANDING_TTL_MS = 3 * 60 * 60 * 1000;

/** How often a PERSISTENT decline repeats in the log. Changes always log
 *  immediately; this only rate-limits the unchanged condition. */
export const DEFAULT_DECLINE_HEARTBEAT_MS = 5 * 60 * 1000;

/** How long a landed injection is given to be acted on before an idle agent
 *  with pending mail counts as owed a fresh wake. One poll interval (15s) plus
 *  headroom — long enough that a delivery in progress is never read as a
 *  failure, short enough that stranding is measured in seconds. */
export const DEFAULT_LANDED_SETTLE_MS = 20_000;

export class WakeGate {
  private lastWokenAt: string | null = null;
  /**
   * Rule-1 idempotency (2026-07-23, the 14-stacked-wakes fix): epoch-ms of an
   * injection we have fired that the agent has NOT yet consumed. While set
   * (and fresh), NO further injection fires no matter how much new mail
   * arrives — the queued injection drains the WHOLE inbox when consumed.
   * Consumption is observed as pending_count returning to 0, whichever path
   * drained it (Tether's own injection or the PostToolUse hook — the gate
   * neither knows nor needs to know which). TETHER'S JOB IS TO WAKE AN IDLE
   * AGENT; this flag is how that rule is enforced by observable state rather
   * than by busy-detection (which would strand mail when a turn ends without
   * a tool call — measured and ruled out, see PR).
   */
  private outstandingSince: number | null = null;
  /**
   * The high-water mark AS IT STOOD before the currently-outstanding injection
   * advanced it. Held so LOSS EVIDENCE can roll `lastWokenAt` back to it: a
   * wake that never landed must not count as "woken for", or the SAME still-
   * pending mail is masked (its timestamp === lastWokenAt) and stays silent
   * until newer mail bumps the timestamp past it — the codex #126 failed-
   * delivery-stays-silent-INDEFINITELY bug (a poll re-route must recover it on
   * the very next tick). null whenever nothing is outstanding.
   */
  private markBeforeOutstanding: string | null = null;
  /**
   * Has the currently-outstanding injection actually LANDED — adapter.wake
   * resolved, the keystroke was typed AND submitted? onWake only SCHEDULES the
   * async inject; binding-fetch + terminal-resolve + adapter submission all run
   * after it returns. Until the caller acks landing (markInjectionLanded), an
   * IDLE snapshot is NOT proof our injection submitted — it may be a stale read
   * from the in-flight window (before our keystroke) — so idle must NOT flush a
   * not-yet-landed wake, or a second inject fires and re-stacks (codex #126
   * round 2: two consecutive idle snapshots produced {first:true, second:true}
   * while wake #1 was still in flight). false whenever nothing is outstanding.
   */
  private outstandingLanded = false;
  /**
   * When the outstanding injection was acked as landed. Used for the settle
   * grace below — an idle read taken immediately after a submit may simply
   * predate the agent picking it up.
   */
  private landedAt: number | null = null;

  /**
   * #4a — SUPPRESSION VISIBILITY.
   *
   * Every `consider()` that declines to wake used to `return false` in silence.
   * That made the ONLY failure mode which actually strands the fleet the one
   * mode that says nothing, while the harmless no-terminal-bound case shouts.
   * Loud when it cannot find you, silent when it decides not to try.
   *
   * The cost of that silence, measured: thirty inbox events in one morning
   * produced thirty silent declines, and the log physically could not say which
   * of two candidate mechanisms was responsible. The diagnosis had to be done by
   * reading source, and it still ended in "these two are indistinguishable from
   * outside".
   *
   * NOISE CONTROL, because a log nobody can read is its own silence: the poll
   * tick re-considers every watched agent every 15s, so logging every decline
   * would emit thousands of identical lines an hour and bury the transition
   * that matters. A line is emitted when the REASON CHANGES for an agent, and
   * thereafter at most once per heartbeat interval — so a state change is
   * immediate and a persistent condition stays visible without flooding.
   */
  private lastDeclineReason: string | null = null;
  private lastDeclineLoggedAt = 0;

  constructor(
    private readonly onWake: (agentName: string) => void,
    private readonly opts: {
      outstandingTtlMs?: number;
      now?: () => number;
      log?: (msg: string) => void;
      declineHeartbeatMs?: number;
      landedSettleMs?: number;
    } = {},
  ) {}

  /** Report a decline, deduplicated by reason. Returns nothing; never throws. */
  private reportDecline(agentName: string, reason: string, detail: string): void {
    const emit = this.opts.log;
    if (!emit) return;
    const now = (this.opts.now ?? Date.now)();
    const heartbeat = this.opts.declineHeartbeatMs ?? DEFAULT_DECLINE_HEARTBEAT_MS;
    const changed = reason !== this.lastDeclineReason;
    if (!changed && now - this.lastDeclineLoggedAt < heartbeat) return;
    this.lastDeclineReason = reason;
    this.lastDeclineLoggedAt = now;
    try {
      emit(`wake declined for "${agentName}": ${reason}${detail ? ` (${detail})` : ""}${changed ? "" : " [still]"}`);
    } catch {
      /* a logger must never break the wake path */
    }
  }

  /** Clear the decline memo so the next decline logs immediately. Called when a
   *  wake actually fires — the next decline after a delivery is news. */
  private resetDeclineMemo(): void {
    this.lastDeclineReason = null;
    this.lastDeclineLoggedAt = 0;
  }

  /**
   * LOSS EVIDENCE: the terminal we injected into closed, the injection failed
   * to land, or the binding was invalidated. A decidable event — clear the
   * flag so the next mail event re-wakes immediately (no TTL wait).
   */
  clearOutstanding(): void {
    this.markLost();
  }

  /**
   * DELIVERY ACK: the async injection this gate fired was DISPATCHED —
   * adapter.wake resolved, meaning the wake sequence (type, settle, separate
   * submit) was written to the terminal. NOT proof the TUI processed the
   * submit: sendText resolving says nothing about what the agent did with the
   * bytes (the 2026-07-24 wake bug hid here — a types-but-never-submits wake
   * acked "landed" and read idle, so the gate flushed and every new message
   * stacked another injection). Dispatch-ack is still the right gate input; the
   * submit correctness itself is the adapter's contract (llm-adapter.ts). Only
   * after this ack is an idle observation valid FLUSH evidence; before it, idle
   * is a stale read from the in-flight window and must not flush the wake
   * (codex #126 round 2). The caller MUST epoch-guard this so a stale ack from
   * a superseded injection can't mark a newer one landed. No-op if nothing is
   * outstanding (a lost/flushed injection already cleared the flag).
   */
  markInjectionLanded(): void {
    if (this.outstandingSince !== null) {
      this.outstandingLanded = true;
      this.landedAt = (this.opts.now ?? Date.now)();
    }
  }

  /**
   * FLUSH EVIDENCE: a LANDED injection was consumed — the host submitted the
   * queued input at the turn boundary and drained it. Clear the outstanding
   * flag; the mark STAYS advanced because we genuinely woke for that mail (no
   * re-wake of the same message).
   */
  private markLanded(): void {
    this.landedAt = null;
    this.outstandingSince = null;
    this.outstandingLanded = false;
    this.markBeforeOutstanding = null;
  }

  /**
   * LOSS EVIDENCE: the injection did NOT land. Clear the outstanding flag AND
   * roll `lastWokenAt` back to its pre-injection value, so the SAME still-
   * pending mail re-wakes on the next route (no silence-until-newer-mail).
   * Guarded on an actual outstanding injection so a stray clear cannot disturb
   * a good mark.
   */
  private markLost(): void {
    this.landedAt = null;
    if (this.outstandingSince !== null) this.lastWokenAt = this.markBeforeOutstanding;
    this.outstandingSince = null;
    this.outstandingLanded = false;
    this.markBeforeOutstanding = null;
  }

  /**
   * Consider a snapshot for one wake (ADR-0010 state-routed). Returns whether
   * it fired (handy for tests/telemetry). Advances the mark exactly as
   * decideWake dictates — a same-timestamp tie fails safe to NO re-wake.
   *
   * OUTSTANDING CLEARS ONLY ON: idle-evidence (below), loss evidence
   * (clearOutstanding), or the TTL backstop. NEVER on drain — a busy agent's
   * PostToolUse drain empties the inbox WITHOUT consuming the queued
   * injection (injection-consumption and inbox-drain are different events;
   * pending==0-as-consumption was the falsified first design, the one that
   * re-created the fourteen-stack).
   *
   * ANTI-STRANDING CONTRACT ON THE CALLER: every suppression here is only
   * safe because the caller re-considers on the poll tick as well as on
   * arrival notifications — a wake suppressed while busy fires within one
   * tick of the agent being observed idle.
   */
  consider(
    snapshot: WakeInboxView,
    agentName: string,
    autoInjectInbox: boolean,
    observed: WakeObservation = { state: "unknown", busyCoveredByHook: false },
  ): boolean {
    const now = this.opts.now ?? Date.now;
    // ── WATERMARK: CONSUMPTION EVIDENCE, NOT DISPATCH ────────────────────
    //
    // `lastWokenAt` used to advance on DISPATCH, so a wake that never achieved
    // delivery marked its mail "woken for" and the mail was never re-offered.
    // Live instance: codex-lumen stranded from 04:05 with pending=1 until a
    // human cleared it by hand. A proxy ("I sent a wake") standing in for the
    // property ("the mail was read").
    //
    // THE PREDICATE, stated at the strength the evidence supports: idle with
    // mail still pending does NOT prove the injection failed — the agent may
    // have read message A, gone idle, and message B landed a moment later. What
    // it proves is weaker and sufficient: MAIL IS UNREAD WHILE THE AGENT IS
    // IDLE, THEREFORE A WAKE IS OWED. The stronger sentence would be a claim
    // ahead of its mechanism.
    //
    // DIRECTION OF ERROR, declared: rolling the mark back re-opens wakes for
    // everything since `markBeforeOutstanding`, not only the undelivered
    // message — so this OVER-WAKES rather than under-wakes. Safe direction, and
    // bounded by `outstanding`, which still permits only one injection in
    // flight. Pinned by test rather than asserted.
    //
    // THE SETTLE GRACE, and why it is not a fudge. An existing pinned test
    // asserts that an idle observation on a LANDED wake must NOT roll the mark
    // back — written to stop a rollback over-reaching into successful
    // deliveries. Taken literally against a still-pending inbox, that invariant
    // IS the stranding bug: it is codex-lumen's exact scenario. But the test is
    // also protecting something real — an idle read taken in the instant after a
    // submit can simply PREDATE the agent picking the wake up, and rolling back
    // on that reads a delivery-in-progress as a failure.
    //
    // Both hold once the two cases are separated by TIME rather than merged:
    // immediately-after-landing is a delivery in flight; still-pending a full
    // settle window later is mail that is owed a wake. So the rollback waits one
    // settle window. The pinned invariant keeps its meaning, the stranding is
    // fixed, and no existing guard was deleted to get there.
    //
    // ORDERING — DECIDE, THEN CALL EXACTLY ONE. `markLanded()` nulls BOTH the
    // rollback value (`markBeforeOutstanding`) AND the rollback guard
    // (`outstandingSince`). Land-then-reconsider therefore leaves `markLost()`
    // silently no-opping — a rollback that LOOKS like it ran and did nothing,
    // which is the more dangerous of the two failures. The branch below reads
    // its inputs before either mutator runs, and a fixture fails if it is ever
    // reordered.
    if (observed.state === "idle" && this.outstandingLanded) {
      const settled =
        this.landedAt === null ||
        now() - this.landedAt >= (this.opts.landedSettleMs ?? DEFAULT_LANDED_SETTLE_MS);
      // Is the newest message STILL the one we woke for? That is the whole
      // discriminator, and it is the only one the inbox resource can support:
      // it exposes pending_count and last_message_at (the NEWEST message) and
      // nothing per-message. So:
      //   newer mail exists  → last_message_at has moved past our mark; the
      //                        watermark will wake for it on its own merits.
      //   mark still newest  → the message we woke for is the newest AND mail
      //                        is pending, i.e. ours was never consumed.
      const ourMessageStillNewest =
        snapshot.last_message_at !== null && snapshot.last_message_at === this.lastWokenAt;

      if (snapshot.pending_count === 0) {
        // Inbox drained → the mail this wake was for is genuinely consumed.
        this.markLanded();
      } else if (!ourMessageStillNewest) {
        // Pending, but NEWER mail has arrived — our delivery is not implicated.
        // Clear the anti-stacking flag and KEEP the mark; decideWake wakes for
        // the newer message on its own timestamp. (Without this branch, newer
        // mail was blocked for the whole settle window — a regression this
        // formulation introduced and this branch removes.)
        this.markLanded();
      } else if (settled) {
        // Our message is still the newest and still pending, a full settle
        // window after the injection landed → a wake is owed. Roll back using
        // the SAME machinery known loss already uses. This is codex-lumen's
        // exact signature: lastWokenAt === newest, pending=1.
        this.markLost();
      }
      // else: ours, pending, not yet settled → HOLD. The idle read may simply
      // predate the agent acting on the wake.
    }

    // IDLE-EVIDENCE — but ONLY for a LANDED injection. The host submits queued
    // input at the turn boundary, so an idle agent cannot still hold an
    // injection that ACTUALLY SUBMITTED. An in-flight (scheduled-but-not-yet-
    // landed) inject is different: onWake only STARTS the async injection, so
    // an idle snapshot then is a stale read from before our keystroke, and
    // flushing it would let a second inject fire and re-stack (codex #126
    // round 2). Wait for the delivery ack (markInjectionLanded); a later idle
    // flushes it. A not-yet-landed wake stays suppressed via the outstanding
    // flag until it lands or fails.
    // TTL backstop for losses nothing can observe. An injection outstanding
    // past the TTL never resolved either way; treat it as a (very late) LOSS
    // so mail still pending re-wakes — clearing the flag alone would leave the
    // mark masking it forever.
    if (this.outstandingSince !== null) {
      const ttl = this.opts.outstandingTtlMs ?? DEFAULT_WAKE_OUTSTANDING_TTL_MS;
      if (now() - this.outstandingSince >= ttl) this.markLost();
    }
    const route = routeWake({
      pendingMail: snapshot.pending_count > 0,
      state: observed.state,
      busyCoveredByHook: observed.busyCoveredByHook,
      outstanding: this.outstandingSince !== null,
    });
    // Suppression never advances the watermark — it means "newest message we
    // WOKE for", and we didn't. The poll-tick re-route picks it up later.
    if (route.action === "suppress") {
      // The observation inputs are logged with the decision because the
      // decision is UNINTERPRETABLE without them: "an injection is already
      // outstanding" reads as benign until you can see that state is `unknown`,
      // which is what stops the flush that would have cleared it.
      this.reportDecline(
        agentName,
        route.reason,
        `state=${observed.state} hookCovered=${observed.busyCoveredByHook} ` +
        `outstanding=${this.outstandingSince !== null} landed=${this.outstandingLanded} pending=${snapshot.pending_count}`,
      );
      return false;
    }
    const decision = decideWake(snapshot, {
      autoInjectInbox,
      lastWokenAt: this.lastWokenAt,
    });
    // Hold the mark AS IT STANDS before this injection advances it, so LOSS
    // EVIDENCE (clearOutstanding / TTL) can roll it back — a wake that never
    // lands must not count as "woken for" (codex #126). In every decideWake
    // no-wake branch newMark === lastWokenAt, so this assignment is a no-op
    // there; it only advances on an actual wake.
    const markBeforeThisWake = this.lastWokenAt;
    this.lastWokenAt = decision.newMark;
    if (decision.shouldWake) {
      this.markBeforeOutstanding = markBeforeThisWake;
      this.outstandingSince = now();
      this.outstandingLanded = false; // scheduled, not yet landed — awaits the delivery ack
      this.resetDeclineMemo();
      this.onWake(agentName);
      return true;
    }
    // The SECOND silent path, and the one that made the morning's thirty
    // events indistinguishable: routing said inject, the watermark said no.
    // Naming which of the two declined is the whole point of #4a.
    this.reportDecline(
      agentName,
      !autoInjectInbox ? "auto-inject is disabled"
        : snapshot.last_message_at === null ? "no message timestamp to form a watermark"
        : "already woke for this newest message (watermark)",
      `lastWokenAt=${markBeforeThisWake ?? "none"} newest=${snapshot.last_message_at ?? "none"} pending=${snapshot.pending_count}`,
    );
    return false;
  }
}

/** One watched agent: its name, its inject toggle, its WakeGate, and whether it
 *  drives the shared status bar / toast (exactly one agent should — the
 *  primary — so the bar doesn't flap between agents). */
export interface InboxAgentSub {
  agentName: string;
  autoInjectInbox: boolean;
  wakeGate: WakeGate;
  primary: boolean;
}

export interface SubscribeInboxesDeps<S extends WakeInboxView> {
  /** A connected MCP client. */
  client: Client;
  /** The agents to watch (≥1). The first/primary drives the status bar. */
  agents: InboxAgentSub[];
  buildInboxUri: (agentName: string) => string;
  /** Read + parse an agent's current inbox snapshot (production: refreshSnapshot). */
  readSnapshot: (client: Client, agentName: string) => Promise<S | null>;
  /** Apply a snapshot to the shared status bar — called for the PRIMARY agent only. */
  applySnapshot: (snapshot: S) => void;
  /** Toast for a snapshot — called for the PRIMARY agent only. */
  showToast: (snapshot: S) => void;
  /** State-lock: when an async transport error has flipped the error UI, don't
   *  paint a success snapshot or wake over it. */
  isInErrorState: () => boolean;
  log: (line: string) => void;
  /** ADR-0010 wake routing: observe the agent's state + hook coverage at
   *  decision time. Optional — absent (tests, older callers) routes as
   *  unknown/uncovered, which preserves inject-with-idempotency. */
  observe?: (agentName: string) => Promise<WakeObservation>;
}

/**
 * Register ONE ResourceUpdated handler that dispatches by inbox URI to the
 * matching agent, subscribe to EACH agent's inbox, then prime each (apply the
 * primary's initial snapshot AND fire a per-agent catch-up wake for mail already
 * waiting — live notifications only cover mail arriving AFTER subscribe). Every
 * agent's live + catch-up wake routes through ITS OWN WakeGate (per-agent no-
 * double-wake).
 */
export async function subscribeInboxes<S extends WakeInboxView>(
  deps: SubscribeInboxesDeps<S>,
): Promise<void> {
  const { client, agents, buildInboxUri, readSnapshot, applySnapshot, showToast, isInErrorState, log } =
    deps;

  // uri → agent entry, so the single shared handler can route by notification uri.
  const byUri = new Map<string, InboxAgentSub>();
  for (const a of agents) byUri.set(buildInboxUri(a.agentName), a);

  client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
    const agent = byUri.get(notification.params.uri);
    if (!agent) return; // not one of ours
    log(`event: ${notification.params.uri}`);
    const fresh = await readSnapshot(client, agent.agentName);
    if (!fresh) return;
    if (isInErrorState()) return; // state-lock — don't paint snapshot over an error UI
    if (agent.primary) {
      applySnapshot(fresh);
      showToast(fresh);
    }
    const obs = deps.observe ? await deps.observe(agent.agentName) : undefined;
    agent.wakeGate.consider(fresh, agent.agentName, agent.autoInjectInbox, obs);
  });

  // Subscribe + prime each agent.
  for (const agent of agents) {
    await client.subscribeResource({ uri: buildInboxUri(agent.agentName) });
    const initial = await readSnapshot(client, agent.agentName);
    if (initial && !isInErrorState()) {
      if (agent.primary) applySnapshot(initial);
      const obs = deps.observe ? await deps.observe(agent.agentName) : undefined;
      agent.wakeGate.consider(initial, agent.agentName, agent.autoInjectInbox, obs);
    }
  }
}

export interface SubscribeInboxDeps<S extends WakeInboxView> {
  client: Client;
  agentName: string;
  autoInjectInbox: boolean;
  buildInboxUri: (agentName: string) => string;
  readSnapshot: (client: Client, agentName: string) => Promise<S | null>;
  applySnapshot: (snapshot: S) => void;
  showToast: (snapshot: S) => void;
  isInErrorState: () => boolean;
  wakeGate: WakeGate;
  log: (line: string) => void;
  observe?: (agentName: string) => Promise<WakeObservation>;
}

/**
 * Single-agent shim over subscribeInboxes — the back-compat path (legacy
 * `agentName` config) and what the integration test drives, so the tested code
 * path IS the shipped multi-agent one.
 */
export async function subscribeInbox<S extends WakeInboxView>(
  deps: SubscribeInboxDeps<S>,
): Promise<void> {
  await subscribeInboxes({
    client: deps.client,
    agents: [
      {
        agentName: deps.agentName,
        autoInjectInbox: deps.autoInjectInbox,
        wakeGate: deps.wakeGate,
        primary: true,
      },
    ],
    buildInboxUri: deps.buildInboxUri,
    readSnapshot: deps.readSnapshot,
    applySnapshot: deps.applySnapshot,
    showToast: deps.showToast,
    isInErrorState: deps.isInErrorState,
    log: deps.log,
    observe: deps.observe,
  });
}
