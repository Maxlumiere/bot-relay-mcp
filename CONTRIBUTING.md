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

Every change, no matter the size, follows these rules. Violating any = re-review failure.

### 1. State assumptions BEFORE code

Each new phase / meaningful change writes a devlog entry under `devlog/NNN-vX.Y.Z-title.md`. The entry has:

- **Context.** Why this work exists, what's broken.
- **Verified before code.** Concrete facts about the existing surface the change depends on. Greps, reads, precedent.
- **Assumptions.** Numbered. Including subtle ones: "CAS predicate extends spec literal to include `token_hash IS ?` because the active-path re-register otherwise silently loses a concurrent rotate."
- **Planned implementation.** Ordered steps.
- **Non-goals.** Explicit deferrals — what this change does NOT do.

Assumptions-first is load-bearing. If you discover mid-build that an assumption was wrong, update the devlog and surface the delta in the ship-pong.

### 2. Surgical scope only

Ship exactly what the spec calls for. No "while I'm here" refactors. No speculative features. Three similar lines is better than a premature abstraction.

### 3. Real adversarial tests

No happy-path mocks for security features. If you added a defense, write a test that tries to defeat it. Semantic assertions only — `post_task_auto` self-assign bug sat in the smoke for months because the old assertion was `"assigned → <anyone>"` instead of `"routed → <not-sender>"`.

### 4. Devlog is honest

Fill in the **post-build** section before ship-pong:
- **What shipped** — concrete file list + behavior notes.
- **Validation** — gate output + test count.
- **Surprises / notes** — what you didn't expect. Callouts for any deviation from the assumptions section.
- **Numbers** — test count delta, file count delta, LOC delta.
- **What's next.**

No "TBD" — if you can't fill it, ship-pong is premature.

### 5. Foundation before features

Never start v(N+1) while v(N) has PARTIAL or DRIFT items from review. Ship patches first, re-review, THEN move on.

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

## Devlog numbering

Sequential zero-padded: `devlog/001-first-test.md` through `devlog/055-v2.1-load-chaos-crossversion.md` as of v2.1.0.

- One devlog per "phase" (self-contained unit of work).
- Title: `NNN-vX.Y.Z-topic.md` (e.g. `046-v2.1-unified-cli.md`).
- Never renumber; append-only history.
- Strategic / architectural documents live in `audit-findings/` (Victra + Codex brief material).

---

## Audit protocol

The project uses a dual-model audit pattern for every major release:

1. **Claude side** — the builder self-reviews against the spec + runs the gate.
2. **Codex side (GPT)** — asynchronous review. Specs + findings shipped in `audit-findings/` get pasted into Codex for independent critique.

Findings are tracked:

- **HIGH** — blocks ship. Must be patched + re-reviewed.
- **MEDIUM** — ship-patch OR deferred with explicit note.
- **LOW** — can batch into a later MEDIUM+LOW phase (see Phase 4q for the pattern).

GREEN verdicts between Victra + the builder travel via the MCP relay itself (`send_message` with `priority: "high"`). Keep the message body grep-able — titles like `PHASE 4X AUDIT GREEN` so later searches across `audit_log.params_summary` find them.

---

## Pull request flow

1. Branch off `main` (or dev branch if the project has one).
2. Write the devlog assumption-first.
3. Ship the code + tests. Update docs in the same PR if surface changes.
4. Run `scripts/pre-publish-check.sh` locally.
5. PR description: link the devlog; enumerate the closed findings / retro items.
6. For schema changes: include the migration function + CURRENT_SCHEMA_VERSION bump + `applyMigration(N-1, N)` registration. ONE migration per PR — never bundle multiple schema bumps in a single commit.

---

## What goes where

- **`src/`** — TypeScript source. Layered: `db.ts` + `auth.ts` + `encryption.ts` are the core; `tools/*` wrap MCP handlers; `cli/*` wrap the `relay` subcommands; `transport/*` is protocol adapters.
- **`tests/`** — vitest suites. One file per surface OR per phase for cross-cutting work.
- **`docs/`** — operator-facing manuals (key-rotation, backup-restore, hooks, migration-v1-to-v2, managed-agent-protocol).
- **`devlog/`** — chronological build history. Source of truth for "why did we make this choice."
- **`audit-findings/`** — strategic / architectural drafts. Specs the builder receives, Codex briefs Victra assembles.
- **`scripts/`** — gate + smoke scripts.
- **`hooks/`** — Claude Code hook scripts (SessionStart, PostToolUse, Stop).
- **`bin/`** — executable entries (`bot-relay-mcp`, `relay`, `spawn-agent.sh`).

---

## Questions

Open an issue on the project's GitHub, or email maxime@lumiereventures.co.
