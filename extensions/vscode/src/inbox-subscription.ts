// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.2.3 R1 — the inbox-subscription seam.
//
// Extracted from connect() so the SHIPPED subscribe→notify→wake path is
// exercisable without a VSCode host (codex R1: the v0.2.3 R0 integration test
// proved decideWake in isolation but never drove the real subscription wiring,
// so a regression in the handler would not have failed it — the v2.5 R0
// "test-path-must-match-shipped-path" trap). subscribeInbox + WakeGate are
// VSCode-free (they take the MCP Client + plain callbacks), so
// tests/tether-reliable-wake.test.ts runs the REAL handler against the real
// HTTP daemon with only the terminal keystroke (onWake) spied.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { decideWake, type WakeInboxView } from "./catch-up-wake.js";

/**
 * Owns the catch-up/live high-water mark (the newest-message timestamp we last
 * woke for) so the catch-up path and the live notification path never
 * double-wake each other. ONE instance is created at activate and reused across
 * every connect()/reconnect, so the mark survives reconnects (no re-wake with
 * no new mail). A window reload re-creates the instance → the mark resets →
 * still-pending mail re-wakes (A1, intended).
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

export interface SubscribeInboxDeps<S extends WakeInboxView> {
  /** A connected MCP client. */
  client: Client;
  agentName: string;
  autoInjectInbox: boolean;
  buildInboxUri: (agentName: string) => string;
  /** Read + parse the current inbox snapshot (production: refreshSnapshot). */
  readSnapshot: (client: Client, agentName: string) => Promise<S | null>;
  applySnapshot: (snapshot: S) => void;
  showToast: (snapshot: S) => void;
  /** State-lock: when an async transport error has flipped the error UI, don't
   *  paint a success snapshot or wake over it. */
  isInErrorState: () => boolean;
  wakeGate: WakeGate;
  log: (line: string) => void;
}

/**
 * Register the ResourceUpdated handler, subscribe to the agent's inbox, then
 * prime: apply the initial snapshot AND fire a catch-up wake if mail is already
 * waiting (live notifications only cover mail arriving AFTER subscribe). Both
 * the live handler and the catch-up route their wake through the SAME WakeGate,
 * which is the no-double-wake guarantee.
 */
export async function subscribeInbox<S extends WakeInboxView>(
  deps: SubscribeInboxDeps<S>,
): Promise<void> {
  const {
    client,
    agentName,
    autoInjectInbox,
    buildInboxUri,
    readSnapshot,
    applySnapshot,
    showToast,
    isInErrorState,
    wakeGate,
    log,
  } = deps;
  const wantUri = buildInboxUri(agentName);

  client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
    if (notification.params.uri !== wantUri) return;
    log(`event: ${notification.params.uri}`);
    const fresh = await readSnapshot(client, agentName);
    if (!fresh) return;
    if (isInErrorState()) return; // state-lock — don't paint snapshot over an error UI
    applySnapshot(fresh);
    showToast(fresh);
    wakeGate.consider(fresh, agentName, autoInjectInbox);
  });

  await client.subscribeResource({ uri: wantUri });

  // Prime: initial snapshot + catch-up wake for mail already waiting.
  const initial = await readSnapshot(client, agentName);
  if (initial && !isInErrorState()) {
    applySnapshot(initial);
    wakeGate.consider(initial, agentName, autoInjectInbox);
  }
}
