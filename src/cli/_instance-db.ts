// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import type { ResolvedInstance } from "../instance.js";

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
  pinned = { dbPath: r.dbPath, resolution: r };
  return null;
}

/**
 * The resolution the pin was made from. The pin turns an INSTANCE resolution into an explicit one for the rest of
 * the verb, and the owner door is bound to the instance: a later door call (relay-client localTool) must present the
 * instance it resolved, not "" (the explicit kind). Returned only while RELAY_DB_PATH still names exactly the pinned
 * path; anything else (no pin, a changed or cleared RELAY_DB_PATH) → null, and the caller resolves afresh.
 */
let pinned: { dbPath: string; resolution: ResolvedInstance } | null = null;
export function pinnedResolution(): ResolvedInstance | null {
  return pinned !== null && process.env.RELAY_DB_PATH === pinned.dbPath ? pinned.resolution : null;
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
  // INV-DB-01 slices 2a + 3: a raw open is native, so a declared-wasm instance (its DB has one opener, the wasm owner)
  // and a header that refuses native (a wasm-owned or foreign file) are refused by name, before the open.
  const { openNativeDb, assertNativeByPathAllowed } = await import("../sqlite-compat.js");
  const header = assertNativeByPathAllowed(dbPath, "a raw native open (a relay CLI verb)");
  // The one native construction: held (no fs read of the file in this process) until a close that succeeds.
  const db = openNativeDb(dbPath, { readonly: opts.readonly, fileMustExist: true }, header);
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
