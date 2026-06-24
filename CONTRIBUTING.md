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
