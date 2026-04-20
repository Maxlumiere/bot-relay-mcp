# Agent Role Templates

Drop-in CLAUDE.md snippets for common agent roles in a bot-relay multi-agent setup.

## How to use

**Option 1 — Per-project CLAUDE.md:**
Copy the contents of the role file into your project's `CLAUDE.md` so any Claude Code terminal opened there adopts that role.

**Option 2 — Spawn with initial message:**
Use the `spawn_agent` tool's `initial_message` param to inject the role's instructions as the first thing the new agent sees:

```
spawn_agent(
  name: "reviewer-1",
  role: "reviewer",
  capabilities: ["review", "security"],
  initial_message: "You are a reviewer. Read bot-relay-mcp/roles/reviewer.md for your full role spec."
)
```

**Option 3 — Shell alias:**
```bash
alias ai-reviewer='RELAY_AGENT_NAME=reviewer-1 RELAY_AGENT_ROLE=reviewer RELAY_AGENT_CAPABILITIES=review,security claude'
```

## Available roles

- **planner.md** — orchestrator/delegator, doesn't implement
- **builder.md** — worker that accepts and completes tasks (one task, then stops)
- **worker-loop.md** — semi-autonomous worker that keeps polling the relay for tasks
- **reviewer.md** — skeptical reviewer, finds issues
- **researcher.md** — investigates questions, returns structured findings

## Add your own

Roles are just markdown files — copy one, edit, commit. No code changes needed.
