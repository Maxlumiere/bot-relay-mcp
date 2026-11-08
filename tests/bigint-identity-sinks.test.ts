// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * BigInt identity is never a crash (as asked at #418 verify, after the doorbell twin threw): JSON.stringify of a value
 * holding a BigInt THROWS ("Do not know how to serialize a BigInt"). Every identity compare in src/ now reads BigInt
 * stats (tests/file-identity-bigint.test.ts), so:
 *  (a) STRUCTURAL (the TS checker): no JSON.stringify argument, and no logger argument (the logger stringifies every
 *      object it is given), in src/ has a type that reaches a bigint through its properties, unless it is stringified
 *      with bigintSafeReplacer. A positive control proves the scan sees such a sink.
 *  (b) RUNTIME: the logger, given a BigInt and a real doorbell lock result (whose handle carries the identity), does
 *      not throw and prints the EXACT digits.
 *  (c) The Windows chain-verdict cache key moves on a sub-millisecond change: BigInt stats' ctimeMs/mtimeMs are
 *      INTEGER milliseconds, so the key must use the nanosecond fields (the numeric Ms fields carried the fraction).
 */
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type TS = typeof import("typescript-legacy");
/** Every JSON.stringify / logger sink in the program's files (filtered) whose argument type reaches a bigint. */
function bigintSinks(ts: TS, program: import("typescript-legacy").Program, keep: (file: string) => string | null): { sinks: number; hits: string[] } {
  const ch = program.getTypeChecker();
  const hasBig = (t: import("typescript-legacy").Type, depth: number, seen: Set<import("typescript-legacy").Type>): boolean => {
    if (depth > 8) return false;
    if (t.flags & ts.TypeFlags.BigIntLike) return true;
    if (t.isUnionOrIntersection()) return t.types.some((x) => hasBig(x, depth + 1, seen));
    if (!(t.flags & ts.TypeFlags.Object) || seen.has(t)) return false;
    seen.add(t);
    if (ch.getSignaturesOfType(t, ts.SignatureKind.Call).length > 0) return false; // JSON skips functions
    if (t.getProperty("toJSON")) return false;
    if (ch.isArrayType(t) || ch.isTupleType(t)) return ch.getTypeArguments(t as import("typescript-legacy").TypeReference).some((x) => hasBig(x, depth + 1, seen));
    if (ch.getIndexInfosOfType(t).some((i) => hasBig(i.type, depth + 1, seen))) return true;
    return ch.getPropertiesOfType(t).some((p) => hasBig(ch.getTypeOfSymbol(p), depth + 1, seen));
  };
  let sinks = 0;
  const hits: string[] = [];
  for (const sf of program.getSourceFiles()) {
    const rel = keep(sf.fileName);
    if (rel === null || sf.isDeclarationFile) continue;
    const visit = (n: import("typescript-legacy").Node): void => {
      if (ts.isCallExpression(n)) {
        const e = n.expression;
        const isJson = e.getText(sf) === "JSON.stringify";
        const isLog = ts.isPropertyAccessExpression(e) && /^(log|logger)$/.test(e.expression.getText(sf)) && /^(debug|info|warn|error)$/.test(e.name.text);
        if (isJson || isLog) {
          sinks++;
          const safe = isJson && n.arguments[1] !== undefined && n.arguments[1].getText(sf) === "bigintSafeReplacer";
          const args = isJson ? n.arguments.slice(0, 1) : [...n.arguments];
          if (!safe && args.some((a) => hasBig(ch.getTypeAtLocation(a), 0, new Set()))) {
            hits.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${n.getText(sf).slice(0, 100).replace(/\s+/g, " ")}`);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { sinks, hits };
}

describe("BigInt identity is never a serialization crash", () => {
  it("(a) STRUCTURAL: no JSON.stringify / logger argument in src/ reaches a bigint (unless bigintSafeReplacer), with a positive control", async () => {
    const ts = (await import("typescript-legacy")).default;
    const { srcProgram, virtualProgram } = await import("./_helpers/ts-binding.js");
    // The control: the scan must SEE each unsafe form, and pass the safe ones.
    const fixture = virtualProgram({
      "fixture.ts": [
        "interface BigStat { dev: bigint; ino: bigint; isFile(): boolean }",
        "declare const st: BigStat;",
        "declare const log: { warn: (...a: unknown[]) => void };",
        "declare const bigintSafeReplacer: (k: string, v: unknown) => unknown;",
        "JSON.stringify(st);",
        "JSON.stringify({ handle: { path: 'p', dev: st.dev } });",
        "log.warn('held', { ino: st.ino });",
        "JSON.stringify([st]);",
        "JSON.stringify({ n: 1, s: 'x' });",
        "JSON.stringify(st, bigintSafeReplacer);",
        "log.warn('fine', { n: 1 });",
        "",
      ].join("\n"),
    });
    const ctl = bigintSinks(ts, fixture, (f) => (f.replace(/\\/g, "/").endsWith("/virtual/fixture.ts") ? "fixture.ts" : null));
    expect(ctl.sinks, "control: the scan saw the fixture's 7 sinks").toBe(7);
    expect(ctl.hits.map((h) => h.split(":")[1]), "control: exactly the 4 unsafe forms are hits").toEqual(["5", "6", "7", "8"]);
    const real = bigintSinks(ts, srcProgram(), (f) => {
      const rel = path.relative(REPO, f).split(path.sep).join("/");
      return rel.startsWith("src/") ? rel : null;
    });
    expect(real.sinks, "precondition: the scan saw src/'s sinks (more than 200 today)").toBeGreaterThan(200);
    expect(real.hits, "no sink in src/ can be handed a bigint").toEqual([]);
  }, 180_000);

  it("(b) RUNTIME: the logger prints a BigInt (exact digits) and a real doorbell lock result without throwing", async () => {
    const { log } = await import("../src/logger.js");
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
      lines.push(String(c));
      return true;
    });
    try {
      expect(() => log.error("identity", { ino: 2n ** 53n + 1n })).not.toThrow();
      expect(lines.join(""), "the exact digits, not a rounded number").toContain("9007199254740993");
      if (process.platform !== "win32") {
        // (skipped on Windows: the doorbell refuses every state dir there, as on main)
        const { acquireInstanceLock, releaseInstanceLock } = await import("../src/doorbell-lock.js");
        const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bigint-sink-"));
        fs.chmodSync(dir, 0o700);
        const r = acquireInstanceLock(dir, { pid: process.pid, proc_start: null, host_id: null });
        expect(r.ok, "precondition: the lock is acquired").toBe(true);
        try {
          expect(() => log.error("lock", r)).not.toThrow();
        } finally {
          if (r.ok) releaseInstanceLock(r.handle);
        }
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("(c) the Windows chain-verdict cache key moves on a sub-millisecond ctime or mtime change (the nanosecond fields)", async () => {
    const { chainCacheKey } = (await import("../src/mint-secret.js")) as {
      chainCacheKey: (p: string, st: { ino: bigint; ctimeNs: bigint; mtimeNs: bigint }) => string;
    };
    const base = { ino: 42n, ctimeNs: 1_700_000_000_000_000_100n, mtimeNs: 1_700_000_000_000_000_100n };
    const ctime = { ...base, ctimeNs: base.ctimeNs + 500n };
    const mtime = { ...base, mtimeNs: base.mtimeNs + 500n };
    expect(ctime.ctimeNs / 1_000_000n, "control: the integer ms collide").toBe(base.ctimeNs / 1_000_000n);
    expect(chainCacheKey("p", ctime), "a ctime change inside one ms moves the key").not.toBe(chainCacheKey("p", base));
    expect(chainCacheKey("p", mtime), "an mtime change inside one ms moves the key").not.toBe(chainCacheKey("p", base));
    expect(chainCacheKey("p", { ...base, ino: 2n ** 53n + 1n })).not.toBe(chainCacheKey("p", { ...base, ino: 2n ** 53n }));
    expect(chainCacheKey("p", base)).toBe(chainCacheKey("p", { ...base }));
  });
});
