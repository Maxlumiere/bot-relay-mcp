# ADR-0012 — force = CAS takeover (amended), and the dead-anchor diagnostic (Fork B)

**Target:** v2.22.x · **Status:** BUILT — awaiting codex-5-5 dual-audit + Victra gate · **Security-adjacent (auth-model boundary)**
**Grounding:** full read of the register/force path, the presence-liveness cascade, the SessionStart hook, and the token-vault model (file:line refs inline). Supersedes the rejected #132 (`feat(ADR-0012): force = CAS takeover, not bypass`).

## 1. Problem / intent

Two defects, one arc:

1. **The origin bug (what stranded a live builder).** On a fast (<120s) re-summon of a NEW terminal for an agent whose PRIOR terminal died, the agent row still carries the dead prior session's `session_id` + `host_shell_pids` + `agent_pid`, and `last_seen` is <120s old. The SessionStart LIVE-gate in `hooks/check-relay.sh` therefore reads the row as LIVE and SKIPS re-register — so the new terminal stays bound to a dead chain. Tether cannot bind a terminal to it, no wake reaches it, and the config self-check still prints `VERDICT=HEALTHY`. It is **unwakeable, and it looks healthy** — the silence-as-health failure this whole line of work exists to end.

2. **Why #132's automatic takeover was rejected.** #132 made `force` a CAS takeover and had the SessionStart hook auto-force on relaunch when a liveness heuristic said the prior session was dead. Dual-audit (codex-5-5) + the architect rejected it: **the CAS is necessary but not sufficient.**
   - The CAS serializes the registration WRITE (it kills the double-force lost-update). That part is correct and permanent.
   - But B2's actual harm is the **mailbox drain** — two same-name terminals draining one inbox — and that lives at the **mailbox-auth layer**. `get_messages` authenticates by token/NAME and reads `session_id` *dynamically*; the CAS never touches it.
   - **P1a:** `{force, expected_session_id = <the LIVE current sid>}` matches the CAS (sid unchanged) → clobbers a LIVE terminal. sid-match ≠ dead.
   - **P1b:** a CAS *loser* still launches as a fully-authed same-name process holding the GLOBAL vault token → it STILL DRAINS.

   So safe *automatic* takeover requires **(a)** dead-anchor eligibility **AND (b)** session-bound mailbox auth, *together*. (b) is an auth-model change — deferred to **ADR-0013**. Therefore this build ships **no automatic takeover at all.**

## 2. The ruling — Fork B ("honest-smaller")

Recommended jointly by codex-5-5 (audit) and the architect, approved by Maxime 2026-07-25. Fork A (automatic takeover) is explicitly **deferred**, not partially built.

Build exactly three things:

1. **KEEP the CAS invariant** from #132 as the *permanent* definition of `force`.
2. **DISABLE automatic hook-takeover** — the SessionStart hook never auto-forces, under any heuristic.
3. **Ship a dead-anchor DIAGNOSTIC + a non-destructive, loud, operator-named recovery command.** Convert the silent hang into a loud error plus one safe command.

## 3. Design

### 3.1 `force` = CAS takeover, never a bypass (permanent)

`force` carries `expected_session_id` (the sid the caller READ). The server registration UPDATE gains `AND session_id IS ?`, so exactly one of two racers wins; the loser gets a distinct, loud `FORCE_PRECONDITION_FAILED` (never a silent mute) and must re-read + retry. Bare `force` with no `expected_session_id` is a `VALIDATION` reject — there is no unconditional-force bypass path left. Pinned by `tests/adr-0012-force-cas-takeover.test.ts` (5 cases: correct-sid win, concurrent double-force single-winner, offline `IS NULL` takeover, malformed bare-force reject, stale-sid precondition-failed).

### 3.2 No automatic takeover — even on a positively-dead anchor

A fast relaunch admits two NEW terminals that both observe the dead anchor → the CAS picks one → **the loser is a VALID new terminal that still drains, absent (b)**. Dead-anchor + blocked-loser is a *false resolution* while the loser holds the global vault token. We do not claim it as one, and we do not automate it. Auto-takeover returns only with ADR-0013's session-bound mailbox auth.

### 3.3 The dead-anchor diagnostic (`hooks/check-relay.sh`, scoped to the LIVE-skip path)

When the 120s gate would SKIP re-register, the hook probes the STORED anchor same-host and branches:

- **dead** → KILL the false-HEALTHY: emit a loud `VERDICT=UNWAKEABLE` and name the exact, copy-pasteable remedy (`relay release-binding <name>`, which PROCEEDS on a dead anchor — so the diagnostic and its remedy agree by construction).
- **unverifiable** (cross-host / no probe-able anchor) → do NOT guess and do NOT take over: emit `VERDICT=TAKEOVER_LIVENESS_UNVERIFIABLE` and point at the deliberate `--override` remedy (the bare command would *refuse* here, so naming it would deadlock).
- **alive** → a genuinely-live 2nd terminal / the same agent: the skip is correct, leave the verdict untouched. **This is the no-false-fire crux** — a live concurrent terminal has a LIVE anchor, so the diagnostic stays silent for the legitimate spawn-handoff case.

It **never auto-forces**. It is suppressed when the verdict is already `MUTE` (a bigger, more-actionable problem dominates the line).

**PRESENCE vs ELIGIBILITY — the one sentence that stops the next person merging them.** PRESENCE asks *"is there a process for this agent?"* (the dashboard; argv-inclusive). ELIGIBILITY asks *"is THIS binding's anchor dead?"* (the gate + diagnostic; anchor-only). Conflating them is what produces the deadlock. Concretely: `computeLivenessVerdict` (`src/db.ts:4102`) OR's in an argv scan (`agentProcessAdvertised`) so it reads "alive" whenever *any* live process advertises `RELAY_AGENT_NAME="<name>"` — correct for presence, but for the gate it would read a re-summoned argv-advertised agent (every `bin/codex-relay` terminal carries the name in its argv) as alive despite a dead anchor → the diagnostic names `release-binding` → `release-binding` refuses → **the entire argv-advertised half of the fleet is unrecoverable, by design.** The gate therefore has its own anchor-only verdict, `anchorLivenessVerdict` (`src/liveness.ts:442`), which reuses the same narrow-dead primitive `isAgentProcessAlive` (`src/liveness.ts:405`) *minus* the argv fallback.

### 3.4 The recovery command — why `relay release-binding`, not `relay recover`

The thing that is broken is the BINDING, not the IDENTITY. So the remedy clears exactly the binding and preserves the identity: `db.releaseAgentBinding` NULLs `session_id` + `host_shell_pids` + `agent_pid`/`agent_pid_start` (+ `last_alive`, `busy_expires_at`; sets `agent_status='offline'`) and PRESERVES `token_hash`, `name`, `capabilities`, and `host_id` — and the write is a **CAS on the observed binding** (§3.6). A fresh SessionStart on the released row then reads STALE to the LIVE-gate and takes the register path — proven sufficient in `tests/cli-release-binding.test.ts`.

`relay recover <name> --yes` was rejected as the named remedy for **three reasons**, recorded here so the error message can never regress into shipping the cut behaviour back through the front door:

1. **It frees the name.** Maxime already ruled on exactly this hazard: #119 cut the 30-day purge *because* freeing an authed agent's name reopens the bootstrap-claim window (v2.14.0). A remedy that frees the name reintroduces a deliberately-removed hazard.
2. **It destroys the token.** A relaunch then needs a NEW credential, so the vault must be updated or the agent comes up mute — a two-step with a silent-failure gap between the steps, the exact class this arc exists to kill.
3. **It destroys capabilities.** Capabilities are immutable after first register; blowing the row away is the one way to silently reset them.

`"wait >120s, then relaunch"` was also rejected — it is a timing workaround, not a recovery command; naming it would ship sleep-and-hope in the operator line.

**Why release-binding NULLs `host_shell_pids` while the lifecycle paths preserve it (the divergence a future reader must not have to re-derive).** `markAgentOffline` (`src/db.ts:2683`) preserves `host_shell_pids` — but *incidentally*: its "Deliberately preserved" list (`src/db.ts:2672`) does not name it; it simply isn't in the mutation set. The load-bearing v2.13.0 rule about `host_shell_pids` is a **read-path** rule (the presence cascade must NOT count a live shell/terminal ancestor as an ALIVE agent, because the shell OUTLIVES the agent — `tests/v2-13-0-presence-liveness.test.ts` §3). Clearing `host_shell_pids` in an operator-invoked release is therefore *consistent* with v2.13.0's spirit, not in tension with it: **a present `host_shell_pids` is not evidence of life.** That single sentence converts an apparent contradiction into the argument for the divergence — the operator path clears the stale terminal chain a lifecycle close had no reason to touch.

### 3.5 One rule, two implementations — pinned against drift

The anchor-only rule is implemented twice: `anchorLivenessVerdict` (TS) for the `release-binding` gate, and `relay_anchor_liveness` (bash, `hooks/_vault-helpers.sh:434`) for the hook diagnostic. If they drift, the failure is a **deadlock**: the hook reads DEAD and tells the operator to run `release-binding`; the CLI reads ALIVE and refuses — both confident, neither wrong on its own terms. `tests/anchor-liveness-conformance.test.ts` pins them to the same verdict across dead / live+match / PID-reuse (start mismatch) / cross-host / no-anchor, asserting TS == bash == expected on each. The load-bearing sixth fixture is a **dead anchor with a live argv-advertised process**: the gate must read DEAD, and the same row read through `computeLivenessVerdict` reads ALIVE — the one fixture that fails if anyone swaps the gate back to the presence verdict. The bash `relay_pid_alive` also mirrors `isPidAlive`'s EPERM=alive branch (a cross-user process at the recorded PID reads alive on both sides), closing a latent same-direction divergence.

**Message honesty.** `anchorLivenessVerdict` collapses "observed alive (start matched)" and "present-but-unverifiable (no/unreadable start anchor → PID reuse cannot be excluded)" into one `alive` verdict — the RULE is correct (fail toward NOT acting), but the operator MESSAGE must not assert liveness it has not observed. The refusal text branches on whether a start anchor is on record, so it never claims "observed dead" when what it has is "cannot verify." This is message-only — it adds no verdict state and so cannot drift the two probes apart.

### 3.6 The recovery write is ITSELF a TOCTOU — CAS it (codex #136 P1)

**The finding, and it is the most valuable thing this arc produced.** The same defect — *observe state, then act on that observation without proving the state still holds at the moment of the write* — has now appeared THREE times, one layer down each time:

1. **Registration layer** — the original force-TOCTOU (a client ps-check + a non-atomic force). Fixed by the server CAS (§3.1).
2. **Mailbox-auth layer** — codex's reframe: a CAS *loser* still drains, because mailbox auth reads `session_id` dynamically. Deferred to ADR-0013 (§2/§3.2).
3. **Recovery-write layer** — the first cut of `release-binding` probed the anchor, decided "dead, safe to release," then wrote `UPDATE … WHERE name = ?` with **no CAS**. Between the probe and the write, a legitimate fresh rebind can land (a new terminal wins `register(force, expected_session_id=<observed>)` → rotates `session_id` + overwrites the anchor with its own live pid). The blind release then clears that NEW live binding and **reports SUCCESS** — stranding a healthy terminal unwakeable, the exact outcome the liveness gate was added to prevent. **We built a whole fork around refusing to act on assumed state, and the remedy itself acted on assumed state.** Reproduced by codex against built `dist/db.js` (old=b579…, live=dd90…, after=null).

**The fix.** `releaseAgentBinding(name, expected)` is now a CONDITIONAL update predicated on the FULL binding identity the probe evaluated: `WHERE name = ? AND session_id IS ? AND agent_pid IS ? AND agent_pid_start IS ?` (`IS`, so NULLs compare null-safe). The claim it makes is "the row I am writing is the row I looked at" — and it makes it on all three fields, not `session_id` alone, because that is the strongest claim the available fields support. `changes = 0` → the binding moved under us → the CLI REFUSES loudly (nonzero exit, empty stdout, "binding changed since it was probed; re-read, NOT released"), the **same shape as a `FORCE_PRECONDITION_FAILED` loser** — deliberately, so it reads as the same thing. No retry, no re-probe loop: it is handed back to the operator. Pinned by the RACE regression in `tests/cli-release-binding.test.ts` (a fresh rebind after the probe SURVIVES the release; verified to FAIL without the CAS).

**The rule for the next person touching a binding write:** never write a binding you merely observed — CAS it on what you observed, or refuse.

## 4. Explicit non-goals (shipping any = a rejected build)

- **NO** session-bound mailbox auth; **NO** changes to `get_messages` / `get_messages_summary` / `resolve_messages` / recipient-mutation auth. That is **ADR-0013**.
- **NO** automatic takeover, even gated on a positively-dead anchor (§3.2).
- **NO** opportunistic refactors in the auth layer.

## 5. Why B is not throwaway

The dead-anchor probe IS the substrate for Fork A's eligibility leg (codex TIER-1). It is built to stage cleanly into ADR-0013: a reusable anchor-liveness verdict shared by CLI + hook, not an inline hook hack.

## 6. Tests / gate

- CAS invariant — `tests/adr-0012-force-cas-takeover.test.ts` (unchanged, cherry-picked from #132).
- Anchor conformance — `tests/anchor-liveness-conformance.test.ts` (TS≡bash≡expected; argv-advertised divergence guard).
- Diagnostic + **negative control** — `tests/check-relay-dead-anchor.test.ts` proves the verdict flips HEALTHY→UNWAKEABLE, and (verified by reverting the diagnostic) that WITHOUT the fix the row prints `VERDICT=HEALTHY` — the false-HEALTHY. Plus no-false-fire (live anchor stays HEALTHY) and unverifiable→`--override`.
- Remedy — `tests/cli-release-binding.test.ts`: preserves token/name/caps/host_id; REFUSES on a live anchor and mutates nothing; refuses cross-host (unverifiable); `--override` releases with a loud note; sufficiency (post-release LIVE-gate reads STALE → SessionStart re-registers); and the **RACE regression** (§3.6) — a fresh rebind after the probe SURVIVES the release, verified to FAIL without the CAS.
- Full CI at HEAD (root + extensions/vscode + `npm audit`, GitHub-green at the real HEAD, `npm ci` in the pre-merge gate), then codex-5-5 dual-audit before merge. No npm-publish (Maxime's 2FA gate; version bump deferred to release).

## 7. Accepted residual

Fork B does not auto-refresh the stale binding (safe auto-refresh needs (a)+(b), §1/§3.2). It converts the silent unwakeable hang into a loud, self-announcing error plus one non-destructive command. That is the accepted residual until ADR-0013.
