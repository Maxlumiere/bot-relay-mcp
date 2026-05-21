# Changelog — Tether for bot-relay-mcp (VSCode)

All notable changes to the Tether VSCode extension are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The marketplace surfaces this file directly on the extension's listing page, so each entry is written for end-users — what changed, why it matters, what to do if anything.

## [0.1.3] — 2026-05-13 — SECURITY: token storage migration to VSCode SecretStorage

### Security

- **[HIGH] Agent token now stored in VSCode SecretStorage** (OS keychain on macOS, Credential Vault on Windows, libsecret on Linux) instead of plaintext `settings.json`. The previous `bot-relay.tether.agentToken` configuration field exposed the credential to settings sync, dotfile backups, accidental screenshots, and shoulder-glance. (Origin: Hermes external review via review-Victra deep-review synthesis msg `2b903f9b`.)

### Added

- **First-launch migration.** On activation, if an existing plaintext `bot-relay.tether.agentToken` value is present in `settings.json` AND no SecretStorage value exists, the extension copies the value into SecretStorage, removes the field from `settings.json` (both Global + Workspace targets), and shows a one-shot warning notification recommending you rotate the token via `relay rotate-token` since the previous plaintext value may have been captured in backups. The notification offers "Reconnect with new token", "View rotation docs", and "Dismiss" actions; the flag persists in globalState so the recommendation fires exactly once per install.
- **`Tether: Set Agent Token (SecretStorage)` palette command.** New command (`botRelayTether.setToken`) prompts via a password-masked input box and stores the value via `context.secrets.store`. Submit empty input to clear the stored secret. After write, the extension reconnects automatically with the new value.

### Removed

- **`bot-relay.tether.agentToken` from the contributes.configuration schema.** Operators upgrading from v0.1.2 see the migration banner once; the setting no longer appears in the VSCode settings UI. Use the palette command above for ongoing changes.

### Compatibility

- Token-resolution precedence is now **SecretStorage > `RELAY_AGENT_TOKEN` env var > legacy settings.json** (the third tier is read only during the migration window and removed once the migration step runs). v0.1.3 against `bot-relay-mcp` v2.7.1 daemon is the recommended pairing; older daemons still authenticate the same way (the daemon never saw `settings.json`).
- VSCode SecretStorage API is identical across macOS / Windows / Linux at the JS surface; no platform-specific code path. Linux/headless hosts without libsecret fall back to `RELAY_AGENT_TOKEN` env ONLY; the legacy `settings.json` fallback is intentionally disabled when SecretStorage is unreachable (R1 security contract — see the Hardening section below). Install libsecret/gnome-keyring and reload VSCode to enable SecretStorage persistence, or set `RELAY_AGENT_TOKEN` env, or use the `Tether: Set Agent Token (SecretStorage)` palette command once SecretStorage is reachable.

### Hardening (R1, codex audit follow-up)

Codex audit on the initial v0.1.3 PR caught a P2 finding: when the SecretStorage backend is UNREACHABLE (Linux without libsecret, or transient failure), the pre-R1 code path fell through to the legacy plaintext `settings.json` value — silently re-promoting the exact leak v0.1.3 was built to close. v0.1.3 R1 splits the two empty-secret cases:

- **SecretStorage reachable + secret value empty** (operator hasn't set one yet): legacy plaintext fallback IS consulted, preserving the upgrade-from-v0.1.2 migration window.
- **SecretStorage UNREACHABLE** (backend error): legacy plaintext fallback is SKIPPED. Token resolves env-only (`RELAY_AGENT_TOKEN`); if env is also empty, the extension goes idle until the operator either installs the OS keychain backend (libsecret on Linux) and reloads VSCode, OR uses the new `Tether: Set Agent Token (SecretStorage)` palette command, OR sets `RELAY_AGENT_TOKEN` in their environment.

A one-shot warning notification surfaces the degraded mode visibly to the operator (per codex's "preferably visible warning/error" recommendation) so the failure isn't silent in the Tether output channel only. The notification fires once per install (tracked in globalState) and offers a "View install docs" action button.

### References

- v2.7.1 hotfix brief F10 + the maintainer's lock 2026-05-13.
- Cross-platform parity verified per `feedback_cross_platform_parity.md`.
- R1 audit finding from codex-5-5 msg `561cf7c9`; R1 dispatch from victra msg `c6f9ee92`.

## [0.1.2] — 2026-05-12 — Reconnect resilience + discoverable manual reconnect

End-to-end smoke against a real Electron-based VS Code session validated the v0.1.1 diagnostics together with the daemon-side Phase 3/4/5 fixes (cross-process outbox, reaper-skip-while-SSE-open, SSE keepalive). v0.1.2 ships two extension-side changes that pair with the daemon's `bot-relay-mcp` v2.6.3 release:

### Added

- **Configurable SDK reconnection options.** The transport constructor now passes `reconnectionOptions: { initialReconnectionDelay: 1000, maxReconnectionDelay: 30000, reconnectionDelayGrowFactor: 1.5, maxRetries: 20 }` to `StreamableHTTPClientTransport`. The SDK default is `maxRetries: 2`, which exhausts in under 2 seconds on any transient network blip — far too aggressive for a long-running editor extension. With `maxRetries: 20` and exponential backoff (1 s × 1.5^attempt, capped at 30 s), the SDK rides out daemon restarts and brief network hiccups for roughly 6 minutes 45 seconds of accumulated wait before surfacing failure.
- **Discoverable manual reconnect on retry exhaustion.** When the SDK's retry budget is exhausted, the status bar now reads `Tether: error — run "Tether: Reconnect to Relay"` (was a generic `Tether: error — see Output channel` message in v0.1.1). The palette command `Tether: Reconnect to Relay` was already available since v0.1.0; this surfaces it where operators look when something goes wrong.

### Compatibility

- Requires `bot-relay-mcp` daemon v2.6.3 or later. The daemon-side SSE keepalive frames (released as part of the same v2.7-track work) are what prevent Electron's `fetch` from declaring the response stream idle and aborting it after ~2.5 minutes. v0.1.2 will run against older daemons but will silently degrade to the same Electron-idle disconnect class v0.1.0 exhibited.

### References

- Phase 4b commit `270acad` in the upstream bot-relay-mcp tree: source-level reconnectionOptions + status-bar text change. Drift guard at `tests/v2-7-tether-reconnection-options.test.ts` pins the contract against both `src/` and the compiled `out/extension.js` that ships in the VSIX.
- Phase 5 commit `6ec32d6` in the upstream bot-relay-mcp tree: daemon-side SSE keepalive comment frames (the load-bearing fix for Electron-fetch idle timeouts).
- Smoke validation: end-to-end Electron-based VS Code test at 2026-05-12, all signals (status-bar count update, toast, `event:` log line, daemon broadcast-trace) fired cleanly.

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
