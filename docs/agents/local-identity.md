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
- Path resolution mirrors `src/instance.ts:resolveInstanceDbPath()`. v2.6.1 R1 consolidated the bash mirrors into a single sourced file at `hooks/_vault-helpers.sh` — `hooks/check-relay.sh`, `hooks/post-tool-use-check.sh`, `hooks/stop-check.sh`, and `scripts/migrate-existing-tokens-to-vault.sh` all `source` it. The same file is sourced by `tests/v2-6-1-token-store.test.ts`, so drift between bash and TS surfaces as a real test failure rather than an inline-copy hide-out.

## Bootstrap → persistence → recovery

The vault is consumed at TWO independent layers — each platform-correct on its own, together making spawn-to-ready zero-touch:

1. **Launching shell hydration (macOS / Linux as of v2.6.1).** When `bin/spawn-agent.sh` (macOS) or the Linux terminal driver assembles the inner-shell command, it embeds a single-line bash snippet that reads the vault file into `RELAY_AGENT_TOKEN` BEFORE `exec claude`. Because env propagates parent → child at fork, the spawned `claude` (and its stdio MCP server) inherits the token from the moment it starts. The vault path is pre-resolved to an absolute literal on the parent side; the snippet only needs `head -n 1`, `tr`, and `grep -E` at runtime.
2. **Daemon-side fallback (STDIO transport only).** `src/server.ts:resolveToken` falls through to a sync vault read when env / args / header all return empty AND the request is on the stdio MCP server transport (`currentContext().transport === "stdio"`). This is the load-bearing path on Windows wt/powershell/cmd (v2.6.1) and on a bare manual `claude` start with no hook: the very first MCP call still authenticates because the stdio server consults the same vault file the hook wrote. Single-line file, microseconds. **HTTP transport never reads the vault** — the R1 implementation honored `args.agent_name` here, which let any HTTP caller name an agent and the daemon would obligingly read that name's vault file (auth oracle, codex REJECT msg d1fbbdde, 2026-05-05). R2 gates the fallback on stdio only because the stdio process identity IS the agent (single agent per process, RELAY_AGENT_NAME set at fork). HTTP clients must always present an explicit token.

Together the two layers cover every operational scenario:

| Scenario | What happens |
|---|---|
| **First spawn via `spawn_agent` MCP tool** | `handleSpawnAgent` registers the new agent server-side, captures the plaintext token, writes the vault file (atomic tmp+rename, chmod 0o600), then dispatches the driver. The launcher's prelude (macOS / Linux) reads the vault into `RELAY_AGENT_TOKEN` before `exec claude`. First MCP call authenticates against the env-supplied token. |
| **First spawn via direct `bin/spawn-agent.sh` invocation (no pre-mint)** | Vault is empty pre-spawn. Launcher prelude reads → miss → `claude` starts with empty `RELAY_AGENT_TOKEN`. SessionStart hook fires inside the new claude, calls `register_agent` over HTTP, captures the response token, writes the vault. The already-running stdio MCP server's env is unchanged BUT its `resolveToken` falls through to the stdio-side vault read on every call → first MCP call authenticates. (This is the gaming-build regression closed in v2.6.1 R1; R2 gated the fallback to the stdio transport only.) |
| **Re-spawn of an existing agent (terminal closed + reopened)** | Vault has the token. Launcher prelude (macOS / Linux) reads → hit → exports. No re-registration. Same identity, same mailbox. On Windows the stdio-only daemon-side fallback authenticates the same way. |
| **Bare `claude` start with no spawn-agent.sh / hook (stdio MCP)** | No env, no launcher prelude. First MCP call → `resolveToken` sees env empty → confirms transport is stdio → falls through to vault → reads → authenticates. (Pure FIX 2 v2 path; works on every platform.) |
| **Bare HTTP client (curl / SDK over HTTP transport)** | The vault is **NOT** consulted. HTTP clients must always present an explicit token through `agent_token` arg, `X-Agent-Token` header, or `RELAY_AGENT_TOKEN` env. The R2 transport gate refuses vault fallback over HTTP because args.agent_name from a network caller is untrusted (would otherwise be an auth oracle). |
| **Lost / corrupted vault file** | Daemon-side fallback returns null on shape-validation reject; first MCP call fails `AUTH_FAILED`; hook (if running) detects via `health_check` pre-probe and surfaces actionable stderr pointing at `relay recover <name>`. |
| **Token revoked elsewhere** | Vault holds the stale token; `resolveToken` returns it; daemon's bcrypt check fails → `AUTH_FAILED`. Operator runs `relay recover <name>` (which deletes the vault file). Next `register_agent` produces a fresh vault entry. |
| **Recovery flow** | `relay recover <name>` deletes the row + scrubs the vault file. The next `register_agent` (via SessionStart hook or manual MCP) writes a fresh vault entry. Operators no longer need to manually `export RELAY_AGENT_TOKEN=...`. |

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
