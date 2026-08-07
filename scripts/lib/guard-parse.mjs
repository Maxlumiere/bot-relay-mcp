// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PINNED-PARSER GATE for the AST drift guards (#47).
 *
 * ── WHY A PINNED PARSER, AND WHY A GATE ──────────────────────────────────────
 * The guards parse TypeScript with the classic compiler API (createSourceFile,
 * SyntaxKind, isXxx). TypeScript 7.0 ("Corsa") is a native rewrite that DROPS
 * that API, so a build bump to 7 would break every guard. Rather than rewrite
 * the guards (guard-ast.mjs is the repo's most hole-prone security code — a
 * must-CALL resolver where UNDER-detection ships a real auth hole), we PIN the
 * guards to a known classic-compiler TypeScript via an npm alias
 * (`typescript-legacy` → typescript@^6.x, a devDependency). The build's own
 * `typescript` is then free to bump to 7 — a normal bump, which was the goal.
 *
 * THE LENS (architect, #47): a guard must NEVER own a bespoke parser. A
 * hand-rolled parser enforces "what my parser understands," which diverges from
 * the real language by construction as TS evolves — silent under-detection built
 * into the foundation. The honest ladder is: NOW = a pinned REAL parser + this
 * loud-fail gate (the guards see exactly one TypeScript's language; anything
 * beyond it fails LOUD); on a revisit trigger = re-platform onto a maintained
 * parser whose full-time job is tracking the language. Owning the predicate is
 * the guard's job; owning the grammar is not.
 *
 * ── THE HAZARD THIS GATE CLOSES (measured 2026-08-07) ────────────────────────
 * `ts.createSourceFile` is ERROR-TOLERANT: on syntax it does not understand it
 * does NOT throw — it returns a PARTIAL tree with error nodes and populates
 * `sourceFile.parseDiagnostics`. Measured on the pinned parser: a file with
 * unsupported syntax yielded 4 parse diagnostics and 0 exceptions. A guard that
 * walked that partial tree could silently UNDER-detect — the construct it exists
 * to police may sit inside an error node it never visits — and report CLEAN on a
 * file it could not actually read. For a pinned parser that is the precise decay
 * mode: as the pin ages behind the build's TypeScript, source using newer syntax
 * parses partially and the guard goes quiet.
 *
 * So: any parse diagnostic on a SCANNED file is a hard failure. Silence-as-
 * failure is the enemy — a guard that cannot fully parse a file must SAY SO
 * (exit red), never pass. This is the CI/strict gate the pin's safety rests on;
 * without it the pin is silent debt, with it the debt self-announces.
 */
import ts from "typescript-legacy";

/** Thrown when the pinned parser cannot fully parse a scanned file. Distinct
 *  class so a guard's top-level handler can map it to a parse-error exit (2),
 *  and a fixture can assert it precisely. */
export class GuardParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "GuardParseError";
  }
}

/**
 * Parse a file the guard SCANS, failing LOUD on any parse diagnostic.
 *
 * Returns a SourceFile (parents set) only when the pinned parser parsed it
 * cleanly. Throws GuardParseError otherwise — the caller must let that reach a
 * non-zero exit, NEVER swallow it into a CLEAN result.
 *
 * @param {string} fileName  used in diagnostics + for one-hop import resolution
 * @param {string} source    the file text
 */
export function parseGuardSource(fileName, source) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diags = sf.parseDiagnostics ?? [];
  if (diags.length > 0) {
    const first = diags[0];
    const detail = ts.flattenDiagnosticMessageText(first.messageText, " ");
    throw new GuardParseError(
      `guard parse gate: "${fileName}" produced ${diags.length} parse diagnostic(s) from the pinned ` +
        `typescript-legacy parser (first: TS${first.code} at pos ${first.start} — ${detail}). ` +
        `A guard cannot certify a file it cannot fully parse, and this parser returns a PARTIAL tree ` +
        `rather than throwing — so refusing to report CLEAN is the only safe outcome. Most likely the ` +
        `source uses syntax newer than the pinned parser: bump the "typescript-legacy" alias (and ` +
        `re-verify the guards) or re-platform the guards onto a maintained parser. See scripts/lib/guard-parse.mjs.`,
    );
  }
  return sf;
}

/** Re-export the pinned compiler so guards import ts from ONE place and the pin
 *  cannot drift between files. */
export { ts };
