# Onboarding cost — measurement (2026-09-01)

**A measurement, not a design.** It exists so the zero-config-onboarding conversation starts from arithmetic instead of impressions. No fix is proposed here; the numbers are the deliverable. Measured **read-only** against the live machine and `origin/main` = `d22e3ee`; code citations are `file:line`.

**Definition used:** onboarding cost = **the number of things that must be true before a brand-new agent can both send and receive a message, that the agent itself cannot establish.** A step a human/out-of-band must do counts; a step the agent can self-serve does not.

---

## Headline numbers

| Metric | Number |
|---|---|
| Channels an agent can use to reach the relay | **3** (stdio-MCP, HTTP-MCP, `relay` CLI) — **not equivalent** (see below) |
| Channels that do **both** send **and** receive | **2** (stdio-MCP, HTTP-MCP). The CLI is **send-only** — it has no receive-content subcommand |
| Ordered prerequisites on the primary path (stdio-MCP) | **7** |
| Of those, steps the agent can **self-serve** | **1** (`register_agent`) |
| Of those, steps that are **out-of-band / human** | **~5** (config entry, spawn name, instance id, `transport≠http`, token persistence) |
| Facts a new agent must be **told** (not discoverable in-session) | **6** (name, token, DB path, instance id, + `http_secret`, `dashboard_secret`) |
| Silent-failure modes (agent looks healthy, cannot send/receive) | **≥6** — ~4 fully silent, ~2 partial, +1 the brief called silent that is actually loud |

**Bottom line: "zero-config" is false today.** The minimum successful join requires **~5 out-of-band facts/prerequisites**, and **≥3 of them fail silently** when wrong. Live proof: the fleet **orchestrator** has run all day on the CLI's send-only path because its own session is provisioned through the account-scoped channel, which carries **no local MCP relay** — an onboarding failure that never announced itself and was never counted until now.

---

## The three channels (steps + who can perform them)

`[AGENT]` = self-serve from inside a session · `[HUMAN]` = operator / out-of-band.

### Channel A — stdio-MCP (`~/.claude.json` → `node dist/index.js`) — the intended zero-config path
1. `~/.claude.json` has a `bot-relay` stdio entry with a **real** (non-`%20`) `dist/index.js` path — `[HUMAN]` (`relay init`, `src/cli/init.ts:243`)
2. Spawn env carries `RELAY_AGENT_NAME` — `[HUMAN]` (`src/server.ts:1054`, `transport/stdio.ts:257`)
3. Resolved `config.transport` is `stdio`/`both`, **not** `http` — `[HUMAN/config]` (`src/index.ts:220,231`)
4. Instance resolvable (`RELAY_INSTANCE_ID` or `active-instance`) or startup **refuses** — `[HUMAN]` (`src/instance.ts:118,296`)
5. `register_agent` first-mint (unauthenticated by design) — **`[AGENT]`** (`src/tools/identity.ts:105,335`)
6. Token persisted so later calls authenticate — in-session `register_agent` does **not** write the vault; only the hook does — `[HUMAN/hook]` (`src/token-store.ts:11`, `hooks/check-relay.sh:732`)
7. Receive: SessionStart hook reads the DB and delivers mail — needs daemon reachable + `curl` + `sqlite3` + DB-path == daemon's DB — `[HUMAN/infra]` (`hooks/check-relay.sh:688,770`)

→ **7 steps, 1 agent-self-serve, ~5 human.**

### Channel B — HTTP-MCP (`POST http://127.0.0.1:3777/mcp`)
1. Daemon running on `http`/`both` — `[HUMAN]` (`src/index.ts:220`)
2. `http_secret` (if configured) presented as `Authorization: Bearer` — `[HUMAN]` told out-of-band (`src/transport/http.ts:263`)
3. `register_agent`, then present `X-Agent-Token` on **every** gated call (no env/vault fallback over HTTP) — `[AGENT]` (`src/server.ts:1019`)

→ **~3 steps; needs the daemon (and maybe a secret) a new agent cannot itself provide.**

### Channel C — `relay` CLI
1. Sender name from `--from`/env — `[AGENT/HUMAN]` (`src/cli/send.ts:110`)
2. Vault token must bcrypt-verify against the DB, else local refusal (exit 2) — `[AGENT]` (`src/cli/send.ts:149`)
3. **Operator gate:** `relay send` → `/api/send-message`, which needs a `dashboard_secret`; with none, returns **401** — `[HUMAN]` prerequisite (`src/transport/http.ts:786`, `src/cli/send.ts:219`)
4. **Receive: not supported.** No `inbox`/read-content subcommand exists (`bin/relay:49`); `relay watch` prints only a wake line. Receive falls back to the hook's `sqlite3` read or MCP.

→ **send-only, and even send needs an operator secret the agent cannot mint.**

---

## Silent-failure inventory (does it announce itself?)

| # | Failure — agent looks healthy but is broken | Announces itself? | Where it goes quiet |
|---|---|---|---|
| a | `transport:"http"` in a stdio-spawned server's config → zero tools / 30s hang | **No** | HTTP-only branch runs; daemon-warn guard is gated on `transport==="stdio"` so it never fires (`src/index.ts:129,220,231`) |
| b | Token registers but fails auth (stale vault vs DB hash) | **Partial** | vault read never throws (`token-store.ts:119,144`); surfaces only as `AUTH_FAILED` on first gated call; the hook **swallows** a non-200 register (`check-relay.sh:744`) |
| c | Tools hidden by feature-bundle / `tool_visibility` | **Partial** | omission from `tools/list` is silent (`server.ts:356`); `health_check.surface` now names hidden tools (the #tools-list-visibility breadcrumb), so it's observable **if** health_check is called |
| d | `%20` URL-encoded path fossil in `~/.claude.json` → spawn fails, every relay session dead | **No** | node spawn fails silently; the exact-match classifier deliberately leaves a `%20` fossil alone (`config-merge.ts:341`). **This install is under `Claude AI` (a space) → a live candidate** |
| e | Operator-gate 401 on CLI send | **Loud (correction)** | the brief listed this as silent; it is actually a loud exit-1 with a message (`http.ts:786`, `send.ts:259`) — an easy-to-miss *prerequisite*, not a silent failure |
| f | Orchestrator / account-scoped session has **no local MCP relay** and silently routes around it | **No** | the session simply has no `bot-relay` tools; nothing states "your relay channel is absent." Happening in the orchestrator's session now |
| g | stdio `register_agent` returns the token but does **not** persist it; token shown once, then lost | **Partial** | later gated calls fail `AUTH_FAILED` with no hint the token was the one just discarded (`identity.ts:335`) |

Fully silent: **a, d, f** (+ g until the first failed call). Partial: **b, c, g**. Miscategorized-as-silent: **e** (loud).

---

## Not discoverable from inside a session (must be injected / told)

1. **Agent name** (`RELAY_AGENT_NAME`) — no "who am I" tool (`server.ts:1054`, `check-relay.sh:66`)
2. **Agent token** — minted once, server keeps only a bcrypt hash; if lost, unrecoverable in-session (`identity.ts:335,338`)
3. **DB path** — a machine fact from `RELAY_DB_PATH`/instance resolution, not exposed to the session (`instance.ts:236`)
4. **Instance id** — `RELAY_INSTANCE_ID` or the `active-instance` link; absent → MUTE refusal on a multi-instance box (`instance.ts:118,301`)
5. **`http_secret`** (Channel B) — daemon transport credential, told out-of-band (`http.ts:263`)
6. **`dashboard_secret`** (Channel C) — operator principal; only `relay init` generates it and there is **no CLI to read it back** (`http.ts:664`)

An agent can ask the relay for none of these six. Each is, by victra's definition, a zero-config blocker.

---

## Method, scope, and what was NOT measured

- **Read-only.** No file, config, credential, or daemon state was modified; no CLI was executed. Live reads: `~/.claude.json`, `~/.bot-relay/config.json`, `/health`, a `/mcp` `initialize` probe, the instance vault listing, MCP attach logs. Code paths traced from source at `d22e3ee`.
- **Verified live (2026-09-01):** `bot-relay` present in `~/.claude.json` as stdio (no env, 0 per-project overrides); `config.json` `transport` **absent** (the (a) trap is not currently armed here), `profile=solo`, `feature_bundles=[core]`, a `dashboard_secret` **is** present; daemon `:3777` v3.0.1, `transport:http`, `auth_required:false`, ~14d uptime; instance `fbd470d2` DB 25 MB with **39** agent tokens in the vault.
- **A false lead I discarded:** an initial grep suggested "many MCP attach failures" in recent logs; on inspection those lines were benign (`"Starting connection with timeout of 30000ms"` startup + server stderr **info** logs recorded under an `error` key). My own working session shows the same pattern while healthy. The local stdio channel attaches fine across 20/21 cwd-keys, including the daily cron sessions. Reported so the number is not mistaken for a live-failure count.
- **Not measurable read-only from here (a finding in itself):** the orchestrator's exact session-side MCP state — its channel (account-scoped) carries no local file to inspect, and inspecting the live session would require changing it. That the product's own interface is unavailable to the fleet's orchestrator, silently, is the single most load-bearing onboarding datapoint and it is confirmed only indirectly.
