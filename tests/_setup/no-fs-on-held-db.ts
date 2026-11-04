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
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import * as header from "../../src/db-header.js";

const OPENERS = [
  "openSync", "readFileSync", "writeFileSync", "appendFileSync", "createReadStream", "createWriteStream",
  "copyFileSync", "cpSync", "truncateSync", "open", "readFile", "writeFile", "appendFile", "copyFile", "cp",
  "truncate", "watch", "watchFile", "openAsBlob",
] as const;
const PROMISE_OPENERS = ["open", "readFile", "writeFile", "appendFile", "copyFile", "truncate", "cp"] as const;

/** Every PATH operand of a call (a copy has two), decoded: a file URL through fileURLToPath (so %20 is a space). */
function pathOperands(args: unknown[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (typeof a === "string") out.push(a);
    else if (a instanceof URL && a.protocol === "file:") out.push(fileURLToPath(a));
    else if (Buffer.isBuffer(a)) out.push(a.toString());
  }
  return out;
}
/**
 * Is `p` a member of the family of a DB this process holds natively? By identity and by the names SQLite appends
 * (db-header.ts, whose registry lives on globalThis, so a vi.resetModules() copy of the module shares it).
 */
const heldFamily = (p: string): boolean => {
  try {
    return header.isInHeldNativeFamily(p);
  } catch {
    return false;
  }
};

const violations: string[] = [];
/** Only the OUTERMOST wrapped call is judged: node's readFileSync calls fs.openSync itself (one read, one record). */
let depth = 0;
const record = (name: string, hits: string[], stack: string | undefined) =>
  violations.push(`fs.${name}(${hits.join(", ")}) while this process holds a native handle on that DB:\n${stack?.split("\n").slice(2, 7).join("\n")}`);
const wrap = <T extends (...a: unknown[]) => unknown>(name: string, orig: T): T =>
  function (this: unknown, ...args: unknown[]) {
    const outer = depth === 0;
    let hits: string[] = [];
    let stack: string | undefined;
    if (outer) {
      depth++;
      try {
        hits = pathOperands(args).filter(heldFamily);
        if (hits.length > 0) stack = new Error().stack;
      } finally {
        depth--;
      }
    }
    depth++;
    let result: unknown;
    try {
      result = orig.apply(this, args);
    } finally {
      depth--;
    }
    // Recorded only once the open SUCCEEDED (a refused or failed open dropped no lock): a sync call that returned, a
    // promise that resolved.
    if (hits.length > 0) {
      if (result instanceof Promise) result.then(() => record(name, hits, stack), () => {});
      else record(name, hits, stack);
    }
    return result;
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
