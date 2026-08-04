# Dashboard security (v2.1 Phase 4d)

The built-in HTML dashboard (`GET /`, `GET /dashboard`) and its JSON feed (`GET /api/snapshot`) are guarded by three layers:

## 1. Host-header allowlist (DNS-rebinding defense)

Every dashboard request passes through `dashboardHostCheck`. If the `Host` header doesn't match the allowlist, the relay returns **421 Misdirected Request**. A DNS-rebinding attack — attacker.com flipped to 127.0.0.1 on a victim browser — still sends `Host: attacker.com` to the server, so this check catches the class.

**Default allowlist (when `RELAY_DASHBOARD_HOSTS` is unset):** hostname part of `Host` must be `127.0.0.1`, `localhost`, or `[::1]` / `::1`. Port is ignored — the relay accepts whatever port it's bound to.

**Override:** `RELAY_DASHBOARD_HOSTS=<comma-list>` matches the full `host[:port]` string verbatim (case-insensitive). Useful for reverse-proxy setups where the dashboard sits behind a public hostname.

## 2. Dashboard auth gate (READ surface)

`dashboardAuthCheck` runs after the Host check and governs the READ surface (`GET /`, `GET /dashboard`, `GET /api/snapshot`). The operator secret chain is **`RELAY_DASHBOARD_SECRET` (env) → `dashboard_secret` (config.json) — and nothing else.** The former `RELAY_HTTP_SECRET` fallback was **removed** as a privilege-escalation path (an agent holds `http_secret` to reach `/mcp`, so the fallback let an agent transport credential satisfy operator auth). See ADR-0006 and §2b; do not re-add it.

| Dashboard secret (env or config) | Peer is loopback | Behavior |
|---|---|---|
| set | (any) | Require the dashboard secret |
| unset | yes | Allow, but **RESTRICTED** — `dashboardAuthenticated=false`, so `snapshotApi` withholds decrypted content + process metadata (presence/status/counts only) |
| unset | no | **403** with hint to set `RELAY_DASHBOARD_SECRET` |

**Secret-by-default:** `relay init` generates a random `dashboard_secret` for every HTTP install (ADR-0006 a), so the "unset" rows apply only to legacy installs (pre-`relay init`) and tests — a fresh loopback dashboard requires the printed secret. The RESTRICTED loopback view exists so those legacy/no-secret configs still surface presence/status/counts (never cross-agent content) rather than hard-failing.

**Secret presentation** — all constant-time compared:

- `Authorization: Bearer <secret>` (first-class; matches the `/mcp` token pattern)
- `?auth=<secret>` query parameter (convenience for bookmarked dashboard URLs)
- `Cookie: relay_dashboard_auth=<secret>` (stickier if you want session-like access)

**Peer IP trumps Host header** for the loopback RESTRICTED path. The socket's `remoteAddress` is not attacker-controllable; `Host` is. A loopback peer with no dashboard secret gets the restricted read view; a non-loopback one gets 403.

## 2b. Operator-power endpoints (ALWAYS authed — ADR-0006 b)

Control / state-changing endpoints — `POST /api/kill-agent`, `/api/wake-agent`, `/api/focus-terminal`, `/api/send-message`, `/api/set-status`, `GET|POST /api/operator-identity`, `GET /api/keyring`, `POST /api/dashboard-theme` — layer **`operatorAuthCheck`** on top of `dashboardAuthCheck`. This gate requires a VERIFIED dashboard secret and has **NO loopback bypass**: *location is not a principal.* A loopback caller with no secret gets **401** (not the restricted-but-allowed read view). Secret-by-default is what makes this satisfiable — an operator secret always exists, so these endpoints are always reachable by the operator and never by an unauthenticated local process (or an agent holding only its transport credential). `operatorAuthCheck` consumes `dashboardAuthCheck`'s own result (`res.locals.dashboardAuthenticated`), so the read surface and the operator gate share ONE predicate and cannot drift (ADR-0015 L4).

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

- A dashboard secret is generated by default at `relay init`; set `RELAY_DASHBOARD_SECRET` to override it. Do **not** point dashboard/operator auth at `RELAY_HTTP_SECRET` — that fallback was removed as an escalation path (every HTTP agent holds the HTTP secret).
- If your dashboard is behind a reverse proxy with a public hostname, set `RELAY_DASHBOARD_HOSTS=dashboard.example.com` to accept that Host.
- Keep `RELAY_HTTP_HOST=127.0.0.1` (default). Non-loopback binds are blocked by Phase 4n's startup guard anyway unless you explicitly set `RELAY_HTTP_SECRET` or `RELAY_ALLOW_OPEN_PUBLIC=1`.
- Tighten `/api/snapshot` visibility further if operational audit policy demands it — the file is `src/dashboard.ts`.

## Related

- `tests/v2-1-dashboard-hardening.test.ts` — 8 tests covering the gate matrix.
- `src/transport/http.ts` — `dashboardHostCheck` + `dashboardAuthCheck`.
