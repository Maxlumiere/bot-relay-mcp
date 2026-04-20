# Transport Architecture — stdio vs http

bot-relay-mcp supports two MCP transports: **stdio** (default) and **http**. This doc explains the process boundaries so operators correctly attribute restart-time symptoms.

## TL;DR

- **stdio MCP clients are process-independent.** Each Claude Code terminal with `"type":"stdio"` in `~/.claude.json` spawns its own `node dist/index.js` child process. Those child processes share `~/.bot-relay/relay.db` but otherwise do not communicate.
- **The `:3777` HTTP daemon is a separate long-running process.** It only serves `"type":"http"` MCP clients pointed at its URL.
- **Restarting the HTTP daemon does NOT drop stdio clients.** Each stdio client's own server process is unaffected.
- **When a Claude Code terminal closes (SIGINT/SIGTERM)**, its stdio server process marks the agent row offline (v2.1.3+) — session_id clears, agent_status='offline', token_hash + capabilities + description preserved. A new terminal with the same `RELAY_AGENT_NAME` resumes via the standard active-state re-register path without operator ceremony.

## Process topology

```
                 ~/.bot-relay/relay.db (SQLite, WAL)
                         ▲     ▲     ▲     ▲
                         │     │     │     │
        ┌────────────────┘     │     │     └─────────────────┐
        │                      │     │                       │
  ┌─────┴──────┐       ┌───────┴─┐   ┌──┴────────┐    ┌──────┴────┐
  │  :3777     │       │ Claude  │   │ Claude    │    │ Cursor /  │
  │  HTTP      │       │ Code    │   │ Code      │    │ Cline /   │
  │  daemon    │       │ term #1 │   │ term #2   │    │ n8n Mgd.  │
  │  (node     │       │ (stdio  │   │ (stdio    │    │ Agent     │
  │  dist/     │       │  node   │   │  node     │    │ (HTTP     │
  │  index.js) │       │  dist/  │   │  dist/    │    │  client)  │
  │            │       │  index  │   │  index)   │    │           │
  └────────────┘       └─────────┘   └───────────┘    └─────┬─────┘
       ▲                                                     │
       │                                                     │
       └──────────── HTTP POST /mcp ────────────────────────┘
```

Each box is a separate OS process. The only shared state is the SQLite database file + WAL journal.

## When does a transport restart affect whom?

| Event | Affects HTTP MCP clients? | Affects stdio MCP clients? |
|---|---|---|
| `:3777` daemon killed + relaunched | YES — client must `/mcp` to reconnect | No — unaffected |
| Claude Code terminal closes | No — its own stdio server exits with it | N/A — it IS the stdio client |
| Claude Code terminal reopens with same `RELAY_AGENT_NAME` | No | Resumes cleanly via active-state re-register (v2.1.3+). Token + caps + description preserved. |
| `npm publish` + daemon binary swap | YES — client must `/mcp` after daemon is back | No — stdio terminals pick up the new binary at their NEXT restart |
| `kill -SIGKILL` on a stdio Claude Code child | No | That agent's row remains with stale session_id until next terminal with same name re-registers, or until 30-day dead-agent purge |

## Post-restart operator checklist

After restarting the `:3777` daemon:

1. **Verify daemon is up:** `curl -s http://127.0.0.1:3777/health` — expect `{"status":"ok","version":"..."}`.
2. **HTTP MCP clients only:** any Claude Code terminal whose `~/.claude.json` has `"type":"http"` pointed at the restarted daemon must run `/mcp` to reconnect. Same applies to Cursor / Cline / n8n Managed Agents configured against the HTTP endpoint.
3. **stdio MCP clients:** no action needed. Their server processes did not restart.

## Why the v2.1.3 change matters

Before v2.1.3, a Claude Code stdio terminal's SIGINT handler DELETED the agent row from the database. That meant closing a terminal destroyed the agent's durable identity (token_hash, capabilities, description). Every respawn had to re-bootstrap from scratch, and operators had to re-paste tokens or run `relay recover`.

v2.1.3 changes the SIGINT behavior to **mark the row offline** instead:

- `session_id` clears (so a sibling terminal can cleanly claim the name).
- `agent_status = 'offline'`.
- `token_hash`, `capabilities`, `description`, `role`, `auth_state`, `managed`, `visibility` are preserved.

The original concurrent-instance-wipe protection (v2.0.1 Codex HIGH 1) is preserved via the same CAS predicate on `session_id` — a stale SIGINT cannot clobber a sibling terminal's fresh session.

A forensic `audit_log` entry (`tool='stdio.auto_offline'`) is written on every SIGINT-triggered offline transition, closing the previous silent-DELETE path.

## Recovery paths (unchanged)

If an agent's row is genuinely stuck and needs to be wiped:

- **Operator-invoked:** `bin/relay recover <name> --yes` — DELETEs the row + capabilities + audit_log entry. Use when you genuinely want a fresh-bootstrap start.
- **MCP tool:** `unregister_agent(name, agent_token)` — caller's token must match. Also DELETEs.

These two paths remain intact. They are explicit operator actions with delete semantics; SIGINT/SIGTERM no longer shares those semantics.

## Related docs

- `README.md` — Quick Start.
- `HANDOFF.md` — operational cheat sheet.
- `docs/multi-machine-deployment.md` — centralized HTTP daemon deployment (Phase 7r).
- `architecture.md` — full architecture spec.
