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

Node ≥ 22. The project uses `better-sqlite3` (native) by default; `sql.js` (WebAssembly) is an optional fallback driver — see `docs/sqlite-wasm-driver.md`.

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

**And the stronger form: a test that claims to prove a NO-HANG must be able to HANG.** A fixture that cannot express the failure it guards is not a weak test — it is an *absent* one that reads green forever. So before trusting any such test, remove the fix and watch it fail; if it still passes, the fixture is what you have been testing, not the code. (Learned the hard way: a SessionStart hook read its payload with `head -c N`, which bounds **size**, not **time** — `head -c` returns when it has N bytes *or when the writer closes*, and `spawn(cmd, {})` with no `stdio` option hands the child a pipe nobody ever writes to or closes. The hook hung against its 10s timeout and a publish-blocking canary timed out at 5s. The purpose-built announce test asserted "no payload completes promptly" and passed cleanly throughout, because `spawnSync`'s `input:` **always** closes the write end: the harness was structurally incapable of producing the one condition that breaks the code. The repair is two-part — bound any read of *inherited* stdio in TIME (`perl` `alarm`; macOS ships neither `timeout` nor `gtimeout`, and with no bounded read available the right move is to SKIP the payload, because one unrecorded record costs less than a hung session start), and add a case in the **real caller's** shape that can actually hang. Note also that timing a pipeline mismeasures it — `sleep 30 | cmd` waits for every member, so time the process alone through a FIFO. Same root as §10: your own fixtures are your threat model.)

**And the pre-flight that catches this whole class: prove the harness GREEN before you trust a RED.** A fixture never seen working certifies nothing in either direction — a crash *in the harness* and a genuine reproduction produce the same failing assertion, and the crash is the likelier of the two. Three rules, all learned in one day:

1. **Green baseline first; only then remove the fix to get red.** Green proves the instrument, red proves the defect; reversed, you cannot tell them apart. (Learned the hard way: a concurrency regression's first "red" reported **zero** current rows with empty child output, and was nearly filed as the defect reproducing. Every child had died with `ERR_MODULE_NOT_FOUND` — the runner script sat in `$TMPDIR`, and Node resolves bare specifiers by walking up from the importing *file*, so `better-sqlite3` was unresolvable under `/var/folders`. The genuine red, once the harness worked, was **eight** rows. **Zero rows and eight rows both read as "not one row" if you only check the assertion count.** Isolate the right artifact, too: the *database* needed to be in `$TMPDIR`; the *script* needed to stay where its imports resolve.)
2. **Never discard the channel where the real error would appear.** That child's reason existed only on stderr, which the harness ignored — the same defect as a `grep` filter that hid a build failure, and a `tail -30` that cut off the first of two failing suites. Three instances in one day of an instrument that could not express the failure it was built to detect.
3. **Check the WIDE answer, not just the narrow assertion.** With the unique index in place but no backoff, the row-count assertion passed — exactly one current row — while **five of eight** child processes reported `database is locked`. In production each of those is a SessionStart hook leaving a window unrecorded. **Surviving a race is not handling it**, and a narrow bar can be 100% of the narrow answer and 0% of the wide one (§8's corollary, in miniature).
4. **A deferred transaction that has read anything — including nothing — cannot upgrade to a write, and `busy_timeout` will not save it.** `busy_timeout` governs *acquiring* a lock, not resolving a *snapshot conflict*. Once a `BEGIN` (deferred) has taken a read snapshot, a later write while another connection holds the write lock is refused **immediately**; the timeout is never consulted. A `SELECT` that matches **zero rows** still establishes that snapshot, so "the row isn't there yet" does not exempt you. MEASURED under WAL on this schema: `read-then-write` → `SQLITE_BUSY` in **0 ms**; `write-first` → **5371 ms**. The practical consequence: any retry loop wrapped around a read-then-write has a *per-attempt cost that depends on statement order*, not on your timeout setting — so budget the whole operation, never the attempt. (This is why a ~25–30 s stall calculated from "6 attempts × 5 s busy wait" was sound arithmetic in the wrong place: the attempts could not incur the wait at all.)
5. **When you bound something, enumerate every clock that can consume the budget — then assert the TOTAL, not your own contribution to it.** A bound on the part you wrote is not a bound on the operation. (Learned the hard way, the same day as the two above: a bind retry was "bounded" at 6 attempts with ~115ms of JavaScript sleeps, and the comment said so. But the handle was opened with `busy_timeout = 5000`, so each failed attempt could sit in **SQLite's own** busy wait for a further 5s before the `catch` ever ran — a real ceiling near **25–30s** against a measured **10s** hook timeout, roughly 250x the documented figure. Two clocks, one budget, and only the one I had written was counted. The repair is a single DEADLINE computed at entry, with every wait — including the engine's — drawn from the remaining envelope, and loud fast exhaustion naming the elapsed time. Note the shape: the *attempt count* was bounded, the *sleep* was bounded, and the *operation* was not.)

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

**And the base is not only the commit graph — it is the state of every external oracle the gate consults.** `npm audit` (the `--audit-level=high` step) queries the npm advisory registry *at run time*, so its verdict tracks the state of the world, not the state of your code. A branch that was green yesterday reds today the moment a new advisory is published against an already-installed dependency — nothing of yours moved. Worse, `npm audit fix` cannot help when the vulnerable version is held by an `overrides` pin (an override defeats the auto-fix), so the only path is bumping the pinned version yourself. The tell is diagnostic and worth banking: **the same step failing *identically* across independent branches means the mover is outside the work.** Before you debug your own diff, check whether an unrelated open PR fails the same way — if it does, fix it once at the root and rebase the rest onto that base, never N times in parallel. (Learned the hard way: three unrelated onboarding PRs all red on `npm audit (high+)` the same morning; the cause was a fresh `fast-uri` advisory reaching us through `ajv`'s transitive dep, not any of the three diffs — #253 bumped the `overrides` pin `3.1.5 → 4.1.4` at the root and the other three went green on rebase.)

**And a corollary about partial greens: N-of-M checks green is not (M−N)/M of the evidence — because each check answers a question about a different surface.** When some checks pass and one fails, do not read it as "almost there." Ask what surface each green actually covers versus the red: a partial green can be 100% of the *narrow* answer and 0% of the *wide* one. (Learned the hard way: on #253's first push, three of four required checks were green — but those three audit the **root** dependency tree only, while the fourth, the 25-tool smoke, runs the full pre-publish gate over **root + the `extensions/vscode` parity audit**. The root fix cleared the three and the smoke caught a second vulnerable tree the root override could not reach. "3 of 4 green" was not 75% done — it was the complete answer to "is root clean?" and no answer at all to "is the extension clean?" **Reporting the honest "3/4, 4th still running" instead of rounding to green is what surfaced the second defect before a merge could bury it.**)

### 9. A required CI check that no longer runs blocks the branch forever

Branch protection matches required status checks by **name**. A required check that is renamed or removed **can never report**, so a PR that renames or removes a required job sits permanently `BLOCKED` — with every visible check green, which makes it a puzzle rather than an error. So: **when a required job changes name or is dropped, update the branch-protection required-contexts list in the same change.** Change the protection with the narrow `required_status_checks` endpoint, not the full-protection PUT (which replaces the whole object and can silently drop `enforce_admins`, force-push blocks, or `strict`); diff before/after to confirm nothing else moved. (Learned the hard way: the PR that removed the Node 20 CI job was blocked by a rule requiring `Test (Node 20)` to pass — a check that, by that same PR, no longer existed to run. A NON-required job renamed in the same PR did not bite, which is exactly why this is easy to miss until a required one does.)

**The stronger, general form: a required check must run on EVERY PR — a PATH-FILTERED job cannot be required.** Requiring a job that only runs on some paths (e.g. a `native-build` job filtered to dependency/workflow changes) deadlocks every PR it skips — a docs-only PR can never satisfy it — silently, with all visible checks green. A check that *stopped* running (renamed/removed) and a check that *never* runs on some paths are the same bug from two directions: both leave a required context that can never report. **The one test before adding any required context: does this job run on a docs-only change? If not, it cannot be required** — one command that would have prevented both of the incidents behind this law. And the corollary that makes it tempting to get wrong: **"more required checks" is not automatically stronger protection. A required check that cannot report is not protection — it is a lock with no key.**

### 10. Every gate check asks "is it broken?" — none asks "what does it say about us?"

The pre-publish gate ran six checks (tsc, build, vitest, npm audit, version-drift, smoke); a prior *secret* leak added `secret-register-guard.mjs` to catch tokens. Every one asks **is it broken / does it leak a credential** — a *correctness* and a *secret-value* category. None asked **what does the published artifact say about the people who made it**: internal personas, codenames, a maintainer's name and home path shipped in compiled `dist/*.js` for weeks (tsc keeps comments), invisible to every check because **the guard was built to the shape of the last incident** (tokens), and names were never in the category. This is the same failure as "your own fixtures are your threat model." So a content-hygiene guard is a first-class gate category — `scripts/shipped-content-guard.mjs`, wired into the pre-publish gate. Two rules make it work: **(a) it inspects the PACKED, EXTRACTED tarball, not the source tree** — a source scan reports clean while the artifact carries the strings (verify the deployment, not the working tree); and **(b) its scope is the tarball, NOT the repo** — internal names in a developer comment are fine (`removeComments` keeps them out of `dist`), because what lives in the repo for humans is a separate question from what ships into a stranger's `node_modules`. Overreaching into source makes the guard hated and bypassed.

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
