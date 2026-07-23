# Stop Hook — Turn-Boundary Wake (v2.1, rewritten v2.23)

The `PostToolUse` hook (`docs/post-tool-use-hook.md`) fires after every tool call and delivers mail near-real-time. But a turn that ends in a text-only response — no tool calls — does not trigger `PostToolUse`, so mail that arrives during such a turn is not surfaced until the next tool call or `SessionStart`.

The `Stop` hook closes that gap. It fires at every turn end regardless of whether the turn invoked tools, **peeks** at the mailbox, and — if mail is pending — emits `decision:"block"` so the agent continues immediately and fetches its own mail with `get_messages`.

**Why a wake and not a delivery (the v2.23 rewrite).** Verified against the Claude Code hooks contract: `additionalContext` on a Stop hook does not wake the agent — it is queued for the *next* model request, which only happens if a future turn starts. The original v2.1 hook marked mail read while emitting `additionalContext`; if the session died before that next turn, the mail was dropped-as-read and invisible to Sentinel and every other floor path (they key on unread). The rewrite removes the entire class: the hook performs **zero writes** (no `UPDATE` exists in the script — enforced by a structural test), so read continues to mean received. Content delivery rides the agent's own authenticated `get_messages` call, the one place mark-as-read has always been correct.

## When to install

Install `Stop` in **every project where you already install `PostToolUse`**. They complement, not replace:

| Hook | When it fires | What it delivers |
|---|---|---|
| `SessionStart` | Terminal open / resume | Mail + active tasks (snapshot) |
| `PostToolUse` | After every tool call | Mail only (intra-turn push) |
| `Stop` | At every turn end (even text-only) | A wake only — the agent fetches its own mail |

**Cost, stated honestly:** a `decision:"block"` steals the turn boundary — the agent continues into mail processing before yielding, and anything the human types meanwhile queues behind that continuation. Two guards bound it: `stop_hook_active` in the hook payload (one wake per natural stop — if the agent could not drain its inbox in the granted continuation, it stops and the floor takes over) and a per-agent time damper (default 120s). Both guards leave the mail **pending** when they suppress: a delayed wake, never a lost one.

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

Claude Code invokes the `command` string via the shell. The shell splits on whitespace, so a path like `/path/to/My Projects/bot-relay-mcp/hooks/stop-check.sh` gets interpreted as `/path/to/My` + the arguments `Projects/bot-relay-mcp/hooks/stop-check.sh`. The first piece is a directory, not an executable, so the shell errors with `/bin/sh: ... is a directory` — and because the hook's stderr is not surfaced to the user by default, the hook **silently fails**.

**Fix:** wrap the path in single quotes inside the JSON string:

```json
"command": "'/path/to/My Projects/bot-relay-mcp/hooks/stop-check.sh'"
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
| `RELAY_HOOK_MAX_MESSAGES` | Max messages considered per peek | `20` |
| `RELAY_STOP_WAKE_DAMPER_SECS` | Minimum seconds between blocks per agent (0 disables) | `120` |

Typical setup via shell alias (matches the `SessionStart` + `PostToolUse` pattern):

```bash
alias ai-agent='RELAY_AGENT_NAME=my-agent RELAY_AGENT_TOKEN=<your-token> claude'
```

## What the hook does

1. Reads the hook payload from stdin; if `stop_hook_active` is true (this stop is already a hook-forced continuation), exits silently — one wake per natural stop.
2. Validates all env-var inputs against an allowlist (no surprises in URLs or SQL).
3. If `RELAY_AGENT_TOKEN` is set AND the HTTP daemon responds on `/health` within 1 second, calls `get_messages` with **`peek: true`** via `/mcp` — the v2.2.2 non-mutating read. This path goes through the full auth / rate-limit / audit pipeline and marks nothing.
4. Otherwise falls back to sqlite on `RELAY_DB_PATH`, opened **`-readonly`** with a bare `SELECT`.
5. If mail is pending and the damper window has elapsed, emits a single-line Claude Code hook JSON to stdout:
   ```json
   {"decision": "block", "reason": "[RELAY] 2 pending messages for builder (high priority), latest from planner. Before stopping, call get_messages(agent_name=\"builder\", status=\"pending\"), act on every message, then continue. The mail is still unread in the relay; this wake did not consume it."}
   ```
   The reason deliberately carries a compact summary, not the message bodies — the agent fetches content through its own authenticated `get_messages` call, which is where mark-as-read lives.
6. If there is no mail, a guard suppresses, or any error happens, the hook exits silently with empty stdout — never pollutes the conversation, never consumes anything.

## What the hook does NOT do

- **It does NOT mark mail read — ever.** There is no write path in the script (no `UPDATE` statement exists; `tests/hooks-stop.test.ts` enforces this structurally and behaviorally). A hook cannot prove from the inside that its output reached the model, so it must not consume what it cannot prove it delivered.
- **It does NOT wake truly idle terminals.** If no turn is in progress, the hook does not fire. Mail that arrives while the agent is sitting idle will not be delivered until either a user types something, the agent's next turn ends, or a `SessionStart` fires on terminal open. Idle wake is Tether's job; parked agents are Sentinel's.
- **It does NOT re-register the agent.** `SessionStart` handles registration. If the agent is not registered when the hook fires, the hook silently exits.
- **It does NOT check tasks.** Task surfacing stays in `SessionStart` for now (simpler, less context-pressure). `Stop` is dedicated to the wake only.
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

**Mail appears once in the wake summary and again when the agent fetches it.** Expected: the Stop wake carries a summary, and the agent's own `get_messages` call in the forced continuation carries the bodies (and marks them read). The `PostToolUse` hook may also render the same batch onto that tool result — a harmless double-render inside one continuation, not a duplicate delivery.

**The agent keeps getting woken for the same mail.** That means the agent is not draining its inbox in the granted continuation (most often a broken or stale token making `get_messages` fail). The hook deliberately re-wakes rather than consuming: the mail stays pending so Sentinel still sees it. Fix the token; do not "fix" the hook by making it mark mail read.

**Hook output looks like stray JSON in my conversation.** That would mean the hook JSON is not being parsed as a Claude Code hook response. Check that the `type: "command"` and `command: "/path/..."` config in settings.json are correct and the script has `+x` permission.

## Related

- [`docs/hooks.md`](./hooks.md) — SessionStart hook (terminal-open mail check)
- [`docs/post-tool-use-hook.md`](./post-tool-use-hook.md) — intra-turn mail delivery
- [`hooks/stop-check.sh`](../hooks/stop-check.sh) — script source
- [`tests/hooks-stop.test.ts`](../tests/hooks-stop.test.ts) — integration tests
