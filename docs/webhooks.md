# Webhooks — recipient-side guide (v2.1)

The relay POSTs a JSON body to your webhook URL on matching events. This doc covers the guarantees v2.1 provides and the dedupe/replay protections recipients SHOULD implement.

## Payload shape

```json
{
  "event": "message.sent",
  "timestamp": "2026-04-18T05:49:43.070Z",
  "delivery_id": "2b8c9d02-7f0e-4a31-bf5c-0123456789ab",
  "idempotency_key": "message.sent:alice:bob:msg-abc",
  "from_agent": "alice",
  "to_agent": "bob",
  "message_id": "msg-abc",
  "content": "..."
}
```

Plus event-specific fields (`task`, `channel_name`, `previous_agent`, etc.).

## Headers sent by the relay

| Header | Purpose |
|---|---|
| `Content-Type: application/json` | — |
| `User-Agent: bot-relay-mcp/<VERSION>` | version-tagged for ops debugging |
| `X-Relay-Event: <event>` | same as `event` in the body |
| `X-Relay-Webhook-Id: <id>` | your webhook subscription id |
| `X-Relay-Delivery-Id: <uuid>` | matches `delivery_id` in the body |
| `X-Relay-Retry: 1` | present on retried deliveries |
| `X-Relay-Signature: sha256=<hex>` | HMAC if you set a secret; signs the body |
| `Date: <RFC 7231>` | per-attempt timestamp |

## Replay protection (your side)

The relay supplies the primitives — you supply the enforcement.

### delivery_id

`delivery_id` is a UUIDv4 assigned at the initial fire. **It's stable across retries** because the payload body is stored verbatim and re-POSTed on each retry. That's the right semantic for correlation: same underlying event = same delivery_id = same HMAC.

**Recommended:** track delivery_ids you've already processed for ~24 hours (long enough to cover the retry ladder + your own downtime). Reject duplicates.

### idempotency_key

Stable per-underlying-event string. Format: `<event>:<from>:<to>:<resource_id>`, where `resource_id` is the most specific ID present in the payload (`message_id` → `task_id` → `channel_name` → `timestamp` fallback).

**Recommended:** dedupe on `idempotency_key` with a longer retention window (days/weeks) if your business logic must never double-process an event.

The difference: `delivery_id` is a per-fire UUID (protects against network-retry double-processing); `idempotency_key` is a per-event derived string (protects against multi-fire redelivery, e.g. if you re-register a webhook and replay historical events).

### Date header staleness

`Date` is set per-attempt, per-retry, in RFC 7231 format. Use it for staleness rejection:

```js
const sentAt = Date.parse(req.headers.date);
if (Math.abs(Date.now() - sentAt) > 5 * 60 * 1000) {
  return res.status(410).send("stale");
}
```

5 minutes is a reasonable default. Adjust based on your tolerance.

## Signature verification

If you set a `secret` at `register_webhook`, every body is signed:

```
X-Relay-Signature: sha256=<hex>
```

Verify:

```js
import crypto from "crypto";
const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-relay-signature"]))) {
  return res.status(401).send("bad sig");
}
```

The signature covers the **full body** — including `delivery_id`, `idempotency_key`, `timestamp`. If the body is valid per sig, those fields are trustworthy.

## DNS-rebinding defense (relay side)

The relay re-resolves your webhook hostname on every fire (initial + retry) and refuses delivery if ANY resolved IP is in a private / loopback / cloud-metadata range. This is v2.1 Phase 4e. Set `RELAY_ALLOW_PRIVATE_WEBHOOKS=1` to opt-in to private targets (useful for local n8n etc.).

## What NOT to log on the recipient side

- Raw HMAC signatures
- Full raw bodies for long-term storage (these may contain agent content)
- `idempotency_key` in logs shared outside your org — it encodes agent names + resource ids

## Related

- `src/webhooks.ts` — fire path, DNS re-check, delivery_id generation
- `src/url-safety.ts` — the SSRF / DNS-rebinding validator
- `tests/v2-1-webhook-hardening.test.ts` — 10 integration tests
- `devlog/040-v2.1-webhook-hardening.md` — design decisions
