// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.1.1 — Transport diagnostics helper.
 *
 * Wires `onerror` + `onclose` callbacks on the MCP transport so failures in
 * the SSE GET stream open path (`_startOrAuthSse` inside the SDK's
 * StreamableHTTPClientTransport) surface to the operator instead of being
 * silently swallowed by `.catch(err => this.onerror?.(err))`.
 *
 * Pre-v0.1.1 the extension never set `transport.onerror`. The SDK's
 * silent-failure window meant the SSE GET stream could fail to open inside
 * VS Code's Electron-based fetch runtime and leave the extension in a
 * "connected + subscribed" state that never receives notifications. The
 * v0.1.0 marketplace smoke caught this; root-cause investigation traced
 * it, and an audit confirmed the daemon-side broadcast contract is intact
 * and the fix lives extension-side.
 *
 * CRITICAL ORDERING — `wireTransportDiagnostics` MUST be called BEFORE
 * `await client.connect(transport)`. The SDK's `Protocol._connect`
 * implementation at `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:220-228`
 * preserves any preexisting `transport.onerror`/`onclose` and WRAPS them
 * during connect. Wiring AFTER connect replaces the SDK's wrapper and
 * breaks protocol-level error propagation. The order-aware drift guard in
 * `tests/v2-6-tether-transport-onerror-pre-connect.test.ts` enforces
 * this at gate time on both `src/` (source) and `out/` (compiled
 * artifact, which is what ships in the VSIX).
 *
 * VSCode-free by design — accepts abstract `TransportLike` + `DiagnosticsSinks`
 * so the unit tests in `transport-diagnostics.test.ts` can run without
 * dragging in the VSCode test stub. The actual `OutputChannel.appendLine`
 * + `StatusBarItem` mutations stay in the caller (`extension.ts`); this
 * module is dumb wiring.
 *
 * State-lock design — this helper does NOT itself enforce the
 * "error state must stick" property. The caller's sinks must implement
 * the lock: `setError` flips a state flag the caller checks before any
 * subsequent success-flip. See `extension.ts:connect()` for the
 * production state-lock implementation, and the helper's unit test for
 * a fake-sinks demonstration.
 */

/**
 * The minimal transport surface we wire diagnostics into. Matches the
 * `Transport` interface from `@modelcontextprotocol/sdk` but typed as a
 * structural subset so this module doesn't import the SDK (keeps the
 * unit test free of SDK transitive dep weight).
 */
export interface TransportLike {
  onerror?: (err: Error) => void;
  onclose?: () => void;
}

/**
 * Sinks the helper calls into. The caller wires real VSCode primitives
 * (output channel, status bar) behind these abstract callbacks; tests
 * wire fake collectors.
 */
export interface DiagnosticsSinks {
  /** Append a diagnostic line to the output channel (or test buffer). */
  log: (line: string) => void;
  /**
   * Flip the connection into a sticky error state with the given text.
   * Implementations should also update operator-visible UI (status bar
   * background color, etc.) and arm the "isInErrorState" check below.
   */
  setError: (msg: string) => void;
}

/**
 * Wire `onerror` + `onclose` on `transport`. Call BEFORE `client.connect()`
 * (see CRITICAL ORDERING in the module docstring). Idempotent: calling
 * twice on the same transport replaces the prior handlers — the caller
 * is responsible for not stacking multiple `connect()` flows on a single
 * transport (the existing `disconnect()` pattern in extension.ts handles
 * this).
 */
export function wireTransportDiagnostics(
  transport: TransportLike,
  sinks: DiagnosticsSinks,
): void {
  transport.onerror = (err: Error) => {
    const msg = err?.message ?? String(err);
    sinks.setError(`transport error: ${msg}`);
  };
  transport.onclose = () => {
    // Closures are not always errors (operator-initiated disconnect, normal
    // session teardown on extension reload, etc.) so this only logs — does
    // NOT flip to error state. The caller may downgrade to error if the
    // close arrives at a time it shouldn't (e.g. mid-subscribe), via
    // setError on its own logic.
    sinks.log("transport closed");
  };
}
