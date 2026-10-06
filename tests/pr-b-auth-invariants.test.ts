// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR-B invariants, enforced by construction (architect rulings e26359ac, 8c8ef8ea, 64131354):
 *   1. NO await between the FINAL authorization check and the identity/token write it authorizes:
 *      every handler in src/identity-mutators.ts has its declared shape, the dispatcher routes the
 *      tool to it, nothing awaits between the final auth-generation re-check and dispatch, and any
 *      handler in src/tools calling an identity mutator is registered.
 *   2. bcrypt never runs on the event loop: a COMPARE exists only in the worker pool; HASHING only at
 *      the 8 inventoried in-transaction sites, each a NAMED exception with its reason.
 * Source is read with comments stripped, so a comment can neither satisfy nor trip a check.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO, "src");
const { IDENTITY_MUTATING_TOOLS, IDENTITY_MUTATOR_FUNCTIONS } = await import("../src/identity-mutators.js");
const MODULES: Record<string, Record<string, unknown>> = {
  "tools/identity": await import("../src/tools/identity.js"),
  "tools/spawn": await import("../src/tools/spawn.js"),
};
const AsyncFunction = (async () => {}).constructor;

/** Source with comments removed (block and line comments; strings are left intact). */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}
function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(full));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}
/** Each top-level `function NAME(` and the code up to the next one: the calls a function makes. */
function functionsOf(text: string): Array<{ name: string; body: string }> {
  const re = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/gm;
  const starts = [...text.matchAll(re)].map((m) => ({ name: m[1], at: m.index! }));
  return starts.map((s, i) => ({ name: s.name, body: text.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : text.length) }));
}

describe("INVARIANT 1: no await between the final authorization check and the write it authorizes", () => {
  it("every registered identity/token-mutating handler has its declared shape (sync, or its write before its first await)", () => {
    for (const [tool, reg] of Object.entries(IDENTITY_MUTATING_TOOLS)) {
      const fn = MODULES[reg.module]?.[reg.handler] as ((...a: unknown[]) => unknown) | undefined;
      expect(typeof fn, `${tool}: ${reg.module}.${reg.handler} is not a function`).toBe("function");
      if (reg.shape === "sync") {
        expect(fn!.constructor === AsyncFunction, `${tool}: ${reg.handler} is ASYNC: an await could separate its final auth check from its write`).toBe(false);
      } else {
        const text = fn!.toString();
        // The identifier, not "name(": the test runner rewrites an imported call to `(0, mod.name)(`.
        const write = text.search(new RegExp(`\\b${reg.writeBeforeFirstAwait}\\b`));
        const firstAwait = text.search(/\bawait\b/);
        expect(write, `${tool}: ${reg.handler} no longer calls ${reg.writeBeforeFirstAwait}`).toBeGreaterThanOrEqual(0);
        expect(firstAwait === -1 || write < firstAwait, `${tool}: ${reg.handler} awaits BEFORE its authorized write`).toBe(true);
      }
    }
  });

  it("the dispatcher routes each registered tool to its registered handler", () => {
    const server = code(path.join(SRC, "server.ts"));
    for (const [tool, reg] of Object.entries(IDENTITY_MUTATING_TOOLS)) {
      expect(server, `dispatch does not route ${tool} to ${reg.handler}`).toMatch(new RegExp(`case "${tool}":\\s*return ${reg.handler}\\(`));
    }
  });

  it("nothing awaits between the final auth-generation re-check and dispatch", () => {
    const server = code(path.join(SRC, "server.ts"));
    const recheck = server.indexOf("getAuthGeneration() === genBefore");
    const dispatchAt = server.indexOf("const result = await dispatch(name, args)");
    expect(recheck, "the auth-generation re-check is gone").toBeGreaterThan(0);
    expect(dispatchAt, "the dispatch call moved").toBeGreaterThan(recheck);
    const between = server.slice(recheck, dispatchAt);
    expect(between.match(/\bawait\b/g) ?? [], "an await between the final auth check and the handler's write").toEqual([]);
  });

  it("every handler in src/tools that calls an identity/token mutator is REGISTERED (a new one cannot appear silently)", () => {
    const registered = new Set(Object.values(IDENTITY_MUTATING_TOOLS).map((r) => r.handler));
    const unregistered: string[] = [];
    for (const file of srcFiles(path.join(SRC, "tools"))) {
      for (const f of functionsOf(code(file))) {
        if (!f.name.startsWith("handle")) continue;
        const calls = IDENTITY_MUTATOR_FUNCTIONS.filter((m) => new RegExp(`\\b${m}\\(`).test(f.body.slice(f.body.indexOf("{"))));
        if (calls.length && !registered.has(f.name)) unregistered.push(`${path.relative(REPO, file)}: ${f.name} calls ${calls.join(", ")}`);
      }
    }
    expect(unregistered).toEqual([]);
  });
});

describe("INVARIANT 2: bcrypt never runs on the event loop", () => {
  it("a bcrypt COMPARE exists ONLY in the worker pool (src/bcrypt-pool.ts)", () => {
    const hits = srcFiles(SRC)
      .filter((f) => /\bcompareSync\b|\bbcrypt\s*\.\s*compare\b|\bverifyToken\b/.test(code(f)))
      .map((f) => path.relative(REPO, f));
    expect(hits).toEqual(["src/bcrypt-pool.ts"]);
  });

  /**
   * The ONLY hashing left on the loop: inside synchronous SQLite transactions, where an awaited worker
   * call is impossible (descope (A), architect 8c8ef8ea). Each is a NAMED exception. The end state (backlog):
   * hash in the pool before the transaction and retire every entry here.
   */
  const HASH_EXCEPTIONS: Record<string, { count: number; reason: string }> = {
    mintAgentToken: { count: 1, reason: "mints the token hash inside the operator mint transaction" },
    registerAgent: { count: 4, reason: "fresh token, a legacy row's first token, a new row's token, and its registration-recovery handle, all inside the register transaction" },
    rotateAgentToken: { count: 1, reason: "the rotated token's hash, inside the CAS rotate transaction" },
    rotateAgentTokenAdmin: { count: 1, reason: "the admin-rotated token's hash, inside the CAS rotate transaction" },
    revokeAgentToken: { count: 1, reason: "the recovery token's hash, inside the revoke transaction" },
  };

  it("bcrypt HASHING exists only in auth.ts hashToken, called ONLY at the 8 named in-transaction sites", () => {
    const hashSyncFiles = srcFiles(SRC).filter((f) => /\bhashSync\b|\bbcrypt\s*\.\s*hash\b/.test(code(f))).map((f) => path.relative(REPO, f));
    expect(hashSyncFiles).toEqual(["src/auth.ts"]);
    const callers = srcFiles(SRC)
      .filter((f) => !f.endsWith(path.join("src", "auth.ts")) && /\bhashToken\(/.test(code(f)))
      .map((f) => path.relative(REPO, f));
    expect(callers).toEqual(["src/db.ts"]);
    const counts: Record<string, number> = {};
    for (const f of functionsOf(code(path.join(SRC, "db.ts")))) {
      const n = (f.body.match(/\bhashToken\(/g) ?? []).length;
      if (n) counts[f.name] = n;
    }
    expect(counts).toEqual(Object.fromEntries(Object.entries(HASH_EXCEPTIONS).map(([k, v]) => [k, v.count])));
  });
});
