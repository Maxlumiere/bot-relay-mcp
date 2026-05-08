# Changelog — Tether for bot-relay-mcp (VSCode)

All notable changes to the Tether VSCode extension are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The marketplace surfaces this file directly on the extension's listing page, so each entry is written for end-users — what changed, why it matters, what to do if anything.

## [0.1.1] — 2026-05-08 — Pre-publish hotfix: transport diagnostics (instrumentation only)

v0.1.0 visual marketplace smoke caught a silent-failure window: the extension reported `connected + subscribed` in its output channel but no inbox notifications were ever observed on send. Root cause: `extension.ts` did not wire `transport.onerror`, and the SDK's `_startOrAuthSse()` path that opens the long-lived SSE GET stream (the channel notifications travel down to idle subscribers) silently swallows errors when `onerror` is unset (`@modelcontextprotocol/sdk` `dist/esm/client/streamableHttp.js:374-376` — `.catch(err => this.onerror?.(err))` is a no-op when `onerror` is undefined).

This release wires diagnostics so the next failure surfaces. It does NOT yet fix whatever actually breaks the SSE GET stream inside VS Code's Electron-based fetch runtime — that's the v0.1.2+ structural fix once we see what error the diagnostics reveal.

### Added

- **Transport diagnostics**. `transport.onerror` now flips the connection into a sticky error state (status bar reads `Tether: error — see Output channel` with the standard error background color), and `transport.onclose` logs to the output channel for visibility into session teardown. Wired BEFORE `client.connect()` so the SDK's protocol-level wrapper (`Protocol._connect` at `protocol.js:220-228`) preserves and chains our handler instead of replacing it. Order pinned by drift guard `tests/v2-6-tether-transport-diagnostics.test.ts`.
- **Sticky error-state lock**. Once a transport error fires, the `connected + subscribed` log line + status-bar success-text + initial-snapshot paint are all suppressed until the next explicit reconnect (config change OR `Tether: Reconnect to Relay` command). Prevents async failures from being silently overwritten by the success path. Verified by the helper's unit tests in `extensions/vscode/src/transport-diagnostics.test.ts`.
- **Helper extracted to `transport-diagnostics.ts`**. VSCode-free, unit-testable. Mirrors the `Transport` interface as a structural subset so the test rig doesn't need the full SDK.

### Fixed

- Nothing yet — this release surfaces the bug in operator-visible UI but does not resolve the underlying SSE GET stream failure inside VS Code's runtime. Operators who see `Tether: error` after upgrading should report the error message from the output channel; the v0.1.2 release will use that signal to land the actual fix.

### References

- Root-cause investigation: bot-relay relay msg `18362476` (2026-05-08).
- Audit verifying daemon-side broadcast contract is intact: msg `4eb34932` (2026-05-08).
- Daemon repros (Node SDK + live `:3777`) confirming notifications/resources/updated frames flow correctly to Node-based subscribers — proves the bug is VS Code runtime-specific, not a daemon issue.

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
