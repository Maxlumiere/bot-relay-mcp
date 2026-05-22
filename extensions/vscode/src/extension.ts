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
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
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

const CHANNEL_NAME = "Tether for bot-relay-mcp";
const STATUS_COMMAND = "botRelayTether.openInbox";
const SET_TOKEN_COMMAND = "botRelayTether.setToken";
const SPAWN_AGENT_COMMAND = "botRelayTether.spawnAgent";
const KILL_AGENT_COMMAND = "botRelayTether.killAgent";
const RESTART_AGENT_COMMAND = "botRelayTether.restartAgent";
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
 * Hermes deep-review flagged that v0.1.2 stored the agent token via
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
let summaryTimer: ReturnType<typeof setInterval> | undefined;
let summaryDirty = false;

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

function injectInboxKeystroke(agentName: string): void {
  // Find a terminal whose name matches the agent name (Claude Code +
  // bin/spawn-agent.sh both set the title via `--name`). If none match,
  // fall back to the active terminal so the operator sees something
  // happen rather than nothing.
  const match = vscode.window.terminals.find((t) => t.name === agentName);
  const target = match ?? vscode.window.activeTerminal;
  if (!target) {
    log(`auto-inject skipped: no terminal named "${agentName}" and no active terminal`);
    return;
  }
  target.sendText("inbox", true);
  log(`auto-inject: wrote "inbox\\n" to terminal "${target.name}"`);
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
  if (!config.agentName) {
    log("idle: no agentName configured (set bot-relay.tether.agentName or RELAY_AGENT_NAME)");
    if (statusBarItem) {
      statusBarItem.text = "Tether: idle";
      statusBarItem.backgroundColor = undefined;
      statusBarItem.show();
    }
    return;
  }
  await disconnect();
  // v0.1.1 — fresh connect attempt resets the error-state lock. Any
  // previously-flipped error from a prior session is cleared so a manual
  // reconnect (or a config-change-driven reconnect) can recover.
  resetErrorState();

  log(`connecting to ${config.endpoint}/mcp as agent="${config.agentName}"`);
  const url = new URL("/mcp", config.endpoint);
  // The SDK's StreamableHTTPClientTransport accepts request init for
  // header injection; the relay's HTTP transport reads X-Agent-Token
  // for auth (see src/transport/http.ts).
  const requestInit: RequestInit = {};
  if (config.agentToken) {
    requestInit.headers = { "X-Agent-Token": config.agentToken };
  }
  // v0.1.2 Tether Phase 4 — raise the SDK's hardcoded
  // `maxRetries: 2` default (see
  // `node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:10`
  // — DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS). 2 retries is too
  // aggressive for a long-running editor extension: a transient TCP
  // hiccup or daemon restart can exhaust the budget in <2 s, after
  // which the extension wedges until manual reconnect.
  //
  // With maxRetries: 20 + exponential backoff (1 s × 1.5^attempt,
  // capped at 30 s), accumulated wait before giving up is roughly
  // 6.75 min — long enough to ride out a daemon restart but bounded
  // so a wedged daemon doesn't loop silently forever. When the
  // budget IS exhausted, the error path now points at the
  // `Tether: Reconnect to Relay` command via setErrorState() so
  // manual recovery is discoverable.
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit,
    reconnectionOptions: {
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 30_000,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 20,
    },
  });

  // v0.1.1 — wire transport diagnostics BEFORE client.connect(). The SDK
  // (Protocol._connect at node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:220-228)
  // PRESERVES preexisting transport.onerror/onclose and WRAPS them on
  // connect. Wiring AFTER connect would replace the SDK's protocol-level
  // wrapper and break protocol-level error propagation. The order is
  // load-bearing — the drift guard at tests/v2-6-tether-transport-diagnostics.test.ts
  // pins this contract.
  wireTransportDiagnostics(transport, {
    log,
    setError: setErrorState,
  });

  const client = new Client(
    { name: "bot-relay-tether-vscode", version: getExtensionVersion() },
    { capabilities: {} },
  );
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
    const wantUri = buildInboxUri(config.agentName);
    if (notification.params.uri !== wantUri) return;
    log(`event: ${notification.params.uri}`);
    const fresh = await refreshSnapshot(client, config.agentName);
    if (!fresh) return;
    if (isInErrorState()) return; // state-lock — don't paint snapshot over an error UI
    applySnapshot(fresh);
    showToast(fresh, config.notificationLevel);
    if (config.autoInjectInbox) injectInboxKeystroke(config.agentName);
  });

  await client.connect(transport);
  mcpClient = client;
  mcpTransport = transport;

  // Subscribe + prime the status bar with an initial fetch.
  await client.subscribeResource({ uri: buildInboxUri(config.agentName) });
  const initial = await refreshSnapshot(client, config.agentName);
  // v0.1.1 — state-lock guard: an async transport error (SSE GET stream
  // open failure, header-mismatch close, etc.) may have fired between
  // the start of connect() and here. If it did, setErrorState already
  // flipped the status bar to "Tether: error". Don't overwrite it with
  // an apparent-success snapshot or "connected + subscribed" log.
  if (initial && !isInErrorState()) applySnapshot(initial);
  if (!isInErrorState()) {
    log("connected + subscribed");
  }
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
      await connect(await readConfig(context));
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
    vscode.commands.registerCommand(SET_TOKEN_COMMAND, async () => {
      const input = await vscode.window.showInputBox({
        title: "Tether: Set Agent Token",
        prompt:
          "Paste your bot-relay agent token. Stored in VSCode SecretStorage (OS keychain) — never written to settings.json. Submit empty to clear.",
        password: true,
        ignoreFocusOut: true,
      });
      if (input === undefined) return; // user dismissed
      const trimmed = input.trim();
      try {
        if (trimmed.length === 0) {
          await context.secrets.delete(SECRET_KEY_AGENT_TOKEN);
          void vscode.window.showInformationMessage("Tether: Agent token cleared from SecretStorage.");
        } else {
          await context.secrets.store(SECRET_KEY_AGENT_TOKEN, trimmed);
          void vscode.window.showInformationMessage("Tether: Agent token stored in SecretStorage.");
        }
        await connect(await readConfig(context));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`SET_TOKEN failed: ${msg}`);
        void vscode.window.showErrorMessage(`Tether: failed to update agent token — ${msg}`);
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

  const initial = await readConfig(context);
  ensureSummaryTimer(initial.notificationLevel);
  await connect(initial);
}

export async function deactivate(): Promise<void> {
  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = undefined;
  }
  await disconnect();
}
