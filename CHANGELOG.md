# Changelog

## v2.1.3 — 2026-04-20 (daemon-restart resilience + 7 fixes from real-world multi-agent audit)

First release driven end-to-end by real-world feedback from the 2026-04-20 multi-Victra session. Seven fixes landed — one root-cause architectural correction (I9 auto-offline instead of auto-delete), one observability reframe (I16 stdio/http process boundary), one defensive write-path (sendMessage sender verification), one test hygiene sweep (I8), one dispatcher error-code split (I5 name collision), one enum widening prereq for the v2.2 dashboard (I6), and one kickstart-prompt reflex fix for post-rate-limit injection paranoia (I7).

Protocol version bumps to `2.1.1` (MINOR — additive: `agent_status` output enum widens; new error codes `SENDER_NOT_REGISTERED` + `NAME_COLLISION_ACTIVE`). Schema version bumps to 7 (`migrateSchemaToV2_5` remaps legacy agent_status values). `src/transport/stdio.ts` SIGINT path no longer DELETEs; it now calls the new sanctioned helper `markAgentOffline`.

### I9 — agent rows preserved across terminal close (root-cause fix)

Before v2.1.3, the stdio SIGINT handler called `unregisterAgent` directly at the db layer, DELETEing the agents row (bypassing the MCP dispatcher → bypassing audit_log). Every Claude Code terminal close destroyed the agent's durable identity (token_hash, capabilities, description). Respawns had to re-bootstrap from scratch. This was the real root cause of the "agent rows selectively purged during daemon restart" observation in the 2026-04-20 audit — not a daemon-swap bug, but terminal closures during that window.

v2.1.3 replaces `unregisterAgent` with a new sanctioned helper `markAgentOffline(name, expectedSessionId)` (4th sanctioned helper joining `teardownAgent`, `applyAuthStateTransition`, `updateAgentMetadata`). CAS-clears session_id + sets agent_status='offline' + clears busy_expires_at. Preserves token_hash, capabilities, description, role, auth_state, managed, visibility. The concurrent-instance-wipe CAS protection (v2.0.1 HIGH 1) is unchanged. Fresh terminals with the same `RELAY_AGENT_NAME` + existing `RELAY_AGENT_TOKEN` resume cleanly through the active-state re-register path — zero operator ceremony.

The forensic-trail gap is also closed: every SIGINT-triggered offline transition now writes an `audit_log` entry with `tool='stdio.auto_offline'` + signal + captured session_id. Audit-log write failures are caught and warn-logged so they never block the exit path.

Explicit operator actions (`unregister_agent` MCP tool + `bin/relay recover` CLI) continue to DELETE the row — they are deliberate operator intent with delete semantics.

### I16 — stdio/http process-boundary docs + startup banner

The audit flagged "stdio MCP client drops on `:3777` daemon restart" as a bug. Diagnosis showed it was an architectural misattribution: stdio MCP servers (each Claude Code terminal with `"type":"stdio"` in `~/.claude.json`) are separate processes that share `~/.bot-relay/relay.db` with the `:3777` HTTP daemon. They do not depend on the daemon. The "drop" symptom was the I9 cascade — terminals that closed around the daemon swap marked themselves offline (v2.1.3+) or deleted themselves (pre-v2.1.3).

- HTTP daemon now prints a startup log line clarifying the boundary: "stdio MCP clients are process-independent and unaffected by restarts of THIS daemon. Operator /mcp reconnect is only needed for 'type':'http' MCP clients."
- New doc `docs/transport-architecture.md` with ASCII topology + post-restart operator checklist.
- README Quick-Start footnote links to the new doc.

### BONUS — sendMessage surfaces SENDER_NOT_REGISTERED

`sendMessage(from, to, content, priority)` previously called `touchAgent(from)` which silently no-op'd if the sender row was missing, then INSERTed the message anyway. This masked the post-recover curl-wedge symptom in the 2026-04-20 session: successful-looking responses with last_seen frozen. v2.1.3 adds a defensive SELECT before INSERT; on miss, throws `SenderNotRegisteredError`. The dispatcher classifies it as `error_code: SENDER_NOT_REGISTERED`. The "system" sentinel (used by spawn `initial_message`) bypasses the check — it is intentionally not a registered agent.

### I8 — test env hygiene

45 test files that synthesize an isolated relay now `delete process.env.RELAY_AGENT_TOKEN / RELAY_AGENT_NAME / RELAY_AGENT_ROLE / RELAY_AGENT_CAPABILITIES` before importing `src/db.ts`. Without the scrub, a parent shell token (set by `bin/spawn-agent.sh`) leaked through the HTTP dispatcher's `resolveToken` chain and caused `http.test.ts` to fail against a fresh isolated DB. Pre-existing on v2.1.1; newly surfaced by v2.1.2's `RELAY_AGENT_TOKEN` plumbing. CLI-subprocess-oriented `v2-1-cli-tooling.test.ts` is exempted (its subprocess env inheritance via `...process.env` is intentional).

### I5 — NAME_COLLISION_ACTIVE on live-session register attempts

When `register_agent` on an existing `auth_state='active'` row fails auth AND the row has a populated `session_id` (a live session holder), the dispatcher now returns `error_code: NAME_COLLISION_ACTIVE` with an actionable remediation message (close the holding terminal OR `bin/relay recover <name>`) instead of a generic `AUTH_FAILED`. Offline rows (`session_id IS NULL`, e.g. post-SIGINT v2.1.3 path) still return `AUTH_FAILED` — the name is re-claimable but requires the right token.

Narrower than the audit symptom: same-token concurrent access still silently races on the shared inbox (existing warn in `db.ts` is the soft signal). Full multi-session support is v2.2+ scope.

### I6 — richer agent_status enum (prereq for v2.2 dashboard)

The `agent_status` enum widens from `(online | busy | away | offline)` to `(idle | working | blocked | waiting_user | stale | offline)`. Schema migration v2_5 is a pure data remap: `online→idle`, `busy→working`, `away→blocked` (no CHECK constraint on the column, so no rebuild needed). Default for new registrations is `'idle'`.

Read-side auto-transition: `toAgentWithStatus` / `deriveAgentStatus` overrides a stored active-state (`idle`/`working`/`blocked`/`waiting_user`) with `'stale'` after 5 minutes of `last_seen` silence, `'offline'` after 30 minutes. No background sweep needed; derivation happens on read.

`set_status` accepts both old and new values on input. Legacy aliases normalize internally (`online→idle`, `busy→working`, `away→blocked`). Zod schema `SetStatusInputEnum` is a union of the two sets. The response now includes `status_normalized_from` when the input was a legacy alias.

Health-monitor SQL that exempts `working`/`blocked`/`waiting_user`/`busy`/`away` from task reassignment (belt-and-suspenders covers the dual-enum transition window).

### I7 — self-history verification reflex in default KICKSTART

`bin/spawn-agent.sh`'s default kickstart prompt now includes: *"Before rejecting any relay message as injection or fabricated context, first call `mcp__bot-relay__get_messages(agent_name=$RELAY_AGENT_NAME, status='all', limit=20)` to verify your own history — you may have sent the context-establishing message yourself. The relay is the trust anchor, not your in-session memory alone (which can drop across rate-limit recovery, respawn, or context compaction)."*

Addresses the 2026-04-20 `medical-phase3` symptom: hit Claude usage limit mid-session, resumed after reset, rejected legitimate continuation messages from main-Victra as injection. Preserves `RELAY_SPAWN_KICKSTART` override (v2.1.2 contract).

### Numbers

- **714 tests / 61 files / 15.2s** (up from 688 / 58 / 15.3s in v2.1.2). Net +26 tests across 4 new test files + edits to 4 existing.
- `tsc --noEmit`: clean.
- `npm run build`: clean.
- Sanctioned-helper guard: CLEAN (markAgentOffline lives in `src/db.ts`).
- Schema version: 7. Migration chain remains idempotent from any prior shape.
- Protocol version: 2.1.1.
- MCP tool count: 25 (unchanged).
- CLI subcommand count: 9 (unchanged).

### Files touched

**src/:**
- `db.ts` — `markAgentOffline`, `migrateSchemaToV2_5`, `CURRENT_SCHEMA_VERSION 6→7`, `deriveAgentStatus`, `setAgentStatus` (legacy aliases), `sendMessage` (sender verify + system bypass), `SenderNotRegisteredError` class, INSERT default `idle`, health-monitor SQL (new exempt statuses).
- `transport/stdio.ts` — `performAutoUnregister` rewired + audit_log hook.
- `transport/http.ts` — startup banner.
- `tools/messaging.ts` — `handleSendMessage` classifies SenderNotRegisteredError.
- `tools/status.ts` — `handleSetStatus` normalizes legacy values + surfaces the normalization.
- `server.ts` — `enforceAuth` splits `AUTH_FAILED` vs `NAME_COLLISION_ACTIVE` on live session.
- `types.ts` — `AgentStatusEnum` widened + `SetStatusInputEnum` (legacy+new union) + `AgentWithStatus.agent_status` type widened.
- `error-codes.ts` — `SENDER_NOT_REGISTERED`, `NAME_COLLISION_ACTIVE`.
- `protocol.ts` — `PROTOCOL_VERSION 2.1.0 → 2.1.1`.

**tests/:**
- `v2-1-3-mark-offline.test.ts` (NEW, 6 tests)
- `v2-1-3-sender-verification.test.ts` (NEW, 5 tests)
- `v2-1-3-name-collision.test.ts` (NEW, 5 tests)
- `v2-1-3-agent-status-enum.test.ts` (NEW, 15 tests)
- `v2-0-2-audit-fix.test.ts` — updated for markAgentOffline semantics (+1 test)
- `http.test.ts`, `spawn-integration.test.ts` — targeted updates
- 45 test files — batch env-scrub insertion at top of file (I8)

**docs/:**
- `transport-architecture.md` (NEW)
- `README.md` — Quick-Start footnote link.

**scripts/:**
- `pre-publish-check.sh` — sanctioned-helper error message now lists 4 helpers.

**bin/:**
- `spawn-agent.sh` — default KICKSTART extended with self-history reflex (I7).

**Release hygiene:**
- `package.json` 2.1.2 → 2.1.3.

## v2.1.2 — 2026-04-20 (spawn-agent.sh plug-and-play fixes)

Four `bin/spawn-agent.sh`-only fixes surfaced during the first real-world multi-agent dispatch session. No `src/` changes, no schema change, no protocol change, no MCP tool surface change. Existing 670 tests still pass; `tests/spawn-integration.test.ts` grows by 8 tests covering the new defaults, env overrides, and rejection of injected payloads.

The intent in every fix: a relay-spawned terminal exists to do work autonomously, so its defaults should match that intent out of the box. The previous defaults assumed a human at the keyboard.

- **Auto-kickstart prompt** — spawned terminals now receive a default positional prompt (`Check your relay inbox via mcp__bot-relay__get_messages …`) so they auto-pull pending mail and act on it instead of idling at the `>` prompt. Override per-spawn with `RELAY_SPAWN_KICKSTART="custom prompt"`; disable entirely with `RELAY_SPAWN_NO_KICKSTART=1`.
- **`--permission-mode bypassPermissions` by default** — spawned agents no longer ask the operator to approve every Bash, Edit, or MCP call. Override via `RELAY_SPAWN_PERMISSION_MODE=<mode>` (allowlisted: `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan`). Setting `default` restores the interactive ask-everything behavior.
- **`--name <agent>` by default** — spawned terminals' iTerm2 / Terminal.app titles + Claude Code session-picker labels now show the agent name, so multiple parallel spawn windows are visually distinguishable. Override via `RELAY_SPAWN_DISPLAY_NAME="custom title"`.
- **`--effort high` by default** — children doing mechanical drafting / scoping / research no longer inherit the parent terminal's `xhigh` (or whatever the operator's global default is) and burn tokens unnecessarily. Override via `RELAY_SPAWN_EFFORT=<level>` (allowlisted: `low`, `medium`, `high`, `xhigh`, `max`).

All five new env vars are validated against an allowlist before reaching the assembled command — invalid values exit 2 with a clear error and never embed in the AppleScript-escaped command. Both rejection paths have adversarial test coverage.

No runtime behavior changes for callers that don't spawn agents. Live `:3777` daemon `/health` still reports `{"protocol_version":"2.1.0"}`; only `version` bumps to `2.1.2`.

## v2.1.1 — 2026-04-20 (CI portability patches, no functional changes)

Test-only + CI-plumbing fixes that surfaced when v2.1.0 published to public GitHub and exercised the Ubuntu CI matrix (Node 18 / 20 / 22) for the first time. Zero runtime behavior changes — the relay, protocol, auth, encryption, and MCP contract are identical to v2.1.0.

- **spawn.test.ts** — skip on non-darwin platforms. The test asserts macOS-specific dispatcher behavior (shells to `bin/spawn-agent.sh`); cross-platform coverage lives in `tests/spawn-drivers.test.ts`. On bare Ubuntu CI runners, the Linux driver probes for `gnome-terminal / konsole / xterm / tmux` — none installed — and the dispatcher short-circuits before the mocked `child_process.spawn` is reached. Now skipped with clear rationale comment.
- **backup.test.ts (6)** — explicit 15s timeout on the daemon-probe + forced-restore test. CI disk IO is slower than local macOS; the back-to-back import cycles (safety-backup → extract → integrity-check → atomic swap) exceed the 5s vitest default. Local runs unaffected.
- **vitest.config.ts** — env-gated `testTimeout`: 15s on CI (`process.env.CI`), 5s locally. Webhook-firing tests, HTTP-probe tests, and file-IO-heavy tests occasionally cross 5s on GitHub Actions runners; dev loops stay at 5s to catch real perf regressions.
- **scripts/smoke-25-tools.sh** — `cli:backup` smoke assertion now dumps tar entries + relay stdout on failure. Diagnostic-only; catches intermittent CI flakes with actionable context instead of "tarball missing manifest or relay.db" alone.
- **.github/workflows/ci.yml** — cosmetic: smoke job renamed `22-tool` → `25-tool` (the underlying script was renamed in Phase 5a; workflow label wasn't updated at the time).

No src/ changes. No test assertion weakening. No protocol changes. Same 670 tests under `--full`; same binaries.

## v2.1.0 — 2026-04-19 (architecturally complete, all 14 Codex findings closed)

The v2.1 arc — 28 phases across 5 calendar weeks — closed the remaining architectural gaps surfaced by Codex's mid-sweep design audit. 14 of 14 Codex findings closed. 25 MCP tools. 8 unified-CLI subcommands. Schema version 5 with idempotent migration chain from any prior shape.

### Upgrade guidance

See [`docs/migration-v1-to-v2.md`](./docs/migration-v1-to-v2.md) for the v2.0.2 → v2.1.0 runbook. Key breaking changes:

- Revoked agents require an admin-issued `recovery_token` to re-register (no more silent re-bootstrap via null-hash path). If your workflow relied on revoke-then-register, switch to `revoke_token(issue_recovery=true)` + `register_agent(recovery_token=...)`.
- Ciphertext format versioned to `enc:<key_id>:...`. Legacy `enc1:...` readable forever; tooling grepping for `enc1:` specifically must accept both.
- Standalone `relay-backup` + `relay-restore` bins removed; absorbed into `relay backup` / `relay restore`. Operator scripts must update.

### Phase arc (closed findings + shipped scope)

**Core layer:**
- **2a** — Stop hook for turn-end mail delivery (retro gap A).
- **2b** — Legacy-row migration bypass on plain `register_agent` (retro #3).
- **2c** — `relay backup` / `relay restore` (retro #36) — later absorbed into Phase 4h.

**Release hygiene + CI:**
- **4a** — Pre-publish gate (tsc + vitest + audit + build + drift + smoke) + GitHub Actions CI matrix (Node 18/20/22) + centralized `src/version.ts`.
- **4c.1** — `hono` vulnerability override.
- **4c.2** — `audit_log` retention (90-day default, piggyback purge every N inserts).
- **4c.3** — `schema_info` table + `CURRENT_SCHEMA_VERSION` + `applyMigration(from, to)` registry.
- **4c.4** — DB + config 0600 file perms + 0700 directory perms.

**Security + protocol:**
- **4d** — Dashboard auth + DNS-rebinding + info-disclosure hardening (retro #13).
- **4e** — Webhook hardening bundle (DNS re-check at fire time, idempotency_key, error redaction).
- **4f.1** — stdio `captured_session_id` re-capture on mid-lifetime register_agent.
- **4g** — Structured `error_code` 16-code catalog (retro #22).
- **4i** — `protocol_version` field on register + health_check (retro #42).
- **4n** — Open-bind refusal without `RELAY_HTTP_SECRET` unless `RELAY_ALLOW_OPEN_PUBLIC=1`.
- **4p** — Webhook-secret encryption at rest (Codex R1 HIGH #2).

**Operator tooling:**
- **4h** — Unified `relay` CLI with 6 subcommands (doctor, init, test, generate-hooks, backup, restore); Phase 2c standalone bins absorbed.
- **4j** — `spawn_agent` passes `RELAY_AGENT_TOKEN` to child via macOS inline-export / Linux + Windows env-only paths (retro #48).
- **4k** — Task authorization HIGHs: `post_task_auto` sender-exclusion, `get_task` party-membership (retro adjacent).
- **4o** — `relay recover <agent-name>` — filesystem-gated lost-token recovery.
- **4b.1 v1** → v2 redesign — rotate_token + revoke_token, then full `auth_state` state machine + admin-issued recovery tokens (Codex R1 HIGH #1, R2 HIGH A/B/C/D, R2 MED E/F, R2 LOW G).
- **4b.2** — Managed-agent class + rotation grace + push-message protocol (Codex Q1 hybrid).
- **4b.3** — Keyring-aware encryption with versioned ciphertext + `relay re-encrypt` CLI + `reencryption_progress` table (Codex Q2 hybrid).
- **4q** — Codex MED+LOW batch: MED #3 audit/rate-limit on verified caller, MED #4 webhook retry piggyback on every tool call, MED #5 atomic backup swap, LOW #6 paramsSummary keys, LOW #7 docs path fix.

**Test + release infrastructure:**
- **5a** — Fresh-install smoke: `scripts/smoke-25-tools.sh` (25 tools + 5 CLI subcommands; Phase 5a retires smoke-22).
- **5b** — Load / chaos / cross-version tests under `pre-publish-check.sh --full`.
- **5c** — Automated retro regression: `tests/regression-plug-and-play.test.ts` with 5 canary tests as publish-blockers.
- **6** — Docs sweep: SECURITY.md, CONTRIBUTING.md, docs/migration-v1-to-v2.md, docs/key-rotation.md, docs/managed-agent-protocol.md, README/CLAUDE.md/HANDOFF.md refresh, license headers across src/tests/scripts.

### Numbers

- **MCP tools:** 22 → 25 (+3: `rotate_token`, `rotate_token_admin`, `revoke_token`; `set_status` + `health_check` already in v2.0).
- **CLI subcommands:** 0 → 8 (unified `relay` CLI ships at Phase 4h, extends to 8 with `recover` + `re-encrypt`).
- **Tests:** 383 → 654 default + 16 opt-in = 670 (+287).
- **Schema:** 1 → 5 (one version bump per architectural milestone).
- **Env vars added:** 11 across the phase arc (see HANDOFF.md for the full list).
- **Breaking MCP changes:** 0 — every additive; revoke-flow change is behavior, not shape.

### Discipline principle established

"READ paths stay pure." Precedent across 4b.1 v2 (authenticateAgent), 4b.2 (rotation_grace cleanup in piggyback tick, not authenticateAgent), 4b.3 (decryptContent pure; lazy re-encrypt reserved signal only). Recorded in `devlog/052 §Architectural note` for future phase inheritance.

### What's NOT in v2.1.0

- Idle-terminal wake (no poll unless turn in progress). Managed Agent reference workers (Layer 2) cover the gap for daemon-style agents; humans typing in Claude Code terminals cover the rest. v2.2 concern.
- Federation / multi-machine relay (v2.5).
- Per-capability token scoping (v2.2).
- Post-quantum ciphers (v3.x+).
- Dashboard UI beyond the minimal ops view (v2.2+).

## v2.0.2 — 2026-04-17 (HIGH 1 regression fix — SIGINT handler)

Narrow follow-up to v2.0.1. The dual-model audit of v2.0.1 accepted HIGH 2, HIGH 3, MED 4, and MED 5 as ship-ready, but flagged HIGH 1 as PARTIAL: the CAS DELETE in `unregisterAgent` was correct, but the SIGINT handler in `src/transport/stdio.ts` still carried a fallback chain (`capturedSessionId ?? getAgentSessionId(name) ?? undefined`) that re-introduced both failure modes HIGH 1 was meant to close.

### The regression

Two paths bypassed the captured-session contract:

1. `capturedSessionId = null` (registered via MCP tool after stdio start, or no SessionStart hook) **+ a concurrent terminal had rotated the session** → live-read returned the *new* terminal's session_id → CAS-DELETE wiped the fresh session. Original HIGH 1 bug.
2. `capturedSessionId = null` **+ no agent row** → fallback resolved to `undefined` → `unregisterAgent` fell through to `DELETE FROM agents WHERE name = ?` (by name, no session predicate). Original v2.0 bug surface.

### The fix

`src/transport/stdio.ts` now honours the captured-session contract exactly:

- If `capturedSessionId` is null, the SIGINT handler logs a debug line and no-ops. The process cannot safely identify its own session, so it must not mutate the registry.
- If `capturedSessionId` is set, the handler CAS-deletes with it. Mismatch → silent no-op. Match → clean unregister.
- The unregister logic is now exported as `performAutoUnregister(name, capturedSid, signal)` so tests exercise all three branches without spawning processes and sending real signals.

### Deferred to v2.1 (filed, not fixed here)

- Re-capturing `capturedSessionId` when a later `register_agent` tool call rotates a session for the running stdio process. Currently capture is one-shot at `startStdioServer`. Scope-creep for v2.0.2; the README will be updated in v2.1 to make the SessionStart hook a documented requirement for plug-and-play auto-unregister. Hookless-but-tool-registers paths should run with `RELAY_ALLOW_LEGACY=1` or rely on the 30-day dead-agent purge until then.
- Legacy-row + `register_agent` migration bypass — pre-v1.7 agents with `token_hash IS NULL` currently cannot call `register_agent` to issue a fresh token when `RELAY_ALLOW_LEGACY` is off. The bifurcated register rule was meant to allow migration, but the auth gate rejects before `db.ts:migrateLegacyAgent` can fire. File as v2.1 work.

### Numbers

- 383 tests across 29 files (was 380 across 28; +3 new: null-sid + rotated-session guard, null-sid + no-row no-op, matching-sid regression guard).
- Zero regression on v2.0.1 coverage.
- Clean `tsc --noEmit` + `npm run build`.
- `package.json` bumped to 2.0.2. `/health` reports 2.0.2.

### What's next

v2.0.2 is the npm-publish candidate. Dual-model re-audit → if GREEN, tag + publish.

## v2.0.1 — 2026-04-17 (Publish hardening — Codex audit fixes)

Gate release for npm publish. v2.0.0's dual-model audit (Claude GREEN, Codex NEEDS-PATCH) surfaced 3 HIGH + 2 MEDIUM correctness issues. Honest disclosure: HIGH 1 turns v2.0's plug-and-play handover fix into a footgun in certain race conditions. All five findings addressed before publish.

### HIGH fixes

- **HIGH 1 — Session-scoped auto-unregister.** The stdio SIGINT handler was calling `unregisterAgent(name)` by name only. If a new terminal re-registered the same agent while the old process was still shutting down, the old SIGINT would wipe the fresh session. Fix: the stdio process captures its session_id at startup; `unregisterAgent` now takes an optional `expectedSessionId` and CAS-deletes with `WHERE name = ? AND session_id = ?`. Old session mismatch = silent no-op. Manual `unregister_agent` MCP calls still wipe by name (explicit operator action).
- **HIGH 2 — busy/away TTL + CAS re-check.** A crashed agent that last set `busy` was exempt from health reassignment until the 30-day dead-agent purge — effectively a permanent shield. Fix: new `agents.busy_expires_at` column, `set_status(busy|away)` sets TTL to now + `RELAY_BUSY_TTL_MINUTES` (default 240 min), health monitor treats expired shields as online. Also pushed `agent_status` + TTL check INSIDE the CAS UPDATE WHERE so a mid-flight status change doesn't get clobbered.
- **HIGH 3 — Webhook retry claim crash-safe.** The old claim marker was `next_retry_at = NULL`; a process that crashed between claim and outcome would leave rows stranded forever. Fix: lease-based claim on two new columns `webhook_delivery_log.claimed_at` + `claim_expires_at`. 60-second lease (`RELAY_WEBHOOK_CLAIM_LEASE_SECONDS`). Expired claims are re-claimable by any caller. `recordWebhookRetryOutcome` clears the lease so the next scheduled retry can be claimed.

### MEDIUM fixes

- **MEDIUM 4 — Strict config validation.** `parseInt("3000abc")` used to silently accept garbage-suffixed numbers. Now every integer env var requires pure-digit input (`/^-?\d+$/`). Added: `RELAY_DB_PATH` validation at startup (must resolve under approved roots). Enforced: `RELAY_TRANSPORT` must be exactly `stdio | http | both`. All errors aggregate into one readable `InvalidConfigError` at startup.
- **MEDIUM 5 — Concurrent same-name register warning.** Two terminals with the same `RELAY_AGENT_NAME` will race on register — the second rotates session_id and the first silently loses read continuity. Documented as a v2.0 limitation (full multi-session support deferred to v2.1). `registerAgent` now emits a `log.warn` when it overwrites a session that was online within the last 10 minutes.

### Schema additions (v2.0.1)

All additive and idempotent on top of v2.0.0:
- `agents.busy_expires_at TEXT` — TTL for busy/away shields.
- `webhook_delivery_log.claimed_at TEXT` — lease start.
- `webhook_delivery_log.claim_expires_at TEXT` — lease expiry.

### New env vars

- `RELAY_BUSY_TTL_MINUTES` (default 240) — busy/away shield duration.
- `RELAY_WEBHOOK_CLAIM_LEASE_SECONDS` (default 60) — claim lease duration.

### Numbers

- 380 tests across 28 files (was 367 at v2.0.0; +13 new: 4 session-unregister, 3 busy TTL, 2 webhook lease, 3 strict config, 1 concurrent warning).
- Zero regression on v2.0.0 coverage.
- Clean `tsc --noEmit` + `npm run build`.
- `package.json` bumped to 2.0.1. `/health` reports 2.0.1.

### What's next

v2.0.1 is the npm-publish candidate — gated on dual-model re-audit. If GREEN, tag + publish. If another HIGH surfaces, v2.0.2 continues the hardening cycle.

## v2.0.0 — 2026-04-17 (Plug-and-play release)

**This is the flagship v2 release.** Everything works out of the box. Install, register, use — nothing else to configure, no conventions to remember. The guiding principle, from Maxime: if a user needs to remember a convention to avoid failure, that is a relay bug.

v2.0.0 bundles the v2.0.0-alpha (data structures), v2.0.0-beta (smart routing), v2.0.0-beta.1 (Codex audit fixes), and v2.0.0 final scope into one shipping version. This is also the npm-publish candidate, gated on a final dual-model audit.

### New tools (22 total, +8 since v1.11)

- `post_task_auto` — capability-based task routing with a queue fallback for when no agent matches.
- `create_channel` / `join_channel` / `leave_channel` / `post_to_channel` / `get_channel_messages` — multi-agent coordination channels.
- `set_status` — agent signals `online` / `busy` / `away` / `offline`. Busy/away exempt the agent from health-monitor task reassignment.
- `health_check` — monitoring tool returning status, version, uptime, and live counts (agents / messages / tasks / channels). Auth-free so scripts can probe without a token.

### New concepts

- **Task lease + heartbeat.** Accepted tasks carry `lease_renewed_at`. Long-running assignees must call `update_task heartbeat` to keep the lease fresh; otherwise the lazy health monitor requeues the task after the grace window (default 120 minutes, see `RELAY_HEALTH_REASSIGN_GRACE_MINUTES`).
- **Lazy health monitor.** No daemon, no timer. Piggybacks on `get_messages`, `get_tasks`, and `post_task_auto`. Requeues only when lease is stale AND assignee is stale (or unregistered) AND assignee is not `busy`/`away`.
- **Session-aware read receipts.** Every `register_agent` rotates the agent's `session_id`. New terminal = new session = previously-read messages reappear. Solves the "hand-over-loses-mail" bug. Opt-out: `status='all'` returns everything regardless of session.
- **Capability-based routing.** `post_task_auto` picks the least-loaded agent whose capabilities are a superset of the task's required capabilities. If no match, queues until a capable agent registers.
- **CAS on every mutation.** Task updates (accept/complete/reject/cancel), task assignments (auto + queue pickup), health requeues, webhook retry claims — all use compare-and-swap. Concurrent callers cannot clobber each other; losers see `ConcurrentUpdateError` with guidance to re-read and retry.
- **Webhook retry with backoff.** 3 attempts at 60s / 300s / 900s. CAS-claimed. Piggybacks on webhook-firing tool calls — no background thread.
- **Auto-unregister on terminal close.** SIGINT/SIGTERM handler in stdio transport removes the agent from the registry. Hard kills still fall through to the 30-day dead-agent purge.
- **Payload + body size limits.** Zod `.refine` on every content field caps each message at `RELAY_MAX_PAYLOAD_BYTES` (default 64KB). Outer Express body-parser caps at 1MB.
- **Config validation at startup.** Bad env/config fails fast with a clear aggregate error message instead of cryptic runtime failures.
- **File transfer convention.** `_file` pointer pattern documented at `docs/file-transfer.md`. Relay stays opaque — receivers validate path, size, hash, and never execute without sandboxing.

### Schema additions (v2.0 final migration)

All additive and idempotent. Upgrades from v1.11.x are zero-downtime.

- `agents.session_id TEXT` — UUID, rotates on every register. Powers session-aware reads.
- `agents.agent_status TEXT NOT NULL DEFAULT 'online'` — operational status distinct from presence.
- `agents.description TEXT` — optional human-readable description, shown in discover + dashboard.
- `messages.read_by_session TEXT` — session that read this message.
- `tasks.required_capabilities TEXT` — JSON array for routing + queue-reassignment.
- `tasks.lease_renewed_at TEXT` — task-level liveness signal.
- `tasks.to_agent` — rebuilt nullable (via transactional CREATE + INSERT + DROP + RENAME) so queued tasks can exist without an assignee.
- `webhook_delivery_log.retry_count / next_retry_at / terminal_status` — retry bookkeeping.
- `channels` + `channel_members` + `channel_messages` tables.
- `agent_capabilities` — normalized index for O(1) capability lookup in routing.

### New env vars

- `RELAY_MAX_PAYLOAD_BYTES` (default 65536) — per-field content byte limit.
- `RELAY_HTTP_BODY_LIMIT` (default `1mb`) — Express body-parser outer bound.
- `RELAY_LOG_LEVEL` (default `info`) — `debug` / `info` / `warn` / `error`. Supersedes `RELAY_LOG_DEBUG=1` (still honored for back-compat).
- `RELAY_HEALTH_REASSIGN_GRACE_MINUTES` (default 120) — lease expiry window.
- `RELAY_HEALTH_SCAN_LIMIT` (default 50) — max tasks per lazy scan.
- `RELAY_HEALTH_DISABLED` — emergency off-switch for the health monitor.
- `RELAY_AUTO_ASSIGN_LIMIT` (default 20) — max queued tasks assigned per register sweep.
- `RELAY_WEBHOOK_RETRY_BATCH_SIZE` (default 10) — max retries processed per piggyback.

### Hook script improvements

Both `check-relay.sh` (SessionStart) and `post-tool-use-check.sh` (PostToolUse) now self-check `$0` at entry. If the install path looks truncated (spaces not quoted in `.claude/settings.json`), the hook emits a stderr warning. Never silent-fails on misconfiguration.

### Behavior changes (breaking for long-running assignees)

- `touchAgent` no longer renews task leases as a side effect. Only task-specific updates on that row (accept, heartbeat, complete, reject, cancel) renew `lease_renewed_at`. Long-running work must heartbeat.
- `to_agent` is nullable on `tasks`. Callers that assumed it is always a string must handle null for queued tasks.
- `TaskStatus` union expanded to include `queued` and `cancelled`.
- `TaskAction` union expanded to include `cancel` and `heartbeat`.

### Security

- `ConcurrentUpdateError` on CAS mismatch — no silent overwrites under contention.
- Health-monitor CAS re-checks agent liveness inside the WHERE clause; a heartbeat between scan and requeue wins.
- `processDueWebhookRetries` runs on every webhook-firing tool call but CAS-claims each job, preventing double delivery.
- `RELAY_HTTP_SECRET` must be ≥32 characters when set (enforced at startup).
- `RELAY_ENCRYPTION_KEY` must decode to exactly 32 bytes (enforced at startup).

### Numbers

- 22 MCP tools (was 14 at v1.11.1).
- 367 tests across 27 files (was 306 at v1.11.1; +61 tests).
- Zero regression across v1.x and v2 alpha/beta/beta.1 coverage.
- Clean `tsc --noEmit` + `npm run build`.

### Deferred to v2.1+

Full backlog at `plug-and-play-retro.md`. Highlights deliberately left for later versions:

- Legacy auto-migration (v2.1)
- Token rotation tool (v2.1)
- Message threading / reply chains (v2.1)
- Task dependencies + timeout (v2.1)
- CLI tooling: `relay doctor` / `relay init` / `relay test` / `relay generate-hooks` (v2.2)
- Batch + fan-out operations (v2.2)
- Private channels + per-channel permissions (v2.2)
- E2E message encryption, federation (v2.5)

---

## v2.0.0-beta.1 — 2026-04-17 (Codex audit fixes — rolled into v2.0.0)

Main Victra ran a Codex audit on beta. Four HIGH + two MEDIUM + one LOW findings — all valid. Beta.1 closes every HIGH before v2.0.0 final work starts (foundation-before-features).

### HIGH fixes

- **HIGH 1 — Health monitor requires both lease expired AND assignee stale.** Previous check looked only at `lease_renewed_at`. An alive-but-observing agent could lose active tasks. Fixed by joining `agents` into the scan + CAS: a task is requeued only when its assignee is offline (`last_seen < grace`) or the agent is no longer registered. Also adds two new health tests: "alive-quiet assignee doesn't requeue" and "unregistered assignee requeues".
- **HIGH 2 — CAS on every `updateTask` mutation.** accept / complete / reject / cancel were pre-read-then-update, allowing concurrent clobber. Now every mutation uses `UPDATE ... WHERE id=? AND status=? AND (to|from)_agent=?` and raises `ConcurrentUpdateError` if 0 rows change. The pre-read still powers authz + transition error messages but is no longer authoritative.
- **HIGH 3 — Lease renewal decoupled from `touchAgent`.** `touchAgent` no longer bumps `tasks.lease_renewed_at`. Only task-specific actions (accept, heartbeat, and any update on that exact row) renew the lease. An agent can no longer keep abandoned tasks alive by doing unrelated work. Side effect: long-running assignees must periodically call `update_task heartbeat` to keep their lease fresh.
- **HIGH 4 — Auto-assign moved into `registerAgent()`.** Was wired only in `handleRegisterAgent`, so non-MCP callers silently lost the sweep. `registerAgent` now returns `{agent, plaintext_token, auto_assigned}` and every caller gets the assignments (handler still fires webhooks off the returned list, circular-import-safe).

### MEDIUM / LOW fixes

- **MEDIUM 5 — `postTaskAuto` pick+insert is transactional.** Wrapped the SELECT candidates + INSERT picked inside a `db.transaction()` (BEGIN IMMEDIATE) so two concurrent callers can't both pick the same least-loaded agent. Strict across-process serialization.
- **MEDIUM 6 — Real OS-process concurrency test.** New test spawns 5 child processes competing for 1 queued task via the CAS UPDATE pattern. Asserts `totalClaimed === 1`. Proves CAS under genuine contention, not just sequential-same-process.
- **LOW 7 — Empty `required_capabilities` throws.** Defense-in-depth guard inside `postTaskAuto` (zod already enforces `.min(1)` at the tool surface, but direct callers bypass that).

### Numbers

- 346 tests across 26 files (was 338; +8: three health-monitor variants, three CAS-on-updateTask variants, empty-caps guard, real-concurrent child-process test).
- Zero regression on pre-beta (all v1.x tests + alpha tests unchanged).
- Clean `tsc --noEmit` + `npm run build`.
- Still no `package.json` bump (same policy as beta — version bump is for v2.0.0 final).

### Files changed since beta

- `src/db.ts` — `touchAgent` (HIGH 3), `updateTask` CAS refactor (HIGH 2), `runHealthMonitorTick` agent-status join (HIGH 1), `postTaskAuto` transaction wrap + empty-caps guard (MEDIUM 5 + LOW 7), `registerAgent` returns `auto_assigned` (HIGH 4), new `ConcurrentUpdateError` class.
- `src/tools/identity.ts` — reads `auto_assigned` from `registerAgent` return instead of calling the helper separately.
- `tests/beta-smart-routing.test.ts` — updated 4 tests to match new semantics, added 8 new tests.

## v2.0.0-beta — 2026-04-17 (Smart routing + lease heartbeat + lazy health monitor — rolled into v2.0.0)

Second v2.0 sub-release. Working tree only — not published, not version-bumped in package.json yet. Checkpointing to main Victra before the final v2.0.0 sub-release (file transfer conventions + webhook retry with CAS).

### What ships

- **`post_task_auto`** (new MCP tool, 20 total) — picks the least-loaded agent whose `agent_capabilities` rows are a superset of the task's `required_capabilities`. Tie-break: freshest `last_seen`. If no agent matches, task is stored with `status='queued'`, `to_agent=NULL`; it will be auto-assigned when a capable agent registers.
- **Task lease heartbeat** — `tasks.lease_renewed_at` is set on accept, implicitly renewed when the assignee makes any tool call that currently bumps `agents.last_seen` (send_message / broadcast / post_task / update_task / post_task_auto), and NOT renewed by observation tools (get_messages / get_tasks / discover_agents) — same v1.3 presence-integrity split applied to task leases.
- **`heartbeat` action on `update_task`** — explicit lease renewal, no state change. Only the assignee, only when status=`accepted`. No webhook (would be too noisy).
- **`cancel` action on `update_task`** — only the requester (`from_agent`) can cancel. Allowed from `queued`, `posted`, `accepted`; rejected from terminal states. Fires `task.cancelled`.
- **Lazy health monitor** — no background timer. Piggybacks on `get_messages`, `get_tasks`, and `post_task_auto`. Scans for accepted tasks where `lease_renewed_at` is older than the grace window (default 120 min via `RELAY_HEALTH_REASSIGN_GRACE_MINUTES`). CAS-requeues them (`to_agent=NULL`, `status=queued`). Fires `task.health_reassigned`. Bounded by `RELAY_HEALTH_SCAN_LIMIT` (default 50). Emergency off-switch: `RELAY_HEALTH_DISABLED=1`.
- **Auto-assign on register** — when a new or re-registered agent comes online, the server sweeps queued tasks whose `required_capabilities` are a subset of the agent's capabilities and CAS-assigns them. Bounded by `RELAY_AUTO_ASSIGN_LIMIT` (default 20). Fires `task.posted` with `auto_assigned_from_queue=true`.

### Schema

- New column `tasks.required_capabilities TEXT` (JSON array). Null for v1.x tasks.
- Column `tasks.to_agent` is now nullable (rebuilt in-place via a transactional `CREATE new + INSERT + DROP + RENAME` — additive, idempotent, preserves all existing rows).
- Column `tasks.lease_renewed_at` is now wired (was declared in alpha; beta consumes it).

### Adversarial tests (19 new, beta-smart-routing.test.ts)

- Auto-routing (8): no-match → queued, single match routing, least-loaded preference, tie-break on last_seen, strict capability superset filter, queued pickup on register, queue CAS prevents double-assign, requester can cancel queued.
- Health + leases (11): lease stamped on accept, active tools bump lease/observation does not, heartbeat renews/authz/status checks (3), expired lease requeues with full CAS chain, CAS short-circuits on fresh lease, `RELAY_HEALTH_DISABLED` off-switch, cancel by requester (3 variants including terminal-state rejection).

### Bug fix surfaced during beta

- `WasmDatabase.exec()` was unconditionally calling `flush()` even inside an open transaction — `db.export()` mid-transaction silently lost pending DDL. Now gated on `txDepth === 0` (same guard the `prepare→run` path already used). Only observed when beta's in-place column rebuild attempted `CREATE TABLE` + `INSERT SELECT` in a single transaction; existing wasm tests did not exercise intra-transaction `exec()`.

### Numbers

- 338 tests across 26 files (was 319; +19 new beta tests).
- Zero regression on alpha (all 319 still green, including 15 wasm tests that were unaffected once the exec/flush bug was patched).
- Clean `tsc --noEmit`.
- No `package.json` version bump yet — that happens at v2.0.0 final.

### What's deliberately deferred to v2.0.0 final

- File transfer convention docs (`_file` metadata receiver-validation guidelines).
- Webhook retry with CAS (schema already in alpha: `retry_count`, `next_retry_at`, `terminal_status`).
- `package.json` version bump.
- Full CHANGELOG / README polish pass.

## v1.11.1 — 2026-04-17 (Dual-model audit fixes — first Claude + Codex/GPT review)

**Milestone: first dual-model audit.** Claude GREEN'd the v1.11.0 release ("does the code do what it claims?"). A parallel Codex/GPT audit ("what happens when things go wrong?") found 3 HIGH + 1 MEDIUM issue Claude missed. Different model families, different blind spots — pattern proved its value.

### Fixes

- **HIGH 1 — Flush fail-closed:** `flush()` no longer silently swallows disk-write errors. Emscripten `ErrnoError` from `db.export()` is caught as warn-level (in-memory data safe; export glitch non-fatal). Real `fs.writeFileSync` errors (ENOSPC, EACCES) propagate and fail the operation.
- **HIGH 2 — Nested transaction compat:** Inner transactions now use `SAVEPOINT sp_N / RELEASE sp_N` instead of bare `BEGIN TRANSACTION` (which errors on SQLite: "cannot start a transaction within a transaction"). Matches better-sqlite3 semantics.
- **HIGH 3 — Init race condition:** `initializeDb()` caches its promise. Concurrent callers share one in-flight initialization — no more two independent wasm DB instances against the same file.
- **MEDIUM 4 — lastInsertRowid:** Now queries `SELECT last_insert_rowid()` via a prepared statement before flush. Returns real rowid (was hardcoded 0).
- **Bonus fix:** journal_mode pragma now skipped entirely on wasm (was `DELETE`, which threw Emscripten FS error). In-memory databases use memory journaling by default.

### Numbers

- 306 tests across 24 files (was 302; +4 new: reopen persistence, nested transaction, concurrent init, lastInsertRowid).
- Zero regression on native (291 existing tests unchanged).

## v1.11.0 — 2026-04-17 (SQLite WASM driver — zero native compilation)

`better-sqlite3` requires a C++ compiler at `npm install` time. This blocks Windows (Visual Studio Build Tools), Alpine/musl Linux (build-essential), Docker (200MB+ toolchain), CI, and ARM cross-compilation. v1.11 adds `sql.js` (SQLite compiled to WebAssembly) as an opt-in alternative behind `RELAY_SQLITE_DRIVER=wasm`.

### What ships

- **`src/sqlite-compat.ts`** — `CompatDatabase` / `CompatStatement` adapter that wraps sql.js behind a better-sqlite3-compatible API. All 731 lines of SQL queries in `src/db.ts` work identically on both drivers — zero query changes.
  - `WasmStatement`: wraps sql.js's `prepare→bind→step→getAsObject→free` into better-sqlite3's `.run()`, `.get()`, `.all()` API.
  - `WasmDatabase`: wraps sql.js's `Database` with write-back-to-file after every write (`db.export()` + `fs.writeFileSync`), transaction support (depth-tracked `BEGIN→COMMIT/ROLLBACK` with flush suppression inside transactions), `pragma()` interception (WAL gracefully degrades to DELETE, busy_timeout is no-op).
  - `initializeDb()` async factory: native path is sync under the hood; wasm path loads the wasm binary asynchronously at startup then all subsequent queries are sync.

- **`sql.js` in `optionalDependencies`** — `npm install` does not force it. Users who want wasm install it explicitly with `npm install sql.js`.

- **`src/db.ts` changes (minimal):**
  - Import type changed from `Database.Database` to `CompatDatabase`.
  - `getDb()` fallback path preserved for native (backward compat with tests that don't call `initializeDb()`).
  - New `initializeDb()` async export called from `src/index.ts` at startup.
  - All SQL queries, migrations, purge logic: **unchanged**.

- **`src/index.ts`** — `getDb()` call replaced with `await initializeDb()`.

- **`tests/db-wasm.test.ts`** — 11 new tests: agent ops (create, re-register cap immutability, filter by role), messaging (send+get, mark-as-read, broadcast), tasks (post→accept→complete, get_tasks), wasm-specific (getDb works, WAL degrades gracefully, sequential writes don't corrupt).

- **`docs/sqlite-wasm-driver.md`** — when to use, how to switch, performance notes, limitations (single-process only, no WAL, write-back latency, crash durability).

- **README "SQLite Driver Options" section** — quick reference linking to the full docs.

### Limitations (documented, not worked around)

1. **Single-process only.** sql.js operates in-memory with write-back. Two processes sharing the same DB file overwrite each other's changes. Multi-terminal stdio setups (each terminal = its own MCP process) MUST use native. HTTP transport (single daemon) is safe.
2. **No WAL mode.** wasm uses `journal_mode=DELETE`. At our scale this is imperceptible.
3. **Write-back latency.** Full DB export + `fs.writeFileSync` after every write. At < 1MB: sub-millisecond. At larger sizes: could be noticeable.
4. **Crash durability.** Same as native WAL — last write may be lost if process crashes between the write and the flush.

### Numbers

- 302 tests across 24 files (was 291; +11 new wasm tests).
- Clean `tsc` compile.
- Zero regression on native driver (all 291 existing tests pass unchanged).
- sql.js in optionalDependencies (no forced install).

### What was deliberately NOT done

- No refactor of src/db.ts into src/db/ module (adapter pattern kept it surgical).
- No making wasm the default (native is default, explicit opt-in only).
- No multi-process wasm support (documented as single-process-only).
- No custom wasm binary compilation (uses sql.js's pre-compiled binary).
- No changes to spawn / auth / hooks / webhooks / encryption / CIDR / dashboard.
- No v2.0 intelligence layer work. No npm publish.

## v1.10.0 — 2026-04-17 (Layer 2: Managed Agent integration — docs + reference workers)

Layer 2 of the four-layer delivery architecture. Non-Claude-Code agents (Python daemons, Node workers, Hermes/Ollama integrations, custom scripts) can now integrate with the relay using a comprehensive guide and two runnable reference implementations.

### What ships

- **`docs/managed-agent-integration.md`** (~350 lines) — full integration guide:
  - Mental model: how a Managed Agent (non-Claude-Code) fits alongside existing terminals.
  - Three transport options: HTTP (recommended), direct SQLite (same-machine), webhook subscription (event-driven).
  - Auth flow: first-time registration → token persistence → subsequent calls (header / arg / env) → capability declaration (immutable, per v1.7.1) → token rotation.
  - Lifecycle: startup → operating loop (poll and/or webhook) → SIGINT/SIGTERM clean shutdown with `unregister_agent`.
  - Error handling: retry-with-backoff on network, no-retry on 401, rate-limit handling, structured tool-error responses.
  - Security notes: never commit tokens, prefer HTTPS in production, scope capabilities narrowly, enable encryption at rest.
  - FAQ: cross-layer messaging, multiple agents same name, relay URL discovery, client library roadmap, relay restarts, direct agent-to-agent.

- **`examples/managed-agent-reference/python/agent.py`** (~200 LOC, stdlib-only) — single-file Python script using `urllib`. Demonstrates: register, send_message, get_messages, post_task (via check_tasks), update_task, discover_agents, unregister_agent. SIGINT handler. Inline comments teach the protocol. No pip dependencies.

- **`examples/managed-agent-reference/node/agent.js`** (~200 LOC, stdlib-only) — parallel Node implementation using `node:http`. Same coverage and structure. No npm dependencies.

- Both examples have a **`SMOKE.md`** with a 5-step manual verification checklist: start the agent, verify in `discover_agents`, send a test message, post a test task, Ctrl-C and verify clean unregister.

- **README** — new "Layer 2: Managed Agents" section linking to the guide and reference scripts.

- **CLAUDE.md** — `examples/` directory added to file map, status line updated.

### Fold-in from re-review 10

- **tmux birthday-paradox math precision fix** — `docs/cross-platform-spawn.md` now says "50% at 362, 1% at 36, 0.1% at 11" instead of the directionally-correct-but-imprecise "~256." Per main Victra's re-review 10 note.

### Numbers

- 291 tests across 23 files — **unchanged**. src/ has zero changes; this is a docs + examples release.
- Clean `tsc` compile.
- No new MCP tools, no schema changes, no auth / hook / spawn / server code changes.

### What was deliberately NOT done

- **No src/ code changes.** Managed Agents use the existing 14 MCP tools via the existing HTTP transport. If a future version needs server-side ergonomic improvements, it ships separately.
- **No client library.** The reference scripts (~200 LOC each) are intentionally minimal so integrators see the protocol clearly and can port to any language.
- **No Docker / systemd / launchd templates.** Deployment environments vary; the reference scripts teach the protocol, not the hosting.
- **No webhook-push-via-relay feature.** Agents that cannot accept inbound HTTP should poll.
- **No v1.11 sqlite-wasm work, no v2.0 intelligence layer, no v2.5 federation.**
- **No npm publish.**

## v1.9.1 — 2026-04-16 (Cross-platform spawn hardening)

Closes three blockers + four fold-ins surfaced by main Victra's re-review 9 of v1.9.0. Verdict for v1.9.0 was "foundation solid" with real seams to close — exactly what the v1.9 post-build section predicted. Foundation-before-features: ships before v1.10.

### Blockers closed

**1. Adversarial payload parity on Linux + Windows drivers.** v1.9.0 had zero hostile-input tests against the Linux or Windows drivers — only the zod schema layer protected them. v1.9.1 adds ~30 mock-level adversarial tests covering the same payload classes as the macOS integration suite: name/role injection (`;`, `|`, `&`, `$(cmd)`, backtick, newline, quotes), cwd injection (substitution, CRLF, null byte, relative paths), length limits (name > 64, cwd > 1024), override case-variance + unknown values. Each test asserts either (a) zod throws at the boundary, or (b) the constructed argv is provably safe — payload appears as its own argv element, never concatenated into a shell-interpreted string.

**2. Linux tmux single-quote POSIX escape.** The Linux driver's launch command `cd '<cwd>' && exec claude` single-quotes cwd. Today zod blocks `'` in cwd so this is not exploitable, but it is a single point of defense. v1.9.1 adds the standard POSIX `'\''` escape (close quote, literal quote, reopen) via a new `escapeSingleQuotesPosix` helper in `src/spawn/validation.ts`. A defense-in-depth test fabricates an input bypassing zod and asserts the escape is applied correctly. Mirrors the `printf %q` pattern in `bin/spawn-agent.sh`.

**3. tmux session-name collision.** v1.9.0 used the agent name directly as the tmux session name — two agents with the same relay name silently collided (`tmux new-session` fails on duplicate session names, but nothing surfaces to the caller). v1.9.1 appends a 4-hex random suffix from `crypto.randomBytes(2)` to the tmux session name. The agent's registered relay identity is unchanged (peers discover by relay name; only the tmux binding carries the suffix). Actual session name is logged to stderr at spawn time so operators see what to `tmux attach -t <agent>-<4hex>`. Entropy 16 bits = 65,536 values; collision probability negligible for any realistic workload.

### Fold-ins

**4. Cross-platform cwd rejection.** `normalizeCwd` in `src/spawn/validation.ts` now throws when passed a cwd that is nonsensical for the target platform: drive-letter paths (`C:\`, `D:/`) on POSIX, non-absolute paths on Windows. Three new fold-in tests assert these.

**5. Honest-caveats section updated.** This entry explicitly lists the tmux collision closure. The `expected re-review findings` paragraph in `devlog/018` has been trued up by `devlog/019`'s post-build section.

**6. Platform-aware `RELAY_TERMINAL_APP` override.** `resolveTerminalOverride` now takes the current platform as its second argument. Cross-platform names (e.g., `gnome-terminal` on macOS) are treated as invalid and fall through to auto-detect with a platform-specific stderr warning listing the valid choices. Previously: silently accepted then ignored by the macOS driver. Now: rejected consistently.

**7. PowerShell single-quote edge.** The Windows PowerShell driver's `Set-Location -LiteralPath '<cwd>'` now routes through a new `escapeSingleQuotesPowershell` helper implementing PowerShell's own `''` doubling rule. A defense-in-depth test fabricates an input bypassing zod and asserts the doubling is applied. Same motivation as blocker 2.

### Numbers

- 291 tests across 23 files (was 260; +31). Spawn-drivers test file: 21 → 53. Zero regression in the 5 `spawn.test.ts` handler tests or the 22 `spawn-integration.test.ts` macOS payload tests — the macOS shell script is still frozen at v1.6.4.
- Clean `tsc` compile.
- No new MCP tools, no schema changes, no auth/hook/server changes. Pure hardening patch inside the `src/spawn/` module.

### What did the adversarial tests actually find?

Honest answer: **they confirmed existing hardening rather than surfacing new bugs.** zod's `SpawnAgentSchema` rejected every hostile input class cleanly at the boundary. The defense-in-depth tests (blocker 2 + fold-in 7) verified the per-driver escape helpers work — both are also no-ops today on legitimate input, so there was nothing to fix operationally. Net value: regression protection for future zod changes, plus explicit coverage that makes the per-platform safety story auditable without reading the whole source tree.

### What was deliberately NOT done

- No changes to `bin/spawn-agent.sh` — frozen at v1.6.4.
- No real-subprocess Linux/Windows CI infrastructure. Manual smoke checklists in `docs/cross-platform-spawn.md` remain authoritative.
- No new drivers. SSH / container / remote spawn still blocked on v2.5.
- No new MCP tools, no schema, no auth, no hook, no server code.
- No v1.10 work. No npm publish.

## v1.9.0 — 2026-04-16 (Cross-platform spawn — Linux + Windows support)

Abstracts the `spawn_agent` backend so the relay works on macOS, Linux, and Windows without modification. macOS keeps the proven `bin/spawn-agent.sh` (untouched from v1.6.4); Linux and Windows get fresh TypeScript drivers.

### Why Node/TypeScript over extending bash

Windows ships without bash by default (no WSL, no Git Bash, no Cygwin). A future `npm install -g bot-relay-mcp` user on stock Windows would hit a wall if the spawn driver were bash-based. Node is already a hard requirement (the MCP server runs on Node), so choosing Node for the driver introduces zero new dependencies while unlocking Windows as a first-class target. `src/types.ts` `SpawnAgentSchema` (zod + allowlist regexes) becomes the single source of validation truth — the bash shell's duplicate allowlist is now one driver among several, not a parallel rulebook to drift out of sync.

### What ships

- **`src/spawn/` module** — new home for the driver abstraction:
  - `types.ts` — `SpawnDriver` interface + `SpawnCommand` shape.
  - `validation.ts` — `resolveTerminalOverride()` (allowlist-gated env-var override), `normalizeCwd()` (POSIX/Windows separator handling), `buildChildEnv()` (principle-of-least-authority env propagation).
  - `dispatcher.ts` — picks a driver via env override > `process.platform` > per-platform fallback. ONLY code path that calls `child_process.spawn`; drivers are pure on the build side (mockable in tests).
  - `drivers/macos.ts` — thin wrapper that shells to `bin/spawn-agent.sh` with the same `[name, role, caps, cwd]` args. Preserves the 3-layer hardening + 19-payload adversarial suite unchanged.
  - `drivers/linux.ts` — fallback chain `gnome-terminal → konsole → xterm → tmux`. tmux fallback creates a detached session (`tmux attach -t <agent>` to enter). Headless servers covered.
  - `drivers/windows.ts` — fallback chain `wt.exe → powershell.exe → cmd.exe`. Forward-slash CWDs normalized to backslashes at the validation boundary. Avoids cmd.exe quoting landmines by keeping args separate (no monolithic command string).

- **`src/tools/spawn.ts` refactored** to delegate to `spawnAgent()` from the dispatcher. Response includes `platform` and `driver` fields so callers can see which sub-driver ran. Error hints are platform-specific.

- **`tests/spawn-drivers.test.ts`** — 21 new mock tests covering:
  - Linux fallback chain (all four sub-drivers picked correctly, error on none available, override honored, override falls through if binary missing).
  - Windows fallback chain (wt/powershell/cmd picked correctly, error on all missing, CWD backslash normalization).
  - macOS driver builds the right bash-script invocation.
  - `resolveTerminalOverride` allowlist gating (accepts every allowed name case-insensitively, rejects everything else).
  - `buildChildEnv` principle-of-least-authority (propagates `RELAY_*` + system essentials; does NOT propagate `AWS_SECRET_ACCESS_KEY` / `GITHUB_TOKEN`).
  - Platform-aware CWD normalization.

- **`docs/cross-platform-spawn.md`** — new docs: driver selection flowchart, per-platform install requirements, `RELAY_TERMINAL_APP` override semantics, env-var propagation policy, manual smoke-test checklists (macOS + Linux + Windows), troubleshooting.

- **README + CLAUDE.md** updated — tool table entry no longer says "macOS only"; new section after the Near-Real-Time Mail Delivery block; CLAUDE.md file map lists the new `src/spawn/` structure.

### Numbers

- 259 tests across 23 files (was 238; +21 new driver tests).
- Zero regression on macOS: `tests/spawn.test.ts` (5) and `tests/spawn-integration.test.ts` (22) still green — `bin/spawn-agent.sh` is unchanged.
- Clean `tsc` compile.
- No new MCP tools. No schema changes. No auth / hook / server code changes.

### Env-var propagation — principle of least authority

Spawned agents receive a minimal env by default:
- System essentials: `PATH`, `HOME`/`USERPROFILE`, `LANG`, `TERM`, `SHELL` (POSIX), Windows-specific (`SYSTEMROOT`, `APPDATA`, etc.).
- Anything prefixed with `RELAY_*`.
- Explicitly set from the spawn call: `RELAY_AGENT_NAME`, `RELAY_AGENT_ROLE`, `RELAY_AGENT_CAPABILITIES`.

Arbitrary parent env vars (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `OPENAI_API_KEY`, ...) do NOT propagate. Operators who need custom forwarding can prefix their var with `RELAY_`.

### `RELAY_TERMINAL_APP` override

Allowlist-gated string that forces a specific sub-driver: `iterm2`, `terminal`, `gnome-terminal`, `konsole`, `xterm`, `tmux`, `wt`, `powershell`, `cmd`. Unknown values are ignored (fall through to auto-detect) with a stderr warning — never silent. If the forced sub-driver's binary is not on PATH, the driver treats it as unavailable and walks the chain normally.

### Tested on

- **macOS** — full CI (existing 27 spawn tests green).
- **Linux + Windows** — mock-only in CI (21 new driver tests). Real-subprocess testing is **manual smoke** per `docs/cross-platform-spawn.md`. No Linux/Windows CI infrastructure was built — scope creep for v1.9.

### What was deliberately NOT done

- **No pure-TS macOS driver.** The existing shell script has a proven adversarial test suite and is left alone.
- **No rewrite of `bin/spawn-agent.sh`.** Frozen at v1.6.4 state.
- **No Linux / Windows CI.** Manual smoke documented instead.
- **No new MCP tools.**
- **No schema changes.**
- **No auth / hook changes.**
- **No v1.10 / v1.11 work.**
- **No npm publish.**

### Honest caveats

- Linux and Windows drivers have never run a real subprocess in CI — only mock tests. First real user on those platforms may hit seams the mocks did not catch. Expect a v1.9.1 patch cycle.
- Linux tmux fallback uses session-only invocation (no window) — correct for headless servers, but operators used to a GUI window may be momentarily confused. `tmux attach -t <agent>` is documented.
- Windows paths with embedded quotes are not specifically tested. The zod allowlist forbids quotes so this should be unreachable, but flag if found.

## v1.8.1 — 2026-04-16 (Docs correction — quoted-path install guidance)

**Docs-only. No code change.**

v1.8.0 shipped the `PostToolUse` hook correctly, but the install docs did not teach readers that paths containing spaces must be single-quoted inside the JSON string of `.claude/settings.json`. Claude Code passes the `command` field to `/bin/sh`, which splits on whitespace — installations at paths like `/Users/name/Documents/Ai stuff/bot-relay-mcp/...` silently fail with `/bin/sh: ... is a directory` and no surfaced diagnostic.

### What ships

- README "Near-Real-Time Mail Delivery" — important callout immediately after the copy-paste JSON block, with a concrete real-world quoted-path example alongside the generic `/path/to/...` template.
- `docs/post-tool-use-hook.md` — fuller callout in the install section explaining the shell-quoting mechanics (outer JSON double-quotes, inner shell single-quotes), plus a diagnostic command (`sh -c "$COMMAND"`). Troubleshooting section gains a named entry: **"Hook silently fails on paths with spaces"** — so readers with a broken install can grep for the symptom and land on the fix.
- Version bump to 1.8.1 across `package.json`, `src/server.ts`, `src/transport/http.ts`, CLAUDE.md, HANDOFF.md.

### Why this earns a patch release, not a fold-in to v1.9

Maxime's rule: v1.8 (the PostToolUse hook foundation) must be solid before v1.9 (cross-platform spawn) starts. A silent-failure install path on any machine whose workspace lives at a space-containing path is a broken first-run experience. Fixing it in a clean patch release preserves the foundation-before-features invariant and the project's clean-patch-release discipline.

### What was deliberately NOT done

- No code changes. The hook script is correct as shipped.
- No test churn. 238 tests pass unchanged; docs are not under test. (The optional embedded-JSON-parse test from Victra's brief did not apply — no embedded example exists in source.)
- No SessionStart-hook `docs/hooks.md` parallel patch. Out of scope for this patch — if the same guidance belongs there too, it queues as a separate doc ticket.

## v1.8.0 — 2026-04-15 (Layer 1 PostToolUse hook — near-real-time mail delivery)

Closes the human-bridged latency between agents. A new `PostToolUse` hook checks the mailbox after every tool call and surfaces pending messages as `additionalContext` so the running Claude Code session picks them up immediately — no waiting for the next `SessionStart` or a human-pasted "check mail."

### What ships

- **`hooks/post-tool-use-check.sh`** — per-project hook script.
  - HTTP path preferred when `RELAY_AGENT_TOKEN` is set and the daemon responds on `/health` within 1s (full auth + audit pipeline; server-side atomic mark-as-read).
  - Sqlite-direct fallback for stdio-only deployments (reads pending rows, marks surfaced IDs read via a follow-up UPDATE per-ID).
  - 2s self-imposed budget (1s health probe + 2s `get_messages`).
  - Never re-registers (that is the SessionStart hook's job).
  - Never reads stdin (mail check is tool-agnostic; the tool-call payload is ignored).
  - Silent-fails on any error — empty stdout, exit 0 — never pollutes the conversation with error text or partial JSON.
  - Every env-var input validated against an allowlist before use. Agent name/host/port/token shapes all matched to regex; `RELAY_DB_PATH` resolved under `$HOME`/tmp only.

- **`docs/post-tool-use-hook.md`** — install guide + env-var reference + troubleshooting + what the hook deliberately does NOT do.

- **README "Near-Real-Time Mail Delivery" subsection** — copy-pasteable `.claude/settings.json` block and honest limitation callout.

- **`tests/hooks-post-tool-use.test.ts`** — 8 integration tests covering: HTTP happy path, empty mailbox, idempotency, unreachable-relay graceful fail with timing ceiling, missing-token sqlite fallback, missing `RELAY_AGENT_NAME`, invalid-token-shape fallback, and a behavioral invariant that the hook does NOT mutate the agent's role or capabilities.

### Honest limitations (documented, not worked around)

- **Idle terminals get no delivery.** The hook only fires when the agent is actively running tool calls. If a terminal is sitting idle, it will not see new mail until the next tool call or next `SessionStart`. Continue to rely on SessionStart + human attention for long-idle windows.
- **HTTP path requires python3.** The script uses `python3` to safely construct and parse JSON (no jq dependency; jq is not guaranteed to exist). macOS and most Linux distros ship python3; if absent, HTTP path fails fast and sqlite fallback runs.
- **Tasks are NOT surfaced.** Only pending messages. Task delivery stays in the SessionStart hook for now — focused scope, less context pressure per firing.
- **Per-project install recommended.** Global install would fire in every Claude Code terminal including ones with no relay identity, which is unwanted polling + token exposure. Opt each workspace in deliberately.

### Numbers

- 238 tests across 22 files (was 230; +8 new integration tests for the hook).
- Clean `tsc` compile.
- No new MCP tools. No schema changes. No new dependencies (python3 and sqlite3 are standard OS tooling; already required by the existing SessionStart hook).

### Security posture (unchanged, verified)

- The hook authenticates via `RELAY_AGENT_TOKEN` on the HTTP path, meaning it goes through the full v1.7 auth layer: token bcrypt-verified, capability gate (`get_messages` is always-allowed-for-authenticated, matching the server rule).
- The sqlite fallback path queries only `WHERE to_agent = :name AND status = 'pending'` — agent isolation preserved at the SQL level.
- Env-var inputs validated against allowlists to block URL-/header-injection via crafted env values.
- The hook cannot escalate capabilities — it never calls `register_agent`.

### What was deliberately NOT done (Karpathy rule 2 — surgical scope)

- No cross-platform spawn work (v1.9).
- No Managed Agent reference worker (v1.10).
- No sqlite-wasm migration (v1.11).
- No new MCP tools.
- No schema changes.
- No changes to the MCP server code — this release is additive (shell script + docs + tests).
- No task surfacing in the hook.
- No npm publish.

## v1.7.1 — 2026-04-15 (Auth hardening — security advisory)

**Two blockers from main Victra's v1.7 re-review.** Both are real vulnerabilities in the v1.7 auth layer. No internet-facing deployments exist and nothing has been published to npm, so no external clients are at risk — but the fixes ship before v1.8 per the foundation-before-features rule.

### Security advisory — CVE-equivalent issues in v1.7.0

**CVE-equivalent 1 — Capability escalation via unauthenticated re-register (CRITICAL)**
- In v1.7.0, `register_agent` was in `TOOLS_NO_AUTH` for bootstrap. Re-registration on an EXISTING agent name hit the same no-auth path and silently updated `capabilities`. An unauthenticated attacker could call `register_agent("victra", "r", ["spawn", "tasks", "webhooks", "broadcast"])` and grant themselves (or any agent they have a token for) every capability — nullifying the entire v1.7 capability-scoping feature.
- **Fix:** dispatcher now bifurcates `register_agent`:
  - New registration (name does not exist in DB) → no auth required (bootstrap path preserved).
  - Re-registration (name exists, token_hash present) → auth required; the presented token must match that agent's stored hash.
  - Re-registration on a legacy pre-v1.7 agent (token_hash = NULL) → defers to `RELAY_ALLOW_LEGACY` grace.
- **Cap immutability:** even on authenticated re-register, capabilities are PRESERVED unchanged. The `capabilities` argument in re-register calls is ignored; only `role` and `last_seen` update. `registerAgent` in `db.ts` enforces this as defense-in-depth regardless of dispatcher state. Callers that pass a different capability set receive a `capabilities_note` in the response explaining the rule.
- To change an agent's capabilities, operators must `unregister_agent` (with valid token) and then `register_agent` fresh.

**CVE-equivalent 2 — Timing-unsafe HTTP secret comparison (HIGH)**
- `src/transport/http.ts` used `presented === config.http_secret` and `findIndex((s) => s === presented)` — both are byte-by-byte short-circuiting JavaScript string equality. A remote caller could measure response timing to recover the shared secret one character at a time.
- **Fix:** both checks now go through a `timingSafeStringEq` helper that length-checks first (short-circuit on length mismatch; length is operational metadata not a secret) then calls `crypto.timingSafeEqual` on `Buffer.from(s, "utf8")`. Content comparison is now constant-time. Length-mismatched callers get a clean 401 instead of a 500 (timingSafeEqual would otherwise throw).
- A side-channel still exists on WHICH previous secret matched during rotation (loop short-circuits on first match). Documented in `devlog/015` — judged acceptable since previous secrets are already lower-trust, and will be revisited in a future patch if Victra rules otherwise.

### Fold-ins from the docs audit

- **README** — new sections: **Per-Agent Tokens**, **Encryption at Rest**, **Rotation Guide** for the HTTP shared secret. CHANGELOG and devlogs already covered these, but README is the public-facing doc.

### Numbers

- 230 tests across 21 files (+12: 6 new adversarial re-register tests, 5 new timing-safety tests, +1 multi-cycle immutability test; the existing `upserts on duplicate name` assertion was rewritten in place to match the new immutable-caps behavior — not weakened).
- Clean `tsc` compile.
- Two existing tests updated: `db.test.ts:55` (upsert caps assertion) and `auth.test.ts:130` (re-register caps assertion). Both previously documented the v1.7 buggy behavior; now they document v1.7.1 correctness.

### What was deliberately NOT done (Karpathy rule 2 — surgical scope)

- **No TOOLS_NO_AUTH membership change.** `register_agent` stays in the set for bootstrap; the re-register gate sits BEFORE the set check.
- **No new `description` agent field.** Victra's spec mentioned "role and description" — there is no `description` column today; adding one would be scope creep. Only `role` is updatable on re-register.
- **No bcrypt-path rework.** `bcrypt.compareSync` is already constant-time by design; only the HTTP shared-secret path was timing-leaky.
- **No constant-time scan across all previous secrets.** Short-circuit on first match retained; documented as an acceptable trade-off in the devlog.
- **No encryption / CORS / audit-log changes.** Out of scope.
- **No npm publish, no v1.8 work.** Waiting on Victra's v1.7.1 re-review green-light.

### Upgrade notes

- **Existing agents:** no action needed if you already have a token. The stored `token_hash` is preserved on re-register.
- **SessionStart hook:** the hook's `register_agent` call will still succeed on every terminal open. The `capabilities` argument is now ignored on re-register, so the hook cannot drift an agent's caps — a capability change requires explicit `unregister_agent` + fresh `register_agent`.
- **Shared-secret rotation:** same env vars (`RELAY_HTTP_SECRET`, `RELAY_HTTP_SECRET_PREVIOUS`). Comparison is now timing-safe.

## v1.7.0 — 2026-04-14 (Auth layer — biggest release yet)

Per-agent auth, capability scoping, secret rotation, encryption at rest, structured audit log, CORS. Foundation shipped cleanly from v1.3 → v1.6.4. Now building the secure multi-agent + external integration layer on top of it.

Plus 2 gate items rolled in from v1.6.4 re-review:
- **G1:** CLAUDE.md status line bumped to v1.7.0 / 218 tests / 14 tools.
- **G2:** `ipInCidr` whitespace asymmetry — now trims both IP and CIDR inputs symmetrically.

### Fix 1 — Per-agent auth tokens
- `register_agent` now generates a random 32-byte token on first registration, stores a bcryptjs hash in `agents.token_hash`, and returns the raw token ONCE in the response + stderr log line.
- Re-registration of an already-tokened agent preserves the existing hash (SessionStart hook can safely upsert without rotating).
- Legacy agents (registered pre-v1.7, `token_hash = NULL`) can be migrated two ways: (a) call `register_agent` again to get a fresh token, or (b) set `RELAY_ALLOW_LEGACY=1` during a grace window.
- Every tool call except `register_agent` validates a presented token against the caller's stored hash. Token source (in precedence order): `agent_token` tool arg → `X-Agent-Token` HTTP header → `RELAY_AGENT_TOKEN` env var.
- Impersonation (claim-to-be-X-with-X's-token → claim-to-be-Y) is rejected.

### Fix 2 — Capability scoping per tool
- Each sensitive tool declares a required capability:
  - `spawn_agent` → `spawn`
  - `post_task`, `update_task` → `tasks`
  - `broadcast` → `broadcast`
  - `register_webhook`, `list_webhooks`, `delete_webhook` → `webhooks`
- Always-allowed (no capability check, token still required): `unregister_agent`, `discover_agents`, `send_message`, `get_messages`, `get_tasks`, `get_task`.
- Capabilities set at register time are immutable. To change, unregister + re-register.

### Fix 3 — Shared-secret rotation with grace period
- New env var `RELAY_HTTP_SECRET_PREVIOUS` — comma-separated list of previously-valid secrets. Accepted during a rotation window.
- Primary secret flows through `RELAY_HTTP_SECRET`. Previous secrets emit `X-Relay-Secret-Deprecated: true` response header so clients can see they should upgrade.
- Audit log entries tag which secret was used (`primary` or `previous[N]`).

### Fix 4 — AES-256-GCM encryption at rest
- New opt-in env var `RELAY_ENCRYPTION_KEY` — 32-byte base64-encoded key. When set, the following fields are encrypted on write and decrypted on read:
  - `messages.content`
  - `tasks.description`, `tasks.result`
  - `audit_log.params_json`
- Not encrypted (queryable metadata): agent names, tool names, from/to, priority, status, timestamps.
- Storage format: `enc1:<base64-iv>:<base64-ciphertext-plus-tag>`. Per-row IV (12 bytes).
- Legacy plaintext rows (predating the key, or rows written while the key was unset) remain readable — decrypt is a safe no-op for non-`enc1:` rows.
- Wrong key → GCM auth tag mismatch → decrypt throws clearly.
- Key rotation DEFERRED to v1.7.1 per original brief. Single active key in v1.7.

### Fix 5 — Structured JSON audit log format
- New column `audit_log.params_json` (added additively; old `params_summary` column preserved for back-compat readers).
- Every tool call writes a structured `{ tool, agent_name, auth_method, source_ip, result, error_message? }` record, encrypted at rest.
- `getAuditLog()` returns parsed objects (or `{ _parse_error: true }` for malformed rows — never throws).
- Legacy rows (without `params_json`) surface as `{ legacy_summary: "<old text>" }` after migration.

### Fix 6 — CORS / Origin allow-list on dashboard
- New config field `allowed_dashboard_origins: string[]`. Default: `["http://localhost", "http://localhost:*", "http://127.0.0.1", "http://127.0.0.1:*"]`.
- Dashboard (`/`, `/dashboard`, `/api/snapshot`) checks the `Origin` header. Missing origin → allowed (non-browser callers). In allowlist → allowed with `Access-Control-Allow-Origin` echoed back. Outside allowlist → 403.
- `/health` always open.
- Port-glob syntax supported: `"http://localhost:*"` matches any port.

### Gate fixes (rolled in)
- `ipInCidr` now trims whitespace from BOTH the IP and CIDR inputs (previously only CIDR was trimmed, causing false negatives on trailing-space IPs).

### Tests
- 218 tests passing (was 162).
- New test files:
  - `tests/auth.test.ts` — 14 tests, token primitives + authenticateAgent logic + integration with registerAgent
  - `tests/auth-dispatcher.test.ts` — 13 tests, end-to-end via HTTP: token required/wrong/right, impersonation rejected, capability scoping per tool, X-Agent-Token header fallback
  - `tests/secret-rotation.test.ts` — 5 tests, primary + previous secrets accepted, wrong/missing rejected, deprecation header on previous
  - `tests/encryption.test.ts` — 13 tests, primitives + db round-trip + raw SQL verification that plaintext is actually gone from disk
  - `tests/cors-and-audit.test.ts` — 10 tests, Origin allow-list enforcement + structured audit JSON + encryption round-trip + malformed row handling
- All 162 v1.6.4 tests pass without modification (one test env vars updated to `RELAY_ALLOW_LEGACY=1` for legacy compatibility).

### Dependencies
- Added `bcryptjs@^3.0.3` and `@types/bcryptjs` (devDep).

### Migration guide (v1.6.x → v1.7.0)
- Option A (recommended): call `register_agent` for each existing agent to issue a new token. Capture the token from the response and save it in `RELAY_AGENT_TOKEN` env in your shell alias.
- Option B (grace window): set `RELAY_ALLOW_LEGACY=1` on the server. Existing token-less agents keep working; new agents still get tokens. Remove the env var after all agents have been migrated.
- Existing DB files upgrade automatically. `ALTER TABLE agents ADD COLUMN token_hash TEXT` and `ALTER TABLE audit_log ADD COLUMN params_json TEXT` run on startup (idempotent).

### Version bumps
- package.json: 1.6.4 → 1.7.0
- MCP server version: 1.6.4 → 1.7.0
- /health version: 1.7.0
- Webhook User-Agent: bot-relay-mcp/1.7.0

### What was DELIBERATELY not done
- Encryption key rotation (deferred to v1.7.1 per original brief).
- Token revocation list (for now, revocation = unregister the agent).
- Capability mutation after registration (by design — unregister + re-register).
- OAuth/JWT/SSO — shared-secret + per-agent tokens are sufficient for this threat model.
- IP auth on stdio — stdio is local-user-trust; token is the fence.

## v1.6.4 — 2026-04-14 (IPv6 form coverage + test hygiene — 5 surgical sharpening items)

Main Victra's v1.6.3 re-review verdict was GREEN on all functional claims, with 5 sharpening items for v1.6.4. All shipped.

### Fix 1 — Fully-expanded IPv4-mapped IPv6 detection
- Previously `ipv4FromMappedIPv6()` only recognized compressed forms (`::ffff:0102:0304`, `::ffff:1.2.3.4`). Fully-expanded `0:0:0:0:0:ffff:0102:0304` returned null, which would silently fail trust checks if an operator wrote a fully-expanded address in `trusted_proxies` config.
- Rewrote with a structural approach: split the address into 8 hex groups (after :: expansion), check the canonical `[0,0,0,0,0,0xffff,hi,lo]` pattern. Single code path handles all compression forms.
- For mixed-dotted forms (any address containing a `.`), split off the IPv4 tail and verify the IPv6 prefix is structurally `0:0:0:0:0:ffff` via a `padded + expand + check` helper.
- 2 new tests verify fully-expanded form behaves identically to compressed form.

### Fix 2 — IPv4-mapped IPv6 peer in trusted-proxy
- Exported `extractSourceIp` from `src/transport/http.ts` for direct unit testing.
- 4 new unit tests in `tests/trusted-proxy.test.ts` exercise scenarios that are awkward to provoke over real sockets:
  - dual-stack peer `::ffff:127.0.0.1` IS trusted against IPv4 CIDR `127.0.0.0/8`
  - IPv6-mapped CIDR rule `::ffff:127.0.0.0/104` matches IPv4 peer `127.0.0.1`
  - mapped peer NOT in trusted list correctly returns the peer (XFF ignored)
  - empty trusted_proxies always returns peer regardless of XFF

### Fix 3 — Bare-path approved root acceptance
- `bin/spawn-agent.sh` case pattern previously had `/var/folders/*` but not the bare `/var/folders` form. A cwd that resolved to exactly `/var/folders` (no subpath) would be wrongly rejected.
- Added bare-path alternative: `"/var/folders"|"/var/folders/"*`. HOME, /tmp, /private/tmp already had this pattern.
- New test `accepts cwd that resolves EXACTLY to an approved root (no subpath)` confirms the fix.

### Fix 4 — Adversarial IPv6 form documentation
- `::1.2.3.4` (IPv4-compatible IPv6, RFC 4291 §2.5.5.1, deprecated) is intentionally NOT treated as IPv4-mapped. Treating it as such would wrongly grant IPv4 CIDR trust to pure IPv6 callers using a deprecated transition format.
- `64:ff9b::1.2.3.4` (NAT64, RFC 6052) is intentionally NOT treated as IPv4-mapped. Different semantics — represents a translated IPv4 destination, not an incoming IPv4 client.
- Both behaviors verified by 2 new tests.
- Comment block in `src/cidr.ts` explains why these forms are intentionally excluded, citing the relevant RFCs.

### Fix 5 — assertBlocked helper consistency
- Extended `assertBlocked()` in `tests/spawn-integration.test.ts` to take optional `stderrContains` and `stdoutNotContains` opts.
- Refactored all 16 existing attack tests to use the helper. Eliminates inline assertion drift over time and makes adding new attack tests a 1-liner.

### Tests
- 162 tests passing (was 153).
  - +2 CIDR fully-expanded tests
  - +2 CIDR adversarial form tests (IPv4-compat, NAT64)
  - +4 extractSourceIp unit tests for IPv4-mapped peer scenarios
  - +1 bare-path approved root test
  - 0 net change from Fix 5 (pure refactor)
- All 153 prior tests pass without modification.

### Files changed
- `src/cidr.ts` — rewrote `ipv4FromMappedIPv6`, added `expandIPv6ToGroups` + `isAllZeroPlusFfffPrefix` helpers, dropped unused helper, expanded comment block
- `src/transport/http.ts` — exported `extractSourceIp`
- `bin/spawn-agent.sh` — added bare-path approved root, comment update
- `tests/cidr.test.ts` — +4 tests
- `tests/spawn-integration.test.ts` — extended assertBlocked, refactored 16 tests, +1 bare-path test
- `tests/trusted-proxy.test.ts` — +4 unit tests for extractSourceIp

### Version bumps
- package.json: 1.6.3 → 1.6.4
- MCP server version: 1.6.3 → 1.6.4
- /health version: 1.6.4
- Webhook User-Agent: bot-relay-mcp/1.6.4

### Backward compatibility
- Behavior change is only ADDITIVE — fully-expanded mapped form now matches where it returned false before; bare `/var/folders` cwd now allowed where it would have been rejected. No existing passing case turns into a failing case.
- All tool signatures unchanged.

## v1.6.3 — 2026-04-14 (IPv4-mapped IPv6 + deeper attack coverage + doc drift fixes)

Main Victra's v1.6.2 re-review found 10/13 items FULL, 2/13 PARTIAL, 1/13 DRIFT. v1.6.3 closes all three.

### Fix 1 — IPv4-mapped IPv6 normalization in CIDR matcher (RFC 7239 §7.4)
- Previously `::ffff:1.2.3.4` compared against `1.2.3.0/24` returned false (cross-family mismatch). Operators writing IPv4 CIDRs would fail to match dual-stack clients arriving in the mapped form.
- Added `ipv4FromMappedIPv6()` helper that detects both textual (`::ffff:1.2.3.4`) and hex (`::ffff:0102:0304`) forms and extracts the embedded IPv4.
- `ipInCidr` now normalizes mapped-IPv6 on both the IP side and the CIDR side, and maps the IPv6 prefix to the corresponding IPv4 prefix (`/120` on `::ffff:a.b.c.d/120` = `/24` on the embedded IPv4).
- Regular IPv6 (non-mapped) still does NOT match IPv4 rules — explicit guard test added.
- 8 new CIDR tests covering: mapped-to-IPv4, IPv4-to-mapped, hex-form mapping, multiple family combos, `ipInAnyCidr` with mixed list.

### Fix 2 — Deeper spawn attack coverage + stderr assertions on every attack
- Added 4 new attack payloads to `tests/spawn-integration.test.ts`:
  - CRLF mixed injection in role (`\r\n`)
  - Unicode NFD normalization bypass (`e` + U+0301 combining acute)
  - Symlink path traversal (creates `/tmp/v163-bad-link-PID -> /etc`, passes as cwd, asserts rejection)
  - Long-payload DoS (cwd > 1024 chars)
- Added stderr-non-empty assertion to every attack test. Catches silent-failure regressions where the script exits 2 but gives no hint why.
- 17 → 21 spawn integration tests.

### Fix 3 — Bash symlink/path-resolution defense in `bin/spawn-agent.sh`
- Added `cd "$CWD" && pwd -P` resolution after text validation. The resolved path must still be under an approved root ($HOME, /tmp, /private/tmp, /var/folders). A symlink pointing outside an approved root is rejected with an explicit "resolves to ... outside approved roots" error.
- Gracefully skips resolution if the path doesn't exist yet (child terminal will fail naturally on `cd`).
- CRLF smuggling in cwd now caught by a dedicated `tr -d` length-comparison block (mirroring the validate_token pattern).

### Fix 4 — Documentation drift
- `CLAUDE.md` was stuck reporting "104 tests, 13 files" (v1.6.1 numbers). Updated to 153 tests / 16 files.
- Added missing entries to the file map: `src/cidr.ts`, `tests/cidr.test.ts`, `tests/spawn-integration.test.ts`, `tests/trusted-proxy.test.ts`.
- Corrected the v1.6.2 CHANGELOG entry: was "validate_token blocks smuggling" (no such function); now points to the real code — `SpawnAgentSchema.SPAWN_CWD_FORBIDDEN` in `src/types.ts` plus the bash `tr -d` check.

### Tests
- 153 tests passing (was 140).
  - +8 CIDR tests (IPv4-mapped IPv6)
  - +4 spawn integration tests (CRLF, Unicode NFD, symlink traversal, DoS)
  - +13 stderr assertions across existing attack tests
- All 140 prior tests pass without modification.

### Version bumps
- package.json: 1.6.2 → 1.6.3
- MCP server version: 1.6.2 → 1.6.3
- /health version: 1.6.3
- Webhook User-Agent: bot-relay-mcp/1.6.3

### Backward compatibility
- `ipInCidr` is stricter only in that it now MATCHES mapped-IPv6 against IPv4 rules where it used to return false — operators who wrote IPv4 CIDRs in `trusted_proxies` now correctly trust dual-stack clients. Non-match cases are unchanged.
- Bash path-resolution defense only triggers when the cwd path exists; non-existent paths pass through as before (child terminal handles the `cd` failure).

## v1.6.2 — 2026-04-14 (Defense-in-depth + trusted-proxy config)

Main Victra re-reviewed v1.6.1 and found 2 items were PARTIAL. v1.6.2 addresses both fully, with real integration tests replacing mocked ones.

### Fix 1 — Spawn shell injection: defense-in-depth
- **TS-layer validation in `src/types.ts` SpawnAgentSchema.** Zod schema now enforces explicit regex patterns matching the bash layer: name/role `[A-Za-z0-9_.-]+`, each capability item `[A-Za-z0-9_.-]+`, cwd absolute path with `/A-Za-z0-9_./-]` allowlist plus a negative-check `.refine` that rejects any shell metacharacter or control character even if the base pattern somehow let it through. This catches attacks at the MCP boundary before the shell ever runs.
- **Real integration tests via `bin/spawn-agent.sh` with `RELAY_SPAWN_DRY_RUN=1`.** 17 tests in `tests/spawn-integration.test.ts` spawn the actual bash script and feed it attack payloads: semicolons, pipes, ampersands, `$()` and backtick command substitution, newlines, quote-mixing, dollar-sign expansion in capabilities, relative cwd, cwd with command substitution, cwd with backtick or semicolon, oversized name, and `RELAY_TERMINAL_APP` env var injection. Every payload is blocked; dry-run stdout is verified NOT to contain the attack.
- **Inline comments in `bin/spawn-agent.sh`** now explicitly document the three layers of defense (TS Zod → bash regex → `printf %q` + AppleScript escape) and warn future maintainers against simplifying.
- Fixed a macOS bash 3.2 bug where `$'\n'` in case patterns didn't match reliably. Replaced with a length-comparison check after `tr -d` strips control chars.

### Fix 2 — X-Forwarded-For trusted-proxy configuration
- **New config field `trusted_proxies: string[]`** (CIDR blocks, default empty).
- **New env var `RELAY_TRUSTED_PROXIES`** (comma-separated CIDRs) that overrides the file config.
- **Behavior change:** when `trusted_proxies` is empty (DEFAULT), the X-Forwarded-For header is COMPLETELY IGNORED. Rate limits key only on the direct socket peer IP. This closes the previous spoofing vector where any caller could send `X-Forwarded-For: 1.2.3.4` and get a fresh quota bucket.
- **When trusted_proxies is configured:** the server only honors X-Forwarded-For if the direct peer IP falls in one of the trusted CIDRs. It then walks the XFF chain right-to-left, skipping trusted hops, and picks the leftmost-untrusted hop as the "real" client IP. This matches RFC 7239 §7.4 and how nginx/Express/Rails normally handle this.
- **New `src/cidr.ts` CIDR matcher** supports both IPv4 and IPv6, with unit tests covering exact matches, /0, /24, /8, /32, /128, /10, IPv4-mapped IPv6 edge cases, malformed input rejection, and cross-family non-matching.

### Tests
- 140 tests passing (was 104).
  - +23 CIDR tests (IPv4, IPv6, /0, /24, /8, /32, /128, cross-family, malformed, ipInAnyCidr)
  - +17 spawn integration tests (real bash invocation, 15+ attack payloads)
  - +2 trusted-proxy HTTP tests (XFF ignored by default, XFF honored from trusted peer)
  - Small tweaks: null-byte/newline/tab/CR smuggling now explicitly blocked by the `SpawnAgentSchema.SPAWN_CWD_FORBIDDEN` regex in `src/types.ts` (TS layer) and the `tr -d` length check in `bin/spawn-agent.sh` (bash layer)

### Version bumps
- package.json: 1.6.1 → 1.6.2
- MCP server version: 1.6.1 → 1.6.2
- /health version: 1.6.2
- Webhook User-Agent: bot-relay-mcp/1.6.2

### Backward compatibility
- `trusted_proxies` defaults to `[]`. Behavior for existing deployments WITHOUT config is unchanged at the behavioral level: we never honored XFF from them meaningfully before (we did in v1.6.1, which is what Victra flagged as a leak). For anyone relying on XFF for rate limiting, they now need to explicitly configure `trusted_proxies`.
- All 104 v1.6.1 tests pass without modification.
- All tool signatures unchanged.

### Files added
- `src/cidr.ts` — IPv4/IPv6 CIDR matching utility (100 lines)
- `tests/cidr.test.ts` — 23 CIDR tests
- `tests/spawn-integration.test.ts` — 17 real-shell integration tests
- `tests/trusted-proxy.test.ts` — 2 HTTP-level XFF tests

## v1.6.1 — 2026-04-14 (Main Victra's review fixes — 3 blockers + 5 fix-this-session items)

Main Victra reviewed v1.6 and held npm publish on three blockers + five fix-this-session items. All eight landed.

### Blockers resolved
- **`bin/spawn-agent.sh` shell injection (CRITICAL).** Previously interpolated `$NAME`/`$ROLE`/`$CAPS`/`$CWD` directly into shell + osascript. Rewrote with: input validation regexes (name/role `[A-Za-z0-9_.-]`, caps `[A-Za-z0-9_.,-]`, cwd must be absolute path with no shell metacharacters), `printf %q` quoting for shell interpolation, and an `applescript_escape` helper that handles `\` and `"` for the AppleScript heredoc. 6 injection payloads verified blocked in smoke test.
- **MCP SDK pin mismatch.** Installed was 1.29.0 while package.json pinned `~1.12.1` — lockfile wasn't forced on pin change. Bumped pin to `~1.29.0` (the version all tests were already passing on) and ran `npm install` to lock it in.
- **Concurrent test was sequential.** Replaced the in-process for-loop with a child-process based test that spawns a second Node process writing the same SQLite file. Real OS-level contention; busy_timeout must kick in for both sides to complete. 100 writes per process, all 200 land.

### Fix-this-session items resolved
- **`src/db.ts` path traversal validation.** Mirrors `check-relay.sh` logic: RELAY_DB_PATH must resolve under `$HOME`, `/tmp`, `/private/tmp`, or `/var/folders`. Throws at startup otherwise.
- **HTTP no-auth rate-limit bypass.** Caller could rotate `agent_name` per call to reset their quota. Fix: new `src/request-context.ts` uses AsyncLocalStorage to bind source IP to each HTTP request, and the server dispatcher composes the rate-limit key as `ip:<addr>` when the call is HTTP + unauthenticated. IP-based quotas cannot be bypassed by agent name switching.
- **`CLAUDE.md` stale at v1.4.** Updated to v1.6.1, 104 tests, 14 tools, full file map reflects current src/ layout.
- **Tool-level rate-limit rejection tests.** Added 3 tests in `security.test.ts`: tool rejection after limit hit, IP-keyed bypass prevention, separate IPs get separate quotas.
- **Hardcoded `sleep(200)` replaced with polling.** `tests/unregister.test.ts` "does NOT fire webhook" test now polls up to 500ms, failing early if the webhook wrongly fires.

### Tests
- 104 tests passing (was 100).
  - +1 concurrent OS-level contention test (child process + parent write race)
  - +3 rate-limit rejection tests (tool level, IP-keyed, multi-IP)
  - Fixed: concurrent test had a 5th arg for 4 placeholders — corrected
  - Fixed: concurrent test was sequential — now actually concurrent across processes

### Version bumps
- package.json: 1.6.0 → 1.6.1
- MCP SDK pin: `~1.12.1` → `~1.29.0` (matches installed + lockfile)
- MCP server version: 1.6.0 → 1.6.1
- /health version: 1.6.1
- Webhook User-Agent: bot-relay-mcp/1.6.1

### Backward compatibility
- Zero behavior changes to tool signatures.
- Zero schema changes.
- The HTTP no-auth rate limit now keys by IP when unauth — existing stdio and authenticated HTTP behavior unchanged.

## v1.6.0 — 2026-04-14 (Hardening pass — no new features)

After 3 parallel research agents audited security, architecture, and tech stack, this release fixes the real issues they found. Zero new features. Zero new tools. Just hardening.

### Security fixes
- **SSRF protection on webhooks.** `register_webhook` now resolves DNS at registration time and rejects URLs targeting private IP ranges (10.x, 172.16/12, 192.168.x, 127.x, 169.254.x cloud metadata, fc00::/7, fe80::/10, ::1) and non-HTTP(S) schemes (file://, ftp://, gopher://). Set `RELAY_ALLOW_PRIVATE_WEBHOOKS=1` to opt-in for local n8n at 127.0.0.1.
- **Hook script input validation.** `check-relay.sh` now validates `RELAY_AGENT_NAME`, `RELAY_AGENT_ROLE`, and `RELAY_AGENT_CAPABILITIES` against `[A-Za-z0-9_.-]` before passing them to sqlite3. SQL injection and shell-substitution attacks are blocked at the input boundary.
- **Path traversal protection.** `RELAY_DB_PATH` is now resolved and must live under `$HOME` or `/tmp` (`/private/tmp`, `/var/folders` for macOS test environments). Pointing at `/etc/passwd` is rejected.
- **Dual-key parameter binding in hook script.** Although input validation already prevents SQL injection, the hook now uses sqlite3's `.parameter set` mechanism for defense-in-depth.

### Tech hygiene
- **Stderr-only logger** (`src/logger.ts`) — every log goes to stderr regardless of transport. Replaced all internal `console.error` calls. Stdout in stdio mode is reserved exclusively for the MCP JSON-RPC channel.
- **CI-style test that fails on `console.log` regression** in any source file. Prevents the #1 silent-break failure mode reported on community MCP servers.
- **Pre-log webhook deliveries** before the fetch fires (was after). A process crash mid-delivery still leaves an audit trail.
- **Node 18+ runtime check** at startup with a clear error message (the engines.node field doesn't enforce at runtime).
- **MCP SDK pinned to `~1.12.1`** (patch-only updates) to avoid silent breakage from minor version bumps.

### Tests
- 100 tests passing (was 79).
  - +15 URL safety tests (scheme, IP literal blocking, IPv6, opt-in, public destinations)
  - +2 stdout discipline tests (no console.log in src/, no process.stdout.write)
  - +3 concurrent write tests (busy_timeout effective, WAL mode, two-connection contention)
  - +1 schema migration test (v1.0-era DB upgrades cleanly to v1.6)

### Backward compatibility
- All 79 v1.5 tests pass with minor adjustments (4 webhook tests needed `await` for the now-async `handleRegisterWebhook`, plus `RELAY_ALLOW_PRIVATE_WEBHOOKS=1` for receivers on 127.0.0.1).
- No new MCP tools, no schema changes, no breaking config changes.
- HTTP auth unchanged from v1.5.

### Version bumps
- package.json: 1.5.0 → 1.6.0
- MCP server version: 1.5.0 → 1.6.0
- /health version: 1.6.0
- Webhook User-Agent: bot-relay-mcp/1.6.0

## v1.5.0 — 2026-04-14

### Added — Security hardening (responding to user feedback on built-in security)

#### Shared-secret auth on HTTP transport
- New config option `http_secret` (file) / `RELAY_HTTP_SECRET` (env var).
- When set, all HTTP requests except `/health` require `Authorization: Bearer <secret>` or `X-Relay-Secret: <secret>` header.
- Rejects missing or wrong secret with HTTP 401 and a helpful hint.
- `/health` stays open for monitors to ping without credentials — now reports `auth_required` in its response.
- Solo stdio use is unaffected (no auth required for stdio transport).

#### Audit log
- New `audit_log` SQLite table.
- Every tool call is logged with agent name, tool, param summary (first 80 chars of key fields), success/failure, and error if any.
- Auto-purges entries older than 30 days.
- Queryable via `getAuditLog(agentName?, tool?, limit?)` library function. (No MCP tool yet — add in v1.6 if users request it.)

#### Rate limiting (sliding-window, per agent per bucket)
- Three buckets: `messages` (send_message + broadcast), `tasks` (post_task), `spawns` (spawn_agent).
- Defaults: 1000 messages/hour, 200 tasks/hour, 50 spawns/hour. 0 disables.
- Configurable via `rate_limit_messages_per_hour`, `rate_limit_tasks_per_hour`, `rate_limit_spawns_per_hour` in `~/.bot-relay/config.json`.
- Over-limit calls return structured error with current/limit counts and reset hint.
- Every rate-limit rejection is also logged to the audit log.

### Changed
- Server version: 1.4.0 → 1.5.0
- `/health` response now includes `auth_required` boolean.
- Tool dispatcher wrapped with rate-limit check + audit logging. All 14 tools still function identically — this is purely additive.

### Tests
- 79 tests passing (was 63)
  - 9 new security tests (audit log writes/filters, rate limit per agent + bucket)
  - 7 new HTTP auth tests (401 without auth, Bearer token, X-Relay-Secret, health exempt, dashboard protected)
- All 63 v1.4 tests pass without modification.

### Backward compatibility
- Default config has `http_secret: null` — HTTP mode works with no auth if the user doesn't set one. This is identical to v1.4 behavior.
- Default rate limits are generous (1000/hr messages) and can be disabled by setting to 0.
- stdio mode unchanged.

## v1.4.0 — 2026-04-14

### Added — spawn_agent
- New MCP tool: `spawn_agent(name, role, capabilities, cwd?, initial_message?)`
- Opens a new Claude Code terminal window (iTerm2 or Terminal.app) pre-configured with `RELAY_AGENT_NAME`, `RELAY_AGENT_ROLE`, `RELAY_AGENT_CAPABILITIES` env vars.
- The SessionStart hook auto-registers the agent and delivers any queued mail on arrival.
- Optional `initial_message` queues a message before spawning, so the new agent sees instructions on first wake.
- Fires new `agent.spawned` webhook event.
- Shell script at `bin/spawn-agent.sh` can also be called directly from the command line.
- macOS only for now (uses osascript). Linux/Windows support is a v2 candidate.

### Added — Dashboard
- Built-in HTML dashboard served at `GET /` and `GET /dashboard` in HTTP mode.
- JSON snapshot API at `GET /api/snapshot` (agents, messages, active/completed tasks, webhooks).
- Vanilla JS, no build step, auto-refreshes every 3 seconds.
- Color-coded presence status (online/stale/offline), priority badges, task state badges.
- Dark theme matching common terminal aesthetics.

### Added — Role templates
- New `roles/` directory with drop-in CLAUDE.md snippets for common agent roles:
  - `planner.md` — orchestrator/delegator
  - `builder.md` — worker that accepts and completes tasks
  - `reviewer.md` — skeptical reviewer with structured output
  - `researcher.md` — investigates questions, returns findings
- `roles/README.md` explains three ways to apply a role (per-project CLAUDE.md, spawn initial_message, shell alias).

### Added — Hardening
- SQLite `busy_timeout = 5000ms` — waits up to 5s for write locks instead of throwing SQLITE_BUSY. Prevents spurious errors under burst traffic.

### Changed
- MCP server version: 1.3.0 → 1.4.0
- Tool count: 13 → 14
- Webhook events: 8 → 9 (added `agent.spawned`)
- Added `mcp__bot-relay__spawn_agent` to pre-approved tools in `.claude/settings.json`

### Tests
- 63 tests passing (was 56)
  - 5 new spawn tests (mocked child_process.spawn)
  - 2 new HTTP tests (dashboard HTML, snapshot API)
- All existing tests untouched

### Fixed
- Updated tool count test from 13 to 14 to match new `spawn_agent`.

## v1.3.0 — 2026-04-14

### Fixed — Presence integrity
- `getMessages()` no longer bumps `last_seen` on the agent calling it. Reading your mailbox is observation, not liveness.
- `getTasks()` no longer bumps `last_seen` on the agent calling it. Same reason.
- `registerAgent`, `sendMessage(from)`, `broadcastMessage(from)`, `postTask(from)`, `updateTask(agent_name)` still bump `last_seen` — these are real actions.
- Net effect: `discover_agents` now tells the truth about who is actually doing something vs who is just lurking.

### Added — Agent lifecycle
- New tool: `unregister_agent(name)` — removes an agent from the relay. Idempotent (returns `removed: false` if the name was not registered).
- New webhook event: `agent.unregistered` — fires when an agent is successfully removed. Does not fire on idempotent no-op removes.
- `agent.unregistered` payload: `from_agent` and `to_agent` both equal the removed name (self-event).
- Added `mcp__bot-relay__unregister_agent` to the pre-approved tools in `.claude/settings.json`.
- **Deliberately skipped:** auto-unregister on SIGINT/SIGTERM in the stdio transport. The stdio transport has no per-connection state that maps a process to its registered agent name. Adding that requires richer per-connection state (v2+ scope). Exposing the tool is enough: clients can call `unregister_agent` themselves on shutdown, or hooks can clean up stale entries.

### Changed — SessionStart hook
- `hooks/check-relay.sh` now registers the agent (upsert) before checking mail. Registration is a real liveness signal.
- Agent name, role, and capabilities are read from `RELAY_AGENT_NAME`, `RELAY_AGENT_ROLE`, `RELAY_AGENT_CAPABILITIES` env vars (comma-separated for caps). Sensible defaults: `default` / `user` / empty array.
- Pending messages and active tasks are printed to stdout (injected into Claude's context) AND stderr (shown to the human) on session open.
- Uses `sqlite3` CLI directly — no daemon dependency, works regardless of transport mode.

### Tests
- 56 tests passing (was 48).
- +4 presence tests (getMessages/getTasks don't touch, sendMessage/postTask do).
- +4 unregister tests (removal, idempotency, webhook fires, no webhook on no-op).

### Unchanged (backward-compatible)
- All 48 v1.2 tests pass without modification.
- All existing tool signatures identical.
- No SQLite schema changes.
- stdio and HTTP transports unchanged.

### Version
- `package.json`: 1.2.0 → 1.3.0
- MCP server version: 1.2.0 → 1.3.0 (seen in initialize handshake)
- `/health` version: 1.3.0
- Webhook `User-Agent`: `bot-relay-mcp/1.3.0`

## v1.2.0 — 2026-04-14

### Added — HTTP Transport
- `StreamableHTTPServerTransport` support alongside stdio
- New entry point supports three transport modes via `RELAY_TRANSPORT` env var or config file:
  - `stdio` (default) — current behavior, one server per terminal
  - `http` — HTTP daemon mode on `RELAY_HTTP_PORT` (default 3777)
  - `both` — HTTP server plus stdio (for daemon + local Claude Code simultaneously)
- `/health` endpoint for HTTP mode (`GET /health` returns status JSON)
- `/mcp` endpoint handles JSON-RPC over HTTP with SSE streaming
- Stateless mode — each request gets its own transport; all share the same SQLite

### Added — Webhook System
- New SQLite tables: `webhook_subscriptions`, `webhook_delivery_log`
- New tools:
  - `register_webhook(url, event, filter?, secret?)` — subscribe to relay events
  - `list_webhooks()` — list all subscriptions (secrets hidden)
  - `delete_webhook(webhook_id)` — remove a subscription
- Supported events: `message.sent`, `message.broadcast`, `task.posted`, `task.accepted`, `task.completed`, `task.rejected`, `*`
- Fire-and-forget delivery with 5s timeout (does not block tool responses)
- HMAC-SHA256 signatures in `X-Relay-Signature` header when `secret` is set
- Optional agent name filter (fires only when `from_agent` or `to_agent` matches)
- Delivery attempts logged to `webhook_delivery_log` with status code or error
- Auto-purge: delivery logs older than 7 days

### Added — Config File
- `~/.bot-relay/config.json` for transport mode, HTTP port, webhook timeout, API allowlist
- Environment variables (`RELAY_TRANSPORT`, `RELAY_HTTP_PORT`, `RELAY_HTTP_HOST`) override file config
- Invalid or missing config falls back to safe defaults

### Changed
- Refactored `src/index.ts` into `src/server.ts` (reusable factory) + `src/transport/{stdio,http}.ts`
- Server version bumped to 1.2.0 in MCP handshake
- 12 MCP tools now registered (was 9 in v1.1)
- Version: 1.1.0 → 1.2.0

### Dependencies
- Added `express@^5.2.1` and `@types/express` (devDep)

### Tests
- 48 tests passing (was 28 in v1.1)
  - 21 database layer (unchanged)
  - 7 tool integration (unchanged)
  - 11 new webhook tests (registration, firing on all events, HMAC, filters, failure handling)
  - 4 new HTTP transport tests (health, tools/list, round-trip, method restrictions)
  - 5 new config loader tests (defaults, file, env overrides, malformed input)

### Unchanged (backward-compatible)
- All existing tool signatures and behaviors preserved
- stdio mode identical to v1.1
- Existing SQLite tables unchanged — only new tables added
- All v1.1 tests still pass without modification

## v1.1.0 — 2026-04-13

### Added
- `get_tasks` tool — query your task queue by role (assigned/posted) and status
- `get_task` tool — look up a single task by ID
- 28 tests (vitest) covering database layer and tool handlers
- README.md with Quick Start, tool reference, examples, roadmap
- SessionStart hook (`hooks/check-relay.sh`) for auto-checking relay at session start
- `.claude/settings.json` pre-approving all relay tools (zero friction)
- `docs/hooks.md` — hook setup guide
- `docs/claude-md-snippet.md` — CLAUDE.md instructions for users
- `.gitignore`, MIT LICENSE

### Changed
- Moved project from `side-projects/bot-relay-mcp/` to `bot-relay-mcp/` (top-level)
- Updated MCP path in `~/.claude.json`
- Version: 1.0.0 → 1.1.0

## v1.0.0 — 2026-04-06

### Added
- Initial release
- 7 MCP tools: `register_agent`, `discover_agents`, `send_message`, `get_messages`, `broadcast`, `post_task`, `update_task`
- TypeScript, stdio transport, SQLite shared state
- WAL mode for concurrent access
- Auto-purge for old messages (7 days) and completed/rejected tasks (30 days)
