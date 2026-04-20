# Federation Event Envelope v1

**Status:** FROZEN 2026-04-19 (paper specification only)
**Implemented in:** *not yet* — v2.1.0 reserves shape; v2.3 hub federation will be the first consumer; v3 P2P builds on the same envelope.
**Authority:** bot-relay-mcp CLAUDE.md (project memory) + this file. Any change to the envelope bumps `protocol_version` and gets a new doc.

---

## 1. Why this exists before any code implements it

bot-relay-mcp is today a single-node SQLite-backed MCP relay. The v2.3 roadmap introduces *hub federation* (an edge relay forwards cross-edge traffic through a hub), and v3 contemplates *peer-to-peer federation* without a central hub. Both need a stable wire shape.

If we start implementing federation without freezing the envelope first, every subsequent phase is a breaking migration. The v2.1.0 design-freeze (Phase 7q, Codex Prompt B) locks the shape now so downstream phases build on the same contract. The code that reads/writes this envelope does not exist yet — this document IS the contract.

Reserving shape in v2.1.0 also reserves three concrete surfaces in code:

- An empty `mailbox` + `agent_cursor` table pair (schema v5→v6, delivered by `migrateSchemaToV2_4`). Phase 4s (v2.2) will populate these with per-recipient `seq` counters; federation routes read the same cursors.
- An `agents.visibility` column (`'local' | 'federated'`, default `'local'`). Phase 7q adds the column; v2.3 will read it to decide which agents surface across the hub.
- This document.

---

## 2. Canonical envelope shape

Every cross-edge event carries exactly this set of fields. JSON encoding is the reference transport; binary codecs (msgpack, protobuf) are allowed as long as they round-trip 1:1.

| Field              | Type            | Required | Purpose                                                                                                |
| ------------------ | --------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `event_id`         | UUIDv7 string   | yes      | Globally unique + time-sortable. Replay protection on the receiver. MUST be v7 (time-prefix matters).  |
| `origin_edge`      | edge identity   | yes      | Sending edge. String (opaque to this layer; defined by the edge identity spec in v2.3).                |
| `target_edge`      | edge identity   | yes      | Recipient edge. Literal string `"hub"` when the envelope is routed through a hub without E2E metadata. |
| `sender_agent`     | agent name      | yes      | Scoped to `origin_edge`. Same namespace as local `agents.name`.                                        |
| `recipient_agent`  | agent name      | yes      | Scoped to `target_edge`. Receiver resolves to a local row.                                             |
| `event_type`       | enum            | yes      | See §3. Additive only; new types MUST NOT shadow old types.                                            |
| `event_body`       | object or bytes | yes      | Per-type payload. See §3 for per-type schemas.                                                         |
| `causal_refs`      | `event_id[]`    | no       | Prior event IDs this event depends on (delivery ordering; optional in v2.3 hub, useful in v3 P2P).     |
| `signature`        | hex/base64      | yes      | ed25519 signature over canonical envelope bytes (see §4) by `origin_edge`'s long-lived keypair.        |
| `created_at`       | ISO 8601 UTC    | yes      | Origin-edge wall clock. Receiver MAY use only for telemetry — `event_id`'s UUIDv7 timestamp is canonical for ordering. |
| `protocol_version` | string          | yes      | `"1"` for this envelope. New envelope shapes bump this. Receivers MUST reject unknown versions.        |

Any field not listed above MUST NOT appear. Receivers SHOULD reject envelopes with unknown keys (fail-closed on drift).

### 2.1 Canonical serialization

Signature is computed over the canonical form:

- JSON with keys sorted lexicographically, no whitespace, UTF-8.
- `signature` itself is excluded from the signed bytes (covers everything else).
- `event_body` is serialized at its own canonical form (same rules), then embedded as a string field in the top-level envelope before signing. This makes the signature stable across re-encoding.

Implementations MUST use a single-source-of-truth canonicalizer. Drift between encoder implementations = signature mismatch = rejection.

---

## 3. Event types

The enum is ADDITIVE. New types extend the list; no type is ever removed or repurposed. Receivers that see an unknown type MUST forward it in hub mode (pass-through) and MAY log-and-drop in edge mode.

### v1 types

| `event_type`        | Trigger on origin edge                                  | `event_body` shape                                                                                                                        |
| ------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `message_sent`      | `send_message` with a cross-edge recipient              | `{ content: string, priority: "normal"|"high", idempotency_key: string }`                                                                 |
| `broadcast_sent`    | `broadcast` with at least one cross-edge subscriber     | `{ content: string, priority: "normal"|"high", idempotency_key: string }` (recipient_agent = `"*"`)                                       |
| `task_posted`       | `post_task` / `post_task_auto` with cross-edge routing  | `{ task_id: string, title: string, description: string, priority: string, required_capabilities: string[] }`                              |
| `task_updated`      | `update_task` action applied to a cross-edge task row   | `{ task_id: string, action: "accept"|"heartbeat"|"complete"|"reject"|"cancel", result: string? }`                                         |
| `agent_registered`  | `register_agent` on a `visibility='federated'` row      | `{ role: string, capabilities: string[], session_id: string }`                                                                            |
| `agent_unregistered`| `unregister_agent` on a federated row                   | `{}`                                                                                                                                      |
| `channel_created`   | `create_channel` on a federated channel                 | `{ channel_id: string, name: string, description: string? }`                                                                              |
| `channel_message_posted` | `post_to_channel` on a federated channel           | `{ channel_id: string, content: string }`                                                                                                 |

Receivers MUST treat `idempotency_key` as globally unique — same key + same origin_edge = duplicate, drop silently.

### 3.1 Encryption-at-rest interaction

When the origin edge has encryption active (Phase 4b.3 keyring), `event_body` is the *plaintext* at the envelope layer — the receiver re-encrypts under its own keyring on landing. Hub nodes that route without decrypting (E2E mode) see only ciphertext in `event_body`; in that case the envelope layer carries ciphertext verbatim and the sender MUST indicate this via a reserved prefix on `event_body` strings (reserved for v3 E2E — v2.3 hub operates plaintext through the hub, encrypts at rest on each edge).

---

## 4. Signing and verification

Every edge holds an ed25519 keypair:

- Public key is published as part of the edge's identity record (format defined in v2.3).
- Private key lives in a keyring file with mode 0600 (same perm discipline as `relay.db`).
- The signature covers canonical envelope bytes (§2.1) excluding the `signature` field itself.
- Algorithm is ed25519 per RFC 8032; no alternatives in v1.

Receivers MUST reject on signature mismatch, expired origin key (rotation is outside v1 scope — whole-envelope rotation is a v3 item), or origin identity not in the trust set.

Hub mode: the hub MAY verify signatures for DoS protection (drop-on-invalid before fan-out) but the ultimate receiver re-verifies. A hub is not an authority.

---

## 5. Replay safety

- Receivers maintain a seen-set of `(origin_edge, event_id)` pairs with a rolling retention window (default 72h, configurable).
- An envelope whose `(origin_edge, event_id)` is already in the set is dropped silently — NOT an error condition.
- `idempotency_key` inside `event_body` is an application-layer dedup signal; the envelope-layer replay set is the first line of defense.

Timestamp-based replay windows are intentionally NOT part of v1 — edges with clock skew shouldn't be rejected outright. UUIDv7's embedded timestamp is informational for receivers, not a gate.

---

## 6. Hub routing (v2.3)

The hub treats the envelope as opaque payload + metadata. It:

- Verifies signatures (DoS protection).
- Records `(event_id, origin_edge, target_edge, created_at)` in its routing log with a short retention window (7d default).
- Fans out to the `target_edge`'s subscribed outbox.
- Does NOT decrypt `event_body` (E2E mode) or MAY decrypt for visibility routing (plaintext mode, opt-in).
- Does NOT originate envelopes — the hub's own identity is a distinct `origin_edge` for hub-originated events (hub health pings, cross-edge directory updates).

`target_edge = "hub"` is reserved for envelopes destined for the hub's own control plane (health, directory, rate-limit telemetry).

---

## 7. What v1 intentionally does NOT cover

- **Envelope-level rotation.** If an edge's ed25519 key is compromised, v1 requires whole-edge rekey (new identity). A rotation grace (dual-key accept window) is a v3 item.
- **Causal ordering guarantees.** `causal_refs` is a hint; receivers MAY process out-of-order. CRDT-style guarantees are explicitly deferred (CRDT-rejected per `memory/project_federation_design.md`).
- **Edge identity spec.** The string form of `origin_edge` / `target_edge` is defined in v2.3 federation kickoff. For v1, treat as opaque strings.
- **Per-event-type schemas beyond §3.** Future event types extend §3 without bumping `protocol_version`. A breaking change to an EXISTING type's body shape DOES bump the version.
- **Multiple signatures.** Exactly one `signature`, from `origin_edge`. Multi-sig envelopes (hub + origin double-attest) are a v3 item.
- **Compression.** Envelope-level compression is not specified. If needed, bolt on in transport-layer only (gzip on HTTP, etc.).

---

## 8. Versioning

`protocol_version` is a **string** (not a number) for forward-compatibility with semantic schemes. v1 uses `"1"`. A future additive-only change can introduce `"1.1"`; a breaking change is `"2"`. Receivers MUST match the major version exactly.

The paper doc version that corresponds to `protocol_version = "1"` is THIS file. A new file will supersede when `protocol_version` bumps.

---

## 9. Relationship to v2.1.0 code

v2.1.0 contains ZERO code that reads or writes this envelope. The three surfaces that exist in code are:

- `mailbox` + `agent_cursor` tables (Phase 7q, `migrateSchemaToV2_4`, empty).
- `agents.visibility` column (Phase 7q, default `'local'`, untouched by any code path).
- This file.

The first implementation target is v2.3 hub federation. Any implementer should read this file end-to-end BEFORE writing a byte of code — the frozen shape is the authority.
