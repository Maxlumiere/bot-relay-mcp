# Contributing to bot-relay-mcp

This doc explains how the project is built — the disciplines every commit is measured against, the gate every change must pass, and the devlog format that keeps history honest.

---

## Dev setup

```bash
git clone <repo>
cd bot-relay-mcp
npm install
npm run build
npm test
```

Node ≥ 18. The project uses `better-sqlite3` (native) by default; `sql.js` (WebAssembly) is an optional fallback driver — see `docs/sqlite-wasm-driver.md`.

Run the dev relay in HTTP mode:

```bash
RELAY_TRANSPORT=http RELAY_HTTP_PORT=3777 node dist/index.js
```

Watch mode for iterative dev:

```bash
npm run dev
```

---

## Karpathy discipline

Every change, no matter the size, follows these rules. Violating any = review failure.

### 1. State assumptions BEFORE code

Each new phase / meaningful change records its assumptions before the code is written:

- **Context.** Why this work exists, what's broken.
- **Verified before code.** Concrete facts about the existing surface the change depends on. Greps, reads, precedent.
- **Assumptions.** Numbered. Including subtle ones: "CAS predicate extends spec literal to include `token_hash IS ?` because the active-path re-register otherwise silently loses a concurrent rotate."
- **Planned implementation.** Ordered steps.
- **Non-goals.** Explicit deferrals — what this change does NOT do.

Assumptions-first is load-bearing. If you discover mid-build that an assumption was wrong, update the record and surface the delta in the PR description.

### 2. Surgical scope only

Ship exactly what the spec calls for. No "while I'm here" refactors. No speculative features. Three similar lines is better than a premature abstraction.

### 3. Real adversarial tests

No happy-path mocks for security features. If you added a defense, write a test that tries to defeat it. Semantic assertions only — `post_task_auto` self-assign bug sat in the smoke for months because the old assertion was `"assigned → <anyone>"` instead of `"routed → <not-sender>"`.

### 4. Changelog is honest

Fill in the **post-build** notes before opening the PR:
- **What shipped** — concrete file list + behavior notes.
- **Validation** — gate output + test count.
- **Surprises / notes** — what you didn't expect. Callouts for any deviation from the assumptions section.
- **Numbers** — test count delta, file count delta, LOC delta.
- **What's next.**

No "TBD" — if you can't fill it, the change isn't ready to ship.

### 5. Foundation before features

Never start v(N+1) while v(N) has PARTIAL or DRIFT items from review. Ship patches first, review again, THEN move on.

### 6. READ paths stay pure

A recurring discipline (precedent: Phase 4b.1 v2's `authenticateAgent`, Phase 4b.2's rotation_grace cleanup, Phase 4b.3's `decryptContent`): read helpers do NOT mutate state. Side effects live in write paths, dedicated piggyback ticks, or explicit CLI operations. If you're proposing a read-with-side-effect in a new phase, flag this discipline in the pre-code checkpoint and require explicit sign-off to deviate.

### 7. An open ticket is a claim about the past

An issue describes the repo on the day it was filed, not today. Before building anything from one, **verify the described defect still exists on `main` now** — and say so in your first line. A state check that errors or returns empty is **not** a pass; re-run it before it can license work. (Learned the hard way: a whole work session spent re-doing a refactor that had already merged, because the check — a `grep` with a glob the shell rejected — returned nothing, and "no output" was read as "nothing to find." The probe failed open and dispatched on the issue text alone.)

**This governs FIXES, not DETECTORS.** "Verify the defect exists today" is right for a *fix* — repairing what is already repaired is the waste above. But a **detector's target is absent by definition; that is precisely why you build it.** A smoke alarm is not unjustified because the house is not on fire. "This machine's config is clean today" correctly answers *should I repair this instance* — it says nothing about *should the tool be able to see this at all*, because a diagnostic exists for the machines that are **not** this one. Applied to a detector, #7 would forbid ever building one; so when the deliverable is a check/alarm/guard rather than a repair, the justification is the class's severity and silence, not its presence on this box. (The negative control then carries the weight #7 usually does: a detector that fires on a healthy state gets muted, which is worse than absent.)

### 8. CI green is a claim about a base, not a branch

A green check proves the branch passed *against the base it ran on*. Merging any PR moves `main` and invalidates every other open PR's evidence — their green now belongs to a base that no longer exists. So for each PR: rebase onto the current tip, let CI fully re-run, and re-confirm the head commit's parent equals the live `main` tip **at the moment you report or merge** — never trust a pre-move green. (Learned the hard way: two "all green" dependency PRs, verified minutes apart; the first merge moved `main` and the second was refused with `N of N required status checks are expected`. Both verifications were correct *and* stale within seconds.)

---

## Pre-publish gate

`scripts/pre-publish-check.sh` runs the full gate:

1. `tsc --noEmit`
2. `vitest run` (default — excludes load/chaos/cross-version)
3. `npm audit --audit-level=moderate`
4. `npm run build`
5. Drift guard (no hardcoded version literals in src/ outside `src/version.ts`)
6. 25-tool + CLI smoke against an isolated relay

For publish, use `--full`:

```bash
bash scripts/pre-publish-check.sh --full
```

Adds three more steps: load-smoke, chaos, cross-version. Wall clock ~90s total; gate passes unconditionally or exits non-zero at the first red step.

---

## Changelog entries

Keep a clear changelog entry per change.

- One entry per "phase" (self-contained unit of work).
- Append-only history; never rewrite shipped entries.
- Strategic / architectural documents live in design-notes (material for review).

---

## Audit protocol

The project uses a dual-model audit pattern for every major release:

1. **First pass** — the author self-reviews against the spec + runs the gate.
2. **Independent pass** — an asynchronous review by a second model (e.g. Codex). Specs + findings are handed to the independent reviewer for critique.

Findings are tracked:

- **HIGH** — blocks ship. Must be patched + reviewed again.
- **MEDIUM** — ship-patch OR deferred with explicit note.
- **LOW** — can batch into a later MEDIUM+LOW phase (see Phase 4q for the pattern).

Review verdicts are tracked in the PR / devlog so the audit trail stays grep-able — use consistent titles like `PHASE 4X AUDIT GREEN` so later searches find them.

---

## Pull request flow

1. Branch off `main` (or dev branch if the project has one).
2. Record the assumptions first.
3. Ship the code + tests. Update docs in the same PR if surface changes.
4. Run `scripts/pre-publish-check.sh` locally.
5. PR description: enumerate the closed findings / retro items.
6. For schema changes: include the migration function + CURRENT_SCHEMA_VERSION bump + `applyMigration(N-1, N)` registration. ONE migration per PR — never bundle multiple schema bumps in a single commit.

---

## What goes where

- **`src/`** — TypeScript source. Layered: `db.ts` + `auth.ts` + `encryption.ts` are the core; `tools/*` wrap MCP handlers; `cli/*` wrap the `relay` subcommands; `transport/*` is protocol adapters.
- **`tests/`** — vitest suites. One file per surface OR per phase for cross-cutting work.
- **`docs/`** — operator-facing manuals (key-rotation, backup-restore, hooks, migration-v1-to-v2, managed-agent-protocol).
- **`CHANGELOG.md`** — chronological build history. Source of truth for "why did we make this choice."
- **design notes** — strategic / architectural drafts. Specs the author receives + material assembled for the independent review pass.
- **`scripts/`** — gate + smoke scripts.
- **`hooks/`** — Claude Code hook scripts (SessionStart, PostToolUse, Stop).
- **`bin/`** — executable entries (`bot-relay-mcp`, `relay`, `spawn-agent.sh`).

---

## Questions

Open an issue on the project's GitHub, or email contact@lumiereventures.co.
