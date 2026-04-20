# Migration Guide: v1.x → v2.1

**For operators upgrading from v1.x or v2.0.x to v2.1.0.**

v2.1.0 is the first architecturally complete release. It adds the auth_state machine, managed agents + rotation grace, versioned ciphertext with keyring rotation, a unified `relay` CLI, `recover` + `re-encrypt` subcommands, and 1 new MCP tool (`rotate_token_admin`).

This guide walks you through:

1. What changed (summary)
2. Schema migration path (0 → 5)
3. Auth migration (no-token → v1.7 token → v2.1 auth_state)
4. Keyring migration (`RELAY_ENCRYPTION_KEY` → `RELAY_ENCRYPTION_KEYRING`)
5. Webhook payload additions
6. CLI subcommand changes (`relay-backup` / `relay-restore` absorbed)
7. Step-by-step upgrade from v2.0.2 → v2.1.0

---

## 1. What changed

### Breaking

- **Revoked agents no longer silently re-bootstrap.** In v2.0.x, a revoked agent (null token_hash) could re-register via the legacy-migration path. v2.1's `auth_state` machine explicitly distinguishes `revoked` from `legacy_bootstrap`. Revoked agents need an admin-issued `recovery_token` to re-register. See Phase 4b.1 v2 in the CHANGELOG.
- **Ciphertext format versioned.** New rows write `enc:<key_id>:...`. Legacy `enc1:...` rows are still readable forever (backward-compatible), but your monitoring / backup tooling that greps for the `enc1:` prefix specifically will need to accept both. See `src/encryption.ts`.
- **`relay-backup` + `relay-restore` standalone bins removed.** Absorbed into `relay backup` + `relay restore` (unified CLI). Operator scripts that call the old bin names must update.
- **`/srv/backups` example path retired** — default is `~/.bot-relay/backups/`. Custom destinations still supported via `--output`.

### Additive (no action required)

- **`rotate_token_admin`** — new tool for admin-initiated cross-agent rotation. Requires the new `rotate_others` capability on the caller.
- **Managed agent class** (`managed:true` on register). Daemon-wrapper agents get a rotation grace window + push-message instead of immediate cut-off.
- **`relay recover <name>`** — filesystem-gated lost-token recovery (Phase 4o).
- **`relay re-encrypt`** — batch migrate existing rows to a new keyring key (Phase 4b.3).
- **Webhook envelope fields** — `delivery_id` + `idempotency_key` always present. Consumers can dedupe across retries.
- **`protocol_version` field** on `register_agent` + `health_check` responses (Phase 4i).
- **Structured `error_code`** — every error response carries a stable 16-code catalog value (Phase 4g).

---

## 2. Schema migration path

The relay uses `schema_info.version` + a migration chain that runs on every `initializeDb()`:

| Version | Change | Added |
|---|---|---|
| 0 (pre-v1.7) | Original schema — no `token_hash` column | v1.6.x |
| 1 | `schema_info` table + `migrateSchemaToV1_7` + v2.0 additive migrations | v1.7 / v2.0 |
| 2 | `auth_state` enum column (+ `revoked_at` + `recovery_token_hash`) | Phase 4b.1 v2 |
| 3 | `webhook_subscriptions.secret` one-shot encryption pass | Phase 4p |
| 4 | `managed` + `rotation_grace_expires_at` + `previous_token_hash`; `auth_state` CHECK rewrite | Phase 4b.2 |
| 5 | `reencryption_progress` table | Phase 4b.3 |

Every migration is idempotent. Running the current daemon against ANY prior schema will migrate in place on startup. Row data is preserved end-to-end.

**No operator action required** — open the daemon, migration runs, done. Verify with:

```bash
sqlite3 ~/.bot-relay/relay.db "SELECT version FROM schema_info"
# expect: 5
```

---

## 3. Auth migration

Three-step history:

**v1.6.x (no tokens).** Agents registered by name + role; no authentication. Any client could impersonate any agent.

**v1.7 (tokens).** `agents.token_hash` column added. `register_agent` returns a fresh token ONCE; subsequent calls must present it via arg / header / env. Legacy null-hash rows still work if `RELAY_ALLOW_LEGACY=1` is set — this is the migration grace window.

**v2.1 (`auth_state` machine).** Explicit per-agent state: `active | legacy_bootstrap | revoked | recovery_pending | rotation_grace`. Revoke + recovery lifecycle replaces the v1 NULL-hash-as-revoked overload. Legacy-grace does NOT bypass capability checks (Phase 4b.1 v2 HIGH A fix).

Upgrade path:
1. Stop the daemon.
2. Take a backup: `relay backup` (writes to `~/.bot-relay/backups/relay-backup-<iso>.tar.gz`).
3. Start the v2.1.0 daemon — migration auto-runs.
4. Pre-v1.7 legacy rows (null token_hash) get marked as `auth_state='legacy_bootstrap'`. They can still self-migrate via plain `register_agent` (Phase 2b path).
5. All rows with an existing token_hash get `auth_state='active'`.

---

## 4. Keyring migration

v1.7 used a single `RELAY_ENCRYPTION_KEY` env var. v2.1 introduces the keyring model (`RELAY_ENCRYPTION_KEYRING` JSON or `RELAY_ENCRYPTION_KEYRING_PATH` file).

**You don't have to migrate.** `RELAY_ENCRYPTION_KEY` continues to work — the daemon auto-wraps it as `{current: "k1", keys: {k1: <value>}}` + emits a one-time deprecation warning at startup.

**When you want key rotation**, switch to the keyring:

```bash
# Before: single key
export RELAY_ENCRYPTION_KEY="<base64-32>"

# After: keyring file
mkdir -p ~/.bot-relay
cat > ~/.bot-relay/keyring.json <<EOF
{
  "current": "k1",
  "keys": {
    "k1": "<base64-32>"
  }
}
EOF
chmod 600 ~/.bot-relay/keyring.json
export RELAY_ENCRYPTION_KEYRING_PATH=~/.bot-relay/keyring.json
unset RELAY_ENCRYPTION_KEY  # one source of truth
```

Once on the keyring, add a second key + rotate via `docs/key-rotation.md`.

---

## 5. Webhook payload additions

v2.1 webhook deliveries always include:

- `delivery_id` — UUID per delivery attempt. Stable across retries of the same event.
- `idempotency_key` — stable across the event's lifetime (same event → same key across all retries). Consumers dedupe on this.
- `X-Relay-Signature` header — HMAC-SHA256 of the body under the webhook's plaintext secret (decrypted at fire time from the keyring-encrypted column).

If your consumer processes webhooks without dedup, add it now using `idempotency_key`. Retry semantics are `at-least-once, possibly out-of-order`.

---

## 6. CLI subcommand changes

Phase 4h absorbed two standalone bins into the unified `relay` CLI:

| Old | New |
|---|---|
| `relay-backup --output <path>` | `relay backup --output <path>` |
| `relay-restore <path>` | `relay restore <path>` |

Operator scripts calling the old names must update. `package.json`'s `bin` map no longer ships `relay-backup` / `relay-restore`.

New subcommands:

- `relay recover <agent-name>` — clear a registration so the agent can re-bootstrap (lost-token recovery).
- `relay re-encrypt --from <old_key> --to <new_key>` — batch migrate rows to a new encryption key.
- `relay doctor` — diagnostic sweep (config + schema + perms + daemon + hooks).
- `relay init --yes` — one-shot first-run setup.
- `relay test` — isolated round-trip self-check.
- `relay generate-hooks [--full]` — emit Claude Code hook JSON.

---

## 7. Step-by-step upgrade: v2.0.2 → v2.1.0

### Pre-upgrade

```bash
# 1. Stop the current daemon.
pkill -f bot-relay-mcp/dist/index.js

# 2. Back up (uses the v2.0.2 bin).
~/.bot-relay/  # verify the DB exists here
relay-backup --output ~/.bot-relay/backups/pre-v2.1.0.tar.gz  # v2.0.2 syntax

# 3. Capture your current env config (if any):
env | grep RELAY_
```

### Upgrade

```bash
# Pull v2.1.0 source or install from npm (once published).
git pull
npm install
npm run build

# OR, after npm publish:
npm install -g bot-relay-mcp@2.1.0
```

### Start v2.1.0

```bash
RELAY_TRANSPORT=http RELAY_HTTP_PORT=3777 node /path/to/dist/index.js &

# Migration auto-runs on first initializeDb. Verify:
curl -s http://127.0.0.1:3777/health | jq '.version'
# expect: "2.1.0"

sqlite3 ~/.bot-relay/relay.db "SELECT version FROM schema_info"
# expect: 5
```

### Post-upgrade sanity

```bash
# Your existing agents should still be visible.
curl -s -X POST http://127.0.0.1:3777/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"discover_agents","arguments":{}}}'

# Run the post-upgrade smoke.
bash /path/to/bot-relay-mcp/scripts/smoke-25-tools.sh
```

### If something goes wrong

Restore from the pre-upgrade backup:

```bash
pkill -f bot-relay-mcp/dist/index.js

# v2.1.0 syntax — old `relay-restore` bin removed.
relay restore ~/.bot-relay/backups/pre-v2.1.0.tar.gz --force

# Restart on v2.0.2 (or whichever version you had).
```

### Rollback note

A v2.1.0 DB CANNOT be downgraded to v2.0.2 in place — the schema additions don't have a down-migration. If you restore a pre-v2.1.0 backup, the daemon re-migrates up. If you restore a v2.1.0 backup onto a v2.0.2 daemon, `initializeDb()` would error on the unknown columns. Always keep your pre-upgrade backup until you're confident the new version is stable.

---

## Known limitations (intentional deferrals)

- **Idle-terminal wake** — SessionStart / PostToolUse / Stop hooks cover active agents. A terminal sitting idle with no turn-in-progress does NOT poll its mailbox. Managed Agent reference workers (Layer 2) or a human typing in the terminal are the coverage paths for idle agents. See `plug-and-play-retro.md` item forthcoming for v2.2.
- **Federation** — v2.5 concern. Current v2.1.0 serves a single operator's agents.
- **Multi-operator** — same daemon can't safely serve conflicting operators. Stand up separate daemons.
- **Post-quantum crypto** — not in scope before v3.x. Current keyring is AES-256-GCM.

---

## References

- `CHANGELOG.md` — every phase by version.
- `SECURITY.md` — threat model + defenses.
- `docs/key-rotation.md` — keyring rotation runbook.
- `docs/backup-restore.md` — backup/restore operator guide.
- `devlog/` — chronological build history.
