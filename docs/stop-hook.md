# Stop Hook — Turn-End Mail Delivery (v2.1)

The `PostToolUse` hook (`docs/post-tool-use-hook.md`) fires after every tool call and delivers mail near-real-time. But a turn that ends in a text-only response — no tool calls — does not trigger `PostToolUse`, so mail that arrives during such a turn is not surfaced until the next tool call or `SessionStart`.

The `Stop` hook closes that gap. It fires on every turn-end regardless of whether the turn invoked tools, checks the mailbox, and injects any pending messages as `additionalContext` on the next turn.

## When to install

Install `Stop` in **every project where you already install `PostToolUse`**. They complement, not replace:

| Hook | When it fires | What it delivers |
|---|---|---|
| `SessionStart` | Terminal open / resume | Mail + active tasks (snapshot) |
| `PostToolUse` | After every tool call | Mail only (intra-turn push) |
| `Stop` | On every turn-end (even text-only) | Mail only (turn-boundary push) |

## Per-project install (NOT global)

**Do not put this in `~/.claude/settings.json`.** A global install fires in every Claude Code terminal — including ones that have no relay identity (`RELAY_AGENT_NAME` unset) or do not want relay involvement at all. Per-project opt-in is the correct pattern.

Add to `<project>/.claude/settings.json` (alongside `PostToolUse`):

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/bot-relay-mcp/hooks/stop-check.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/` with the actual path to your bot-relay-mcp installation. `timeout: 5` gives the hook 5 seconds — it aims for under 2, but the Claude Code timeout is the hard ceiling.

### ❗ Paths containing spaces — single-quote inside the JSON string

Claude Code invokes the `command` string via the shell. The shell splits on whitespace, so a path like `/Users/name/Documents/Ai stuff/bot-relay-mcp/hooks/stop-check.sh` gets interpreted as `/Users/name/Documents/Ai` + the arguments `stuff/bot-relay-mcp/hooks/stop-check.sh`. The first piece is a directory, not an executable, so the shell errors with `/bin/sh: ... is a directory` — and because the hook's stderr is not surfaced to the user by default, the hook **silently fails**.

**Fix:** wrap the path in single quotes inside the JSON string:

```json
"command": "'/Users/maxime/Documents/Ai stuff/Claude AI/bot-relay-mcp/hooks/stop-check.sh'"
```

The outer double-quotes are JSON syntax. The inner single-quotes survive into the shell invocation and preserve the whole path as one argument. Paths without spaces do not need this, but the single-quote-always pattern is harmless and is the safer default.

## Environment variables

The hook reads the same env vars as `PostToolUse`:

| Var | Purpose | Default |
|---|---|---|
| `RELAY_AGENT_NAME` | Which agent mailbox to check | (unset → hook silently exits) |
| `RELAY_AGENT_TOKEN` | Auth token for HTTP path | (unset → HTTP path skipped, sqlite fallback used) |
| `RELAY_HTTP_HOST` | Relay HTTP host | `127.0.0.1` |
| `RELAY_HTTP_PORT` | Relay HTTP port | `3777` |
| `RELAY_DB_PATH` | Sqlite DB path (sqlite fallback only) | `~/.bot-relay/relay.db` |
| `RELAY_HOOK_MAX_MESSAGES` | Max messages per firing | `20` |

Typical setup via shell alias (matches the `SessionStart` + `PostToolUse` pattern):

```bash
alias ai-victra='RELAY_AGENT_NAME=victra RELAY_AGENT_TOKEN=<your-token> claude'
```

## What the hook does

1. Validates all env-var inputs against an allowlist (no surprises in URLs or SQL).
2. If `RELAY_AGENT_TOKEN` is set AND the HTTP daemon responds on `/health` within 1 second, uses `get_messages` via `/mcp`. This path goes through the full auth / rate-limit / audit pipeline. Messages are marked `read` server-side.
3. Otherwise falls back to sqlite direct on `RELAY_DB_PATH`. Reads pending rows, formats them, then marks those specific message IDs `read` in a follow-up statement.
4. Emits a single-line Claude Code hook JSON (`{"continue": true, "hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": "..."}}`) to stdout. The content looks like:
   ```
   [RELAY] New mail for victra-build (2 messages):
     [high] from victra at 2026-04-17T20:15:00Z:
       re-audit ready
     [normal] from ops at 2026-04-17T20:16:30Z:
       smoke green
   ```
5. If there is no mail, or any error happens, the hook exits silently with empty stdout — never pollutes the conversation.

## What the hook does NOT do

- **It does NOT wake truly idle terminals.** If no turn is in progress, the hook does not fire. Mail that arrives while the agent is sitting idle (no user message, no in-progress turn) will not be delivered until either a user types something, the agent's next turn ends, or a `SessionStart` fires on terminal open. For long-idle windows, use the Layer 2 Managed Agent (see `examples/managed-agent-reference/`).
- **It does NOT re-register the agent.** `SessionStart` handles registration. If the agent is not registered when the hook fires, the hook silently exits.
- **It does NOT check tasks.** Task surfacing stays in `SessionStart` for now (simpler, less context-pressure). `Stop` is dedicated to live message delivery only, same as `PostToolUse`.
- **It does NOT read stdin.** The Stop hook stdin payload is ignored — the mail check is event-agnostic.
- **It does NOT retry.** A single budget, silent-fail, wait for the next turn.

## Timing budget

The hook self-imposes a ~2 second budget (1s health probe + 2s `get_messages` call). On an unreachable relay + missing DB, the full-fail path completes in tens of milliseconds. Claude Code's `timeout` field is the hard ceiling; set it to 5 or higher in settings.json to leave headroom.

## Troubleshooting

**Hook silently fails on paths with spaces.** Most common install bug. Claude Code passes the `command` string to `/bin/sh`, which splits on whitespace. Fix: single-quote the path inside the JSON string — see "Paths containing spaces" above. Verify with `sh -c "$COMMAND"` where `$COMMAND` is the exact string from your settings.json.

**Hook fires but messages never appear.** Check that:
- `RELAY_AGENT_NAME` matches the name the SessionStart hook registered under.
- The relay daemon is running (`curl http://127.0.0.1:3777/health` returns `status:ok`).
- If using HTTP, `RELAY_AGENT_TOKEN` is set and matches the agent.
- If using sqlite, the DB path is correct and you have read+write access to it.

**Mail delivery feels duplicated between PostToolUse and Stop.** That's expected by design — whichever hook fires first marks the mail as read, so the other sees an empty mailbox. If you see the same message surfaced twice in one turn, check that `RELAY_AGENT_TOKEN` is identical in both hook configs (mismatched tokens can cause HTTP-vs-sqlite path divergence and race on the mark-as-read).

**Hook output looks like stray JSON in my conversation.** That would mean the hook JSON is not being parsed as a Claude Code hook response. Check that the `type: "command"` and `command: "/path/..."` config in settings.json are correct and the script has `+x` permission.

## Related

- [`docs/hooks.md`](./hooks.md) — SessionStart hook (terminal-open mail check)
- [`docs/post-tool-use-hook.md`](./post-tool-use-hook.md) — intra-turn mail delivery
- [`hooks/stop-check.sh`](../hooks/stop-check.sh) — script source
- [`tests/hooks-stop.test.ts`](../tests/hooks-stop.test.ts) — integration tests
