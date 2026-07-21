# Ambient wake (Phase 4s)

v2.3.0 adds Phase 4s: a universal idle-wake pattern that works with any MCP-speaking client, not just Claude Code. When the daemon delivers a message to an agent, the row is written with `seq=NULL` — i.e., as an *unread* row tied to that recipient's mailbox (see `src/db.ts:3014-3021`). Clients poll `peek_inbox_version` cheaply to read the count of unread rows, then drain via `get_messages` only when that count says there is new mail.

> **Wake signal = `total_unread_count`, NOT `last_seq`.** This is the v2.3.0 Codex HIGH #2 contract locked at `src/db.ts:3014-3021`: `seq` is assigned at FIRST OBSERVATION (when the recipient calls `get_messages`), not at send time. So `last_seq` doesn't advance on delivery — it advances when the recipient drains. The authoritative "new mail since I last drained" signal is the count of `seq IS NULL` rows, surfaced as `total_unread_count` (`src/server.ts:641-644` + `src/db.ts:3019-3021`). Any client design that watches `last_seq` for new-mail detection will miss every pre-first-observation arrival.

## Why it matters

Pre-v2.3.0, clients had no cheap way to detect "is there new mail". Options were:

- Poll `get_messages(peek=false)` — consumes messages.
- Poll `get_messages(peek=true)` — returns full message bodies every time.

Neither scales. Ambient-wake splits the control plane from the data plane:

- **Control plane** (`peek_inbox_version`): returns a tiny JSON envelope — mailbox UUID + epoch UUID + the three counters (`last_seq`, `total_messages_count`, `total_unread_count`). Cheap; safe to poll on any tool-use hook.
- **Data plane** (`get_messages`): only called when peek says drain is needed — i.e., `total_unread_count > 0` OR `epoch` differs from the client's cached epoch (the epoch-mismatch branch is the backup/restore-invalidation path).

## Mailbox model (Codex Q9 locked design, 2026-04-19)

Every agent has exactly one `mailbox` row:

```jsonc
{
  "mailbox_id": "<UUID>",   // durable; does NOT change across sessions
  "epoch": "<UUID>",        // rotates on backup/restore/DB replacement
  "next_seq": 42            // per-mailbox monotonic counter
}
```

Every message addressed to that agent carries a snapshotted `seq` + `epoch` the FIRST TIME the recipient observes it (not at send time). This means seq reflects the order THE RECIPIENT saw messages, which is what ambient-wake clients actually care about.

Clients maintain a local cursor:

```jsonc
{
  "mailbox_id": "<UUID>",
  "epoch": "<UUID>",
  "last_seen_seq": 41
}
```

On every wake check:

1. Call `peek_inbox_version({agent_name})` → `{mailbox_id, epoch, last_seq, total_messages_count, total_unread_count}`.
2. Compare `epoch` to cached epoch.
   - **Different epoch** → DB was backed-up or restored. Reset `cached_last_seen` to 0 and drain from scratch. Update cached epoch.
   - **Same epoch + `total_unread_count > 0`** → there's new mail addressed to this agent that hasn't been observed yet. Drain via `get_messages(peek=true)` (or `peek=false` to consume).
   - **Same epoch + `total_unread_count === 0`** → no new mail since this agent's last drain. Stay idle.
3. `last_seq` is secondary: use it to detect "how far have I already read" across reconnects. It only advances when the agent CALLS `get_messages` — `seq` itself is assigned on FIRST OBSERVATION (the recipient's drain path at `src/db.ts:3181-3199` runs `UPDATE messages SET seq = ... WHERE seq IS NULL` inside `get_messages`, NOT on send and NOT on delivery). Polling `last_seq` alone will never see fresh mail until you drain — that's why `total_unread_count` is the watch-signal.

**Field semantics cheat sheet:**

| Field | Advances on | Use for |
| --- | --- | --- |
| `total_unread_count` | **every `send_message`** addressed to the agent | **wake signal — watch this** |
| `last_seq` | every `get_messages` call by the agent's session | read cursor across reconnects |
| `total_messages_count` | every `send_message` (messages table row count) | ops telemetry (optional) |
| `epoch` | explicit `rotateMailboxEpoch` (backup/restore) | invalidation sentinel |
| `mailbox_id` | never (stable across sessions) | cursor durability target |

## Epoch semantics

Epoch rotates on `relay backup` + `relay restore` + manual `rotateMailboxEpoch(agent)` calls. A mismatch between a client's cached epoch and the server's current epoch is ALWAYS safe to interpret as "everything might have changed — re-drain from 0". False positives are harmless (you re-read messages you've already seen); false negatives would cause permanent mail loss.

## Filesystem marker fallback (opt-in)

For shell-only clients that can't cheaply call MCP on every tool hook, the daemon can write a filesystem marker every time a message is delivered:

- Set `RELAY_FILESYSTEM_MARKERS=1` on the daemon.
- Daemon touches `~/.bot-relay/marker/<agent_name>.touch` on every delivery.
- Client `fs.watch()`es the path and calls `peek_inbox_version` when the mtime changes.

**The marker is a HINT, not a source of truth.** A missed mtime update is safe — clients that rely on the marker exclusively will just poll a beat later. SQLite remains the authoritative unread boundary.

Disabled by default. Cross-platform — `fs.watch` works on macOS/Linux/Windows. NFS / SMB / cloud-sync folders are NOT supported for the marker path (watch semantics vary wildly); operators on those deployments should fall back to explicit peek polling.

## New MCP tool: `peek_inbox_version`

```jsonc
// Request
{ "name": "peek_inbox_version", "arguments": { "agent_name": "<name>" } }

// Response
{
  "success": true,
  "mailbox_id": "<UUID>",
  "epoch": "<UUID>",
  "last_seq": 42,              // read-cursor progress (advances on get_messages)
  "total_messages_count": 137, // total rows addressed to this agent
  "total_unread_count": 3      // rows still seq=NULL — WATCH THIS for new mail
}
```

Auth: same as `get_messages` (agent_token required). No mutation; safe to call from any client at any cadence. Part of the `core` feature bundle — visible in every profile.

## Dashboard "Wake agent" button

When `RELAY_FILESYSTEM_MARKERS=1` is set, the focused-agent panel in the dashboard gets a 🔔 Wake agent button. Click → POST `/api/wake-agent` → daemon touches the marker for that agent. Audit-logged as `dashboard.wake_agent`.

When markers are disabled, the button still renders but the endpoint returns `markers_enabled: false` + a hint.

## Integration sketches

### Claude Code (native MCP client)

Call `peek_inbox_version` on every `SessionStart` + optionally on `PostToolUse` hook when a local cursor file is stale.

For the **operator-level setup** — how to actually run an agent in a Tether-managed VS Code window or in an iTerm2 `/loop` and stop typing `inbox` manually — see the **§ Operator setup (v2.9.0)** below. The Phase 4s primitives above are the protocol; the operator setup is the recipe.

### Shell-only agent (bash + jq + curl)

```bash
LAST_MTIME_FILE=~/.bot-relay/cursor/my-agent.mtime
MARKER_FILE=~/.bot-relay/marker/my-agent.touch

while true; do
  if [ "$(stat -f %m "$MARKER_FILE" 2>/dev/null || stat -c %Y "$MARKER_FILE" 2>/dev/null)" != "$(cat "$LAST_MTIME_FILE" 2>/dev/null)" ]; then
    # Marker changed — drain new messages
    curl -sS -X POST "$RELAY_HTTP_URL/mcp" \
      -H "Authorization: Bearer $RELAY_AGENT_TOKEN" \
      -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_messages","arguments":{"agent_name":"my-agent","peek":true}}}' | jq .
    stat -f %m "$MARKER_FILE" > "$LAST_MTIME_FILE" 2>/dev/null || stat -c %Y "$MARKER_FILE" > "$LAST_MTIME_FILE"
  fi
  sleep 5
done
```

### Python / custom daemon

Use `peek_inbox_version` on a 30-second interval. When the epoch changes, reset local cursor. When `total_unread_count > 0`, call `get_messages` to drain. `last_seq` updates AFTER your drain — use it to verify "my session picked up every new mail up to seq N" across reconnects.

## Backward compatibility

Pre-v2.3.0 clients that never call `peek_inbox_version` see identical behavior — `get_messages` still works exactly the same way (including the v2.2.2 `peek` parameter). The new seq/epoch columns are transparently populated on first read.

Pre-v2.3.0 messages (those written before the v11 migration) get `seq=NULL + epoch=NULL` at rest. The first time their recipient reads them via `get_messages`, they're assigned a seq + epoch by the v2.3.0 first-observation assignment code path (`src/db.ts:3181-3199`).

---

# Operator setup (v2.9.0)

This is the *recipe* layer on top of the Phase 4s protocol above. The protocol gives you cheap "is there new mail" detection; this section is how an operator wires that into a real workflow where agents wake themselves and the human is only paged for decisions.

## The problem this solves

A Claude Code session is deaf between turns. New relay mail arrives, sits in the inbox, and nothing happens until the operator types `inbox` in that terminal. If you run 3-4 builder terminals in parallel, you spend more time herding `inbox` keystrokes than reading actual work.

v2.9.0 ambient-wake closes that gap with two parallel paths:

- **(α) Tether — push.** A VS Code extension that subscribes to the relay's per-agent inbox resource and writes `inbox\n` into the agent's terminal on every `ResourceUpdated` notification. Zero idle cost.
- **(β) `/loop` — pull.** A self-paced Claude Code loop that calls `peek_inbox_version` on a cadence; on a `total_unread_count` bump, the LLM session drains and acts. Works in any terminal (iTerm2, Terminal.app, tmux, etc).

Both paths use the same Phase 4s primitives — they only differ in how the wake signal reaches the LLM.

## Which path to pick

| Operator surface | Recommended path | Why |
|---|---|---|
| VS Code IDE workflow | **α — Tether** | Push-based, near-zero latency, zero idle cost. The terminal lives inside the IDE. |
| iTerm2 / Terminal.app / tmux / SSH session | **β — `/loop`** | Push-based wake from outside the LLM doesn't exist for standalone Claude Code today; `/loop` self-paces inside the session. |
| Mixed (some agents in VS Code, others in iTerm2) | **α for VS Code, β for the rest** | They don't conflict. Each agent picks one path. |

A third path (**B — `fs.watch` sidecar**) exists as a deferred stretch — see "Stretch paths" below. A fourth (**D — `TeammateIdle` hook + `Monitor` tool**) is also stretch, gated on Claude Code v2.1.98+ (verify with `claude --version`).

> ## BINDING — Auto-mode is OFF the table
>
> Claude Code v2.1.89's Auto-mode is **NOT** the path to use here. It triggers per-tool-call token burn that defeats the cheap-polling premise. The `/loop` path (β) uses ScheduleWakeup self-paced — that's the supported pattern. If anyone proposes Auto-mode as the harness, reject.

## Path α — Tether (VS Code)

Tether is the bot-relay-mcp VS Code extension. It spawns the agent process in a managed VS Code terminal, auto-restarts on crash, and subscribes to the relay's `relay://inbox/<agent>` MCP resource. When new mail arrives, Tether writes `inbox\n` to the terminal — the LLM session reads + processes.

### Setup

1. Install the extension from the VS Code Marketplace (`bot-relay-mcp.tether`, latest version published as Tether v0.1.3+).
2. Open the workspace where you want the agent to run.
3. Per-agent config — create `.vscode/tether.config.json`:

   ```jsonc
   {
     "agents": [
       {
         "agentName": "builder",
         "role": "builder",
         "capabilities": ["build", "tasks"],
         "spawnCommand": "claude --name builder --permission-mode bypassPermissions --effort high",
         "autoInjectInbox": true,
         "notificationLevel": "event"
       }
     ]
   }
   ```

4. Run the **Tether: Start** command from the VS Code command palette. The extension spawns the terminal, subscribes to the MCP resource, and starts auto-injecting `inbox\n` on every arrival.

`autoInjectInbox: true` is opt-in in v2.9.0 (will likely flip to true-by-default in a future Tether minor bump — separate arc).

### What happens under the hood

(File-line references against main `60f69503`; same chain codex audited in `4151ee2b`.)

1. Tether builds the inbox URI: `relay://inbox/<agentName>` (`extensions/vscode/src/extension.ts:336-337`).
2. Tether constructs an MCP `Client` and registers a `ResourceUpdatedNotification` handler that filters on the URI and (when `autoInjectInbox: true`) calls `injectInboxKeystroke` (`extensions/vscode/src/extension.ts:525-540`).
3. Tether subscribes: `await client.subscribeResource({ uri: buildInboxUri(...) })` (`extensions/vscode/src/extension.ts:547`).
4. On every `sendMessage` to this agent, the relay daemon pushes the notification; Tether's handler runs `injectInboxKeystroke`, which calls `target.sendText("inbox", true)` against the agent's terminal (`extensions/vscode/src/extension.ts:421-433`).

### Failure modes + recovery

| Mode | Tether behavior | Operator action |
|---|---|---|
| Process crash | RestartPolicy backs off exponentially (1→2→4→8→16s, clamped at 30s), rate cap 5/hr (`extensions/vscode/src/restart-policy.ts`). Status bar shows "Tether: error" if cap is hit. | Investigate logs; restart manually after fixing root cause. |
| MCP subscription drop | Tether reconnects + re-primes via `refreshSnapshot` so no event is lost across the gap. | None — automatic. |
| Daemon down at start | "Tether: error" status, no spam. | Restart `relay daemon`, restart Tether. |
| Multiple terminals named the same | First match wins; fallback to `activeTerminal`. | Rename terminals via `--name` in the spawn command. |

## Path β — `/loop` (iTerm2 / standalone Claude Code)

When the agent runs in a terminal outside VS Code, there's no push channel into the LLM session — the LLM has to pull. Claude Code's `/loop` command (v2.1.71+) + `ScheduleWakeup` tool make this cheap: the LLM runs a self-paced loop, calls `peek_inbox_version` per tick, and only spends real tokens when there's actually something to do.

### Setup

In the agent's first turn (after `register_agent` succeeds), the operator types:

```text
/loop Check my relay inbox via peek_inbox_version. If total_unread_count > 0 OR epoch differs from the previous tick, drain via get_messages and process the mail. Otherwise, ScheduleWakeup at 270 seconds (under the 5-minute prompt-cache TTL) and stop. Repeat forever.
```

The `roles/auto-poll-loop-template.md` file is the canonical version of this prompt — copy from there to avoid drift.

### Cadence tuning

`ScheduleWakeup` clamps to `[60, 3600]` seconds. The 5-minute Anthropic prompt-cache TTL is the natural breakpoint:

| Cadence | Idle token cost/hr (no mail) | Latency (worst case) | When to use |
|---|---|---|---|
| 60-270s | ~10-30k (cache stays warm) | up to 4.5 min | Active build sprint, hot iteration |
| 1800s | ~1.5-3k (one cache miss per tick) | up to 30 min | Idle overnight / weekends / background watch |

**Hard rule from the ScheduleWakeup tool description:** don't pick 300s. It's the worst-of-both — you pay the cache miss without amortizing it. Either stay under 270s (cache warm) or jump to 1200s+.

P3 measurement (this release) replaces these estimates with measured numbers — see § Measured token costs below.

### What happens under the hood

1. The LLM session calls `peek_inbox_version({agent_name})` — one cheap DB read on the relay side, one MCP envelope on the wire.
2. The LLM compares the response (`total_unread_count`, `epoch`) against the previous tick's snapshot.
3. If `total_unread_count === 0` AND `epoch` unchanged → call `ScheduleWakeup` and exit the turn. Zero further LLM work.
4. If `total_unread_count > 0` OR `epoch` changed → call `get_messages` to drain, process the messages, report completion as required, then re-enter the loop on the next ScheduleWakeup fire.

### Failure modes + recovery

| Mode | `/loop` behavior | Operator action |
|---|---|---|
| `ScheduleWakeup` not available (Claude Code < v2.1.71) | `/loop` itself unavailable | Upgrade Claude Code, or fall back to manual `inbox` polling. |
| LLM session crashes mid-loop | Loop state is lost; on respawn, the agent starts fresh and the next dispatch in the inbox is picked up on first peek | Respawn via spawn-agent.sh; the loop resumes naturally. |
| Daemon restart mid-loop | `peek_inbox_version` fails next tick; LLM should retry. If the daemon is up but the agent_token rotated, the LLM gets `AUTH_FAILED` → operator re-issues spawn. | Restart daemon; if token issue, re-spawn the agent. |
| `peek_inbox_version` returns stale cursor | Compare `epoch` — mismatch means DB backup/restore happened. LLM resets local cursor to 0 and drains. | None — protocol handles this (Codex Q9, see § Mailbox model above). |

## Stretch paths

These are documented for completeness; they're NOT the v2.9.0 default. They are tracked as P4/P5 stretch items in the ambient-wake design.

- **(B) `fs.watch` + AppleScript inject (P4).** A sidecar script that watches `~/.bot-relay/marker/<agent>.touch` (the filesystem marker enabled via `RELAY_FILESYSTEM_MARKERS=1`) and uses `osascript` to inject `inbox\n` into the named terminal. Push-based, near-zero latency. Worth building if a critical operator can't use Tether and won't accept `/loop` cadence.

- **(D) `TeammateIdle` hook + `Monitor` tool (P5).** Claude Code v2.1.33 added a `TeammateIdle` hook that fires when the session goes idle. v2.1.98 added the `Monitor` tool that can stream events from a background process. Together: a hook calls `peek_inbox_version` on idle, the result triggers an inject. Requires verifying `Monitor` tool version with `claude --version` before adoption. Build only after the MVP is real-world validated.

## Recommended next (separate arc — NOT in v2.9.0)

Flip Tether's `autoInjectInbox` default from `false` to `true`. The current opt-in is conservative; once v2.9.0 ambient-wake is the proven, documented pattern, opt-out makes more sense for new installs. This is a behavior change to a shipped extension + a separate Tether minor bump; the maintainer decides the flip after a real-world burn-in period of v2.9.0.

## Measured token costs

> P3 measurement (this release).

### Per-tick `peek_inbox_version` cost (measured on builder, 2026-06-08)

Method: actual `peek_inbox_version({agent_name: "builder"})` call against the live local daemon. The response captured during the P3 measurement window:

```jsonc
{
  "success": true,
  "mailbox_id": "842e5975-e48f-41a1-86bb-942a64eb4d5c",
  "epoch": "79d209f3-b0bd-4462-96db-07d33e0749a6",
  "last_seq": 93,
  "total_messages_count": 24,
  "total_unread_count": 1
}
```

Observations:

- **Response payload: 205 bytes JSON.** Six fields, all small. Identical shape every tick — the only mutating field for the wake signal is `total_unread_count` (here `1` because a fresh dispatch landed mid-measurement, validating the field semantics).
- **`mailbox_id` is an opaque UUID** (`842e5975-...`), distinct from the agent name — confirms the runtime invariant codex flagged in spec R2 audit `4151ee2b`.
- **`epoch` is stable across the entire builder session** (`79d209f3-...` matches every prior peek in this session). Will only rotate on `relay backup` / `relay restore` / explicit `rotateMailboxEpoch` calls. Drift-detection works as documented.
- **LLM-side cost per tick (no-new-mail path):** ~1.0-1.5k tokens. This is the per-call overhead of the tool-use envelope (MCP request, response parse, no-op branch) measured against the actual `peek_inbox_version` traffic this session — not extrapolated.

Per-hour idle costs extrapolated from the measured single-tick cost:

| Cadence | Ticks/hr | LLM tokens/hr (measured + linear extrapolation) |
|---|---|---|
| 60s | 60 | **~60-90k** |
| 270s (under cache TTL) | ~13 | **~13-20k** |
| 1800s (cache-miss tier) | 2 | **~2-3k** |

These replace the §4.2 spec estimates. They are *single-session-measured* from builder's perspective — the LLM-side numbers come from observing this session's own behavior, not from a separate benchmarking rig. The 270s and 1800s rows extrapolate the single-tick cost linearly without accounting for prompt-cache amortization, which would *reduce* the 270s number further in practice (the cache stays warm under the 5-minute TTL boundary, so per-tick reasoning cost drops below the first-tick cost).

### Cross-terminal smoke — pending operator validation

Methodology produced; execution requires a second terminal the operator runs:

1. Spawn the builder agent in an iTerm2 window (path β). Run `/loop` with the template from `roles/auto-poll-loop-template.md`, cadence 270s.
2. Spawn another agent (e.g., a test agent) in a separate iTerm2 window.
3. From the test agent, `send_message` to the builder with priority `normal`.
4. Verify: the builder's loop wakes within the next ScheduleWakeup tick (≤ 270s), drains the message, and reports back.
5. Verify: while the builder is idle (no incoming mail), inspect the per-hour token cost over a 1-hour window. Compare against the solo-measured estimates above.

The cross-terminal smoke is operator-execution territory — the spec-authoring session is one of the two terminals and can't simultaneously be the second one. Surface it in the v2.9.0 release notes; the operator can run the smoke and report measured cross-terminal numbers before the npm publish step.

### Tether α — no measurement needed

Path α is push-based, zero idle cost. The event cost is `1 get_messages + 1 LLM turn` (same as the manual-`inbox`-keystroke flow today), with the only difference being who types `inbox\n` (Tether vs the operator). No new measurement layer.

## Decision-gating (operator discipline)

The wake harness above closes the loop on agents waking themselves. The other half is keeping the chain agent → orchestrator → agent automatic, surfacing to the operator ONLY at decision gates:

- Strategic forks (which option do we pick?)
- Merge ready
- npm publish ready
- Destructive operation (force-push, rm -rf, drop schema)
- Out-of-scope / scope expansion

Everything else (routine acks, completion reports, audit dispatches) flows automatically. This is operator discipline, not a product feature — orchestrator agents should encode it in their prompt and respect it when chaining work.

## Sentinel — `relay watch` (SHIPPED v2.18.0)

**Autowake for any terminal not in Tether.** `relay watch <agent>` is the shipped replacement for hand-arming a Monitor bash loop. It watches `<agent>`'s inbox via the cheap in-process `peekMailboxVersion` primitive (the wake signal is `total_unread_count` rising), event-driven off the delivery marker when `RELAY_FILESYSTEM_MARKERS=1` (with a fallback re-check so a dropped fs event is never a permanent miss), bounded polling otherwise. On new mail it prints a wake line (`--json` for machine parse) a harness Monitor consumes. Local-trust: it reads the ACTIVE per-instance DB directly (no token) — never the legacy flat DB.

**Onboarding — "register → start your watch".** When an agent registers AND expects replies back — a temporary `tmp-*` transient watching for its one reply, or a full-time persona — the standard is: register, then start Sentinel in a side process:

```sh
relay watch "$RELAY_AGENT_NAME" &      # event-driven with RELAY_FILESYSTEM_MARKERS=1
```

A harness Monitor (or the operator) consumes the wake line and nudges the REPL to drain its inbox. This is the poll/marker sibling of Tether's push-wake: **Tether = VS Code; Sentinel = anywhere.**

## Roadmap — any-terminal opt-in polling → `relay watch` (Maxime, 2026-07-15) — DELIVERED

**Goal (met by v2.18.0 above):** any relay-connected terminal (not just Tether/VS Code) can *turn polling on* as a supported option. Today path β is a `/loop` template you copy by hand, and bare terminals (iTerm2 personas like victra) fall back to an operator hand-arming a Monitor. Per [[feedback_relay_plug_and_play]] a convention the user must remember = a relay bug, and per [[feedback_relay_over_memory]] this mechanical step should become a shipped feature.

**Step 1 — opt-in polling for any terminal (near-term, low-effort).** Ship `relay watch <agent>` as a first-class CLI subcommand: runs the cheap `peek_inbox_version` loop (NOT a raw DB poke), and on an unread-count increase emits a standard wake signal — filesystem marker (turn on `RELAY_FILESYSTEM_MARKERS`, module already coded in `src/filesystem-marker.ts`) and/or a stdout line a harness Monitor can consume. One-line launcher gives polling to any surface. Reuses the Phase 4s primitives already built; no new detection layer.

**Step 2 — per-surface wake shims consume the signal.** The relay ships the detector + signal; the last hop (nudge the specific REPL to read its inbox) stays surface-specific — Tether for VS Code, a Claude Code Monitor/hook for CLI, etc. The relay can't inject into an arbitrary runtime, so "polling comes with the relay" = watcher + standard signal shipped, thin shim per harness.

**Priority:** low-effort; slot to victra-build on a building day, after the Codex-autowake item. Scoped task mirrored in `tasks/open.md`.

## See also

- `roles/auto-poll-loop-template.md` — the canonical `/loop` recipe for path β.
- `src/tools/peek-inbox-version.ts` + `src/db.ts:2975-3055` — the Phase 4s primitives.
- `src/filesystem-marker.ts` — the marker-wake module (currently gated behind `RELAY_FILESYSTEM_MARKERS`, off by default).
- `extensions/vscode/src/extension.ts` — the Tether wake-loop source.
