# Error codes (v2.1)

Every tool that returns `{ "success": false, "error": "..." }` also returns a stable `error_code` token. Clients branch on the code; the `error` string is free-form UX text we may rephrase between versions.

## Stability guarantee

- Codes here are **forever** within a major version.
- Adding a new code is a MINOR bump (old clients ignore it; new clients start branching on it).
- Removing or renaming a code is a MAJOR bump.

Source of truth: [`src/error-codes.ts`](../src/error-codes.ts).

## Catalog

| Code | Family | Meaning |
|---|---|---|
| `AUTH_FAILED` | Auth | Missing / invalid / mismatched `agent_token`. Includes HMAC signature failures. |
| `CAP_DENIED` | Auth | Caller is authenticated but lacks the capability required by the tool. |
| `NAME_COLLISION` | Auth | `spawn_agent` / `register_agent` refused because a row with that name already exists. |
| `NOT_FOUND` | Lookup | Task / message / channel / agent / webhook not found. |
| `ALREADY_EXISTS` | Lookup | Creating something that already exists (e.g. `create_channel` name clash). |
| `NOT_PARTY` | Authz | v2.1 Phase 4k — caller is not `from_agent` or `to_agent` on a task they're reading. |
| `NOT_MEMBER` | Authz | Caller is not a member of the channel they're posting to / reading. |
| `VALIDATION` | Validation | Zod / shape / format failure. |
| `PAYLOAD_TOO_LARGE` | Validation | Exceeds `RELAY_MAX_PAYLOAD_BYTES` (per-field) or outer 1MB HTTP body cap. |
| `CONCURRENT_UPDATE` | Concurrency | CAS write lost a race. Re-read and retry. |
| `INVALID_STATE` | State | State-transition violation (e.g., cancel a completed task). |
| `RATE_LIMITED` | Capacity | Rate-limit bucket exceeded. |
| `SSRF_REFUSED` | Network | v2.1 Phase 4e — webhook URL or DNS resolution in a blocked range. |
| `SCHEMA_MISMATCH` | Schema | `importRelayState` archive's `schema_version` mismatches the relay. |
| `DAEMON_RUNNING` | Operational | `importRelayState` refused while the relay daemon appears to be running. Pass `force: true` to override. |
| `INTERNAL` | Fallback | Unexpected failure. Rare; indicates a real bug. |

## Example response

```json
{
  "success": false,
  "error": "Agent \"alice\" is not a party to this task. Only from_agent or to_agent can read it.",
  "error_code": "NOT_PARTY",
  "auth_error": true
}
```

Backup / restore CLI errors use the same catalog via a `BackupError.code` property — operators can switch on it in shell scripts (`relay-restore ... || if [[ $? == ... ]]; then ...`).

## Client branching example

```js
const res = await rpc("get_task", { task_id, agent_token });
if (!res.success) {
  switch (res.error_code) {
    case "NOT_FOUND": return showTaskMissing();
    case "NOT_PARTY": return showAccessDenied();
    case "AUTH_FAILED": return reauth();
    default: return showGenericError(res.error);
  }
}
```

## What this is NOT

- Not an HTTP status mapping. MCP tool responses live in the `success: false` shape regardless of transport.
- Not i18n. The `error` string is English and free-form; translate on your side.
- Not exhaustive. Some internal exceptions surface as `INTERNAL` until we add a specific code — file an issue if you hit one that deserves its own category.
