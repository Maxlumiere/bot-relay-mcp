// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.5.0 #94 code-audit — SHIPPED SPAWN-PATH regression.
//
// The reconnect path (resolveTetherConfig) was made vault-first, but the SPAWN
// path (promptForAgentSpec) still read per-agent SecretStorage FIRST and only
// consulted the vault when that was empty. So a STALE SecretStorage token
// shadowed the hook-maintained vault and got injected as RELAY_AGENT_TOKEN into
// the spawned agent — which then bypasses SessionStart vault hydration and runs
// on the dead credential. Same desync class, on the executor/spawn path.
//
// The pure resolvePerAgentToken test (v0-2-per-agent-config) MISSED this because
// promptForAgentSpec didn't call the resolver until AFTER SecretStorage already
// won. This drives the REAL shipped flow end-to-end:
//   promptForAgentSpec (mocked prompts + fake SecretStorage + real vault file)
//     → AgentSpec → buildSpawnEnv → RELAY_AGENT_TOKEN.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as vscodeTypes from "vscode";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGENT = "watcher";
const CURRENT = "C".repeat(40); // vault (hook-maintained) — the CORRECT token
const STALE = "S".repeat(40); // per-agent SecretStorage — the WRONG token

// Queue of showInputBox answers: name, role, caps. The operator TOKEN prompt
// must NOT be reached when resolution succeeds — we flag it if it fires.
let inputQueue: Array<string | undefined> = [];
let tokenPromptHit = false;

vi.mock("vscode", () => ({
  window: {
    showInputBox: (opts: { title?: string }) => {
      if (typeof opts?.title === "string" && opts.title.includes("token for")) {
        tokenPromptHit = true;
        return Promise.resolve(undefined); // cancel — assertions will catch it
      }
      return Promise.resolve(inputQueue.shift());
    },
  },
}));

// The SHIPPED spawn path + the env builder it feeds (root/ext seams importable
// from tests). Top-level await mirrors the other real-flow tests in this repo.
const { promptForAgentSpec } = await import("./extension.js");
const { buildSpawnEnv } = await import("./agent-manager.js");

let home: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "RELAY_HOME",
  "RELAY_DB_PATH",
  "RELAY_INSTANCE_ID",
  "RELAY_AGENT_TOKEN",
  "RELAY_AGENT_TOKEN_WATCHER",
];

/** Minimal ExtensionContext.secrets backing store keyed by the per-agent key. */
function fakeContext(storedSecret: string | undefined): vscodeTypes.ExtensionContext {
  const store = new Map<string, string>();
  if (storedSecret !== undefined) store.set(`botRelayTether.token.${AGENT}`, storedSecret);
  return {
    secrets: {
      get: (k: string) => Promise.resolve(store.get(k)),
      store: (k: string, v: string) => {
        store.set(k, v);
        return Promise.resolve();
      },
    },
  } as unknown as vscodeTypes.ExtensionContext;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "v050-spawn-"));
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RELAY_HOME = home; // flat vault → <home>/agents/<name>.token
  inputQueue = [AGENT, "builder", "build,test"];
  tokenPromptHit = false;
  // Plant the CURRENT token in the per-instance vault (as the SessionStart hook does).
  fs.mkdirSync(path.join(home, "agents"), { recursive: true });
  fs.writeFileSync(path.join(home, "agents", `${AGENT}.token`), `${CURRENT}\n`);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("v0.5.0 #94 code-audit — spawn path: hook-maintained vault beats stale per-agent SecretStorage", () => {
  it("stale SecretStorage + current vault + no env → spec.token AND RELAY_AGENT_TOKEN = the CURRENT vault token", async () => {
    const result = await promptForAgentSpec(fakeContext(STALE));
    expect(result, "promptForAgentSpec must not cancel").not.toBeNull();
    expect(tokenPromptHit, "resolution succeeds → operator token prompt must NOT fire").toBe(false);

    const spec = result!.spec;
    expect(spec.token, "vault must win over stale SecretStorage on the SPAWN path").toBe(CURRENT);
    expect(spec.token).not.toBe(STALE);

    // The shipped downstream: buildSpawnEnv injects the resolved token as
    // RELAY_AGENT_TOKEN for the spawned terminal — it must be the CURRENT one.
    const env = buildSpawnEnv(spec, {});
    expect(env.RELAY_AGENT_TOKEN, "spawned terminal must inherit the CURRENT vault token").toBe(CURRENT);
    expect(env.RELAY_AGENT_TOKEN).not.toBe(STALE);
  });

  it("explicit per-agent env overrides even the vault (emergency operator override stays on top)", async () => {
    const OVERRIDE = "O".repeat(40);
    process.env.RELAY_AGENT_TOKEN_WATCHER = OVERRIDE;
    const result = await promptForAgentSpec(fakeContext(STALE));
    expect(result).not.toBeNull();
    expect(result!.spec.token, "explicit env must beat both vault and SecretStorage").toBe(OVERRIDE);
    expect(buildSpawnEnv(result!.spec, {}).RELAY_AGENT_TOKEN).toBe(OVERRIDE);
  });

  it("no vault + SecretStorage present → falls back to the stored token (back-compat preserved, no prompt)", async () => {
    fs.rmSync(path.join(home, "agents", `${AGENT}.token`));
    const result = await promptForAgentSpec(fakeContext(STALE));
    expect(result).not.toBeNull();
    expect(tokenPromptHit, "a stored secret still resolves without prompting").toBe(false);
    expect(result!.spec.token, "with no vault, the stored SecretStorage token is still used").toBe(STALE);
    expect(buildSpawnEnv(result!.spec, {}).RELAY_AGENT_TOKEN).toBe(STALE);
  });
});
