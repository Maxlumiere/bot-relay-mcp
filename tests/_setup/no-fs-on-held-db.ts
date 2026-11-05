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

/**
 * WHERE a descriptor is acquired, and which arguments are paths (never a payload):
 * - fd level: openSync (returns an fd), callback open (an fd in its callback), promises.open (resolves to a handle).
 *   Node's readFileSync / writeFileSync / appendFileSync / truncateSync and the streams open through these, so an
 *   operation that fails AFTER its open (a read through an append-only fd: EBADF) is still recorded;
 * - call level, for the APIs whose open bypasses the exported fs.open (natively implemented copies, callback
 *   readFile, the promise readers, watches, openAsBlob): recorded unless they failed with ENOENT (no fd acquired).
 */
const CALL_LEVEL: Record<string, number[]> = {
  copyFileSync: [0, 1], copyFile: [0, 1], cpSync: [0, 1], cp: [0, 1],
  readFile: [0], writeFile: [0], appendFile: [0], truncate: [0], watch: [0], watchFile: [0], openAsBlob: [0],
};
const PROMISE_CALL_LEVEL: Record<string, number[]> = { readFile: [0], writeFile: [0], appendFile: [0], truncate: [0], copyFile: [0, 1], cp: [0, 1] };

/** The PATH operand(s) at `positions`, decoded: a file URL through fileURLToPath (so %20 is a space). */
function pathOperands(args: unknown[], positions: number[]): string[] {
  const out: string[] = [];
  for (const i of positions) {
    const a = args[i];
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
const record = (name: string, hits: string[], stack: string | undefined) =>
  violations.push(`fs.${name}(${hits.join(", ")}) while this process holds a native handle on that DB:\n${stack?.split("\n").slice(2, 8).join("\n")}`);
const hitsOf = (args: unknown[], positions: number[]): string[] => pathOperands(args, positions).filter(heldFamily);
const noFd = (err: unknown) => (err as { code?: string } | null)?.code === "ENOENT";

const anyFs = fs as unknown as Record<string, (...a: unknown[]) => unknown>;
// fd level
{
  const orig = anyFs.openSync!;
  anyFs.openSync = function (this: unknown, ...args: unknown[]) {
    const hits = hitsOf(args, [0]);
    const fd = orig.apply(this, args);
    if (hits.length > 0) record("openSync", hits, new Error().stack); // an fd was acquired (it returned)
    return fd;
  };
}
{
  const orig = anyFs.open!;
  anyFs.open = function (this: unknown, ...args: unknown[]) {
    const hits = hitsOf(args, [0]);
    const cb = args[args.length - 1];
    if (hits.length > 0 && typeof cb === "function") {
      const stack = new Error().stack;
      args[args.length - 1] = function (this: unknown, err: unknown, ...rest: unknown[]) {
        if (!err) record("open", hits, stack); // only an fd that was acquired
        return (cb as (...a: unknown[]) => unknown).call(this, err, ...rest);
      };
    }
    return orig.apply(this, args);
  };
}
// call level
for (const [name, positions] of Object.entries(CALL_LEVEL)) {
  const orig = anyFs[name];
  if (typeof orig !== "function") continue;
  anyFs[name] = function (this: unknown, ...args: unknown[]) {
    const hits = hitsOf(args, positions);
    if (hits.length === 0) return orig.apply(this, args);
    const stack = new Error().stack;
    const cb = args[args.length - 1];
    if (typeof cb === "function" && !["watch", "watchFile"].includes(name)) {
      args[args.length - 1] = function (this: unknown, err: unknown, ...rest: unknown[]) {
        if (!noFd(err)) record(name, hits, stack);
        return (cb as (...a: unknown[]) => unknown).call(this, err, ...rest);
      };
      return orig.apply(this, args);
    }
    try {
      const r = orig.apply(this, args);
      if (r instanceof Promise) r.then(() => record(name, hits, stack), (e) => { if (!noFd(e)) record(name, hits, stack); });
      else record(name, hits, stack);
      return r;
    } catch (e) {
      if (!noFd(e)) record(name, hits, stack);
      throw e;
    }
  };
}
const anyPromises = fs.promises as unknown as Record<string, (...a: unknown[]) => unknown>;
{
  const orig = anyPromises.open!;
  anyPromises.open = function (this: unknown, ...args: unknown[]) {
    const hits = hitsOf(args, [0]);
    const stack = hits.length > 0 ? new Error().stack : undefined;
    const p = orig.apply(this, args) as Promise<unknown>;
    if (hits.length > 0) p.then(() => record("promises.open", hits, stack), () => {});
    return p;
  };
}
for (const [name, positions] of Object.entries(PROMISE_CALL_LEVEL)) {
  const orig = anyPromises[name];
  if (typeof orig !== "function") continue;
  anyPromises[name] = function (this: unknown, ...args: unknown[]) {
    const hits = hitsOf(args, positions);
    const p = orig.apply(this, args) as Promise<unknown>;
    if (hits.length > 0) {
      const stack = new Error().stack;
      p.then(() => record(`promises.${name}`, hits, stack), (e) => { if (!noFd(e)) record(`promises.${name}`, hits, stack); });
    }
    return p;
  };
}
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
