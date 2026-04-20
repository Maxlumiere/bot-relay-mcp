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
config.json     ~/.bot-relay/config.json copy (present iff one existed)
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
  }
}
```

- `schema_version` tracks the DB schema. The relay reads this from the `schema_info` table at export time (DB-actual, not a code constant — v2.1 Phase 4c.3). Restore refuses when the archive's schema is **higher** than the target relay (cannot downgrade) and refuses by default when it is **lower** (pass `--force` to override; migration is your responsibility). The authoritative `CURRENT_SCHEMA_VERSION` constant in `src/db.ts` is what the running code expects; `schema_info.version` is what the live DB has.
- `archive_format_version` tracks the tar layout itself, so either can evolve independently.

## File perms

Archives are written with mode `0600` (owner-only) on POSIX filesystems, matching the live `relay.db`. The `~/.bot-relay/backups/` directory is created at `0700`. Safety-backup tarballs produced during a restore inherit the same mode. Native Windows NTFS uses ACLs and ignores POSIX modes — documented.

## Safety guarantees on restore

1. **Safety-backup-before-touch.** The very first step of `relay-restore` is a full `exportRelayState` of the *current* DB to `~/.bot-relay/backups/pre-restore-<iso>.tar.gz`. If that safety backup fails for any reason, the restore aborts and the current DB is never touched.
2. **Daemon-running refusal.** Probes `http://127.0.0.1:<RELAY_HTTP_PORT>/health` with a 1-second timeout. If the daemon answers, the CLI refuses unless `--force` is passed. This is best-effort: it won't catch a stdio-only daemon or one bound to a non-default port.
3. **Schema-version guard.** See the manifest section above.
4. **Integrity check.** After extraction, the archive's `relay.db` is opened read-only and runs `PRAGMA integrity_check`. Anything other than `ok` aborts the restore.
5. **Atomic swap.** The new DB is written to `<DB_PATH>.new`, the old DB + WAL + shm files are removed, then `fs.renameSync` atomically replaces the live path. WAL/shm regenerate on next open.

## What is NOT in the archive

- **No live `process` state** — the relay daemon's in-memory rate-limit buckets, request-context, etc. An active deployment restarts with empty buckets after restore.
- **No OS logs / stderr output** — only the relay's own `audit_log` table (which IS in the DB and therefore IS in the archive).
- **No encryption of the tar itself.** Individual message contents can be encrypted at rest via `RELAY_ENCRYPTION_KEY` (v1.7 feature) and that encryption is preserved byte-for-byte in the snapshot. If you want whole-archive encryption, run `gpg -c` yourself.

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
- [`devlog/031-v2.1-backup-restore.md`](../devlog/031-v2.1-backup-restore.md) — design decisions and assumptions.
