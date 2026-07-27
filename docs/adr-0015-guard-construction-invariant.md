# ADR-0015 — Guard-construction invariant: a guard enforces the harm-predicate, never a proxy

**Status:** Accepted (architect ruling, 2026-07-25). Documented with worked evidence from the ADR-0006 dashboard/daemon hardening cluster (PR #141).

## Context

A "guard" here is any check that stands between an input and a harm: an auth gate, a redaction, a health probe that decides whether to install a daemon, a test that certifies a fix. Guards fail in a characteristic way: they enforce a **proxy** for the harm instead of the **harm predicate itself**, the two agree most of the time, and the gap between them is exactly where the exploit lives. Four unrelated guards failed this way in a single day — all with a green suite, all caught only by adversarial reading — which established the failure as structural, not coincidental.

The proxies were: file **bytes** standing in for "the relay hook fires on SessionStart"; a **display verdict** standing in for "this agent can act"; **ambient environment** standing in for "the caller is authorized"; a **past observation** standing in for "the state is still true at the moment of the write". In each case the proxy-predicate gap was the hole.

## Decision — the invariant, in four legs

A guard is correct only if all four hold. State them in the guard's own artifact so the next person editing it must satisfy them consciously.

- **L1 — HARM + PREDICATE DECLARED.** The guard names the harm it prevents, the predicate it enforces, and why `predicate ⟹ harm-prevented`. If you cannot write that sentence, the guard is enforcing a proxy. (A byte-hash of a config file is not "the hook fires.")
- **L2 — FRESHNESS.** An *observed* predicate authorizes a write only if the write is CAS'd on that observation. `observe → decide → act` is never unconditioned — a live rebind can invalidate the observation between the check and the act (same root as ADR-0012).
- **L3 — BYPASS INVENTORY.** Enumerate every input that can disable or weaken the guard, and authenticate-or-remove each. A guard is **never** weakened by ambient environment (an env var, a CI flag, network position).
- **L4 — SIGNAL CONTRACT.** A shared signal may be consumed as *authorization* only if its contract declares it authorization-grade (display/dashboard verdicts never authorize). And diagnostic and enforcement must consume the **same** predicate — one source, no split-brain.

### The test rule ("green by construction")

A guard is tested by **attempting the harm through the real shipped path** (assert refused) **and** by its **innocent twin** (assert passes). Both legs are mandatory:

- No harm-leg → the tests codify the bypass (a suite that asserts the hole is "correct" defends it against the person trying to fix it).
- No innocent-leg → an unpassable guard → alert fatigue → the silence-as-failure inversion.

Tests derived from the *implementation* assert the mechanism and therefore defend its holes. Only tests derived from the *harm* mean "green = safe." A guard's contract IS the impossibility of the harm — assert that, per case, field-agnostically, never a proxy.

## Worked evidence (PR #141 — the ADR-0006 cluster)

This cluster is the strongest illustration the codebase has produced, because the same lessons recurred at successive layers and each intermediate fix was *correct and insufficient*.

1. **parse → fetch → body — one fail-open defeated at three layers of a single request.** The daemon health probe treated "anything went wrong" as "port is free" and would install a *competing* daemon. Round 1 fixed the **parse** failure (empty/non-JSON body). Round 2's `reachable:false` was still the catch-all for every **fetch** failure — a redirect-to-a-dead-target and a socket reset both read as free. Round 3 narrowed "free" to a *positive* determination (an unambiguous `ECONNREFUSED`) — but cleared the abort timer after `fetch`, leaving the **body** read unbounded, so a server that sent headers then stalled hung the installer forever. The repair that finally held is the L1/L4 move: **enumerate the SUCCESS condition** ("the port is free" is *only* `ECONNREFUSED`), and bound the whole operation (the abort timer spans `fetch` *and* `res.json()`). When a fail-open comes from an over-broad `catch`, you fix it by naming success, never by adding one more failure case to the handled list — every unknown future failure must inherit "refuse", not "free".

2. **Provenance is not severity.** The first stopping rule for the review cycle was "findings only in newly-introduced code → churn → freeze and ship." It was wrong: a P1 written twenty minutes ago is still a P1 about to ship. Round 4 proved it the same afternoon by finding a real hang **introduced by round 3's own patch**. The corrected rule gates on **severity and convergence** — fix any P1 regardless of age; log sub-P1s and ship; treat "two rounds running where a fix spawns a comparable-severity finding" as oscillation and put the design back on the table.

3. **The L4 same-row contradiction — single-sourcing a constant is not single-sourcing a predicate.** A `routable` field was added specifically so the router and the dashboard could not disagree about whether an agent can receive work. It was computed from raw `agent_status` while the display *normalized* it, and the router's SQL applied a case-sensitive `NOT IN` — so a persisted `OFFLINE` produced a row reading `agent_status: 'offline'` **and** `routable: true` at once: the field disagreeing with its own neighbour. Sharing the *status list* between SQL and JS (a constant) was not enough; L4 requires sharing the *predicate*. The fix drops the SQL status filter entirely and routes both the enforcement and the surface through one `isAgentRoutable()`.

4. **Free-text vs structural — the classification boundary was the bug.** An unauthenticated projection (the dashboard snapshot) leaked cross-agent secrets three times: first the raw `content` column (plaintext when at-rest encryption is opt-in — the default), then the free-text `description`/`title` fields hiding under innocuous names, then a webhook `url` that *is* a credential. A denylist could not close it. The durable form is an **allowlist by classification**: every field is either operator-authored **free text** (can carry a secret regardless of its name → excluded, or admitted only as a documented, constrained exposure) or **structural** (a fixed vocabulary the system controls → safe). Classify every field in the artifact, and test the harm per-field with a distinct secret so a leak names its own field.

## Anti-pattern — a comment asserting an invariant is not evidence the invariant holds

A recurring failure: a comment states the exact property the adjacent code violates. It is evidence someone *intended* the invariant, never that it *holds* — and it actively misleads the next reader into trusting the code without checking. Observed four times in one week:

- the webhook mapper comment declaring the dashboard "never leaks secrets" beside code that shipped a webhook URL credential (PR A);
- a `--force` alias comment claiming re-registration is rejected without the flag, beside code that accepted it;
- `db.ts` comments asserting a guard that had already been deleted;
- a `csrfCheck` comment reading *"This MIRRORS dashboardAuthCheck's channel precedence — keep the two in sync (ADR-0015 L4)"* directly above six lines that broke the mirror (the exemption matched any `Authorization` header; the consumer accepted only `Bearer `), so a non-Bearer header skipped CSRF while authenticating from the ambient cookie.

The cure is L4's own medicine applied to the comment: if two sites must agree, do not ask a comment to keep them agreeing — extract ONE predicate both call, so agreement is structural and the comment becomes true by construction. A comment that must be manually kept true is a latent bug with a due date. When reviewing, treat an invariant-asserting comment as a **claim to verify**, never as evidence that the invariant holds.

## Consequences

- New guards and projections declare L1–L4 inline and carry harm + innocent-twin tests.
- "Make it impossible, don't detect it afterwards": prefer allowlist over denylist, positive success-condition over failure-list, one shared predicate over two implementations, and a constrained write over an unconstrained store validated on read.
- Verification is described precisely — which platforms/versions actually executed a check — never rounded up to "verified" or down to "unverified"; an understated claim invites redoing done work, an overstated one ships a hole.

**Depends-on:** [[ADR-0008]] (honest system), [[ADR-0012]] (CAS-at-write), [[ADR-0006]] (location is not a principal), the silence-as-failure invariant, test-asserts-the-contract-not-a-proxy, test-path-must-match-the-shipped-path.
