# relay CLI (v2.1)

One unified entry point with six subcommands. Invoke as `relay <subcommand>`.

## Migration notes (v2.1 Phase 4h)

- `bin/relay-backup` → `relay backup` (same flags, same exit-code contract).
- `bin/relay-restore` → `relay restore` (same flags, same exit-code contract).
- The standalone bins were removed from `package.json "bin"` when `relay` was added. Update any shell scripts that invoked the old names.

## `relay doctor`

Runs a battery of diagnostic checks against your local install. Each check prints `PASS`, `WARN`, or `FAIL`. Exit code is 0 iff zero `FAIL`s (warns are advisory).

```
$ relay doctor
=== relay doctor ===
  PASS  config.json: valid (~/.bot-relay/config.json)
  PASS  schema_info: version=1 (matches CURRENT_SCHEMA_VERSION)
  PASS  dir perms (~/.bot-relay): 0700
  PASS  db perms (~/.bot-relay/relay.db): 0600
  PASS  disk space: 84201 MB free on ~/.bot-relay
  PASS  daemon /health: responding on http://127.0.0.1:3777 (version=2.0.2, protocol_version=2.1.0)
  PASS  Claude Code hooks: SessionStart + PostToolUse + Stop all configured

Result: healthy
```

Checks: config.json shape + validation; `schema_info.version` matches `CURRENT_SCHEMA_VERSION`; DB + parent dir perms; disk space >100MB; optional `/health` probe; SessionStart/PostToolUse/Stop hooks in `~/.claude/settings.json`.

## `relay init`

First-run interactive setup. Writes `~/.bot-relay/config.json` (mode 0600) and creates `~/.bot-relay/` (mode 0700). Prints a ready-to-paste `~/.claude.json` MCP server entry.

```
$ relay init
=== relay init (interactive) ===

Transport (stdio/http/both) [both]:
HTTP port [3777]:
HTTP secret (ENTER = generate random 32-byte base64):
Install Claude Code hooks now? (y/N):

✓ Wrote ~/.bot-relay/config.json (mode 0600)
✓ Generated HTTP secret (32 bytes, base64url)
...
```

Non-interactive: `relay init --yes` accepts all defaults and generates a random secret.

Flags:
- `--yes`, `-y` — accept defaults, skip prompts
- `--force` — overwrite an existing config.json
- `--install-hooks` — also install Claude Code hooks to `~/.claude/settings.json`
- `--port N` — set HTTP port (default 3777)
- `--transport stdio|http|both` — default `both`
- `--secret STRING` — provide an explicit HTTP secret (random if omitted)

Refuses when `~/.bot-relay/config.json` already exists unless `--force`.

## `relay test`

Fresh-install self-check. Spawns an isolated relay on a throwaway port + DB, runs a minimal agent-register → send_message → receive round-trip, tears down. Never touches your live `~/.bot-relay/`. Under 2 seconds.

```
$ relay test
=== relay test ===
  PASS  health: version=2.0.2 protocol_version=2.1.0
  PASS  register_agent a: ok
  PASS  register_agent b: ok
  PASS  send_message: id=a1b2c3d4
  PASS  get_messages: delivered: "ping"

Result: PASS
```

For the full 36-tool + CLI battery, use `scripts/smoke-25-tools.sh` (script name is historical — it now exercises all 36 tools; v2.1 Phase 5a, runs in the pre-publish gate).

## `relay generate-hooks`

Emits Claude Code hook JSON for `~/.claude/settings.json`. Two modes:

Default (fragment — merge into an existing settings.json):

```
$ relay generate-hooks
{
  "SessionStart": [ ... ],
  "PostToolUse": [ ... ],
  "Stop": [ ... ]
}
```

`--full` (complete settings.json template — overwrite target):

```
$ relay generate-hooks --full
{ "hooks": { ... } }
```

Paths containing spaces are single-quoted inside the JSON string value per the path-with-spaces discipline (see `docs/post-tool-use-hook.md`).

## `relay backup [--output PATH]`

Snapshot the DB + optional config into a `tar.gz` archive. Safe while the daemon is running (consistent `VACUUM INTO`). Archive is chmod 0600.

Default destination: `~/.bot-relay/backups/relay-backup-<iso>.tar.gz`.

```
$ relay backup
Backup written: ~/.bot-relay/backups/relay-backup-2026-04-18T09-00-00Z.tar.gz (4866 bytes, schema_version=1)
```

Full docs: [`docs/backup-restore.md`](./backup-restore.md).

## `relay restore PATH [--force]`

Restore from a `tar.gz` archive. Safety-backs-up the current DB first; refuses if the daemon appears to be running (`/health` probe) and if the archive's `schema_version` mismatches — `--force` overrides both.

```
$ relay restore ~/.bot-relay/backups/relay-backup-*.tar.gz
Restore complete. schema_version=1, previous DB saved to: ~/.bot-relay/backups/pre-restore-<iso>.tar.gz
```

## `relay help`

Prints the subcommand list. `relay <sub> --help` prints per-subcommand help.

## Related

- `src/cli/*` — per-subcommand implementations
- `bin/relay` — unified entry point (dispatcher)
- `tests/v2-1-cli-tooling.test.ts` — 12 integration tests
