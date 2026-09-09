// bot-relay-mcp Kanban board (Vercel) — the page itself (GET).
// SPDX-License-Identifier: MIT
//
// Token-gated, read-only render of the last-good snapshot. This is Maxime's
// private board, so access requires ?token=<VIEW_TOKEN> (constant-time compared).
// The page ALWAYS renders the last good snapshot with its freshness banner —
// never an empty grid — so a broken pipe, a misconfig, and an idle fleet each
// look different (see lib/board-state.js).

import { timingSafeEqualStr } from "../lib/sign.js";
import { kvGet, kvConfigured, KEYS } from "../lib/kv.js";
import { renderBoard } from "../lib/render.js";

export default async function handler(req, res) {
  // The view token rides in the URL (zero-friction from a phone or another LLM),
  // so harden the realistic leak paths on EVERY response: no Referer on any link
  // clicked from the board, and keep this public Vercel URL out of search indexes.
  // (The write path — /api/ingest — is the security-critical one and is HMAC-gated.)
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  const expected = process.env.VIEW_TOKEN;
  if (!expected) {
    res.status(500).send("VIEW_TOKEN is not configured on this deployment.");
    return;
  }
  const token = (req.query && (req.query.token || req.query.t)) || req.headers["x-view-token"];
  if (!token || !timingSafeEqualStr(token, expected)) {
    res.setHeader("Cache-Control", "no-store");
    res.status(401).send("Unauthorized — append ?token=<VIEW_TOKEN>.");
    return;
  }

  if (!kvConfigured()) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(
      renderBoard({ latest: null, lastRejection: null, nowMs: Date.now() }),
    );
    return;
  }

  const [latest, lastRejection] = await Promise.all([
    kvGet(KEYS.latest),
    kvGet(KEYS.lastRejection),
  ]);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(renderBoard({ latest, lastRejection, nowMs: Date.now() }));
}
