# External CLI agent setup

This doc covers wiring an MCP-aware command-line agent into bot-relay-mcp **without** the agent calling `register_agent` itself. Use it when:

- Your CLI client's safety monitor cancels follow-up tool calls when the same response calls `register_agent` and then immediately uses the returned token. (Codex was the canonical case as of 2026-04-27. Cursor and similar agents may exhibit the same pattern — see the platform notes below.)
- You're provisioning agents from a CI script and want a deterministic, scriptable identity-issuance path without an interactive register/use ceremony.
- You're embedding bot-relay-mcp into a multi-LLM workflow where one operator script provisions every agent and hands plaintext tokens out via env vars.

If your CLI client supports the standard `SessionStart` hook (`hooks/check-relay.sh`) and doesn't trip the safety pattern, you don't need this doc — keep using the hook flow. The env-token pattern below is the universal fallback.

## How it works

1. Operator runs `relay mint-token <name>` outside the agent's process.
2. The CLI generates a random 32-byte token, bcrypt-hashes it (matching `src/auth.ts`'s `BCRYPT_ROUNDS`), and writes the hash directly to the agent row in the active per-instance DB. The plaintext token is printed ONCE to stdout.
3. Operator captures the plaintext token, exports it as `RELAY_AGENT_TOKEN`, exports the agent name as `RELAY_AGENT_NAME`, and launches the CLI client.
4. The agent's first MCP tool call (e.g. `get_messages`) carries the token via the `agent_token` field or `X-Agent-Token` HTTP header. The relay's standard auth path bcrypt-verifies it. The agent never sees `register_agent` in its own trace.

The `agents` row that mint-token creates is byte-identical to the row that `register_agent` would create on first registration. The auth layer cannot tell the two paths apart — both produce an `auth_state='active'`, `agent_status='idle'` row with the same column shape.

## Step-by-step: first mint

```bash
relay mint-token codex \
  --role builder \
  --capabilities build,test,audit \
  --description "Codex dual-audit instance"
```

Output (truncated):

```
✓ Minted token for new agent "codex"

Token (shown ONCE — store it now):

  Xy9...43-char-base64url-token...

Set in your CLI's environment before launching:

  export RELAY_AGENT_NAME=codex
  export RELAY_AGENT_TOKEN=Xy9...token...
```

Then:

```bash
export RELAY_AGENT_NAME=codex
export RELAY_AGENT_TOKEN=Xy9...token...
codex   # or whichever launcher invokes your client
```

## Worked example — Codex

OpenAI's Codex (and any future GPT model with similar guardrails) cancels the second tool call when the same response runs `register_agent({...})` and then `get_messages({agent_token: ...})`. The relay sees the register succeed; the agent sees its own follow-up cancelled and never captures the token.

Workaround:

```bash
# 1. Operator provisions identity outside the Codex process
relay mint-token codex --role builder --capabilities build,audit --json > /tmp/codex.json

# 2. Pull token out of the JSON and export
export RELAY_AGENT_NAME="$(jq -r .name /tmp/codex.json)"
export RELAY_AGENT_TOKEN="$(jq -r .token /tmp/codex.json)"
rm -f /tmp/codex.json   # wipe before launch

# 3. Launch Codex
codex
```

On Codex's first MCP tool call (`mcp__bot-relay__get_messages`), the relay authenticates via env-resolved `RELAY_AGENT_TOKEN`. No `register_agent` in the trace, no safety-monitor cancellation.

## Worked example — Cursor (best-effort)

Cursor's MCP integration follows the same client-side pattern as VS Code's: a single MCP server connection per workspace. As of 2026-05, there is no public reproduction of Cursor cancelling the register-then-use sequence in the same way Codex does. If you encounter `NAME_COLLISION_ACTIVE` on a fresh Cursor session despite no other terminal holding the name, treat that as evidence Cursor's harness has a similar guard and use the env-token pattern as the bootstrap path:

```bash
relay mint-token cursor-agent --role agent --json > /tmp/cursor.json
export RELAY_AGENT_NAME="$(jq -r .name /tmp/cursor.json)"
export RELAY_AGENT_TOKEN="$(jq -r .token /tmp/cursor.json)"
rm -f /tmp/cursor.json
# Then start Cursor; the env vars are picked up by its MCP transport
```

This section is best-effort and untested as of v2.6.0 — please open an issue with reproduction steps if you observe the cancellation pattern in production.

## Storing the token

The plaintext token is shown ONCE. Treat it like any other long-lived credential:

- ❌ Don't commit `.env` files containing the token to git.
- ❌ Don't paste the token into shared Slack / Discord / email channels.
- ✅ Use [`direnv`](https://direnv.net/) + a gitignored `.envrc.local` for per-project token loading.
- ✅ For shared dev machines, prefer ephemeral shell session env over persistent profile entries — close the terminal, the token's gone.
- ✅ macOS operators can park the token in the system keychain via `security add-generic-password -a "$USER" -s bot-relay-codex -w "$RELAY_AGENT_TOKEN"` and reload it on demand with `security find-generic-password -a "$USER" -s bot-relay-codex -w` — handy for long-lived background agents.
- ✅ If exposure is suspected, rotate immediately: `relay mint-token <name> --force` invalidates the prior token (the next MCP call from the agent will fail auth) and prints a fresh one.

The relay never sees the plaintext after the mint. Only the bcrypt hash sits in `agents.token_hash`. A leaked token is the operator's exposure window; the relay cannot retroactively detect or constrain it.

## Rotating an existing agent's token

```bash
relay mint-token codex --force
```

`--force` is required when the agent name already exists. Behavior:

- Token rotates: a fresh 32-byte token is generated, hashed, and written to `agents.token_hash`. The prior token stops authenticating on the next MCP call.
- `session_id` is cleared and `agent_status` is set to `offline`. Any active dashboard reflecting the prior session shows the agent as offline until it re-bootstraps with the new token.
- Caps and role are PRESERVED per the `caps-immutable-after-first-mint` discipline. `--capabilities` and `--role` flags are silently ignored on the rotate path.
- Auth-side fields (`previous_token_hash`, `rotation_grace_expires_at`, `recovery_token_hash`, `revoked_at`) are zeroed. mint-token is a clean reset, not a graceful rotation; for graceful rotation with a grace window, use the `rotate_token` MCP tool instead.

If the agent is currently online (active session reachable on `:3777`), the daemon-running advisory printed to stderr will tell you the prior session will start failing on next call. Restart the agent process with the new `RELAY_AGENT_TOKEN` before its next MCP call.

## When to use this vs. `register_agent`

| Scenario | Path |
|---|---|
| Claude Code SessionStart hook works | Standard hook (no mint-token needed) |
| Standard MCP client without safety monitor | `register_agent` directly from the agent |
| Codex / future hardened LLM clients | `relay mint-token` + env-token export |
| CI script provisioning N agents in parallel | `relay mint-token --json` + env injection per worker |
| Recovering from a lost `RELAY_AGENT_TOKEN` | `relay recover` (preserves messages) + standard register |
| Onboarding a fresh agent with caps reset needed | `relay recover` then `relay mint-token` |

`mint-token` is operator-side only. It is not exposed as an MCP tool — by definition the caller cannot present a valid token, so authentication would have to be filesystem-gated anyway. Filesystem access to the per-instance DB at `~/.bot-relay/instances/<id>/relay.db` (or the legacy `~/.bot-relay/relay.db`) IS the authority. Same trust boundary the daemon itself relies on.

## Audit trail

Every `relay mint-token` invocation writes an entry to the `audit_log` table:

| Field | Value |
|---|---|
| `tool` | `agent.token_minted` |
| `agent_name` | the target agent |
| `source` | `cli` |
| `params_summary` | `operator=<os-username> target=<name> created=true|rotated=true force=<bool>` |
| `params_json` | encrypted blob with operator, target, created, rotated, force, agent_id |
| `success` | true on issuance; false if the call was refused (e.g. existing agent without `--force`) |

The audit row is written for refusals as well, so an attempted credential rotation that didn't go through still leaves a trail.

## Cross-platform notes

- The CLI is pure TypeScript / Node `crypto` / `bcryptjs`. No native binaries beyond Node's own; runs identically on macOS, Linux, and Windows.
- DB path resolution uses `os.homedir()` + `path.join()` everywhere; no POSIX-only shell tricks. The active instance is resolved via `~/.bot-relay/active-instance` (symlink on POSIX, plain file fallback on Windows-non-admin) — same path the daemon reads.
- The token output uses Unicode `✓` and `⚠` glyphs; if your terminal can't render them, pipe through `iconv -t ASCII//TRANSLIT` or use `--json` (ASCII-only).
