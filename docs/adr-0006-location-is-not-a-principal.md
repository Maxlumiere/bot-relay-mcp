# ADR-0006 — Power derives from authenticated identity + capability, never from network position

**Status:** Accepted. Referenced across the code since v2.1; written up here when PR B (the ADR-0006 completion) landed the three enforcement calls below.

## Context

The relay's HTTP surface serves two different principals over the same socket:

- **Agents**, who authenticate with a per-agent token (and, on a non-loopback bind, the transport-level `http_secret`) to use `/mcp`.
- **The operator**, who drives the dashboard and the operator-power endpoints (kill an agent, wake a terminal, write another agent's status, read the keyring, set the operator identity).

These are different principals with different lifetimes and different blast radii. An agent credential leaking is a contained incident; the operator credential is fleet-wide. The invariant: **power derives from an authenticated identity plus capability — never from where the connection came from. Location is not a principal.** A process being on loopback, inside the trusted network, or holding a transport credential does not make it the operator.

Two shipped violations motivated writing this down:

1. **Loopback bypass of operator power.** Every dashboard/operator route used `dashboardAuthCheck`, which in the default no-secret install let *any* loopback peer through with no credential. So any local process — or any agent on the box — could `POST /api/kill-agent` and unregister a colleague. Network position (loopback) was standing in for the operator principal.
2. **Transport credential standing in for operator credential.** `dashboardAuthCheck` and `csrfCheck` resolved the dashboard secret as `RELAY_DASHBOARD_SECRET || config.http_secret`. But `authMiddleware` enforces `http_secret` on `/mcp`, so **every HTTP agent already holds it.** The fallback therefore made an agent *transport* credential silently satisfy *operator* auth: an agent could authenticate to operator endpoints with the same secret it uses to send a message.

## Decision — three enforcement calls

- **(a) Secret-by-default at init.** `relay init` generates a dedicated `dashboard_secret` (`crypto.randomBytes(32).base64url`) for every HTTP install and prints it once. This is a *different* config field from `http_secret` — different principal, different lifetime, different rotation; one secret must not authorize both. `reconcileRelayConfig` preserves an existing secret (re-runs never rotate it) and fills it for legacy installs on their next `init`. Generation is in-memory and written in the existing config step, which runs **after** the preflight refusal, so the "nothing written on refusal" atomicity invariant is preserved. Secret-by-default is what makes (b) *satisfiable* — operator endpoints can be always-authed only if an operator secret always exists.

- **(b) Operator-power endpoints are always authed, regardless of secret config OR network position.** A new `operatorAuthCheck` gates `kill-agent`, `wake-agent`, `focus-terminal`, `send-message`, `set-status`, `operator-identity` (GET+POST), `keyring`, and `dashboard-theme`. It requires a **verified** dashboard secret and has **NO loopback bypass** — a loopback caller with no secret gets 401, not the read surface's restricted-but-allowed view. It consumes `dashboardAuthCheck`'s own result (`res.locals.dashboardAuthenticated`) rather than re-resolving the secret, so the read surface and the operator gate share ONE predicate and cannot drift (ADR-0015 L4). It is fail-closed by enumerating the SUCCESS condition (`authenticated === true` → allow; every other state → refuse).

- **(c) The `http_secret` fallback is removed — recorded as an ESCALATION removal, not a convenience trim.** The secret is now resolved through a SINGLE exported `resolveDashboardSecret(config)` in `config.ts` = `RELAY_DASHBOARD_SECRET || config.dashboard_secret` and nothing else. **This is written down deliberately so it is not re-added as a kindness in a year.** The fallback was a live privilege-escalation path (agent transport credential → operator power); "operators with an HTTP secret get the dashboard for free" is exactly the convenience that reintroduces the hole. The read surface keeps a loopback *restricted* view (presence/status/counts, no cross-agent content) only for configs without a `dashboard_secret` — legacy installs and tests — because secret-by-default means fresh installs always have one.

  There were THREE resolution sites, not two: `dashboardAuthCheck` and `csrfCheck` (http.ts) and `dashboardWsAuthOk` (the dashboard **WebSocket** gate, websocket.ts) — a fourth copy of the same logic, so the escalation lived in three places and could drift. Collapsing them to one exported resolver is the durable ADR-0015 L4 fix: the predicate now has a single definition every surface imports. (The WS itself is metadata-only by design — a prior H4 audit made broadcasts carry only an event name + entity id, no content; clients refetch via the gated `/api/snapshot`. So the WS fallback was an escalation of the *event-stream*, not a content leak; it is closed for consistency and defense-in-depth.)

## The read surface vs the operator surface

The read paths (`/`, `/dashboard`, `/api/snapshot`) may serve a loopback peer a **restricted** view (this is PR A's snapshot allowlist gated on `dashboardAuthenticated`). That is not a loopback bypass of a principal — it is a deliberately reduced projection that carries no cross-agent secret. Operator power is the opposite posture: no reduced form, no loopback grant, verified secret or 401.

## Consequences

- A fresh loopback dashboard now requires the printed secret to load the full view (the restricted read view still loads without it for legacy/no-secret configs). This is the intended posture — location grants nothing.
- Existing no-secret installs get 401 on operator endpoints until `relay init` regenerates a secret and the daemon restarts to load it; the 401 body names that remedy (silence-as-failure: a bare 401 is not enough).
- Tests assert the harm through the real shipped route (ADR-0015): a tokenless/no-secret caller attempting operator power is REFUSED **and** the side effect does not happen (e.g. kill-agent must not unregister), plus the innocent twin (secret + Bearer) succeeds; and the escalation-removal harm — presenting `http_secret` to an operator endpoint — is REFUSED.

**Depends-on:** [[ADR-0015]] (guard-construction invariant — one predicate, harm+twin tests), the silence-as-failure invariant, PR A's snapshot allowlist (`dashboardAuthenticated`).
