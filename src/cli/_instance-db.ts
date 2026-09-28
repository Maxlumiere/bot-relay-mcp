// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0048 PR B — how a CLI verb picks its relay DB: through the ONE strict
 * resolver (src/instance.ts resolveInstance), and never by guessing. On success
 * RELAY_DB_PATH is pinned to the resolved path, so the rest of the verb (and the
 * db.ts it loads) opens exactly that DB. On a resolver error the REASON is
 * returned for the verb to print and exit non-zero with: there is no fallback.
 * (Verbs used to swallow the error "to fall back to db.ts's default"; that
 * default no longer exists, because a fault must never select a different DB.)
 */
export async function pinResolvedDbPath(): Promise<string | null> {
  const { resolveInstance } = await import("../instance.js");
  const r = resolveInstance();
  if (r.kind === "error") return r.reason;
  process.env.RELAY_DB_PATH = r.dbPath;
  return null;
}
