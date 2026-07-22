# Driving the relay over HTTP (no MCP client) — one-shot recipe

A session with **no bot-relay MCP wired in** (a plain shell, a script, a non-MCP tool) can still register, send, and clean up over the HTTP daemon with `curl`. This is the documented "one-shot" path.

> Base URL is the daemon's HTTP address — default `http://127.0.0.1:3777`. Every relay tool is callable as a JSON-RPC `tools/call` against `POST /mcp`.

**Two headers matter:**
- `Content-Type: application/json`
- `Accept: application/json, text/event-stream` — include **both** (the transport requires it), but a non-streaming one-shot POST replies with **plain `application/json`** (ADR-0005 #3), so you can `JSON.parse` the body directly — no `event:`/`data:` SSE frames to strip.

## 1. Register + capture the token

`agent_token` is the **first field** of the response body (ADR-0005 #2), so even a truncated read captures it. It is shown **once** (the server stores only a bcrypt hash).

```bash
BASE=http://127.0.0.1:3777
resp=$(curl -s "$BASE/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register_agent",
       "arguments":{"name":"my-script","role":"worker","capabilities":[]}}}')

# The tool payload is JSON-encoded inside result.content[0].text:
payload=$(printf '%s' "$resp" | jq -r '.result.content[0].text')
TOKEN=$(printf '%s' "$payload"   | jq -r '.agent_token')          # save this — shown once
HANDLE=$(printf '%s' "$payload"  | jq -r '.registration_recovery') # for self-clean if you botch capture
```

## 2. Send a message

`send_message` accepts `content` **or** its alias `message` (ADR-0005 #5). Authenticate the sender with `from_agent_token` (the impersonation gate applies — a token for X cannot send `from: Y`).

```bash
curl -s "$BASE/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"send_message\",
       \"arguments\":{\"from\":\"my-script\",\"to\":\"some-agent\",\"message\":\"hello\",
       \"from_agent_token\":\"$TOKEN\"}}}" | jq -r '.result.content[0].text' | jq .
```

## 3. Clean up

**Normal exit** — unregister with your token:

```bash
curl -s "$BASE/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"unregister_agent\",
       \"arguments\":{\"name\":\"my-script\",\"agent_token\":\"$TOKEN\"}}}"
```

**Botched capture** — you registered but lost the token before ever authenticating (an *orphan*). Use the `registration_recovery` handle from step 1 — no token needed (ADR-0005 #4). It can **only** remove a never-authenticated row, so it's safe:

```bash
curl -s "$BASE/mcp" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"abandon_registration\",
       \"arguments\":{\"name\":\"my-script\",\"recovery_handle\":\"$HANDLE\"}}}"
```

Lost both the token *and* the handle? Orphans (never-authed, session-less) are **auto-removed after ~30 minutes** — no action needed. (A *live* agent that lost its token is not an orphan; use `rotate_token` or `relay recover`.)

---

**Long-term:** the one-shot recipe is the stopgap for sessions without MCP. The cleaner fix is wiring the bot-relay MCP server into the session's `~/.claude.json` (see the [README Quick Start](../README.md#quick-start-30-seconds)), so the tools appear natively and none of this hand-rolling is needed.
