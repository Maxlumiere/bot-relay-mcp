// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0045 R5 — DRIFT GUARD: a read that windows the pending set must say what
 * its window hid.
 *
 * Every function in src/ that passes a `since` bound to a message read
 * (getMessages, getMessagesSummary, countMatchingMessages, or the window
 * primitive pendingSinceClause) must also call pendingWindowReport, which yields
 * total_pending (unwindowed) and hidden_by_since. Otherwise a new read path could
 * window the action queue silently again: the exact harm ADR-0045 removes.
 *
 * "Passes a since bound" = the since argument is present and is not the literal
 * `null`. Parsed with the PINNED parser (scripts/lib/guard-parse.mjs), per
 * function body.
 *
 * EXEMPT, by name, each for a stated reason:
 *   - pendingWindowReport: it IS the report (it counts with and without the window).
 *   - buildMessageWhere: the window PRIMITIVE the reads are built from; it
 *     returns a WHERE clause, never a result to a caller.
 *   - sampleGetMessagesConsistency: a comparator that mirrors the drain's window
 *     to detect dropped rows; it logs and returns nothing to a caller.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
// @ts-expect-error — .mjs helper without types
import { parseGuardSource, ts } from "../scripts/lib/guard-parse.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Windowed reads, and the index of their `since` argument. */
const WINDOWED_READS: Record<string, number> = {
  getMessages: 4,
  getMessagesSummary: 3,
  countMatchingMessages: 2,
  pendingSinceClause: 0,
};
const EXEMPT = new Set(["pendingWindowReport", "buildMessageWhere", "sampleGetMessagesConsistency"]);

function calleeName(call: any): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function functionName(fn: any): string {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return "<anonymous>";
}

/** Functions that window a message read without calling pendingWindowReport. */
export function violations(fileName: string, source: string): string[] {
  const sf = parseGuardSource(fileName, source);
  const out: string[] = [];
  const isFn = (n: any) =>
    ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

  const inspect = (fn: any): void => {
    const name = functionName(fn);
    let windowed: string | null = null;
    let reports = false;
    const walk = (n: any): void => {
      if (n !== fn && isFn(n)) return; // nested functions are inspected on their own
      if (ts.isCallExpression(n)) {
        const callee = calleeName(n);
        if (callee === "pendingWindowReport") reports = true;
        if (callee && callee in WINDOWED_READS) {
          const arg = n.arguments[WINDOWED_READS[callee]];
          if (arg && arg.kind !== ts.SyntaxKind.NullKeyword) windowed = windowed ?? callee;
        }
      }
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(fn, walk);
    if (windowed && !reports && !EXEMPT.has(name)) out.push(`${name} windows ${windowed} without pendingWindowReport`);
  };

  const visit = (n: any): void => {
    if (isFn(n)) inspect(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function srcFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return srcFiles(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

describe("ADR-0045 R5 — every windowed pending read reports hidden_by_since", () => {
  it("src/ has ZERO functions that window a message read without pendingWindowReport", () => {
    const found: string[] = [];
    for (const f of srcFiles(path.join(REPO, "src"))) {
      for (const v of violations(f, fs.readFileSync(f, "utf-8"))) found.push(`${path.relative(REPO, f)}: ${v}`);
    }
    expect(found).toEqual([]);
  });

  it("NON-VACUOUS: the scan sees both real windowed reads, and each calls pendingWindowReport", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "tools", "messaging.ts"), "utf-8");
    // With the report call stripped, both handlers must be flagged.
    const stripped = src.replace(/pendingWindowReport\(/g, "notTheReport(");
    const flagged = violations("messaging.ts", stripped).map((v) => v.split(" ")[0]).sort();
    expect(flagged).toEqual(["handleGetMessages", "handleGetMessagesSummary"]);
    expect(violations("messaging.ts", src)).toEqual([]);
  });

  it.each([
    ["getMessages with a since, no report", "export function h(i: any) { return getMessages(i.a, 'pending', 20, true, sinceIso); }"],
    ["getMessagesSummary with a since, no report", "export function h(i: any) { return getMessagesSummary(i.a, 'pending', 20, i.since); }"],
    ["a count with a since, no report", "export const h = (a: string, s: string) => countMatchingMessages(a, 'pending', s, 'all');"],
    ["the window primitive used directly", "export function h(s: string) { const w = pendingSinceClause(s); return w; }"],
    ["a method on an object", "const o = { read(a: string, s: string) { return db.getMessages(a, 'pending', 5, false, s); } };"],
  ])("FLAGS a form absent from the repo: %s", (_label, code) => {
    expect(violations("x.ts", code)).toHaveLength(1);
  });

  it.each([
    ["a windowed read WITH the report", "export function h(a: string, s: string) { pendingWindowReport(a, 'pending', s); return getMessages(a, 'pending', 20, true, s); }"],
    ["an explicitly unwindowed read (null)", "export function h(a: string) { return getMessages(a, 'pending', 20, true, null); }"],
    ["a read with the since argument omitted", "export function h(a: string) { return getMessages(a, 'pending', 20); }"],
    ["an exempt primitive", "function buildMessageWhere(a: string, s: string) { return pendingSinceClause(s); }"],
  ])("does NOT flag: %s", (label, code) => {
    expect(violations("x.ts", code), label).toEqual([]);
  });
});
