// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Where code RESOLVES the relay's config path itself, instead of asking the one resolver (src/config.ts getConfigPath,
 * which delegates to src/instance.ts). Found with the pinned parser (typescript-legacy), never a regex. The predicate is
 * the NAME, not its syntactic position (Codex #343 R1: an enumerated list of "building" positions missed an assignment
 * RHS and literal / computed destructuring keys, and the next position would be missed the same way):
 *   - env-read: `x.RELAY_CONFIG_PATH` (unless it is the target of an assignment or `delete`: that SETS the override),
 *     a shorthand `{ RELAY_CONFIG_PATH }` binding, the key of a destructuring ASSIGNMENT (`({ RELAY_CONFIG_PATH: p } =
 *     src)`, its shorthand, nested, under a default, in an array pattern), and EVERY string literal whose text is
 *     exactly RELAY_CONFIG_PATH
 *     (element access, literal or computed binding keys, a constant later used as a key, a list of names), except the
 *     key of an element-access write;
 *   - file-name: EVERY string literal whose text is "config.json" (or ends in /config.json or \config.json), and every
 *     template whose text ends in one, wherever it appears (an argument, an initializer, an assignment, a property
 *     value, a default, an array element).
 * Each site is keyed "<file>::<enclosing top-level function>::<form>:<the site's PARENT expression text>", and the
 * scan reports how many times each key occurs: an allowlist names the exact expression and its count, never a whole
 * function. THE BOUNDARY (documented, not seen): a name built at run time ("config" + ".json"), the same expression text
 * whose identifiers are rebound to mean something else, and code outside src/.
 */
import ts from "typescript-legacy";
import { topLevelName } from "./ts-binding.js";

export interface ConfigPathSite {
  key: string;
  form: "env-read" | "file-name";
  line: number;
}

const ENV = "RELAY_CONFIG_PATH";
const isConfigFileName = (text: string) => text === "config.json" || text.endsWith("/config.json") || text.endsWith("\\config.json");
/**
 * The site's expression as the printer writes it (comments and formatting do not change a key): its PARENT (the call,
 * the property, the declaration it sits in), except an array element, which is keyed on itself (an array's other
 * elements are not part of the site).
 */
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const parentText = (n: ts.Node, sf: ts.SourceFile) =>
  printer.printNode(ts.EmitHint.Unspecified, ts.isArrayLiteralExpression(n.parent) ? n : n.parent, sf).replace(/\s+/g, " ").trim();

export function configPathSites(program: ts.Program, rel: (f: string) => string, inFile: (relPath: string) => boolean): ConfigPathSite[] {
  program.getTypeChecker(); // binding sets every node's `parent`, which the walk below reads
  const out: ConfigPathSite[] = [];
  for (const sf of program.getSourceFiles()) {
    const file = rel(sf.fileName);
    if (sf.isDeclarationFile || !inFile(file)) continue;
    const add = (n: ts.Node, form: ConfigPathSite["form"]) =>
      out.push({
        key: `${file}::${topLevelName(n)}::${form}:${parentText(n, sf)}`,
        form,
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
      });
    /** Is `n` the target of an assignment (`n = …`, `n ??= …`) or a `delete n`: setting the override, not reading it. */
    const isWrite = (n: ts.Node): boolean => {
      const p = n.parent;
      if (ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
      return ts.isDeleteExpression(p);
    };
    /**
     * Is this object literal a destructuring ASSIGNMENT target (`({ … } = src)`, also nested in another pattern, in an
     * array pattern, under a default, or a for-of / for-in target)? Its keys are then READ from the source object
     * (Codex #343 R2 #2), unlike an object literal that BUILDS a value (e.g. a child's env), whose keys set it.
     */
    const isAssignmentPattern = (lit: ts.Node): boolean => {
      let cur: ts.Node = lit;
      for (;;) {
        const p = cur.parent;
        if (!p) return false;
        if (ts.isParenthesizedExpression(p)) {
          cur = p;
          continue;
        }
        if (ts.isBinaryExpression(p) && p.left === cur && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          // the pattern's own `= default` inside an enclosing pattern, or the assignment itself
          const pp = p.parent;
          if (ts.isPropertyAssignment(pp) && pp.initializer === p) {
            cur = pp.parent;
            continue;
          }
          if (ts.isArrayLiteralExpression(pp)) {
            cur = pp;
            continue;
          }
          return true;
        }
        if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === cur) return true;
        if (ts.isPropertyAssignment(p) && p.initializer === cur) {
          cur = p.parent;
          continue;
        }
        if (ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) {
          cur = ts.isArrayLiteralExpression(p) ? p : p.parent;
          continue;
        }
        return false;
      }
    };
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === ENV && isAssignmentPattern(n.parent)) {
        add(n, "env-read"); // `({ RELAY_CONFIG_PATH: p } = src)`
      } else if (ts.isShorthandPropertyAssignment(n) && n.name.text === ENV && isAssignmentPattern(n.parent)) {
        add(n, "env-read"); // `({ RELAY_CONFIG_PATH } = src)`
      } else if (ts.isPropertyAccessExpression(n) && n.name.text === ENV) {
        if (!isWrite(n)) add(n, "env-read");
      } else if (ts.isBindingElement(n) && !n.propertyName && ts.isIdentifier(n.name) && n.name.text === ENV) {
        add(n, "env-read"); // `{ RELAY_CONFIG_PATH }`: a renamed or literal key is the string/identifier case
      } else if (ts.isBindingElement(n) && n.propertyName && ts.isIdentifier(n.propertyName) && n.propertyName.text === ENV) {
        add(n, "env-read");
      } else if (ts.isStringLiteralLike(n) && n.text === ENV) {
        const p = n.parent;
        if (!(ts.isElementAccessExpression(p) && p.argumentExpression === n && isWrite(p))) add(n, "env-read");
      } else if (ts.isStringLiteralLike(n) && isConfigFileName(n.text)) {
        add(n, "file-name");
      } else if (ts.isTemplateExpression(n) && n.templateSpans.some((s) => isConfigFileName(s.literal.text))) {
        add(n, "file-name");
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** How many times each site key occurs. */
export function siteCounts(sites: ConfigPathSite[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of sites) counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
  return counts;
}
