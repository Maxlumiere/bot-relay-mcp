# Control-plane target architecture

**Provenance:** ADR-0007, ratified at full scope 2026-07-25. Authored by the architect; the orchestrator converts
slices into build briefs and owns sequencing. This document is the durable statement of *where the relay is going*,
so every slice lands as a permanent part of one design.

**Status (reality-check, 2026-07-26, base `936f5f3`, post-#141):** now under version control. Verified against main —
S0's "already exists unnamed" list holds: dead-anchor Fork B (#136), register-time `server_version` recording, and
the wake-routing module (#126) are merged. One shipped-status correction was applied: L2 (see §4) was marked
"shipped / live since v2.22", but main carries only the *resolve/read-receipt* substrate (`resolved_at` +
`resolve_messages`) — the `disposition` classification AND the operator-recap query surface are unmerged (PR #127).
The cross-referenced ADRs are a mix of states: **ADR-0012** and **ADR-0015** are committed in `docs/`, **ADR-0006**
lands with the in-flight operator-auth PR, and the remainder (0005 / 0007 / 0008 / 0009 / 0010 / 0011 / 0013) are
forthcoming deliverables not yet in `docs/` — cited here by number as the roadmap intends, not as extant files.

## 1. Why

Coordinating N agents over a plain message bus costs O(N) human attention: every question about the fleet — *is this
agent alive? what version is it running? is anyone watching its inbox? which wake path covers it? is that message a
log or an unanswered obligation?* — is answered today by a person (or an agent spending attention) reading things and
remembering. Seven operational gaps documented in a single day all reduced to this shape. Our own standing rule says
a convention the user must remember is a relay bug; these are seven of them.

Root cause: no single process authoritatively **observes** the whole fleet. State is smeared across per-session
server processes, a shared database, and human memory.

## 2. The shape

The relay becomes **a message bus plus a control plane**:

- **The relay owns FACTS and DRIFT-DETECTION.** It models its own operational state as queryable data and reports
  loudly when reality diverges from what was declared.
- **The orchestrator and the human own INTENT and JUDGMENT.** The plane is strictly **report-first**: it never
  auto-acts on inferred state. Drift produces a report, not a remediation.

The definition of done, stated as a test: *any question about the fleet is answerable in one query of observed
state; drift is reported unprompted within a bounded delay; zero human memory is required for correct operation.*

## 3. Invariant layer (applies to every slice)

1. **Honest system.** Make the knowable loud, mark the unknowable explicit, never let a guess pose as knowledge —
   by acting on it, hiding it, or asserting it.
2. **Observed, not assumed.** Liveness, coverage, and version are recorded as *observations with verdicts*
   (`alive | dead | unverifiable`), never booleans inferred from identity or recency. An unverifiable fact is
   surfaced as unverifiable.
3. **No irreversible action on an undecidable predicate** (ADR-0005). Inference gates only reversible effects.
4. **No silent discard.** A caller's differing declaration is either applied and echoed, or refused and stated.
5. **Guards enforce the harm-predicate, not a proxy** (ADR-0015), and every guard ships with a harm-attempt test
   and its innocent twin.
6. **Location is not a principal** (ADR-0006). Power derives from authenticated identity + capability, never from
   network position.

## 4. The model — three layers of one thing

### L1 — Fleet facts (foundation)
Per agent, the plane holds current, observed data:
- **Identity:** name, class (mutable hint), capabilities (immutable authorization ground truth).
- **Declared-at-register:** server version, config fingerprint, wake-coverage claim. Registration is the single
  assertion gate every agent already passes through — the natural chokepoint (ADR-0008).
- **Binding:** host, terminal chain (`host_shell_pids`), process anchors (`agent_pid` + start time).
- **Liveness:** tri-state observed verdict with provenance (which probe, when).
- **Wake coverage:** which driver (Tether / post-tool-use hook / Sentinel / future CLIs) is *verified* to cover the
  agent in each state — never inferred from the agent's CLI identity (the Gap-4a lesson).
- **Watchers:** a registry of who watches whom; one watcher per name, enforced.

### L2 — Work disposition (resolve substrate live; disposition + query surface in flight)
Message disposition (log / ask / obligation), sticky agent-level read, explicit resolve, pull-queryable
outstanding/overdue (ADR-0011). What is live in main today is the **explicit-resolve + read-receipt substrate** — the
`resolved_at` column and the `resolve_messages` tool. The rest of ADR-0011 — the per-message `disposition` /
`deadline` / `read_at` columns AND the operator-recap query surface (`get_outstanding`, the pull-queryable
outstanding/overdue view that makes L2 answer "what is owed, by whom, how late" in one call) — is **in flight as PR
#127, not yet merged** (verified against main: it carries no `disposition` column). L2's substrate is the resolve
layer; the disposition classification and the recap surface land together with #127.

### L3 — Desired state + reconcile + report
A declared fleet spec — which agents should exist, what coverage each should have, the minimum protocol version —
plus a reconcile loop that compares spec to observation and **reports** drift (never repairs it). Reports are
facts-first: known facts as facts, inferred states explicitly confidence-marked (the ADR-0008 sharpening), bounded
in frequency so the channel stays credible.

## 5. Substrate — one authoritative observer

The control plane needs one process that sees everything. Two moves converge here:

- **HTTP-default transport, one daemon** (ADR-0009): one process, one version; kills version skew and the
  path-encoding bug class by construction. Gated on the client auto-reconnect test — the test decides the *path*
  (native reconnect vs. a thin stable connection-holder in front of the daemon), not the destination. Companions in
  the definition of done: cross-platform daemon supervision (launchd / systemd / Windows) and loud mute-detection.
- **Elevate the outbox-tail** — the one component that already observes every commit — into the plane's observer,
  rather than building a parallel watcher. Additive, not a rewrite.

## 6. What gets deleted (the plane is also a subtraction)

- N per-session stdio servers on drifting versions → one supervised daemon (stdio remains supported where no daemon
  exists; version floor + register-declared version make residual skew visible and bounded).
- Ad-hoc watcher processes with no registry → registered, single-instance watches.
- Per-CLI wake special cases → drivers under one coverage/routing model (ADR-0010). The three wake mechanisms are
  permanent host physics; the *special-casing* is what dies.
- Two databases → one.

## 7. Slice sequence

Each slice is permanent — nothing here is scaffolding to revisit. The orchestrator sequences these against
everything else in flight; gates are stated per slice.

**S0 — Name and connect (no behavior change).** Much of the plane already exists unnamed: L2 (ADR-0011), the
wake-routing module, dead-anchor liveness diagnostics (Fork B), register-time version recording. S0 writes the fact
catalog, maps each existing mechanism to its place in this model, and flags contradictions. Done when: every L1 fact
has a named source of truth or an explicit "not yet observed" entry.

**S1 — Register assertion gate.** Every launch declares version / coverage claim / config fingerprint; the relay
flags inconsistency at the one chokepoint every agent already hits. Done when: a stale-version or
inconsistent-config launch produces a loud, queryable flag. Harm-test: launch with a mismatched declaration →
assert flagged; identical re-declaration → assert quiet.

**S2 — Observed coverage + watcher registry.** Coverage is verified per driver (a claude-CLI agent with a broken
PostToolUse hook must read *uncovered*, not assumed-covered); `relay watch` acquires a per-name single-instance
lock and registers itself. Done when: killing an agent's hook or doubling a watcher produces a report within a
bound. Harm-tests: break the hook → coverage flips to unverified/uncovered; start a second watcher → refused.

**S3 — Substrate.** HTTP-default daemon behind the reconnect gate (path A: native; path B: connection-holder);
single DB; protocol-version floor with loud refusal below it. Done when: one bounce updates every connected
session, or path B's holder demonstrably survives a daemon bounce; a below-floor server refuses loudly.
Note: container behavior claims (e.g. the #122 fix) are treated as *unverified until reproduced* — the daemon
work must not build on them.

**S4 — Desired state + reconcile/report (L3).** Declared fleet spec; drift reports; integration with the L2 recap
so "what is drifting" and "what is owed" arrive as one queryable view. Done when: spec-vs-observed drift (a missing
agent, an uncovered state, a version below floor) is reported unprompted within its bound, and a fresh orchestrator
session can pull the full picture in one call. Harm-test per ADR-0015; innocent twin: a compliant fleet produces
zero reports (alert-fatigue leg).

**S5 — Consolidation deletes.** The ADR-0006 arc (split the DB god-module, unify presence derivation into the L1
liveness model, fold version-organized tests into contract suites, drop unused schema) lands here, aligned with the
plane instead of as an independent cleanup.

## 8. Non-goals

- **No auto-remediation.** The plane reports; humans and the orchestrator decide. Any future auto-act proposal is a
  new ADR against invariant 3, not an extension of this one.
- **No judgment transfer.** Dispatch, prioritization, and build sequencing remain the orchestrator's.
- **Session-bound mailbox auth (ADR-0013 Fork A)** is a separate security track; the plane depends on it nowhere.
