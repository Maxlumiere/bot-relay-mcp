# Python Reference Agent — Smoke Test

Verify the reference agent works end-to-end against a live relay.

## Prerequisites

- Python 3.8+ (stdlib only, no pip install needed)
- Relay running in HTTP mode: `RELAY_TRANSPORT=http node /path/to/bot-relay-mcp/dist/index.js`

## Steps

### 1. Start the agent

```bash
cd examples/managed-agent-reference/python
RELAY_HTTP_HOST=127.0.0.1 RELAY_HTTP_PORT=3777 python3 agent.py
```

Expected stderr output:
```
[managed-py] Starting managed agent (host=127.0.0.1:3777, role=worker)
[managed-py] Registered. Save this token:
  export RELAY_AGENT_TOKEN=<token>
[managed-py] Peers: victra, ops, managed-py
[managed-py] Entering poll loop (interval=5s). Ctrl-C to quit.
```

### 2. Verify it appears in discover_agents

From another terminal:
```bash
curl -s -X POST http://127.0.0.1:3777/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"discover_agents","arguments":{}}}'
```

Look for `"name": "managed-py"` with `"has_token": true`.

### 3. Send a message to it

```bash
curl -s -X POST http://127.0.0.1:3777/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_message","arguments":{"from":"tester","to":"managed-py","content":"hello from smoke test","priority":"normal"}}}'
```

Within one poll interval (~5s), the agent should print:
```
[managed-py] Mail from tester [normal]: hello from smoke test
```

### 4. Post a task to it

```bash
curl -s -X POST http://127.0.0.1:3777/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"post_task","arguments":{"from":"tester","to":"managed-py","title":"smoke task","description":"verify task lifecycle","priority":"normal"}}}'
```

Within one poll interval, the agent should print:
```
[managed-py] Task from tester: smoke task (id=...)
[managed-py] Accepted task ...
[managed-py] Completed task ...
```

### 5. v2.1 Phase 4b.2: token rotation + persist-before-ack

Test that the agent survives a `rotate_token` call — this exercises the `token_rotated` push-message path and the persist-before-ack discipline.

With the agent still running, register an admin agent with `rotate_others` capability:

```bash
curl -s -X POST http://127.0.0.1:3777/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register_agent","arguments":{"name":"admin-rotator","role":"admin","capabilities":["rotate_others"]}}}'
```

Capture the returned `agent_token`. Then trigger admin-rotation of the Python agent:

```bash
ADMIN_TOKEN=<token-from-previous-step>
curl -s -X POST http://127.0.0.1:3777/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-Agent-Token: $ADMIN_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"rotate_token_admin","arguments":{"target_agent_name":"managed-py","rotator_name":"admin-rotator","grace_seconds":60}}}'
```

Within one poll interval (~5s), the agent should print:
```
[managed-py] Token rotated by "admin-rotator". Persisted + cut over. Old token valid until <ISO8601>.
```

Verify the persisted token file was updated:
```bash
cat examples/managed-agent-reference/python/.agent-token
```

That value MUST be non-empty + different from the original. Agent continues to operate using the new token for all subsequent calls.

### 5b. Simulated crash-between-receive-and-persist

Stop the agent (Ctrl-C) while it's mid-rotation handling is rare to catch manually — instead, verify the PERSIST-FIRST discipline by inspection. Read `examples/managed-agent-reference/python/agent.py` and confirm `handle_token_rotation` calls `persist_token(new_token)` BEFORE assigning `TOKEN = new_token`. A process crash between those two lines would wake up on next restart with the new token already on disk, load it via `load_persisted_token()`, and reconnect cleanly. This is the Phase 4o recovery-flow pattern applied to rotations.

### 6. Ctrl-C — verify clean shutdown

Press Ctrl-C. Expected:
```
[managed-py] Shutting down (signal 2)...
[managed-py] Unregistered (removed=true).
```

Re-run `discover_agents` — `managed-py` should no longer appear.

## Pass criteria

All 6 steps produce the expected output. No exceptions, no hangs, no orphaned agent row, token file correctly persisted post-rotation.
