// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 slice 3: whether the bash hooks may read the DB with the sqlite3 CLI (a native opener), decided by the
 * relay's ONE reader of the instance declaration and the DB header, and handed to the hooks as the 7th line of
 * `relay where --fields`. A wasm instance's DB has one opener, its owner, so the hooks never read it with sqlite3; with
 * a valid owner endpoint record they read its mail over HTTP from that owner (hook PR 1: the verdict "http", line 8).
 *
 * The closed token set (the hooks run sqlite3 ONLY on the exact token "sqlite3"; any other answer is a named skip):
 * - "sqlite3": the DB is native, legacy (application_id 0), absent or empty: today's sqlite3 path;
 * - "skip-declared-wasm": the instance declares sqlite_driver "wasm";
 * - "skip-rlyw": the DB is stamped for the wasm driver's single owner;
 * - "skip-unreadable": a declaration (the caller's, or the DB's own instance's) or the header could not be read or
 *   judged (fail closed);
 * - "skip-owner-locked": another process holds the DB's single-owner lock (a conversion, or an owner with no record);
 * - "skip-no-endpoint" (hook PR 2, Q5): a wasm DB whose owner lock IS held but with no valid owner endpoint record:
 *   the owner has no hook endpoint (its loopback listener could not open, an older relay, or a conversion holds it);
 * - "http" (hook PR 1): a wasm DB (declared, RLYW, or its owner lock held) whose owner endpoint record is VALID: the
 *   hooks read its mail over HTTP from that owner (line 8 of `relay where --fields` is "URL KEY").
 *
 * It opens NO SQLite connection: the header comes from db-header.ts readDriverHeader, an fs read here (this process
 * holds no native handle on the DB). Computed on every call (the answer is about now; nothing is cached).
 */
import { readDriverHeader } from "./db-header.js";
import { nativeOpenVerdict } from "./sqlite-compat.js";
import { validOwnerEndpoint } from "./owner-endpoint.js";
import { probeOwnerLock } from "./db-owner-lock.js";

export const HOOK_DB_VERDICTS = [
  "sqlite3",
  "skip-declared-wasm",
  "skip-rlyw",
  "skip-unreadable",
  "skip-owner-locked",
  "skip-no-endpoint",
  "http",
] as const;
export type HookDbVerdict = (typeof HOOK_DB_VERDICTS)[number];

/**
 * Hook PR 1: the verdict AND the owner endpoint ("URL KEY", or "" for every verdict but "http"), from one decision. A
 * wasm verdict (declared wasm, RLYW, or the owner lock held) with a VALID owner endpoint record becomes "http".
 */
export function hookDbAnswer(dbPath: string): { verdict: HookDbVerdict; endpoint: string } {
  const verdict = hookDbVerdict(dbPath);
  if (verdict === "skip-declared-wasm" || verdict === "skip-rlyw" || verdict === "skip-owner-locked") {
    try {
      const e = validOwnerEndpoint(dbPath);
      if (e) return { verdict: "http", endpoint: `${e.url} ${e.key}` };
      // Hook PR 2 (Q5): an owner IS running (the lock is held) yet no valid record names its endpoint: say so.
      if (probeOwnerLock(dbPath).state === "held") return { verdict: "skip-no-endpoint", endpoint: "" };
    } catch {
      /* no valid record: the wasm verdict stands */
    }
  }
  return { verdict, endpoint: "" };
}

export function hookDbVerdict(dbPath: string): HookDbVerdict {
  try {
    // The ONE native-open predicate (sqlite-compat.ts nativeOpenVerdict): the caller's declaration AND the DB's own
    // instance's; a wasm declaration skips, and an unreadable or invalid one skips too (fail closed, Codex #391 R1 P2-4).
    const v = nativeOpenVerdict(dbPath, "a hook's sqlite3 read");
    if (!v.ok) return v.kind === "declared-wasm" ? "skip-declared-wasm" : v.kind === "owner-locked" ? "skip-owner-locked" : "skip-unreadable";
    const h = readDriverHeader(dbPath);
    switch (h.kind) {
      case "wasm":
        return "skip-rlyw";
      case "absent":
      case "legacy":
      case "native":
        return "sqlite3";
      default:
        return "skip-unreadable"; // a foreign application_id, or not readable as a SQLite header
    }
  } catch {
    return "skip-unreadable";
  }
}
