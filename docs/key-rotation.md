# Encryption Key Rotation

**Introduced:** v2.1 Phase 4b.3 (keyring + versioned ciphertext + `relay re-encrypt`).

This runbook covers rotating the key that protects at-rest encrypted columns in the relay DB. If your threat model doesn't require rotation (single-tenant dev relays, no key compromise events), you can skip this — the keyring works identically with a single key.

## Encrypted columns

The relay encrypts these columns when a keyring is configured:

| Table | Column | Since |
|---|---|---|
| `messages` | `content` | v1.7 |
| `tasks` | `description`, `result` | v1.7 |
| `audit_log` | `params_json` | v1.7 |
| `webhook_subscriptions` | `secret` | v2.1 Phase 4p |

All use AES-256-GCM. Ciphertext is base64-encoded with a prefix that identifies the key used to produce it.

## Ciphertext formats (stable forever)

- **`enc:<key_id>:<iv>:<payload>`** — v2 versioned format (Phase 4b.3). Every `encryptContent` call after this phase emits this shape. `<key_id>` is an operator-chosen name (e.g. `k1`, `k2`, `2026q2`); must match `^[a-zA-Z0-9_.-]+$`.
- **`enc1:<iv>:<payload>`** — legacy v1 format (Phase 4p). Never written after Phase 4b.3. Still readable; assumed to use key_id = `RELAY_ENCRYPTION_LEGACY_KEY_ID` (default `k1`).
- **unprefixed** — plaintext. Either no keyring is configured OR the row predates encryption activation.

The parser distinguishes `enc:` vs `enc1:` by the character immediately after `enc` — `:` means v2, `1` means legacy.

## Configuring the keyring

Three sources (pick **exactly one** — multi-set is rejected at startup):

### 1. `RELAY_ENCRYPTION_KEYRING` — JSON blob in env

```bash
export RELAY_ENCRYPTION_KEYRING='{"current":"k2","keys":{"k1":"<base64-32>","k2":"<base64-32>"}}'
```

Best for CI / secrets managers that inject config via env vars. The JSON must parse cleanly + validate.

### 2. `RELAY_ENCRYPTION_KEYRING_PATH` — filesystem path

```bash
export RELAY_ENCRYPTION_KEYRING_PATH=~/.bot-relay/keyring.json
chmod 600 ~/.bot-relay/keyring.json
```

`keyring.json`:

```json
{
  "current": "k2",
  "keys": {
    "k1": "<base64-32-bytes>",
    "k2": "<base64-32-bytes>"
  }
}
```

More ergonomic for direct operator edits. File perms should be 0600 (the relay warns otherwise).

### 3. `RELAY_ENCRYPTION_KEY` — legacy single-key (deprecated)

```bash
export RELAY_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

Phase 4b.3 auto-wraps this into a keyring shape: `{current:"<RELAY_ENCRYPTION_LEGACY_KEY_ID or 'k1'>", keys:{<id>:<value>}}`. Emits a deprecation warning at startup. Still supported indefinitely; migrate to the keyring shape at your own pace.

## Generating a new key

```bash
openssl rand -base64 32
```

Copy the output into the `keys` map with a unique `key_id`.

## Rotation workflow

This is the workflow for replacing an existing key with a new one:

### Step 1 — Add the new key to your keyring

Edit `keyring.json` (or update the `RELAY_ENCRYPTION_KEYRING` env blob):

```json
{
  "current": "k1",
  "keys": {
    "k1": "<existing-key>",
    "k2": "<new-key-you-just-generated>"
  }
}
```

Note `current` still points to `k1` — new writes keep using the OLD key for now. This is deliberate: the relay needs both keys present BEFORE we start rotating.

Restart the daemon so it picks up the updated keyring.

### Step 2 — Flip `current` to the new key

Edit the keyring:

```json
{
  "current": "k2",
  "keys": { "k1": "...", "k2": "..." }
}
```

Restart the daemon. From this point on, every NEW write uses `k2`. Existing rows still carry `enc:k1:...`. Both decrypt correctly because `k1` is still in the keyring.

### Step 3 — Re-encrypt existing rows

```bash
relay re-encrypt --from k1 --to k2 --yes
```

Scans all 5 encrypted columns, decrypts rows tagged with `k1`, re-encrypts with `k2`. Resumable — if the process is interrupted, re-run the same command and it picks up where it left off via the `reencryption_progress` table.

Add `--dry-run` first if you want to see the plan without writes:

```bash
relay re-encrypt --from k1 --to k2 --dry-run
```

### Step 4 — Verify retirement safety

```bash
relay re-encrypt --verify-clean k1
```

Exit 0 = count is zero across all 5 encrypted columns — `k1` is safe to retire. Exit 1 = rows still pending (breakdown printed on stderr).

### Step 5 — Retire the old key

Remove `k1` from the keyring:

```json
{
  "current": "k2",
  "keys": { "k2": "..." }
}
```

Restart the daemon.

## Audit log retention interaction

The `audit_log.params_json` column has a retention policy (Phase 4c.2) that purges rows older than `RELAY_AUDIT_LOG_RETENTION_DAYS` (default 90). If `relay re-encrypt --verify-clean k1` shows **only audit_log rows pending**, you have two choices:

### A. Wait for natural purge

Do nothing. After `RELAY_AUDIT_LOG_RETENTION_DAYS` + 1 day, the legacy rows age out via the normal retention piggyback. `--verify-clean` will eventually return 0 without any re-encryption work.

This is simpler when the pending count is small and you're in no hurry.

### B. Explicit re-encrypt

Run `relay re-encrypt --from k1 --to k2 --yes` again. It will re-encrypt any lingering audit_log rows.

This is safer when you need the key retired promptly (e.g. key compromise).

## Troubleshooting

### "Row is encrypted with key_id=... but that key is not in the keyring."

You've removed a key from the keyring while rows still reference it. Add the key back + run `relay re-encrypt` to migrate those rows before removing it again.

If the key is permanently lost (credential leak forced destruction), the affected rows are unrecoverable. Your options:

- **Drop the rows.** If they're not critical, purge them via SQL:
  ```sql
  UPDATE messages SET content = '<purged>' WHERE content LIKE 'enc:<lost_key_id>:%';
  ```
- **Restore from backup.** If you have a pre-loss backup + still possess the old key there, `relay restore` + `relay re-encrypt` + restart.

### "[config] Multiple encryption key sources detected: ..."

Set exactly ONE of `RELAY_ENCRYPTION_KEYRING`, `RELAY_ENCRYPTION_KEYRING_PATH`, `RELAY_ENCRYPTION_KEY`. The error names which variables you currently have set.

### Partial re-encrypt run (exit code 3)

The `relay re-encrypt` command exited with code 3 — one or more tables completed, others aborted mid-run. The `reencryption_progress` table tracks cursor positions per table. Re-run the same command:

```bash
relay re-encrypt --from <same-from> --to <same-to> --yes
```

It will resume each incomplete table from the last-processed row. Completed tables are skipped.

### Backup/restore across key rotation

If you're restoring a backup taken pre-rotation into a post-rotation environment, the destination's keyring **must contain every key_id referenced in the archive**. Add the old key_id(s) to the destination keyring BEFORE running `relay restore`.

After restore, `relay re-encrypt --from <old> --to <current>` to migrate to the current key.

## Reserved signals

### `RELAY_LAZY_REENCRYPT=1`

Currently a reserved signal. WRITE paths already use the current key automatically (no runtime behavior change). Reserved for future opportunistic-upgrade features in v2.1.x+. If set, emits an informational log at startup.

## Dashboard visibility

`GET /api/keyring` (dashboard auth required) returns:

```json
{
  "current": "k2",
  "known_key_ids": ["k1", "k2"],
  "legacy_key_id": "k1",
  "legacy_row_counts": {
    "messages_content": 47,
    "tasks_description": 0,
    "tasks_result": 0,
    "audit_log_params_json": 152,
    "webhook_subscriptions_secret": 0
  }
}
```

Never exposes raw keys. `legacy_row_counts` counts rows still carrying the `enc1:` prefix — helpful for confirming migration completeness.

## References

- `src/encryption.ts` — keyring loader + cipher primitives.
- `src/cli/re-encrypt.ts` — batch re-encrypt implementation.
- `tests/encryption-keyring.test.ts` — 30 regression tests.
- `docs/backup-restore.md` — backup/restore workflow (coordinate with key rotation).
- `README.md` — encryption-at-rest overview.
