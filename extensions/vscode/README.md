# Tether for bot-relay-mcp

A VSCode extension that subscribes to a bot-relay-mcp agent's inbox over MCP and surfaces pending mail in the status bar (and optionally as toasts). Local-only, no telemetry, no cloud.

## Install (dev / pre-marketplace)

```sh
cd extensions/vscode
npm install
npm run compile
# In VSCode: F5 to launch the Extension Development Host with this extension loaded.
```

Marketplace install steps land here once published — see `PUBLISH.md` for the publish workflow.

## Configuration

Settings are under `bot-relay.tether.*`:

| Setting | Default | What it does |
|---|---|---|
| `endpoint` | `http://127.0.0.1:3777` | Relay HTTP endpoint. The extension speaks MCP over Streamable HTTP to this URL. |
| `agentName` | (env: `RELAY_AGENT_NAME`) | Which agent's inbox to subscribe to. Empty + no env = idle. |
| `agentToken` | (env: `RELAY_AGENT_TOKEN`) | Optional bearer token for authenticated relays. Sent as `X-Agent-Token` header. |
| `autoInjectInbox` | `false` | On every notification, type `inbox\n` into the matching integrated terminal. Useful when the terminal name matches the agent name (Claude Code sets the terminal title via `--name`). Off by default to avoid surprising ambient typing. |
| `notificationLevel` | `event` | `event` = toast on every change. `summary` = collapsed digest every 5 min. `none` = silent (status bar only). |

VSCode setting > env var > default.

## What it does

1. On startup, reads config + env, connects to the relay at `endpoint/mcp`.
2. Subscribes to `relay://inbox/<agentName>`.
3. Status bar (left) shows: `Tether: <pending_count> | last <relative time>`. Color: gray for 0 pending, yellow 1-3, red 4+.
4. On every `notifications/resources/updated` event for that URI, re-fetches the resource snapshot and (per `notificationLevel`) emits a toast.
5. Click the status bar → opens a read-only webview with the last message preview + a link to the full dashboard at `http://127.0.0.1:3777`.
6. If `autoInjectInbox=true`, also writes `inbox\n` to the integrated terminal whose name matches `agentName` (or the active terminal if no match).

## What it doesn't do

- No interactive features (no send_message, no acknowledge buttons). v0.1 is read-only awareness; interaction lands in v2 along with the rest of the paid Tether Cloud surface — see `../../docs/tether-roadmap.md`.
- No cross-machine sync. The extension only speaks to a relay running on `127.0.0.1` (or whatever you configure as `endpoint`). There is no federation, no hosted broker.
- No telemetry, no analytics, no third-party calls.

## Troubleshooting

The extension publishes a `Tether for bot-relay-mcp` output channel — every connection attempt + error lands there. View → Output → "Tether for bot-relay-mcp" in the dropdown.

- **Status bar stuck on "Tether: starting..."**: the connect call is in progress. Check the output channel for `connecting to ...`.
- **"Tether: idle"**: `agentName` is empty in both VSCode setting and env. Set `bot-relay.tether.agentName` (or export `RELAY_AGENT_NAME` before launching VSCode).
- **Repeated reconnect attempts**: the relay daemon is unreachable. Check `curl http://127.0.0.1:3777/health` and `relay doctor`.

## License

MIT — same as `bot-relay-mcp`. See repo root `LICENSE`.
