// bot-relay-mcp Kanban board (Vercel) — tiny KV client (Upstash-compatible REST).
// SPDX-License-Identifier: MIT
//
// Vercel's KV / Upstash Redis integration injects KV_REST_API_URL +
// KV_REST_API_TOKEN. We store one JSON blob per key and read it back. No npm
// dependency — just global fetch (Node 20+ / Vercel runtime). Values are stored
// as JSON strings; Upstash returns them under { result }.

const BASE = process.env.KV_REST_API_URL;
const TOKEN = process.env.KV_REST_API_TOKEN;

export function kvConfigured() {
  return Boolean(BASE && TOKEN);
}

/** Read + JSON-parse a key. Returns null if unconfigured, absent, or unparseable. */
export async function kvGet(key) {
  if (!kvConfigured()) return null;
  const r = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) return null;
  const data = await r.json().catch(() => null);
  if (!data || data.result == null) return null;
  try {
    return JSON.parse(data.result);
  } catch {
    return null;
  }
}

/** JSON-stringify + write a key. Throws if KV is unconfigured or the write fails. */
export async function kvSet(key, value) {
  if (!kvConfigured()) throw new Error("KV not configured (KV_REST_API_URL / KV_REST_API_TOKEN)");
  const r = await fetch(`${BASE}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`KV set failed: HTTP ${r.status}`);
}

export const KEYS = {
  latest: "kanban:latest",
  lastRejection: "kanban:last_rejection",
};
