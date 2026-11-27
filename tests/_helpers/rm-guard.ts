// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE rm GUARD's scanner (ruling bac8abd5), built on the type-checker scanner (fs-open-sites.ts + ts-binding.ts), never
 * on a regex: every reference to node's fs `rm` / `rmSync` (fs and fs/promises, through import aliases, namespaces,
 * destructuring and re-exports, as the checker resolves them).
 *   - A CALL whose options argument is an OBJECT LITERAL with `recursive: true` (the literal) removes a tree: out of scope.
 *   - Every other call (no options, `recursive` absent or false, or an options argument that is not a literal the
 *     guard can read) must carry `// rm: own regular file` as a comment ON its statement's line (trailing) or as the
 *     comment directly above that statement. One justification per call: two removal calls on one line are refused.
 *   - A VALUE use of rm / rmSync (an alias, a destructured property, a stored or passed function) is refused: its
 *     calls would be invisible here. So is fs named outside a static import (the scanner's own `rejected` sites).
 * NAMED LIMITS: code outside the scanned files, and a child process running `rm`.
 */
import ts from "typescript-legacy";
import { fsOpenSites } from "./fs-open-sites.js";

export const JUSTIFICATION = "// rm: own regular file";
export const RM_APIS = ["rm", "rmSync"] as const;

export interface RmSite {
  file: string;
  line: number;
  api: string;
  firstArg: string;
  justified: boolean;
}
export interface RmFinding {
  /** The scanner's site key (`<file>::<enclosing top-level function>::<api>`), for a NAMED allowance. */
  key: string;
  file: string;
  line: number;
  text: string;
  problem: string;
  /** The finding's node (a reviewed allowance reads what is done THROUGH it: rejectedUses). */
  node: ts.Node;
}

/** `true` / `false` when an object-literal options argument says so with a literal; "unreadable" otherwise. */
function recursiveOf(call: ts.CallExpression): boolean | "unreadable" {
  const opts = call.arguments[1];
  if (!opts) return false;
  if (!ts.isObjectLiteralExpression(opts)) return "unreadable";
  let value: boolean | "unreadable" = false;
  for (const p of opts.properties) {
    if (ts.isSpreadAssignment(p)) return "unreadable";
    // A COMPUTED key may name `recursive` (and override a literal one): the effective options cannot be read.
    if (p.name && ts.isComputedPropertyName(p.name)) return "unreadable";
    const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
    if (name !== "recursive") continue;
    if (!ts.isPropertyAssignment(p)) return "unreadable"; // shorthand `{ recursive }`, a method, an accessor
    const k = p.initializer.kind;
    value = k === ts.SyntaxKind.TrueKeyword ? true : k === ts.SyntaxKind.FalseKeyword ? false : "unreadable";
  }
  return value;
}

function statementOf(n: ts.Node): ts.Node {
  let cur: ts.Node = n;
  while (cur.parent && !ts.isSourceFile(cur.parent) && !ts.isBlock(cur.parent) && !ts.isCaseClause(cur.parent) && !ts.isDefaultClause(cur.parent) && !ts.isIfStatement(cur.parent) && !ts.isIterationStatement(cur.parent, false)) cur = cur.parent;
  return cur;
}

/** The comment on the statement's own line (trailing), or the comment directly above it (its last leading comment). */
function justified(sf: ts.SourceFile, call: ts.CallExpression): boolean {
  const stmt = statementOf(call);
  const text = sf.text;
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line;
  const callLine = lineOf(call.getStart(sf));
  // The trailing comment of the statement, or of any enclosing node that still ENDS on the call's line (a one-line
  // function body: `{ fs.rmSync(a); } // rm: own regular file`).
  for (let n: ts.Node | undefined = stmt; n && !ts.isSourceFile(n) && lineOf(n.getEnd()) === callLine; n = n.parent) {
    for (const c of ts.getTrailingCommentRanges(text, n.getEnd()) ?? []) {
      if (lineOf(c.pos) === callLine && text.slice(c.pos, c.end).startsWith(JUSTIFICATION)) return true;
    }
  }
  const leading = ts.getLeadingCommentRanges(text, stmt.getFullStart()) ?? [];
  const last = leading[leading.length - 1];
  return !!last && lineOf(last.pos) === lineOf(stmt.getStart(sf)) - 1 && text.slice(last.pos, last.end).startsWith(JUSTIFICATION);
}

export function rmScan(program: ts.Program, rel: (f: string) => string, inFile: (relPath: string) => boolean): { sites: RmSite[]; findings: RmFinding[] } {
  const sites: RmSite[] = [];
  const findings: RmFinding[] = [];
  const byFile = new Map(program.getSourceFiles().map((sf) => [rel(sf.fileName), sf]));
  const perLine = new Map<string, number>();
  for (const s of fsOpenSites(program, rel, inFile, RM_APIS)) {
    const file = s.key.split("::")[0]!;
    const sf = byFile.get(file)!;
    const line = sf.getLineAndCharacterOfPosition(s.node.getStart(sf)).line + 1;
    if (s.api === "rejected") {
      findings.push({ key: s.key, node: s.node, file, line, text: s.text, problem: `fs named outside a static import (${s.why}): its rm calls would be invisible` });
      continue;
    }
    if (s.api.endsWith("(reference)")) {
      findings.push({ key: s.key, node: s.node, file, line, text: s.text, problem: "a VALUE use of rm/rmSync (an alias, a destructured property, a stored or passed function) hides its calls: call it directly" });
      continue;
    }
    const call = s.node as ts.CallExpression;
    const lineKey = `${file}:${line}`;
    perLine.set(lineKey, (perLine.get(lineKey) ?? 0) + 1);
    if (perLine.get(lineKey) === 2) findings.push({ key: s.key, node: s.node, file, line, text: s.text, problem: "two removal calls on one line: one justification per call" });
    const rec = recursiveOf(call);
    if (rec === true) continue;
    const ok = justified(sf, call);
    sites.push({ file, line, api: s.api, firstArg: call.arguments[0]?.getText(sf) ?? "", justified: ok });
    if (!ok) {
      findings.push({
        key: s.key,
        node: s.node,
        file,
        line,
        text: s.text,
        problem:
          `a ${rec === "unreadable" ? "removal whose options the guard cannot read" : "non-recursive removal"} without "${JUSTIFICATION}". If the path may be a link ` +
          `(or a dangling one), use fs.unlinkSync: on Node v24.13.0 rmSync on a dangling symlink returns without error and leaves the link.`,
      });
    }
  }
  return { sites, findings };
}

/** One use of a value: `.member`, `.member()` when that member is called, or `(value)` for anything else. */
function useOf(n: ts.Node): string {
  let outer: ts.Node = n;
  while (ts.isParenthesizedExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isNonNullExpression(outer.parent)) outer = outer.parent;
  const p = outer.parent;
  if (ts.isPropertyAccessExpression(p) && p.expression === outer) return ts.isCallExpression(p.parent) && p.parent.expression === p ? `.${p.name.text}()` : `.${p.name.text}`;
  return "(value)";
}

/**
 * What is done THROUGH a rejected fs expression (e.g. `const anyFs = fs as any`): each use, in source order, as
 * `.member`, `.member()` or `(value)`. A rejected DECLARATION's uses are every reference to its name (resolved by the
 * checker); any other rejected expression is its own single use. A reviewed allowance pins this list, so a member
 * added through `any` (invisible to the type checker) fails.
 */
export function rejectedUses(program: ts.Program, node: ts.Node): string[] {
  if (!ts.isVariableDeclaration(node)) return [useOf(node)];
  if (!ts.isIdentifier(node.name)) return ["(value)"]; // a destructuring of the rejected value: refuse to read it
  const checker = program.getTypeChecker();
  const target = checker.getSymbolAtLocation(node.name);
  const sf = node.getSourceFile();
  const uses: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n !== node.name && target && checker.getSymbolAtLocation(n) === target) uses.push(useOf(n));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return uses;
}
