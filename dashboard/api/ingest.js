// bot-relay-mcp Kanban board (Vercel) — snapshot ingest endpoint.
// SPDX-License-Identifier: MIT
//
// The relay POSTs a signed kanban.v1 snapshot here every ~30s. We verify the
// HMAC over the EXACT received bytes (bodyParser disabled so the signed bytes
// are not reserialized), then store the snapshot. Unsigned / bad-signature /
// unconfigured-secret pushes are REJECTED and recorded as a rejection marker so
// the board can SHOW the rejection — a silent 401 would make a misconfigured
// push indistinguishable from an idle fleet.

import { verifySignature } from "../lib/sign.js";
import { kvSet, KEYS } from "../lib/kv.js";

export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const MAX = 512 * 1024; // 512KB ceiling — a snapshot is tiny; refuse oversized bodies
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "POST only" });
    return;
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    res.status(413).json({ ok: false, error: String(err?.message || err) });
    return;
  }

  const secret = process.env.DASHBOARD_PUSH_SECRET;
  const sig = req.headers["x-relay-signature"];
  const verdict = verifySignature(raw, sig, secret);

  if (!verdict.ok) {
    // Record the rejection (best-effort) so the board surfaces it; do NOT store the snapshot.
    try {
      await kvSet(KEYS.lastRejection, { at: new Date().toISOString(), reason: verdict.reason });
    } catch {
      /* best-effort: a KV write failure here must not change the 401 we owe the caller */
    }
    res.status(401).json({ ok: false, error: verdict.reason });
    return;
  }

  let snap;
  try {
    snap = JSON.parse(raw.toString("utf8"));
  } catch {
    res.status(400).json({ ok: false, error: "signed body is not valid JSON" });
    return;
  }
  if (!snap || snap.schema !== "kanban.v1") {
    res.status(400).json({ ok: false, error: `unexpected schema: ${snap && snap.schema}` });
    return;
  }

  try {
    await kvSet(KEYS.latest, { snapshot: snap, received_at: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ ok: false, error: `store failed: ${String(err?.message || err)}` });
    return;
  }
  res.status(200).json({ ok: true });
}
