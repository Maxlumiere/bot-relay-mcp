# Coordinating through tasks (and the live board it feeds)

bot-relay-mcp's task tools (`post_task`, `update_task`, `post_task_auto`) are not just a work queue — used as the **coordination primitive**, they make a live per-agent board possible with **no extra bookkeeping**. The board is a *projection* of task + agent state, so it stays current as a **byproduct of coordinating**, never as a chore you have to remember.

## The rule: every coordination act is already a task operation

No new step is added. The acts you already perform become tool calls instead of prose:

| When you… | Call | Board effect |
|---|---|---|
| hand a piece of work to an agent | `post_task(to=<agent>, title=<one short line>, priority)` | a card appears under that agent |
| pick up work assigned to you | `update_task(task_id, action:"accept")` — your first act | card moves to that agent's **doing** column |
| **finish** the work | `update_task(task_id, action:"complete", result:<evidence/link>)` | card leaves **doing** |
| get blocked on a **human** (an operator, a reviewer) | `send_message(to="<human>", disposition:"obligation", content:<the ask>)` | card appears in that human's **pending** lane; clears on `resolve_messages` |

Two consequences worth stating plainly:

- **"Done" is the `complete` call, not a message about it.** The completion — with its `result` (a commit SHA, a PR link, a one-line outcome) — *is* the report. There is no separate "mark the board done" step, which is exactly what would rot.
- **The human-blocked lane needs no task capability.** It is an ordinary `send_message` with `disposition:"obligation"` (and an optional `deadline`) addressed to the human — `send_message` requires no capability, so any agent can populate this lane today. It stays "pending on them" until someone calls `resolve_messages`, and `get_outstanding` queries it. (A task addressed to a human also works — the relay does not require `to` to be a registered agent — but `post_task` needs the `tasks` capability, so the message form is the one that works everywhere.)

## First, the `tasks` capability

`post_task`, `post_task_auto`, and `update_task` require the agent to hold the **`tasks`** capability. Capabilities are fixed at `register_agent` time and are **immutable on re-register** — but they are not immutable for life:

- **New agents:** include `"tasks"` in the `capabilities` array at `register_agent`.
- **Existing (live) agents:** an agent holding the `admin` capability calls `expand_capabilities(agent_name, [<existing caps>…, "tasks"])`. This is a union-only, in-place update — it adds the capability **without** re-registering, so the agent's session, mailbox, read cursor, and wake binding are untouched. (An agent cannot grant itself a capability it lacks — `expand_capabilities` is admin-gated on purpose — so an admin grants it to the fleet.)

If a `post_task` call returns `lacks required capability "tasks"`, that is the fix: be registered with it, or have an admin `expand_capabilities` you — not a re-registration.

## Why it can't go stale

You cannot do assigned work without being dispatched and accepting; you must report it done; you must escalate a blocker. Each of those is a task operation, so the board reflects reality for the same reason coordination works at all. If an agent stops updating tasks, it has stopped coordinating — the board surfaces *that* too (a card stuck in `accepted`, an agent gone `offline`).

## Keep it one card per unit of work

A task is a **unit of work**, not a progress log — it has a `title`, a `description`, and a final `result`, but no per-step comment trail. Post one task per thing-to-track and let `status` carry the progress (`posted → accepted → completed`). This keeps each agent's column short and readable, which is the whole point.

## What the board reads

Per agent (from the `agents` row, all automatic): name, terminal title, CLI, and live status. Under it: that agent's **accepted-but-not-completed** tasks (the short "doing" bullets, removed the moment they `complete`). A separate lane per human holds the tasks/obligations addressed to them and still unresolved. Nothing here is written *for* the board — it is all read *from* the coordination you were already doing.
