# Token lifecycle (v2.1)

Two new MCP tools ship in Phase 4b.1: `rotate_token` and `revoke_token`. Pre-v2.1 the only way to invalidate a leaked token was `unregister_agent` — full identity wipe + loss of message/task history. v2.1 splits that into two sharper primitives.

## `rotate_token` — self-service hygiene

An agent proves its current token, gets a fresh one back, and the old token is immediately invalid. No capability required — every authenticated agent can rotate its own token.

**Input:** `{ agent_name, agent_token }`
**Output:** `{ success: true, agent_name, new_token, rotated_at, auth_note }`
**Error codes:** `AUTH_FAILED` (wrong current token), `NOT_FOUND` (no such agent), `CONCURRENT_UPDATE` (another rotate / revoke raced), `INVALID_STATE` (legacy null-hash row — call `register_agent` to bootstrap instead), `INTERNAL`.

**When to use:**
- Routine key-rotation hygiene (monthly, quarterly, whatever your policy says).
- After a suspicious event — laptop handed off, accidental git commit, etc. — where you still trust the current token enough to present it once more.
- Before publishing a shell script that embeds the token: rotate, save the new one, burn the old.

History is preserved. Message + task rows, session continuity, capabilities — all untouched.

## `revoke_token` — admin emergency

A DIFFERENT agent, holding the new `admin` capability, nullifies the target's `token_hash`. The target falls into the legacy-null-hash state; a plain `register_agent` call re-bootstraps via the Phase 2b migration path.

**Input:** `{ target_agent_name, revoker_name, agent_token (revoker's) }`
**Output:** `{ success: true, revoked, revoked_by, revoked_at, hash_was_present, note }`
**Error codes:** `AUTH_FAILED`, `CAP_DENIED` (revoker lacks admin), `NOT_FOUND` (target doesn't exist).

**When to use:**
- Target's token is known-compromised AND the target can't be trusted to rotate.
- Incident response: contain now, investigate after.
- Shared-laptop handoff where you want the inheriting operator to start clean.

After a revoke, the target must call `register_agent` to get a fresh token. Capabilities are preserved (Phase 2b + v1.7.1 capability-immutability rule).

## The `admin` capability

`admin` is a new capability string introduced in v2.1 Phase 4b.1. It is NEVER auto-granted. Operators who want an admin agent must register it explicitly:

```bash
# stdio
RELAY_AGENT_NAME=incident-admin \
RELAY_AGENT_ROLE=security \
RELAY_AGENT_CAPABILITIES=admin \
claude
```

Or via HTTP:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "register_agent",
    "arguments": {
      "name": "incident-admin",
      "role": "security",
      "capabilities": ["admin"]
    }
  }
}
```

Per the v1.7.1 capability-immutability rule, `admin` (like every other cap) is set at FIRST register and preserved thereafter. To grant/remove admin on an existing agent, `unregister_agent` + re-register.

## Operator runbook: suspected token leak

1. **Can the agent still be trusted to present a current token once?**
   - Yes → tell the agent to call `rotate_token`. Save the new token, update env, done. Old token invalidated.
   - No (stolen laptop, hostile co-tenant, already rotated away from you) → continue.
2. **Do you have an admin-capable agent registered?**
   - Yes → call `revoke_token { target_agent_name: "<leaked>", revoker_name: "<your-admin>", agent_token: "<admin's>" }`. Target's hash is now null.
   - No → out-of-band sqlite: `UPDATE agents SET token_hash = NULL WHERE name = '<leaked>';`. Same effect, no admin gate. Use sparingly.
3. **Tell the target to re-bootstrap.** Plain `register_agent` against the nulled row triggers Phase 2b's migration path and issues a fresh token. Capabilities are preserved.

## Audit trail

Every successful `rotate_token` and `revoke_token` writes an `audit_log` row. For revokes, the `agent_name` column records the REVOKER, and the `params_summary` column records `target=<target_agent_name>`. Correlate those rows to build an incident timeline.

```sql
SELECT created_at, agent_name AS revoker, params_summary
FROM audit_log
WHERE tool = 'revoke_token' AND params_summary LIKE 'target=%'
ORDER BY created_at DESC LIMIT 20;
```

## Non-goals (v2.1)

- Scheduled auto-rotate. If you want it, wire cron against `rotate_token`.
- Inherited-children graceful replacement — if a parent rotates, spawned children with the old token in their shell env keep holding stale credentials. Phase 4b.2 will address.
- Encryption key rotation (`RELAY_ENCRYPTION_KEY`) — Phase 4b.3.

## Related

- `src/tools/identity.ts` — `handleRotateToken` / `handleRevokeToken`
- `src/db.ts` — `rotateAgentToken` (CAS) / `revokeAgentToken`
- `tests/v2-1-token-rotate-revoke.test.ts` — 8 integration tests
- `docs/error-codes.md` — stable error-code catalog
- `devlog/045-v2.1-token-rotate-revoke.md` — design decisions
