// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Where code RESOLVES the relay's config path itself, instead of asking the one resolver (src/config.ts getConfigPath,
 * which delegates to src/instance.ts). Two forms, found with the pinned parser (typescript-legacy), never a regex:
 *   - a READ of RELAY_CONFIG_PATH: `x.RELAY_CONFIG_PATH`, `x["RELAY_CONFIG_PATH"]`, or a destructured
 *     `{ RELAY_CONFIG_PATH }` (an ASSIGNMENT to it, or `delete`, sets the override and is not a resolution);
 *   - the config FILE NAME used to build a path: a "config.json" literal (or one ending in /config.json or
 *     \config.json) as a call argument, a variable initializer, a `+` operand, or a template's text.
 * Each site is "<file>::<enclosing top-level function>::<form>". THE BOUNDARY (documented, not seen): a name built at
 * run time ("config" + ".json"), and code outside src/.
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

export function configPathSites(program: ts.Program, rel: (f: string) => string, inFile: (relPath: string) => boolean): ConfigPathSite[] {
  program.getTypeChecker(); // binding sets every node's `parent`, which the walk below reads
  const out: ConfigPathSite[] = [];
  for (const sf of program.getSourceFiles()) {
    const file = rel(sf.fileName);
    if (sf.isDeclarationFile || !inFile(file)) continue;
    const add = (n: ts.Node, form: ConfigPathSite["form"], what: string) =>
      out.push({ key: `${file}::${topLevelName(n)}::${form}:${what}`, form, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
    /** Is `n` the target of an assignment (`n = …`, `n ??= …`) or a `delete n`: setting the override, not reading it. */
    const isWrite = (n: ts.Node): boolean => {
      const p = n.parent;
      if (ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
      return ts.isDeleteExpression(p);
    };
    /** Is a string node used to BUILD a path or a value (not a message, a property value, a key)? */
    const builds = (n: ts.Node): boolean => {
      const p = n.parent;
      if (ts.isCallExpression(p) && p.arguments.includes(n as ts.Expression)) return true;
      if (ts.isNewExpression(p) && (p.arguments ?? ([] as readonly ts.Expression[])).includes(n as ts.Expression)) return true;
      if (ts.isVariableDeclaration(p) && p.initializer === n) return true;
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) return true;
      if (ts.isReturnStatement(p) || ts.isArrowFunction(p) || ts.isConditionalExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p)) return true;
      if (ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.BarBarToken || p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) return true;
      return false;
    };
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n) && n.name.text === ENV && !isWrite(n)) add(n, "env-read", ENV);
      else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === ENV && !isWrite(n)) add(n, "env-read", ENV);
      else if (ts.isBindingElement(n) && (n.propertyName ? ts.isIdentifier(n.propertyName) && n.propertyName.text === ENV : ts.isIdentifier(n.name) && n.name.text === ENV)) add(n, "env-read", ENV);
      else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && isConfigFileName(n.text) && builds(n)) add(n, "file-name", JSON.stringify(n.text));
      else if (ts.isTemplateExpression(n) && n.templateSpans.some((s) => isConfigFileName(s.literal.text))) add(n, "file-name", "`…/config.json`");
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}
