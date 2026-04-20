# Multi-Machine Deployment: Centralized bot-relay-mcp

**Phase:** v2.1.0 Phase 7r
**Scope:** Package the "one hosted bot-relay-mcp + many thin MCP clients" deployment pattern as a first-class story.
**Prerequisites:** Node 20+ on the hub; at least one MCP-compatible client (Claude Code / Cursor / Aider / custom) on each machine.

---

## 1. Why centralize?

The default install is single-machine: `stdio` transport, per-terminal process, zero infrastructure. That's perfect for solo work on one laptop.

Once you have **more than one machine** in play — a dev laptop + a CI box, a work laptop + a personal laptop, family members on different devices, multiple AI agents on different hosts — you need a shared data plane. bot-relay-mcp's HTTP transport already supports this: run one daemon on a VPS, point every MCP client at it, and suddenly agents on different machines can `send_message`, `post_task`, subscribe to webhooks, and coordinate through a shared SQLite state.

No new architecture. No federation protocol. Just the HTTP transport we've had since v1.2, hardened through v1.7 (per-agent tokens), v2.0 (channels + smart routing), and v2.1 (Phase 4d dashboard auth, Phase 4e webhook hardening, Phase 4n open-bind refusal).

**Trust model** — read [`SECURITY.md` §Centralized deployment trust model](../SECURITY.md) before deciding. Short version: the hub operator can see plaintext messages in RAM, hub is a single point of failure for cross-machine traffic, recommended for trusted-group deployments (families, small teams, personal multi-machine setups), not for mutually-distrustful parties sharing a single hub.

---

## 2. Worked example: VPS hub for two machines

Deployment target: a $5/mo DigitalOcean droplet (Singapore, Ubuntu 22.04) reachable at `relay.example.com`. Two clients: laptop-A and laptop-B.

### 2.1 On the VPS

```bash
# 1. Install Node 20+ (nvm, nodesource, or pkg — whatever you prefer).
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Install bot-relay-mcp (once published to npm; until then, git clone + npm install).
sudo npm install -g bot-relay-mcp@2.1.0
# OR for the pre-publish candidate:
# git clone https://github.com/Maxlumiere/bot-relay-mcp.git /opt/bot-relay-mcp
# cd /opt/bot-relay-mcp && npm install && npm run build

# 3. Generate a 32+ character shared secret for HTTP auth.
RELAY_HTTP_SECRET=$(openssl rand -base64 48 | tr -d '=/' | head -c 48)
echo "Shared secret (save this — clients will need it): $RELAY_HTTP_SECRET"

# 4. Generate a 32-byte encryption key for at-rest protection (optional but recommended).
RELAY_ENCRYPTION_KEY=$(openssl rand -base64 32)
echo "Encryption key (save this — needed for backup restores): $RELAY_ENCRYPTION_KEY"

# 5. Initialize + start under systemd.
sudo mkdir -p /opt/bot-relay-mcp /etc/bot-relay-mcp
sudo chown $USER:$USER /opt/bot-relay-mcp /etc/bot-relay-mcp
chmod 700 /opt/bot-relay-mcp /etc/bot-relay-mcp
relay init --yes --db-path /opt/bot-relay-mcp/relay.db --config /etc/bot-relay-mcp/config.json

cat >/etc/systemd/system/bot-relay-mcp.service <<UNIT
[Unit]
Description=bot-relay-mcp
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=/opt/bot-relay-mcp
Environment=RELAY_TRANSPORT=http
Environment=RELAY_HTTP_HOST=127.0.0.1
Environment=RELAY_HTTP_PORT=3777
Environment=RELAY_DB_PATH=/opt/bot-relay-mcp/relay.db
Environment=RELAY_CONFIG_PATH=/etc/bot-relay-mcp/config.json
Environment=RELAY_HTTP_SECRET=$RELAY_HTTP_SECRET
Environment=RELAY_ENCRYPTION_KEY=$RELAY_ENCRYPTION_KEY
ExecStart=/usr/bin/node /usr/lib/node_modules/bot-relay-mcp/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now bot-relay-mcp
sudo systemctl status bot-relay-mcp   # confirm it's green
```

### 2.2 TLS termination (recommended: caddy)

Bind bot-relay-mcp to `127.0.0.1:3777` (loopback only) and run Caddy as the public-facing reverse proxy with automatic TLS:

```caddyfile
# /etc/caddy/Caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:3777
    encode gzip
    # Long-polled SSE responses from /mcp need generous timeouts.
    # Match the relay's internal request budget (~30s).
    request_body {
        max_size 2MB
    }
}
```

```bash
sudo apt-get install -y caddy
sudo systemctl enable --now caddy
```

Caddy fetches a Let's Encrypt cert on first start; no manual certbot step. Verify with `curl https://relay.example.com/health`.

Alternative: nginx with certbot. Same shape — reverse proxy to 127.0.0.1:3777, enable TLS, set a generous body/timeout budget for SSE.

### 2.3 On each client machine (laptop-A, laptop-B)

Install bot-relay-mcp locally for the CLI (`relay pair`, `relay doctor --remote`):

```bash
npm install -g bot-relay-mcp@2.1.0
```

Pair with the hub:

```bash
relay pair https://relay.example.com \
  --name laptop-a-$(whoami) \
  --role operator \
  --capabilities spawn,tasks,webhooks,broadcast,channels \
  --secret "$RELAY_HTTP_SECRET"
```

The command prints an MCP client config snippet like:

```json
{
  "bot-relay": {
    "type": "http",
    "url": "https://relay.example.com/mcp",
    "headers": {
      "X-Agent-Token": "NQ4fgn4mFw_Y5Ar6ERH1WL38QziChjD624STj0eU_m4",
      "X-Relay-Secret": "…"
    }
  }
}
```

Paste it under `mcpServers` in your MCP client config:

- **Claude Code:** `~/.claude.json`
- **Cursor:** `~/.cursor/mcp.json`
- **Aider / custom:** see your client's MCP setup docs

Then persist the token for hooks:

```bash
echo 'export RELAY_AGENT_TOKEN=NQ4fgn4mFw_Y5Ar6ERH1WL38QziChjD624STj0eU_m4' >> ~/.zshrc
source ~/.zshrc
```

Verify connectivity:

```bash
relay doctor --remote https://relay.example.com
```

Expected: PASS on hub reachability + protocol compatibility + token auth + hub auth config.

Repeat on laptop-B with a distinct `--name` (e.g. `laptop-b-<user>`). That's it — two agents on two machines can now `send_message` to each other, post tasks across the hub, broadcast, and join shared channels.

---

## 3. Operator-choice bridge: Slack / Discord / Matrix

bot-relay-mcp is MCP-compatible, so it is NOT the only thing your MCP client can talk to. If you also want your agents to interact with Slack / Discord / Matrix / email, connect to **both** bot-relay-mcp AND a relevant MCP server on the same client:

```json
{
  "mcpServers": {
    "bot-relay": {
      "type": "http",
      "url": "https://relay.example.com/mcp",
      "headers": { "X-Agent-Token": "…", "X-Relay-Secret": "…" }
    },
    "slack": {
      "type": "stdio",
      "command": "npx",
      "args": ["@slack/mcp-server"]
    }
  }
}
```

The client sees both as independent toolsets. Messages to other agents go through bot-relay-mcp; Slack ops go through the Slack MCP server. One MCP client, two back-ends, operator-controlled. **We are not integrating Slack/Discord/Matrix into bot-relay-mcp** — that's an operator deployment choice, not a scope item for us. Reference upstream MCP servers:

- [Slack MCP](https://github.com/modelcontextprotocol/servers/tree/main/src/slack)
- [Discord / Matrix / email MCP servers](https://github.com/modelcontextprotocol/servers) — the canonical upstream list

---

## 4. Monitoring

What to alert on (rough priority):

1. **Hub process down** — `systemctl status bot-relay-mcp`. Add a watchdog or pager check (uptime.com / healthchecks.io) on `https://relay.example.com/health`.
2. **Disk fill** — SQLite WAL + backup tarballs will eat space. Alert at 80% of volume capacity. Run `relay backup` rotation on a cron.
3. **Auth failure spikes** — `grep -c 'auth_error' /var/log/bot-relay-mcp.log` over a rolling window. A sudden spike is a symptom of a leaked/rotated token, scanner, or misconfigured client.
4. **Token rotation grace windows past expiry** — if `RELAY_ROTATION_GRACE_SECONDS` windows expire unused, the push-message protocol (Phase 4b.2) may have a delivery issue.

bot-relay-mcp logs to stderr (journald capture under systemd). No structured metrics endpoint in v2.1.0 — that's a v2.3+ add if demand surfaces.

---

## 5. Backup + restore

**Back up the hub daily.** One tar.gz covers the DB + config:

```bash
# Crontab on the hub (daily 03:00 UTC):
0 3 * * * cd /opt/bot-relay-mcp && relay backup --output /var/backups/bot-relay-$(date +\%Y\%m\%d).tar.gz && find /var/backups -name 'bot-relay-*.tar.gz' -mtime +30 -delete
```

Store `RELAY_ENCRYPTION_KEY` alongside the backups (in a separate sealed location — 1Password, Vault, offline USB). Without it you cannot read historical encrypted content after a restore.

**Restore procedure** (e.g. after hub-drive failure):

```bash
# On the new host, after install + systemd unit set up but BEFORE starting:
relay restore /path/to/bot-relay-20260418.tar.gz
# Verify the DB:
relay doctor
# Start:
sudo systemctl start bot-relay-mcp
```

Restore preserves every agent registration, message, task, channel, and webhook delivery log — clients continue working as soon as the new hub binds the same DNS name.

---

## 6. Incident response

### 6.1 Hub compromise (operator host rooted)

1. Stop the hub: `sudo systemctl stop bot-relay-mcp`.
2. Rotate `RELAY_HTTP_SECRET` in systemd unit + `RELAY_ENCRYPTION_KEY` via `relay re-encrypt` (see [`docs/key-rotation.md`](./key-rotation.md)).
3. Revoke every agent's token — `relay recover <name>` for each, or bulk via a script. Clients must re-pair.
4. Review audit log for lateral activity (`SELECT * FROM audit_log WHERE created_at > ?`).
5. Restore from last-known-good backup if active DB is suspect.

### 6.2 Single-agent token leak

Client token accidentally committed to a public repo:

```bash
# On the hub:
relay recover <compromised-agent-name>
```

Then on the affected client, re-run `relay pair` to issue a fresh token.

### 6.3 Agent revocation across clients

Revoke a specific agent cross-hub via the `revoke_token` MCP tool (admin capability required) — v2.1 Phase 4b.1 v2's `auth_state='revoked'` gate ensures the revoked agent cannot re-register without a recovery token.

---

## 7. Cross-reference

- [`SECURITY.md`](../SECURITY.md) — full threat model + centralized deployment trust model.
- [`docs/key-rotation.md`](./key-rotation.md) — encryption key rotation operator runbook.
- [`docs/migration-v1-to-v2.md`](./migration-v1-to-v2.md) — version-to-version upgrade procedure.
- [`README.md` §Multi-machine: centralized deployment](../README.md) — user-facing summary that links back here for the full runbook.
- [`docs/federation-envelope-v1.md`](./federation-envelope-v1.md) — frozen paper spec reserving shape for the v2.3 hub federation story. v2.1.0 does not implement it.

---

## 8. Known limitations (v2.1.0)

- **Single-hub only** — no multi-hub bridging. Plan: v2.3 edge/hub split + v3 multi-hub pilot.
- **Operator sees plaintext in hub RAM** — on-disk encryption via `RELAY_ENCRYPTION_KEY` does not reach the routing layer. End-to-end encryption is a v3+ item (see `docs/federation-envelope-v1.md` §3.1).
- **TLS is your job** — bot-relay-mcp does not bundle certbot or similar. Run Caddy/nginx as the reverse proxy.
- **No per-client rate limits distinct from per-agent** — quota is keyed on `agent_name`, so a client with many agents shares the pool.
- **Hub is SPOF for cross-machine traffic** — local-only operations within each client's stdio MCP config still work if the hub is down, but cross-machine coordination halts.

Address these explicitly in your operator runbook before adopting.
