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
  type InboxSnapshot,
} from "./format.js";
import { resolveTetherConfig, type TetherConfig } from "./config.js";

const CHANNEL_NAME = "Tether for bot-relay-mcp";
const STATUS_COMMAND = "botRelayTether.openInbox";

function readConfig(): TetherConfig {
  // R1 #3: route through the pure resolveTetherConfig() so the precedence
  // rule (VSCode setting > env > default) is verifiable in unit tests
  // without booting VSCode. Pre-R1 the inline `?:` chain bound after `||`,
  // ignoring the VSCode-configured endpoint when env was set.
  const cfg = vscode.workspace.getConfiguration("bot-relay.tether");
  return resolveTetherConfig(
    (key) => cfg.get(key),
    process.env as Record<string, string | undefined>,
  );
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

  log(`connecting to ${config.endpoint}/mcp as agent="${config.agentName}"`);
  const url = new URL("/mcp", config.endpoint);
  // The SDK's StreamableHTTPClientTransport accepts request init for
  // header injection; the relay's HTTP transport reads X-Agent-Token
  // for auth (see src/transport/http.ts).
  const requestInit: RequestInit = {};
  if (config.agentToken) {
    requestInit.headers = { "X-Agent-Token": config.agentToken };
  }
  const transport = new StreamableHTTPClientTransport(url, { requestInit });
  const client = new Client(
    { name: "bot-relay-tether-vscode", version: "0.1.0" },
    { capabilities: {} },
  );
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
    const wantUri = buildInboxUri(config.agentName);
    if (notification.params.uri !== wantUri) return;
    log(`event: ${notification.params.uri}`);
    const fresh = await refreshSnapshot(client, config.agentName);
    if (!fresh) return;
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
  if (initial) applySnapshot(initial);
  log("connected + subscribed");
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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel(CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = STATUS_COMMAND;
  statusBarItem.text = "Tether: starting...";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

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
      await connect(readConfig());
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("bot-relay.tether")) {
        const fresh = readConfig();
        ensureSummaryTimer(fresh.notificationLevel);
        await connect(fresh);
      }
    }),
  );

  const initial = readConfig();
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
