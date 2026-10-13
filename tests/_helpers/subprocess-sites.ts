// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-22's scanner: every call in a program that BINDS to node's child_process spawn family (resolved through import
 * aliases and namespaces by the pinned typescript-legacy checker, never matched by name), with how its program is
 * named: a `systemBinary(...)` call, `process.execPath`, or anything else (a bare name, a variable, an expression).
 */
import ts from "typescript-legacy";
import { resolveBinding, topLevelName } from "./ts-binding.js";

const SPAWN_FAMILY = /child_process\.d\.ts:(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)$/;

export interface SubprocessSite {
  /** "<file>::<enclosing top-level function>::<first argument's text>" */
  key: string;
  /** The API called (spawnSync, execFileSync, ...). */
  api: string;
  /** systemBinary | execPath | other */
  program: "systemBinary" | "execPath" | "other";
}

export function subprocessSites(program: ts.Program, rel: (f: string) => string, inFile: (relPath: string) => boolean): SubprocessSite[] {
  const checker = program.getTypeChecker();
  const out: SubprocessSite[] = [];
  for (const sf of program.getSourceFiles()) {
    const file = rel(sf.fileName);
    if (!inFile(file)) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name : ts.isIdentifier(n.expression) ? n.expression : null;
        const b = callee && ts.isIdentifier(callee) ? resolveBinding(checker, callee, rel) : null;
        const m = b ? SPAWN_FAMILY.exec(b.key) : null;
        if (m) {
          const first = n.arguments[0];
          let kind: SubprocessSite["program"] = "other";
          if (first && ts.isCallExpression(first) && ts.isIdentifier(first.expression)) {
            const fb = resolveBinding(checker, first.expression, rel);
            if (fb && /system-binary\.ts:systemBinary$/.test(fb.key)) kind = "systemBinary";
          } else if (first && ts.isPropertyAccessExpression(first) && first.getText(sf) === "process.execPath") kind = "execPath";
          out.push({ key: `${file}::${topLevelName(n)}::${first ? first.getText(sf) : "<none>"}`, api: m[1]!, program: kind });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}
