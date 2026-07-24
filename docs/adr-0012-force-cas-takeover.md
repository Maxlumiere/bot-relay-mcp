# ADR-0012 — `force` is a CAS TAKEOVER, not an unconditional bypass

- **Status:** Accepted (architect + victra), implemented on `fix/force-cas-takeover`.
- **Supersedes:** the client-side-force approach in the rejected #131.
- **Context origin:** codex-5-5's dual-audit of #131 (host_shell_pids stale-on-restart).

## Context

The `host_shell_pids` stale-on-restart fix needs a relaunched agent to re-register
over an actively-held row so Tether's PID-binding refreshes. The first attempt
(#131) did this with the existing `force` flag, which was an **unconditional
bypass**: `handleRegisterAgent` skipped the B2 collision guard when `force=true`,
and the db re-register CAS guarded `auth_state / token_hash / recovery_token_hash`
but **not** `session_id` / `host_shell_pids`.

codex-5-5 proved this reopens a lost-update TOCTOU (P1b): two simultaneous
relaunches both read the same stale chain, both `force`, and the last writer
clobbers the first. A client-side `ps` check cannot make `force` safe — the check
and the write are not atomic. Related findings: the same bug strands **Codex**
agents (P1a — `bin/codex-relay` + `codex-session-start.sh` were non-force), and
the client discriminator has two MED limits (PID-reuse false-skip;
live-ancestor ≠ live-agent).

## Decision

Redefine `force` from an unconditional bypass into a **conditional compare-and-swap
(CAS) takeover** adjudicated by the server.

1. **`force` carries `expected_session_id`.** It is the `session_id` the client
   READ from the row it intends to take over. `null` is a valid *explicit* value
   meaning "I expect an offline row" (CAS matches `session_id IS NULL`). It is
   deliberately **not** `host_shell_pids` (both racers read the same stale chain →
   non-discriminating) and **not** a nonce (`session_id` is already fresh-per-
   session, so there is no ABA problem). A takeover MINTS a new `session_id`.

2. **`force=true` REQUIRES `expected_session_id`.** Bare `force` (no
   `expected_session_id`) is rejected as **malformed** (`VALIDATION`). **There is
   no unconditional-bypass path left in the codebase** — `force` ALWAYS compares
   and swaps from an expected state. An operator force-claiming reads the current
   `session_id` first, then CASes with it (read-then-swap). (`relay recover` is
   unaffected — it uses `teardownAgent`, not register-force.)

3. **Server CAS in the db re-register** (`registerAgent`, replacing the
   force-bypasses-B2-no-CAS path). The UPDATE gains `AND session_id IS ?` when
   `expected_session_id` is supplied:
   - `changes == 1` → **WON**.
   - `changes == 0` with a session mismatch → `ForcePreconditionError` →
     `FORCE_PRECONDITION_FAILED` (distinct from the auth-race `ConcurrentUpdate`,
     disambiguated by a best-effort re-select).
   Two simultaneous relaunches both anchored on `S_old`: the first flips
   `S_old → S_A`, the second matches 0 rows and loses. **Exactly one winner by
   construction.** This **subsumes B2** — collision is now *enforced* by the CAS,
   not *bypassed*.

4. **The loser is loud, never mute** (silence-as-failure). On
   `FORCE_PRECONDITION_FAILED` the client does **not** retry-force; it re-reads
   (the row is now live-held by the winner → its LIVE gate SKIPs) and surfaces a
   visible ⚠️ ("another live session holds this name — duplicate relaunch").

5. **The client `ps` discriminator is ADVISORY, not the safety authority.**
   `relay_binding_live_elsewhere` still decides *whether to attempt* a takeover
   (skip when a live foreign process holds the binding; attempt on a relaunch),
   which is what protects a genuine concurrent terminal. But because the server
   CAS is the concurrency authority, a discriminator error can no longer cause a
   *clobber* — only a **bounded, self-healing wake miss** (the next hook run
   re-evaluates). The two MED limits are therefore demoted to tracked follow-ups
   (interim: documented bounded false-skip):
   - **PID-reuse false-skip** — `ps -p` can't tell a recycled PID from the
     original; a pid+start-time snapshot for the host chain (mirroring
     `relay_pid_start` for `agent_pid`) is the follow-up fix.
   - **live-ancestor ≠ live-agent** — a stored PID can be alive while its agent
     already exited; same class, same follow-up.

6. **Codex parity (P1a).** The relaunch takeover happens in the SessionStart
   **hook** (`codex-session-start.sh`), which now runs the same advisory
   discriminator + CAS force (reading the row via `discover_agents`, since the
   Codex hook is HTTP-only). `bin/codex-relay` stays a **non-force** cold-start
   pre-register that gracefully defers to the hook on a live-session rejection —
   it has no `session_id` to CAS against on a cold start, and forcing there would
   duplicate the hook's takeover. No bypass anywhere: the launcher defers, it
   never bypasses B2.

## Consequences

- New MCP input `expected_session_id`; new error code `FORCE_PRECONDITION_FAILED`;
  new `ForcePreconditionError` (db).
- A duplicate relaunch is now a defined, loud outcome instead of a silent
  clobber or a stale binding.
- Both Claude and Codex relaunches refresh `host_shell_pids` safely under
  concurrency.

## Tests (gating)

- **concurrent-double-force** → exactly ONE winner; the loser gets
  `FORCE_PRECONDITION_FAILED`, re-reads, and surfaces loudly (never mute).
- **offline takeover** (`expected_session_id=null` → CAS on `IS NULL`).
- **malformed reject** (`force` without `expected_session_id` → `VALIDATION`).
- **Claude stale-restart** seam (R1 all-dead → CAS-force re-register; R2 live
  foreign → skip; R3 dead leaves + shared LIVE ancestor → CAS-force re-register).
- **Codex stale-restart** seam (shipped `codex-session-start.sh` → CAS-force
  re-register).
- **loser-not-mute** at the hook seam.
- PID-reuse mocked-`ps` → follow-up PR.
