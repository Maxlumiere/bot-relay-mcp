# Profiles — choose your bot-relay surface

bot-relay-mcp v2.3.0 introduces **profiles**: one-shot setup choices that shape which MCP tools are visible, what the defaults look like, and how chatty the logs are. Profiles are selected at `relay init` time and persisted to `~/.bot-relay/config.json`.

Profiles shape the **surface**, not just the defaults:

- MCP `tools/list` responses exclude tools outside the active profile's feature bundles.
- Calls to a hidden tool return `error_code: TOOL_NOT_AVAILABLE` with a hint pointing at the profile that would expose it.
- Dashboard / logging / retention thresholds follow the profile defaults unless the operator overrides them in the config file.

## The three shipped profiles

### `solo` (default)

Minimal single-machine dev. The profile most operators will pick on their laptop.

| Field | Value |
| --- | --- |
| `transport` | `stdio` |
| `feature_bundles` | `["core"]` |
| `logging_level` | `info` |
| `agent_abandon_days` | `30` |
| `dashboard_enabled` | `true` |

**Visible tools:** identity (register/unregister/discover), messaging (send/get/broadcast), tasks (post/update/get), status, health_check. All webhook/channel/admin tools hidden.

### `team`

Multi-agent, multi-machine. HTTP transport with all feature bundles enabled.

| Field | Value |
| --- | --- |
| `transport` | `http` |
| `feature_bundles` | `["core", "channels", "webhooks", "admin", "managed-agents"]` |
| `logging_level` | `info` |
| `agent_abandon_days` | `7` |
| `dashboard_enabled` | `true` |

**Visible tools:** everything.

### `ci`

Ephemeral per-test runner. Quiet logs + short abandon threshold + no dashboard.

| Field | Value |
| --- | --- |
| `transport` | `stdio` |
| `feature_bundles` | `["core"]` |
| `logging_level` | `warn` |
| `agent_abandon_days` | `1` |
| `dashboard_enabled` | `false` |

**Visible tools:** same as `solo`.

## Selecting a profile

One-shot, written into the config and then lived-with:

```bash
relay init --yes --profile=solo    # default
relay init --yes --profile=team
relay init --yes --profile=ci
```

You can combine `--profile` with explicit overrides:

```bash
relay init --yes --profile=solo --transport=http  # solo defaults + HTTP transport
```

Explicit flags always win over profile defaults.

## Changing profiles after initial setup

Either re-run `relay init --force --profile=<name>` (overwrites `config.json`) or edit `~/.bot-relay/config.json` directly. The fields that matter for surface shaping are:

```jsonc
{
  "profile": "solo",
  "feature_bundles": ["core"],
  "tool_visibility": { "hidden": [] }
}
```

Add bundle names to `feature_bundles` to expose more tools; add individual tool names to `tool_visibility.hidden` to hide one without dropping the whole bundle.

## Feature bundles

| Bundle | Tools |
| --- | --- |
| `core` | `register_agent`, `unregister_agent`, `discover_agents`, `send_message`, `get_messages`, `get_messages_summary`, `broadcast`, `post_task`, `post_task_auto`, `update_task`, `get_tasks`, `get_task`, `set_status`, `health_check` |
| `webhooks` | `register_webhook`, `list_webhooks`, `delete_webhook` |
| `channels` | `create_channel`, `join_channel`, `leave_channel`, `post_to_channel`, `get_channel_messages` |
| `admin` | `rotate_token`, `rotate_token_admin`, `revoke_token`, `expand_capabilities`, `set_dashboard_theme`, `spawn_agent` |
| `managed-agents` | `get_standup` |
| `federation` | (reserved for v2.3.x hub/edge) |

`health_check` and `discover_agents` are diagnostic/routing primitives and are always visible regardless of profile.

## Behavior when a tool is hidden

A client that calls `tools/list` sees the filtered list — the hidden tools simply aren't there. A client that calls `tools/call` for a hidden tool gets:

```json
{
  "success": false,
  "error_code": "TOOL_NOT_AVAILABLE",
  "error": "Tool \"register_webhook\" is not available under the active profile.",
  "hint": "Tool requires feature bundle \"webhooks\". Re-run `relay init --profile=team --force` or edit ~/.bot-relay/config.json to add \"webhooks\" to feature_bundles.",
  "tool": "register_webhook",
  "required_bundle": "webhooks"
}
```

This is a stable, machine-readable shape — clients can branch on `error_code` and present profile-aware UX.

## Upgrade path from v2.2.x

Pre-v2.3.0 installs have no `profile` / `feature_bundles` / `tool_visibility` fields in their config. The surface-shape resolver treats this as "everything visible" — you get the full pre-v2.3.0 surface until you explicitly opt in via `relay init --force --profile=<name>`. No forced migration.
