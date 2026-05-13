// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v0.1.3 [HIGH F10] drift guards — the Tether VSCode extension stores
 * the agent token in VSCode SecretStorage (OS keychain) instead of
 * plaintext `settings.json`.
 *
 * Bug class (pre-v0.1.3): the `bot-relay.tether.agentToken` setting
 * was a regular contributes.configuration string property, written to
 * plaintext `settings.json`. Every backup, settings sync, accidental
 * screenshot, and shoulder-glance leaked the token.
 *
 * Origin: Hermes deep-review surfaced via review-Victra synthesis
 * msg `2b903f9b`. v2.7.1 brief F10 locked Maxime's Option (full
 * SecretStorage migration with one-shot rotation notice).
 *
 * COVERAGE:
 *   - drift-pkg: extensions/vscode/package.json's
 *     contributes.configuration MUST NOT contain
 *     `bot-relay.tether.agentToken`. Adding it back would re-expose
 *     plaintext storage in the VSCode settings UI.
 *   - drift-pkg-cmd: a `botRelayTether.setToken` palette command MUST
 *     be advertised so operators have a discoverable way to set the
 *     secret (without it the migration-recommends-rotation flow has
 *     no operator-facing surface).
 *   - drift-src: extensions/vscode/src/extension.ts must reference
 *     `context.secrets` (the SecretStorage API). A future refactor
 *     that drops back to settings.json fails this guard loudly.
 *   - drift-out: same scan on the compiled
 *     extensions/vscode/out/extension.js artifact that ships in the
 *     VSIX. The marketplace runs `out/`, not `src/`.
 *   - migrate-fn-presence: the migration function MUST exist + be
 *     invoked from activate(). The contract is "first-launch
 *     migration runs automatically, not on a manual user action."
 *
 * Mirrors the drift-guard pattern from
 * tests/v2-6-tether-transport-diagnostics.test.ts +
 * tests/v2-7-tether-reconnection-options.test.ts. The out/ scan
 * requires `cd extensions/vscode && npm run compile` to have run;
 * the pre-publish gate's "extension TS compile + emit" step runs
 * it before vitest.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const EXT_PKG = path.join(REPO_ROOT, "extensions", "vscode", "package.json");
const EXT_SRC = path.join(REPO_ROOT, "extensions", "vscode", "src", "extension.ts");
const EXT_OUT = path.join(REPO_ROOT, "extensions", "vscode", "out", "extension.js");

describe("v0.1.3 [HIGH F10] — Tether SecretStorage migration drift guards", () => {
  it("(drift-pkg) extensions/vscode/package.json contributes.configuration does NOT expose bot-relay.tether.agentToken", () => {
    expect(fs.existsSync(EXT_PKG)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(EXT_PKG, "utf-8")) as {
      contributes?: { configuration?: { properties?: Record<string, unknown> } };
    };
    const props = pkg.contributes?.configuration?.properties ?? {};
    expect(
      "bot-relay.tether.agentToken" in props,
      "extensions/vscode/package.json must NOT contain `bot-relay.tether.agentToken` in contributes.configuration.properties — Hermes flagged this as plaintext storage. Use VSCode SecretStorage via the `botRelayTether.setToken` palette command instead.",
    ).toBe(false);
  });

  it("(drift-pkg-cmd) package.json advertises the botRelayTether.setToken palette command", () => {
    const pkg = JSON.parse(fs.readFileSync(EXT_PKG, "utf-8")) as {
      contributes?: { commands?: Array<{ command: string; title: string }> };
    };
    const commands = pkg.contributes?.commands ?? [];
    const setTokenCmd = commands.find((c) => c.command === "botRelayTether.setToken");
    expect(
      setTokenCmd,
      "extensions/vscode/package.json must advertise the `botRelayTether.setToken` palette command. Without it operators have no discoverable way to write the secret after the migration-recommends-rotation notice fires.",
    ).toBeTruthy();
    expect(setTokenCmd!.title).toMatch(/SecretStorage/i);
  });

  it("(drift-src) extension.ts uses context.secrets API (not workspace.getConfiguration for token reads)", () => {
    const body = fs.readFileSync(EXT_SRC, "utf-8");
    expect(
      body,
      "extensions/vscode/src/extension.ts must call `context.secrets.get(...)` — without it the v0.1.3 SecretStorage path isn't wired.",
    ).toMatch(/context\.secrets\.get\s*\(/);
    expect(
      body,
      "extensions/vscode/src/extension.ts must call `context.secrets.store(...)` — without it the migration + Set Token command can't persist the secret.",
    ).toMatch(/context\.secrets\.store\s*\(/);
    // The migration function must be invoked from activate() — not
    // gated behind a manual command. Hermes's contract is "first-launch
    // migration runs automatically."
    expect(
      body,
      "extension.ts must invoke `migrateAgentTokenToSecretStorage(context)` from activate() so first-launch migration runs without operator action.",
    ).toMatch(/await\s+migrateAgentTokenToSecretStorage\s*\(/);
    // Confirm the migration is wired BEFORE the first readConfig call
    // — order matters because readConfig pulls the secret value, and
    // migration writes it. We use line-order rather than program-
    // semantic analysis: the activate() function's migration call
    // must appear earlier in the file than the `const initial = await
    // readConfig(context)` first-launch invocation.
    const migrationIdx = body.indexOf("await migrateAgentTokenToSecretStorage");
    const firstReadIdx = body.indexOf("const initial = await readConfig(context)");
    expect(migrationIdx).toBeGreaterThan(0);
    expect(firstReadIdx).toBeGreaterThan(0);
    expect(
      migrationIdx,
      "migrateAgentTokenToSecretStorage(context) must be awaited BEFORE `const initial = await readConfig(context)` in activate() — order is load-bearing for the first-launch flow.",
    ).toBeLessThan(firstReadIdx);
  });

  it("(drift-out) compiled out/extension.js (what ships in VSIX) preserves SecretStorage wiring", () => {
    expect(
      fs.existsSync(EXT_OUT),
      `missing ${EXT_OUT} — run \`cd extensions/vscode && npm run compile\` first`,
    ).toBe(true);
    const body = fs.readFileSync(EXT_OUT, "utf-8");
    // tsc preserves method-call shape (`context.secrets.get(...)` →
    // `context.secrets.get(...)`); both reads and writes must survive.
    expect(body).toMatch(/secrets\.get\s*\(/);
    expect(body).toMatch(/secrets\.store\s*\(/);
    expect(body).toMatch(/migrateAgentTokenToSecretStorage/);
  });

  it("(drift-out-no-legacy) compiled out/extension.js does NOT advertise agentToken as a workspace configuration field", () => {
    // The package.json scan above is the source of truth; this is a
    // belt-and-suspenders check that the compiled JS hasn't dragged
    // along a hardcoded fallback to `cfg.get("agentToken")` as the
    // primary token source (the legacy fallback inside resolveTetherConfig
    // is permitted during the migration window, but `extension.ts` must
    // NOT directly read it — that's what config.ts encapsulates).
    expect(fs.existsSync(EXT_OUT)).toBe(true);
    const body = fs.readFileSync(EXT_OUT, "utf-8");
    // The string `bot-relay.tether.agentToken` should NOT appear as a
    // direct property reference in compiled extension.ts (the package
    // manifest property name). It is still permitted in the configuration
    // JSON schema if we ever re-add it — but it shouldn't surface in
    // out/extension.js.
    expect(body).not.toContain('"bot-relay.tether.agentToken"');
  });
});
