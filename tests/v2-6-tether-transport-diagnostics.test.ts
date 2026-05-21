// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.6.x / Tether v0.1.1 — order-aware drift guard for the SDK
 * `transport.onerror`/`onclose` wiring window.
 *
 * BUG CLASS this guards against (caught 2026-05-08 on the v0.1.0
 * marketplace smoke):
 *
 *   The SDK's StreamableHTTPClientTransport's SSE GET stream open
 *   (`_startOrAuthSse`) silently swallows errors via
 *   `.catch(err => this.onerror?.(err))` (`@modelcontextprotocol/sdk`
 *   `dist/esm/client/streamableHttp.js:374-376`). When `transport.onerror`
 *   is unset the optional-chain `?.()` is a no-op and the failure
 *   vanishes, leaving the operator with a stuck "connected + subscribed"
 *   status while no notifications can ever flow. Tether v0.1.0 shipped
 *   with no `onerror` wiring; the smoke caught this.
 *
 *   v0.1.1 wires `transport.onerror` + `transport.onclose` via the
 *   `wireTransportDiagnostics` helper, BEFORE `await client.connect()`.
 *   The SDK's `Protocol._connect` at
 *   `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:220-228`
 *   PRESERVES preexisting handlers and WRAPS them on connect, so wiring
 *   AFTER connect would replace the SDK's protocol-level wrapper and
 *   break error propagation through the protocol stack. The order
 *   constraint is the load-bearing property; this test pins it.
 *
 * COVERAGE:
 *   - drift-src: source-level scan of `extensions/vscode/src/extension.ts`
 *   - drift-out: compiled-artifact scan of `extensions/vscode/out/extension.js`
 *     (this is the file that ships in the VSIX — the marketplace runs
 *     `out/extension.js`, not `src/extension.ts`)
 *   - helper-presence: the helper module + its unit-test file both exist
 *
 * The `out/` scan only runs after `npm run build`. The pre-publish gate
 * already executes `extension TS compile` before this test fires, so
 * `out/extension.js` is fresh when the drift guard runs.
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
const HELPER_SRC = path.join(REPO_ROOT, "extensions", "vscode", "src", "transport-diagnostics.ts");
const HELPER_TEST = path.join(REPO_ROOT, "extensions", "vscode", "src", "transport-diagnostics.test.ts");

/**
 * Find the line number (1-indexed) of the first match of `pattern` in
 * the file body. Returns -1 if no match.
 */
function findLine(body: string, pattern: RegExp): number {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return -1;
}

describe("v2.6.x / Tether v0.1.1 — transport diagnostics drift guard", () => {
  it("(drift-src) extensions/vscode/src/extension.ts wires diagnostics BETWEEN transport-construction and client.connect", () => {
    expect(fs.existsSync(EXT_SRC), `missing ${EXT_SRC}`).toBe(true);
    const body = fs.readFileSync(EXT_SRC, "utf-8");

    // Find the 3 anchor lines.
    const newTransportLine = findLine(body, /new StreamableHTTPClientTransport\b/);
    const wireDiagLine = findLine(body, /\bwireTransportDiagnostics\s*\(/);
    const connectLine = findLine(body, /\bawait\s+client\.connect\s*\(\s*transport\s*\)/);

    expect(newTransportLine, "extension.ts must instantiate StreamableHTTPClientTransport").toBeGreaterThan(0);
    expect(wireDiagLine, "extension.ts must call wireTransportDiagnostics(transport, sinks)").toBeGreaterThan(0);
    expect(connectLine, "extension.ts must call client.connect(transport)").toBeGreaterThan(0);

    // ORDER constraint — the regression class this guard catches: someone
    // wiring diagnostics AFTER connect, which replaces the SDK's protocol
    // wrapper and breaks protocol-level error propagation.
    expect(
      newTransportLine,
      `wireTransportDiagnostics call (line ${wireDiagLine}) must come AFTER new StreamableHTTPClientTransport() (line ${newTransportLine}) in extension.ts`,
    ).toBeLessThan(wireDiagLine);
    expect(
      wireDiagLine,
      `wireTransportDiagnostics call (line ${wireDiagLine}) must come BEFORE client.connect() (line ${connectLine}) in extension.ts. Wiring after connect replaces the SDK's protocol-level onerror/onclose wrapper and breaks error propagation. See SDK protocol.js:220-228.`,
    ).toBeLessThan(connectLine);
  });

  it("(drift-out) extensions/vscode/out/extension.js (compiled artifact, what ships in VSIX) preserves the BEFORE-connect order", () => {
    expect(
      fs.existsSync(EXT_OUT),
      `missing ${EXT_OUT} — run \`cd extensions/vscode && npm run bundle\` first`,
    ).toBe(true);
    const body = fs.readFileSync(EXT_OUT, "utf-8");

    // v0.1.4 bundle-aware: pre-v0.1.4 this test used `findLine` against
    // tsc output where identifier names + line layout matched source.
    // Post-bundle the artifact is minified single-mega-line CJS with
    // some identifiers preserved by `keepNames: true` (function/class
    // names) and local vars renamed. Switch to byte-offset (`indexOf`)
    // ordering on the preserved anchors:
    //   - StreamableHTTPClientTransport — class name, preserved.
    //   - wireTransportDiagnostics      — function name, preserved.
    //   - `.connect(`                   — method invocation pattern,
    //     survives even when the local `client`/`transport` vars get
    //     mangled to `n`/`o`. Search AFTER wireDiagIdx so we hit the
    //     extension's call, not the SDK's superclass method definition
    //     that bundles ahead of it.
    const newTransportIdx = body.indexOf("StreamableHTTPClientTransport");
    const wireDiagIdx = body.indexOf("wireTransportDiagnostics");
    expect(newTransportIdx, "out/extension.js must reference StreamableHTTPClientTransport").toBeGreaterThan(-1);
    expect(wireDiagIdx, "out/extension.js must reference wireTransportDiagnostics").toBeGreaterThan(-1);
    const connectIdx = body.indexOf(".connect(", wireDiagIdx);
    expect(
      connectIdx,
      "out/extension.js must contain `.connect(` AFTER wireTransportDiagnostics (extension's call to client.connect(transport))",
    ).toBeGreaterThan(-1);

    expect(
      newTransportIdx,
      `compiled artifact: wireTransportDiagnostics (byte ${wireDiagIdx}) must come AFTER StreamableHTTPClientTransport (byte ${newTransportIdx})`,
    ).toBeLessThan(wireDiagIdx);
    expect(
      wireDiagIdx,
      `compiled artifact: wireTransportDiagnostics (byte ${wireDiagIdx}) must come BEFORE the extension's .connect( call (byte ${connectIdx}). The marketplace ships the BUNDLE — drift here means the runtime breaks even if src/ looks correct.`,
    ).toBeLessThan(connectIdx);
  });

  it("(helper-presence) the transport-diagnostics module + its unit test exist", () => {
    expect(fs.existsSync(HELPER_SRC), `missing ${HELPER_SRC}`).toBe(true);
    expect(fs.existsSync(HELPER_TEST), `missing ${HELPER_TEST}`).toBe(true);

    // Helper must export wireTransportDiagnostics.
    const helperBody = fs.readFileSync(HELPER_SRC, "utf-8");
    expect(helperBody).toMatch(/export function wireTransportDiagnostics\b/);

    // Unit test must reference the helper symbol it pins.
    const testBody = fs.readFileSync(HELPER_TEST, "utf-8");
    expect(testBody).toMatch(/wireTransportDiagnostics/);
  });

  it("(state-lock-presence) extension.ts gates success-flips on an error-state check (not just success-on-completion)", () => {
    // Pins the state-lock contract codex named: once setError fires, the
    // success log + status-bar mutation MUST NOT fire and overwrite the
    // error state. The lock is implemented in extension.ts; this test
    // verifies a guard exists. Without this, a late-arriving SSE failure
    // (after connect() returns) could flip to error briefly, then the
    // subscribe-success path would unconditionally overwrite back to
    // "connected + subscribed".
    const body = fs.readFileSync(EXT_SRC, "utf-8");
    expect(
      body,
      "extension.ts must reference an isInErrorState (or equivalent) check guarding the success log/status mutation. The state-lock prevents the success path from overwriting an async-set error state.",
    ).toMatch(/isInErrorState\s*\(/);
  });
});
