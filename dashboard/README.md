# Fleet board (external Vercel page)

A read-only Kanban board for the bot-relay-mcp fleet, hosted on Vercel. The relay
**pushes** a signed `kanban.v1` snapshot to this page every ~30s (outbound only —
**no inbound hole into the relay**). The page renders, per agent, its header
(name / terminal / CLI / coarse status) and a **pending-on-a-human** lane, plus a
note that per-task "doing" detail is not in v1.

It is **not** the relay's built-in `:3777` dashboard — that one needs you to reach
the daemon. This one lives outside and receives pushes, so you can watch the fleet
from anywhere without exposing the relay.

## How it behaves (by design)

- **Always shows the last good snapshot**, with its timestamp — never an empty grid.
- The banner distinguishes four states so they never look alike:
  - **ok** — a fresh snapshot (< 90s old).
  - **stale** — no snapshot recently, nothing rejected → the push pipe is down / relay idle.
  - **rejected** — the most recent push was rejected (bad/missing signature) → active misconfig. Loudest.
  - **waiting** — no valid snapshot has ever arrived → not wired yet.
- Every push **must** carry a valid HMAC (`X-Relay-Signature`). Unsigned / wrong-secret
  pushes are rejected **and shown** on the page. The relay refuses to push unsigned.

## Endpoints

- `POST /api/ingest` — the relay's `dashboard_push_url` target. Verifies the HMAC, stores the snapshot.
- `GET /` (→ `/api/board`) — the board. Requires `?token=<VIEW_TOKEN>`.

## Storage

One Vercel KV (Upstash Redis) store, two keys: `kanban:latest`, `kanban:last_rejection`.
The KV integration injects `KV_REST_API_URL` + `KV_REST_API_TOKEN` automatically.

---

## Deploy (Maxime — `npx vercel` is yours)

All commands run from this `dashboard/` directory. The three secrets are yours to
mint; generate them with the commands shown.

### 1. Mint the two secrets

```sh
# The shared push secret — must be IDENTICAL on the relay and here:
openssl rand -hex 32        # copy this value → used twice below (DASHBOARD_PUSH_SECRET + relay)
# The view token that gates the page:
openssl rand -hex 24        # copy this value → VIEW_TOKEN, and into your board URL
```

### 2. Link the project + add a KV store

```sh
cd dashboard
npx vercel link            # create/link a Vercel project for this directory
npx vercel integration add upstash    # or: add "KV" from the Vercel dashboard Storage tab, then link it to this project
```

Linking a KV/Upstash store to the project sets `KV_REST_API_URL` and
`KV_REST_API_TOKEN` in the project's environment automatically.

### 3. Set the two app secrets (each command prompts for the value you minted)

```sh
npx vercel env add DASHBOARD_PUSH_SECRET production   # paste the `openssl rand -hex 32` value
npx vercel env add VIEW_TOKEN production               # paste the `openssl rand -hex 24` value
```

### 4. Deploy

```sh
npx vercel --prod
```

Vercel prints the production URL (e.g. `https://fleet-board-xxxx.vercel.app`). That
URL is the board at `<url>/?token=<the VIEW_TOKEN you minted>`, and its ingest
endpoint is `<url>/api/ingest`.

### 5. Point the relay at it

On the relay host, set (env or `~/.bot-relay/config.json`):

```sh
export RELAY_DASHBOARD_PUSH_URL="<the production URL>/api/ingest"
export RELAY_DASHBOARD_PUSH_SECRET="<the same openssl rand -hex 32 value from step 1>"
```

Then restart the relay daemon. Within ~30s the board's banner flips from **waiting**
to **ok**. (If the relay has a URL set but no secret, it refuses to push — the board
stays **waiting** and the relay logs why.)

### Rotating the push secret

Set the new value on both sides (relay `RELAY_DASHBOARD_PUSH_SECRET` and the page's
`DASHBOARD_PUSH_SECRET`) and restart both. A mismatch shows up immediately as a
**rejected** banner on the board — not as silence.
