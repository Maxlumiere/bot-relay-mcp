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

See the `relay doctor --remote` runbook in `docs/multi-machine-deployment.md`.

## stdio TTY guard

When `transport=stdio`, `bot-relay-mcp` checks whether stdin is a TTY. Running `node dist/index.js` with non-TTY stdin in a background shell is almost always a mistake: the stdio transport exits the moment stdin closes, so the "daemon" dies silently as soon as the invoking shell finishes the command.

### Guard (current)

If `transport=stdio` and stdin is not a TTY, the relay waits on an **event**, not a duration:

- **stdin becomes readable** → a client is there. Treat as a legitimate MCP client (Claude Code, Cursor, Cline, …), cancel the guard, and proceed.
- **stdin reaches `end` (EOF)** → nobody is ever coming. Exit with code 3 and a helpful error message pointing to the three usual fixes (set `RELAY_TRANSPORT=http`, run with `--transport=http --port=3777`, or attach a real TTY).

There is **no time limit and no window to tune.** A client that takes ten seconds to send its first frame is still a client, and the guard waits for it.

The received bytes are preserved via a `PassThrough` proxy: `process.stdin` is piped into the proxy, the guard watches the proxy's `readable` event without consuming anything, and the same proxy is handed to the MCP SDK's stdio transport — so the SDK reads the JSON-RPC frame unchanged from the stream that already buffered it. (An earlier shape used `process.stdin.unshift(chunk)` to "give the bytes back"; a Codex repro proved that drops the first frame, so it was retired.)

### Configuration

- `RELAY_SKIP_TTY_CHECK=1` — bypass the guard entirely. Still supported, for deliberate piped-stdin deployments.

> **REMOVED: `RELAY_TTY_GRACE_MS`.** This variable configured the old grace window and **is now ignored.** It is not deprecated-but-honoured — the window it configured no longer exists, so setting it has no effect at all. If you set it to work around a client that was slow to send its first frame, **you can delete it**: the guard now waits for that client indefinitely and only gives up on EOF. Nothing that previously worked stops working.

### History

v2.2.1 introduced the guard as an immediate exit on non-TTY stdin. That over-corrected: every post-v2.2.1 MCP client launch silently failed until the operator set `RELAY_SKIP_TTY_CHECK=1` in their `~/.claude.json` env block. v2.4.2 softened it to a 1500ms grace window, so the workaround env entry could be removed from `~/.claude.json` (non-destructive — leaving it in place also works).

The 1500ms window was itself wrong, and in a way nobody had reported because nobody had tried: **it exited before any container could start.** Measured against the published binary, a client connecting at 3000ms got exit 3 at ~1675ms — it never saw the server. That is the ordinary case for container runtimes, systemd units, process supervisors and MCP proxies, where stdin is a pipe and the client connects on its own schedule.

The current guard replaces the undecidable question *"has enough time passed?"* with a decidable one: *"is anyone there?"* — readable means yes, EOF means no. The original mistake it was built to catch (running the stdio server where a daemon was meant) is still caught: stdin closed with no client is still exit 3.
