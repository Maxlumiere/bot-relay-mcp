# MCP prompts + resources (v2.4.0)

v2.4.0 adds the MCP `prompts` and `resources` capabilities alongside the existing `tools` capability. These are **different** from tools: prompts are pre-baked instruction templates (the operator picks one from a menu); resources are pre-defined read-only data endpoints (the client fetches JSON snapshots).

Tool count stays at 30 — neither prompts nor resources add to it.

## Why split

Per the federation design memo (Codex Prompt B 2026-04-19):

> Use MCP's tools/resources/prompts split more aggressively. Put routine flows ("recover lost token", "invite worker", "rotate compromised agent") into PROMPTS. Keep advanced tools hidden unless profile enables.

Tools are high-level actions the operator invokes by name. Prompts are pre-written instruction sequences the client surfaces in a menu — great for routine flows where the exact sequence is known and the operator just needs a reminder of the right steps. Resources are read-only data endpoints — great for visualization tools that want structured JSON without hand-wiring a dozen tool calls.

## Prompts (3 shipped)

Call `prompts/list` to enumerate; call `prompts/get` with a name + arguments to render.

### `recover-lost-token`

**When to use:** an agent's `RELAY_AGENT_TOKEN` was lost and `register_agent` now returns `AUTH_FAILED`.

**Arguments:**

| name | required | description |
| --- | --- | --- |
| `agent_name` | yes | The agent whose token was lost |

**Renders:** step-by-step instructions for `relay recover <name> --dry-run` → `--yes` → fresh `register_agent` → save new token.

### `invite-worker`

**When to use:** you're spawning a sub-agent and want to get them onboarded with a brief in a single flow.

**Arguments:**

| name | required | description |
| --- | --- | --- |
| `agent_name` | yes | Name for the new sub-agent |
| `role` | yes | Agent role (builder / reviewer / …) |
| `brief` | no | First-message brief the sub-agent sees on arrival |

**Renders:** `spawn_agent` call template + SessionStart hook note + confirmation via `discover_agents`.

### `rotate-compromised-agent`

**When to use:** an agent's token has leaked and you need to revoke + reissue + re-register it.

**Arguments:**

| name | required | description |
| --- | --- | --- |
| `agent_name` | yes | Compromised agent whose token must be rotated |
| `revoker_name` | yes | Your own agent name (must hold admin capability) |

**Renders:** `revoke_token({issue_recovery: true})` → hand-off the one-shot `recovery_token` → target's operator runs `register_agent(recovery_token: ...)` → fresh `agent_token`.

## Resources (3 shipped)

Call `resources/list` to enumerate; call `resources/read` with a URI.

### `relay://current-state`

JSON snapshot of the live relay:

```jsonc
{
  "agents": [
    {
      "name": "alice",
      "role": "builder",
      "agent_status": "idle",
      "last_seen": "2026-04-23T10:00:00.000Z",
      "pending_count": 3
    }
  ],
  "active_tasks_count": 2,
  "total_pending_messages": 3,
  "schema_version": 11
}
```

Same family as the dashboard's `/api/snapshot` but surfaced via MCP — useful for clients without HTTP access.

### `relay://recent-activity`

Last 50 audit-log entries:

```jsonc
{
  "entries": [
    {
      "id": "...",
      "ts": "2026-04-23T10:00:00.000Z",
      "tool": "register_agent",
      "source": "http",
      "success": true,
      "agent_name": "alice",
      "error": null
    }
  ]
}
```

`params_json` is **not** included — stays in the SQLite file for authorized review only. If you need payload-level audit data, query the DB directly under filesystem-access authority.

### `relay://agent-graph`

Agent + message + task graph suitable for visualization:

```jsonc
{
  "nodes": [
    { "id": "alice", "role": "builder", "agent_status": "idle" }
  ],
  "message_edges": [
    { "from": "alice", "to": "bob", "count": 42 }
  ],
  "task_edges": [
    { "from": "alice", "to": "bob", "status": "in_progress", "count": 1 }
  ]
}
```

Edges are aggregated counts — no message/task IDs are surfaced here. For per-message detail, use the `get_messages` / `get_tasks` tools.

## How clients surface these

### Claude Code

Prompts appear in the slash-command menu (type `/` + prompt name). Resources are surfaced via an attachment picker.

### Cursor / Aider / Continue

Depends on the client — any MCP-compliant client that negotiates the `prompts` / `resources` capabilities sees these automatically. Clients that don't negotiate them see only the `tools` capability, which is unchanged.

### Programmatic (raw MCP)

```jsonc
// prompts/list
{ "jsonrpc": "2.0", "id": 1, "method": "prompts/list" }

// prompts/get
{
  "jsonrpc": "2.0", "id": 2, "method": "prompts/get",
  "params": { "name": "recover-lost-token", "arguments": { "agent_name": "alice" } }
}

// resources/list
{ "jsonrpc": "2.0", "id": 3, "method": "resources/list" }

// resources/read
{
  "jsonrpc": "2.0", "id": 4, "method": "resources/read",
  "params": { "uri": "relay://current-state" }
}
```

## Adding more prompts

Edit `src/mcp-prompts.ts`:

1. Define a new `McpPromptDefinition` with `name`, `description`, `arguments`, and a `render(args)` function.
2. Append to `ALL_PROMPTS`.
3. Add a test in `tests/v2-4-0-mcp-prompts-resources.test.ts` asserting round-trip + substitution.

## Adding more resources

Edit `src/mcp-resources.ts`:

1. Append a new `McpResourceDescriptor` to `RESOURCE_DESCRIPTORS`.
2. Add a `case` to `readResource` dispatch + a helper `buildX()` that returns the JSON snapshot.
3. Add a test asserting the shape + that unknown URIs still throw.

## Backward compatibility

Pre-v2.4.0 MCP clients never negotiated `prompts` / `resources` capabilities — they silently ignored them. v2.4.0 advertises all three (`tools`, `prompts`, `resources`) in the initial capabilities exchange. Clients that don't care for the new capabilities see no change.
