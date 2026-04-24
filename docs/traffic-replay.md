# Traffic replay (v2.4.0)

v2.4.0 introduces an env-gated **traffic recorder** and a **replay harness** for behavioral-parity validation between releases. Capture real MCP traffic against the current daemon, then replay it against a candidate build to catch regressions the unit tests didn't.

This is A.3 from the v2.3.0 brief, deferred at that time because A.1 (property-based tests) and A.2 (consistency probe) delivered the bulk of the bug-finding value. v2.4.0 picks it up now that we have a real deployment pattern to validate.

## Recording

Set the env var, restart the daemon:

```bash
RELAY_RECORD_TRAFFIC=/var/log/bot-relay-traffic.jsonl bot-relay-mcp --transport=http
```

Every tool call writes one line:

```jsonc
{
  "ts": "2026-04-23T10:00:00.000Z",
  "tool": "send_message",
  "args": { "from": "alice", "to": "bob", "content": "hi" },
  "response": { "success": true, "message_id": "<uuid>" },
  "transport": "stdio",
  "source_ip": null
}
```

### Redaction

Sensitive fields are redacted **at capture time** with the literal string `<REDACTED>`. The replay harness normalizes these same fields so a recorded `<REDACTED>` value and a replay-time fresh token are considered equal. Redacted field names:

- `agent_token`, `token`, `from_agent_token`, `X-From-Agent-Token`, `plaintext_token`
- `http_secret`, `password`, `secret`
- `recovery_token`

If you need to add more, edit `REDACT_KEYS` in `src/transport/traffic-recorder.ts`.

### Durability + safety

- Every line is `fsync`'d before the tool call returns. Cost is real — use only for short capture windows, not long-running production.
- Log file is append-only. Operator is responsible for rotation.
- **1 GB safety cap**: when the log exceeds 1 GB, the recorder logs a warning and silently disables further capture. Restart the daemon after rotating if you want to resume.
- Never throws. Recording failures are swallowed so capture never breaks a tool call.

## Replay

```bash
npx tsx scripts/replay-relay-traffic.ts /var/log/bot-relay-traffic.jsonl
```

Output:

```
Replay summary for /var/log/bot-relay-traffic.jsonl:
  total      1247
  identical  1247
  divergent  0
  errored    0
```

Exit code 0 on full parity; 1 on any divergence.

### Parity semantics

Non-deterministic fields are **normalized** before comparison:

| Field | Why normalized |
| --- | --- |
| `message_id`, `task_id`, `id`, `session_id`, `mailbox_id` | UUIDs differ by run |
| `seq`, `epoch`, `last_seq`, `total_messages_count`, `total_unread_count` | Mailbox state scales with prior recorded calls |
| `created_at`, `updated_at`, `last_seen`, `ts` | Wall-clock timestamps |
| `agent_token`, `plaintext_token`, `csrf_token`, `delivery_id`, `idempotency_key` | Random per run |

Inline UUIDs and ISO timestamps embedded in prose error messages (e.g. the `note:` field) are also replaced with `<uuid>` / `<iso>` sentinels.

Stable fields that the harness DOES compare strictly:

- `success: boolean`
- `error_code` (stable per v2.1 Phase 4g catalog)
- `agent_status`, `priority`, `status`
- Structural shape (presence/absence of fields)
- Business-logic counts (e.g. `agents.length`, `messages.length`)
- Error message text (after UUID/ISO normalization)

## Use as a pre-publish gate

Opt-in — NOT default. Capture a real hour against a known-good build, drop the log in the repo under `.replay-snapshots/baseline-<version>.jsonl`, and pass `--with-replay` to the gate:

```bash
scripts/pre-publish-check.sh --full --with-replay .replay-snapshots/baseline-v2.3.0.jsonl
```

If the replay shows divergence, the gate fails and printed diffs show which tool calls drifted.

## When to use

- **Before a MINOR or MAJOR release**. Record an hour of real operator traffic against the current stable daemon; replay against the candidate build to check behavioral parity.
- **After a dependency bump** that you suspect might change semantics. Traffic replay catches silent behavior shifts the unit tests missed.
- **After a schema migration**. Confirm that post-migration responses match pre-migration responses for the same inputs.

## When NOT to use

- **As a primary test strategy.** Traffic replay validates PARITY between two versions — it doesn't tell you whether the behavior is correct in the first place. Unit tests + property tests (v2.3.0 A.1) own correctness; replay owns regression.
- **For capturing production secrets.** Redaction covers the known-sensitive field names but review the redaction list before pointing it at production traffic. If in doubt, capture against a staging deployment.
- **For long-running capture.** The `fsync`-per-line durability cost is significant. Capture windows of minutes or hours, not days.
