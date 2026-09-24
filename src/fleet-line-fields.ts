// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0040 — the fields of a restart line Maxime will PASTE INTO A TERMINAL.
 *
 * Architect: every field is validated against a strict pattern and then
 * shell-quoted; on any failure the line is NOT emitted and the caller says why.
 * A folder name containing a quote or `;` would otherwise run when pasted.
 *
 *   conversation id — lowercase UUID
 *   name, role      — [a-z0-9-], 1-64. Stricter than AGENT_NAME_PATTERN on purpose:
 *                     that pattern admits `.` and `_`, which are harmless in the
 *                     relay but have no business in a pasted command. A registered
 *                     name outside this set gets no line, and the reason says so.
 *   folder          — absolute, no control characters, an existing directory whose
 *                     REALPATH is under an allowlisted root (default-deny: no roots,
 *                     no folders). Any other character is legal: it is quoted.
 *   model           — a member of the caller's known list
 *   sub-agent       — never a resume target (victra, 24 Sep); the reason names the parent.
 *
 * Validation reports EVERY failing field, not the first one.
 */
import fs from "fs";
import path from "path";
import { escapeSingleQuotesPosix } from "./spawn/validation.js";

export interface LineFieldsInput {
  conversationId: string;
  name?: string | null;
  role?: string | null;
  folder: string;
  model?: string | null;
  /** Set when this conversation is a sub-agent's; it is then not resumable. */
  parentThreadId?: string | null;
}

export interface LineFieldsPolicy {
  allowedRoots: readonly string[];
  knownModels: readonly string[];
}

export interface LineFields {
  conversationId: string;
  name: string | null;
  role: string | null;
  /** Canonical (realpath) folder. */
  folder: string;
  model: string | null;
}

export type LineFieldsResult = { ok: true; fields: LineFields } | { ok: false; reasons: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z0-9-]{1,64}$/;
// C0 controls, DEL. Tab included: a pasted tab is not a character anyone means.
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A value made safe to show in a refusal: control characters replaced, length capped. */
function shown(v: unknown): string {
  const s = typeof v === "string" ? v : String(v);
  const clean = s.replace(/[\u0000-\u001f\u007f]/g, "?");
  return JSON.stringify(clean.length > 80 ? clean.slice(0, 79) + "…" : clean);
}

function isUnder(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function checkFolder(folder: unknown, roots: readonly string[], reasons: string[]): string | null {
  if (typeof folder !== "string" || folder === "") {
    reasons.push("folder is missing");
    return null;
  }
  if (CONTROL.test(folder)) {
    reasons.push(`folder ${shown(folder)} contains a control character`);
    return null;
  }
  if (!path.isAbsolute(folder)) {
    reasons.push(`folder ${shown(folder)} is not an absolute path`);
    return null;
  }
  let real: string;
  try {
    real = fs.realpathSync(folder);
    if (!fs.statSync(real).isDirectory()) {
      reasons.push(`folder ${shown(folder)} is not a directory`);
      return null;
    }
  } catch {
    reasons.push(`folder ${shown(folder)} does not exist`);
    return null;
  }
  const realRoots = roots.flatMap((r) => {
    try {
      return [fs.realpathSync(r)];
    } catch {
      return [];
    }
  });
  if (!realRoots.some((r) => isUnder(real, r))) {
    reasons.push(`folder ${shown(real)} is not under an allowlisted root`);
    return null;
  }
  return real;
}

function checkName(label: "name" | "role", v: unknown, reasons: string[]): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !NAME.test(v)) {
    reasons.push(`${label} ${shown(v)} must match [a-z0-9-], 1-64 characters`);
    return null;
  }
  return v;
}

export function validateLineFields(input: LineFieldsInput, policy: LineFieldsPolicy): LineFieldsResult {
  const reasons: string[] = [];

  if (input.parentThreadId !== null && input.parentThreadId !== undefined) {
    const parent = typeof input.parentThreadId === "string" && UUID.test(input.parentThreadId) ? input.parentThreadId : null;
    reasons.push(
      parent
        ? `this is a sub-agent conversation and cannot be resumed; resume its parent ${parent}`
        : `this is a sub-agent conversation and cannot be resumed; its parent id ${shown(input.parentThreadId)} is not valid`,
    );
  }

  const conversationId =
    typeof input.conversationId === "string" && UUID.test(input.conversationId) ? input.conversationId : null;
  if (conversationId === null) reasons.push(`conversation id ${shown(input.conversationId)} is not a lowercase UUID`);

  const name = checkName("name", input.name, reasons);
  const role = checkName("role", input.role, reasons);
  const folder = checkFolder(input.folder, policy.allowedRoots, reasons);

  let model: string | null = null;
  if (input.model !== null && input.model !== undefined) {
    if (typeof input.model === "string" && policy.knownModels.includes(input.model)) model = input.model;
    else reasons.push(`model ${shown(input.model)} is not a known model`);
  }

  if (reasons.length > 0 || conversationId === null || folder === null) {
    return { ok: false, reasons };
  }
  return { ok: true, fields: { conversationId, name, role, folder, model } };
}

/**
 * POSIX single-quote a value for a pasted shell line. Refuses control characters
 * rather than quoting them: a newline inside quotes is still a line break in a
 * paste buffer, and some terminals act on escape sequences before the shell
 * ever sees them.
 */
export function shellQuote(value: string): string {
  if (CONTROL.test(value)) {
    throw new Error(`refusing to shell-quote a value containing a control character: ${shown(value)}`);
  }
  return `'${escapeSingleQuotesPosix(value)}'`;
}
