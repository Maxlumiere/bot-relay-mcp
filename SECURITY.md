# Security Policy

**Project:** bot-relay-mcp
**Last updated:** 2026-04-21 (v2.1.7)

---

## v2.1.7 external review (external reviewer credit — Steph + Codex)

On 2026-04-21, an external security review by Steph (Maxime's wife's primary AI) surfaced four hardening gaps; Codex's follow-up audit added five more. v2.1.7 ships fixes for the HIGH and MEDIUM items inline; the two LOW items are documented in this file; the one MEDIUM (webhook TOCTOU on DNS fast-flip) is deferred to v2.1.8 per the scope envelope. Changes:

- **HIGH — IPv6 prefix bypass in `src/url-safety.ts`.** Pre-v2.1.7 code used `startsWith('fe80:')` for link-local classification, missing the remaining 6 prefixes in `fe80::/10` (fe90::, fea0::, etc.). Codex demonstrated a monkey-patched `dns.lookup` returning `fe90::1` passed validation and let a webhook fire against a link-local address. Replaced every prefix check with real IPv6 CIDR matching via `src/cidr.ts`. Now blocks: `::1/128`, `::/128`, `fe80::/10`, `fc00::/7`, `ff00::/8`, `::ffff:0:0/96`, `64:ff9b::/96`, `2001::/23`.
- **HIGH — Dashboard secret layering.** `authMiddleware` (RELAY_HTTP_SECRET) ran ahead of `dashboardAuthCheck` and blocked requests lacking the HTTP secret before the dashboard-specific auth ever ran. Operators expecting dashboard-only-secret isolation silently got stronger auth than intended. Fixed: authMiddleware now skips the four enumerated dashboard routes (`/`, `/dashboard`, `/api/snapshot`, `/api/keyring`) so `dashboardAuthCheck` can enforce `RELAY_DASHBOARD_SECRET` independently.
- **HIGH — `/mcp` Host-header check.** Pre-v2.1.7 the DNS-rebinding defense was wired per-route on dashboard paths only. `/mcp` accepted any Host header, exposing agents to browser-based rebinding attacks. Fixed: `httpHostCheck` is now applied globally (including `/mcp` POST/GET), skipping `/health` only. New canonical env var `RELAY_HTTP_ALLOWED_HOSTS`; `RELAY_DASHBOARD_HOSTS` preserved as a backward-compat alias.
- **MEDIUM — SameSite + CSRF.** `relay_dashboard_auth` cookie is now re-issued by `dashboardAuthCheck` with `HttpOnly; SameSite=Strict; Path=/` (and `Secure` when `RELAY_TLS_ENABLED=1`). A companion `relay_csrf` cookie (NOT HttpOnly — dashboard JS reads it) carries a per-process HMAC-SHA256 double-submit token; unsafe methods (POST/PUT/DELETE/PATCH) on `/api/*` require a matching `X-Relay-CSRF` header. v2.1.7 has no state-changing endpoints to exercise this today — the middleware is infrastructure so v2.2's dashboard state-changing endpoints are safe-by-construction.
- **MEDIUM — Per-IP HTTP rate limits.** Pre-v2.1.7 rate limiting was per-tool-call keyed on agent_name; an anonymous flood could exhaust Express middleware before auth fired. Added a pre-auth per-IP fixed-window counter (default 200 req/min) + per-IP concurrent-request cap (default 10). `/health` excluded. Tuning via `RELAY_HTTP_RATE_LIMIT_PER_MINUTE` + `RELAY_HTTP_MAX_CONCURRENT_PER_IP`. 429 + `Retry-After`.
- **LOW — Audit log content preview (now documented).** See "Known residual behavior" below.
- **LOW — Keyring cache reload (now documented).** See "Known residual behavior" below.
- **DEFERRED to v2.1.8 — Webhook TOCTOU on DNS fast-flip.** `src/webhooks.ts` re-validates the URL at fire time (DNS-rebinding defense), but native fetch re-resolves the hostname when opening the socket. A fast-flip authoritative DNS response can bypass the re-validation. Closing this requires pinning fetch to the validated IP while preserving TLS/SNI on the hostname (Undici per-request dispatcher with `connect.lookup`). A direct `undici` dep + rewrite of the webhook fire path is larger than the v2.1.7 envelope and is scheduled for v2.1.8. Exploitation requires attacker control of an authoritative nameserver with sub-second TTL + precise timing; not trivial at scale.

### Hall of Fame

v2.1.7 hardening landed thanks to:

- **Steph** — external review that flagged the original four items (/mcp Host-check, SameSite+CSRF, per-IP rate limits, audit preview retention doc).
- **Codex** (dual-model audit) — five additional findings including the concrete IPv6 prefix-bypass SSRF.

Reporters who prefer attribution here can request entries as part of the disclosure flow.

---

## Known residual behavior (v2.1.7)

### Audit log content preview (`audit_log.params_summary`)

The dispatcher records a 40-char preview of `content` + other string args in the plaintext `params_summary` column (full body is separately in the encrypted `params_json`). The preview persists for the configured audit retention window (default 90 days, env `RELAY_AUDIT_LOG_RETENTION_DAYS`). If the operator's workload routes secrets through message content (tokens, API keys, emails), those appear in previews for up to 90 days.

Mitigation (operator-side):
- Sanitize sensitive content at the application layer before calling `send_message` / `post_task` (the relay cannot know what is "secret" in your domain).
- Shorten `RELAY_AUDIT_LOG_RETENTION_DAYS` if your compliance posture demands it (1 day is valid; 0 disables audit purging).
- For forensic depth, the `params_json` column stays encrypted with your keyring — decrypt out-of-band only when needed.

Future server-side regex scrubbing of known secret shapes is tracked as a v2.1.8 candidate.

### Encryption keyring cache reload

`src/encryption.ts` caches the parsed keyring at first read, keyed on the `RELAY_ENCRYPTION_KEYRING` / `RELAY_ENCRYPTION_KEYRING_PATH` env value. In-place edits to the keyring file contents do NOT auto-reload — the daemon continues using the cached keyring until restart. This is intentional: detecting file content change mid-operation would complicate the re-encryption state machine.

Operational implication: key rotation must pair a file edit with a daemon restart. `relay re-encrypt` is designed around this — operators run the rotation command on a paused daemon, then bring it back up.

A future `RELAY_ENCRYPTION_KEYRING_WATCH=1` opt-in reload flag is a v2.2 candidate.

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

## DNS-rebinding defense (Phase 4e + v2.1.7)

Webhook targets are re-validated at fire time: `validateWebhookUrl` re-resolves the hostname and re-runs the SSRF check against every resolved IP. If a previously-safe hostname now resolves to a private IP or a cloud-metadata address, the webhook is terminally refused (no retry — feeding an attacker controlling DNS wastes bandwidth). v2.1.7 replaces IPv6 string-prefix checks with real CIDR matching (see Item 5 in v2.1.7 review above); pre-v2.1.7 clients that relied on the `fe80:` string-prefix should re-audit their webhook targets for any link-local IPv6 they depended on seeing blocked.

**Residual TOCTOU (v2.1.7):** native fetch re-resolves hostname when opening the socket, so sub-second-TTL authoritative DNS flips can still bypass the fire-time check. Closing this via Undici per-request dispatcher `connect.lookup` pinning is scheduled for v2.1.8.

Every HTTP route (dashboard + `/mcp`) now enforces a Host-header allowlist (default loopback-hostname-only, override via `RELAY_HTTP_ALLOWED_HOSTS` — `RELAY_DASHBOARD_HOSTS` preserved as the v2.1 alias) so an external attacker can't use DNS rebinding to reach `127.0.0.1:3777` through a browser. Pre-v2.1.7 this gate was dashboard-only, leaving `/mcp` exposed — see Item 1 above.

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
