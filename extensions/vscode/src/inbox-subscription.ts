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

/**
 * Owns the catch-up/live high-water mark (the newest-message timestamp we last
 * woke for) so the catch-up path and the live notification path never
 * double-wake each other. ONE instance PER AGENT, created at activate/connect and
 * reused across reconnects so the mark survives reconnects (no re-wake with no
 * new mail). A window reload re-creates the instance → the mark resets → still-
 * pending mail re-wakes (A1, intended).
 */
export class WakeGate {
  private lastWokenAt: string | null = null;

  constructor(private readonly onWake: (agentName: string) => void) {}

  /**
   * Consider a snapshot for one wake. Returns whether it fired (handy for
   * tests/telemetry). Advances the mark exactly as decideWake dictates — a
   * same-timestamp tie fails safe to NO re-wake.
   */
  consider(snapshot: WakeInboxView, agentName: string, autoInjectInbox: boolean): boolean {
    const decision = decideWake(snapshot, {
      autoInjectInbox,
      lastWokenAt: this.lastWokenAt,
    });
    this.lastWokenAt = decision.newMark;
    if (decision.shouldWake) {
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
    agent.wakeGate.consider(fresh, agent.agentName, agent.autoInjectInbox);
  });

  // Subscribe + prime each agent.
  for (const agent of agents) {
    await client.subscribeResource({ uri: buildInboxUri(agent.agentName) });
    const initial = await readSnapshot(client, agent.agentName);
    if (initial && !isInErrorState()) {
      if (agent.primary) applySnapshot(initial);
      agent.wakeGate.consider(initial, agent.agentName, agent.autoInjectInbox);
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
  });
}
