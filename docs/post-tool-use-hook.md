# PostToolUse Hook — Near-Real-Time Mail Delivery (v1.8)

The `SessionStart` hook (`docs/hooks.md`) gives you a one-shot mail check at terminal open. That is great for resuming a session, but it does nothing if messages arrive WHILE the agent is working — you have to wait for the next terminal open (or a human paste) before the agent sees them.

The `PostToolUse` hook closes that gap. It fires after every tool call, checks the mailbox, and injects any pending messages as `additionalContext` — the running Claude Code session sees them immediately.

## When to install

Install `PostToolUse` in **every project you run a relay-registered agent from**. Recommended with the `SessionStart` hook, not instead of it:

| Hook | When it fires | What it delivers |
|---|---|---|
| `SessionStart` | Terminal open / resume | Mail + active tasks (snapshot) |
| `PostToolUse` | After every tool call | Mail only (push-style) |

## Per-project install (NOT global)

**Do not put this in `~/.claude/settings.json`.** A global install fires in every Claude Code terminal — including ones that have no relay identity (`RELAY_AGENT_NAME` unset) or do not want relay involvement at all. Per-project opt-in is the correct pattern.

Add to `<project>/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/bot-relay-mcp/hooks/post-tool-use-check.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/` with the actual path to your bot-relay-mcp installation. `matcher: "*"` fires after every tool. `timeout: 5` gives the hook 5 seconds — it aims for under 2, but the Claude Code timeout is the hard ceiling.

### ❗ Paths containing spaces — single-quote inside the JSON string

Claude Code invokes the `command` string via the shell. The shell splits on whitespace, so a path like `/Users/name/Documents/Ai stuff/bot-relay-mcp/hooks/post-tool-use-check.sh` gets interpreted as `/Users/name/Documents/Ai` + the arguments `stuff/bot-relay-mcp/hooks/post-tool-use-check.sh`. The first piece is a directory, not an executable, so the shell errors out with `/bin/sh: ... is a directory` — and because the hook's stderr is not surfaced to the user by default, the hook **silently fails**.

**Fix:** wrap the path in single quotes inside the JSON string:

```json
"command": "'/Users/maxime/Documents/Ai stuff/Claude AI/bot-relay-mcp/hooks/post-tool-use-check.sh'"
```

The outer double-quotes are JSON syntax. The inner single-quotes survive into the shell invocation and preserve the whole path as one argument. Paths without spaces do not need this, but the single-quote-always pattern is harmless and is the safer default.

**Quick diagnostic:** on a suspect install, manually run `sh -c "$COMMAND"` where `$COMMAND` is the exact string from your settings.json — if the shell splits it, you will see the split immediately.

## Environment variables

The hook reads these:

| Var | Purpose | Default |
|---|---|---|
| `RELAY_AGENT_NAME` | Which agent mailbox to check | (unset → hook silently exits) |
| `RELAY_AGENT_TOKEN` | Auth token for HTTP path | (unset → HTTP path skipped, sqlite fallback used) |
| `RELAY_HTTP_HOST` | Relay HTTP host | `127.0.0.1` |
| `RELAY_HTTP_PORT` | Relay HTTP port | `3777` |
| `RELAY_DB_PATH` | Sqlite DB path (sqlite fallback only) | `~/.bot-relay/relay.db` |
| `RELAY_HOOK_MAX_MESSAGES` | Max messages per firing | `20` |

Typical setup via shell alias (the SessionStart hook already uses this pattern):

```bash
alias ai-victra='RELAY_AGENT_NAME=victra RELAY_AGENT_TOKEN=<your-token> claude'
```

## What the hook does

1. Validates all env-var inputs against an allowlist (no surprises in URLs or SQL).
2. If `RELAY_AGENT_TOKEN` is set AND the HTTP daemon responds on `/health` within 1 second, uses `get_messages` via `/mcp`. This path goes through the full auth / rate-limit / audit pipeline. Messages are marked `read` server-side.
3. Otherwise falls back to sqlite direct on `RELAY_DB_PATH`. Reads pending rows, formats them, then marks those specific message IDs `read` in a follow-up statement.
4. Emits a single-line Claude Code hook JSON (`{"continue": true, "hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "..."}}`) to stdout. The content looks like:
   ```
   [RELAY] New mail for victra-build (2 messages):
     [high] from victra at 2026-04-15T07:43:23Z:
       please review the v1.8 plan
     [normal] from ops at 2026-04-15T07:44:01Z:
       deploy green
   ```
5. If there is no mail, or any error happens, the hook exits silently with empty stdout — never pollutes the conversation.

## What the hook does NOT do

- **It does NOT re-register the agent.** The `SessionStart` hook handles registration. If the agent is not registered when the hook fires, the hook silently exits.
- **It does NOT check tasks.** Task surfacing stays in `SessionStart` for now (simpler, less context-pressure). Dedicate `PostToolUse` to live message delivery only.
- **It does NOT read stdin.** The PostToolUse stdin payload (tool_name, tool_input, tool_response) is ignored — the mail check is tool-agnostic.
- **It does NOT retry.** A single budget, silent-fail, wait for the next tool call.
- **It does NOT work for idle terminals.** If no tool is running, the hook will not fire — honest limitation. Use the SessionStart hook + human attention for long-idle windows.

## Timing budget

The hook self-imposes a ~2 second budget (1s health probe + 2s `get_messages` call). On an unreachable relay + missing DB, the full-fail path completes in tens of milliseconds. Claude Code's `timeout` field is the hard ceiling; set it to 5 or higher in settings.json to leave headroom.

## Troubleshooting

**Hook silently fails on paths with spaces.** This is the most common install bug. Claude Code passes the `command` string to `/bin/sh`, which splits on whitespace. A path like `/Users/name/Ai stuff/bot-relay-mcp/...` gets split at the space and the shell errors with `is a directory` — which you never see because hook stderr is not surfaced by default. **Fix:** single-quote the path inside the JSON string — see "Paths containing spaces" above. Verify with `sh -c "$COMMAND"` where `$COMMAND` is the exact string from your settings.json.

**Hook fires but messages never appear.** Check that:
- `RELAY_AGENT_NAME` matches the name the SessionStart hook registered under.
- The relay daemon is running (`curl http://127.0.0.1:3777/health` returns `status:ok`).
- If using HTTP, `RELAY_AGENT_TOKEN` is set and matches the agent.
- If using sqlite, the DB path is correct and you have read+write access to it.

**Hook output looks like stray JSON in my conversation.** That would mean the hook JSON is not being parsed as a Claude Code hook response. Check that the `type: "command"` and `command: "/path/..."` config in settings.json are correct and the script has `+x` permission.

**Hook feels slow.** The `/health` probe is capped at 1s. If that times out frequently, your relay daemon is overloaded or binding to a different interface. Reduce the polling surface by shortening `RELAY_HOOK_MAX_MESSAGES`.

**Hook triggered a rate limit.** The HTTP path counts against the relay's rate-limit buckets. `get_messages` is not in the rate-limited set (`messages`, `tasks`, `spawns`) by default, so this should not happen — file a bug if it does.

## Related

- [`docs/hooks.md`](./hooks.md) — SessionStart hook (terminal-open mail check)
- [`hooks/post-tool-use-check.sh`](../hooks/post-tool-use-check.sh) — script source
- [`tests/hooks-post-tool-use.test.ts`](../tests/hooks-post-tool-use.test.ts) — integration tests
