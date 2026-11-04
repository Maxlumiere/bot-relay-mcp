// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 slice 2b-i, the RUNTIME half of "a native process never fs-opens a DB-family file" (ruling e6e1b44e
 * Q3; the static half is tests/inv-db-01-fs-open-scan.test.ts). Suite-wide: every fs function that opens a descriptor
 * on a path is wrapped in the test process, and a test FAILS when, during it, the process opened a DB-family path
 * (the DB, -wal, -shm, -journal) while it held a native SQLite handle on that DB. Closing that descriptor would drop
 * the handle's POSIX locks. Test code is held to the same rule: a test that must read a held DB's bytes reads them
 * from another process.
 * Not covered (stated): child processes (each is its own process), and descriptors a native addon opens itself.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterEach } from "vitest";
import * as header from "../../src/db-header.js";

const OPENERS = [
  "openSync", "readFileSync", "writeFileSync", "appendFileSync", "createReadStream", "createWriteStream",
  "copyFileSync", "cpSync", "truncateSync", "open", "readFile", "writeFile", "appendFile", "copyFile", "truncate",
] as const;
const PROMISE_OPENERS = ["open", "readFile", "writeFile", "appendFile", "copyFile", "truncate", "cp"] as const;
const SIDECARS = ["-wal", "-shm", "-journal"];

/** How many native handles this process holds on the DB at `p` (the slice's counter; 2a's registry before it). */
const heldCount = (p: string): number => {
  const h = header as unknown as { nativeHandleCount?: (p: string) => number; nativeHoldCount?: (p: string) => number };
  return (h.nativeHandleCount ?? h.nativeHoldCount ?? (() => 0))(p);
};
/** Is `p` the DB, or a sidecar of a DB, that this process holds natively? (Over-inclusive by design: a test check.) */
function heldDbFamily(p: unknown): string | null {
  if (typeof p !== "string" && !(p instanceof URL) && !Buffer.isBuffer(p)) return null; // a descriptor: not a path open
  const s = p instanceof URL ? p.pathname : String(p);
  if (heldCount(s) > 0) return s;
  for (const side of SIDECARS) if (s.endsWith(side) && heldCount(s.slice(0, -side.length)) > 0) return s;
  return null;
}

const violations: string[] = [];
/** Only the OUTERMOST wrapped call is judged: node's readFileSync calls fs.openSync itself (one read, one record). */
let depth = 0;
const wrap = <T extends (...a: unknown[]) => unknown>(name: string, orig: T): T =>
  function (this: unknown, ...args: unknown[]) {
    if (depth === 0) {
      depth++;
      try {
        const hit = heldDbFamily(args[0]);
        if (hit) violations.push(`fs.${name}(${hit}) while this process holds a native handle on that DB:\n${new Error().stack?.split("\n").slice(2, 7).join("\n")}`);
      } finally {
        depth--;
      }
    }
    depth++;
    try {
      return orig.apply(this, args);
    } finally {
      depth--;
    }
  } as T;

const anyFs = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
for (const name of OPENERS) if (typeof anyFs[name] === "function") anyFs[name] = wrap(name, anyFs[name]);
const anyPromises = fs.promises as unknown as Record<string, (...a: unknown[]) => unknown>;
for (const name of PROMISE_OPENERS) if (typeof anyPromises[name] === "function") anyPromises[name] = wrap(`promises.${name}`, anyPromises[name]);
syncBuiltinESMExports();

afterEach(() => {
  if (violations.length === 0) return;
  const found = violations.splice(0);
  throw new Error(`INV-DB-01: ${found.length} fs open(s) of a DB-family file this process held natively:\n${found.join("\n\n")}`);
});

/** Test-only: the violations recorded so far (the spy's own rows read and clear them). */
export function _takeFsSpyViolations(): string[] {
  return violations.splice(0);
}
