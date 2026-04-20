# CLAUDE.md Snippet for Bot Relay

Add this to any project's `CLAUDE.md` to make Claude automatically use the relay. Copy the section below into your file.

---

```markdown
## Agent Relay

This project uses bot-relay-mcp for inter-agent communication. At the start of every session:

1. Register on the relay: `register_agent` with your name, role, and capabilities
2. Check for pending messages: `get_messages` with your agent name
3. Check for pending tasks: `get_tasks` with your agent name and role "assigned"
4. If there are pending tasks, work on them before starting new work
5. When you finish a task, call `update_task` with action "complete" and include results
6. If you need another agent's help, use `send_message` or `post_task`
```

---

## Per-role examples

For an orchestrator/planner agent:
```markdown
## Agent Relay
You are the orchestrator. Register as "orchestrator" with role "planner".
Check messages and tasks at session start. Delegate work to other agents via post_task.
Monitor task completion via get_tasks with role "posted".
```

For a builder/worker agent:
```markdown
## Agent Relay
You are a worker agent. Register as "worker-1" with role "builder".
Check messages and tasks at session start. Accept and complete tasks assigned to you.
Report results via update_task and send_message.
```
