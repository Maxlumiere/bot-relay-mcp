# Claude Code hook payload format

**Scope:** reference for anyone writing a Claude Code hook that targets
`bot-relay-mcp`. Consolidates what Claude Code 2.1.x passes to hooks via
stdin (JSON payload) + env vars, so the next script author doesn't have to
re-discover the shape. Originally assembled during Phase F chat-extraction
build (2026-04-21) after the Stop-hook stdin-JSON format wasn't obvious
from the existing `hooks/check-relay.sh` SessionStart pattern.

Cross-reference: [`docs/hooks.md`](./hooks.md) covers WHY we use hooks + how
to install them in `~/.claude/settings.json`. This file covers WHAT Claude
Code passes to the hook command once it fires.

---

## Common payload shape

Every hook type receives a JSON object on stdin. Fields shared across
every event:

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | UUID of the Claude Code session that triggered the hook. |
| `transcript_path` | string | Absolute path to the session's JSONL transcript file. |
| `cwd` | string | The session's current working directory at the time of the event. |
| `hook_event_name` | string | The event that fired — e.g. `SessionStart`, `SessionEnd`, `Stop`, `PostToolUse`, `PreToolUse`, `UserPromptSubmit`. Treat this list as non-exhaustive: Claude Code adds event types, and a script that switches on an exhaustive set silently no-ops on a new one. |

Event-specific fields are documented per-event below.

**Always read stdin as JSON.** Claude Code 2.1.x does NOT pass event data
via env vars (`CLAUDE_SESSION_ID`, `CLAUDE_TRANSCRIPT_PATH`, etc. are not
defined). Scripts that assume env-var-only will silently no-op.

---

## SessionStart

Fires when a new Claude Code session starts. Use for: bootstrap registration
with external services, context injection, stale-state audits.

```json
{
  "session_id": "<session-id>",
  "transcript_path": "~/.claude/projects/<project>/<session-id>.jsonl",
  "cwd": "/path/to/workspace",
  "hook_event_name": "SessionStart",
  "source": "startup"
}
```

**The `source` field** says WHY the session started, and it is the field that
distinguishes a brand-new window from a continuation. Observed values (MEASURED
on Claude Code 2.1.272; treat as non-exhaustive):

| `source` | Meaning | `session_id` |
|----------|---------|--------------|
| `startup` | A new window. | new |
| `resume` | `--resume`, `-p --resume`, or in-session `/resume`. | unchanged (the resumed conversation) |
| `fork` | `--fork-session`. | **new** |
| `clear` | `/clear` — the window continues, the conversation does not. | **new** |
| `compact` | Context was compacted mid-session. | unchanged |

`clear` and `fork` are the ones that surprise: the terminal is the same but the
conversation id changes, so anything keyed to the conversation must decide
whether to carry across or start fresh. They differ in intent — `clear`
continues the same window's work under a new id, while `fork` deliberately
branches — so code that treats them identically will mis-attribute one of them.
`compact` keeps the same id, so it is a refresh, not a new conversation.

A SessionStart matcher of `startup|resume|clear|compact|fork` fires on all five;
a `startup`-only matcher fires solely on startup, so the matcher itself is how
you filter by source.

**Stdout convention:** anything the SessionStart hook writes to stdout is
injected into the session's context before the first user message. Keep it
short + relevant — the existing `hooks/check-relay.sh` reference pattern
writes a `[RELAY]` banner + pending-mail digest.

**Reference implementation:** `hooks/check-relay.sh` (in this repo). Reads
env vars AND falls back gracefully if the relay daemon isn't reachable.

## SessionEnd

Fires when a session ends. Use for: releasing a binding, flushing state,
recording WHY the session ended.

```json
{
  "session_id": "<session-id>",
  "transcript_path": "~/.claude/projects/<project>/<session-id>.jsonl",
  "cwd": "/path/to/workspace",
  "hook_event_name": "SessionEnd",
  "reason": "prompt_input_exit"
}
```

The `reason` field carries the cause of the end. Observed values (MEASURED on
Claude Code 2.1.272; treat as non-exhaustive):

| `reason` | Cause |
|----------|-------|
| `prompt_input_exit` | `/exit` — the user explicitly closed the session. |
| `clear` | `/clear`. Carries the **OLD** `session_id`, and fires immediately before `SessionStart` with `source: "clear"` and the NEW id. |
| `other` | SIGTERM **and** terminal close (SIGHUP) — these are not distinguishable here. |

Two consequences worth designing around:

- **`/compact` fires no SessionEnd at all.** A cleanup keyed to SessionEnd will
  simply not run across a compaction, so anything that must survive one cannot
  depend on this event.
- **"Explicitly closed" means `prompt_input_exit` only.** A machine rebooting
  sends SIGTERM, which arrives as `other` — identical to the user closing the
  window. Treating `other` as a deliberate exit will mistake a reboot for one.

Record `reason` verbatim rather than mapping it to a local vocabulary — a reason
you do not recognise today is still the truth about what happened, and rewriting
it loses the only evidence of an end you did not expect.

**Stdout convention:** treat SessionEnd's stdout as discarded, the same as
`Stop`. Write to disk or stderr.

> **Not the same as `Stop`.** `Stop` fires when the assistant finishes responding
> and can fire many times in one session; `SessionEnd` fires once, when the
> session itself is over. A script that wants "the session is finished" wants
> this event, not `Stop`.

## Stop

Fires when a Claude Code session ends (user closes the terminal OR the
stdio transport's stdin closes). Use for: post-session extraction,
cleanup, final audit.

```json
{
  "session_id": "<session-id>",
  "transcript_path": "~/.claude/projects/<project>/<session-id>.jsonl",
  "cwd": "/path/to/workspace",
  "hook_event_name": "Stop",
  "stop_hook_active": false
}
```

The `stop_hook_active` field is `false` on the first Stop invocation and
`true` on subsequent invocations during the same session (distinguishes
"first stop" from "re-triggered stop" after a hook chain runs). Most
scripts only care about the `false` case.

**Stdout convention:** the Stop hook's stdout is discarded by Claude Code
(session is already ending). Writes go to disk directly or to stderr for
operator logs. A typical session-extraction pattern appends extraction
candidates to a file on disk and logs a one-liner to stderr.

**Reference implementation:** a `--stdin-hook` extractor script reads
`transcript_path` from stdin JSON, streams the JSONL, and writes markdown
output.

## PostToolUse

Fires after each tool call completes. Use for: inline validation, audit
trails, side-effect triggers.

```json
{
  "session_id": "<session-id>",
  "transcript_path": "~/.claude/projects/<project>/<session-id>.jsonl",
  "cwd": "/path/to/workspace",
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "ls -la" },
  "tool_response": { "stdout": "total 42\n...", "stderr": "", "exitCode": 0 }
}
```

Tool-specific fields:
- `tool_name` — the tool that fired (`Bash`, `Read`, `Write`, `Edit`,
  `Grep`, `Glob`, `Task`, `WebFetch`, etc. — matches the tool's registered
  name).
- `tool_input` — the arguments the tool was called with.
- `tool_response` — the tool's return value (shape varies per tool).
- `agent_id`, `agent_type` — present **only** when the tool call was made by a
  **subagent** (for example `"agent_type": "general-purpose"`); `session_id` is
  then the parent's. A main-agent call has neither key. Measured on Claude Code
  2.1.272. `hooks/post-tool-use-check.sh` uses this to skip its mail notice for
  subagent calls (ADR-0037).

**Stdout convention:** stdout content is appended to the session context
as a tool-use continuation. Keep quiet unless you want the content visible
to the agent.

## PreToolUse

Fires before each tool call executes. Can VETO the tool by returning a
non-zero exit code. Use for: permission checks, argument rewriting (via
stdout JSON), dangerous-op gates.

```json
{
  "session_id": "<session-id>",
  "transcript_path": "...",
  "cwd": "...",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "rm -rf /" }
}
```

Same tool-identification fields as PostToolUse, minus `tool_response`
(tool hasn't run yet).

**Veto mechanism:** exit non-zero. Claude Code aborts the tool call and
surfaces the hook's stderr as the reason.

## UserPromptSubmit

Fires when the user submits a prompt (before it reaches the model). Use
for: prompt rewriting, policy checks.

```json
{
  "session_id": "<session-id>",
  "transcript_path": "...",
  "cwd": "...",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "Fix the bug in src/webhooks.ts"
}
```

**Mutation:** if the hook writes valid JSON matching a specific contract
to stdout, Claude Code can rewrite the prompt before sending to the model.
Consult the latest Claude Code docs (links below) for the exact contract;
it's evolved across 2.1.x releases.

---

## Minimal Node script template (stdin-JSON reader)

Reusable shape for any hook:

```javascript
#!/usr/bin/env node
// Read stdin JSON payload (Claude Code 2.1.x hook contract).
async function readStdinJson() {
  let buf = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) buf += chunk;
  if (!buf.trim()) return null;
  try { return JSON.parse(buf); } catch { return null; }
}

const payload = await readStdinJson();
if (!payload) {
  process.stderr.write("hook: empty or malformed stdin payload\n");
  process.exit(1);
}

// payload.session_id, payload.transcript_path, payload.hook_event_name, ...
// ...do work...
```

## Minimal bash template

```bash
#!/usr/bin/env bash
set -euo pipefail
PAYLOAD=$(cat)
SESSION_ID=$(echo "$PAYLOAD" | jq -r '.session_id // empty')
TRANSCRIPT=$(echo "$PAYLOAD" | jq -r '.transcript_path // empty')
# ...do work...
```

---

## Authoritative sources

The above reflects Claude Code 2.1.116 as of 2026-04-21. For the most
current contract (fields may be added in minor releases), consult:

- <https://docs.claude.com/en/docs/claude-code/hooks>
- The Claude Code CLI's own `--help` output for the hooks subcommand.

If you observe a field or behavior that's not captured here, open an issue
against `bot-relay-mcp` and we'll refresh this doc.

---

## Why this doc exists

The `hooks/check-relay.sh` reference pattern in this repo used env vars +
direct sqlite3 access because the SessionStart hook's env-bootstrapping
predates the stdin-JSON contract. New scripts SHOULD read stdin JSON
instead — it's the canonical format and carries fields the env vars don't
(like `transcript_path` on Stop). Surfaced during a 2026-04-21 build when a
session-extraction script couldn't use env vars to find the transcript on
the Stop event.
