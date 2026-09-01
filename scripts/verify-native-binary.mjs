#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Verify what actually SHIPS for our native dependency (#182 supply-chain posture).
 *
 * THE GUARANTEE MOVED. better-sqlite3 v13 ships bundled prebuilt binaries in its
 * tarball (`prebuilds/<platform>-<arch>.node`) and no longer compiles at install
 * (its install-time node-gyp is a stamp no-op). So we no longer build the native
 * addon ourselves — we accept a binary from the tarball. The old "compile from
 * source" gate can no longer see its target; retiring it would leave NOTHING
 * watching the artefact that actually runs. So this asserts the two properties
 * that now carry the real guarantee, and it is NAMED for exactly those:
 *
 *   1. INTEGRITY — better-sqlite3 is pinned in the lockfile to an EXACT version by
 *      an `integrity` hash resolved from the npm registry. Compiling from source
 *      was never really about the compile; it was about knowing what the binary
 *      CONTAINS. With v13 that knowledge rests entirely on this hash. (Static.)
 *   2. LOADS — the bundled prebuild for THIS platform resolves, loads, and answers
 *      a query. That is the path users actually run — including musl/Alpine/ARM
 *      users, who were previously the MOST exposed because they had to compile and
 *      now get a working bundled binary. (Runtime, platform-specific.)
 *
 * Fail CLOSED: any missing evidence is a failure, never a pass.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const DEP = "better-sqlite3";

/**
 * Pure + unit-testable. Given a parsed package-lock.json (v2/v3), assert `dep` is
 * pinned to an exact version by a registry-sourced integrity hash.
 */
export function checkLockfileIntegrity(lock, dep = DEP) {
  const entry = lock?.packages?.[`node_modules/${dep}`];
  if (!entry) {
    return { ok: false, reason: `no lockfile entry for node_modules/${dep} (lockfileVersion ${lock?.lockfileVersion ?? "?"})` };
  }
  const v = entry.version;
  if (typeof v !== "string" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v)) {
    return { ok: false, reason: `${dep} version ${JSON.stringify(v)} is not an exact pin` };
  }
  const integrity = entry.integrity;
  if (typeof integrity !== "string" || !/^sha(?:256|384|512)-.+/.test(integrity)) {
    return { ok: false, reason: `${dep}@${v} has no integrity hash — the tarball contents are not pinned` };
  }
  const resolved = entry.resolved;
  if (typeof resolved !== "string" || !/^https:\/\/registry\.npmjs\.org\//.test(resolved)) {
    return { ok: false, reason: `${dep}@${v} resolves from a non-registry source: ${JSON.stringify(resolved)}` };
  }
  return { ok: true, version: v, integrity };
}

/** Integration: the bundled prebuild for THIS platform resolves, loads, and queries. */
export function checkBundledPrebuildLoads(requireFn = createRequire(import.meta.url)) {
  try {
    const Database = requireFn(DEP);
    const db = new Database(":memory:");
    const row = db.prepare("select sqlite_version() as v, 1 as one").get();
    db.close();
    if (row?.one !== 1 || typeof row?.v !== "string") {
      return { ok: false, reason: `loaded ${DEP} but the query returned ${JSON.stringify(row)}` };
    }
    return { ok: true, sqlite: row.v };
  } catch (err) {
    return { ok: false, reason: `${DEP} failed to load/query: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function main() {
  let failed = false;
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf-8"));
  const integ = checkLockfileIntegrity(lock);
  if (integ.ok) {
    console.log(`  OK   integrity: ${DEP}@${integ.version} pinned by ${integ.integrity.slice(0, 16)}… from the npm registry`);
  } else {
    console.error(`::error::${DEP} lockfile integrity check FAILED — ${integ.reason}`);
    failed = true;
  }
  const load = checkBundledPrebuildLoads();
  if (load.ok) {
    console.log(`  OK   bundled prebuild loads + queries on ${process.platform}-${process.arch} (sqlite ${load.sqlite})`);
  } else {
    console.error(`::error::${DEP} bundled prebuild FAILED to load on this platform — ${load.reason}`);
    failed = true;
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
