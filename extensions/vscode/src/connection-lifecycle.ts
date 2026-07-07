// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.4.1 — connection lifecycle guard (the auto-reconnect-on-daemon-restart seam).
 *
 * WHY THIS EXISTS. A clean daemon restart (`launchctl kickstart`, run after
 * every publish/update) ends Tether's SSE GET stream. The v0.2.1 reconnect
 * supervisor already recovers from a transport *error* (`onerror` →
 * `handleError` → fresh connect). But a clean restart often ends the stream
 * as a quiet EOF that the SDK surfaces via `onclose`, NOT `onerror` — and
 * pre-v0.4.1 `onclose` was log-only. So the supervisor never fired and Tether
 * wedged at "connected" (dead stream) until the operator ran "Tether:
 * Reconnect to Relay" by hand. That manual step is unacceptable for a shipped
 * product. v0.4.1 routes an *unexpected* close into the supervisor too.
 *
 * THE HARD PART — telling an UNEXPECTED close from an INTENTIONAL one. Two
 * discriminators, BOTH load-bearing (neither is sufficient alone):
 *
 *   (1) intentionalDisconnect flag. `connect()` tears down the OLD transport
 *       via `disconnect()` at its top; deactivate() tears the transport down
 *       on reload. Those closes are EXPECTED and must NOT trigger a reconnect.
 *       The flag is raised across such teardowns. Identity alone can't cover
 *       this: during `connect()`'s own `disconnect()`, the OLD transport is
 *       (momentarily) still the tracked transport, so an identity-only guard
 *       would wrongly honor its close.
 *
 *   (2) transport identity. A LATE close from a superseded transport (one a
 *       newer connect has already replaced) must be ignored even though the
 *       flag is down. The flag alone can't cover this: it is down during
 *       normal operation, so a stale transport's late close would be honored.
 *
 * THE MID-CONNECT RACE (load-bearing). The pre-v0.4.1 code bound the
 * new transport as "current" only AFTER `await client.connect(transport)`. So
 * a close DURING `client.connect()` — the daemon rejecting/closing the new
 * SSE mid-handshake — was NOT yet identity-matched and would be dropped,
 * re-wedging on the exact restart we are fixing. `establish()` closes this by
 * binding the new transport as the guard-accepted `connecting` transport
 * BEFORE wiring/connecting it, and resetting the intentional flag BEFORE the
 * connect await. A mid-connect close is then honored.
 *
 * VSCode-free by design. This module takes the transport as an opaque handle
 * (compared by reference) and plain callbacks, so its unit test drives the
 * REAL establish() ordering + guard decision — the code that ships, not a
 * proxy (the "test-path-must-match-shipped-path" discipline this codebase
 * uses for subscribeInboxes / decideWake / transport-diagnostics). extension.ts
 * is dumb wiring over it.
 */

/**
 * Dependencies for one `establish()` attempt. All three run against the SAME
 * freshly-built transport handle `t`:
 *   - `build`   creates the new transport (production: the StreamableHTTP
 *               transport factory).
 *   - `wire`    attaches diagnostics to `t`, INCLUDING an `onClose` that calls
 *               back into `shouldReconnectOnClose(t)` (production:
 *               wireTransportDiagnostics). Called AFTER `t` is bound as the
 *               connecting transport, so a close fired during/after wiring is
 *               already guard-accepted.
 *   - `connect` performs the actual `client.connect(t)` handshake. A close
 *               that arrives while this promise is pending is the mid-connect
 *               race — and is honored, because `t` is already the connecting
 *               transport.
 */
export interface EstablishDeps<T> {
  build: () => T;
  wire: (t: T) => void;
  connect: (t: T) => Promise<void>;
}

export class ConnectionLifecycle<T> {
  /** The transport of the live, fully-established connection. */
  private currentT: T | undefined;
  /** The transport currently being established (bound BEFORE connect). */
  private connectingT: T | undefined;
  /** Raised across an intentional teardown (disconnect/deactivate). */
  private intentional = false;

  /**
   * Raise the intentional-disconnect window. Call BEFORE an operator- or
   * teardown-initiated transport close (i.e. before `disconnect()` inside
   * `connect()`, and before the deactivate-time disconnect) so that close is
   * swallowed rather than treated as a drop. Also drops `currentT`: the
   * current transport is being torn down, so its close (even a late async one
   * that arrives after the flag is later reset by `establish`) must not be
   * honored.
   */
  beginIntentionalDisconnect(): void {
    this.intentional = true;
    this.currentT = undefined;
  }

  /**
   * Establish a new transport with the ordering that closes the mid-connect
   * race:
   *   1. build the transport;
   *   2. bind it as `connectingT` BEFORE connect (so a close during connect is
   *      guard-accepted);
   *   3. clear the intentional flag BEFORE wiring/connecting the NEW transport
   *      (so a genuine close on the new transport is honored — NOT masked by a
   *      flag left up from the preceding intentional disconnect);
   *   4. wire diagnostics, then run the connect handshake;
   *   5. on success, promote to `currentT` and clear `connectingT`;
   *   6. on failure, unbind `connectingT` (don't leave a dead transport
   *      guard-accepted) and rethrow to the caller / supervisor.
   */
  async establish(deps: EstablishDeps<T>): Promise<T> {
    const t = deps.build();
    this.connectingT = t; // (2) bind BEFORE connect
    this.intentional = false; // (3) reset BEFORE wiring/connecting the new transport
    try {
      deps.wire(t);
      await deps.connect(t); // (4) a close during this await → shouldReconnectOnClose(t) === true
    } catch (err) {
      if (this.connectingT === t) this.connectingT = undefined; // (6) cleanup
      throw err;
    }
    this.currentT = t; // (5) promote
    this.connectingT = undefined;
    return t;
  }

  /**
   * The guard decision for a transport `t` that just fired `onclose`. Returns
   * true iff the close is UNEXPECTED and should drive a reconnect:
   *   - intentional teardown in progress → false;
   *   - `t` is neither the current nor the connecting transport (superseded /
   *     stale) → false;
   *   - otherwise (the live transport, or the one mid-establish, dropped
   *     unexpectedly) → true.
   */
  shouldReconnectOnClose(t: T): boolean {
    if (this.intentional) return false;
    if (t !== this.currentT && t !== this.connectingT) return false;
    return true;
  }

  /**
   * Tear down all lifecycle state (deactivate / dispose). Leaves the flag
   * RAISED so any in-flight teardown close is swallowed, and forgets both
   * transports so no late close is ever honored after disposal.
   */
  reset(): void {
    this.intentional = true;
    this.currentT = undefined;
    this.connectingT = undefined;
  }

  /** Introspection (wiring/tests): the live transport, or undefined. */
  get currentTransport(): T | undefined {
    return this.currentT;
  }

  /** Introspection (tests): the transport mid-establish, or undefined. */
  get connectingTransport(): T | undefined {
    return this.connectingT;
  }
}
