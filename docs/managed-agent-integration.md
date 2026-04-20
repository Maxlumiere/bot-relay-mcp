# Managed Agent Integration (v1.10)

This doc is for integrators building a **Managed Agent** — an agent that is NOT running inside a Claude Code terminal. Examples:

- A Python script polling the relay for work, running jobs, reporting status.
- A headless background worker on a Linux VM subscribing to `task.posted` webhooks.
- A Hermes / Ollama / vLLM server participating in multi-agent workflows.
- A custom Node service bridging the relay to Slack / email / Discord.
- (future) An Anthropic Managed Agent subscribed to the relay.

Our four-layer delivery architecture names this **Layer 2**. Layer 1 is the existing Claude Code terminals (stdio MCP). Layer 2 is "agents that aren't Claude Code." The relay doesn't care which layer a peer lives in — names are names, messages are messages, tokens authenticate the same way.

This doc is intentionally long. If you just want runnable code, skip to [`examples/managed-agent-reference/`](../examples/managed-agent-reference/).

---

## Mental model

A Managed Agent is just another registered agent in the relay's `agents` table. It registers once (gets a bcrypt-hashed token), then participates in the same primitives every other agent uses:

- `send_message` / `get_messages` — peer-to-peer messaging.
- `post_task` / `update_task` / `get_tasks` — work assignment + status.
- `broadcast` — one-to-many (rate-limit-scoped).
- `register_webhook` / `list_webhooks` / `delete_webhook` — event subscriptions.
- `discover_agents` — find peers.
- `unregister_agent` — retire cleanly on shutdown.

What's different from a Claude Code terminal:

| Claude Code terminal (Layer 1) | Managed Agent (Layer 2) |
|---|---|
| Transport: stdio MCP to `node dist/index.js` | Transport: HTTP to `http://relay-host:3777/mcp` |
| Identity: `RELAY_AGENT_NAME` env var + `SessionStart` hook auto-registers | Identity: explicit `register_agent` call on startup, token persisted by the agent |
| Mail delivery: SessionStart hook + PostToolUse hook inject into Claude context | Mail delivery: the agent polls `get_messages` OR subscribes a webhook |
| Lifecycle: terminal closes → SessionStart hook's register is stale until next open | Lifecycle: agent calls `unregister_agent` on SIGTERM/SIGINT for clean retirement |

The relay protocol is **identical**. Both layers use the same MCP tools, the same DB tables, the same token auth, the same webhooks. The difference is in how you move data over the wire and how you manage your own lifecycle.

---

## Choosing a transport

Three options. Pick based on deployment topology.

### Option A — HTTP (recommended default)

- Managed Agent POSTs JSON-RPC 2.0 payloads to the relay's `/mcp` endpoint.
- Works **cross-machine** over a network.
- Full auth pipeline (token + optional shared secret + rate limits + audit log).
- Response is SSE-framed — you'll see `event: message\ndata: {...}` lines.

Use when: Managed Agent and relay are on different machines, or same machine but you want full observability.

### Option B — Direct SQLite (same-machine, same user only)

- Agent opens `~/.bot-relay/relay.db` directly and uses SQL.
- No HTTP round-trip; a few hundred microseconds per operation.
- **No authentication** — file-system permissions are the only gate. Requires the agent to run as the same OS user that owns the DB file.
- You lose: audit log entries (direct SQL bypasses the dispatcher), rate limits, structured error messages.
- Used by the existing `SessionStart` hook (`hooks/check-relay.sh`) for the same rationale.

Use when: Managed Agent runs on the same box as the relay, same OS user, and the perf / dependency-free upside outweighs the lost observability. Rare in practice.

### Option C — Webhook subscription (event-driven)

- Managed Agent runs an HTTP server of its own.
- Agent calls `register_webhook` once, giving the relay its URL.
- Relay POSTs events (`message.sent`, `task.posted`, `agent.spawned`, etc.) to the agent as they happen.
- HMAC-signed if you pass a `secret` at register time (recommended).

Use when: you want push-style delivery (no polling loop) AND your Managed Agent can accept inbound HTTP — either it's on the same network as the relay, or it has a publicly reachable URL.

Cannot accept inbound HTTP? Use Option A + polling. Webhook is a capability upgrade, not a requirement.

**Most Managed Agents use A + C:** poll `get_messages` as the reliable baseline, subscribe webhooks for low-latency push when possible.

---

## Authentication flow

### First-time registration

```
POST /mcp
Content-Type: application/json
Accept: application/json, text/event-stream

{
  "jsonrpc": "2.0", "id": 1,
  "method": "tools/call",
  "params": {
    "name": "register_agent",
    "arguments": {
      "name": "my-managed-worker",
      "role": "worker",
      "capabilities": ["tasks", "webhooks"]
    }
  }
}
```

Response (SSE-framed, one event):

```
event: message
data: {"result":{"content":[{"type":"text","text":"{\n  \"success\": true,\n  \"agent\": { ... },\n  \"agent_token\": \"jHE9unOA3QVybi_1AfQ95FdNeIDtaUANPfES2gmzLWM\",\n  ...\n}"}]},"jsonrpc":"2.0","id":1}
```

**Save the `agent_token`.** The server stores only a bcrypt hash. The raw token is returned exactly once. If you lose it, you must `unregister_agent` and re-register to get a new one.

### Subsequent calls

On every tool call after registration, present the token **one** of three ways:

1. As the `agent_token` field inside `arguments` (works for every transport):
   ```json
   "arguments": { "from": "my-managed-worker", "to": "peer", "content": "hi", "agent_token": "..." }
   ```
2. As an HTTP header (HTTP transport only):
   ```
   X-Agent-Token: <token>
   ```
3. As an env var on the Managed Agent process:
   ```
   export RELAY_AGENT_TOKEN=<token>
   ```
   (Most useful if you're pulling the token from a secret manager at startup.)

### HTTP shared secret (optional second factor)

If the relay is configured with `RELAY_HTTP_SECRET`, every `/mcp` call also needs:

```
Authorization: Bearer <shared-secret>
```

OR

```
X-Relay-Secret: <shared-secret>
```

This is a **network-trust** gate, distinct from per-agent tokens. Pair them: shared secret says "you are on a trusted network"; agent token says "you are this specific agent." Both required in a zero-trust deployment.

### Capability declaration

Capabilities are **immutable after first registration** (v1.7.1). Declare what you need upfront:

- `tasks` — required for `post_task` and `update_task`.
- `webhooks` — required for `register_webhook` / `list_webhooks` / `delete_webhook`.
- `broadcast` — required for `broadcast`. This is coarser than `send_message` (blast to many peers), so the relay treats it as elevated.
- `spawn` — required for `spawn_agent`. Unlikely for a typical Managed Agent.

Not listed = always allowed for any authenticated agent (`send_message`, `get_messages`, `discover_agents`, `unregister_agent`, `post_task`, `get_task`, `get_tasks`).

To change capabilities later: `unregister_agent` (with your token) then fresh `register_agent` with the new set. The relay will reject any re-register attempt that changes caps silently.

### Token rotation

There is no server-driven rotation in v1.10 — the bcrypt hash is stable for the agent's lifetime. To rotate: `unregister_agent`, re-register, update your env var. Peer agents referencing you by name are unaffected (names are stable, tokens aren't visible to peers).

---

## Lifecycle

### Startup

1. Load token from secure storage (env var, secret manager, encrypted config file).
2. If no token on first run:
   - `register_agent` (no token required) → get token → write it to storage.
3. Optional: `register_webhook` for events you want pushed.
4. Begin your main loop.

### Operating loop

A typical poll-based worker:

```python
while True:
    msgs = rpc("get_messages", {"agent_name": NAME, "status": "pending", "limit": 20})
    for m in msgs:
        handle_message(m)

    tasks = rpc("get_tasks", {"agent_name": NAME, "role": "assigned", "status": "posted"})
    for t in tasks:
        accept_and_work(t)

    time.sleep(POLL_INTERVAL_SECONDS)
```

A webhook-driven worker replaces polling with an HTTP server that reacts to pushed events:

```python
def on_task_posted(event_payload):
    task = event_payload["data"]
    if task["to_agent"] == NAME:
        accept_and_work(task)
```

Most robust setup: do both. Poll every N seconds as a floor, react to webhooks for push.

### Shutdown (SIGTERM / SIGINT)

Call `unregister_agent` before exiting. This:

- Removes your row from the agents table (so `discover_agents` stops listing you).
- Fires an `agent.unregistered` webhook to peers subscribed to the event.
- Lets peers cleanly stop routing work to you.

The reference scripts do this with a signal handler:

```python
signal.signal(signal.SIGINT,  lambda *_: shutdown_and_exit())
signal.signal(signal.SIGTERM, lambda *_: shutdown_and_exit())
```

If you skip it: your agent row stays in the DB until the relay's purge window (for messages: 7 days; for tasks: 30 days; for stale agents: presence logic marks them offline after ~3 minutes of no activity). Peers will see "stale" but not "gone."

---

## Error handling patterns

### Network errors (connection refused, DNS failure, timeout)

Retry with exponential backoff. The relay is durable (SQLite), so most errors are transport failures — the relay itself is fine; your link to it isn't.

Suggested: start 1s, double up to 30s, cap attempts at ~5 before logging + sleeping longer.

### HTTP 401 (auth failure)

Don't retry. Either:

- Your token is wrong (operator bug — check env / storage).
- The server's `RELAY_HTTP_SECRET` rotated and your shared-secret is stale.
- The agent was unregistered on the relay side (admin action).

Log loud, exit non-zero. A process supervisor (systemd, Docker, pm2) should restart you; on restart, if registration is missing, re-register.

### HTTP 429 / `rate_limit` in the response body

The relay enforces per-bucket rate limits (see README — `rate_limit_messages_per_hour` etc.). If you hit one:

- Back off for the stated reset window.
- If you're hitting it often, your agent is doing too much; reduce poll frequency or batch work.

### Tool response `success: false` with `auth_error: true`

Means the dispatcher rejected you — capability missing, token mismatch, or legacy grace disabled. The `error` field has the human-readable reason. Log and alert; do not retry.

### Tool response `success: false` without `auth_error`

A legitimate business error (agent not found, invalid state transition on a task, etc.). Handle the specific case; don't blanket-retry.

---

## Testing your integration

After your Managed Agent starts and registers, verify from a Claude Code terminal or any HTTP client:

```bash
curl -s -X POST http://127.0.0.1:3777/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"discover_agents","arguments":{"agent_token":"<your-token>"}}}'
```

Your Managed Agent should appear in the returned `agents` array with `has_token: true`. If `has_token: false`, you're in legacy-grace mode — re-register to move out of it.

Send a test message to your agent from another terminal and verify it picks it up via `get_messages` (or webhook, if subscribed).

Reference implementations in two languages are in [`examples/managed-agent-reference/`](../examples/managed-agent-reference/). Each has a `SMOKE.md` with a step-by-step verification checklist.

---

## Security notes

- **Never commit tokens.** Use env vars or a secret manager.
- **Prefer HTTPS in production.** The built-in relay listens plain HTTP; put it behind nginx / Caddy / Cloudflare with TLS termination. Configure `RELAY_TRUSTED_PROXIES` (see README) so rate-limit source IPs are correct.
- **Use the shared secret** (`RELAY_HTTP_SECRET`) if your relay is reachable from an untrusted network — per-agent tokens are your identity layer; shared secret is your perimeter layer.
- **Rotate shared secret periodically.** v1.7 supports rotation via `RELAY_HTTP_SECRET_PREVIOUS`; docs in README.
- **Enable encryption at rest** if your DB holds sensitive content: set `RELAY_ENCRYPTION_KEY` on the relay. See README.
- **Scope capabilities narrowly.** If your agent only sends messages, do NOT grant it `tasks` or `webhooks`. Principle of least authority.

---

## FAQ

**Q: Can a Managed Agent send a message to a Claude Code terminal?**
A: Yes. Both are just registered agents. Use `send_message { from: "<managed-name>", to: "<claude-terminal-name>", content: "..." }`. The terminal picks it up via the SessionStart or PostToolUse hook (or when a human calls `get_messages`).

**Q: Can I run multiple Managed Agents with the same name?**
A: No — names are unique. The relay will reject the second `register_agent` call (capability-immutability rule kicks in and the second call needs the first agent's token to succeed). Use distinct names, one per Managed Agent process.

**Q: How does the agent find the relay's URL?**
A: You configure it. Typically via `RELAY_HTTP_HOST` + `RELAY_HTTP_PORT` env vars (defaults `127.0.0.1:3777`). The reference scripts read those env vars.

**Q: Is there a client library?**
A: Not yet. The reference scripts are under 200 lines each and use stdlib only — they're meant to be easy to port into any language. A client library might ship in a later version once the protocol stabilizes further.

**Q: What happens if the relay restarts?**
A: SQLite persists everything (agents, messages, tasks, webhooks). Your Managed Agent's next call will succeed as if nothing happened. You do NOT need to re-register.

**Q: Can two Managed Agents talk to each other directly, without going through the relay?**
A: Not using the relay protocol. The relay IS the bus. For direct agent-to-agent, use a webhook targeted at the peer's URL, but that's outside the relay's model.

**Q: Can a Managed Agent spawn a Claude Code terminal?**
A: Yes if it has the `spawn` capability. Call `spawn_agent` via HTTP. The relay's v1.9 cross-platform driver picks the right terminal emulator on its host.

---

## Related

- [`examples/managed-agent-reference/`](../examples/managed-agent-reference/) — runnable Python + Node references
- [README](../README.md) — full protocol overview, tool list, config options
- [Per-Agent Tokens (v1.7)](../README.md#per-agent-tokens-v17) — token semantics in depth
- [Cross-Platform Spawn (v1.9)](../README.md#cross-platform-spawn-v19) — if your Managed Agent will spawn Claude Code terminals
- [SessionStart hook](./hooks.md) — how Layer 1 auto-registers
- [PostToolUse hook](./post-tool-use-hook.md) — Layer 1 near-real-time mail delivery
