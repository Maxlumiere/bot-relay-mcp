# Agent Role: Auto-Poll Loop (v2.9.0 ambient-wake path β)

Drop-in `/loop` recipe for an agent running in iTerm2 / Terminal.app / tmux / SSH — anywhere outside VS Code (Tether handles VS Code via path α; see `docs/ambient-wake.md`). The agent self-paces a cheap inbox check via `peek_inbox_version` + `ScheduleWakeup`, only doing real work when there's actually new mail.

This template assumes the agent is already registered. If you're spawning fresh, run `register_agent` first (or use `spawn-agent.sh` which does it via the SessionStart hook).

## Prerequisites

- Claude Code v2.1.71+ (`/loop` + `ScheduleWakeup` required). Verify with `claude --version`.
- bot-relay-mcp v2.3.0+ daemon (peek_inbox_version shipped in v2.3.0; current main is v2.9.0+).
- The agent's `agent_token` is loaded (the SessionStart hook does this automatically).

## How to invoke

In the agent's first turn after spawn, paste:

```text
/loop Call peek_inbox_version({agent_name: "<MY_AGENT_NAME>"}) once. Compare the returned total_unread_count and epoch against the previous tick's values (if this is the first tick, treat previous as null and proceed as if mail is present). If total_unread_count > 0 OR the epoch differs from the previous tick: call get_messages and process any new mail (ack via send_message to the dispatcher as appropriate per your role's contract). If total_unread_count === 0 AND the epoch matches: do nothing this tick. Then ALWAYS call ScheduleWakeup with delaySeconds=270 (under the 5-minute Anthropic prompt-cache TTL — cache stays warm and per-tick cost stays minimal) and a one-sentence reason ("ambient-wake idle tick"). End the turn. The /loop harness will re-invoke this prompt on the next ScheduleWakeup fire.
```

Replace `<MY_AGENT_NAME>` with the agent's actual name (matches what `register_agent` was called with, also matches `$RELAY_AGENT_NAME` in the environment).

## Cadence tuning

`ScheduleWakeup` clamps to `[60, 3600]`. Pick based on operator phase:

| Cadence | When to use | Idle cost (per-hr) |
|---|---|---|
| `60` | Hot iteration, real-time chain | ~60-90k tokens/hr (cache warm) |
| `270` | Default — active work day | ~13-20k tokens/hr (cache warm) |
| `1800` | Idle / overnight / background | ~2-3k tokens/hr (1 cache miss per tick) |

Numbers above are from a real `peek_inbox_version` call against the live daemon (`docs/ambient-wake.md` § "Measured token costs" is authoritative — check there if the table here drifts). 60s row updated to match the measured doc per codex audit `d5f45679-A`.

**Don't pick 300s.** The 5-minute Anthropic prompt-cache TTL boundary is the worst-of-both: you pay the cache miss without amortizing it. Either stay under 270s (warm cache) or jump to 1200s+. See the ScheduleWakeup tool description for full guidance.

## Drift detection (epoch handling)

`peek_inbox_version` returns an `epoch` field. If it differs from your previously-cached epoch, the daemon's mailbox state was rotated (backup/restore happened). Reset your local cursor logic — drain via `get_messages` from scratch and update the cached epoch. False positives are harmless (you re-read messages you've already seen); false negatives would cause permanent mail loss.

In practice for a `/loop` agent: when you detect an epoch change, treat it as a `total_unread_count > 0` signal and drain.

## What this loop is NOT

- **Not Auto-mode.** Claude Code v2.1.89 added Auto-mode which triggers per-tool-call token burn. That is explicitly OFF the table for ambient-wake — it defeats the cheap-polling premise. Use ScheduleWakeup self-paced, as this template does.
- **Not a worker loop.** `roles/worker-loop.md` is for agents that grab tasks from a queue and execute them autonomously. This template is for agents that *receive dispatches* (relay messages) from an orchestrator and act on them. The two compose: a worker can run this template to wake on dispatches AND poll `get_tasks` from inside the wake-cycle.
- **Not a substitute for path α.** If the agent runs in VS Code with Tether installed + `autoInjectInbox: true`, Tether's push-based wake is strictly better (zero idle cost, sub-second latency). Use this template when Tether is not available (iTerm2, SSH, tmux, etc.).

## Failure modes

| Mode | What happens | What to do |
|---|---|---|
| Daemon down at tick time | `peek_inbox_version` fails with a transport error. The /loop turn ends in error; the next ScheduleWakeup still fires. | Restart the daemon; the next tick picks up where you left off. |
| `agent_token` rotated mid-loop | `peek_inbox_version` returns `AUTH_FAILED`. | Re-run `register_agent` or re-spawn via spawn-agent.sh. |
| LLM session crash | The /loop state is lost. On respawn (new Claude Code session), the SessionStart hook re-runs `register_agent` and re-delivers any pending mail. Restart the loop with this template. | Just re-paste the /loop prompt after respawn. |
| Mail arrives between ticks | Wake latency is at most one cadence interval. Drain happens on the next tick. | Tune cadence down if latency matters. |
| Inbox has 100+ unread messages | `get_messages` returns a large payload; the LLM turn may burn 5-20k tokens just to read. | Process in batches; send fast acks to clear pressure. |

## Integration with the broader ambient-wake spec

See `docs/ambient-wake.md` for:
- Path α (Tether — VS Code IDE)
- Path β (this template — standalone Claude Code)
- The binding Auto-mode prohibition
- Decision-gating discipline (what surfaces to the human operator)
- Stretch paths (B fs.watch sidecar; D TeammateIdle hook + Monitor)

See `docs/ambient-wake.md` for the design this template implements.

## Quick start (copy-paste)

```text
/loop Call peek_inbox_version({agent_name: "your-agent"}) once. If total_unread_count > 0 OR epoch differs from the previous tick: call get_messages and process. Otherwise do nothing. Then ScheduleWakeup at 270 seconds, reason "ambient-wake idle tick". End turn.
```

Replace `your-agent` with your agent name and adjust the cadence (60/270/1800) to your phase.
