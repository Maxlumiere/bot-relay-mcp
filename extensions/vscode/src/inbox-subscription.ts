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

  constructor(
    private readonly onWake: (agentName: string) => void,
    private readonly opts: { outstandingTtlMs?: number; now?: () => number } = {},
  ) {}

  /**
   * LOSS EVIDENCE: the terminal we injected into closed, the injection failed
   * to land, or the binding was invalidated. A decidable event — clear the
   * flag so the next mail event re-wakes immediately (no TTL wait).
   */
  clearOutstanding(): void {
    this.markLost();
  }

  /**
   * DELIVERY ACK: the async injection this gate fired actually LANDED —
   * adapter.wake resolved, so the keystroke was typed and submitted. Only now
   * is an idle observation valid FLUSH evidence for it; before this, idle is a
   * stale read from the in-flight window and must not flush the wake (codex
   * #126 round 2). The caller MUST epoch-guard this so a stale ack from a
   * superseded injection can't mark a newer one landed. No-op if nothing is
   * outstanding (a lost/flushed injection already cleared the flag).
   */
  markInjectionLanded(): void {
    if (this.outstandingSince !== null) this.outstandingLanded = true;
  }

  /**
   * FLUSH EVIDENCE: a LANDED injection was consumed — the host submitted the
   * queued input at the turn boundary and drained it. Clear the outstanding
   * flag; the mark STAYS advanced because we genuinely woke for that mail (no
   * re-wake of the same message).
   */
  private markLanded(): void {
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
    // IDLE-EVIDENCE — but ONLY for a LANDED injection. The host submits queued
    // input at the turn boundary, so an idle agent cannot still hold an
    // injection that ACTUALLY SUBMITTED. An in-flight (scheduled-but-not-yet-
    // landed) inject is different: onWake only STARTS the async injection, so
    // an idle snapshot then is a stale read from before our keystroke, and
    // flushing it would let a second inject fire and re-stack (codex #126
    // round 2). Wait for the delivery ack (markInjectionLanded); a later idle
    // flushes it. A not-yet-landed wake stays suppressed via the outstanding
    // flag until it lands or fails.
    if (observed.state === "idle" && this.outstandingLanded) this.markLanded();
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
    if (route.action === "suppress") return false;
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
      this.onWake(agentName);
      return true;
    }
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
