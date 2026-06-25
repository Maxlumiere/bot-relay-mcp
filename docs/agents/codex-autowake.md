# Codex auto-wake (relay self-wake for Codex CLI agents)

Claude Code agents wake themselves on relay mail via Tether. Codex CLI agents
can do the same with two lifecycle hooks — no extra infrastructure, no human
nudge. This is the Codex port of the Claude `hooks/check-relay.sh` (register)
and `hooks/stop-check.sh` (mail check), using Codex's `Stop` "decision: block"
continuation to actually **re-prompt** the agent when mail arrives.

What you get:

- **SessionStart** registers the Codex session as a relay agent and tells it to
  check its inbox.
- **Stop** runs at every turn-end: if the agent has pending relay mail it
  re-prompts ("ping-off") so the agent reads and acts on it; if not, it keeps
  the agent alive with a bounded, paced poll.

## Prerequisites

- `codex-cli` with lifecycle hooks (`SessionStart`, `Stop`).
- A running bot-relay daemon on `127.0.0.1:3777` (`relay`/HTTP transport).
- `curl` and `python3` on `PATH` (used to talk to the daemon and emit hook JSON).
- The bot-relay MCP server configured in Codex so the agent can call
  `get_messages` / `send_message` itself.

## 1. Set the agent identity

The hooks read the agent name/role from the environment (the payload Codex
passes does not carry it). Launch Codex with these set, e.g. via a shell alias:

```bash
alias codex-relay='RELAY_AGENT_NAME=codex RELAY_AGENT_ROLE=builder codex'
```

`RELAY_AGENT_NAME` is required; `RELAY_AGENT_ROLE` defaults to `user`.

## 2. Add the hooks to `~/.codex/config.toml`

Add this block (adjust the absolute paths to wherever this repo lives). Codex
also accepts a `hooks.json` file with the same shape.

```toml
[[hooks.SessionStart]]
matcher = "startup|resume"

[[hooks.SessionStart.hooks]]
type = "command"
command = "/path/to/bot-relay-mcp/hooks/codex/codex-session-start.sh"
statusMessage = "Registering with bot-relay"

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = "/path/to/bot-relay-mcp/hooks/codex/codex-stop.sh"
timeout = 120
```

> **`timeout` must exceed the idle backoff.** The Stop hook `sleep`s for
> `RELAY_CODEX_POLL_BACKOFF` seconds (default 90) on an empty poll, so the hook
> `timeout` has to be larger (120 here). If you raise the backoff, raise the
> timeout too.

Make the scripts executable once:

```bash
chmod +x /path/to/bot-relay-mcp/hooks/codex/*.sh
```

## 3. Tuning (optional env vars)

| Env var | Default | Meaning |
|---|---|---|
| `RELAY_HTTP_HOST` / `RELAY_HTTP_PORT` | `127.0.0.1` / `3777` | Daemon address. |
| `RELAY_CODEX_POLL_BACKOFF` | `90` | Seconds to wait before each empty-inbox keep-alive re-check. |
| `RELAY_CODEX_MAX_IDLE_POLLS` | `40` | Cap on consecutive empty polls (~1h at 90s) before the agent rests. **`0` = unbounded 24/7 loop.** |

**Token cost note:** every keep-alive re-check is a model turn. At the defaults
that is ~1 turn/90s while idle, capped at ~40 turns (~1h) before the agent rests
and waits for the next real turn or incoming mail. Set `MAX_IDLE_POLLS=0` only
if you want a true 24/7 loop and accept the continuous per-poll token cost; raise
`POLL_BACKOFF` to trade latency for fewer turns.

## 4. Test

1. **Register:** start `codex-relay`. On startup the SessionStart hook registers
   the agent — confirm it appears:
   ```bash
   curl -s http://127.0.0.1:3777/api/snapshot | grep '"name":"codex"'
   ```
2. **Auto-wake on mail:** from another agent (or `curl`), send the Codex agent a
   message, then let its current turn end. The Stop hook should detect the
   pending message and re-prompt it to call `get_messages` and act — with no
   human input.
3. **Keep-alive:** with an empty inbox, end a turn. The agent should pause
   (~`POLL_BACKOFF`s) and re-check, repeating up to `MAX_IDLE_POLLS` times, then
   rest. Watch the daemon logs / `Stop` hook stderr for the cap message.

## How it works (and the guard)

The Stop hook **peeks** the inbox (`get_messages` with `peek=true`) so counting
mail never consumes it — the agent's own `get_messages` call still receives it.
On pending mail it emits `{"decision":"block","reason":"ping-off …"}`, which
Codex turns into a fresh user turn. On an empty inbox it waits and re-blocks to
stay alive.

The keep-alive loop **cannot run away**: it is paced by `POLL_BACKOFF` (never a
tight spin) and bounded by `MAX_IDLE_POLLS` consecutive empty polls. The counter
only accumulates while Codex reports `stop_hook_active=true` (so a genuine
turn-end starts a fresh window) and is cleared whenever real mail arrives. Any
error — daemon unreachable, missing token, parse failure — exits 0 with no
output, so a broken setup never traps the agent in a loop.

## v1 vs v2 (the efficient next step)

This is **v1: a zero-infrastructure poll loop.** It keeps the agent awake by
re-prompting on a timer, which costs one model turn per idle poll.

The **efficient v2** removes idle polling entirely: the relay *pushes* to the
agent via the **Codex App Server** (`turn/start`) the moment mail arrives, so the
agent only spends turns when there is actually work. That requires the relay to
hold a connection to the Codex App Server (real infrastructure) and is the
documented next step once v1 is proven in day-to-day use. Until then, tune
`POLL_BACKOFF` / `MAX_IDLE_POLLS` to balance wake latency against token cost.
