# Local agent identity (v2.6.1)

bot-relay-mcp persists each agent's authentication credential in a per-instance file vault under your home directory. This doc covers the model, the bootstrap → persistence → recovery lifecycle, the cross-platform story, and the forward-looking pluggable credential-helper interface.

If you want the short version: **the relay now writes `<instanceDir>/agents/<name>.token` (chmod 0o600 on POSIX) the first time an agent registers, and reads it on every subsequent terminal so spawned agents stay authenticated across restarts with zero operator mediation.**

## The vault model

```
~/.bot-relay/
├── relay.db                          (single-instance legacy)
├── agents/
│   └── <name>.token                  (single-instance vault entry)
└── instances/<id>/
    ├── relay.db                      (per-instance DB)
    └── agents/
        └── <name>.token              (per-instance vault entry)
```

- File: chmod 0o600. Contents: a single line — the plaintext bcrypt-input token. The relay stores only a bcrypt hash in the `agents.token_hash` column; the plaintext lives only in the vault file (and briefly in env when the hook hydrates it).
- Parent directory: chmod 0o700. Inherits the same per-instance scope as the relay DB so no split-brain: when the daemon serves a per-instance DB, the vault sits next to it.
- Path resolution mirrors `src/instance.ts:resolveInstanceDbPath()` — a byte-identical bash function lives in `hooks/check-relay.sh`, `hooks/post-tool-use-check.sh`, `hooks/stop-check.sh`, and `scripts/migrate-existing-tokens-to-vault.sh`. Drift would surface as a regression in `tests/v2-6-1-token-store.test.ts`.

## Bootstrap → persistence → recovery

| Scenario | What happens |
|---|---|
| **First spawn** of `gaming-build` | SessionStart hook reads vault → miss → calls `register_agent` over HTTP → relay mints fresh token + returns in response → hook captures with `grep -oE '"agent_token":"[^"]*"'` → writes vault (atomic tmp+rename, chmod 0600) → exports `RELAY_AGENT_TOKEN`. First MCP call authenticates. |
| **Re-spawn** of `gaming-build` | Hook reads vault → hit → exports. **No re-register.** Same identity, same mailbox, same session. |
| **Lost / corrupted vault file** | Hook reads vault → miss / shape-validation rejects malformed content → calls `register_agent` → daemon refuses with `NAME_COLLISION_ACTIVE` (the row exists from the first registration). Hook stderr-prints "Bootstrap failed for `<name>` — run `relay recover <name>` and re-spawn." Existing recovery flow handles it. |
| **Token revoked elsewhere** | Hook reads stale vault file, exports → first MCP call fails `AUTH_FAILED`. The health_check pre-probe in `hooks/check-relay.sh` surfaces actionable stderr; operator runs `relay recover <name>` (which deletes the vault file) and re-spawns. |
| **Recovery flow** | `relay recover <name>` deletes the row + scrubs the vault file. The next register_agent (whether triggered by SessionStart or a manual MCP call) writes a fresh vault entry. Operators no longer need to manually `export RELAY_AGENT_TOKEN=...` after recovery. |

## Cross-platform story

bot-relay-mcp ships every feature at macOS / Linux / Windows parity from first release per [`memory/feedback_cross_platform_parity.md`](#) (project-internal). The vault is no exception:

| Platform | Implementation | Owner-only enforcement |
|---|---|---|
| **macOS** | POSIX file (chmod 0o600), parent dir 0o700. Created by `FileTokenStore.write()` (TS) and the bash mirror in the SessionStart hook. | Verified by tests. |
| **Linux** | Identical to macOS. | Verified by tests. |
| **Windows** | NTFS file at `%USERPROFILE%\.bot-relay\instances\<id>\agents\<name>.token`. The `chmod` calls are best-effort no-ops. The parent directory under `%USERPROFILE%` already inherits a user-restricted ACL from the Windows profile defaults; same threat model as `~/.aws/credentials`, `~/.ssh/id_rsa`, `~/.config/gh/hosts.yml` on POSIX. | Profile-dir defaults. v2.9+ Windows Credential Manager helper will move beyond profile-dir defaults. |

Test coverage: `tests/v2-6-1-token-store.test.ts` runs the FileTokenStore TS implementation against a tmp directory and asserts on file permissions (POSIX-only assertion). Windows ACL is a documented assumption — bot-relay-mcp does not currently shell out to `icacls` to verify.

## Pluggable credential helpers (forward-looking)

The `TokenStore` interface in `src/token-store.ts` is the same shape used by `docker credential-helpers`, `git credential helper`, `gh auth`, `aws configure`, and `kubectl config`. v2.6.1 ships only the `FileTokenStore` default impl. Future helpers plug in without breaking changes:

- **macOS Keychain** (v2.9+ candidate) — `KeychainTokenStore` shells out to `security add-generic-password` / `security find-generic-password`. Tokens encrypted at rest by macOS, unlocked per-user.
- **Windows Credential Manager** (v2.9+ candidate) — `WindowsCredentialTokenStore` via `cmdkey` + `wincred` Node binding.
- **libsecret / GNOME Keyring** (v2.9+ candidate) — `LibsecretTokenStore` for Linux desktop sessions.
- **1Password** / **Vault** (v3.0+ candidate) — operator-managed centralized credential stores. Likely paid-tier (Tether Cloud per `project_tether_product_strategy.md`) since they require third-party API keys.

The strict free / paid line per the Tether roadmap: anything that requires a third-party API or a network round-trip is **not** in this repo. `FileTokenStore` is local, free, and bundled.

## Migration from env-baked tokens

If you had `RELAY_AGENT_TOKEN` baked into `~/.zshrc`, `~/.bashrc`, `~/.envrc`, or a shell-profile fragment, run the one-shot migration once:

```bash
RELAY_AGENT_NAME=<your-agent-name> RELAY_AGENT_TOKEN=<your-token> ./scripts/migrate-existing-tokens-to-vault.sh
```

This writes the env-resolved token to the vault file. After it succeeds, you can remove the env line from your shell config — the SessionStart hook will hydrate `RELAY_AGENT_TOKEN` from disk on every new terminal.

The env var is still honored when set; the vault is the fallback. So removing the line is optional cleanup, not a forced migration.

## Operator hygiene

- ❌ Don't include `~/.bot-relay/` in cloud-synced backup destinations (Dropbox, iCloud Drive, Google Drive, Backblaze, etc.) without an exclusion rule. The token is plaintext in the vault file; cloud-sync providers do not promise per-file ACL preservation, and the file may end up readable by your sync service or by other devices logged into the same account.
- ✅ Exclude `~/.bot-relay/` (or just `~/.bot-relay/agents/`) from your sync tool. Same hygiene as `~/.aws/credentials` or `~/.ssh/id_rsa`.
- ✅ Rotate via `relay mint-token <name> --force` (v2.6.0) if exposure is suspected. The next MCP call from the agent will fail auth; the SessionStart hook will refresh the vault on the subsequent register.
- ✅ For shared dev machines, prefer per-user OS-level isolation (separate user accounts) over relying on `chmod 0600` alone. Same threat boundary as every other credential under `$HOME`.
- ✅ When wiping a machine, `rm -rf ~/.bot-relay/` is sufficient — every credential is local-machine only. Federation tokens (v2.3+ when shipped) use a separate mechanism not covered here.

## Audit trail

Every credential issuance writes to `audit_log` (encrypted at rest when `RELAY_ENCRYPTION_KEY` is set):

| Source | tool | params_summary |
|---|---|---|
| `register_agent` (first mint via hook) | `register_agent` | `from_ip=<source> agent_name=<name>` |
| `relay mint-token <name>` | `agent.token_minted` | `operator=<os-username> target=<name> created=true|rotated=true force=<bool>` |
| `rotate_token` MCP call | `rotate_token` | `agent_name=<name>` |
| `revoke_token` MCP call | `revoke_token` | `agent_name=<name> issue_recovery=<bool>` |
| `relay recover <name>` | `recovery.cli` | `operator=<os-username> target=<name>` |

Vault writes themselves are not audited (no DB row touched on a write that happens AFTER the daemon's audit boundary). The DB's `audit_log` is the authoritative trail; vault writes are a side effect of the daemon-issued token already audited.

## Related docs

- [`docs/agents/external-cli-setup.md`](./external-cli-setup.md) — `relay mint-token` for external CLI agents (Codex 5.5, Cursor) whose safety monitors block the `register_agent` → use-returned-token sequence inside a single response. Different flow; same vault.
- [`docs/token-lifecycle.md`](../token-lifecycle.md) — `rotate_token` / `revoke_token` MCP tools + the v2.1 Phase 4b.1 v2 recovery flow.
- [`SECURITY.md`](../../SECURITY.md) — local-machine threat model, including the "Local agent token storage" subsection added in v2.6.1.
