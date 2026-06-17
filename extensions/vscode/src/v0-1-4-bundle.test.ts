// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.1.4 — bundle-correctness drift guard.
 *
 * Asserts properties of the SHIPPED out/extension.js bundle so a future
 * dependency update can't silently re-introduce un-bundled runtime
 * requires (which would break the extension since v0.1.4 ships with no
 * node_modules in the VSIX).
 *
 * Discipline:
 *   - `feedback_test_path_must_match_shipped_path.md`: assertions are
 *     against out/extension.js + out/extension.meta.json — the actual
 *     artifacts that go into the VSIX. Tests run after `npm run bundle`,
 *     not against source.
 *   - `feedback_test_asserts_contract_not_proxy.md`: the contract is
 *     "the bundle has no un-bundled runtime require beyond a safe
 *     allowlist". We parse the metafile esbuild emits (machine-readable
 *     ground truth for esbuild's bundling decisions) rather than
 *     greping the minified bundle text (which would match string-literal
 *     occurrences of `require("...")` like ajv's standalone-code
 *     metadata — see v0.1.4 changelog for the false-positive class).
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_ROOT = path.resolve(__dirname, "..");
const BUNDLE = path.join(EXT_ROOT, "out/extension.js");
const BUNDLE_MAP = path.join(EXT_ROOT, "out/extension.js.map");
const META = path.join(EXT_ROOT, "out/extension.meta.json");

// Hard ceiling on bundle size. Pre-v0.1.4 VSIX was 2.84 MB / 2004 files
// — the bundle itself was zero bytes (no bundling happened). Post-v0.1.4
// the bundle replaces node_modules in the VSIX. 800 KB is a generous
// ceiling that flags accidental future bloat (e.g. an extra
// 10-MB transitive dep) without tripping on minor version bumps of the
// existing dep tree. Adjust UP only with a CHANGELOG entry and a
// rationale; never silently raise.
const BUNDLE_SIZE_MAX_BYTES = 800 * 1024;

// External imports we accept at runtime. `vscode` is provided by the
// VSCode extension host. Anything starting with `node:` is a Node.js
// built-in available in the Electron runtime. NOT in this list means:
// must be bundled OR explicitly added to the allowlist with a
// CHANGELOG entry.
const ALLOWED_RUNTIME_EXTERNALS = new Set<string>([
  "vscode",
]);

function isNodeBuiltin(name: string): boolean {
  return name.startsWith("node:");
}

// The esbuild metafile encodes "external: <runtime>" for esbuild's
// own internal helpers — those are inlined into the bundle, not real
// runtime requires. Filter them out before assertion.
function isEsbuildRuntime(name: string): boolean {
  return name === "<runtime>";
}

describe("v0.1.4 — bundle correctness", () => {
  beforeAll(() => {
    if (!fs.existsSync(BUNDLE)) {
      throw new Error(
        `Bundle missing at ${BUNDLE}. Run 'npm run bundle' before tests.`,
      );
    }
    if (!fs.existsSync(META)) {
      throw new Error(
        `Metafile missing at ${META}. esbuild.config.mjs should write it.`,
      );
    }
  });

  it("(B1) bundle exists at out/extension.js with non-trivial size", () => {
    const stat = fs.statSync(BUNDLE);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(50_000); // sanity floor — empty bundle would slip past elsewhere
  });

  it("(B2) bundle size is under the regression ceiling (800 KB)", () => {
    const stat = fs.statSync(BUNDLE);
    expect(
      stat.size,
      `bundle size ${stat.size} exceeds ceiling ${BUNDLE_SIZE_MAX_BYTES}. Either reduce deps or raise the ceiling with a CHANGELOG note.`,
    ).toBeLessThan(BUNDLE_SIZE_MAX_BYTES);
  });

  it("(B3) source map is shipped alongside the bundle (Q1=YES)", () => {
    expect(fs.existsSync(BUNDLE_MAP), "out/extension.js.map missing").toBe(true);
    const stat = fs.statSync(BUNDLE_MAP);
    expect(stat.size).toBeGreaterThan(10_000);
  });

  it("(B4) bundle's runtime externals are only in the allowlist (vscode + node:* built-ins)", () => {
    const meta = JSON.parse(fs.readFileSync(META, "utf-8"));
    const externals = new Set<string>();
    for (const input of Object.values<{ imports?: { path: string; external?: boolean }[] }>(
      meta.inputs,
    )) {
      if (!input.imports) continue;
      for (const imp of input.imports) {
        if (!imp.external) continue;
        if (isEsbuildRuntime(imp.path)) continue;
        externals.add(imp.path);
      }
    }
    const unexpected = [...externals].filter(
      (e) => !ALLOWED_RUNTIME_EXTERNALS.has(e) && !isNodeBuiltin(e),
    );
    expect(
      unexpected,
      `unexpected runtime externals: ${JSON.stringify(unexpected)}. Either add to ALLOWED_RUNTIME_EXTERNALS (with CHANGELOG entry + rationale) or fix the bundle so the dep is inlined.`,
    ).toEqual([]);
    // Positive assertion: `vscode` IS external (would be wrong to bundle it).
    expect(externals.has("vscode"), "vscode must be marked external — the VSCode host provides it").toBe(true);
  });

  it("(B5) MCP SDK is inlined — paths under node_modules/@modelcontextprotocol/sdk appear as bundled inputs", () => {
    const meta = JSON.parse(fs.readFileSync(META, "utf-8"));
    const sdkInputs = Object.keys(meta.inputs).filter((p) =>
      p.includes("@modelcontextprotocol/sdk"),
    );
    expect(
      sdkInputs.length,
      "MCP SDK has no inputs in metafile — bundle did not inline the SDK",
    ).toBeGreaterThan(0);
  });

  it("(B6) extension source modules all appear as bundle inputs (no dead-code surprise)", () => {
    const meta = JSON.parse(fs.readFileSync(META, "utf-8"));
    const srcInputs = Object.keys(meta.inputs).filter((p) =>
      p.startsWith("src/") && p.endsWith(".ts") && !p.endsWith(".test.ts"),
    );
    // v0.2 additions: agent-manager.ts + restart-policy.ts joined the
    // bundle when AgentManager wired into extension.ts. v0.2.1 added
    // reconnect-supervisor.ts (wired into connect()/activate for P1
    // auto-reconnect). v0.2.2 added terminal-targeting.ts (deterministic
    // inbox-wake matcher, imported by extension.ts + agent-manager.ts). v0.2.3
    // added catch-up-wake.ts (shared catch-up/live wake decision) +
    // switch-agent.ts (discover_agents → Switch-Agent QuickPick parse), both
    // imported by extension.ts. v0.1.4 baseline (extension + config + format +
    // transport-diagnostics) preserved.
    expect(srcInputs.sort()).toEqual([
      "src/agent-manager.ts",
      "src/catch-up-wake.ts",
      "src/config.ts",
      "src/extension.ts",
      "src/format.ts",
      "src/inbox-subscription.ts",
      "src/reconnect-supervisor.ts",
      "src/restart-policy.ts",
      "src/switch-agent.ts",
      "src/terminal-targeting.ts",
      "src/transport-diagnostics.ts",
    ]);
  });

  // Shared helper for B7 + B8: monkey-patches Module._load to mock
  // `vscode`, busts the require cache for the bundle, returns the
  // loaded module's exports + a restore() callback the caller MUST
  // invoke in a finally block.
  //
  // Why require() instead of vm.runInContext: the MCP SDK pulls in
  // pkce-challenge which has `import("node:crypto")` for the Node-vs-
  // browser switch. vm.runInContext with dynamic imports requires
  // --experimental-vm-modules + a callback flag we can't count on
  // across Node versions. require() handles dynamic imports natively
  // because the loaded module's import() is just Node's own.
  async function loadBundleWithMockedVscode(vscodeMock: unknown): Promise<{
    loaded: Record<string, unknown>;
    restore: () => void;
  }> {
    const { createRequire } = await import("node:module");
    const Module = (await import("node:module")).default as {
      _resolveFilename: (req: string, parent: unknown) => string;
      _load: (req: string, parent: unknown, isMain: boolean) => unknown;
    };
    const origResolve = Module._resolveFilename;
    const origLoad = Module._load;
    Module._resolveFilename = function patchedResolve(
      request: string,
      parent: unknown,
    ): string {
      if (request === "vscode") return "vscode";
      return origResolve.call(this, request, parent);
    };
    Module._load = function patchedLoad(
      request: string,
      parent: unknown,
      isMain: boolean,
    ): unknown {
      if (request === "vscode") return vscodeMock;
      return origLoad.call(this, request, parent, isMain);
    };
    const reqLocal = createRequire(__filename);
    const resolved = reqLocal.resolve(BUNDLE);
    // Bust the require cache so re-runs (watch mode) re-evaluate.
    delete (reqLocal as unknown as { cache: Record<string, unknown> }).cache?.[resolved];
    const loaded = reqLocal(BUNDLE) as Record<string, unknown>;
    return {
      loaded,
      restore: () => {
        Module._resolveFilename = origResolve;
        Module._load = origLoad;
      },
    };
  }

  it("(B7) bundle is CJS and exports activate/deactivate when loaded via require()", async () => {
    const body = fs.readFileSync(BUNDLE, "utf-8");
    // CJS bundles start with "use strict". Top-level ESM `export` would
    // surface here as a bundle-config error.
    expect(body.startsWith('"use strict"')).toBe(true);

    // Minimal vscode mock — B7 does not invoke activate, so a Proxy
    // satisfies any top-level `vscode.X` lookups that occur during
    // module-eval (there are none in the current bundle, but the
    // Proxy is future-proof).
    const vscodeMock: unknown = new Proxy(
      {},
      {
        get: () =>
          new Proxy(() => undefined, {
            get: () => undefined,
          }),
      },
    );
    const { loaded, restore } = await loadBundleWithMockedVscode(vscodeMock);
    try {
      expect(typeof loaded.activate, "bundle does not export activate()").toBe("function");
      expect(typeof loaded.deactivate, "bundle does not export deactivate()").toBe("function");
    } finally {
      restore();
    }
  });

  // (B8) — codex-5-5 R0 P2 finding closure. B7 proves require/export
  // shape but never CALLS activate, so a bundle that exports an
  // activate function which throws immediately on call would still
  // pass B7. B8 actually invokes `await loaded.activate(mockContext)`
  // with a no-agent config so the activation reaches the idle path
  // without dialing :3777. Asserts:
  //   - activate completes without throwing
  //   - statusBarItem.text mutates to "Tether: idle" (the verified
  //     observable that connect() took the early-return idle branch
  //     at src/extension.ts:381-390)
  //   - mockContext.subscriptions has entries registered (outputChannel,
  //     statusBarItem, command registrations, config-change listener)
  // Per codex's preference: automated idle-activation call instead of
  // "rename B7 honestly + manual smoke" (manual VSCode smoke is
  // DEFERRED-USER already).
  it("(B8) bundled activate() reaches the idle path without throwing when no agentName is configured", async () => {
    // Structured vscode mock — needs to satisfy real activate() shape:
    //   - window.createOutputChannel returning { appendLine, dispose, ... }
    //   - window.createStatusBarItem returning a mutable item with
    //     text/command/backgroundColor/show/hide/dispose
    //   - commands.registerCommand returning a disposable
    //   - workspace.onDidChangeConfiguration returning a disposable
    //   - workspace.getConfiguration("bot-relay.tether").get(key) →
    //     undefined for everything (so config.agentName resolves "")
    //   - window.show{Information,Warning,Error}Message → no-op
    interface MockStatusBarItem {
      text: string;
      command?: string;
      backgroundColor?: unknown;
      show: () => void;
      hide: () => void;
      dispose: () => void;
    }
    const statusBars: MockStatusBarItem[] = [];
    const outputLines: string[] = [];
    const registeredCommands: string[] = [];

    const vscodeMock = {
      StatusBarAlignment: { Left: 1, Right: 2 },
      ViewColumn: { Beside: -2, Active: -1, One: 1 },
      window: {
        createOutputChannel: (_name: string) => ({
          name: _name,
          appendLine: (s: string) => {
            outputLines.push(s);
          },
          append: (_s: string) => {},
          show: () => {},
          hide: () => {},
          dispose: () => {},
          replace: () => {},
          clear: () => {},
        }),
        createStatusBarItem: (_align: number, _prio: number) => {
          const item: MockStatusBarItem = {
            text: "",
            show: () => {},
            hide: () => {},
            dispose: () => {},
          };
          statusBars.push(item);
          return item;
        },
        showInformationMessage: () => Promise.resolve(undefined),
        showWarningMessage: () => Promise.resolve(undefined),
        showErrorMessage: () => Promise.resolve(undefined),
        showInputBox: () => Promise.resolve(undefined),
        // v0.2 — AgentManager wiring needs terminal API surface even
        // on the idle path (the manager is constructed at activate
        // time and registers an onDidCloseTerminal listener).
        createTerminal: (_opts: unknown) => ({
          show: () => {},
          sendText: () => {},
          dispose: () => {},
          exitStatus: undefined,
        }),
        onDidCloseTerminal: (_cb: (...args: unknown[]) => unknown) => ({
          dispose: () => {},
        }),
        terminals: [],
        activeTerminal: undefined,
        createWebviewPanel: () => ({
          webview: { html: "" },
          dispose: () => {},
          reveal: () => {},
          onDidDispose: () => ({ dispose: () => {} }),
        }),
      },
      commands: {
        registerCommand: (name: string, _fn: (...args: unknown[]) => unknown) => {
          registeredCommands.push(name);
          return { dispose: () => {} };
        },
      },
      workspace: {
        getConfiguration: (_section?: string) => ({
          // Returns undefined for every key — `resolveTetherConfig`
          // then sees no agentName, no endpoint override, etc., and
          // `connect()` falls through to the idle early-return.
          get: (_key: string) => undefined,
          // Used by the SecretStorage migration when removing the
          // legacy plaintext field. No legacy here → never invoked
          // along the happy path, but stubbed for safety.
          update: () => Promise.resolve(),
          has: (_key: string) => false,
          inspect: () => undefined,
        }),
        onDidChangeConfiguration: (_fn: (...args: unknown[]) => unknown) => ({
          dispose: () => {},
        }),
      },
      Uri: { parse: (s: string) => ({ toString: () => s }) },
      env: { uriScheme: "vscode" },
      version: "1.85.0",
    };

    // Minimal ExtensionContext. The activation path touches:
    //   - subscriptions (push for each disposable)
    //   - secrets.get/store/delete (token resolution + migration)
    //   - globalState.get/update (one-shot migration flag + secret-
    //     storage-unavailable banner flag)
    // Empty values for everything → activate stays on the idle path.
    const subscriptions: unknown[] = [];
    const secretsStore: Record<string, string> = {};
    const globalStateStore: Record<string, unknown> = {};
    const mockContext = {
      subscriptions,
      secrets: {
        get: (key: string) => Promise.resolve(secretsStore[key]),
        store: (key: string, value: string) => {
          secretsStore[key] = value;
          return Promise.resolve();
        },
        delete: (key: string) => {
          delete secretsStore[key];
          return Promise.resolve();
        },
        onDidChange: () => ({ dispose: () => {} }),
      },
      globalState: {
        get: <T>(key: string, def?: T): T | undefined =>
          (globalStateStore[key] as T) ?? def,
        update: (key: string, value: unknown) => {
          globalStateStore[key] = value;
          return Promise.resolve();
        },
        keys: () => Object.keys(globalStateStore),
        setKeysForSync: () => {},
      },
      workspaceState: {
        get: () => undefined,
        update: () => Promise.resolve(),
        keys: () => [],
      },
      extensionPath: path.resolve(__dirname, ".."),
      extensionUri: { toString: () => "file://test" },
      environmentVariableCollection: {},
      storageUri: undefined,
      globalStorageUri: { toString: () => "file://test-global" },
      logUri: { toString: () => "file://test-log" },
      asAbsolutePath: (p: string) => p,
      extensionMode: 1,
    };

    // Ensure no RELAY_AGENT_NAME env leakage from the test runner can
    // accidentally push activate() off the idle path.
    const savedRelayAgentName = process.env.RELAY_AGENT_NAME;
    delete process.env.RELAY_AGENT_NAME;

    const { loaded, restore } = await loadBundleWithMockedVscode(vscodeMock);
    try {
      const activate = loaded.activate as (ctx: unknown) => Promise<void>;
      // Resolution moment: actually call the bundled activate().
      await activate(mockContext);

      // (B8 invariant 1) — activation completed without throwing.
      // Implicit: if `await activate(...)` rejected we'd never reach
      // here. Vitest surfaces the rejection as a failed assertion.

      // (B8 invariant 2) — exactly one status bar item created and
      // its final text is "Tether: idle" (the verified-observable that
      // connect() took the no-agent early-return branch at
      // src/extension.ts:381-390).
      expect(statusBars.length, "exactly one status bar item must be created").toBe(1);
      expect(statusBars[0]!.text, "status bar must read 'Tether: idle' after no-agent activation").toBe(
        "Tether: idle",
      );

      // (B8 invariant 3) — disposables registered (output channel,
      // status bar, palette commands, config-change listener). Exact
      // count is brittle to future activation additions; assert "many"
      // instead of "exactly N".
      expect(
        subscriptions.length,
        "activation must push disposables onto context.subscriptions",
      ).toBeGreaterThanOrEqual(3);

      // (B8 invariant 4) — the three v0.1.3 palette commands are
      // registered: open inbox, reconnect, set token.
      expect(registeredCommands).toContain("botRelayTether.openInbox");
      expect(registeredCommands).toContain("botRelayTether.reconnect");
      expect(registeredCommands).toContain("botRelayTether.setToken");
      // v0.2 — three new executor commands must also be registered
      // by activate(). Drift here means a future refactor accidentally
      // unbound an executor command from the manifest.
      expect(registeredCommands).toContain("botRelayTether.spawnAgent");
      expect(registeredCommands).toContain("botRelayTether.killAgent");
      expect(registeredCommands).toContain("botRelayTether.restartAgent");
      // v0.2.3 — Switch Agent command must be registered by activate().
      expect(registeredCommands).toContain("botRelayTether.switchAgent");
    } finally {
      restore();
      if (savedRelayAgentName !== undefined) {
        process.env.RELAY_AGENT_NAME = savedRelayAgentName;
      }
    }
  });

  // (B9) — v0.2 end-to-end spawn flow through the SHIPPED bundle.
  // Exercises: activate → bundled Tether: Spawn Agent command →
  // vscode.window.createTerminal called with the right name + env.
  // Asserts the env contract end-to-end (RELAY_AGENT_NAME / ROLE /
  // CAPABILITIES propagation) on the actual bundle, not just on the
  // unit-test surface in agent-manager.test.ts.
  it("(B9) bundled Tether: Spawn Agent command creates a terminal with the correct env", async () => {
    interface CreatedTerminal {
      options: { name: string; env?: Record<string, string>; cwd?: string };
      shown: number;
      sentText: { text: string; addNewLine?: boolean }[];
    }
    const terminals: CreatedTerminal[] = [];
    const registeredCommands: Record<string, (...args: unknown[]) => unknown> = {};
    const inputs: string[] = [];

    // Queue of values to return from showInputBox in order:
    // 1) agent name, 2) role, 3) caps, 4) token (empty → no token storage).
    const inputBoxAnswers = ["b9-agent-1", "builder", "build,test,deploy", ""];
    let inputBoxIdx = 0;

    const vscodeMock = {
      StatusBarAlignment: { Left: 1, Right: 2 },
      ViewColumn: { Beside: -2, Active: -1, One: 1 },
      window: {
        createOutputChannel: (_name: string) => ({
          name: _name,
          appendLine: () => {},
          append: () => {},
          show: () => {},
          hide: () => {},
          dispose: () => {},
          replace: () => {},
          clear: () => {},
        }),
        createStatusBarItem: () => ({
          text: "",
          show: () => {},
          hide: () => {},
          dispose: () => {},
        }),
        showInformationMessage: () => Promise.resolve(undefined),
        showWarningMessage: () => Promise.resolve(undefined),
        showErrorMessage: () => Promise.resolve(undefined),
        showInputBox: (_opts?: unknown) => {
          const val = inputBoxAnswers[inputBoxIdx++];
          inputs.push(val ?? "<undefined>");
          return Promise.resolve(val);
        },
        createTerminal: (opts: { name: string; env?: Record<string, string>; cwd?: string }) => {
          const t: CreatedTerminal = { options: opts, shown: 0, sentText: [] };
          terminals.push(t);
          return {
            show: () => { t.shown += 1; },
            sendText: (text: string, addNewLine?: boolean) => {
              t.sentText.push({ text, addNewLine });
            },
            dispose: () => {},
            exitStatus: undefined,
          };
        },
        onDidCloseTerminal: () => ({ dispose: () => {} }),
        terminals: [],
        activeTerminal: undefined,
        createWebviewPanel: () => ({
          webview: { html: "" },
          dispose: () => {},
          reveal: () => {},
          onDidDispose: () => ({ dispose: () => {} }),
        }),
      },
      commands: {
        registerCommand: (name: string, fn: (...args: unknown[]) => unknown) => {
          registeredCommands[name] = fn;
          return { dispose: () => {} };
        },
      },
      workspace: {
        getConfiguration: () => ({
          get: () => undefined,
          update: () => Promise.resolve(),
          has: () => false,
          inspect: () => undefined,
        }),
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
      },
      Uri: { parse: (s: string) => ({ toString: () => s }) },
      env: { uriScheme: "vscode" },
      version: "1.85.0",
    };

    const mockContext = {
      subscriptions: [] as unknown[],
      secrets: {
        get: () => Promise.resolve(undefined),
        store: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        onDidChange: () => ({ dispose: () => {} }),
      },
      globalState: {
        get: () => undefined,
        update: () => Promise.resolve(),
        keys: () => [],
        setKeysForSync: () => {},
      },
      workspaceState: {
        get: () => undefined,
        update: () => Promise.resolve(),
        keys: () => [],
      },
      extensionPath: path.resolve(__dirname, ".."),
      extensionUri: { toString: () => "file://test" },
      environmentVariableCollection: {},
      storageUri: undefined,
      globalStorageUri: { toString: () => "file://test-global" },
      logUri: { toString: () => "file://test-log" },
      asAbsolutePath: (p: string) => p,
      extensionMode: 1,
    };

    const savedRelayAgentName = process.env.RELAY_AGENT_NAME;
    delete process.env.RELAY_AGENT_NAME;
    const { loaded, restore } = await loadBundleWithMockedVscode(vscodeMock);
    try {
      const activate = loaded.activate as (ctx: unknown) => Promise<void>;
      await activate(mockContext);

      // The spawn command must be in the registry.
      const spawnHandler = registeredCommands["botRelayTether.spawnAgent"];
      expect(typeof spawnHandler, "spawnAgent command not registered").toBe("function");

      // Fire it; the mocked showInputBox returns our queue, the
      // spawn flow validates + calls createTerminal.
      await spawnHandler!();

      expect(
        terminals.length,
        "createTerminal must be called exactly once during spawn",
      ).toBe(1);
      const created = terminals[0]!;
      expect(created.options.name).toBe("Tether: b9-agent-1");
      // CONTRACT ASSERTION (per
      // `feedback_test_asserts_contract_not_proxy.md`): the env that
      // VSCode actually passed to the spawned shell. Drift here would
      // re-open the "agent boots without RELAY_AGENT_NAME" failure
      // mode v2.7.2 closed for spawn-agent.sh.
      expect(created.options.env?.RELAY_AGENT_NAME).toBe("b9-agent-1");
      expect(created.options.env?.RELAY_AGENT_ROLE).toBe("builder");
      expect(created.options.env?.RELAY_AGENT_CAPABILITIES).toBe("build,test,deploy");
      // Bundled prompt typed into the terminal — claude is the default.
      expect(created.sentText).toEqual([{ text: "claude", addNewLine: true }]);
      expect(created.shown).toBeGreaterThanOrEqual(1);
    } finally {
      restore();
      if (savedRelayAgentName !== undefined) {
        process.env.RELAY_AGENT_NAME = savedRelayAgentName;
      }
    }
  });

  // ---- v0.2.0 R1 — closes codex audit P2 (msg 2e206b58) ----
  //
  // The brief + v0.2.0 CHANGELOG promise `Tether: Set Agent Token
  // (SecretStorage)` supports per-agent tokens for the executor
  // flow. R0 only wrote the singleton SECRET_KEY_AGENT_TOKEN
  // ("botRelay.agentToken"), which the executor's
  // resolveAgentSecretKey path (config.ts) does not consume — so
  // operator-set tokens disappeared into a non-consumer key.
  //
  // B10a + B10b exercise the SHIPPED bundle's setToken command
  // through Module._load with a structured vscode mock + a tracked
  // secrets.store call log. Per
  // `feedback_test_asserts_contract_not_proxy.md`: the assertion is
  // EXACT key + EXACT value, not "contains" or substring.

  function makeSetTokenMock(inputBoxAnswers: string[]): {
    vscodeMock: unknown;
    mockContext: unknown;
    secretsStoreCalls: { key: string; value: string }[];
    secretsDeleteCalls: { key: string }[];
    registeredCommands: Record<string, (...args: unknown[]) => unknown>;
    infoMessages: string[];
  } {
    const secretsStoreCalls: { key: string; value: string }[] = [];
    const secretsDeleteCalls: { key: string }[] = [];
    const registeredCommands: Record<string, (...args: unknown[]) => unknown> = {};
    const infoMessages: string[] = [];
    let inputIdx = 0;
    const vscodeMock = {
      StatusBarAlignment: { Left: 1, Right: 2 },
      ViewColumn: { Beside: -2, Active: -1, One: 1 },
      window: {
        createOutputChannel: () => ({
          appendLine: () => {},
          append: () => {},
          show: () => {},
          hide: () => {},
          dispose: () => {},
          replace: () => {},
          clear: () => {},
        }),
        createStatusBarItem: () => ({
          text: "",
          show: () => {},
          hide: () => {},
          dispose: () => {},
        }),
        showInformationMessage: (msg: string) => {
          infoMessages.push(msg);
          return Promise.resolve(undefined);
        },
        showWarningMessage: () => Promise.resolve(undefined),
        showErrorMessage: () => Promise.resolve(undefined),
        showInputBox: (_opts?: unknown) => {
          const v = inputBoxAnswers[inputIdx++];
          return Promise.resolve(v);
        },
        createTerminal: () => ({
          show: () => {},
          sendText: () => {},
          dispose: () => {},
          exitStatus: undefined,
        }),
        onDidCloseTerminal: () => ({ dispose: () => {} }),
        terminals: [],
        activeTerminal: undefined,
        createWebviewPanel: () => ({
          webview: { html: "" },
          dispose: () => {},
          reveal: () => {},
          onDidDispose: () => ({ dispose: () => {} }),
        }),
      },
      commands: {
        registerCommand: (name: string, fn: (...args: unknown[]) => unknown) => {
          registeredCommands[name] = fn;
          return { dispose: () => {} };
        },
      },
      workspace: {
        getConfiguration: () => ({
          get: () => undefined,
          update: () => Promise.resolve(),
          has: () => false,
          inspect: () => undefined,
        }),
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
      },
      Uri: { parse: (s: string) => ({ toString: () => s }) },
      env: { uriScheme: "vscode" },
      version: "1.85.0",
    };
    const mockContext = {
      subscriptions: [] as unknown[],
      secrets: {
        get: () => Promise.resolve(undefined),
        store: (key: string, value: string) => {
          secretsStoreCalls.push({ key, value });
          return Promise.resolve();
        },
        delete: (key: string) => {
          secretsDeleteCalls.push({ key });
          return Promise.resolve();
        },
        onDidChange: () => ({ dispose: () => {} }),
      },
      globalState: {
        get: () => undefined,
        update: () => Promise.resolve(),
        keys: () => [],
        setKeysForSync: () => {},
      },
      workspaceState: {
        get: () => undefined,
        update: () => Promise.resolve(),
        keys: () => [],
      },
      extensionPath: path.resolve(__dirname, ".."),
      extensionUri: { toString: () => "file://test" },
      environmentVariableCollection: {},
      storageUri: undefined,
      globalStorageUri: { toString: () => "file://test-global" },
      logUri: { toString: () => "file://test-log" },
      asAbsolutePath: (p: string) => p,
      extensionMode: 1,
    };
    return {
      vscodeMock,
      mockContext,
      secretsStoreCalls,
      secretsDeleteCalls,
      registeredCommands,
      infoMessages,
    };
  }

  it("(B10a) bundled botRelayTether.setToken with NAMED agent writes per-agent key", async () => {
    // inputBox answers (in order): name="victra-build", token="tok-abc-123"
    const { vscodeMock, mockContext, secretsStoreCalls, registeredCommands, infoMessages } =
      makeSetTokenMock(["victra-build", "tok-abc-123"]);
    const savedRelayAgentName = process.env.RELAY_AGENT_NAME;
    delete process.env.RELAY_AGENT_NAME;
    const { loaded, restore } = await loadBundleWithMockedVscode(vscodeMock);
    try {
      const activate = loaded.activate as (ctx: unknown) => Promise<void>;
      await activate(mockContext);
      const setTokenHandler = registeredCommands["botRelayTether.setToken"];
      expect(typeof setTokenHandler, "setToken command not registered").toBe("function");
      await setTokenHandler!();
      expect(
        secretsStoreCalls,
        "setToken with named agent must write per-agent key",
      ).toEqual([
        { key: "botRelayTether.token.victra-build", value: "tok-abc-123" },
      ]);
      // Toast confirms WHICH path ran — operator-visible.
      expect(infoMessages.some((m) => /agent "victra-build"/.test(m))).toBe(true);
    } finally {
      restore();
      if (savedRelayAgentName !== undefined) {
        process.env.RELAY_AGENT_NAME = savedRelayAgentName;
      }
    }
  });

  it("(B10b) bundled botRelayTether.setToken with EMPTY agent name writes legacy singleton", async () => {
    // inputBox answers (in order): name="" (empty → singleton path), token="leg-singleton-token"
    const { vscodeMock, mockContext, secretsStoreCalls, registeredCommands, infoMessages } =
      makeSetTokenMock(["", "leg-singleton-token"]);
    const savedRelayAgentName = process.env.RELAY_AGENT_NAME;
    delete process.env.RELAY_AGENT_NAME;
    const { loaded, restore } = await loadBundleWithMockedVscode(vscodeMock);
    try {
      const activate = loaded.activate as (ctx: unknown) => Promise<void>;
      await activate(mockContext);
      const setTokenHandler = registeredCommands["botRelayTether.setToken"];
      await setTokenHandler!();
      // Singleton key is SECRET_KEY_AGENT_TOKEN = "botRelay.agentToken"
      // (v0.1.x observer backward-compat constant at extension.ts:69).
      expect(secretsStoreCalls).toEqual([
        { key: "botRelay.agentToken", value: "leg-singleton-token" },
      ]);
      expect(infoMessages.some((m) => /observer-mode singleton/.test(m))).toBe(true);
    } finally {
      restore();
      if (savedRelayAgentName !== undefined) {
        process.env.RELAY_AGENT_NAME = savedRelayAgentName;
      }
    }
  });
});
