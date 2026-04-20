# bot-relay-mcp — Architecture Spec

> See `CLAUDE.md` for quick overview, status, and build plan.

## System Architecture

```
Terminal A (Victra)          Terminal B (Ops)          Terminal C (Builder)
    |                            |                         |
    v                            v                         v
MCP Server (stdio)          MCP Server (stdio)        MCP Server (stdio)
    |                            |                         |
    +----------------------------+-------------------------+
                                 |
                        ~/.bot-relay/relay.db
                          (shared SQLite)
```

Each Claude Code terminal runs its own MCP server process via stdio. All processes read/write the same SQLite database file at `~/.bot-relay/relay.db`. There is no daemon, no HTTP server, no ports — just stdio transport and a shared DB file.

SQLite handles concurrent access through its built-in locking. WAL mode is enabled for better concurrent read performance. Write contention is minimal since agents typically write short bursts (register, send message) with long gaps between.

## MCP Tools (7 total)

### Identity (2 tools)

**`register_agent`** — Register the calling terminal as a named agent.
- Input: `name` (string), `role` (string), `capabilities` (string[])
- Behavior: Upserts by name. Sets `last_seen` to now. Returns agent record.
- A name like "victra" or "ops" — human-readable, not UUIDs.

**`discover_agents`** — List all registered agents.
- Input: `role` (optional string filter)
- Returns: All agents, with `status` computed from `last_seen` (online if < 5 min ago, offline otherwise).

### Messaging (3 tools)

**`send_message`** — Send a text message to a specific agent.
- Input: `from` (string), `to` (string), `content` (string), `priority` ("normal" | "high")
- Creates a message record with status "pending".

**`get_messages`** — Check your mailbox.
- Input: `agent_name` (string), `status` (optional: "pending" | "read" | "all"), `limit` (optional, default 20)
- Returns messages addressed to you, newest first. Marks returned pending messages as "read".

**`broadcast`** — Send a message to all agents (or all with a specific role).
- Input: `from` (string), `content` (string), `role` (optional string filter)
- Creates one message record per recipient.

### Tasks (2 tools)

**`post_task`** — Assign a task to another agent.
- Input: `from` (string), `to` (string), `title` (string), `description` (string), `priority` ("low" | "normal" | "high" | "critical")
- Creates a task with status "posted".

**`update_task`** — Accept, complete, or reject a task.
- Input: `task_id` (string), `agent_name` (string), `action` ("accept" | "complete" | "reject"), `result` (optional string)
- State machine: posted -> accepted -> completed (or posted/accepted -> rejected)
- Only the assigned agent can update the task.

## Data Model

Three SQLite tables. All use UUID primary keys generated server-side.

### `agents`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| name | TEXT UNIQUE | Human-readable identifier |
| role | TEXT | e.g., "orchestrator", "builder", "ops" |
| capabilities | TEXT | JSON array of strings |
| last_seen | TEXT | ISO 8601 timestamp |
| created_at | TEXT | ISO 8601 timestamp |

Index: `idx_agents_name` on `name`, `idx_agents_role` on `role`.

### `messages`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| from_agent | TEXT | Sender name |
| to_agent | TEXT | Recipient name |
| content | TEXT | Free-form text |
| priority | TEXT | "normal" or "high" |
| status | TEXT | "pending", "read" |
| created_at | TEXT | ISO 8601 timestamp |

Indexes: `idx_messages_to_status` on `(to_agent, status)`, `idx_messages_created` on `created_at`.

### `tasks`

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| from_agent | TEXT | Who posted the task |
| to_agent | TEXT | Who should do it |
| title | TEXT | Short description |
| description | TEXT | Full task details |
| priority | TEXT | "low", "normal", "high", "critical" |
| status | TEXT | "posted", "accepted", "completed", "rejected" |
| result | TEXT | Completion notes (nullable) |
| created_at | TEXT | ISO 8601 timestamp |
| updated_at | TEXT | ISO 8601 timestamp |

Indexes: `idx_tasks_to_status` on `(to_agent, status)`, `idx_tasks_from` on `from_agent`.

## Integration

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "bot-relay": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/bot-relay-mcp/dist/index.js"]
    }
  }
}
```

Every Claude Code terminal that opens will spawn its own server process. They all share `~/.bot-relay/relay.db`.

## Example Workflow: Task Delegation

Victra (orchestrator) needs Ops to run a server health check.

```
1. Victra calls register_agent("victra", "orchestrator", ["planning", "delegation"])
2. Victra calls discover_agents() — sees Ops is registered
3. Victra calls post_task(from: "victra", to: "ops", title: "Health check",
     description: "Run n8n health check and report status", priority: "high")
   → Returns task_id: "abc-123"

4. Ops calls get_messages("ops") — no direct messages, but...
5. Ops calls get_tasks("ops", status: "posted") — sees the health check task
   (Note: get_tasks is handled via discover or a filtered query; tasks are
    retrieved by the assigned agent checking their queue)
6. Ops calls update_task("abc-123", "ops", "accept")
   → Task status: accepted

7. Ops runs the health check...

8. Ops calls update_task("abc-123", "ops", "complete",
     result: "n8n healthy, 2.13.3, uptime 14 days, no errors")
   → Task status: completed

9. Victra calls discover_agents() or checks task status
   → Sees task "abc-123" is completed with result
```

## Build Plan

### Day 1: Core Relay (~4-5 hours)
- Project scaffold: package.json, tsconfig, directory structure
- SQLite setup: schema creation, WAL mode, connection management
- Types and Zod schemas for all inputs
- Identity tools: register_agent, discover_agents
- Messaging tools: send_message, get_messages, broadcast
- MCP server wiring: tool registration, stdio transport
- Manual smoke test with two terminals

### Day 2: Tasks + Tests (~3-4 hours)
- Task tools: post_task, update_task
- State machine validation (posted -> accepted -> completed/rejected)
- Database layer tests (vitest)
- Integration tests: full tool call flows
- Edge cases: duplicate names, messages to nonexistent agents, invalid state transitions

### Day 3: Polish (~2-3 hours)
- Error messages: clear, actionable
- Input validation: all edge cases covered
- DB cleanup: auto-purge messages older than 7 days
- README with setup instructions
- Build script, npm package prep

**Estimated total: ~1,400 lines of TypeScript**

## Deferred to v2

These features are explicitly out of scope for v1:

- **HTTP transport** — SSE or WebSocket for remote agents
- **Auth tokens** — agent identity verification
- **Encryption** — message content encryption at rest
- **Channels** — topic-based message routing (like Slack channels)
- **Webhooks** — external notifications on events
- **Web dashboard** — browser UI to monitor agents and messages
- **Message persistence config** — configurable TTL per message type
- **Task dependencies** — task chains and DAGs
- **Rate limiting** — per-agent message quotas

v1 is local-only, trusted, minimal. Get the core loop working first.

## Deferred to v2.3+ (federation)

v2.1.0 ships a single-node MCP relay. Cross-edge federation is a v2.3 (hub) + v3 (P2P) roadmap item. To avoid a breaking envelope migration later, v2.1.0 freezes the shape now:

- **`docs/federation-envelope-v1.md`** — frozen cross-edge event envelope. Signed with ed25519 by the origin edge; replay-safe via `(origin_edge, event_id)` seen-set; additive event-type enum; `protocol_version` = `"1"`. Paper spec only — no v2.1.0 code reads or writes it.
- **`mailbox` + `agent_cursor` tables** (schema v6 via `migrateSchemaToV2_4`) — empty in v2.1.0; reserved for Phase 4s v2.2 per-recipient delivery-seq protocol.
- **`agents.visibility` column** — `'local' | 'federated'`, default `'local'`. v2.3 hub federation reads this to decide which agents surface across the hub; all v2.1.0 rows are local.

All three surfaces reserve shape without changing behavior. v2.1.0 is compatible with any future federation phase that uses the frozen envelope.
