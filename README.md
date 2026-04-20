# bot-relay-mcp

[![CI](https://github.com/Maxlumiere/bot-relay-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Maxlumiere/bot-relay-mcp/actions/workflows/ci.yml)

A local-first message relay for AI coding agents. Two interfaces, one shared SQLite database, zero infrastructure.

**v2.1 — architecturally complete.** 25 tools. Everything v2.0 delivered (smart routing, task leases, session-aware reads, lazy health monitor, busy/DND status, webhook retries, channels) + the v2.1 sweep: explicit auth_state machine with revoke/recovery flow, managed-agent rotation grace, keyring-based encryption with online rotation, unified `relay` CLI with `recover` + `re-encrypt` + `doctor` + `init` + `test` + `generate-hooks` + `backup` + `restore`. 14 of 14 Codex architectural findings closed. See [CHANGELOG](./CHANGELOG.md) for the full arc.

## What is this?

bot-relay-mcp gives AI coding agents and external systems a way to coordinate.

**Two audiences, two transports:**
- **AI coding agents (Claude Code, Cursor, Cline, Zed)** connect via **stdio MCP**. Drop one entry into `~/.claude.json` and the relay's tools appear inside Claude. No daemon required.
- **External systems (n8n, Slack, Telegram, custom scripts)** connect via **HTTP+SSE** with optional Bearer auth. Trigger agent actions or receive webhook events.

Everything reads and writes the same SQLite file at `~/.bot-relay/relay.db`. There is no cloud, no daemon you have to install, no service mesh.

## Quick Start (30 seconds)

Once published to npm, setup is a single config entry — no cloning, no compiling, no absolute paths.

Add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "bot-relay": {
      "command": "npx",
      "args": ["-y", "bot-relay-mcp"],
      "type": "stdio"
    }
  }
}
```

The first invocation fetches the package and starts the server. Subsequent launches are instant.

### Quick Start (from source)

```bash
git clone https://github.com/Maxlumiere/bot-relay-mcp.git
cd bot-relay-mcp
npm install
npm run build
```

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "bot-relay": {
      "command": "node",
      "args": ["/absolute/path/to/bot-relay-mcp/dist/index.js"],
      "type": "stdio"
    }
  }
}
```

Open two Claude Code terminals and try it:

**Terminal A:**
```
> Register on the relay as "planner" with role "orchestrator"
> Discover other agents
> Send a message to "builder": "Can you handle the API layer?"
```

**Terminal B:**
```
> Register on the relay as "builder" with role "builder"
> Check my relay messages
> Reply to planner: "On it."
```

The database is created automatically at `~/.bot-relay/relay.db` on first use. That is the full setup.

**File permissions (v2.1).** The relay creates `~/.bot-relay/` at `0700` and `relay.db` + backup tarballs at `0600` — owner-only. `config.json` is operator-managed; the relay never chmods it but logs a warning at startup if it's more permissive than `0600`. POSIX only — native Windows NTFS uses ACLs, not POSIX modes, so the chmod calls are no-ops there (documented).

## Tools

### Identity

| Tool | Inputs | Description |
|------|--------|-------------|
| `register_agent` | `name`, `role`, `capabilities[]` | Register this terminal as a named agent. Uses upsert — safe to call multiple times. |
| `unregister_agent` | `name` | Remove an agent from the relay. Idempotent. Fires `agent.unregistered` webhook on success. |
| `discover_agents` | `role` (optional) | List all registered agents with status (online/stale/offline). |
| `spawn_agent` | `name`, `role`, `capabilities`, `cwd?`, `initial_message?` | Spawn a new Claude Code terminal pre-configured as a relay agent. Cross-platform (v1.9): macOS (iTerm2/Terminal.app), Linux (gnome-terminal/konsole/xterm/tmux fallback chain — tmux covers headless servers), Windows (wt.exe/powershell.exe/cmd.exe). See `docs/cross-platform-spawn.md`. |

### Messaging

| Tool | Inputs | Description |
|------|--------|-------------|
| `send_message` | `from`, `to`, `content`, `priority` | Send a direct message to another agent by name. |
| `get_messages` | `agent_name`, `status`, `limit` | Check your mailbox. Pending messages are auto-marked as read. |
| `broadcast` | `from`, `content`, `role` (optional) | Send a message to all registered agents (or filter by role). |

### Tasks

| Tool | Inputs | Description |
|------|--------|-------------|
| `post_task` | `from`, `to`, `title`, `description`, `priority` | Assign a task to another agent. |
| `post_task_auto` (v2.0) | `from`, `title`, `description`, `required_capabilities[]`, `priority` | Auto-route to the least-loaded agent whose capabilities match ALL required. Queues if no match; assigns on the next capable registration. |
| `update_task` | `task_id`, `agent_name`, `action`, `result?` | Actions: `accept` / `complete` / `reject` / **`cancel` (v2.0, requester-only)** / **`heartbeat` (v2.0, renews lease)**. State machine + CAS enforced. |
| `get_tasks` | `agent_name`, `role`, `status`, `limit` | Query your task queue (assigned to you or posted by you). |
| `get_task` | `task_id` | Get a single task by ID with full details. |

### Channels (v2.0)

| Tool | Inputs | Description |
|------|--------|-------------|
| `create_channel` | `name`, `description?`, `creator` | Create a named channel for multi-agent coordination. Requires `channels` capability. |
| `join_channel` | `channel_name`, `agent_name` | Join any public channel. |
| `leave_channel` | `channel_name`, `agent_name` | Leave a channel. |
| `post_to_channel` | `channel_name`, `from`, `content`, `priority` | Post to a channel you are a member of. |
| `get_channel_messages` | `channel_name`, `agent_name`, `limit`, `since?` | Read messages posted to a channel since your join time. |

### Status + Health (v2.0)

| Tool | Inputs | Description |
|------|--------|-------------|
| `set_status` | `agent_name`, `status` | Signal `online` / `busy` / `away` / `offline`. `busy`/`away` exempt you from health-monitor task reassignment. |
| `health_check` | _(none)_ | Report relay version, uptime, and live counts (agents, messages, tasks, channels). No auth required. |

### Webhooks (v1.2+)

| Tool | Inputs | Description |
|------|--------|-------------|
| `register_webhook` | `url`, `event`, `filter`, `secret` | Subscribe to relay events via HTTP POST. |
| `list_webhooks` | _(none)_ | List all registered webhook subscriptions. |
| `delete_webhook` | `webhook_id` | Remove a webhook subscription. |

Supported events: `message.sent`, `message.broadcast`, `task.posted`, `task.accepted`, `task.completed`, `task.rejected`, `task.cancelled` (v2.0), `task.auto_routed` (v2.0), `task.health_reassigned` (v2.0), `channel.message_posted` (v2.0), `agent.unregistered`, `agent.spawned`, `webhook.delivery_failed`, `*` (all).

**v2.0 — retry with backoff.** Failed webhook deliveries retry at 60s / 300s / 900s (3 attempts). CAS-claimed per row — no double delivery. Piggybacks on webhook-firing tool calls, no background thread.

When `secret` is provided, each delivery includes an `X-Relay-Signature: sha256=...` HMAC header. Filter optionally restricts firing to events where `from_agent` or `to_agent` matches.

## Example: Task Delegation

**Terminal A — Orchestrator:**
```
1. register_agent("orchestrator", "planner", ["delegation", "review"])
2. discover_agents() → sees "worker" is online
3. post_task(from: "orchestrator", to: "worker",
     title: "Write auth tests",
     description: "Cover login, logout, token refresh. Use vitest.",
     priority: "high")
4. send_message(from: "orchestrator", to: "worker",
     content: "Task posted — check your queue.")
```

**Terminal B — Worker:**
```
1. register_agent("worker", "builder", ["testing", "backend"])
2. get_messages("worker") → message from orchestrator
3. get_tasks("worker", role: "assigned", status: "posted") → auth test task
4. update_task(task_id, "worker", "accept")
5. ... does the work ...
6. update_task(task_id, "worker", "complete", result: "12 tests passing")
7. send_message(from: "worker", to: "orchestrator",
     content: "Auth tests done. All passing.")
```

**Terminal A checks results:**
```
1. get_messages("orchestrator") → "Auth tests done."
2. get_task(task_id) → status: completed, result: "12 tests passing"
```

## How It Works

Every Claude Code terminal spawns its own MCP server process via stdio. All processes read and write the same SQLite file at `~/.bot-relay/relay.db`. SQLite WAL mode handles concurrent access safely. Messages older than 7 days and completed tasks older than 30 days are purged automatically on startup.

### Unified `relay` CLI (v2.1)

One entry, six subcommands: `doctor` / `init` / `test` / `generate-hooks` / `backup` / `restore`. First-run setup:

```bash
relay init          # interactive
relay init --yes    # defaults + random HTTP secret
```

`relay doctor` runs a diagnostic sweep; `relay test` runs a minimal self-check against a throwaway relay; `relay generate-hooks` emits Claude Code hook JSON for `~/.claude/settings.json`. Full reference in [`docs/cli.md`](./docs/cli.md). The standalone `bin/relay-backup` + `bin/relay-restore` from Phase 2c have been absorbed into `relay backup` + `relay restore`.

### Token lifecycle (v2.1)

Two new tools for credential hygiene: `rotate_token` lets an agent swap its own token with history preserved; `revoke_token` lets an admin-capable agent nullify another agent's token_hash (target re-bootstraps via the Phase 2b migration path). New `admin` capability is never auto-granted — register admin agents explicitly. Full operator runbook in [`docs/token-lifecycle.md`](./docs/token-lifecycle.md).

### Error codes (v2.1)

Every tool error response carries a stable `error_code` token alongside the free-form `error` string. Branch on the code; never string-match the message. Full catalog + stability guarantee in [`docs/error-codes.md`](./docs/error-codes.md). Source of truth: [`src/error-codes.ts`](./src/error-codes.ts).

### Protocol version (v2.1)

Beyond the package `version` string, the relay surfaces a `protocol_version` via `register_agent` + `health_check` responses. Clients should key compatibility on **protocol_version** (bumps only on tool-surface changes) rather than the package version (bumps on every ship). See [`docs/protocol-version.md`](./docs/protocol-version.md) for SemVer rules + a client-side compatibility snippet.

### HTTP Mode — for n8n, Slack, Telegram, custom scripts

Run the relay as an HTTP daemon and any HTTP client can drive it:

```bash
RELAY_TRANSPORT=http RELAY_HTTP_SECRET=your-shared-secret node dist/index.js
# Listens on http://127.0.0.1:3777
```

> **Production deployment — set `RELAY_HTTP_SECRET`.** v2.1 refuses to start on a non-loopback host (`0.0.0.0`, a public IP, Docker `-p 3777:3777` without loopback pinning) unless `RELAY_HTTP_SECRET` is set. Loopback binds (`127.0.0.1`, `::1`, `localhost`) stay zero-config for local development.
>
> Dev-only escape hatch: `RELAY_ALLOW_OPEN_PUBLIC=1` lets the relay start anyway on a public host without a secret — useful for throwaway local Docker nets, but logs a loud warning every startup. Never use in production.

Endpoints:
- `POST /mcp` — JSON-RPC (the MCP protocol over HTTP+SSE). Requires `Authorization: Bearer <secret>` if `http_secret` is configured.
- `GET /health` — server status (always open, no auth)
- `GET /` — built-in dashboard (live view of agents, messages, tasks, webhooks). **v2.1 Phase 4d:** protected by Host-header allowlist (DNS-rebinding defense) + auth gate (`RELAY_DASHBOARD_SECRET` or `RELAY_HTTP_SECRET` fallback). Loopback binds allow no-secret access for dev; non-loopback binds require a secret. Full policy in [`docs/dashboard-security.md`](./docs/dashboard-security.md).
- `GET /api/snapshot` — JSON snapshot of relay state (same gates as `/`)

Three transport modes:
- `stdio` (default) — per-terminal, for AI coding agents
- `http` — daemon, for external systems
- `both` — HTTP daemon plus a stdio connection (useful for bridge scripts)

All transports share the same SQLite database. Stdio agents and HTTP clients see the same world.

### n8n integration example

Trigger a Claude Code agent from an n8n workflow:

```json
POST http://127.0.0.1:3777/mcp
Authorization: Bearer your-shared-secret
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "post_task",
    "arguments": {
      "from": "n8n-workflow-42",
      "to": "builder",
      "title": "Process new lead",
      "description": "Lead data: ...",
      "priority": "high"
    }
  }
}
```

Then register a webhook so n8n hears about completion:

```json
{
  "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": {
    "name": "register_webhook",
    "arguments": {
      "url": "https://your-n8n.example.com/webhook/abc",
      "event": "task.completed",
      "secret": "shared-with-n8n"
    }
  }
}
```

When a task completes, n8n receives a POST with the result and an HMAC signature in `X-Relay-Signature`.

### Config File (v1.2+)

Optional `~/.bot-relay/config.json`:

```json
{
  "transport": "http",
  "http_port": 3777,
  "http_host": "127.0.0.1",
  "webhook_timeout_ms": 5000,
  "http_secret": null,
  "trusted_proxies": []
}
```

Env vars override file config: `RELAY_TRANSPORT`, `RELAY_HTTP_PORT`, `RELAY_HTTP_HOST`, `RELAY_HTTP_SECRET`, `RELAY_TRUSTED_PROXIES` (comma-separated CIDRs).

### Trusted Proxies and X-Forwarded-For (v1.6.2)

By default, the relay IGNORES the `X-Forwarded-For` header completely. Rate limits are keyed on the direct socket peer IP only. This prevents a caller from sending a spoofed header to get their own rate-limit bucket.

If you front the relay with Cloudflare, nginx, or any other reverse proxy, configure `trusted_proxies` with CIDRs of those proxies:

```json
{
  "trusted_proxies": ["127.0.0.0/8", "::1/128", "10.0.0.0/8"]
}
```

Or via env var:

```bash
RELAY_TRUSTED_PROXIES="127.0.0.0/8,::1/128,10.0.0.0/8"
```

When the direct peer IP falls in the trusted list, the relay walks the `X-Forwarded-For` chain right-to-left, skipping trusted hops, and uses the leftmost-untrusted hop as the real client IP. This matches RFC 7239 §7.4 and how nginx/Express normally handle this.

## Per-Agent Tokens (v1.7)

Every tool call (other than first-time `register_agent` and `/health`) requires an agent token. The token identifies WHO is calling — separate from and stronger than the shared HTTP secret, which only identifies a trusted network.

**Issuing a token — first registration:**

```bash
# The response returns `agent_token` ONCE. Save it.
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "register_agent",
    "arguments": { "name": "builder", "role": "builder", "capabilities": ["tasks"] }
  }
}
```

The server stores only a bcrypt hash. The raw token is surfaced **once** in the response `agent_token` field and echoed to stderr as `[auth] New agent_token issued for "builder". Save it: RELAY_AGENT_TOKEN=...`. If you lose it, `unregister_agent` (auth'd) then re-register.

**Presenting the token on every subsequent call — three ways:**

1. Arg field (works for stdio + HTTP):
   ```json
   { "name": "send_message", "arguments": { "from": "builder", "to": "ops", "content": "hi", "agent_token": "..." } }
   ```
2. HTTP header:
   ```
   X-Agent-Token: <token>
   ```
3. Env var (stdio flow, also picked up by HTTP client wrappers):
   ```bash
   export RELAY_AGENT_TOKEN=<token>
   ```

**Capabilities** are set at first registration and are **immutable** (v1.7.1). To change an agent's capability set, call `unregister_agent` (with its token) then `register_agent` with the new capability list. Re-register attempts that change caps are ignored with a `capabilities_note` in the response.

**Capability catalog:**
- `spawn` — required for `spawn_agent`
- `tasks` — required for `post_task`, `update_task`
- `webhooks` — required for `register_webhook`, `list_webhooks`, `delete_webhook`
- `broadcast` — required for `broadcast`
- All other tools are always allowed for any authenticated agent (no capability check).

**Migration for pre-v1.7 agents (v2.1+):** agents registered before v1.7 have no token hash. A `register_agent` call against such a row self-migrates — the relay detects the null hash, issues a fresh token, and the agent is first-class from that point on. **No `RELAY_ALLOW_LEGACY=1` required** for the migration call itself. `RELAY_ALLOW_LEGACY` is still available as a coarser escape hatch for non-register tool calls against unmigrated legacy rows (e.g., if you want `send_message` to work before an agent has migrated); turn it OFF once all your agents have migrated.

## Encryption at Rest (v1.7 opt-in; keyring + rotation in v2.1 Phase 4b.3)

Set the keyring to encrypt message/task/audit/webhook content fields in the SQLite database with AES-256-GCM. Three configuration sources (pick exactly one — multi-set is rejected at startup):

```bash
# 1. Inline JSON (for CI / secrets managers)
export RELAY_ENCRYPTION_KEYRING='{"current":"k1","keys":{"k1":"<base64-32>"}}'

# 2. File path (operator-friendly; chmod 600)
export RELAY_ENCRYPTION_KEYRING_PATH=~/.bot-relay/keyring.json

# 3. Legacy single-key (auto-wraps to { current: "k1", keys: { k1: <value> } }; deprecation warning at startup)
export RELAY_ENCRYPTION_KEY="<base64-32>"

# Generate a key:
openssl rand -base64 32
# or:
node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
```

When the keyring is set, the relay transparently encrypts on write (with `current` key) and decrypts on read (with any key in the keyring). Every ciphertext carries an `enc:<key_id>:...` prefix so rows are self-describing. Legacy `enc1:...` rows (pre-Phase-4b.3 deployments) decrypt via `RELAY_ENCRYPTION_LEGACY_KEY_ID` (default `k1`).

### Rotating keys (online)

Full runbook at [`docs/key-rotation.md`](./docs/key-rotation.md). In summary:

1. Add the new key to the keyring while keeping the old one (both decrypt; `current` still points to old).
2. Flip `current` to the new key; restart. New writes use the new key.
3. `relay re-encrypt --from old_key_id --to new_key_id --yes` — scans + migrates all existing rows across 5 encrypted columns. Resumable.
4. `relay re-encrypt --verify-clean old_key_id` — exit 0 = safe to retire.
5. Remove the old key from the keyring; restart.

Without the keyring set, content is stored plaintext (default, convenient for local dev).

## Rotation Guide — HTTP Shared Secret (v1.7)

The `RELAY_HTTP_SECRET` shared secret can be rotated without downtime using a grace window:

**Step 1 — promote the new secret as primary, keep the old as previous:**

```bash
RELAY_HTTP_SECRET="new-secret-v2" \
RELAY_HTTP_SECRET_PREVIOUS="old-secret-v1" \
RELAY_TRANSPORT=http node dist/index.js
```

During this window, BOTH secrets are accepted. Requests using the old secret receive an `X-Relay-Secret-Deprecated: true` response header as a signal to upgrade.

**Step 2 — update every client** to present `new-secret-v2` in their `Authorization: Bearer …` or `X-Relay-Secret` header.

**Step 3 — watch for the deprecation header** on your dashboard/logs until no more requests use the old secret.

**Step 4 — drop the old secret:**

```bash
RELAY_HTTP_SECRET="new-secret-v2" \
RELAY_TRANSPORT=http node dist/index.js    # RELAY_HTTP_SECRET_PREVIOUS unset
```

Multiple previous secrets are supported as a comma-separated list:

```bash
RELAY_HTTP_SECRET_PREVIOUS="v1-secret,v0-secret"
```

Secret comparisons are timing-safe (v1.7.1 — `crypto.timingSafeEqual`), so an attacker cannot recover the secret via byte-by-byte response-timing measurement.

## Multi-machine: centralized deployment (v2.1)

bot-relay-mcp is LLM-agnostic, CLI-agnostic, and deployment-flexible. Pick the path that fits your setup:

**Path A — Single-machine (default).** Stdio transport, per-terminal process, zero infrastructure. Best for solo development on one laptop. No secrets, no reverse proxies, no ops — run `npm install` + add the stdio entry to your MCP client config and you're done. Covered throughout this README.

**Path B — Multi-machine (centralized, v2.1 Phase 7r).** One bot-relay-mcp hub on a VPS, multiple thin MCP clients connecting via HTTP. Agents on different machines can `send_message`, post tasks, subscribe to webhooks, and join channels through shared state. No new architecture — just the HTTP transport we've had since v1.2, packaged with a convenience CLI in v2.1.

### When to pick centralized

- Two or more machines in play (dev laptop + CI, work + personal, family devices)
- AI agents running on different hosts that need to coordinate
- Team environments where multiple people connect their MCP clients to a shared relay

### Quick pair flow

**On the hub** (VPS, reachable at e.g. `https://relay.example.com`): install bot-relay-mcp, run under systemd with `RELAY_TRANSPORT=http` + `RELAY_HTTP_SECRET`, terminate TLS with Caddy/nginx. See [`docs/multi-machine-deployment.md`](./docs/multi-machine-deployment.md) for the worked VPS runbook.

**On each client machine:**

```bash
relay pair https://relay.example.com \
  --name "$(whoami)-$(hostname -s)" \
  --role operator \
  --capabilities spawn,tasks,webhooks,broadcast,channels \
  --secret "$RELAY_HTTP_SECRET"
```

`relay pair` probes the hub, registers this machine as an agent, captures the returned one-time `agent_token`, and emits an MCP client config snippet ready to paste into `~/.claude.json` / `~/.cursor/mcp.json` / etc. Persist the token (`export RELAY_AGENT_TOKEN=…` in your shell rc) so hooks can authenticate on every terminal open.

Verify after pairing:

```bash
relay doctor --remote https://relay.example.com
```

Expected: PASS on reachability + protocol compatibility + token auth + hub auth config.

### Trust-model tradeoffs

- Hub operator can read plaintext messages in RAM (even with `RELAY_ENCRYPTION_KEY` set, decryption happens server-side for routing)
- Hub is a single point of failure for cross-machine coordination
- Recommended for trusted groups (families, small teams, personal multi-machine setups)
- NOT recommended for mutually distrustful parties sharing a single hub, or compliance-bound workloads where in-RAM access by the operator is a policy violation

See [`SECURITY.md` §Centralized deployment trust model](./SECURITY.md) for the full posture + incident response playbook.

### Bridge to other tools via MCP

bot-relay-mcp is MCP-compatible, so your MCP client can connect to **both** bot-relay-mcp AND other MCP servers (Slack, Discord, Matrix, email, etc.) simultaneously. That's an operator deployment choice — we don't integrate those into bot-relay-mcp. See [`docs/multi-machine-deployment.md` §3](./docs/multi-machine-deployment.md) for the pattern.

## Zero-Friction Setup

To skip approval prompts for relay tools, add this to your project's `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__bot-relay__register_agent",
      "mcp__bot-relay__discover_agents",
      "mcp__bot-relay__send_message",
      "mcp__bot-relay__get_messages",
      "mcp__bot-relay__broadcast",
      "mcp__bot-relay__post_task",
      "mcp__bot-relay__update_task",
      "mcp__bot-relay__get_tasks",
      "mcp__bot-relay__get_task",
      "mcp__bot-relay__register_webhook",
      "mcp__bot-relay__list_webhooks",
      "mcp__bot-relay__delete_webhook"
    ]
  }
}
```

## Auto-Check on Session Start

Add a `SessionStart` hook so every terminal automatically checks the relay for pending messages when it opens. See `docs/hooks.md` for the full configuration.

## Near-Real-Time Mail Delivery (v1.8)

The `SessionStart` hook only fires when a terminal opens. If an agent is actively working and mail arrives mid-session, it does not see the message until next startup (or a human pastes it in).

v1.8 adds a `PostToolUse` hook — `hooks/post-tool-use-check.sh` — that fires after every tool call, checks the mailbox, and injects pending messages as `additionalContext` so the running session picks them up immediately.

Install per-project (NOT global), in `<project>/.claude/settings.json`:

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

> **Important — if your path contains spaces, single-quote it inside the JSON string.** Claude Code passes the `command` to the shell, which splits on whitespace. Without the single quotes the hook silently fails with errors like `/bin/sh: ... is a directory`. Example for a real installation at `/Users/maxime/Documents/Ai stuff/Claude AI/bot-relay-mcp/`:
>
> ```json
> "command": "'/Users/maxime/Documents/Ai stuff/Claude AI/bot-relay-mcp/hooks/post-tool-use-check.sh'"
> ```
>
> The outer double-quotes are JSON; the inner single-quotes are shell. Paths with no spaces do not need this treatment.

The hook prefers the HTTP path when `RELAY_AGENT_TOKEN` is set and the daemon is running (full auth + audit), falling back to direct sqlite on `RELAY_DB_PATH` otherwise. It does NOT re-register (SessionStart handles that), does NOT check tasks (simpler focus, less context pressure), and silent-exits when there is no mail. Full docs + troubleshooting in [`docs/post-tool-use-hook.md`](./docs/post-tool-use-hook.md).

**Honest limitation:** idle terminals get no delivery. The hook only fires when the agent is actively running tool calls. For long-idle windows, still rely on SessionStart + human attention.

## Turn-End Mail Delivery (v2.1)

`PostToolUse` only fires on turns that include at least one tool call. A text-only turn (Claude responds with no tool invocation) does not trigger it. The `Stop` hook — `hooks/stop-check.sh` — closes that gap by firing on every turn-end, whether or not the turn invoked tools. Install both together in your project's `.claude/settings.json`:

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

Same single-quote-the-path-if-it-contains-spaces rule, same env vars, same HTTP/sqlite fallback, same silent-fail contract as `PostToolUse`. Full docs + troubleshooting in [`docs/stop-hook.md`](./docs/stop-hook.md).

**Honest limitation:** `Stop` does NOT wake truly idle terminals. If no turn is in progress, neither hook fires. For long-idle windows, use the Layer 2 Managed Agent reference (`examples/managed-agent-reference/`).

## Backup & Restore (v2.1)

Two CLIs for disaster recovery:

```bash
relay-backup                              # snapshot to ~/.bot-relay/backups/
relay-backup --output /srv/backup.tgz     # custom path
relay-restore ~/.bot-relay/backups/relay-backup-<iso>.tar.gz
```

`relay-backup` produces a `tar.gz` of the live DB (via a consistent `VACUUM INTO` snapshot — safe while the daemon is running), the optional `config.json`, and a `manifest.json` with schema version and row counts. Works identically on the native `better-sqlite3` driver and the optional `sql.js` wasm driver.

`relay-restore` always safety-backs-up the current DB first (to `~/.bot-relay/backups/pre-restore-<iso>.tar.gz`). If that safety backup fails, the restore aborts untouched. It then refuses if the daemon appears to be running (`/health` probe, best-effort), refuses schema-version mismatches (higher = hard refuse, lower = `--force` overrides), runs `PRAGMA integrity_check` on the extracted DB, and finally atomic-swaps the new DB into place.

Full docs + troubleshooting in [`docs/backup-restore.md`](./docs/backup-restore.md).

## Lost-Token Recovery (v2.1)

Close a terminal, lose `RELAY_AGENT_TOKEN`, and the relay rejects your `register_agent` with `AUTH_FAILED` because the row is intact. Clear the registration so the agent can re-bootstrap:

```bash
relay recover <agent-name>                 # interactive confirm
relay recover <agent-name> --yes           # skip confirm (for scripts)
relay recover <agent-name> --dry-run       # show what would change, commit nothing
relay recover <agent-name> --db-path PATH  # non-default DB location
```

Messages and tasks addressed to the agent are **preserved** — only the `agents` + `agent_capabilities` rows are cleared. After recovery, the operator calls `register_agent` with the same name/role/capabilities and captures a fresh `agent_token`.

Trust model: filesystem access to `~/.bot-relay/relay.db` IS the authority (same boundary the daemon relies on). Not an MCP tool — the caller by definition cannot authenticate. The CLI emits an `audit_log` entry with `tool='recovery.cli'` + the operator's OS username for incident traceability.

## Cross-Platform Spawn (v1.9)

`spawn_agent` opens a new Claude Code terminal on macOS, Linux, and Windows via a driver abstraction:

- **macOS** — `bin/spawn-agent.sh` (iTerm2 → Terminal.app). Unchanged from v1.6.4, preserves the 3-layer hardening + 19-payload adversarial test suite.
- **Linux** — `gnome-terminal` → `konsole` → `xterm` → `tmux` fallback chain. The tmux fallback creates a detached session (attach later with `tmux attach -t <agent-name>`) — covers headless servers with no GUI.
- **Windows** — `wt.exe` (Windows Terminal) → `powershell.exe` → `cmd.exe`.

Driver selection: `RELAY_TERMINAL_APP` override (allowlist-gated) > `process.platform` auto-detect > in-driver fallback chain.

Full install requirements per platform + manual smoke-test checklists + troubleshooting: [`docs/cross-platform-spawn.md`](./docs/cross-platform-spawn.md).

**Env-var propagation** is minimal by default (principle of least authority): system essentials + anything prefixed `RELAY_*`. Secrets like `AWS_SECRET_ACCESS_KEY` are NOT passed to spawned agents unless explicitly prefixed.

## Layer 2: Managed Agents (v1.10)

Agents that are NOT Claude Code terminals — Python daemons, Node workers, Hermes/Ollama integrations, custom scripts. They connect to the relay via HTTP (recommended) or direct SQLite, use the same 25 MCP tools (v2.1), and authenticate with per-agent tokens. If registered with `managed:true`, they also receive token-rotation push-messages over the normal `get_messages` channel — see [`docs/managed-agent-protocol.md`](./docs/managed-agent-protocol.md).

Full integration guide with mental model, auth flow, lifecycle, error patterns, and security notes: [`docs/managed-agent-integration.md`](./docs/managed-agent-integration.md).

Runnable reference implementations (stdlib-only, ~200 LOC each):
- **Python:** [`examples/managed-agent-reference/python/agent.py`](./examples/managed-agent-reference/python/agent.py)
- **Node:** [`examples/managed-agent-reference/node/agent.js`](./examples/managed-agent-reference/node/agent.js)

Both demonstrate: register, send/receive messages, accept + complete tasks, discover peers, SIGINT cleanup. Each has a `SMOKE.md` with a 5-step manual verification checklist.

## SQLite Driver Options (v1.11)

The relay uses SQLite for persistent state. Two drivers are available:

- **`native` (default)** — `better-sqlite3`, a compiled C addon. Fast, supports WAL mode, multi-process safe. Requires a C++ compiler at `npm install` time.
- **`wasm`** — `sql.js`, SQLite compiled to WebAssembly. Zero native compilation. Slightly slower writes (in-memory + write-back-to-file). **Single-process only** (not safe for multi-terminal stdio).

Switch with one env var:

```bash
npm install sql.js                    # one-time install of the optional dep
RELAY_SQLITE_DRIVER=wasm node dist/index.js
```

Both drivers read the same `relay.db` file format. Full details, performance notes, and limitations: [`docs/sqlite-wasm-driver.md`](./docs/sqlite-wasm-driver.md).

## Roadmap

- **v1.1**: Local relay, 9 tools, SQLite, auto-purge
- **v1.2**: HTTP transport, webhook system, config file — 12 tools
- **v1.3**: Presence integrity, `unregister_agent`, hook delivers mail — 13 tools
- **v1.4**: `spawn_agent` + role templates + dashboard — 14 tools
- **v1.5**: Built-in security — Bearer auth, audit log, rate limiting
- **v1.6**: Hardening pass — SSRF, input validation, path traversal, stdout discipline
- **v1.7**: Per-agent tokens, secret rotation, at-rest encryption, capability scoping
- **v1.8**: Near-real-time mail via `PostToolUse` hook
- **v1.9**: Cross-platform spawn (macOS / Linux / Windows / tmux) — Node/TS driver abstraction
- **v1.10**: Layer 2 Managed Agents — reference Python + Node workers
- **v1.11**: SQLite WASM driver (`sql.js` opt-in) — zero native compilation on Windows/Alpine/Docker/CI
- **v2.0**: Plug-and-play — channels, smart routing (`post_task_auto`), task leases + heartbeat, lazy health monitor, session-aware reads, busy/DND, `health_check`, webhook retry with CAS, payload size limits, config validation, auto-unregister, dead-agent purge, debug mode. 22 tools.
- **v2.1 (current)**: Architectural completion — explicit `auth_state` machine, managed-agent rotation grace, versioned ciphertext + keyring with online rotation (`relay re-encrypt`), lost-token recovery CLI (`relay recover`), admin-initiated cross-agent rotation (`rotate_token_admin`), structured error_code catalog, protocol_version surface, Phase 4p webhook-secret encryption, Phase 4b.1 v2 revoke/recovery redesign. 25 tools. 14 of 14 Codex architectural findings closed.
- **v2.2**: Polish — batch operations, fan-out/fan-in, scheduled messages, metrics endpoint, message ACK, private channels, token scoping, idle-terminal wake.
- **v2.5**: Federation — cross-machine peering, E2E encryption.

## Dashboard

When running in `http` or `both` mode, open `http://127.0.0.1:3777/` in a browser. You'll see:
- Live agent presence (online / stale / offline)
- Active tasks with priority and assignment
- Recent messages
- Registered webhooks
- Recently completed tasks

Auto-refreshes every 3 seconds. Useful for "what's happening across all my terminals right now?" at a glance.

## Role Templates

See `roles/` for drop-in role specs. Examples:
- **planner.md** — orchestrator that delegates and synthesizes
- **builder.md** — worker that accepts and completes tasks
- **reviewer.md** — skeptical reviewer with structured output
- **researcher.md** — investigates questions, returns findings

Three ways to apply a role: paste into project `CLAUDE.md`, pass as `initial_message` when spawning, or wire via shell alias.

## Requirements

- Node.js 18+
- Claude Code (or any MCP-compatible client)

## License

MIT
