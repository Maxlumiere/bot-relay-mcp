// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 slice 3: whether the bash hooks may read the DB with the sqlite3 CLI (a native opener), decided by the
 * relay's ONE reader of the instance declaration and the DB header, and handed to the hooks as the 7th line of
 * `relay where --fields`. A wasm instance's DB has one opener, its owner, so the hooks deliver no mail there (they reach
 * the owner over HTTP in a later release).
 *
 * The closed token set (the hooks run sqlite3 ONLY on the exact token "sqlite3"; any other answer is a named skip):
 * - "sqlite3": the DB is native, legacy (application_id 0), absent or empty: today's sqlite3 path;
 * - "skip-declared-wasm": the instance declares sqlite_driver "wasm";
 * - "skip-rlyw": the DB is stamped for the wasm driver's single owner;
 * - "skip-unreadable": the declaration or the header could not be read or judged (fail closed).
 *
 * It opens NO SQLite connection: the header comes from db-header.ts readDriverHeader, an fs read here (this process
 * holds no native handle on the DB). Computed on every call (the answer is about now; nothing is cached).
 */
import { readInstanceSqliteDriver, instanceSqliteDriverProblem } from "./config.js";
import { readDriverHeader } from "./db-header.js";

export const HOOK_DB_VERDICTS = ["sqlite3", "skip-declared-wasm", "skip-rlyw", "skip-unreadable"] as const;
export type HookDbVerdict = (typeof HOOK_DB_VERDICTS)[number];

export function hookDbVerdict(dbPath: string): HookDbVerdict {
  try {
    const { value, configPath } = readInstanceSqliteDriver();
    // An unreadable config makes the relay itself fall back to the default (native, warned), so the header decides here
    // too; a READABLE value this release refuses is not something a hook can judge.
    if (instanceSqliteDriverProblem(value, configPath)) return "skip-unreadable";
    if (value === "wasm") return "skip-declared-wasm";
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
