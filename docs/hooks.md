# Hook Configuration

Hooks let Claude Code terminals automatically check the relay for messages without being asked. This turns the relay from "pull-only" into something closer to push-based communication.

**Writing a new hook?** See [`hook-payload-format.md`](./hook-payload-format.md) for the exact JSON payload Claude Code 2.1.x passes on stdin per event type (SessionStart / Stop / PostToolUse / PreToolUse / UserPromptSubmit), plus minimal reader templates in Node + bash.

## How it works

Claude Code supports `SessionStart` hooks — shell commands that run when a terminal opens or resumes. The hook's stdout is injected directly into Claude's context, so the agent sees any pending messages immediately.

## Setup

### 1. Set your agent name

The hook needs to know which agent's mailbox to check. Set the `RELAY_AGENT_NAME` environment variable before launching Claude Code:

```bash
# In your shell profile (~/.zshrc or ~/.bashrc)
export RELAY_AGENT_NAME="myagent"

# Or per-terminal with an alias
alias ai-victra='RELAY_AGENT_NAME=victra claude'
alias ai-ops='RELAY_AGENT_NAME=ops claude'
```

### 2. Add the hook to your settings

Add to `~/.claude/settings.json` (global) or `.claude/settings.json` (per-project):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/bot-relay-mcp/hooks/check-relay.sh",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/` with the actual path to your bot-relay-mcp installation.

### 3. That's it

Every time you open a Claude Code terminal (or resume a session), the hook checks for pending messages and tasks. If there are any, they appear in Claude's context automatically. If there's nothing pending, the hook stays silent.

## What the hook checks

- **Pending messages** — messages sent to your agent that haven't been read yet
- **Active tasks** — tasks assigned to you with status "posted" or "accepted", sorted by priority

## Example output

When you open a terminal and have pending items:

```
[RELAY] Pending messages for victra:
  From: ops | Server health check complete, all green. (2026-04-13T15:30:00Z)

[RELAY] Active tasks for victra:
  [high] Review auth module PR (from: builder, id: abc-123)
  [normal] Update deployment docs (from: ops, id: def-456)
```

Claude sees this automatically and can act on it without you asking.

## Requirements

- `sqlite3` command-line tool (pre-installed on macOS and most Linux)
- The `RELAY_AGENT_NAME` environment variable set before launching Claude Code

## Custom database path

If your relay database is in a non-default location, set `RELAY_DB_PATH`:

```bash
export RELAY_DB_PATH="/custom/path/relay.db"
```

Default: `~/.bot-relay/relay.db`

## Stale token? Run `relay recover`

The hook probes `health_check` with the presented `RELAY_AGENT_TOKEN` first. If the daemon reports an auth error — because the terminal restarted, a new token was issued in another session, or the row was somehow desynced — the hook surfaces a clear stderr message telling the operator what to do (set `RELAY_RECOVERY_TOKEN` if an admin issued one, or fall through to `relay recover`).

The hook NEVER writes the agent row directly via `sqlite3` (Phase 7p HIGH #3 — that path created impossible `auth_state='active' + token_hash IS NULL` rows). Instead, it calls the daemon's `register_agent` over HTTP, so the server enforces every auth-state invariant. If the daemon is unreachable, the hook skips the register silently; mail/task delivery still runs via read-only sqlite3.

Run `relay recover <agent-name>` (filesystem-gated, see [`README.md`](../README.md#lost-token-recovery-v21)) to clear a registration and let the next session re-bootstrap via the hook.

## Related hooks

- [`docs/post-tool-use-hook.md`](./post-tool-use-hook.md) — `PostToolUse` hook for intra-turn mail delivery (fires after every tool call).
- [`docs/stop-hook.md`](./stop-hook.md) — `Stop` hook for turn-end mail delivery (fires on every turn-end, closes the text-only-turn gap).
