// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v2.5.0 Tether Phase 1 — Part E — VSCode extension entry point.
 *
 * Wires three things:
 *   1. An MCP client connection to the local bot-relay daemon over its
 *      Streamable HTTP transport, subscribed to `relay://inbox/<agent>`.
 *   2. A status-bar item showing pending count + last-message recency.
 *   3. A click-to-open webview with the last 10 messages (read-only).
 *
 * Activation is `onStartupFinished` so the extension lights up the
 * moment a workspace opens. If the operator hasn't set an agent name
 * (and `RELAY_AGENT_NAME` isn't in env), the extension stays idle —
 * status bar shows "Tether: idle" and nothing tries to dial the relay.
 *
 * No vscode types imported at module-eval time so the unit-test harness
 * (vitest) can `await import('./format.js')` without dragging in the
 * full VSCode stub. All vscode imports live inside `activate`.
 */
import * as vscode from "vscode";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  formatStatusBar,
  formatToast,
  statusBarSeverity,
  formatExecutorStatusBar,
  type InboxSnapshot,
} from "./format.js";
import {
  resolveTetherConfig,
  decideMigrationAction,
  resolveAgentSecretKey,
  resolvePerAgentToken,
  AGENT_NAME_RE,
  type TetherConfig,
} from "./config.js";
import { wireTransportDiagnostics } from "./transport-diagnostics.js";
import { WakeGate, subscribeInboxes } from "./inbox-subscription.js";
import { parseAgentNames, applyAgentSwitch } from "./switch-agent.js";
import {
  AgentManager,
  realScheduler,
  type AgentSnapshot,
  type AgentSpec,
  type ManagedTerminal,
  type ManagedTerminalOptions,
  type TerminalApi,
} from "./agent-manager.js";
import { RestartPolicy } from "./restart-policy.js";
import { ReconnectSupervisor } from "./reconnect-supervisor.js";
import { ConnectionLifecycle } from "./connection-lifecycle.js";
import { HealthPoll } from "./health-poll.js";
import { resolveAndWake, resolveAgentBinding, type AgentPidBinding } from "./pid-binding.js";
import { machineGuid, type HostPlatform } from "./host-identity.js";
import { adapterFor, type LlmAdapter, type WakeContext, type SubmitMethod } from "./llm-adapter.js";
import { execFileSync } from "node:child_process";

const CHANNEL_NAME = "Tether for bot-relay-mcp";
const STATUS_COMMAND = "botRelayTether.openInbox";
const SET_TOKEN_COMMAND = "botRelayTether.setToken";
const SPAWN_AGENT_COMMAND = "botRelayTether.spawnAgent";
const KILL_AGENT_COMMAND = "botRelayTether.killAgent";
const RESTART_AGENT_COMMAND = "botRelayTether.restartAgent";
const SWITCH_AGENT_COMMAND = "botRelayTether.switchAgent";
const EXTENSION_ID = "lumiere-ventures.bot-relay-tether";

/**
 * v0.1.3 — SecretStorage key for the agent token. Stable, namespaced
 * under `botRelay.` so future Tether settings don't collide. NEVER
 * read agentToken from `workspace.getConfiguration` directly — go
 * through `readConfig(context)` below which threads the SecretStorage
 * value in as highest-priority per config.ts:resolveAgentToken.
 */
const SECRET_KEY_AGENT_TOKEN = "botRelay.agentToken";

/**
 * v0.1.3 — globalState key tracking whether we've shown the post-
 * migration "we moved your token to SecretStorage; recommend rotating"
 * notification. Stored in non-secret globalState because it's a UI
 * one-shot flag, not a credential.
 */
const MIGRATION_NOTICE_SHOWN_KEY = "botRelayTether.migrationNoticeShown";

function getExtensionVersion(): string {
  return vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON.version ?? "0.0.0-unknown";
}

async function readConfig(context: vscode.ExtensionContext): Promise<TetherConfig> {
  // v0.1.3 — token now resolves SecretStorage > env > legacy config.
  // SecretStorage is the only persistence layer the operator should
  // see in v0.1.3+; legacy `bot-relay.tether.agentToken` setting is
  // removed from the contributes schema in package.json. The legacy
  // fallback in resolveTetherConfig stays for the migration window
  // (some operators upgrading from v0.1.2 still have a value in
  // settings.json until migrateAgentTokenToSecretStorage runs).
  //
  // R1 #3 from v0.1.1 stays: route through the pure resolveTetherConfig()
  // so the precedence rule is verifiable in unit tests without booting
  // VSCode. The new SecretStorage source is passed as a 3rd arg.
  const cfg = vscode.workspace.getConfiguration("bot-relay.tether");
  let secretToken: string | undefined;
  // v0.1.3 R1 [P2 codex audit fix] — track whether SecretStorage was
  // actually reachable. Pre-R1 a failure here set secretToken=undefined
  // and let resolveAgentToken fall through to legacy plaintext config,
  // re-promoting the exact leak v0.1.3 was meant to close. R1 splits
  // the two cases: secret-undefined-but-backend-available (fine to
  // fall through during the migration window) vs backend-unreachable
  // (refuse to read legacy plaintext; degrade to env-only).
  let secretsAvailable = true;
  try {
    secretToken = await context.secrets.get(SECRET_KEY_AGENT_TOKEN);
  } catch (err) {
    // VSCode SecretStorage is backed by OS keychain on macOS /
    // Credential Vault on Windows / libsecret on Linux. The Linux case
    // can fail in headless / minimal containers without libsecret.
    // Pre-R1 we fell back to legacy config; R1 explicitly refuses
    // because that re-opens the plaintext leak. Operator falls back
    // to RELAY_AGENT_TOKEN env (or sets up libsecret + uses the
    // `Tether: Set Agent Token (SecretStorage)` palette command).
    log(
      `SecretStorage unavailable, refusing to read legacy plaintext token (codex P2 audit fix). ` +
      `Falling back to RELAY_AGENT_TOKEN env only. Set token via the "Tether: Set Agent Token (SecretStorage)" ` +
      `palette command once SecretStorage is reachable. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
    secretToken = undefined;
    secretsAvailable = false;
    // Optional one-shot UI banner so the operator sees the degraded
    // mode rather than just a silent log line. Mark via globalState
    // so it fires once per install per the codex's "preferably visible
    // warning/error" recommendation. Fire-and-forget; the banner
    // shouldn't block readConfig from returning.
    void surfaceSecretStorageUnavailableNotice(context);
  }
  return resolveTetherConfig(
    (key) => cfg.get(key),
    process.env as Record<string, string | undefined>,
    secretToken,
    secretsAvailable,
  );
}

/**
 * v0.1.3 R1 — one-shot warning banner when SecretStorage backend is
 * unreachable. Surfaces the degraded mode to the operator (per codex
 * audit's "preferably visible warning/error") so they don't silently
 * lose Tether functionality on Linux-without-libsecret. Action button
 * routes to the bot-relay docs.
 *
 * Tracked via globalState so the banner fires exactly once per install
 * — the alternative (fire on every readConfig call) would be
 * obnoxious during a long-running session.
 */
const SECRET_STORAGE_UNAVAILABLE_NOTICE_KEY = "botRelayTether.secretStorageUnavailableNoticeShown";

async function surfaceSecretStorageUnavailableNotice(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    if (context.globalState.get<boolean>(SECRET_STORAGE_UNAVAILABLE_NOTICE_KEY) === true) return;
    void vscode.window
      .showWarningMessage(
        "Tether: VSCode SecretStorage is unreachable on this host. Tether will use the RELAY_AGENT_TOKEN environment variable only — the legacy plaintext settings.json fallback has been disabled in v0.1.3 R1 (security fix). On Linux this typically means libsecret/gnome-keyring isn't installed; install it and reload VSCode to enable token persistence, then set your token via the \"Tether: Set Agent Token (SecretStorage)\" palette command.",
        "View install docs",
        "Dismiss",
      )
      .then((choice) => {
        if (choice === "View install docs") {
          void vscode.env.openExternal(
            vscode.Uri.parse("https://github.com/Maxlumiere/bot-relay-mcp/blob/main/docs/token-lifecycle.md"),
          );
        }
      });
    await context.globalState.update(SECRET_STORAGE_UNAVAILABLE_NOTICE_KEY, true);
  } catch (err) {
    // Notification path itself may fail in some headless test hosts.
    // Swallow — the log line above is the source of truth.
    log(`SecretStorage-unavailable notice failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * v0.1.3 [HIGH F10] — one-shot migration from plaintext
 * `settings.json` to encrypted SecretStorage.
 *
 * An external security review flagged that v0.1.2 stored the agent token via
 * `workspace.getConfiguration("bot-relay.tether").get("agentToken")`,
 * which writes to plaintext `settings.json`. Anyone with read access
 * to a backup / settings-sync / accidental screenshot recovered the
 * token. v0.1.3 switches to `context.secrets` (VSCode SecretStorage —
 * OS keychain on macOS, Credential Vault on Windows, libsecret on
 * Linux).
 *
 * Migration semantics:
 *   - First-launch path: copy legacy plaintext value into
 *     SecretStorage, then `cfg.update(..., undefined, ...)` to remove
 *     the legacy field from `settings.json` entirely (BOTH Global +
 *     Workspace targets, to handle the "user set it per-workspace"
 *     case). Show a one-shot warning recommending token rotation
 *     since the value may have been captured in backups.
 *   - Idempotency: subsequent activations see SecretStorage populated
 *     and short-circuit. The migration-notice flag in globalState
 *     ensures the rotation prompt fires exactly once per install.
 *   - Failure safety: every SecretStorage / config-update /
 *     show-message call is try/catch'd. Activation must NOT throw
 *     because of a Linux-without-libsecret host.
 *
 * Cross-platform parity: SecretStorage API is identical across
 * macOS / Windows / Linux at the VSCode surface; the backend differs
 * but the JS contract doesn't. No platform-specific code path.
 *
 * Decision logic is extracted as `decideMigrationAction` in config.ts
 * for unit-test access. This function wires the actual VSCode side
 * effects against that decision.
 */
async function migrateAgentTokenToSecretStorage(
  context: vscode.ExtensionContext,
): Promise<{ migrated: boolean; reason: "noop-has-secret" | "noop-no-legacy" | "migrated" | "error" }> {
  try {
    const existing = await context.secrets.get(SECRET_KEY_AGENT_TOKEN);
    const cfg = vscode.workspace.getConfiguration("bot-relay.tether");
    const legacy = cfg.get("agentToken") as string | undefined;
    const decision = decideMigrationAction(!!(existing && existing.length > 0), legacy);
    if (decision.action === "noop") {
      return {
        migrated: false,
        reason: existing && existing.length > 0 ? "noop-has-secret" : "noop-no-legacy",
      };
    }
    const token = decision.tokenToStore!;
    await context.secrets.store(SECRET_KEY_AGENT_TOKEN, token);
    // Remove from BOTH Global + Workspace targets — the operator might
    // have set it at either scope. Failures are non-fatal (the leak is
    // partially closed even if one target's update throws on a
    // permission boundary; SecretStorage still wins precedence-wise).
    try {
      await cfg.update("agentToken", undefined, vscode.ConfigurationTarget.Global);
    } catch (err) {
      log(`migration: cfg.update(Global) failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await cfg.update("agentToken", undefined, vscode.ConfigurationTarget.Workspace);
    } catch (err) {
      log(`migration: cfg.update(Workspace) failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    const alreadyShown = context.globalState.get<boolean>(MIGRATION_NOTICE_SHOWN_KEY) === true;
    if (!alreadyShown) {
      // Fire-and-forget; the notification flow shouldn't block
      // activation. Mark the flag immediately so a fast re-activation
      // doesn't double-fire.
      void vscode.window
        .showWarningMessage(
          "Tether: Your bot-relay agent token has been migrated from settings.json to VSCode SecretStorage and removed from your settings. Recommend rotating the token via `relay rotate-token` since the previous plaintext value may have been captured in backups or settings sync.",
          "Reconnect with new token",
          "View rotation docs",
          "Dismiss",
        )
        .then((choice) => {
          if (choice === "Reconnect with new token") {
            void vscode.commands.executeCommand("botRelayTether.reconnect");
          } else if (choice === "View rotation docs") {
            void vscode.env.openExternal(
              vscode.Uri.parse("https://github.com/Maxlumiere/bot-relay-mcp/blob/main/docs/token-lifecycle.md"),
            );
          }
        });
      await context.globalState.update(MIGRATION_NOTICE_SHOWN_KEY, true);
    }
    log("v0.1.3 SecretStorage migration: agent token moved from settings.json → SecretStorage, legacy field cleared.");
    return { migrated: true, reason: "migrated" };
  } catch (err) {
    log(`SecretStorage migration error (continuing without migration): ${err instanceof Error ? err.message : String(err)}`);
    return { migrated: false, reason: "error" };
  }
}

/**
 * Module-scope state. Kept simple — one extension instance per VSCode
 * window, and `deactivate` clears it on reload.
 */
let outputChannel: vscode.OutputChannel | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let mcpClient: Client | undefined;
let mcpTransport: StreamableHTTPClientTransport | undefined;
let lastSnapshot: InboxSnapshot | undefined;
// Per-agent inbox-wake gates. Each agent owns its no-double-wake high-water mark
// across reconnects (catch-up + live share it). The map persists across
// reconnects (cleared only on deactivate) so the mark survives; a window reload
// re-creates the extension → fresh map → still-pending mail re-wakes (A1).
const wakeGates = new Map<string, WakeGate>();
function getWakeGate(agentName: string): WakeGate {
  let g = wakeGates.get(agentName);
  if (!g) {
    g = new WakeGate((name) => {
      void injectInboxKeystroke(name);
    });
    wakeGates.set(agentName, g);
  }
  return g;
}
// v0.3.0 PID-handshake state. localHostId = this instance's machine GUID (the
// host-scoping anchor, computed once at activate; must match the agent-side
// hook's host_id). boundTerminals caches the resolved agent→terminal binding so
// we don't re-await every Terminal.processId per wake — invalidated on terminal
// close AND self-invalidating: each wake re-validates the cached terminal
// against a FRESH binding. v0.3.0 R1 (codex P1): the discover_agents binding is
// NOT cached — a stale binding would wake the wrong terminal after a same-name
// re-register.
let localHostId: string | null = null;
// v0.3.1 — the relay HTTP base URL (config.endpoint), captured at connect so the
// PID-binding fetch can fall back to the auth-free GET /api/snapshot when the
// token-gated discover_agents read returns no binding (Tether connects token-free).
let relayEndpoint: string | null = null;
const boundTerminals = new Map<string, vscode.Terminal>();
let summaryTimer: ReturnType<typeof setInterval> | undefined;
let summaryDirty = false;

/**
 * v0.4.1 — connection lifecycle guard. Owns the intentional-disconnect flag +
 * transport-identity so an UNEXPECTED transport close (a clean daemon restart
 * ending the SSE as a quiet EOF) routes into the reconnect supervisor, while
 * an operator/teardown close is swallowed. Its `establish()` binds the new
 * transport BEFORE connect so a mid-connect close is honored (the mid-connect race).
 * Persists across reconnects; `reset()` on deactivate.
 */
const connectionLifecycle = new ConnectionLifecycle<StreamableHTTPClientTransport>();

/**
 * v0.4.1 — health-poll backstop (belt-and-suspenders for a SILENTLY swallowed
 * SSE death — no onerror AND no onclose, the Electron-fetch failure class
 * transport-diagnostics.ts was born to fight). Probes the daemon's /health
 * while connected; a tick is healthy ONLY when the response is 2xx AND the
 * body reports status==="ok" (health, not mere reachability). N consecutive
 * failures hand off to the reconnect supervisor. ZERO idle-token cost — a raw
 * HTTP GET, not an MCP tool call, no relay writes, no agent token spend. Paused
 * while a reconnect owns recovery (error/reconnecting state) and cleared on
 * dispose.
 *
 * The status check + failure counter live in the VSCode-free HealthPoll helper
 * (tested path == shipped path); extension.ts owns only the interval, the real
 * fetch, and the unhealthy handoff.
 */
const HEALTH_POLL_INTERVAL_MS = 15_000;
const HEALTH_POLL_TIMEOUT_MS = 5_000;
const HEALTH_POLL_FAIL_THRESHOLD = 2; // N consecutive fails → reconnect
let healthPollTimer: ReturnType<typeof setInterval> | undefined;
const healthPoll = new HealthPoll({
  threshold: HEALTH_POLL_FAIL_THRESHOLD,
  fetchHealth: async () => {
    const base = relayEndpoint;
    if (!base) throw new Error("no relay endpoint");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_POLL_TIMEOUT_MS);
    try {
      const res = await fetch(new URL("/health", base), { signal: controller.signal });
      // Read the body only on a 2xx — HealthPoll requires status==="ok", so a
      // non-2xx (bodyText=null) is already unhealthy without spending a read.
      return { ok: res.ok, bodyText: res.ok ? await res.text() : null };
    } finally {
      clearTimeout(timer);
    }
  },
  onUnhealthy: () => {
    if (isInErrorState()) return; // a reconnect already owns recovery
    stopHealthPoll(); // the supervisor owns retries now; connect() re-arms on success
    if (reconnectSupervisor) {
      reconnectSupervisor.handleError("health-poll: daemon not healthy");
    } else {
      setErrorState("health-poll: daemon not healthy");
    }
  },
  log,
});

/**
 * v0.2 — single-agent executor. Null when no agent has been spawned
 * via `Tether: Spawn Agent` yet; the extension is in observer-only
 * mode (v0.1.3 behavior) and the status bar follows the inbox
 * snapshot. Once spawned, the status bar switches to executor mode
 * (`Tether: <name> | N pending | <status>`).
 */
let agentManager: AgentManager | undefined;
let lastAgentSnapshot: AgentSnapshot | undefined;

/**
 * v0.1.1 — sticky error state for the active connection. Flipped by
 * `setErrorState` (called from the transport-diagnostics helper's
 * `setError` sink) when the SSE GET stream fails or the transport
 * raises any error during the connect/subscribe window. Once true,
 * `applySnapshot` + the "connected + subscribed" log line + the
 * status-bar success-text mutation MUST NOT run — otherwise a late
 * async failure would silently mask itself under the success path. The
 * lock is reset at the start of each `connect()` call (a fresh attempt
 * starts clean) and on `botRelayTether.reconnect`. Pre-v0.1.1 there was
 * no lock; this is the load-bearing piece that makes Phase 1
 * instrumentation observable instead of getting overwritten.
 */
let connectionErrorState = false;
/**
 * v0.2.1 P1 — auto-reconnect supervisor. Created in activate(); drives a
 * fresh connect() (new session id) on a recoverable transport error with
 * indefinite capped backoff, so a daemon restart no longer wedges Tether at
 * "Tether: error — run Reconnect". Null only before activation / in the
 * unit-test import path.
 */
let reconnectSupervisor: ReconnectSupervisor | undefined;
function isInErrorState(): boolean {
  return connectionErrorState;
}
function resetErrorState(): void {
  connectionErrorState = false;
}
function setErrorState(msg: string): void {
  connectionErrorState = true;
  log(msg);
  if (statusBarItem) {
    // v0.1.2 Tether Phase 4 — error text now points at the Reconnect
    // command (registered as `botRelayTether.reconnect`, surfaced in
    // the command palette as "Tether: Reconnect to Relay") so manual
    // recovery is discoverable when the SDK's auto-reconnect retries
    // exhaust. Per Codex SCOPE-TIGHTEN: "operator-facing text/status
    // to make manual reconnect discoverable when retries exhaust."
    statusBarItem.text = 'Tether: error — run "Tether: Reconnect to Relay"';
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    statusBarItem.show();
  }
}

/**
 * v0.2.1 P1 — paint the "auto-reconnect in progress" state. Unlike
 * setErrorState's red manual-Reconnect dead-end, this is an amber
 * "reconnecting…" because recovery is automatic (the supervisor will retry
 * with backoff). It flips the same connectionErrorState lock so a late
 * success-paint from the dying connection can't overwrite it — connect()
 * resets the lock at the top of the next attempt (resetErrorState).
 */
function setReconnectingState(attempt: number, delayMs: number): void {
  connectionErrorState = true;
  log(`reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${attempt})`);
  if (statusBarItem) {
    statusBarItem.text = `Tether: reconnecting… (attempt ${attempt})`;
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    statusBarItem.show();
  }
}

function log(line: string): void {
  if (!outputChannel) return;
  const ts = new Date().toISOString();
  outputChannel.appendLine(`${ts} ${line}`);
}

function buildInboxUri(agentName: string): string {
  return `relay://inbox/${encodeURIComponent(agentName)}`;
}

async function refreshSnapshot(client: Client, agentName: string): Promise<InboxSnapshot | null> {
  try {
    const result = await client.readResource({ uri: buildInboxUri(agentName) });
    // R1 #2: result.contents[0] is { uri, mimeType, ... } & ({ text } | { blob }).
    // The naive `?.text` access fails strict-mode compilation (TS2339) because
    // the union doesn't guarantee `text` exists. Type-guard via `'text' in`.
    const first = result.contents[0];
    if (!first || !("text" in first) || typeof first.text !== "string") return null;
    return JSON.parse(first.text) as InboxSnapshot;
  } catch (err) {
    log(`refreshSnapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function applySnapshot(snapshot: InboxSnapshot): void {
  lastSnapshot = snapshot;
  if (!statusBarItem) return;
  // v0.2 — executor-mode status bar wins when an agent is actively
  // managed by AgentManager. The brief defines the operator-facing
  // text precisely as `Tether: <name> | <pending> pending | <status>`,
  // so we route through formatExecutorStatusBar and ignore the
  // inbox-only formatter.
  if (lastAgentSnapshot?.spec) {
    renderExecutorStatusBar();
    return;
  }
  statusBarItem.text = formatStatusBar(snapshot);
  const sev = statusBarSeverity(snapshot);
  statusBarItem.backgroundColor =
    sev === "alert"
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : sev === "warn"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
  statusBarItem.show();
}

/**
 * v0.2 — render the executor-mode status bar. Called from both the
 * AgentManager onDidChange listener AND from applySnapshot when an
 * agent is managed so the pending count stays in sync with whichever
 * source ticks first.
 *
 * Pending count is taken from the inbox snapshot ONLY when the
 * snapshot is for the managed agent. A snapshot for a different
 * agent (e.g. a stale v0.1.3-mode snapshot from before
 * Spawn Agent was run) doesn't get rolled into the executor display.
 */
function renderExecutorStatusBar(): void {
  if (!statusBarItem) return;
  const spec = lastAgentSnapshot?.spec;
  if (!spec) return;
  const pending =
    lastSnapshot && lastSnapshot.agent_name === spec.name
      ? lastSnapshot.pending_count
      : 0;
  statusBarItem.text = formatExecutorStatusBar({
    agentName: spec.name,
    pendingCount: pending,
    status: lastAgentSnapshot!.status,
  });
  // Theme color follows the lifecycle status: error → red,
  // restarting/crashed → yellow, connecting/connected → no override.
  if (lastAgentSnapshot!.status === "error") {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground",
    );
  } else if (
    lastAgentSnapshot!.status === "restarting" ||
    lastAgentSnapshot!.status === "crashed"
  ) {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
  } else {
    statusBarItem.backgroundColor = undefined;
  }
  statusBarItem.show();
}

function toHostPlatform(p: NodeJS.Platform): HostPlatform | null {
  return p === "darwin" || p === "linux" || p === "win32" ? p : null;
}

/** Fetch the inbox-owner agent's PID binding — ALWAYS fresh (no TTL cache;
 *  v0.3.0 R1: a cached binding would wake the wrong terminal after a same-name
 *  re-register). Thin adapter: injects the real discover_agents (MCP) + the
 *  auth-free /api/snapshot fetcher into the VSCode-free `resolveAgentBinding`
 *  seam (pid-binding.ts). Tether connects token-free and the relay token-gates
 *  discover_agents, so the snapshot fallback is what populates the binding — the
 *  v0.3.0 T-ACC fix. Each fetcher returns parsed JSON or null; a failure degrades
 *  cleanly to the empty binding (→ name matcher), never a throw or wrong wake. */
async function getAgentBinding(agentName: string): Promise<AgentPidBinding> {
  return resolveAgentBinding(agentName, {
    discover: async () => {
      if (!mcpClient) return null;
      try {
        const res = await mcpClient.callTool({ name: "discover_agents", arguments: {} });
        const text = extractToolText(res);
        return text ? JSON.parse(text) : null;
      } catch (err) {
        log(`pid-binding: discover_agents failed — ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
    snapshot: async () => {
      // The auth-free dashboard read; serves the same host_shell_pids/host_id
      // (behind http_secret on remote binds, open on a loopback daemon — the
      // same trust boundary as the MCP surface).
      if (!relayEndpoint) return null;
      try {
        const res = await fetch(new URL("/api/snapshot", relayEndpoint), { method: "GET" });
        return res.ok ? await res.json() : null;
      } catch (err) {
        log(`pid-binding: /api/snapshot fallback failed — ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
  });
}

/**
 * v0.3.0 PID-handshake — wake the terminal bound to `agentName`. Thin adapter
 * over the VSCode-free resolveAndWake (PID-primary, host-scoped; name fallback;
 * 0/>1 → hint). resolveAndWake fetches the binding FRESH each wake (no stale
 * cache → no wrong-terminal-after-re-register, codex R1) and re-validates any
 * cached terminal against it. Async; fire-and-forget from WakeGate.
 */
/**
 * Pick the per-LLM wake adapter from config (`bot-relay.tether.agentLlm`,
 * default "claude"). The adapter owns the wake word + the inject/submit quirks
 * for that CLI agent; the terminal matcher above is LLM-agnostic. Read fresh per
 * wake so a config change takes effect without a reload.
 */
function resolveWakeAdapter(agentName: string): LlmAdapter {
  const cfg = vscode.workspace.getConfiguration("bot-relay.tether");
  // Per-agent llm: prefer this agent's entry in agents[], else the global
  // agentLlm (legacy single-agent config).
  let llm = cfg.get<string>("agentLlm") ?? "claude";
  const agentsCfg = cfg.get<Array<{ name?: unknown; llm?: unknown }>>("agents");
  if (Array.isArray(agentsCfg)) {
    const entry = agentsCfg.find((a) => a && typeof a.name === "string" && a.name === agentName);
    if (entry) llm = entry.llm === "codex" ? "codex" : "claude";
  }
  const submitKey: "\r" | "\n" = cfg.get<string>("codexEnterKey") === "lf" ? "\n" : "\r";
  const submitDelayMs = cfg.get<number>("codexSubmitDelayMs") ?? 150;
  // Default to sendSequence: focusing the terminal + a standalone CR is the
  // programmatic twin of a real keyboard Enter — the only thing proven to make
  // Codex submit (a sendText'd CR can be absorbed). sendText stays selectable.
  const submitMethod: SubmitMethod =
    cfg.get<string>("codexSubmitMethod") === "sendText" ? "sendText" : "sendSequence";
  // Codex has no `inbox` convention — inject an explicit instruction, with the
  // agent name templated into the configured prompt so it drains the right inbox.
  const promptTemplate =
    cfg.get<string>("codexWakePrompt") ??
    'Relay mail arrived — call get_messages(agent_name="{agent}", status="pending"), act on every message, then continue.';
  const wakeText = promptTemplate.replace(/\{agent\}/g, agentName);
  return adapterFor(llm, { codex: { wakeText, submitKey, submitDelayMs, submitMethod } });
}

/** Resolve the agents Tether watches: the legacy single `agentName` (primary —
 *  the connection identity + status-bar agent) plus any entries in
 *  `bot-relay.tether.agents`. Deduped; primary first. */
function resolveAgentList(config: TetherConfig): Array<{ name: string; llm: string }> {
  const cfg = vscode.workspace.getConfiguration("bot-relay.tether");
  const out: Array<{ name: string; llm: string }> = [];
  const seen = new Set<string>();
  const globalLlm = cfg.get<string>("agentLlm") === "codex" ? "codex" : "claude";
  if (config.agentName && AGENT_NAME_RE.test(config.agentName)) {
    out.push({ name: config.agentName, llm: globalLlm });
    seen.add(config.agentName);
  }
  const raw = cfg.get<Array<{ name?: unknown; llm?: unknown }>>("agents");
  if (Array.isArray(raw)) {
    for (const a of raw) {
      const name = a && typeof a.name === "string" ? a.name : "";
      if (!name || !AGENT_NAME_RE.test(name) || seen.has(name)) continue;
      out.push({ name, llm: a.llm === "codex" ? "codex" : "claude" });
      seen.add(name);
    }
  }
  return out;
}

/**
 * Build the side-effecting WakeContext for a bound terminal: the per-terminal
 * sendText/show, a real timer delay, and a focus-then-sendSequence path. VSCode's
 * sendSequence command only targets the ACTIVE terminal, so we `show()` first to
 * make the bound terminal active. The submit-key timing quirk itself lives in the
 * Codex adapter; this only supplies the effects.
 */
function buildWakeContext(t: vscode.Terminal): WakeContext {
  return {
    terminal: t,
    delay: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    sendSequenceToTerminal: async (text: string) => {
      t.show(false);
      await vscode.commands.executeCommand("workbench.action.terminal.sendSequence", { text });
    },
  };
}

async function injectInboxKeystroke(agentName: string): Promise<void> {
  const adapter = resolveWakeAdapter(agentName);
  try {
    await resolveAndWake<vscode.Terminal>(agentName, {
      fetchBinding: getAgentBinding,
      localHostId,
      openTerminals: () => vscode.window.terminals,
      nameOf: (t) => t.name,
      processIdOf: (t) => Promise.resolve(t.processId),
      cacheGet: (name) => boundTerminals.get(name),
      cacheSet: (name, t) => {
        boundTerminals.set(name, t);
      },
      cacheClear: (name) => {
        boundTerminals.delete(name);
      },
      // Per-LLM injection: Claude submits an appended newline; Codex types the
      // word then submits with a SEPARATE, delayed Enter (see llm-adapter.ts).
      // resolveAndWake's wake is sync/void — fire-and-forget the async adapter.
      wake: (t) => {
        void adapter.wake(buildWakeContext(t));
      },
      wakeWord: adapter.wakeWord,
      hint: hintNoWake,
      log,
    });
  } catch (err) {
    log(`auto-inject failed for "${agentName}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * v0.2.2 P3 — transient status-bar nudge when an inbox wake could not be
 * delivered deterministically (0 or >1 matching terminals). Uses
 * `setStatusBarMessage` (auto-clears) so it never clobbers the persistent
 * Tether status-bar item (normal / reconnecting / error states).
 */
function hintNoWake(message: string): void {
  vscode.window.setStatusBarMessage(`$(mail) Tether: ${message}`, 8000);
}

function showToast(snapshot: InboxSnapshot, level: TetherConfig["notificationLevel"]): void {
  if (level === "none") return;
  if (level === "event") {
    vscode.window.showInformationMessage(formatToast(snapshot));
    return;
  }
  // summary: mark dirty + the timer flushes a single digest every 5 min.
  summaryDirty = true;
}

function ensureSummaryTimer(level: TetherConfig["notificationLevel"]): void {
  if (level !== "summary") {
    if (summaryTimer) {
      clearInterval(summaryTimer);
      summaryTimer = undefined;
    }
    return;
  }
  if (summaryTimer) return;
  summaryTimer = setInterval(() => {
    if (!summaryDirty || !lastSnapshot) return;
    vscode.window.showInformationMessage(
      `Tether digest: ${lastSnapshot.pending_count} pending in ${lastSnapshot.agent_name}`,
    );
    summaryDirty = false;
  }, 5 * 60 * 1000);
}

async function connect(config: TetherConfig): Promise<void> {
  const agentList = resolveAgentList(config);
  if (agentList.length === 0) {
    log("idle: no agents configured (set bot-relay.tether.agentName / RELAY_AGENT_NAME, or bot-relay.tether.agents)");
    stopHealthPoll(); // nothing to watch — don't poll
    if (statusBarItem) {
      statusBarItem.text = "Tether: idle";
      statusBarItem.backgroundColor = undefined;
      statusBarItem.show();
    }
    return;
  }
  // v0.4.1 — a fresh connect intentionally tears down the OLD transport. Raise
  // the intentional-disconnect window (so the old transport's onclose is
  // swallowed, not treated as a drop) and stop the health-poll before the
  // teardown. establish() below resets the flag before wiring/connecting the
  // NEW transport, so a genuine close on the new transport IS honored.
  connectionLifecycle.beginIntentionalDisconnect();
  stopHealthPoll();
  await disconnect();
  // v0.1.1 — fresh connect attempt resets the error-state lock. Any
  // previously-flipped error from a prior session is cleared so a manual
  // reconnect (or a config-change-driven reconnect) can recover.
  resetErrorState();

  log(`connecting to ${config.endpoint}/mcp; watching ${agentList.length} agent(s): ${agentList.map((a) => `${a.name}(${a.llm})`).join(", ")}`);
  relayEndpoint = config.endpoint; // for the /api/snapshot PID-binding fallback
  const url = new URL("/mcp", config.endpoint);
  // The SDK's StreamableHTTPClientTransport accepts request init for
  // header injection; the relay's HTTP transport reads X-Agent-Token
  // for auth (see src/transport/http.ts).
  const requestInit: RequestInit = {};
  if (config.agentToken) {
    requestInit.headers = { "X-Agent-Token": config.agentToken };
  }
  // v0.2.1 P1 — the SDK's same-session SSE retries (default `maxRetries: 2`,
  // see streamableHttp.js:10 DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS)
  // re-open the GET on the SAME mcp-session-id. That is only useful for a
  // genuinely transient blip where the session still exists server-side; it
  // is FUTILE after a daemon restart (the session id is gone → 404 every
  // attempt). Recovery from a restart is now owned by ReconnectSupervisor,
  // which performs a FRESH initialize (new session id) on the first
  // recoverable error and re-arms indefinitely. So we keep the SDK budget
  // small (3) — just enough to absorb a true transient — rather than the old
  // 20 that burned ~6.75 min of dead retries against a dead session. The
  // supervisor's classifier fires on the first 404, at/before the SDK
  // give-up, so there is no recovery gap (O-1).
  const client = new Client(
    { name: "bot-relay-tether-vscode", version: getExtensionVersion() },
    { capabilities: {} },
  );

  // v0.4.1 — establish the transport through the ConnectionLifecycle seam. It
  // binds the new transport as guard-accepted BEFORE connect (closing the
  // mid-connect race: a close during client.connect() is honored, not dropped)
  // and resets the intentional-disconnect flag before wiring/connecting, so a
  // genuine close on the NEW transport routes to the supervisor.
  const transport = await connectionLifecycle.establish({
    build: () =>
      new StreamableHTTPClientTransport(url, {
        requestInit,
        // v0.2.1 P1 — the SDK's same-session SSE retries (default `maxRetries: 2`,
        // see streamableHttp.js:10 DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS)
        // re-open the GET on the SAME mcp-session-id. That is only useful for a
        // genuinely transient blip where the session still exists server-side; it
        // is FUTILE after a daemon restart (the session id is gone → 404 every
        // attempt). Recovery from a restart is owned by ReconnectSupervisor,
        // which performs a FRESH initialize (new session id) on the first
        // recoverable error/close and re-arms indefinitely. So we keep the SDK
        // budget small (3) — just enough to absorb a true transient.
        reconnectionOptions: {
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 30_000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 3,
        },
      }),
    // v0.1.1 — wire transport diagnostics BEFORE client.connect(). The SDK
    // (Protocol._connect at node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:220-228)
    // PRESERVES preexisting transport.onerror/onclose and WRAPS them on
    // connect. Wiring AFTER connect would replace the SDK's protocol-level
    // wrapper and break protocol-level error propagation. The order is
    // load-bearing — the drift guard at tests/v2-6-tether-transport-diagnostics.test.ts
    // pins this contract. establish() calls this before its connect().
    wire: (t) =>
      wireTransportDiagnostics(t, {
        log,
        // v0.2.1 P1 — route transport ERRORS through the reconnect supervisor.
        // Recoverable (dead session / daemon down) → auto-reconnect with
        // indefinite backoff (closes RC-2). Unrecoverable (bad token) → the
        // v0.1.x manual-Reconnect dead-end. Falls back to setErrorState if the
        // supervisor isn't wired yet (shouldn't happen post-activate).
        setError: (msg: string) => {
          if (reconnectSupervisor) {
            reconnectSupervisor.handleError(msg);
          } else {
            setErrorState(msg);
          }
        },
        // v0.4.1 — route an UNEXPECTED transport CLOSE through the supervisor
        // too. A clean daemon restart (launchctl kickstart) often ends the SSE
        // as a quiet EOF (onclose), never an onerror; pre-v0.4.1 that wedged
        // Tether until a manual Reconnect. The guard swallows operator/teardown
        // closes and stale/superseded closes; only a real drop of the live (or
        // mid-establish) transport reaches here.
        onClose: () => {
          if (!connectionLifecycle.shouldReconnectOnClose(t)) return;
          log("transport closed unexpectedly — routing to reconnect supervisor");
          if (reconnectSupervisor) {
            reconnectSupervisor.handleError("transport closed");
          } else {
            setErrorState("transport closed");
          }
        },
      }),
    connect: (t) => client.connect(t),
  });
  mcpClient = client;
  mcpTransport = transport;

  // Wire ONE notification handler + subscribe + catch-up through the shared,
  // VSCode-free subscribeInboxes seam (the integration test exercises the REAL
  // subscribe→notify→wake path via the single-agent subscribeInbox shim, not just
  // decideWake in isolation — test-path-must-match-shipped-path). The state-lock
  // guard (don't paint a success snapshot / wake over an error UI) lives inside
  // it. Each watched agent has its OWN persistent WakeGate (per-agent no-double-
  // wake mark across reconnects); a window reload re-creates them, re-waking
  // pending mail (A1).
  await subscribeInboxes({
    client,
    agents: agentList.map((a, i) => ({
      agentName: a.name,
      autoInjectInbox: config.autoInjectInbox,
      wakeGate: getWakeGate(a.name),
      primary: i === 0,
    })),
    buildInboxUri,
    readSnapshot: refreshSnapshot,
    applySnapshot,
    showToast: (snapshot) => showToast(snapshot, config.notificationLevel),
    isInErrorState,
    log,
  });
  if (!isInErrorState()) {
    log("connected + subscribed");
    // v0.4.1 — arm the reachability health-poll now that we're live. Resets
    // its failure counter each fresh connect; auto-resumes after a reconnect
    // (a successful reconnect re-runs connect() → here).
    startHealthPoll();
  }
}

/**
 * v0.4.1 — start (or restart) the health-poll. Idempotent: clears any prior
 * timer + zeroes the helper's failure counter first. No-op without a known
 * relay endpoint. The uptime-decrease reboot detector is deferred to a
 * follow-on once the daemon adds a monotonic uptime_seconds to HTTP /health.
 */
function startHealthPoll(): void {
  stopHealthPoll();
  if (!relayEndpoint) return;
  healthPoll.reset();
  healthPollTimer = setInterval(() => {
    void pollHealthOnce();
  }, HEALTH_POLL_INTERVAL_MS);
}

/** v0.4.1 — stop the health-poll + reset its failure counter (no leaked timer). */
function stopHealthPoll(): void {
  if (healthPollTimer) {
    clearInterval(healthPollTimer);
    healthPollTimer = undefined;
  }
  healthPoll.reset();
}

/**
 * v0.4.1 — one health-poll tick. Skipped while a reconnect already owns
 * recovery (error/reconnecting state) so it never double-drives with
 * onerror/onclose. The probe (2xx + status==="ok"), the failure counter, the
 * threshold, and the supervisor handoff all live in the HealthPoll helper.
 */
async function pollHealthOnce(): Promise<void> {
  if (isInErrorState()) return; // a reconnect owns recovery; don't double-drive
  if (!relayEndpoint) return;
  await healthPoll.tick();
}

async function disconnect(): Promise<void> {
  if (mcpClient) {
    try {
      await mcpClient.close();
    } catch (err) {
      log(`disconnect: client.close threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (mcpTransport) {
    try {
      await mcpTransport.close();
    } catch {
      /* best-effort */
    }
  }
  mcpClient = undefined;
  mcpTransport = undefined;
}

/** Pull the first text payload out of an MCP tools/call result, or null. */
function extractToolText(res: unknown): string | null {
  const content = (res as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const first = content[0];
  if (
    first &&
    typeof first === "object" &&
    "text" in first &&
    typeof (first as { text: unknown }).text === "string"
  ) {
    return (first as { text: string }).text;
  }
  return null;
}

/**
 * v0.2.3 (B) — Switch Agent: offer the live `discover_agents` roster as a
 * QuickPick (the multi-agent inbox-picker), always with a free-text fallback,
 * and write the choice to `bot-relay.tether.agentName`. The existing
 * onDidChangeConfiguration → connect(fresh) path re-subscribes live (no
 * reload — already wired in v0.2.1/v0.2.2), and the v0.2.3 catch-up wake then
 * delivers any mail already waiting for the newly-selected agent.
 */
async function runSwitchAgent(context: vscode.ExtensionContext): Promise<void> {
  const current = (await readConfig(context)).agentName;
  let names: string[] = [];
  if (mcpClient) {
    try {
      const res = await mcpClient.callTool({ name: "discover_agents", arguments: {} });
      const text = extractToolText(res);
      if (text) names = parseAgentNames(JSON.parse(text), current);
    } catch (err) {
      log(`switchAgent: discover_agents failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const picked = await pickAgentName(names, current);
  if (!picked || picked === current) return;
  // v0.2.3 R2 (codex) — Switch Agent is a workspace/global concept (not
  // per-folder). applyAgentSwitch writes at the effective WORKSPACE/GLOBAL
  // scope, reads the effective value back, and only claims success if it
  // actually moved; a folder-level override is surfaced honestly rather than
  // silently shadowed. The flow lives in switch-agent.ts so it's unit-tested
  // for real (not just the scope decision).
  await applyAgentSwitch(picked, {
    inspect: () =>
      vscode.workspace.getConfiguration("bot-relay.tether").inspect<string>("agentName"),
    update: (target, value) =>
      Promise.resolve(
        vscode.workspace
          .getConfiguration("bot-relay.tether")
          .update(
            "agentName",
            value,
            target === "workspace"
              ? vscode.ConfigurationTarget.Workspace
              : vscode.ConfigurationTarget.Global,
          ),
      ),
    readEffective: () =>
      vscode.workspace.getConfiguration("bot-relay.tether").get<string>("agentName"),
    info: (message) => void vscode.window.showInformationMessage(message),
    warn: (message) => void vscode.window.showWarningMessage(message),
  });
}

/** QuickPick over discovered agents (+ a free-text entry); falls back to a
 *  plain input box when discover_agents yielded nothing. */
async function pickAgentName(names: string[], current: string): Promise<string | undefined> {
  const ENTER = "$(edit) Enter a name…";
  if (names.length > 0) {
    const items: vscode.QuickPickItem[] = names.map((n) => ({ label: n }));
    items.push({ label: ENTER });
    const sel = await vscode.window.showQuickPick(items, {
      placeHolder: "Switch Tether to which agent's inbox?",
    });
    if (!sel) return undefined;
    if (sel.label !== ENTER) return sel.label;
  }
  return vscode.window.showInputBox({
    prompt: "Agent name to subscribe to",
    value: current,
    validateInput: (v) => (v.trim().length === 0 ? "Agent name cannot be empty" : undefined),
  });
}

function buildWebviewHtml(snapshot: InboxSnapshot | undefined): string {
  if (!snapshot) {
    return `<html><body><h2>Tether</h2><p>No snapshot yet — the relay may be unreachable.</p></body></html>`;
  }
  const safe = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const last = snapshot.last_message_preview
    ? `<p><b>Last from ${safe(snapshot.last_message_from ?? "?")}:</b> ${safe(snapshot.last_message_preview)}</p>`
    : "<p><i>Inbox empty.</i></p>";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Tether — ${safe(snapshot.agent_name)}</title>
<style>body{font:13px system-ui;padding:16px}h2{margin-top:0}small{color:#888}</style>
</head><body>
<h2>Tether — ${safe(snapshot.agent_name)}</h2>
<p>Pending: <b>${snapshot.pending_count}</b> &middot; Total: ${snapshot.total_count}</p>
${last}
<p><small>Open the dashboard for full traffic: <a href="http://127.0.0.1:3777">http://127.0.0.1:3777</a></small></p>
</body></html>`;
}

/**
 * v0.2 — adapter from vscode.window's terminal API to the
 * AgentManager's `TerminalApi` interface. AgentManager keeps the
 * vscode import out of its own module so it can be unit-tested
 * without monkey-patching node's loader.
 */
function buildTerminalApi(): TerminalApi {
  const adapt = (t: vscode.Terminal): ManagedTerminal => ({
    show: (preserveFocus?: boolean) => t.show(preserveFocus),
    sendText: (text: string, addNewLine?: boolean) => t.sendText(text, addNewLine),
    dispose: () => t.dispose(),
    get exitStatus(): { code: number | undefined } | undefined {
      return t.exitStatus ? { code: t.exitStatus.code } : undefined;
    },
  });
  // Map vscode.Terminal → ManagedTerminal lazily. We can't just stash
  // ManagedTerminal in createTerminal because vscode's
  // `onDidCloseTerminal` hands back a vscode.Terminal, not our
  // adapted view. So we maintain a small WeakMap to recover the
  // adapter for the same underlying Terminal.
  const adapters = new WeakMap<vscode.Terminal, ManagedTerminal>();
  function ensureAdapter(t: vscode.Terminal): ManagedTerminal {
    let a = adapters.get(t);
    if (!a) {
      a = adapt(t);
      adapters.set(t, a);
    }
    return a;
  }
  return {
    createTerminal(opts: ManagedTerminalOptions): ManagedTerminal {
      const t = vscode.window.createTerminal({
        name: opts.name,
        env: opts.env,
        cwd: opts.cwd,
        shellPath: opts.shellPath,
        shellArgs: opts.shellArgs,
        hideFromUser: opts.hideFromUser,
      });
      const adapter = adapt(t);
      adapters.set(t, adapter);
      return adapter;
    },
    onDidCloseTerminal(cb) {
      const sub = vscode.window.onDidCloseTerminal((t) => cb(ensureAdapter(t)));
      return { dispose: () => sub.dispose() };
    },
    showInformationMessage(msg: string) {
      return vscode.window.showInformationMessage(msg);
    },
    showWarningMessage(msg: string) {
      return vscode.window.showWarningMessage(msg);
    },
    showErrorMessage(msg: string) {
      return vscode.window.showErrorMessage(msg);
    },
  };
}

/**
 * v0.2 — guided prompt flow for Tether: Spawn Agent. Returns a fully
 * validated `AgentSpec` plus the resolved token, or null when the
 * operator cancels.
 */
async function promptForAgentSpec(
  context: vscode.ExtensionContext,
): Promise<{ spec: AgentSpec; tokenWasStored: boolean } | null> {
  const name = await vscode.window.showInputBox({
    title: "Tether: Spawn Agent — agent name",
    prompt:
      "Name the agent (used for RELAY_AGENT_NAME). Must match [A-Za-z0-9_.-]{1,64}.",
    validateInput: (v) => {
      const t = v.trim();
      if (t.length === 0) return "name required";
      if (!AGENT_NAME_RE.test(t)) return "allowed: A-Z a-z 0-9 _ . - (1-64 chars)";
      return null;
    },
    ignoreFocusOut: true,
  });
  if (!name) return null;
  const role = await vscode.window.showInputBox({
    title: "Tether: Spawn Agent — role",
    prompt: "Role (e.g. builder, researcher, reviewer).",
    value: "builder",
    validateInput: (v) => {
      const t = v.trim();
      if (t.length === 0) return "role required";
      if (!AGENT_NAME_RE.test(t)) return "allowed: A-Z a-z 0-9 _ . - (1-64 chars)";
      return null;
    },
    ignoreFocusOut: true,
  });
  if (!role) return null;
  const capsStr = await vscode.window.showInputBox({
    title: "Tether: Spawn Agent — capabilities",
    prompt:
      "Comma-separated capabilities (caps are LOCKED at first register — declare every cap the agent might ever need).",
    value: "build,test",
    validateInput: (v) => {
      const tokens = v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (tokens.length === 0) return "at least one capability required";
      for (const t of tokens) {
        if (!AGENT_NAME_RE.test(t)) return `invalid capability "${t}"`;
      }
      return null;
    },
    ignoreFocusOut: true,
  });
  if (capsStr === undefined) return null;
  const capabilities = capsStr
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Token — read per-agent SecretStorage first; if empty, prompt.
  // Operator can submit empty input to spawn token-less (SessionStart
  // hook will mint one via register_agent + vault). Operator can also
  // paste a fresh token to overwrite the stored value.
  let token: string | undefined;
  let tokenWasStored = false;
  let secretsReachable = true;
  try {
    token = await context.secrets.get(resolveAgentSecretKey(name.trim()));
  } catch (err) {
    log(
      `SecretStorage unreachable while reading per-agent token for "${name}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    secretsReachable = false;
  }
  if (!token || token.length === 0) {
    const env = process.env as Record<string, string | undefined>;
    const fallback = resolvePerAgentToken(name.trim(), undefined, env, undefined, secretsReachable);
    if (fallback.length > 0) {
      token = fallback;
    } else {
      const input = await vscode.window.showInputBox({
        title: `Tether: Spawn Agent — token for "${name.trim()}"`,
        prompt:
          "Paste agent token (stored in SecretStorage). Leave empty to let the relay mint one via SessionStart hook.",
        password: true,
        ignoreFocusOut: true,
      });
      if (input === undefined) return null; // operator cancelled
      const trimmed = input.trim();
      if (trimmed.length > 0) {
        if (secretsReachable) {
          try {
            await context.secrets.store(resolveAgentSecretKey(name.trim()), trimmed);
            tokenWasStored = true;
          } catch (err) {
            log(
              `SecretStorage store failed for "${name}": ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            // Fall through with token in memory only.
          }
        }
        token = trimmed;
      }
    }
  }

  return {
    spec: {
      name: name.trim(),
      role: role.trim(),
      capabilities,
      token: token && token.length > 0 ? token : undefined,
    },
    tokenWasStored,
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel(CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = STATUS_COMMAND;
  statusBarItem.text = "Tether: starting...";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // v0.2 — AgentManager. Constructed at activation so the
  // onDidChange listener wires up before any Spawn Agent command
  // could fire. inheritedEnv passes through the entire process
  // env so the spawned terminal has PATH, HOME, etc. — the relay's
  // SessionStart hook + claude CLI both need that surface intact.
  agentManager = new AgentManager({
    terminalApi: buildTerminalApi(),
    restartPolicy: new RestartPolicy(),
    scheduler: realScheduler(),
    inheritedEnv: process.env as Record<string, string | undefined>,
  });
  context.subscriptions.push({ dispose: () => agentManager?.dispose() });
  context.subscriptions.push(
    agentManager.onDidChange((snap) => {
      lastAgentSnapshot = snap;
      if (snap.spec) {
        renderExecutorStatusBar();
      } else if (lastSnapshot) {
        // Agent killed → fall back to inbox-only status bar if a
        // snapshot is available.
        applySnapshot(lastSnapshot);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(STATUS_COMMAND, () => {
      const panel = vscode.window.createWebviewPanel(
        "botRelayTether.inbox",
        "Tether Inbox",
        vscode.ViewColumn.Beside,
        { enableScripts: false },
      );
      panel.webview.html = buildWebviewHtml(lastSnapshot);
    }),
    vscode.commands.registerCommand("botRelayTether.reconnect", async () => {
      // v0.2.1 P1 — cancel any pending auto-reconnect + reset the backoff
      // curve: the operator is forcing a fresh attempt right now.
      reconnectSupervisor?.notifyManualReconnect();
      await connect(await readConfig(context));
      reconnectSupervisor?.notifyExternalConnect(!isInErrorState());
    }),
    // v0.2.3 (B) — Switch Agent: re-subscribe Tether to another agent's inbox
    // live (no reload). Pairs with the catch-up wake so switching to an agent
    // with pending mail wakes its terminal immediately.
    vscode.commands.registerCommand(SWITCH_AGENT_COMMAND, async () => {
      await runSwitchAgent(context);
    }),
    // v0.2 — single-agent executor commands.
    vscode.commands.registerCommand(SPAWN_AGENT_COMMAND, async () => {
      if (!agentManager) return;
      const existing = agentManager.snapshot();
      if (existing.spec && existing.status !== "idle" && existing.status !== "error") {
        const choice = await vscode.window.showWarningMessage(
          `Tether: an agent named "${existing.spec.name}" is already running (${existing.status}). Spawn a different one (kill the current first)?`,
          "Kill current + spawn new",
          "Cancel",
        );
        if (choice !== "Kill current + spawn new") return;
        agentManager.kill();
      }
      const result = await promptForAgentSpec(context);
      if (!result) return;
      try {
        agentManager.spawn(result.spec);
        void vscode.window.showInformationMessage(
          `Tether: spawned "${result.spec.name}" (role: ${result.spec.role})${
            result.tokenWasStored ? " — token stored in SecretStorage" : ""
          }.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`spawn failed: ${msg}`);
        void vscode.window.showErrorMessage(`Tether: spawn failed — ${msg}`);
      }
    }),
    vscode.commands.registerCommand(KILL_AGENT_COMMAND, () => {
      if (!agentManager) return;
      const snap = agentManager.snapshot();
      if (!snap.spec || snap.status === "idle") {
        void vscode.window.showInformationMessage(
          "Tether: no agent to kill.",
        );
        return;
      }
      agentManager.kill();
      void vscode.window.showInformationMessage(
        `Tether: killed "${snap.spec.name}".`,
      );
    }),
    vscode.commands.registerCommand(RESTART_AGENT_COMMAND, () => {
      if (!agentManager) return;
      agentManager.restart();
    }),
    // v0.1.3 [HIGH F10] — palette command to set / clear the agent
    // token via SecretStorage. `password: true` masks the input;
    // `ignoreFocusOut: true` keeps the box open while the operator
    // pastes (some terminals lose focus mid-paste). Empty input clears
    // the stored secret.
    // v0.2.0 R1 (Codex audit, P2) — the v0.2 executor-scope brief and the
    // v0.2.0 CHANGELOG entry both promise this command supports
    // per-agent tokens for the executor flow. R0 still wrote only
    // the singleton SECRET_KEY_AGENT_TOKEN, which the executor path
    // (resolveAgentSecretKey at config.ts:160) does not consume.
    //
    // R1 contract:
    //   - Prompt for an OPTIONAL agent name first.
    //   - Non-empty name (must match AGENT_NAME_RE) → write/clear at
    //     resolveAgentSecretKey(name) — the per-agent executor key.
    //   - Empty name → write/clear at SECRET_KEY_AGENT_TOKEN
    //     (singleton; preserved for v0.1.x observer backward compat).
    //   - Toast text confirms WHICH path ran so the operator can
    //     verify their fresh token is wired to the right consumer.
    vscode.commands.registerCommand(SET_TOKEN_COMMAND, async () => {
      const agentName = await vscode.window.showInputBox({
        title: "Tether: Set Agent Token — agent name (optional)",
        prompt:
          "Agent name to scope the token to. Leave EMPTY to set the legacy v0.1.x observer-mode singleton token. For the executor (Tether: Spawn Agent), enter the agent name (e.g. my-agent).",
        ignoreFocusOut: true,
        validateInput: (v) => {
          const t = v.trim();
          if (t.length === 0) return null; // empty → singleton path
          if (!AGENT_NAME_RE.test(t)) return "allowed: A-Z a-z 0-9 _ . - (1-64 chars), or leave empty";
          return null;
        },
      });
      if (agentName === undefined) return; // operator cancelled
      const namedAgent = agentName.trim();
      const tokenInput = await vscode.window.showInputBox({
        title: namedAgent.length > 0
          ? `Tether: Set Agent Token — token for "${namedAgent}"`
          : "Tether: Set Agent Token — observer-mode singleton",
        prompt:
          "Paste your bot-relay agent token. Stored in VSCode SecretStorage (OS keychain) — never written to settings.json. Submit empty to clear.",
        password: true,
        ignoreFocusOut: true,
      });
      if (tokenInput === undefined) return; // operator cancelled
      const trimmed = tokenInput.trim();
      // Resolve the target key BEFORE any side effect so a malformed
      // name name surfaces a clean error (resolveAgentSecretKey
      // throws on validation failure even though validateInput
      // above should have caught it — defense-in-depth).
      let storageKey: string;
      let scopeLabel: string;
      if (namedAgent.length > 0) {
        try {
          storageKey = resolveAgentSecretKey(namedAgent);
          scopeLabel = `agent "${namedAgent}"`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Tether: ${msg}`);
          return;
        }
      } else {
        storageKey = SECRET_KEY_AGENT_TOKEN;
        scopeLabel = "observer-mode singleton (v0.1.x backward compat)";
      }
      try {
        if (trimmed.length === 0) {
          await context.secrets.delete(storageKey);
          void vscode.window.showInformationMessage(
            `Tether: Token cleared for ${scopeLabel}.`,
          );
        } else {
          await context.secrets.store(storageKey, trimmed);
          void vscode.window.showInformationMessage(
            `Tether: Token stored for ${scopeLabel}.`,
          );
        }
        await connect(await readConfig(context));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`SET_TOKEN failed (scope=${scopeLabel}): ${msg}`);
        void vscode.window.showErrorMessage(
          `Tether: failed to update token for ${scopeLabel} — ${msg}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("bot-relay.tether")) {
        const fresh = await readConfig(context);
        ensureSummaryTimer(fresh.notificationLevel);
        await connect(fresh);
      }
    }),
  );

  // v0.1.3 [HIGH F10] — one-shot SecretStorage migration runs BEFORE
  // the first readConfig so a freshly-migrated token surfaces on the
  // initial connect attempt without an extra reload.
  await migrateAgentTokenToSecretStorage(context);

  // v0.2.1 P1 — wire the auto-reconnect supervisor BEFORE the first connect
  // so a startup-while-daemon-down also self-heals. Backoff is delegated to
  // RestartPolicy in neverGiveUp mode (O-2): a down/restarting daemon is
  // retried indefinitely; the 5/hr cap stays only on the child-process
  // crash-loop path (AgentManager above). Production timer = setTimeout.
  // v0.3.0 PID-handshake — compute THIS instance's machine GUID once (the
  // host-scoping anchor; must match the agent-side hook's host_id), and
  // invalidate the bound-terminal cache when a terminal closes.
  const hostPlatform = toHostPlatform(process.platform);
  localHostId = hostPlatform
    ? machineGuid(hostPlatform, (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 2000 }))
    : null;
  log(`pid-handshake: local host_id = ${localHostId ?? "(unavailable)"}`);
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => {
      for (const [name, term] of boundTerminals) {
        if (term === closed) boundTerminals.delete(name);
      }
    }),
  );
  // Per-agent wake gates are created lazily in connect() via getWakeGate (one
  // per watched agent), persisting across reconnects so each agent's
  // no-double-wake mark survives. v0.3.0: the wake is async (PID resolution) —
  // fire-and-forget; the gate advances its mark synchronously, so there's no
  // double-wake window.
  reconnectSupervisor = new ReconnectSupervisor({
    // v0.4.1 — equalJitter decorrelates a fleet of Tether windows / watched
    // agents so they don't retry a just-restarted daemon in lockstep. Enabled
    // ONLY here (the reconnect path); the child-process crash-loop policy in
    // AgentManager keeps its deterministic curve.
    policy: new RestartPolicy({ neverGiveUp: true, equalJitter: true }),
    connect: async () => {
      await connect(await readConfig(context));
      return !isInErrorState();
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    log,
    onReconnecting: (attempt, delayMs) => setReconnectingState(attempt, delayMs),
    onReconnected: () => {
      // connect() already painted the healthy snapshot; re-apply the latest
      // snapshot defensively so the amber "reconnecting…" text can't linger.
      if (lastSnapshot) applySnapshot(lastSnapshot);
    },
    onUnrecoverable: (msg) => setErrorState(msg),
  });
  context.subscriptions.push({ dispose: () => reconnectSupervisor?.dispose() });

  const initial = await readConfig(context);
  ensureSummaryTimer(initial.notificationLevel);
  // Wrap the initial connect: a startup-time daemon-down must hand off to the
  // supervisor (indefinite backoff) rather than reject activation.
  try {
    await connect(initial);
    reconnectSupervisor.notifyExternalConnect(!isInErrorState());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`initial connect failed: ${msg} — handing to reconnect supervisor`);
    reconnectSupervisor.handleError(msg);
  }
}

export async function deactivate(): Promise<void> {
  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = undefined;
  }
  // v0.2.1 P1 — tear down the supervisor first so a scheduled auto-reconnect
  // can't fire a fresh connect() during/after teardown (no reconnect storm,
  // no leaked timer).
  reconnectSupervisor?.dispose();
  reconnectSupervisor = undefined;
  wakeGates.clear();
  // v0.4.1 — stop the health-poll (no leaked timer) and reset the connection
  // lifecycle so the imminent transport close is swallowed (flag raised, both
  // transports forgotten) rather than treated as a drop.
  stopHealthPoll();
  connectionLifecycle.reset();
  await disconnect();
}
