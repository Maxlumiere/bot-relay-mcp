# Protocol version (v2.1)

The relay exposes two version numbers:

- **Package version** (`version` field, from `src/version.ts`). Bumps on every ship: patches, docs, release hygiene. Noisy by design.
- **Protocol version** (`protocol_version` field, from `src/protocol.ts`). Bumps only when the *tool surface* or *wire semantics* change.

Clients should key compatibility checks on `protocol_version`, not `version`.

## Where to read it

- `register_agent` response — `body.protocol_version`. Natural negotiation point: the first thing a client does.
- `health_check` response — `body.protocol_version`. Auth-free; monitoring + smoke scripts can read it.

## SemVer interpretation

- **MAJOR** bump — breaking. Old clients cannot work (tool removed, required arg added, response shape narrowed). Clients should hard-fail.
- **MINOR** bump — additive. New tools, new optional arguments, new response fields. Old clients ignore the new stuff and keep working.
- **PATCH** bump — behavior fix that clients shouldn't key on. Rare.

## Recommended client snippet

```js
async function checkRelay() {
  const res = await fetch("http://127.0.0.1:3777/health").then((r) => r.json());
  const [major, minor] = res.protocol_version.split(".").map(Number);
  const MY_MAJOR = 2;
  const MY_MIN_MINOR = 0;
  if (major !== MY_MAJOR) throw new Error(`Relay protocol v${res.protocol_version} incompatible — need v${MY_MAJOR}.x`);
  if (minor < MY_MIN_MINOR) console.warn(`Relay protocol v${res.protocol_version} older than my min v${MY_MAJOR}.${MY_MIN_MINOR}`);
  return res;
}
```

## History

- `2.0.0` — v2.0 npm release baseline. 22 tools, session_id, channels, lease + heartbeat semantics.
- `2.1.0` — v2.1 sweep: Stop hook, legacy migration bypass, backup/restore, dashboard auth, webhook hardening (delivery_id + idempotency_key), spawn token passthrough, file perms, sid recapture, open-bind hardening, task authz, protocol version itself. All additive — no breaking changes.

## Update rule

Modify `PROTOCOL_VERSION` in `src/protocol.ts` only when a new release changes the tool surface. Bump MAJOR for breaking, MINOR for additive, PATCH rarely. The drift-grep guard (`scripts/pre-publish-check.sh`) allowlists `src/protocol.ts` + `src/version.ts` — these are the two authoritative version files.

## Non-goals

- The relay does NOT enforce client-side version checks. It reports; clients decide.
- There is NO `/protocols` endpoint enumerating supported versions.
- There is NO per-tool deprecation timestamp.

If your deployment needs richer negotiation, file a roadmap issue. Today's single field keeps the semantics simple.
