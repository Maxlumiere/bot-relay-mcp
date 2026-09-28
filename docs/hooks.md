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
alias ai-orchestrator='RELAY_AGENT_NAME=orchestrator claude'
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

- **Pending messages** — exactly what `get_messages(status="pending")` would return, in the same order (priority first, then newest). The hook reads them through `relay pending AGENT --with-content 10`, so it holds no query of its own. It shows up to 10 bodies and says how many are pending in all. Bodies stored encrypted are shown decrypted when this environment has the key, and as a placeholder otherwise, never as ciphertext. The read marks nothing: the mail stays pending until the agent calls `get_messages`. The hook's verdict is HEALTHY only once this mail read has completed. `relay pending` also decides WHERE the mail is, as the `PostToolUse` and `Stop` hooks do: with no local instance and `RELAY_HTTP_HOST` set, the mail comes from the remote relay and the header says `via remote relay`. If a local read fails (a missing, corrupt or too-old DB, the wrong instance, or a read still running at its deadline, inside the hook's installed budget (what is left of 10 s after registration at session start; 5 s for PostToolUse and Stop), which `RELAY_PENDING_TIMEOUT_SECS` may only shorten), the hook says `relay unreadable` rather than showing nothing, the verdict is `DEGRADED`, and nothing is asked over HTTP. An answer whose count contradicts its messages is refused the same way. Active tasks that cannot be rendered are reported too, never dropped. With no agent name set (the unresolved fallback `default`), no mail is read and the verdict is `CANNOT-JUDGE`: run `relay init --agent <name>` (or set `RELAY_AGENT_NAME`). Message bodies and task titles are FRAMED: every line after the first starts with `    | `. Every line terminator counts as a newline (CR, LF, VT, FF, NEL, U+2028, U+2029 and the like), and other control characters and ANSI escapes are removed, so no sender text can start a line and pose as a `[RELAY]` line from the hook. The framing does not make the content trusted: it is still what the sender wrote.
- **Active tasks** — tasks assigned to you with status "posted" or "accepted", sorted by priority

## Example output

When you open a terminal and have pending items:

```
[RELAY] Pending messages for orchestrator (showing 1 of 1):
  From: ops | Server health check complete, all green. (2026-04-13T15:30:00Z)

[RELAY] Active tasks for orchestrator:
  [high] Review auth module PR (from: builder, id: abc-123)
  [normal] Update deployment docs (from: ops, id: def-456)
```

Claude sees this automatically and can act on it without you asking.

## Requirements

- `sqlite3` command-line tool (pre-installed on macOS and most Linux), and `node` (the hook runs the `relay` CLI beside it)
- The `RELAY_AGENT_NAME` environment variable set before launching Claude Code

## Custom database path

If your relay database is in a non-default location, set `RELAY_DB_PATH`:

```bash
export RELAY_DB_PATH="/custom/path/relay.db"
```

Default: `~/.bot-relay/relay.db`

## Verdict words

Every relay hook ends with exactly one `[RELAY] VERDICT=<WORD> reason="..."` line. The words are one closed set, defined with their meaning in [`hooks/_verdict.sh`](../hooks/_verdict.sh) and shared by every hook. In short: `HEALTHY` means every check concluded well. `DEGRADED` means a concluded fault; a local mail read that failed is always `DEGRADED`, with the reason `relay unreadable: <why>`. `CANNOT-JUDGE` means no judgement was made. The rest (`MUTE`, `UNWAKEABLE`, `TAKEOVER_LIVENESS_UNVERIFIABLE`, `AUTH_FAILED`, `REGISTER_FAILED`) name specific faults. The words are a total order, most severe first: `MUTE` > `AUTH_FAILED` > `UNWAKEABLE` > `TAKEOVER_LIVENESS_UNVERIFIABLE` > `REGISTER_FAILED` > `DEGRADED` > `CANNOT-JUDGE` > `HEALTHY`. The most severe wins; two faults at the same level keep both reasons, the mail-read one first.

**Known limit:** the mail read resolves its DB through `relay pending`, but this hook's liveness and task reads still resolve the DB in shell until a single shared resolver lands. If that shell path resolves outside `$HOME` and the temp roots, those two reads are skipped (the verdict is `DEGRADED` in local mode) and the mail read still runs.

## Stale token? Run `relay recover`

The hook probes `health_check` with the presented `RELAY_AGENT_TOKEN` first. If the daemon reports an auth error — because the terminal restarted, a new token was issued in another session, or the row was somehow desynced — the hook surfaces a clear stderr message telling the operator what to do (set `RELAY_RECOVERY_TOKEN` if an admin issued one, or fall through to `relay recover`).

The hook NEVER writes the agent row directly via `sqlite3` (Phase 7p HIGH #3 — that path created impossible `auth_state='active' + token_hash IS NULL` rows). Instead, it calls the daemon's `register_agent` over HTTP, so the server enforces every auth-state invariant. If the daemon is unreachable, the hook skips the register silently; mail delivery still runs read-only through `relay pending`, and task delivery through read-only sqlite3.

Run `relay recover <agent-name>` (filesystem-gated, see [`README.md`](../README.md#lost-token-recovery-v21)) to clear a registration and let the next session re-bootstrap via the hook.

## Related hooks

- [`docs/post-tool-use-hook.md`](./post-tool-use-hook.md) — `PostToolUse` hook for intra-turn mail delivery (fires after every tool call).
- [`docs/stop-hook.md`](./stop-hook.md) — `Stop` hook for turn-end mail delivery (fires on every turn-end, closes the text-only-turn gap).
