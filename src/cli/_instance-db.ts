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

/**
 * ADR-0048 PR B — open a RAW better-sqlite3 handle on the resolved DB (the verbs
 * that must not run the schema setup: bind, fleet) and apply the SAME post-open
 * re-check db.ts applies to its own handle (db.ts assertStillContained: the
 * containment + shared-root ownership rule). A file created or swapped between
 * resolution and open (for example by another user under /tmp) is refused
 * before the handle is used; nothing has been written through it yet (no pragma
 * or statement runs before the check), and it is closed.
 */
export async function openRawRelayDb(
  dbPath: string,
  opts: { readonly: boolean },
): Promise<import("../sqlite-compat.js").CompatDatabase> {
  const Better = (await import("better-sqlite3")).default;
  const db = new Better(dbPath, { readonly: opts.readonly, fileMustExist: true });
  try {
    const { assertStillContained } = await import("../db.js");
    assertStillContained(dbPath);
  } catch (err) {
    try {
      db.close();
    } catch {
      /* closing a refused handle is best-effort */
    }
    throw err;
  }
  return db as unknown as import("../sqlite-compat.js").CompatDatabase;
}
