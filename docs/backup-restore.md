# Backup & Restore (v2.1)

The relay keeps everything — registered agents, messages, tasks, issued tokens, channels, webhook subscriptions, audit log — inside a single SQLite database at `~/.bot-relay/relay.db`. A v2.1 relay ships two CLIs for disaster recovery:

- `relay-backup` — creates a consistent `tar.gz` snapshot of the DB, the optional `config.json`, and a machine-readable `manifest.json`.
- `relay-restore` — replaces the current DB with the contents of an archive, always creating a safety backup of the current state first.

## When to run

- **Before any risky operation:** manual schema experimentation, major upgrade, moving to another machine, or wiping the WAL because something looks off.
- **On a cron / systemd timer for production setups.** The CLI is safe to run while the daemon is up — `VACUUM INTO` produces a consistent point-in-time snapshot without blocking writers.
- **Right before an npm upgrade or environment migration.**

## Usage

### Back up

```bash
# Default destination: ~/.bot-relay/backups/relay-backup-<iso>.tar.gz
relay backup

# Custom destination (parent directory must already exist)
relay backup --output ~/.bot-relay/backups/relay-2026-04-18.tar.gz
```

> The `--output` path's parent directory is NOT auto-created. `mkdir -p <parent>` first if you're pointing at a non-default location. Phase 4h absorbed the standalone `relay-backup` / `relay-restore` bins into the unified `relay backup` / `relay restore` subcommands.

Exit 0 on success, 1 on failure. One-line human-readable summary on stdout (archive path + byte count + schema_version).

### Restore

```bash
# Basic (will refuse if the daemon is running)
relay-restore ~/.bot-relay/backups/relay-backup-2026-04-18T09-00-00Z.tar.gz

# Bypass the daemon-running guard AND the "older archive schema" guard
relay-restore ... --force
```

Exit 0 on success, 1 on failure. On success, the stdout line tells you where the pre-restore safety backup landed — save that path if you want to roll back.

## How it works

### Snapshot mechanism

Both CLIs invoke `VACUUM INTO 'path'` through the shared DB connection. That's plain SQL — it runs identically on the native (`better-sqlite3`) driver and the optional wasm (`sql.js`) driver, and produces a consistent point-in-time SQLite file on disk. No driver branching.

### Archive layout

A relay archive is a gzip-compressed tar with up to three files at the root:

```
relay.db        SQLite snapshot (always present)
manifest.json   archive metadata (always present)
config.json     the live config, its secrets REDACTED (present iff one existed; see below)
```

### Manifest format

```json
{
  "schema_version": 1,
  "archive_format_version": 1,
  "created_at": "2026-04-18T09:00:00.000Z",
  "relay_version": "2.0.2",
  "row_counts": {
    "agents": 12,
    "messages": 143,
    "tasks": 28,
    "channels": 3,
    "channel_members": 9,
    "channel_messages": 56,
    "webhook_subscriptions": 2,
    "webhook_delivery_log": 41,
    "agent_capabilities": 35,
    "audit_log": 8192
  },
  "encryption": {
    "keys": [{ "key_id": "k1", "rows": 171, "fingerprint": "3f9c0e5a1b7d2c4e8a6f0b1d3e5c7a9b" }]
  },
  "plaintext_secrets": { "webhook_subscriptions.secret": 0 },
  "config": { "redacted": ["dashboard_secret", "http_secret"], "dropped": [] }
}
```

- `schema_version` tracks the DB schema. The relay reads this from the `schema_info` table at export time (DB-actual, not a code constant — v2.1 Phase 4c.3). Restore refuses when the archive's schema is **higher** than the target relay (cannot downgrade) and refuses by default when it is **lower** (pass `--force` to override; migration is your responsibility). The authoritative `CURRENT_SCHEMA_VERSION` constant in `src/db.ts` is what the running code expects; `schema_info.version` is what the live DB has.
- `archive_format_version` tracks the tar layout itself, so either can evolve independently.
- `encryption.keys`: every key id the DB's ciphertext needs, its row count, and a **fingerprint** of the key: HMAC-SHA256(key, `"bot-relay backup key fingerprint v1"`), truncated to 128 bits. It identifies the key without revealing it. `fingerprint` is `null` when the backing-up relay's keyring did not hold that key.
- `plaintext_secrets`: the secrets the DB holds in PLAINTEXT (see "Secrets" below).
- `config`: what the archived `config.json` had redacted and dropped.
- Archives made before these three fields existed still restore (see "Safety guarantees").

## Secrets: what an archive does and does not carry

**No archive contains an encryption key, a raw token or the mint secret.**

- **Encryption keys are never archived.** Rows encrypted at rest stay encrypted in the snapshot, and the manifest names the key id(s) they need. **Keep your keyring** (`RELAY_ENCRYPTION_KEYRING` or `RELAY_ENCRYPTION_KEYRING_PATH`) somewhere other than the archive: without it, an archive with encrypted rows cannot be restored. `relay backup` says which key ids an archive needs, on stderr.
- **The archived `config.json` is not a copy of the file.** Each known config field is either copied as it is (its value is not validated or inspected; a nested value is copied whole) or, for a credential, set to `null`: `http_secret`, `http_secrets_previous`, `dashboard_secret` and `dashboard_push_secret` (each is a shared bearer credential). A key the relay does not know is left out. Both lists are named, never valued, in the manifest and in the result. Restore does not read the archived `config.json`, so this costs a restore nothing.
- **The mint secret** (`secrets/mint.secret`) is not one of the three archive members.
- **Token hashes ARE in the snapshot, and are not tokens.** The DB stores bcrypt hashes of agent and recovery tokens, never the tokens. A token is 32 random bytes (256 bits, `crypto.randomBytes(32)` in `src/auth.ts`), so its hash cannot be reversed by guessing. A future token that is NOT random would change this.
- **No-key mode: the webhook secrets ARE in the archive, in plaintext.** Without an encryption keyring, the relay stores a webhook's HMAC secret as given, so the snapshot carries it. `relay backup` then states how many, loudly: on stderr, in the result (`plaintext_secrets`, `warnings`) and in the manifest. Only a well-formed ciphertext counts as encrypted, so a secret that merely starts with `enc:` is counted as plaintext; a count that cannot be read is `null`, stated as unverifiable. The remedy: configure a keyring and re-register the webhooks, so their secrets are encrypted at rest.

## File perms

Archives are owner-only, with one stated exception on Windows (below). On POSIX they are written with mode `0600`, matching the live `relay.db`, and the `~/.bot-relay/backups/` directory is created at `0700`. On Windows, the archive's ACL is restricted to its owner (and SYSTEM), as the live DB and the mint secret are. **The exception:** if that restriction cannot be applied, the archive is still written and keeps the ACL it inherited from its directory, and the result's `warnings` and stderr say so. Safety-backup archives made during a restore get the same treatment.

## Safety guarantees on restore

In this order:

1. **Daemon-running refusal.** Probes `http://127.0.0.1:<RELAY_HTTP_PORT>/health` with a 1-second timeout. If the daemon answers, the CLI refuses unless `--force` is passed. This is best-effort: it won't catch a stdio-only daemon or one bound to a non-default port.
2. **Validation, entirely in a private staging directory, before anything live is touched.** A refused archive leaves no safety backup and the live DB and its connection unchanged. Each check refuses by name:
   - the relay reads the archive itself (only the three members; links, other names, duplicates and malformed archives are refused);
   - the required members and the manifest;
   - the schema-version guard (see the manifest section above);
   - `PRAGMA integrity_check` on the staged `relay.db`, opened read-only;
   - **the keyring can read it.** The key ids come from the staged DB's own ciphertext, not from the manifest alone. Each must be in this relay's keyring; its key must match the manifest's fingerprint, when the manifest has one; and one staged row under it must decrypt. The decrypt check also covers an archive made before fingerprints existed.
3. **Safety backup.** A full `exportRelayState` of the *current* DB to `~/.bot-relay/backups/pre-restore-<iso>.tar.gz`. If it fails, the restore aborts and the current DB is never touched.
4. **Atomic swap.** The new DB is written to `<DB_PATH>.new`, then `fs.renameSync` atomically replaces the live path, and the old WAL and shm files are removed. They regenerate on next open.

## What is NOT in the archive

- **No live `process` state** — the relay daemon's in-memory rate-limit buckets, request-context, etc. An active deployment restarts with empty buckets after restore.
- **No OS logs / stderr output** — only the relay's own `audit_log` table (which IS in the DB and therefore IS in the archive).
- **No encryption key, raw token or mint secret.** See "Secrets" above.
- **No encryption of the tar itself.** Content encrypted at rest (an encryption keyring) is preserved byte-for-byte in the snapshot. If you want whole-archive encryption, run `gpg -c` yourself.

## Dependencies

- `tar` must be on `PATH`. macOS + modern Linux + Windows 10 1803+ all ship tar by default.
- `better-sqlite3` is always present (hard dependency of the relay).

## Common pitfalls

**"Relay daemon appears to be running" when it isn't.** Check `RELAY_HTTP_PORT` — if you changed the port, export the same value before running restore, or pass `--force` once you've confirmed no daemon is up. The probe is best-effort, not authoritative.

**Schema downgrade refused.** Don't override with `--force` unless you know exactly which tables/columns changed between the archive's `schema_version` and the running relay. Data loss is the default outcome of a forced downgrade without a migration plan.

**Safety-backup succeeded but restore failed.** Your current DB is untouched (the atomic swap only happens after every guard passes). The path of the safety backup is printed to stdout — keep it around if you're uncertain.

**Restore replaced the DB but agents don't reconnect.** Every `register_agent` rotates `session_id`, so mid-session handoff behavior after a restore is the same as a fresh terminal open. That's by design (v2.0 session-aware reads).

## Related

- [`src/backup.ts`](../src/backup.ts) — implementation.
- [`bin/relay`](../bin/relay) — unified CLI entry point. `relay backup` and `relay restore` are the Phase 4h-absorbed subcommands of the former standalone `bin/relay-backup` / `bin/relay-restore` (same flags, same exit-code contract).
- [`tests/backup.test.ts`](../tests/backup.test.ts) + [`tests/backup-wasm.test.ts`](../tests/backup-wasm.test.ts) — 9 integration tests across native + wasm drivers.
