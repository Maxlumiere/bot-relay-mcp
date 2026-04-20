# bot-relay-mcp — Evolution Roadmap (post-v2.1.0)

**Last refreshed:** 2026-04-20 (Phase 7r — replaces the pre-v2.1.0 roadmap shape).
**Authority:** this file is the current locked plan. Prior version numbers (v2/v3/v4/v5 as originally scoped) have been reorganized — what was "v2" through "v5" is now compressed into the completed v1.x → v2.0 → v2.1.0 arc. The forward plan below is what ships next.
**Full rationale:** `memory/project_federation_design.md` (Victra's memory store — architectural decisions + rejected alternatives).

---

## Where we are (v2.1.0, working-tree, awaiting Phase 8 publish)

25 MCP tools + 9-subcommand unified `relay` CLI. 671+ tests (16 opt-in under `--full`). HTTP transport with per-agent bcrypt tokens (v1.7), hardened dashboard + webhook surface (Phase 4d/4e/4n), AES-256-GCM at-rest encryption with versioned ciphertext + keyring rotation (Phase 4b.3), auth-state machine (Phase 4b.1 v2), managed-agent push-message rotation grace (Phase 4b.2), CLI subcommands for init/doctor/test/backup/restore/recover/re-encrypt/generate-hooks/pair.

The two-path deployment story is first-class as of Phase 7r:
- Single-machine (stdio, zero infra)
- Centralized (HTTP hub + `relay pair` + `relay doctor --remote`)

---

## v2.2 — Profiles + surface shaping + idle-wake core

**Target:** next build cycle after v2.1.0 publish + a pause for usage data.
**Focus:** operational ergonomics + closing the "wake an idle terminal" gap.

**Scope:**
- **Agent profiles** — persist per-agent defaults (role, capabilities, preferred channels, status) so `register_agent` on re-open doesn't require env replay. Addresses retro feedback about capability redeclaration.
- **MCP surface shaping** — split tools into logical groups (identity, messaging, tasks, channels, ops, admin) + MCP prompts/resources where they make the surface easier for clients to introspect. Sub-phase within v2.2.
- **Mailbox versioning** — implements the design-frozen `mailbox` + `agent_cursor` tables (Phase 7q). Adds `peek_inbox_version(agent_name)` MCP tool, `get_messages(since_seq=?)` filter, seq-at-delivery-time assignment.
- **Per-recipient monotonic seq** — Phase 4s idle-wake core. The marker-file fallback for non-MCP environments lands here too (LLM/CLI-agnostic per the design memo).
- **Per-instance local isolation** — if the same machine runs multiple relays (dev vs staging), per-instance namespaces avoid cross-talk.

**Explicit deferrals (NOT in v2.2):**
- Federation / cross-hub traffic (v2.3)
- End-to-end encryption where the hub is blind (v3+)
- Event sourcing log (v3)

---

## v2.3 — Hub federation (single codebase, edge + hub roles)

**Focus:** run the same bot-relay-mcp binary in two roles — edge (one per machine/team) + hub (single central coordinator) — with durable cross-edge queueing.

**Scope:**
- **Edge/hub roles in one codebase** — `RELAY_ROLE=edge|hub` startup flag. Edge runs its existing SQLite-backed relay locally. Hub runs the same binary but with federation routes enabled.
- **Per-edge auth** — each edge registers with the hub via `relay pair --as-edge`, receives a per-edge credential (separate from per-agent tokens). Hub verifies edge identity on every federation envelope (ed25519 signature, shape frozen in v2.1.0 `docs/federation-envelope-v1.md`).
- **Durable cross-edge queueing** — the hub persists envelopes to a routing table, fans out to subscribed edges. Edges pull via long-poll or push. Resumable via mailbox epoch (Phase 4s precedent).
- **Visibility controls** — `agents.visibility` column (design-frozen in Phase 7q) becomes load-bearing. Agents marked `'federated'` surface across the hub; `'local'` agents stay edge-only.
- **Federation envelope v1 becomes live** — paper spec in `docs/federation-envelope-v1.md` is the contract. First real implementer.

**Explicit deferrals (NOT in v2.3):**
- Multi-hub bridging — single hub only in v2.3 (v3 pilots cross-hub)
- End-to-end encryption beyond keyring at rest — hub still sees plaintext in RAM (v3+)
- CRDT merge semantics for federated channels — REJECTED (event sourcing chosen, see rationale in memory store)
- Full P2P mesh — deferred to v3 only if demand materializes

---

## v3 — Event substrate + replay + selective E2E

**Focus:** move the source of truth from SQLite rows to an append-only event log, enabling replay/backfill APIs + end-to-end encryption on the envelope body where appropriate.

**Scope:**
- **Event log extraction** — every mutation becomes an event (`agent_registered`, `message_sent`, `task_posted`, ...) written to an append-only table. SQLite rows become a materialized view over the log. This is the v2.3 hub federation's natural next step — cross-hub traffic becomes event replay.
- **Replay / backfill APIs** — consumers can subscribe from any event cursor. Useful for new edges catching up, audit investigations, reconstructing historical state, analytics pipelines.
- **Multi-hub bridge pilot** — two hubs federate through a bridge protocol (same envelope shape, escalated trust model). Pilot only — broad rollout gates on demand.
- **Direct-message E2E on event envelope** — `event_body` carries ciphertext when sender marks the envelope E2E. Hub routes without decrypting. Paper spec already reserves this in `docs/federation-envelope-v1.md` §3.1.

**Explicit deferrals (NOT in v3):**
- Mesh P2P (edges talking directly without any hub) — deferred unless demand shows up
- Federated channels with arbitrary concurrent merge — REJECTED (event sourcing gives eventual-consistency via per-channel ordering; arbitrary CRDT merge adds complexity without a concrete requirement)
- Slack / Discord / Matrix native integration — operator-choice pattern via MCP simultaneous connections; we do NOT build native bridges

---

## Architectural principles carried forward

These are not roadmap items — they are constraints every phase must respect:

1. **READ paths stay pure** (established in Phase 4b.2, reinforced through 4b.3). No side effects in authenticateAgent, decryptContent, or any read-only surface. Side effects live in WRITE paths or piggyback ticks.
2. **LLM/CLI-agnostic** — bot-relay-mcp never hardcodes Claude Code, Cursor, or any specific MCP client. The v2.1.0 Phase 4s idle-wake design is marker-file-fallback-first to preserve this.
3. **Foundation before features** — security fixes and invariant consolidation ship BEFORE new feature layers. Phase 7p + 7q were pulled into v2.1.0 specifically to avoid stacking v2.2 on a drifted base.
4. **Honest test count over padded target** — deferred tests get a DEFERRED-TESTING note in the regression file, not a pad-to-target inflation.
5. **One-approval audit cycle** — Victra audits and decides next-step autonomously within a locked roadmap. Cross-phase scope changes require explicit Maxime approval.

---

## Explicit deferrals (project-wide, NOT scheduled anywhere above)

- **CRDT as the sync substrate** — REJECTED. Event sourcing chosen per Codex review; CRDT adds complexity without a concrete requirement that event ordering + replay can't serve.
- **Full peer-to-peer mesh** — DEFERRED to v3+. Only if demand surfaces after v2.3 hub federation is production-proven.
- **Slack / Discord / Matrix native bridge** — DEFERRED and likely permanent. The operator-choice pattern (connect MCP client to both bot-relay-mcp AND the relevant bridge's MCP server simultaneously) covers the use case without lock-in. Documented in `docs/multi-machine-deployment.md` §3.
- **Federated channels with arbitrary concurrent merge** — REJECTED. Single-writer-per-channel with event ordering is enough for the use cases that surfaced in the v2.0 channels rollout.
- **Proof-of-work / sybil resistance for public registries** — OUT OF SCOPE. bot-relay-mcp is not a public registry; it's a private coordination relay. Public discovery is not a goal.
- **Browser-based user-facing UI beyond the diagnostic dashboard** — OUT OF SCOPE. Operators who want a UI can build one against `/api/snapshot` + future event-log endpoints.

---

## Dependency chain

```
v2.1.0 (done, working tree)
   └─ v2.2 (profiles + mailbox versioning + Phase 4s idle-wake + MCP surface shaping)
       └─ v2.3 (hub federation, edge/hub in one codebase, visibility field live)
           └─ v3 (event log + replay + selective E2E + multi-hub pilot)
```

Each version is shippable on its own — v2.2 does not require v2.3 to be useful, v2.3 does not require v3. But the mailbox schema frozen in v2.1.0 Phase 7q, the federation envelope v1 spec frozen in v2.1.0 Phase 7q, and the `agents.visibility` column frozen in v2.1.0 Phase 7q are the contracts every downstream phase honors.
