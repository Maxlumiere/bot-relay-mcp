# PostToolUse Hook — Mid-Task Mail Notice (v1.8; peek-only since ADR-0037)

The `SessionStart` hook (`docs/hooks.md`) gives you a one-shot mail check at terminal open. That is great for resuming a session, but it does nothing if messages arrive WHILE the agent is working — you have to wait for the next terminal open (or a human paste) before the agent sees them.

The `PostToolUse` hook closes that gap. It fires after every tool call, **peeks** at the mailbox, and injects a short notice as `additionalContext`: how many messages are unread, the highest priority, who sent them, and how long ago the newest arrived. It never quotes any message content: `additionalContext` is trusted more than a tool result, so sender-chosen words do not belong in it. The agent then calls `get_messages` itself, and that call is what delivers the mail and marks it read.

> **Why a notice and not the messages (ADR-0037).** Before this change the hook drained the mailbox and injected the bodies. A hook cannot prove delivery: `additionalContext` has no acknowledgement, it can be truncated or dropped, and `PostToolUse` also fires for a **subagent's** tool calls. Mail was marked read while the model never saw it, and the recipient's own drain came back empty. Only the model moves mail to read now; the hook, like the `Stop` hook, is read-only.

## When to install

Install `PostToolUse` in **every project you run a relay-registered agent from**. Recommended with the `SessionStart` hook, not instead of it:

| Hook | When it fires | What it delivers |
|---|---|---|
| `SessionStart` | Terminal open / resume | Mail + active tasks (snapshot) |
| `PostToolUse` | After every tool call | A notice that mail is waiting (never consumes it) |

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

Claude Code invokes the `command` string via the shell. The shell splits on whitespace, so a path like `/path/to/My Projects/bot-relay-mcp/hooks/post-tool-use-check.sh` gets interpreted as `/path/to/My` + the arguments `Projects/bot-relay-mcp/hooks/post-tool-use-check.sh`. The first piece is a directory, not an executable, so the shell errors out with `/bin/sh: ... is a directory` — and because the hook's stderr is not surfaced to the user by default, the hook **silently fails**.

**Fix:** wrap the path in single quotes inside the JSON string:

```json
"command": "'/path/to/My Projects/bot-relay-mcp/hooks/post-tool-use-check.sh'"
```

The outer double-quotes are JSON syntax. The inner single-quotes survive into the shell invocation and preserve the whole path as one argument. Paths without spaces do not need this, but the single-quote-always pattern is harmless and is the safer default.

**Quick diagnostic:** on a suspect install, manually run `sh -c "$COMMAND"` where `$COMMAND` is the exact string from your settings.json — if the shell splits it, you will see the split immediately.

## Environment variables

The hook reads these:

| Var | Purpose | Default |
|---|---|---|
| `RELAY_AGENT_NAME` | Which agent mailbox to check | (unset → hook silently exits) |
| `RELAY_AGENT_TOKEN` | Auth token for the remote read and the liveness self-heal (the local read needs none) | (unset → vault token) |
| `RELAY_DB_PATH` / `RELAY_INSTANCE_ID` | An explicit local relay DB: forces local mode | per-instance DB, else `~/.bot-relay/relay.db` |
| `RELAY_HTTP_HOST` | A remote relay: selects remote mode when no local instance is configured explicitly | `127.0.0.1` (used only by the self-heal when unset) |
| `RELAY_HTTP_PORT` | Relay HTTP port | `3777` |
| `RELAY_HOOK_MAX_MESSAGES` | Page size of the remote read | `20` |
| `RELAY_HOOK_NOTICE_REMIND_SECS` | How long an unchanged notice stays quiet (see "Damper") | `600` |
| `RELAY_HOME` | Where the damper keeps its state (`$RELAY_HOME/hook-state/`) | `~/.bot-relay` |

Typical setup via shell alias (the SessionStart hook already uses this pattern):

```bash
alias ai-agent='RELAY_AGENT_NAME=my-agent RELAY_AGENT_TOKEN=<your-token> claude'
```

## What the hook does

1. Validates all env-var inputs against an allowlist (no surprises in URLs or SQL).
2. Reads its stdin payload. If the payload carries `agent_id` or `agent_type`, the tool call belongs to a **subagent** and the hook stops there: no mail check, no output. A non-empty payload that is not valid JSON is treated the same way.
3. Reads the mailbox. **The path is chosen by configuration, never by failure.** `relay pending AGENT --json` decides, using the MCP server's instance layout and marker reader, on positive evidence only (a place it cannot read is an error, never an absence). Explicit local configuration (`RELAY_DB_PATH`, `RELAY_INSTANCE_ID`) comes first, then an explicit remote (`RELAY_HTTP_HOST`), then what is on disk (the active-instance marker, the legacy `~/.bot-relay/relay.db`):
   - **Local** (the usual case): the answer is `relay pending`'s own. That is the canonical pending set, exactly what `get_messages(status="pending")` would return, as metadata only, read from the DB read-only. It works with the daemon down, and it stamps nothing (not even the `seq` observation cursor).
   - **Local, but unreadable** (a missing, corrupt or too-old DB, or the wrong instance): the notice says `relay unreadable: …`, and the verdict line gives the reason. The hook **never** falls back to HTTP: a failed local read is a problem to see, not a reason to ask a different relay.
   - **Remote** (no local instance, `RELAY_HTTP_HOST` set): `get_messages` with `peek: true` over HTTP, and the notice starts `relay (via remote relay):`. **Known limit:** this peek stamps the message's `seq` observation cursor, although the notice observes no message. No decision keys on `seq`. A remote equivalent of `relay pending` is planned.
   - **Neither:** nothing is read, and the verdict says so.
4. Emits a single-line Claude Code hook JSON (`{"continue": true, "hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "..."}}`) to stdout. The notice looks like:
   ```
   relay: 2 unread for builder (highest priority: high), from planner (1 high), ops. newest arrived 3m ago. Unread until get_messages is called.
   ```
5. If there is no mail, or nothing to read, the hook exits with empty stdout. An unreadable local relay is the one error it announces (step 3).

## Damper

A read-only notice would otherwise repeat after every tool call until the agent reads its mail. So the hook stays quiet while nothing has changed:

- A notice is emitted when the set of unread messages **changes** (new mail arrives, or some is read), or when the **remind interval** has passed since the last notice.
- The remind interval is `RELAY_HOOK_NOTICE_REMIND_SECS` (default `600`, maximum `3600`). While any unread message is **high priority** it is at most `120` seconds.
- `0` disables damping: every tool call re-notifies. A non-numeric, negative or larger-than-3600 value falls back to the default; it never disables damping, and damping is never unbounded.
- State is kept per **agent and Claude session** (`session_id` from the hook payload) in `$RELAY_HOME/hook-state/`. Two windows running as the same agent do not silence each other, and `/clear` (which starts a new session id) notifies again. A payload without `session_id` falls back to one key per agent.
- Suppression never touches the mail. It stays pending, `SessionStart` and `Stop` still surface it, and the worst case is a late notice. If the state cannot be read or written, the hook notifies rather than staying silent.

## What the hook does NOT do

- **It does NOT mark mail read, resolve it, or change it in any way.** Only the agent's own `get_messages` call does that.
- **It does NOT inject any message content**, not even a first line. Count, highest priority, sender names (anything outside `[a-z0-9-]` shows as `unknown`) and the newest message's age only.
- **It does NOT run for subagent tool calls.**
- **It does NOT re-register the agent.** The `SessionStart` hook handles registration. If the agent is not registered in the local relay (often the wrong instance), `relay pending` refuses to answer and the notice says `relay unreadable`.
- **It does NOT check tasks.** Task surfacing stays in `SessionStart` for now (simpler, less context-pressure).
- **It does NOT retry.** One read per firing; the next tool call reads again.
- **It does NOT work for idle terminals.** If no tool is running, the hook will not fire — honest limitation. Use the SessionStart and Stop hooks for idle windows.

## Timing budget

Local mode costs one `relay pending` run, a Node process start: about 280ms at p95 on the machine we measured, against about 220ms for the HTTP peek it replaces. Remote mode self-imposes a ~3 second budget (1s health probe + 2s `get_messages` call). Reading the stdin payload is instant when Claude Code closes the pipe, and bounded to one idle second when a caller does not. Claude Code's `timeout` field is the hard ceiling; set it to 5 or higher in settings.json to leave headroom.

## Troubleshooting

**Hook silently fails on paths with spaces.** This is the most common install bug. Claude Code passes the `command` string to `/bin/sh`, which splits on whitespace. A path like `/path/to/My Projects/bot-relay-mcp/...` gets split at the space and the shell errors with `is a directory` — which you never see because hook stderr is not surfaced by default. **Fix:** single-quote the path inside the JSON string — see "Paths containing spaces" above. Verify with `sh -c "$COMMAND"` where `$COMMAND` is the exact string from your settings.json.

**Hook fires but no notice appears.** Check that:
- `RELAY_AGENT_NAME` matches the name the SessionStart hook registered under.
- `relay pending <agent>` answers in the same environment. It names the DB it read, or says why it could not.
- If remote, `RELAY_AGENT_TOKEN` is set and matches the agent, and the relay answers `/health`.
- The notice is not simply damped: the same unread set was already announced in this session less than `RELAY_HOOK_NOTICE_REMIND_SECS` ago. Set it to `0` to see every notice while debugging.

**The same notice keeps coming back.** The mail is still unread. Call `get_messages` for the agent; the notice stops once the unread set is empty.

**Hook output looks like stray JSON in my conversation.** That would mean the hook JSON is not being parsed as a Claude Code hook response. Check that the `type: "command"` and `command: "/path/..."` config in settings.json are correct and the script has `+x` permission.

**The notice says `relay unreadable`.** Run `relay pending <agent>` yourself; its error names the DB and the reason. A DB from before v2.12 is refused with a one-line remedy: start the current relay once against it, which migrates the schema in place.

**Hook feels slow.** Locally, each firing starts one Node process. Remotely, the `/health` probe is capped at 1s; if it times out often, the relay is overloaded or bound to a different interface.

**Hook triggered a rate limit.** The remote path counts against the relay's rate-limit buckets. `get_messages` is not in the rate-limited set (`messages`, `tasks`, `spawns`) by default, so this should not happen — file a bug if it does.

## Related

- [`docs/hooks.md`](./hooks.md) — SessionStart hook (terminal-open mail check)
- [`hooks/post-tool-use-check.sh`](../hooks/post-tool-use-check.sh) — script source
- [`tests/hooks-post-tool-use.test.ts`](../tests/hooks-post-tool-use.test.ts) — integration tests
- [`tests/adr-0037-post-tool-use-peek-only.test.ts`](../tests/adr-0037-post-tool-use-peek-only.test.ts) — the ADR-0037 contract (never consumes, subagent skip, damper)
