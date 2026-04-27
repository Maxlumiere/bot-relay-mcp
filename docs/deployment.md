# Deployment

This doc covers runtime/launch concerns for operators running `bot-relay-mcp` — picking a transport, running as a daemon, and the stdio TTY guard.

## Transports

- **`stdio`** (default) — per-process MCP client spawns. Each Claude Code / Cursor / Cline terminal launches its own `node dist/index.js` and speaks JSON-RPC on stdin/stdout. Zero infrastructure. This is what ~/.claude.json `"type":"stdio"` uses.
- **`http`** — long-running daemon on a port (default 3777). Multiple stdio clients share state through the common SQLite DB, and remote MCP clients can connect via HTTP. Set `RELAY_TRANSPORT=http` and `RELAY_HTTP_PORT=3777`.
- **`both`** — stdio transport *and* an HTTP server in the same process. Rare; used mostly for development.

## Running as a daemon

For the HTTP daemon:

```bash
RELAY_TRANSPORT=http RELAY_HTTP_PORT=3777 node dist/index.js
```

See the live daemon pattern in `HANDOFF.md` and the `relay doctor --remote` runbook in `docs/multi-machine-deployment.md`.

## stdio TTY guard

When `transport=stdio`, `bot-relay-mcp` checks whether stdin is a TTY. Running `node dist/index.js` with non-TTY stdin in a background shell is almost always a mistake: the stdio transport exits the moment stdin closes, so the "daemon" dies silently as soon as the invoking shell finishes the command.

### Heuristic (v2.4.2+)

If `transport=stdio` and stdin is not a TTY, the relay waits **up to 1500ms** for any bytes to arrive on stdin:

- **Bytes arrive** → treat as a legitimate MCP client (Claude Code, Cursor, Cline, …), cancel the guard, unshift the bytes back so the MCP transport reads the full frame, and proceed.
- **Timer expires with zero bytes** → exit with code 3 and a helpful error message pointing to the three usual fixes (set `RELAY_TRANSPORT=http`, run with `--transport=http --port=3777`, or attach a real TTY).

The received bytes are preserved via `process.stdin.unshift(chunk)`, so the MCP SDK's stdio transport downstream reads the JSON-RPC frame unchanged.

### Configuration

- `RELAY_SKIP_TTY_CHECK=1` — bypass the guard entirely. Useful for test harnesses whose first frame lands later than 1500ms, or for deliberate piped-stdin deployments.
- `RELAY_TTY_GRACE_MS=<milliseconds>` — override the 1500ms grace window. Tests drive this tight (300ms) to keep suite runtime low; production should leave it at the default.

### History

v2.2.1 introduced the guard as an immediate exit on non-TTY stdin. That over-corrected: every post-v2.2.1 MCP client launch silently failed until the operator set `RELAY_SKIP_TTY_CHECK=1` in their `~/.claude.json` env block. v2.4.2 refined the guard to the 1500ms heuristic above, so the workaround env entry can be removed from `~/.claude.json` (non-destructive — leaving it in place also works).
