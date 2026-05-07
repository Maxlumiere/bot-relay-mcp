# Changelog — Tether for bot-relay-mcp (VSCode)

All notable changes to the Tether VSCode extension are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The marketplace surfaces this file directly on the extension's listing page, so each entry is written for end-users — what changed, why it matters, what to do if anything.

## [0.1.0] — 2026-05-07

Initial public release. Ships with bot-relay-mcp v2.5.0+.

### Added

- **MCP inbox subscription.** The extension dials the local bot-relay daemon over its Streamable HTTP transport (default `http://127.0.0.1:3777/mcp`) and subscribes to `relay://inbox/<your-agent-name>`. Inbox changes arrive as MCP `ResourceUpdated` notifications — no polling, no fan-out, no traffic when nothing is happening.
- **Status bar tile.** A new status-bar item (left side) shows pending message count + last-message recency in the form `Tether: <count> | last <time>`. Color tracks severity:
  - gray when 0 pending,
  - yellow when 1-3 pending,
  - red when 4+ pending.
- **Click-to-open inbox panel.** Clicking the status bar opens a read-only webview with the most recent snapshot — pending count, total count, and a preview of the last message. Includes a link to the bot-relay dashboard at `http://127.0.0.1:3777`.
- **Optional auto-typing into integrated terminal.** When `bot-relay.tether.autoInjectInbox` is enabled, every inbox notification writes the literal string `inbox\n` into the integrated terminal whose name matches your agent. Useful when the agent's terminal IS the same name as the inbox — Claude Code wakes up immediately. Off by default to avoid surprising ambient typing.
- **Tunable notifications.** `bot-relay.tether.notificationLevel` chooses between:
  - `event` (default) — toast on every inbox change,
  - `summary` — collapsed digest every 5 minutes,
  - `none` — silent (status bar only).
- **Output channel for diagnostics.** `View → Output → Tether for bot-relay-mcp` shows connection state, refresh attempts, and per-event log lines for troubleshooting.
- **Reconnect command.** `Cmd/Ctrl+Shift+P → Tether: Reconnect to Relay` re-establishes the connection without reloading the window — useful after restarting the daemon.

### Configuration

All settings are under `bot-relay.tether.*`:

| Setting | Default | Description |
|---|---|---|
| `endpoint` | `http://127.0.0.1:3777` | HTTP endpoint of the local bot-relay daemon. |
| `agentName` | `""` | Agent name to subscribe to. Empty falls back to `RELAY_AGENT_NAME` env; with neither set the extension stays idle. |
| `agentToken` | `""` | Optional agent token for authenticated relays. Empty falls back to `RELAY_AGENT_TOKEN` env. |
| `autoInjectInbox` | `false` | On every notification, write the literal string `inbox\n` into the matching integrated terminal. |
| `notificationLevel` | `event` | `event` (toast each change), `summary` (5-min digest), `none` (silent). |

### Compatibility

- Requires VS Code `^1.85.0` (released Nov 2023).
- Requires a running bot-relay-mcp daemon. The daemon ships in [`bot-relay-mcp` on npm](https://www.npmjs.com/package/bot-relay-mcp); install via `npm install -g bot-relay-mcp` then start with `relay test` (or your operator config).
- macOS, Linux, Windows all supported — the extension is pure TypeScript / VS Code API, no native modules.

### Privacy

- Local-only by default. No telemetry, no cloud, no network calls beyond the configured `endpoint`.
- Agent token (when set) is sent as `X-Agent-Token` header to the configured endpoint only.
- The webview panel is read-only and has scripts disabled (`enableScripts: false`).

### Known limitations

- The first connection on extension activation can take up to ~1s if the daemon is still starting. The status bar shows `Tether: starting...` until the first snapshot arrives.
- Auto-typing only matches a terminal whose `name` equals the configured `agentName` exactly. If your terminal name differs (e.g. operator renamed it), auto-injection falls back to the active terminal.
- The summary digest interval is fixed at 5 minutes (not currently user-configurable).

### Coming next

- v0.2.0 candidates: bundled JS (smaller VSIX), extension icon, configurable digest interval, multi-agent subscription, dashboard auth via `bot-relay.tether.dashboardSecret`.
