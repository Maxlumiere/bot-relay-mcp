# Managed Agent Protocol (Stable-forever spec)

**Version:** 1 (frozen)
**Introduced:** v2.1 Phase 4b.2

This document specifies the push-message format the relay uses to deliver out-of-band events to Managed Agents (agents registered with `managed: true`). The envelope is a **stable-forever contract**: breaking changes bump the `version` field; additive changes stay at `version: 1`.

Managed Agent reference implementations live at `examples/managed-agent-reference/python/agent.py` and `examples/managed-agent-reference/node/agent.js`.

---

## Transport

Protocol messages are delivered via normal relay `send_message` with `priority: "high"`. Managed Agents see them in their ordinary `get_messages` poll; no special endpoint or stream. Message `from_agent` is either the rotating agent itself (self-rotation) or the admin rotator's name (admin-rotation).

---

## Envelope format

Each protocol message is composed of:

1. A **human-readable summary line** — one line, starts with `[RELAY SECURITY]`. Operators reading messages by eye can understand at a glance.
2. A **fenced JSON block** — the machine-parseable payload. Managed Agent code extracts via:

```python
import re, json
m = re.search(r"```json\n(.*?)\n```", message_content, re.DOTALL)
if m:
    data = json.loads(m.group(1))
```

```javascript
const m = /```json\n([\s\S]*?)\n```/.exec(message.content);
const data = m ? JSON.parse(m[1]) : null;
```

Rationale for the fenced-block shape:
- Messages are stored as plain TEXT (`messages.content`) in SQLite. Newlines + backticks round-trip safely.
- Existing parsers (CLI dashboards, ops tooling) render the message readably regardless of whether they understand the protocol.
- Future non-JSON extensions (e.g. YAML blocks) can coexist without ambiguity.

---

## Events (`version: 1`)

### `token_rotated`

Fired when an agent's token is rotated (self-rotation via `rotate_token` OR admin-rotation via `rotate_token_admin`) AND the agent is `managed: true`. Unmanaged agents do NOT receive this event — the new token is returned directly to the caller's tool response instead.

**Schema:**

```json
{
  "protocol": "bot-relay-token-rotation",
  "version": 1,
  "event": "token_rotated",
  "agent_name": "<string>",
  "new_token": "<base64url>",
  "rotated_at": "<ISO8601>",
  "grace_expires_at": "<ISO8601>",
  "grace_seconds": <integer>,
  "rotator": "<rotator_name | 'self'>"
}
```

| Field | Type | Semantics |
|---|---|---|
| `protocol` | string | Always `"bot-relay-token-rotation"`. Grep-safe protocol identifier. |
| `version` | integer | Protocol version. `1` = this spec. Consumers MUST refuse unknown versions. |
| `event` | string | `"token_rotated"` for this envelope. Reserved for future event types. |
| `agent_name` | string | Target agent whose token was rotated. Matches the receiving agent's own name. |
| `new_token` | string | Freshly-minted replacement token (base64url, 32 bytes). The relay stores only a bcrypt hash — this is the ONLY copy. |
| `rotated_at` | string (ISO8601 UTC) | When the rotation write hit the DB. |
| `grace_expires_at` | string (ISO8601 UTC) | When the OLD token becomes invalid. Managed Agent should cut over BEFORE this. |
| `grace_seconds` | integer | Derived: seconds from `rotated_at` to `grace_expires_at`. Included for convenience. |
| `rotator` | string | `"self"` literal for self-rotation; the admin agent's name for admin-initiated rotation. Supports audit replay on the agent side. |

---

## Agent-side handling — `token_rotated`

Reference implementation pseudocode:

```
on incoming message:
    payload = extract_fenced_json(message.content)
    if payload is None or payload.protocol != "bot-relay-token-rotation":
        continue  # not a protocol message
    if payload.version != 1:
        log_warning("unknown protocol version; ignoring")
        continue
    if payload.event == "token_rotated":
        handle_token_rotation(payload)

def handle_token_rotation(payload):
    new_token = payload.new_token
    # === PERSIST BEFORE ACKING ===
    # Write to the SAME location the process reads on startup (config file,
    # env-var file, credential store). Fsync if the config path supports it.
    # Persist must succeed before the process returns from this handler.
    write_config_atomically(RELAY_AGENT_TOKEN=new_token)
    # Cut over the in-process client to the new token so the NEXT relay
    # call uses it. Old token remains valid until grace_expires_at; using
    # the new token immediately ensures the window is closed ASAP.
    relay_client.set_token(new_token)
    # Optional: log the rotator for audit replay.
    log("token rotated", rotator=payload.rotator, grace_expires_at=payload.grace_expires_at)
```

### Persist-before-ack (critical)

The reference implementations MUST persist the new token to the agent's config store BEFORE the message-processing loop returns. If the agent process crashes between reading `new_token` and persisting it, the agent wakes up on next restart with the OLD token — which may be past `grace_expires_at` — and fails auth on every call. Mirrors the recovery-flow pattern from Phase 4o.

The SMOKE.md checklist for each reference impl includes a simulated crash-between-receive-and-persist test.

---

## Security-at-rest

`new_token` in the payload is sensitive. The relay protects it at rest via the same AES-256-GCM pipeline used for all `messages.content` values (Phase 4p / Phase 4b.3). When any keyring source is configured — `RELAY_ENCRYPTION_KEYRING`, `RELAY_ENCRYPTION_KEYRING_PATH`, or the legacy single-key `RELAY_ENCRYPTION_KEY`:

- `new_token` is stored encrypted in the DB under the v2 versioned prefix `enc:<key_id>:<iv>:<payload>` (Phase 4b.3). Rows written before the Phase 4b.3 keyring rollout keep their legacy `enc1:<iv>:<payload>` prefix and decrypt via the keyring's `legacy_key_id` — both formats are readable forever.
- Only the target agent's authenticated `get_messages` call decrypts.
- Backup archives (tar.gz snapshots produced by `relay backup`) carry only ciphertext.
- `sqlite3` interactive sessions, WAL inspection, and raw SELECTs all show ciphertext.

When no keyring source is set, `new_token` lives plaintext in `messages.content` — consistent with every other column's encryption contract.

Operators in high-security environments SHOULD configure `RELAY_ENCRYPTION_KEYRING` (or `RELAY_ENCRYPTION_KEYRING_PATH` for file-sourced keyrings) before inviting Managed Agents to join the relay. See `docs/key-rotation.md` for the keyring shape and `relay re-encrypt` retirement flow.

---

## Best-effort delivery

Push-message delivery is **best-effort**. The rotation's DB-level CAS write is the source of truth — if `send_message` throws (e.g. DB write error, disk full), the rotation still succeeds. The caller's tool response will set `push_sent: false` and the operator should fall back to out-of-band delivery of the `new_token` (visible in the same tool response) or, if the token is lost entirely, use `relay recover <agent-name>` to clear the registration and allow fresh bootstrap.

Reference Managed Agents SHOULD treat a missed `token_rotated` event the same as any other delivery failure: poll `get_messages` on every tool call's post-auth hook, process every protocol message, and persist before acking. The relay's SessionStart / PostToolUse / Stop hooks deliver messages on every active moment of an agent's lifetime.

---

## Future events (reserved)

`version: 1` reserves the `event` field for future envelope types without breaking the protocol. Planned additions (non-breaking — stay at `version: 1`):

- `capability_added` / `capability_removed` — admin-initiated cap changes.
- `rotation_cancelled` — admin re-revokes an agent during its own grace window.
- `managed_transition` — agent type flipped (unmanaged → managed or vice versa).

Breaking changes (e.g. field renames, semantic reinterpretation) bump `version` to `2`. Consumers that see `version > 1` and don't recognize the number MUST log a warning and ignore the message.

---

## References

- `src/tools/identity.ts` — `handleRotateToken` + `handleRotateTokenAdmin` emit this envelope.
- `src/db.ts` — `rotateAgentToken` + `rotateAgentTokenAdmin` perform the DB mutation; the handler layer handles the message.
- `examples/managed-agent-reference/python/agent.py` — reference `handle_token_rotation` implementation.
- `examples/managed-agent-reference/node/agent.js` — Node equivalent.
- `docs/managed-agent-integration.md` — broader Managed Agent operator guide (links here for the protocol contract).
