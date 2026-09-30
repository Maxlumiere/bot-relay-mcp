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

## Upgrading across the UTC start-token change

The relay tells a live window from a dead one, and from a process that reused its id, by the process start time (`TZ=UTC LC_ALL=C ps -o lstart= -p PID` plus the suffix ` UTC`). Start times recorded before this change are in the machine's local time and have no suffix. The relay accepts both forms until every window has restarted, and compares each form only with a reading in that form.

- **Deploy in one go:** update the tree, build, and restart the daemon back to back, then restart every agent window. The hooks run from disk, so they write the new form as soon as the tree is updated. Until it restarts, an old daemon or connector compares in local time and reads windows anchored in the new form as dead.
- **During the transition, one guard keeps a window to one current binding: `relay bind`.** The database's unique index on a window's anchor (`idx_agent_bindings_current_anchor`) cannot stop a window from holding a pre-UTC row and a UTC row at once, because the two spellings are different strings. So `relay bind` moves a window's pre-UTC row onto its UTC start time, retires the pre-UTC row when both are current, and refuses to bind (with a reason, writing nothing) when it cannot read the window's pre-UTC start time while a pre-UTC row for that process id is current. Once the older form is retired, the index covers this state again.
- **`relay doctor`, "start tokens (legacy form)":** counts the live anchors still in the older form and the ones it could not read, and lists any window with more than one current binding as an ANOMALY. It is PASS only when all three are zero. When it reads PASS on every machine, the older form can be retired.
- **Known limit:** a start time recorded by a shell that set `TZ` explicitly is not recognised. That window reads dead until its next tool call rewrites the start time in UTC.

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

## Build identity: what a running process reports

A merge or an install changes the files on disk, but a process that is already running keeps the code it loaded when it started. So every relay process reports the build it LOADED, as `build` in `/health`, `health_check`, `whoami` and `relay where --json`:

- `build_id` is the **code id**: a hash of `package.json` and every file under `dist/`, written into `dist/build-info.js` by `npm run build`. An identical rebuild gives the same id. A build made with plain `tsc` (without that last step) reports `unbuilt`, which matches nothing.
- `deps_id` is the **dependency id**: a hash of the name and version of every installed production dependency, read from each package's own `package.json` (never a lockfile), plus every native addon (`*.node`), which `npm rebuild` can change with no version bump. The process computes it once, when it starts.
- `commit`, `dirty`, `built_at` and `node` are for people reading it.

**The boundary: what a restart is needed for.** The identity covers exactly what a long-lived process (the daemon, or the stdio connector each agent window starts) loads when it starts and keeps for its whole life: `dist/`, `package.json` and the production dependencies. It does NOT cover `hooks/*.sh` or `bin/relay`: they run fresh on every call, so a change to them takes effect on the next call, and no window needs a restart for it.

An install whose stamp does not match its own content (a plain `tsc` rebuild, a hand edit), or whose declared dependencies are missing or unreadable, is reported as inconsistent: rebuild with `npm run build`.
