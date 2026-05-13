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
 *   For a long-running editor extension, 2 retries is far too
 *   aggressive — a transient TCP hiccup exhausts the budget in <2 s
 *   and the extension wedges silently. The smoke captured this:
 *     09:04:43 transport error: fetch failed
 *     09:04:44 transport error: fetch failed
 *     09:04:44 Maximum reconnection attempts (2) exceeded.
 *
 *   The constructor accepts a `reconnectionOptions` parameter that
 *   the extension MUST pass to override the default. v0.1.2 wires
 *   `maxRetries: 20` + exponential backoff (1s × 1.5^attempt, capped
 *   at 30s) for ~6.75 min of accumulated wait before giving up.
 *
 * COVERAGE:
 *   - drift-src: source-level scan asserts the constructor call
 *     includes `reconnectionOptions` with `maxRetries` set.
 *   - drift-out: compiled-artifact scan (the marketplace ships
 *     `out/extension.js`, not `src/extension.ts`).
 *   - error-text: extension surfaces the manual Reconnect command
 *     when retries exhaust (per Codex SCOPE-TIGHTEN: "operator-facing
 *     text/status to make manual reconnect discoverable").
 *
 * The `out/` scan only runs after `cd extensions/vscode && npm run
 * compile`. The pre-publish gate runs the extension's TS compile
 * step before vitest, so `out/extension.js` is fresh.
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
  it("(drift-src) extension.ts constructor passes reconnectionOptions with maxRetries", () => {
    expect(fs.existsSync(EXT_SRC), `missing ${EXT_SRC}`).toBe(true);
    const body = fs.readFileSync(EXT_SRC, "utf-8");

    // The constructor block must mention BOTH the options key and the
    // maxRetries field. A bare `new StreamableHTTPClientTransport(url,
    // { requestInit })` would silently fall back to maxRetries: 2 — the
    // exact regression that wedged the maintainer's Phase 3 smoke.
    expect(
      body,
      "extension.ts must pass `reconnectionOptions` to StreamableHTTPClientTransport — falling back to the SDK default of maxRetries: 2 wedges the extension on any transient hiccup. See node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:5-11.",
    ).toMatch(/reconnectionOptions\s*:/);

    expect(
      body,
      "extension.ts must explicitly set `maxRetries` in the reconnectionOptions block — without it the SDK still falls back to 2.",
    ).toMatch(/maxRetries\s*:\s*\d+/);

    // Pin a minimum-floor on maxRetries so a future edit can't drop it
    // back to a too-aggressive value (e.g. 3) without an explicit
    // intent. Read every numeric maxRetries literal in the file and
    // assert at least one is >= 10.
    const matches = Array.from(body.matchAll(/maxRetries\s*:\s*(\d+)/g));
    expect(matches.length, "expected at least one maxRetries literal").toBeGreaterThan(0);
    const maxValue = Math.max(...matches.map((m) => Number(m[1])));
    expect(
      maxValue,
      `the highest configured maxRetries in extension.ts must be >= 10. The Phase 4 fix locked in 20 to ride out daemon restarts + transient network issues. Saw max=${maxValue}.`,
    ).toBeGreaterThanOrEqual(10);
  });

  it("(drift-out) compiled out/extension.js (what ships in VSIX) preserves the reconnectionOptions wiring", () => {
    expect(
      fs.existsSync(EXT_OUT),
      `missing ${EXT_OUT} — run \`cd extensions/vscode && npm run compile\` first`,
    ).toBe(true);
    const body = fs.readFileSync(EXT_OUT, "utf-8");

    // tsc preserves the property keys, even after const-prop / minification.
    // We expect both identifiers to survive verbatim.
    expect(body).toMatch(/reconnectionOptions\s*:/);
    expect(body).toMatch(/maxRetries\s*:\s*\d+/);
    const matches = Array.from(body.matchAll(/maxRetries\s*:\s*(\d+)/g));
    const maxValue = Math.max(...matches.map((m) => Number(m[1])));
    expect(
      maxValue,
      `compiled artifact: maxRetries floor is the load-bearing check — the marketplace runs out/, not src/.`,
    ).toBeGreaterThanOrEqual(10);
  });

  it("(error-text) setErrorState references the manual Reconnect command (operator discoverability on retry exhaustion)", () => {
    const body = fs.readFileSync(EXT_SRC, "utf-8");
    // Per Codex SCOPE-TIGHTEN: when the SDK's maxRetries budget is
    // exhausted, the status bar should explicitly point at the
    // existing `botRelayTether.reconnect` command (palette label
    // "Tether: Reconnect to Relay") so the operator knows how to
    // recover. Match a substring of the command title rather than the
    // raw command id so future palette-label tweaks don't silently
    // pass the guard.
    expect(
      body,
      'setErrorState must surface a reference to the manual reconnect command (palette label "Tether: Reconnect to Relay") so operators know how to recover when the SDK\'s reconnection budget exhausts.',
    ).toMatch(/Reconnect to Relay/);
  });
});
