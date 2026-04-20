# Dashboard security (v2.1 Phase 4d)

The built-in HTML dashboard (`GET /`, `GET /dashboard`) and its JSON feed (`GET /api/snapshot`) are guarded by three layers:

## 1. Host-header allowlist (DNS-rebinding defense)

Every dashboard request passes through `dashboardHostCheck`. If the `Host` header doesn't match the allowlist, the relay returns **421 Misdirected Request**. A DNS-rebinding attack — attacker.com flipped to 127.0.0.1 on a victim browser — still sends `Host: attacker.com` to the server, so this check catches the class.

**Default allowlist (when `RELAY_DASHBOARD_HOSTS` is unset):** hostname part of `Host` must be `127.0.0.1`, `localhost`, or `[::1]` / `::1`. Port is ignored — the relay accepts whatever port it's bound to.

**Override:** `RELAY_DASHBOARD_HOSTS=<comma-list>` matches the full `host[:port]` string verbatim (case-insensitive). Useful for reverse-proxy setups where the dashboard sits behind a public hostname.

## 2. Dashboard auth gate

`dashboardAuthCheck` runs after the Host check. Four cases:

| `RELAY_DASHBOARD_SECRET` | `RELAY_HTTP_SECRET` | Peer is loopback | Behavior |
|---|---|---|---|
| set | (any) | (any) | Require the dashboard secret |
| unset | set | (any) | Require the HTTP secret (fallback) |
| unset | unset | yes | Allow (dev-friendly) |
| unset | unset | no | **403** with hint to set `RELAY_DASHBOARD_SECRET` |

**Secret presentation** — all constant-time compared:

- `Authorization: Bearer <secret>` (first-class; matches the `/mcp` token pattern)
- `?auth=<secret>` query parameter (convenience for bookmarked dashboard URLs)
- `Cookie: relay_dashboard_auth=<secret>` (stickier if you want session-like access)

**Peer IP trumps Host header** for the loopback-dev-friendly fallback. The socket's `remoteAddress` is not attacker-controllable; `Host` is. If the peer is loopback we permit with no secret; if it's not, the 403 fires with guidance.

## 3. Origin check (browser same-origin)

Legacy `originCheck` middleware still runs after auth. Browsers with a non-allowlisted `Origin` header get 403 — defense-in-depth against same-site CSRF shenanigans that happen to slip past the other two checks.

## Info-disclosure policy (`snapshotApi`)

The dashboard is never allowed to leak:

- **Agent token hashes** — the `AgentWithStatus` type (`src/db.ts:toAgentWithStatus`) copies everything EXCEPT `token_hash`, surfacing only `has_token: boolean`.
- **Webhook secrets** — the dashboard mapper in `snapshotApi` replaces the raw `secret` with `has_secret: boolean`.
- **Plaintext encrypted-at-rest columns** — `SELECT *` on `messages` / `tasks` returns the `enc1:...` ciphertext, NOT the decrypted content. The UI renders encrypted gibberish when `RELAY_ENCRYPTION_KEY` is set; operators who disable encryption have already opted into plaintext.
- **Webhook delivery log error_text** — currently not rendered. If a future change adds it, redact internal-looking paths + IPs (F-3a.5).

`src/dashboard.ts` carries a top-of-file comment block enumerating this policy. Future maintainers should not strip it.

## Production checklist

- Set `RELAY_DASHBOARD_SECRET` (or rely on `RELAY_HTTP_SECRET`).
- If your dashboard is behind a reverse proxy with a public hostname, set `RELAY_DASHBOARD_HOSTS=dashboard.example.com` to accept that Host.
- Keep `RELAY_HTTP_HOST=127.0.0.1` (default). Non-loopback binds are blocked by Phase 4n's startup guard anyway unless you explicitly set `RELAY_HTTP_SECRET` or `RELAY_ALLOW_OPEN_PUBLIC=1`.
- Tighten `/api/snapshot` visibility further if operational audit policy demands it — the file is `src/dashboard.ts`.

## Related

- `tests/v2-1-dashboard-hardening.test.ts` — 8 tests covering the gate matrix.
- `src/transport/http.ts` — `dashboardHostCheck` + `dashboardAuthCheck`.
- `docs/../devlog/039-v2.1-dashboard-hardening.md` — decisions + assumptions.
