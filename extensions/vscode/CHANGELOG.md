# Changelog — Tether for bot-relay-mcp (VSCode)

All notable changes to the Tether VSCode extension are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The marketplace surfaces this file directly on the extension's listing page, so each entry is written for end-users — what changed, why it matters, what to do if anything.

## [0.3.0] — 2026-06-17 — Zero-config wake: Tether finds your agent's terminal by process id

Tether now binds a terminal to an agent by **process identity** — no terminal naming, no rename, no convention to remember. Start your agent however you like (a shell alias, a plain `claude --name …`, anything); when mail arrives, Tether wakes the terminal that's actually running that agent. This is the foundation for running several agents, each in its own terminal, with nothing to configure.

### Changed

- **Auto-`inbox` wake is now PID-primary.** An agent reports its process-ancestry chain + a stable machine id when it registers; Tether reads each terminal's process id and wakes the one whose process is in that chain. The v0.2.2 name match (`<agent>` / `Tether: <agent>`) remains as a fallback for agents that haven't reported a chain yet, and the 0/>1 safety (no wake + a status-bar hint, never a guess) is unchanged. Net effect: the common case — an alias-launched agent in a terminal named `zsh` — now wakes correctly with **zero configuration**.

### Internal

- Matching is **host-scoped**: an equal process id on a *different* machine never false-matches (the machine id — macOS `IOPlatformUUID` / Linux `/etc/machine-id` / Windows `MachineGuid` — is computed identically by the agent and the extension). Resolved bindings are cached and invalidated on terminal close, so wakes don't re-scan every terminal. The matcher core (`pid-binding.ts`) and the host-identity parsers (`host-identity.ts`) are pure + unit-tested across all three platforms (Windows parsers are verified against documented command output; not runtime-tested on a real Windows host). Requires a relay that surfaces the handshake fields (`register_agent` schema v16). Two-mode Tether + the iTerm2→VS Code "promote to builder" handoff build on this primitive in a later v0.3.x.

## [0.2.3] — 2026-06-17 — Reliable wake: catch up on mail that's already waiting, switch agents live

Two fixes to make the auto-`inbox` wake reliable in day-to-day multi-agent use: Tether now wakes your terminal for mail that was **already sitting in the inbox** when it (re)connects — not just mail that arrives afterward — and you can point Tether at a different agent's inbox from the Command Palette without a window reload.

### Added

- **`Tether: Switch Agent` command.** Pick another agent's inbox from a Quick Pick (populated live from the relay's `discover_agents`, with a free-text fallback) and Tether re-subscribes immediately — no `Developer: Reload Window`. Combined with the catch-up wake below, switching to an agent that already has mail wakes its terminal right away. Switch Agent sets `agentName` at **workspace or global scope** (whichever already holds the value); a per-folder (multi-root) override is out of scope by design — Tether surfaces a hint to change it manually rather than silently failing to switch.

### Fixed

- **Mail already waiting at connect didn't wake the terminal (catch-up wake).** The auto-`inbox` keystroke only fired for messages that arrived **after** Tether subscribed. So on a fresh start, after a daemon restart, or after switching agents, any mail already in the inbox was shown in the status bar but never woke the terminal — you had to type `inbox` yourself. Tether now fires one wake on (re)subscribe when the inbox already holds pending mail. A shared high-water mark (the newest-message timestamp, in memory) guarantees it **never double-wakes**: a reconnect with no new mail does nothing, while a window reload deliberately re-wakes still-pending mail.
- **The "no matching terminal" hint is now actionable** — it tells you to rename a terminal to the agent's name so the wake can land (an interim nudge until automatic terminal discovery arrives).

### Internal

- New `catch-up-wake.ts` (pure, unit-tested) — the wake decision shared by the catch-up and live paths, so neither double-wakes the other. New `tests/helpers/relay-http-harness.ts` + a real-HTTP-daemon integration test assert the no-double-wake invariant end-to-end against the shipped transport. Gated on `autoInjectInbox` only (independent of the notification level). The next robustness item — an SSE keepalive watchdog for silent Electron drops — follows in v0.2.4; automatic terminal↔agent binding by process id lands in v0.3.

## [0.2.2] — 2026-06-16 — Deterministic wake: the right agent's terminal, every time

When mail arrives, Tether's auto-`inbox` keystroke now wakes the terminal that belongs to **that** agent — never whichever terminal you happen to have focused. This is the foundation for running several agents (victra-build, codex, …) each in its own VS Code terminal.

### Fixed

- **Auto-inject could wake the wrong terminal (P3).** Previously, when no terminal's name exactly equalled the agent name, the `inbox` keystroke fell back to the **focused** terminal — so a message for one agent could nudge whichever terminal you were looking at (it once typed `inbox` into a terminal titled "✳ Restart …"). Now Tether targets the agent's terminal deterministically — by its bare name (e.g. the `vscode-victra-build` relaunch alias names its terminal `victra-build`) or the `Tether: <name>` spawn convention — and **never** falls back to the focused terminal. If **no** terminal matches, or **more than one** does, Tether does not guess: it shows a brief status-bar hint (`<agent> has mail …`) and leaves the mail for you to drain. A missed wake is recoverable; a wrong wake is not.

### Internal

- New `terminal-targeting.ts` (VSCode-free, unit-tested): the pure wake-matcher + the single-sourced `Tether: <name>` naming convention (shared by the spawner and the matcher so they cannot drift). Multi-agent terminal identity via a registration handshake — and its reserved-name protection — is the v0.3 follow-up.

### Coming next

- This is a focused, standalone release of the terminal-targeting fix (P3) — the prerequisite for v0.3 multi-agent. Two further robustness items are deferred to **v0.2.3**: live re-subscribe when you change the configured agent without a window reload (P2), and an SSE keepalive/heartbeat so the long-lived inbox subscription doesn't silently drop on the Electron host (P4).

## [0.2.1] — 2026-06-11 — Auto-reconnect: Tether survives daemon restarts hands-off

Tether now reconnects on its own after the bot-relay daemon restarts — no more "Tether: error — run Reconnect" wedge. This matters because the daemon is now a background service that auto-restarts on crash or reboot, so restarts are routine; Tether has to ride through them without you noticing.

### Fixed

- **No auto-reconnect after a daemon restart (P1).** Previously, when the daemon restarted, Tether's saved session became invalid; the MCP SDK kept retrying that dead session, exhausted its retry budget, and gave up permanently — the status bar stuck at `Tether: error — run "Tether: Reconnect to Relay"` until you ran a manual Reconnect. Now, on a recoverable transport error (a dead/unknown session, the SDK's retry give-up, an SSE disconnect, or a refused connection to a down daemon), Tether performs a **fresh connect** (a brand-new session) and **re-arms indefinitely** with capped exponential backoff (1s → 2s → … → 30s) until the daemon comes back. The status bar shows `Tether: reconnecting… (attempt N)` while it recovers, then returns to normal. A bad/expired token is the one case that still asks for a manual Reconnect (retrying it would loop pointlessly).

### Changed

- The SDK's same-session retry budget is reduced (20 → 3): same-session retries only help a brief blip where the session still exists, and are futile after a restart. Recovery from restarts is now owned by the new reconnect supervisor, which kicks in on the first error — before the SDK gives up — so there's no gap.

### Internal

- New `reconnect-supervisor.ts` (VSCode-free, fully unit-tested): error classification + single-flight + indefinite capped backoff, delegating the backoff curve to the existing `RestartPolicy` (extended with a `neverGiveUp` mode for this path; the 5-restarts/hour cap stays only on the child-process crash-loop path). Manual Reconnect and extension deactivate cleanly cancel any pending auto-reconnect.

## [0.2.0] — 2026-05-22 — Single-agent executor: spawn, kill, restart from the palette

Tether becomes an executor: it can now manage a single agent process inside VSCode. v0.1.x was observer-only; v0.2 promotes it to actively spawn, kill, restart, and auto-recover a `claude` (or `codex`) terminal so you can travel without manually babysitting builder terminals.

### Added

- **`Tether: Spawn Agent`** (palette). Prompts for agent name, role, and capabilities; opens a VSCode integrated terminal with `RELAY_AGENT_NAME` / `RELAY_AGENT_ROLE` / `RELAY_AGENT_CAPABILITIES` exported in its env; types `claude` to boot. The terminal's SessionStart hook handles registration + per-instance token-vault hydration end-to-end — zero new relay-side daemon API.
- **`Tether: Kill Agent`** (palette). Disposes the managed terminal cleanly. Cancels any pending auto-restart timer so nothing zombie-respawns.
- **`Tether: Restart Agent`** (palette). Kill + respawn with the previously-recorded spec. Resets the backoff curve so a fresh manual restart starts at 1s delay again.
- **Auto-restart on crash.** When the managed terminal closes without `Tether: Kill Agent` being invoked, the manager treats it as a crash and respawns automatically. Backoff: 1s → 2s → 4s → 8s → 16s, hard-capped at 30s. Hard cap: 5 restarts per agent per rolling hour. After the cap → loud error toast (`agent crash-looping, manual intervention needed`) and the status bar flips to error state.
- **Executor-mode status bar.** When an agent is managed, the bar reads `Tether: <agentName> | <pendingCount> pending | <status>` where status ∈ `{connecting, connected, disconnected, restarting, error}`. Pending count comes from the inbox snapshot when the snapshot's agent matches the managed agent; otherwise 0. The v0.1.3 observer-mode status bar (`Tether: <count> | last Xm ago`) still renders when no agent is being managed.

### Caps are immutable at first register

Per the v0.2 brief and `memory/feedback_relay_caps_immutable.md`: declare *every* capability the agent might ever need at first spawn. Widening caps later requires `unregister_agent` first (operator-driven; Tether refuses to silently rotate caps under the hood). The spawn prompt explicitly calls this out.

### Per-agent SecretStorage

Each agent gets its own SecretStorage entry at `botRelayTether.token.<agentName>`. Legacy v0.1.3 singleton (`botRelay.agentToken`) stays read-only for backward compatibility — set fresh tokens via `Tether: Set Agent Token (SecretStorage)` or the in-line prompt during `Tether: Spawn Agent`.

`Tether: Set Agent Token (SecretStorage)` (extended in v0.2.0 R1, closing codex audit P2 on PR #38) prompts for an agent name first:

- Non-empty name (must match `[A-Za-z0-9_.-]{1,64}`) → stores/clears at `botRelayTether.token.<name>` (the per-agent executor key — same key the spawn flow + `resolvePerAgentToken` consumes).
- Empty name → stores/clears at the legacy `botRelay.agentToken` singleton (v0.1.x observer-mode backward compat).

The post-store toast text confirms which path ran (`Token stored for agent "<name>"` vs `Token stored for observer-mode singleton (v0.1.x backward compat)`) so the operator can verify their fresh token reached the right consumer.

Token-resolution precedence (per agent):
1. Per-agent SecretStorage value (`botRelayTether.token.<name>`)
2. Per-agent env var (`RELAY_AGENT_TOKEN_<NAME_UPPER>`, with hyphens + dots normalized to underscores)
3. Singleton env var (`RELAY_AGENT_TOKEN`) — v0.1.3 backward compat
4. Legacy `settings.json` — ONLY when SecretStorage is reachable (R1 contract from v0.1.3 preserved verbatim)

If SecretStorage is unreachable (Linux without libsecret, transient backend failure), the extension falls back to env-only — the v0.1.3 R1 hardening that refused to re-promote the legacy plaintext leak still applies, per-agent.

### Architecture choices (locked in `audit-findings/v0.2-tether-executor-scope-brief.md`)

- VSCode Terminal API hosts the agent process. No node-pty. Operator can drop into the terminal to debug live.
- Single-agent only in v0.2. Multi-subscription (parallel management of N agents) deferred to v0.3 per the foundation-first sequencing — ship the executor model first, then layer multi-agent state-machine complexity once the executor is proven.

### Tests

`+59` new extension-local assertions on top of v0.1.4's 44:
- `src/restart-policy.test.ts` (R1-R16, 16 tests) — backoff curve 1s→2s→4s→8s→16s clamped at 30s, custom configurations, 5/hr rolling-window cap with crash-aging semantics, success-resets-curve-not-history, construction guards.
- `src/agent-manager.test.ts` (A1-A22, 22 tests) — pure helpers (env build, shell-command allowlist), spawn/kill/restart lifecycle, crash detection + auto-restart with backoff timing via manual scheduler, 6th-crash give-up + error toast, operator-restart resets state, kill-during-pending-restart cancels timer.
- `src/v0-2-per-agent-config.test.ts` (C1-C16, 16 tests) — per-agent SecretStorage key derivation, env-var name normalization, four-level token precedence + v0.1.3 R1 SecretStorage-unreachable contract.
- `src/v0-2-status-bar.test.ts` (S1-S5, 5 tests) — exact string match on executor status bar across all five statuses + AgentLifecycleStatus → ExecutorStatus mapping.
- `src/v0-1-4-bundle.test.ts` (B6 updated, B9 added) — bundle inputs include the new modules; bundled `Tether: Spawn Agent` command creates a terminal with the contract env vars.

### Compatibility

- Marketplace minimum stays at VSCode 1.85 (Node 20 baseline, no change from v0.1.4).
- Observer-mode (v0.1.3 + v0.1.4 behavior) is preserved for users who don't use the new spawn commands — the extension activates, connects to the inbox, and shows the v0.1.x status bar until you fire `Tether: Spawn Agent`.
- Per-agent SecretStorage keys are additive. Existing v0.1.3 / v0.1.4 installs continue using `botRelay.agentToken` until the operator spawns a new agent via the palette.

### References

- Brief: `audit-findings/v0.2-tether-executor-scope-brief.md` (committed build plan, dispatched 2026-05-22).
- Auditor: codex-5-5.
- Pre-requisites (both shipped): `bot-relay-mcp@2.7.2` (spawn_agent identity recovery), Tether `v0.1.4` (bundling cleanup).

## [0.1.4] — 2026-05-21 — Bundling cleanup: VSIX from 2.84 MB / 2004 files → 348 KB / 8 files

A mechanical packaging cleanup. No behavior changes — same SecretStorage migration, same R1 hardening, same R2 doc fixes as v0.1.3. The only thing that changed is how the extension ships.

### Changed

- **VSIX is now bundled with esbuild.** Before: every byte of `node_modules` (1994 files) traveled to the marketplace alongside the extension. After: `@modelcontextprotocol/sdk` and its full transitive tree are inlined into a single `out/extension.js` and `node_modules/**` is excluded from the package. Downloads + installs are faster on every fresh VSCode profile.
- **`.vscodeignore` rewritten.** Pre-v0.1.4 it selectively excluded chunks of `node_modules` (maps, test fixtures, `.github` metadata, etc). Post-bundle the whole tree is excluded wholesale.
- **`vscode:prepublish` runs `tsc --noEmit` (typecheck) + `node esbuild.config.mjs` (bundle).** Previous: `tsc -p .` (which emitted `out/*.js` files that no longer ship). Typecheck is still required — esbuild does not type-check by design.

### Size

| | files | size |
|---|---|---|
| v0.1.3 | 2,004 | 2.84 MB |
| v0.1.4 | 8 | 348 KB |

87.8 % byte reduction, 99.6 % file-count reduction. Well under the brief's 800 KB / 50 files ceiling.

### Architectural choices

The brief left three calls to victra-build (Q1-Q3):

1. **Source maps shipped (Q1: YES).** `out/extension.js.map` ships alongside `out/extension.js`. Adds ~1 MB to the VSIX but resolves stack traces back to original `src/*.ts` for any contributor or operator who attaches a debugger. Tether is small enough that debug-friendliness > marginal-size cost.
2. **Bundle minified (Q2: YES).** esbuild's minifier is cheap (no Terser/CommonJS-shim overhead) and source maps survive intact. `keepNames: true` preserves function names for stack traces even under minification.
3. **Target Node 20 (Q3).** VSCode 1.85+ runs Electron with Node 20+; targeting older Node would bloat the output with unneeded transpilation. `format: cjs` because VSCode loads `main` via `require()`.

### Tests

- **+7 bundle-correctness assertions** (`src/v0-1-4-bundle.test.ts`):
  - Bundle exists at `out/extension.js` with non-trivial size.
  - Bundle size < 800 KB regression ceiling.
  - Source map shipped alongside.
  - Runtime externals are exactly `{vscode}` ∪ `node:*` built-ins — verified via esbuild metafile (machine-readable ground truth, not text-grep which would false-positive on ajv's string-literal `require("...")` standalone-code metadata).
  - MCP SDK appears as bundled inputs in the metafile.
  - All four `src/*.ts` modules included in the bundle.
  - Bundle loads via `require()` with a mocked `vscode` and exports `activate` + `deactivate` as functions — the actual contract the VSCode extension host enforces.
- **+10 VSIX-contents drift guard assertions** (`src/v0-1-4-vsix-contents.test.ts`):
  - vsce's `ls` output exact-matches the v0.1.4 expected file set.
  - `node_modules/**` NOT present, `src/**` NOT present, build configs NOT present, prior `*.vsix` NOT present, dev-only docs NOT present.
  - Required marketplace files present: `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, `out/extension.js`, `out/extension.js.map`.
  - File count ≤ 10 (caps future bloat).

All 25 pre-existing extension tests pass unchanged — they exercise the SAME source that the bundle inlines (`src/format.ts`, `src/transport-diagnostics.ts`, `src/config.ts`), so test relevance is preserved without a separate bundle-import path.

### Compatibility

- No runtime API surface change. v0.1.4 against any bot-relay-mcp daemon ≥ v2.6.x works identically to v0.1.3.
- VSCode minimum stays at 1.85 (Node 20 baseline already required by v0.1.3 — no regression).
- Source maps in the VSIX are a marketplace convention; no operator action required.

### References

- Brief: `Victra/briefs/2026-05-21-tether-v0.1.4-bundling-brief.md`.
- Dispatched from victra on v2.7.2 ship (msg `775be1b8`, 2026-05-21).
- Auditor: codex-5-5.

## [0.1.3] — 2026-05-13 — SECURITY: token storage migration to VSCode SecretStorage

### Security

- **[HIGH] Agent token now stored in VSCode SecretStorage** (OS keychain on macOS, Credential Vault on Windows, libsecret on Linux) instead of plaintext `settings.json`. The previous `bot-relay.tether.agentToken` configuration field exposed the credential to settings sync, dotfile backups, accidental screenshots, and shoulder-glance. (Origin: Hermes external review via review-Victra deep-review synthesis msg `2b903f9b`.)

### Added

- **First-launch migration.** On activation, if an existing plaintext `bot-relay.tether.agentToken` value is present in `settings.json` AND no SecretStorage value exists, the extension copies the value into SecretStorage, removes the field from `settings.json` (both Global + Workspace targets), and shows a one-shot warning notification recommending you rotate the token via `relay rotate-token` since the previous plaintext value may have been captured in backups. The notification offers "Reconnect with new token", "View rotation docs", and "Dismiss" actions; the flag persists in globalState so the recommendation fires exactly once per install.
- **`Tether: Set Agent Token (SecretStorage)` palette command.** New command (`botRelayTether.setToken`) prompts via a password-masked input box and stores the value via `context.secrets.store`. Submit empty input to clear the stored secret. After write, the extension reconnects automatically with the new value.

### Removed

- **`bot-relay.tether.agentToken` from the contributes.configuration schema.** Operators upgrading from v0.1.2 see the migration banner once; the setting no longer appears in the VSCode settings UI. Use the palette command above for ongoing changes.

### Compatibility

- Token-resolution precedence is now **SecretStorage > `RELAY_AGENT_TOKEN` env var > legacy settings.json** (the third tier is read only during the migration window and removed once the migration step runs). v0.1.3 against `bot-relay-mcp` v2.7.1 daemon is the recommended pairing; older daemons still authenticate the same way (the daemon never saw `settings.json`).
- VSCode SecretStorage API is identical across macOS / Windows / Linux at the JS surface; no platform-specific code path. Linux/headless hosts without libsecret fall back to `RELAY_AGENT_TOKEN` env ONLY; the legacy `settings.json` fallback is intentionally disabled when SecretStorage is unreachable (R1 security contract — see the Hardening section below). Install libsecret/gnome-keyring and reload VSCode to enable SecretStorage persistence, or set `RELAY_AGENT_TOKEN` env, or use the `Tether: Set Agent Token (SecretStorage)` palette command once SecretStorage is reachable.

### Hardening (R1, codex audit follow-up)

Codex audit on the initial v0.1.3 PR caught a P2 finding: when the SecretStorage backend is UNREACHABLE (Linux without libsecret, or transient failure), the pre-R1 code path fell through to the legacy plaintext `settings.json` value — silently re-promoting the exact leak v0.1.3 was built to close. v0.1.3 R1 splits the two empty-secret cases:

- **SecretStorage reachable + secret value empty** (operator hasn't set one yet): legacy plaintext fallback IS consulted, preserving the upgrade-from-v0.1.2 migration window.
- **SecretStorage UNREACHABLE** (backend error): legacy plaintext fallback is SKIPPED. Token resolves env-only (`RELAY_AGENT_TOKEN`); if env is also empty, the extension goes idle until the operator either installs the OS keychain backend (libsecret on Linux) and reloads VSCode, OR uses the new `Tether: Set Agent Token (SecretStorage)` palette command, OR sets `RELAY_AGENT_TOKEN` in their environment.

A one-shot warning notification surfaces the degraded mode visibly to the operator (per codex's "preferably visible warning/error" recommendation) so the failure isn't silent in the Tether output channel only. The notification fires once per install (tracked in globalState) and offers a "View install docs" action button.

### References

- v2.7.1 hotfix brief F10 + Maxime's lock 2026-05-13.
- Cross-platform parity verified per `feedback_cross_platform_parity.md`.
- R1 audit finding from codex-5-5 msg `561cf7c9`; R1 dispatch from victra msg `c6f9ee92`.

## [0.1.2] — 2026-05-12 — Reconnect resilience + discoverable manual reconnect

End-to-end smoke against a real Electron-based VS Code session validated the v0.1.1 diagnostics together with the daemon-side Phase 3/4/5 fixes (cross-process outbox, reaper-skip-while-SSE-open, SSE keepalive). v0.1.2 ships two extension-side changes that pair with the daemon's `bot-relay-mcp` v2.6.3 release:

### Added

- **Configurable SDK reconnection options.** The transport constructor now passes `reconnectionOptions: { initialReconnectionDelay: 1000, maxReconnectionDelay: 30000, reconnectionDelayGrowFactor: 1.5, maxRetries: 20 }` to `StreamableHTTPClientTransport`. The SDK default is `maxRetries: 2`, which exhausts in under 2 seconds on any transient network blip — far too aggressive for a long-running editor extension. With `maxRetries: 20` and exponential backoff (1 s × 1.5^attempt, capped at 30 s), the SDK rides out daemon restarts and brief network hiccups for roughly 6 minutes 45 seconds of accumulated wait before surfacing failure.
- **Discoverable manual reconnect on retry exhaustion.** When the SDK's retry budget is exhausted, the status bar now reads `Tether: error — run "Tether: Reconnect to Relay"` (was a generic `Tether: error — see Output channel` message in v0.1.1). The palette command `Tether: Reconnect to Relay` was already available since v0.1.0; this surfaces it where operators look when something goes wrong.

### Compatibility

- Requires `bot-relay-mcp` daemon v2.6.3 or later. The daemon-side SSE keepalive frames (released as part of the same v2.7-track work) are what prevent Electron's `fetch` from declaring the response stream idle and aborting it after ~2.5 minutes. v0.1.2 will run against older daemons but will silently degrade to the same Electron-idle disconnect class v0.1.0 exhibited.

### References

- Phase 4b commit `270acad` in the upstream bot-relay-mcp tree: source-level reconnectionOptions + status-bar text change. Drift guard at `tests/v2-7-tether-reconnection-options.test.ts` pins the contract against both `src/` and the compiled `out/extension.js` that ships in the VSIX.
- Phase 5 commit `6ec32d6` in the upstream bot-relay-mcp tree: daemon-side SSE keepalive comment frames (the load-bearing fix for Electron-fetch idle timeouts).
- Smoke validation: end-to-end Electron-based VS Code test at 2026-05-12, all signals (status-bar count update, toast, `event:` log line, daemon broadcast-trace) fired cleanly.

## [0.1.1] — 2026-05-08 — Pre-publish hotfix: transport diagnostics (instrumentation only)

v0.1.0 visual marketplace smoke caught a silent-failure window: the extension reported `connected + subscribed` in its output channel but no inbox notifications were ever observed on send. Root cause: `extension.ts` did not wire `transport.onerror`, and the SDK's `_startOrAuthSse()` path that opens the long-lived SSE GET stream (the channel notifications travel down to idle subscribers) silently swallows errors when `onerror` is unset (`@modelcontextprotocol/sdk` `dist/esm/client/streamableHttp.js:374-376` — `.catch(err => this.onerror?.(err))` is a no-op when `onerror` is undefined).

This release wires diagnostics so the next failure surfaces. It does NOT yet fix whatever actually breaks the SSE GET stream inside VS Code's Electron-based fetch runtime — that's the v0.1.2+ structural fix once we see what error the diagnostics reveal.

### Added

- **Transport diagnostics**. `transport.onerror` now flips the connection into a sticky error state (status bar reads `Tether: error — see Output channel` with the standard error background color), and `transport.onclose` logs to the output channel for visibility into session teardown. Wired BEFORE `client.connect()` so the SDK's protocol-level wrapper (`Protocol._connect` at `protocol.js:220-228`) preserves and chains our handler instead of replacing it. Order pinned by drift guard `tests/v2-6-tether-transport-diagnostics.test.ts`.
- **Sticky error-state lock**. Once a transport error fires, the `connected + subscribed` log line + status-bar success-text + initial-snapshot paint are all suppressed until the next explicit reconnect (config change OR `Tether: Reconnect to Relay` command). Prevents async failures from being silently overwritten by the success path. Verified by the helper's unit tests in `extensions/vscode/src/transport-diagnostics.test.ts`.
- **Helper extracted to `transport-diagnostics.ts`**. VSCode-free, unit-testable. Mirrors the `Transport` interface as a structural subset so the test rig doesn't need the full SDK.

### Fixed

- Nothing yet — this release surfaces the bug in operator-visible UI but does not resolve the underlying SSE GET stream failure inside VS Code's runtime. Operators who see `Tether: error` after upgrading should report the error message from the output channel; the v0.1.2 release will use that signal to land the actual fix.

### References

- Root-cause investigation: bot-relay relay msg `18362476` (2026-05-08).
- Audit verifying daemon-side broadcast contract is intact: msg `4eb34932` (2026-05-08).
- Daemon repros (Node SDK + live `:3777`) confirming notifications/resources/updated frames flow correctly to Node-based subscribers — proves the bug is VS Code runtime-specific, not a daemon issue.

## [0.1.0] — 2026-05-07

Initial public release. Ships with bot-relay-mcp v2.5.0+.

### Added

- **MCP inbox subscription.** The extension dials the local bot-relay daemon over its Streamable HTTP transport (default `http://127.0.0.1:3777/mcp`) and subscribes to `relay://inbox/<your-agent-name>`. Inbox changes arrive as MCP `ResourceUpdated` notifications — no polling, no fan-out, no traffic when nothing is happening.
- **Status bar tile.** A new status-bar item (left side) shows pending message count + last-message recency in the form `Tether: <count> | last <time>`. Color tracks severity:
  - gray when 0 pending,
  - yellow when 1-3 pending,
  - red when 4+ pending.
- **Click-to-open inbox panel.** Clicking the status bar opens a read-only webview with the most recent snapshot — pending count, total count, and a preview of the last message. Includes a link to the bot-relay dashboard at `http://127.0.0.1:3777`.
- **Optional auto-typing into integrated terminal.** When `bot-relay.tether.autoInjectInbox` is enabled, every inbox notification writes the literal string `inbox\n` into the integrated terminal whose name matches your agent. Useful when the agent's terminal IS the same name as the inbox — Claude Code wakes up immediately. Off by default to avoid surprising ambient typing.
- **Tunable notifications.** `bot-relay.tether.notificationLevel` chooses between:
  - `event` (default) — toast on every inbox change,
  - `summary` — collapsed digest every 5 minutes,
  - `none` — silent (status bar only).
- **Output channel for diagnostics.** `View → Output → Tether for bot-relay-mcp` shows connection state, refresh attempts, and per-event log lines for troubleshooting.
- **Reconnect command.** `Cmd/Ctrl+Shift+P → Tether: Reconnect to Relay` re-establishes the connection without reloading the window — useful after restarting the daemon.

### Configuration

All settings are under `bot-relay.tether.*`:

| Setting | Default | Description |
|---|---|---|
| `endpoint` | `http://127.0.0.1:3777` | HTTP endpoint of the local bot-relay daemon. |
| `agentName` | `""` | Agent name to subscribe to. Empty falls back to `RELAY_AGENT_NAME` env; with neither set the extension stays idle. |
| `agentToken` | `""` | Optional agent token for authenticated relays. Empty falls back to `RELAY_AGENT_TOKEN` env. |
| `autoInjectInbox` | `false` | On every notification, write the literal string `inbox\n` into the matching integrated terminal. |
| `notificationLevel` | `event` | `event` (toast each change), `summary` (5-min digest), `none` (silent). |

### Compatibility

- Requires VS Code `^1.85.0` (released Nov 2023).
- Requires a running bot-relay-mcp daemon. The daemon ships in [`bot-relay-mcp` on npm](https://www.npmjs.com/package/bot-relay-mcp); install via `npm install -g bot-relay-mcp` then start with `relay test` (or your operator config).
- macOS, Linux, Windows all supported — the extension is pure TypeScript / VS Code API, no native modules.

### Privacy

- Local-only by default. No telemetry, no cloud, no network calls beyond the configured `endpoint`.
- Agent token (when set) is sent as `X-Agent-Token` header to the configured endpoint only.
- The webview panel is read-only and has scripts disabled (`enableScripts: false`).

### Known limitations

- The first connection on extension activation can take up to ~1s if the daemon is still starting. The status bar shows `Tether: starting...` until the first snapshot arrives.
- Auto-typing only matches a terminal whose `name` equals the configured `agentName` exactly. If your terminal name differs (e.g. operator renamed it), auto-injection falls back to the active terminal.
- The summary digest interval is fixed at 5 minutes (not currently user-configurable).

### Coming next

- v0.2.0 candidates: bundled JS (smaller VSIX), extension icon, configurable digest interval, multi-agent subscription, dashboard auth via `bot-relay.tether.dashboardSecret`.
