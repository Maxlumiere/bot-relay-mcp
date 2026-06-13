// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.7 Tether Phase 4 — drift guard for the SDK reconnectionOptions
 * wiring on the extension's StreamableHTTPClientTransport.
 *
 * BUG CLASS this guards against (caught 2026-05-11 on the post-Phase-3
 * smoke):
 *
 *   The SDK's StreamableHTTPClientTransport hardcodes
 *   `maxRetries: 2` in DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS
 *   (`node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:5-11`).
 *   A bare `new StreamableHTTPClientTransport(url, { requestInit })`
 *   silently falls back to that default; the smoke captured the wedge:
 *     09:04:43 transport error: fetch failed
 *     09:04:44 transport error: fetch failed
 *     09:04:44 Maximum reconnection attempts (2) exceeded.
 *   So the constructor MUST pass an explicit `reconnectionOptions` with
 *   a `maxRetries` field — that part of the contract is unchanged.
 *
 * v0.2.1 SUPERSEDES the old `maxRetries >= 10` floor.
 *   Phase 4 originally locked `maxRetries: 20` because the SDK's
 *   same-session retry loop was the ONLY reconnection mechanism, so the
 *   budget had to be large enough to ride out a daemon restart. v0.2.1
 *   introduces `ReconnectSupervisor` (extensions/vscode/src/reconnect-supervisor.ts),
 *   which OWNS daemon-restart recovery: on a recoverable transport error
 *   it performs a FRESH initialize (new session id) + re-subscribe with
 *   INDEFINITE capped backoff, firing on the first 404 — at/before the
 *   SDK's give-up. Consequences:
 *     1. Retrying the SAME (now-dead) session after a restart is futile
 *        — those 20 retries were pure dead time. The SDK budget is now
 *        deliberately SMALL (3): just enough to absorb a true transient
 *        blip where the session is still valid server-side.
 *     2. The original "silent wedge" is now IMPOSSIBLE regardless of the
 *        SDK budget, because the supervisor always re-arms — so the >= 10
 *        floor no longer protects anything; the load-bearing invariant is
 *        instead "the supervisor is wired".
 *   Hence this guard now asserts (a) reconnectionOptions+maxRetries are
 *   still explicitly set (the bare-constructor regression), and (b) the
 *   extension wires ReconnectSupervisor (the v0.2.1 recovery owner). The
 *   numeric floor is removed.
 *
 * COVERAGE:
 *   - drift-src: source scan — reconnectionOptions + maxRetries present,
 *     and `new ReconnectSupervisor(` wired.
 *   - drift-out: compiled-artifact scan (the marketplace ships
 *     `out/extension.js`, not `src/extension.ts`) — same wiring + the
 *     auto-reconnect status path survives bundling.
 *   - error-text: extension surfaces the manual Reconnect command for
 *     the unrecoverable (bad-token) path.
 *
 * The `out/` scan only runs after `cd extensions/vscode && npm run
 * compile` (or `npm run bundle`). The pre-publish gate builds the
 * extension artifact before vitest, so `out/extension.js` is fresh.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const EXT_SRC = path.join(REPO_ROOT, "extensions", "vscode", "src", "extension.ts");
const EXT_OUT = path.join(REPO_ROOT, "extensions", "vscode", "out", "extension.js");

describe("v2.7 Tether Phase 4 — reconnectionOptions drift guard", () => {
  it("(drift-src) extension.ts passes reconnectionOptions+maxRetries AND wires the ReconnectSupervisor", () => {
    expect(fs.existsSync(EXT_SRC), `missing ${EXT_SRC}`).toBe(true);
    const body = fs.readFileSync(EXT_SRC, "utf-8");

    // Unchanged contract: an explicit reconnectionOptions block with a
    // maxRetries field. A bare `new StreamableHTTPClientTransport(url,
    // { requestInit })` would silently fall back to the SDK default of
    // maxRetries: 2 — the exact regression that wedged the maintainer's Phase 3
    // smoke. (The VALUE is now intentionally small — see module docstring
    // — so we only assert presence, not a floor.)
    expect(
      body,
      "extension.ts must pass `reconnectionOptions` to StreamableHTTPClientTransport — omitting it falls back to the SDK default of maxRetries: 2. See node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:5-11.",
    ).toMatch(/reconnectionOptions\s*:/);
    expect(
      body,
      "extension.ts must explicitly set `maxRetries` in the reconnectionOptions block — without it the SDK still falls back to 2.",
    ).toMatch(/maxRetries\s*:\s*\d+/);

    // v0.2.1 load-bearing invariant (replaces the old maxRetries >= 10
    // floor): daemon-restart recovery is owned by ReconnectSupervisor,
    // which re-arms indefinitely. If a future edit removes the supervisor
    // wiring, the extension regresses to the permanent-wedge bug — THAT
    // is the regression this now guards.
    expect(
      body,
      "extension.ts must wire `new ReconnectSupervisor(...)` — it owns daemon-restart auto-reconnect (indefinite backoff). Without it the extension wedges at the manual-Reconnect dead-end after a daemon restart (the v0.2.1 P1 bug).",
    ).toMatch(/new\s+ReconnectSupervisor\s*\(/);
  });

  it("(drift-out) compiled out/extension.js (what ships in VSIX) preserves the wiring + auto-reconnect path", () => {
    expect(
      fs.existsSync(EXT_OUT),
      `missing ${EXT_OUT} — run \`cd extensions/vscode && npm run compile\` (or npm run bundle) first`,
    ).toBe(true);
    const body = fs.readFileSync(EXT_OUT, "utf-8");

    // The bundler preserves these property keys + string literals even
    // after const-prop / minification, so they are robust shipped-artifact
    // markers (identifier names like the class could be mangled; the
    // user-facing "reconnecting" status string cannot).
    expect(body).toMatch(/reconnectionOptions\s*:/);
    expect(body).toMatch(/maxRetries\s*:\s*\d+/);
    expect(
      body,
      "compiled artifact must contain the auto-reconnect status path — the marketplace runs out/, not src/. The supervisor's `Tether: reconnecting…` status is the shipped evidence that v0.2.1 recovery survived bundling.",
    ).toMatch(/reconnecting/i);
  });

  it("(handoff) the transport-error sink ROUTES to reconnectSupervisor.handleError — not the v0.2.0 setErrorState dead-end", () => {
    // R3 (codex assert-the-contract catch): supervisor CONSTRUCTION alone is
    // not the load-bearing invariant — the wireTransportDiagnostics `setError`
    // sink must HAND transport errors to `reconnectSupervisor.handleError(...)`.
    // If that sink reverts to `setErrorState` (the v0.2.0 RC-2 dead-end) while
    // the constructor stays intact, auto-reconnect never fires and the
    // extension wedges after a daemon restart — yet the (drift-src) construction
    // check would still pass. This ties the `setError:` key to the handoff so a
    // sink-only revert is caught. NEGATIVE-CONTROL: reverting the sink to
    // `setError: setErrorState` (constructor intact) makes THIS assertion fail
    // (verified 2026-06-12: guard goes red on codex's exact mutation, green when
    // restored; out/extension.js sha256 restored to the T-ACC'd VSIX build).
    const src = fs.readFileSync(EXT_SRC, "utf-8");
    expect(
      src,
      "the wireTransportDiagnostics `setError` sink must route to reconnectSupervisor.handleError(...) — reverting it to setErrorState reintroduces the RC-2 permanent-wedge (no auto-reconnect on daemon restart).",
    ).toMatch(/setError\s*:[\s\S]{0,240}reconnectSupervisor\.handleError\s*\(/);

    // Shipped-artifact marker: the supervisor handoff code path survives into
    // out/ (the marketplace runs out/, not src/).
    const out = fs.readFileSync(EXT_OUT, "utf-8");
    expect(
      out,
      "compiled out/extension.js must contain the `.handleError(` handoff — the marketplace runs out/, not src/.",
    ).toMatch(/\.handleError\s*\(/);
  });

  it("(error-text) setErrorState references the manual Reconnect command (operator discoverability on the unrecoverable path)", () => {
    const body = fs.readFileSync(EXT_SRC, "utf-8");
    // For the UNRECOVERABLE path (e.g. a bad/expired token, which the
    // supervisor deliberately does NOT auto-retry), the status bar should
    // explicitly point at the `botRelayTether.reconnect` command (palette
    // label "Tether: Reconnect to Relay") so the operator knows how to
    // recover. Match a substring of the command title rather than the raw
    // command id so future palette-label tweaks don't silently pass.
    expect(
      body,
      'setErrorState must surface a reference to the manual reconnect command (palette label "Tether: Reconnect to Relay") so operators know how to recover on the unrecoverable (bad-token) path.',
    ).toMatch(/Reconnect to Relay/);
  });
});
