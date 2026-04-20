# Security Policy

**Project:** bot-relay-mcp
**Last updated:** 2026-04-19 (v2.1.0)

This document describes the threat model bot-relay-mcp defends against, the mechanisms that enforce those defenses, and — crucially — what the project does NOT protect. It closes with the vulnerability-disclosure process.

---

## Threat model

bot-relay-mcp assumes **a single trust boundary**: the operator who owns the machine running the relay daemon. Every agent connected to the relay is either started by that operator or granted access through an authenticated handoff. The relay is designed to be safe against:

- Compromised agent tokens — revoke + rotate without losing history.
- DB exfiltration (backup tarballs, bit-rot mitigation) — sensitive columns are encrypted at rest.
- Dashboard/HTTP request origin spoofing — auth gate, Host-header allowlist, DNS-rebinding defense.
- Unregistered or revoked agents trying to authenticate — dispatcher-level auth_state gate.
- Privilege escalation via legacy-grace config during migration — capability checks fire before grace grants.

It is NOT designed to be safe against:

- Host-level compromise (any actor with root on the machine can read the keyring, the DB, and the process memory).
- Multi-tenant relays — a single daemon serves one operator's agents. Federation (v2.5) will introduce a different trust model.
- Cross-machine agent relays — the current HTTP mode is loopback-first. Exposing the relay on the public internet is possible but requires the operator to set `RELAY_HTTP_SECRET` + `RELAY_DASHBOARD_SECRET` + `RELAY_TRUSTED_PROXIES` correctly.

---

## Per-agent token model (v1.7+)

Every agent registered via `register_agent` receives a 32-byte base64url token shown ONCE in the response. The relay stores only a bcrypt hash (`agents.token_hash`) — the plaintext is discarded after the response is written.

Subsequent tool calls must present the token via one of three channels (in precedence order):

1. `agent_token` argument in the tool input.
2. `X-Agent-Token` HTTP header.
3. `RELAY_AGENT_TOKEN` environment variable (stdio flow).

A capability list is set at first registration and is **immutable** (v1.7.1 rule). Changing capabilities requires `unregister_agent` + fresh `register_agent`.

See `src/auth.ts` + `tests/auth.test.ts`.

---

## Encryption at rest (Phases 1.7 / 4p / 4b.3)

Sensitive columns are encrypted with AES-256-GCM under a keyring (v2.1 Phase 4b.3):

| Table | Column | Encrypted since |
|---|---|---|
| `messages` | `content` | v1.7 |
| `tasks` | `description`, `result` | v1.7 |
| `audit_log` | `params_json` | v1.7 |
| `webhook_subscriptions` | `secret` | v2.1 Phase 4p |

Ciphertext formats (both stable forever):
- `enc:<key_id>:<iv>:<payload>` — v2 versioned. Emitted by every `encryptContent` call after v2.1 Phase 4b.3.
- `enc1:<iv>:<payload>` — legacy v1 from Phase 4p. Readable forever; never written post-4b.3.

When no keyring is configured, content is stored plaintext. Operators who need at-rest encryption MUST set one of `RELAY_ENCRYPTION_KEYRING` (JSON), `RELAY_ENCRYPTION_KEYRING_PATH` (file), or the deprecated `RELAY_ENCRYPTION_KEY` (single-key, auto-wrapped).

See `src/encryption.ts`, `docs/key-rotation.md`, `tests/encryption-keyring.test.ts`.

---

## `auth_state` state machine (Phase 4b.1 v2)

Every agent row carries an explicit `auth_state`:

- `active` — normal. Token hash verifies on every tool call.
- `legacy_bootstrap` — pre-v1.7 row awaiting one-shot migration via `register_agent`.
- `revoked` — terminal. `token_hash` preserved for forensics but no longer authenticates. Admin must `unregister_agent` + fresh register to reuse the name.
- `recovery_pending` — admin issued a one-time `recovery_token`; target re-registers with it to return to `active`.
- `rotation_grace` — managed agent in a rotation window; both old and new tokens validate until expiry.

Transitions are CAS-gated at each write site. Revoke never nulls `token_hash` (forensic integrity). Recovery requires the admin-issued bcrypt-verified secret (prevents name-race re-registration).

See `src/auth.ts::authenticateAgent`, `src/db.ts::revokeAgentToken`, `tests/phase-4b-1-v2.test.ts`.

---

## Key rotation (Phase 4b.3)

Operators can rotate the at-rest encryption key without downtime:

1. Add the new key to the keyring (both keys present, `current` still points to old).
2. Flip `current` to the new key + restart. New writes use the new key.
3. `relay re-encrypt --from <old> --to <new> --yes` — batch-migrates every encrypted row with CAS-on-original-ciphertext safety against concurrent daemon writes.
4. `relay re-encrypt --verify-clean <old>` — exit 0 confirms no rows still reference the old key.
5. Remove the old key from the keyring + restart.

Resumable via `reencryption_progress` table if the CLI is interrupted.

See `docs/key-rotation.md` for the full runbook.

---

## Recovery flows (Phase 4o + Phase 4b.1 v2)

Two paths for a locked-out agent:

**`relay recover <agent-name>`** (filesystem-gated) — the operator has FS access to `~/.bot-relay/relay.db` but lost the agent's token. The CLI DELETEs the agent + capability rows in a transaction, preserving messages + tasks. Authorization = FS access to the DB file (same trust boundary the daemon itself relies on). NOT an MCP tool — the caller by definition cannot authenticate.

**`revoke_token(issue_recovery=true)` + register_agent(recovery_token=...)`** (admin-initiated) — admin revokes the target with a one-time bcrypt-hashed recovery_token returned on the revoke response. Target's operator re-registers with that token; state flips from `recovery_pending` to `active`. Recovery_token_hash cleared on first successful use.

Out-of-band token handoff is the human authorization moment. Recovery tokens currently have no TTL (deferred to v2.1.1 if demand surfaces).

---

## DNS-rebinding defense (Phase 4e)

Webhook targets are re-validated at fire time: `validateWebhookUrl` re-resolves the hostname and re-runs the SSRF check against every resolved IP. If a previously-safe hostname now resolves to a private IP or a cloud-metadata address, the webhook is terminally refused (no retry — feeding an attacker controlling DNS wastes bandwidth).

The dashboard enforces a Host-header allowlist (default loopback-hostname-only, override via `RELAY_DASHBOARD_HOSTS`) so an external attacker can't use DNS rebinding to reach `127.0.0.1:3777` through a browser.

See `src/url-safety.ts`, `src/dashboard.ts`, `src/transport/http.ts`.

---

## Open-bind defense (Phase 4n)

Binding to a non-loopback interface (`0.0.0.0`, `::`) without `RELAY_HTTP_SECRET` is refused at startup. Operators who genuinely want a public-facing relay (e.g. in a private VPC) can set `RELAY_ALLOW_OPEN_PUBLIC=1`; the relay logs a DANGER line every startup as a reminder.

---

## Trusted-proxy XFF handling (v1.6)

X-Forwarded-For headers are **ignored by default**. Only requests from CIDRs listed in `RELAY_TRUSTED_PROXIES` have their XFF parsed for the source IP. This prevents IP-spoofing by external clients that wrap requests in crafted headers.

Rate-limit + audit attribution key on the resolved source IP. With no trusted proxies set, the source IP is the direct peer — correct for loopback or private deployments.

See `src/request-context.ts`, `tests/trusted-proxy.test.ts`.

---

## Centralized deployment trust model (Phase 7r)

The single-machine default (stdio transport, per-terminal process) assumes the operator's laptop is the trust boundary. The HTTP transport (v1.2+) supports a different deployment pattern: one bot-relay-mcp hub on a VPS, many thin MCP clients connecting from laptops / dev boxes / CI / family devices. This model is shipped as `relay pair <hub-url>` in Phase 7r. See [`docs/multi-machine-deployment.md`](docs/multi-machine-deployment.md) for the full operator runbook.

Trust-model consequences you must accept before deploying a centralized hub:

- **The hub operator can read plaintext messages in RAM.** Even with `RELAY_ENCRYPTION_KEY` set, decryption happens server-side for routing decisions. On-disk encryption protects the DB file, backup tarballs, and raw `sqlite3` access — NOT the hub operator. End-to-end encryption where the hub only sees ciphertext is a v3+ scope item (see `docs/federation-envelope-v1.md` §3.1).
- **The hub is a single point of failure for cross-machine coordination.** If the hub drops, agents on different machines cannot `send_message`, post tasks, or broadcast to each other until it comes back. Agents on the SAME machine still work via local stdio if that machine's MCP config includes a stdio entry.
- **Per-agent tokens are issued by the hub, not the client.** If the hub is compromised, every client's token is compromised. Rotation is via `relay recover <name>` on the hub + re-run `relay pair` on each client.
- **Recommended deployments:** families and small trusted teams (shared ownership of the hub), personal multi-machine setups (you own the hub + every client), CI + dev coordination within one team.
- **NOT recommended:** mutually distrustful parties sharing a single hub, compliance-bound workloads where in-RAM access by the operator is a policy violation, or adversarial environments (the hub operator is in the trust boundary by design). Wait for v2.3 hub federation + v3 E2E.
- **Operational parity:** `relay backup`, `relay re-encrypt`, key rotation, audit log retention, and `relay doctor` (with `--remote <url>`) all work identically in centralized deployments as in single-machine ones. No new operator skillset required.

---

## What bot-relay-mcp does NOT protect against

- **Host-level compromise.** An actor with root on the machine can read the keyring file, the DB, the process memory (plaintext tokens during verify), and `/tmp` spawn scripts. Move to a different trust boundary (different host, container, KMS) if this matters to you.
- **Pre-v1.7 agents migrating without operator action.** Phase 2b auto-migrates on plain `register_agent` — if the operator never calls register, legacy rows stay at `legacy_bootstrap` indefinitely. Set `RELAY_ALLOW_LEGACY=1` if you need dispatch-time grace; disable once migration finishes.
- **Multi-tenancy.** A single relay serves one operator's agents. Concurrent operators sharing the same DB will see each other's traffic, register conflicting agent names, and audit each other. Federation is v2.5's concern.
- **Side-channel timing attacks.** bcrypt-verify uses a constant-time comparison (`bcrypt.compareSync`) internally, but other code paths (e.g. audit log lookups by agent_name) may be timing-observable. Not in scope for v2.1.
- **Covert channels through messages.** Messages are stored in plaintext by default. Encryption at rest protects the DB file, not in-transit traffic between two browser tabs sharing the same relay.

---

## Disclosure

Report vulnerabilities by email to **maxime@lumiereventures.co** or via the project's GitHub Security tab (if published). Please:

1. Include a clear reproduction (commands, env vars, expected vs observed).
2. Specify the affected version (the running daemon's `/health` reports it).
3. Wait for acknowledgement (target: 72 hours) before public disclosure.
4. Label sensitivity appropriately — critical issues warrant out-of-band coordination, low-severity issues can file directly as public GitHub issues.

Acknowledged reports get a commit reference + credit in CHANGELOG unless the reporter prefers anonymity.

---

## References

- `src/auth.ts` — per-agent token + authenticateAgent + auth_state gating.
- `src/encryption.ts` — keyring + AES-256-GCM + versioned ciphertext.
- `docs/key-rotation.md` — key rotation operator runbook.
- `docs/migration-v1-to-v2.md` — upgrade guide between major versions.
- `docs/federation-envelope-v1.md` — **frozen** cross-edge event envelope shape reserved for v2.3 hub federation + v3 P2P. Paper spec only; no code in v2.1.0 reads or writes it. Signing is ed25519; signatures cover canonical envelope bytes minus the signature field itself. Replay safety via `(origin_edge, event_id)` seen-set.
- `tests/regression-plug-and-play.test.ts` — canary regressions; if any CANARY test goes red, publish is NOT safe.
