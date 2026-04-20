# Node Reference Agent — Smoke Test

Verify the reference agent works end-to-end against a live relay.

## Prerequisites

- Node 18+ (stdlib only, no npm install needed)
- Relay running in HTTP mode: `RELAY_TRANSPORT=http node /path/to/bot-relay-mcp/dist/index.js`

## Steps

### 1. Start the agent

```bash
cd examples/managed-agent-reference/node
RELAY_HTTP_HOST=127.0.0.1 RELAY_HTTP_PORT=3777 node agent.js
```

Expected stderr output:
```
[managed-node] Starting managed agent (host=127.0.0.1:3777, role=worker)
[managed-node] Registered. Save this token:
  export RELAY_AGENT_TOKEN=<token>
[managed-node] Peers: victra, ops, managed-node
[managed-node] Entering poll loop (interval=5s). Ctrl-C to quit.
```

### 2. Verify it appears in discover_agents

From another terminal:
```bash
curl -s -X POST http://127.0.0.1:3777/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"discover_agents","arguments":{}}}'
```

Look for `"name": "managed-node"` with `"has_token": true`.

### 3. Send a message to it

```bash
curl -s -X POST http://127.0.0.1:3777/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_message","arguments":{"from":"tester","to":"managed-node","content":"hello from smoke test","priority":"normal"}}}'
```

Within one poll interval (~5s), the agent should print:
```
[managed-node] Mail from tester [normal]: hello from smoke test
```

### 4. Post a task to it

```bash
curl -s -X POST http://127.0.0.1:3777/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"post_task","arguments":{"from":"tester","to":"managed-node","title":"smoke task","description":"verify task lifecycle","priority":"normal"}}}'
```

Within one poll interval, the agent should print:
```
[managed-node] Task from tester: smoke task (id=...)
[managed-node] Accepted task ...
[managed-node] Completed task ...
```

### 5. v2.1 Phase 4b.2: token rotation + persist-before-ack

Same flow as the Python agent — register an admin with `rotate_others` capability, trigger `rotate_token_admin` against `managed-node`, verify the agent handles the push-message.

```bash
curl -s -X POST http://127.0.0.1:3777/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register_agent","arguments":{"name":"admin-rotator","role":"admin","capabilities":["rotate_others"]}}}'
# capture returned agent_token → $ADMIN_TOKEN

curl -s -X POST http://127.0.0.1:3777/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "X-Agent-Token: $ADMIN_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"rotate_token_admin","arguments":{"target_agent_name":"managed-node","rotator_name":"admin-rotator","grace_seconds":60}}}'
```

Within one poll interval (~5s):
```
[managed-node] Token rotated by "admin-rotator". Persisted + cut over. Old token valid until <ISO8601>.
```

Verify:
```bash
cat examples/managed-agent-reference/node/.agent-token  # non-empty, differs from pre-rotation
```

**Persist-before-ack discipline**: read `handleTokenRotation` in `agent.js` — `persistToken(newToken)` runs BEFORE `TOKEN = newToken`. A crash between the two leaves the new token already on disk, so `loadPersistedToken()` on next startup picks it up cleanly. Mirror of Phase 4o recovery-flow.

### 6. Ctrl-C — verify clean shutdown

Press Ctrl-C. Expected:
```
[managed-node] Shutting down...
[managed-node] Unregistered (removed=true).
```

Re-run `discover_agents` — `managed-node` should no longer appear.

## Pass criteria

All 6 steps produce the expected output. No exceptions, no hangs, no orphaned agent row, token file correctly persisted post-rotation.
