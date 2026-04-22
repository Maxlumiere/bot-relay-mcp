# Ambient wake (Phase 4s)

v2.3.0 adds Phase 4s: a universal idle-wake pattern that works with any MCP-speaking client, not just Claude Code. Every message/task delivered to an agent advances a per-recipient monotonic `seq`. Clients poll `peek_inbox_version` cheaply to detect "anything new", then drain via `get_messages` only when the seq has advanced.

## Why it matters

Pre-v2.3.0, clients had no cheap way to detect "is there new mail". Options were:

- Poll `get_messages(peek=false)` — consumes messages.
- Poll `get_messages(peek=true)` — returns full message bodies every time.

Neither scales. Ambient-wake splits the control plane from the data plane:

- **Control plane** (`peek_inbox_version`): returns a tiny integer + UUID epoch + count. Cheap; safe to poll on any tool-use hook.
- **Data plane** (`get_messages`): only called when peek says the seq has advanced.

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

1. Call `peek_inbox_version({agent_name})` → `{mailbox_id, epoch, last_seq, total_messages_count}`.
2. Compare `epoch` to cached epoch.
   - **Same epoch + `last_seq > cached_last_seen`** → there's new mail. Drain via `get_messages(peek=true)`.
   - **Different epoch** → DB was backed-up or restored. Reset `cached_last_seen` to 0 and drain from scratch. Update cached epoch.
3. If nothing changed, stay idle.

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
  "last_seq": 42,
  "total_messages_count": 137
}
```

Auth: same as `get_messages` (agent_token required). No mutation; safe to call from any client at any cadence. Part of the `core` feature bundle — visible in every profile.

## Dashboard "Wake agent" button

When `RELAY_FILESYSTEM_MARKERS=1` is set, the focused-agent panel in the dashboard gets a 🔔 Wake agent button. Click → POST `/api/wake-agent` → daemon touches the marker for that agent. Audit-logged as `dashboard.wake_agent`.

When markers are disabled, the button still renders but the endpoint returns `markers_enabled: false` + a hint.

## Integration sketches

### Claude Code (native MCP client)

Call `peek_inbox_version` on every `SessionStart` + optionally on `PostToolUse` hook when a local cursor file is stale.

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

Use `peek_inbox_version` on a 30-second interval. When the epoch changes, reset local cursor. When `last_seq > cursor`, call `get_messages` to drain.

## Backward compatibility

Pre-v2.3.0 clients that never call `peek_inbox_version` see identical behavior — `get_messages` still works exactly the same way (including the v2.2.2 `peek` parameter). The new seq/epoch columns are transparently populated on first read.

Pre-v2.3.0 messages (those written before the v11 migration) get `seq=NULL + epoch=NULL` at rest. The first time their recipient reads them, they're assigned a seq + epoch by the v2.3.0 delivery-time-assignment code path.
