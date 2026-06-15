// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.
//
// v2.10 — schema-gated task completion (safety). Hardened JSON Schema
// validation for task-completion gating. Per the v2.10 design rulings
// (victra Q1 + codex audit gate), ajv is used because a battle-tested
// standard validator is SAFER than a hand-rolled subset (a bug in our own
// validator = the gate fails OPEN), and real JSON Schema is portable.
//
// HARDENING (a registered schema is COMPILED by ajv — ajv code-generates a
// validator FROM the schema, so the schema document is an attack surface):
//   - strict mode ON           → ambiguous / unknown schema constructs rejected
//   - $data DISABLED (default) → no data-references
//   - no loadSchema configured → a remote $ref cannot be fetched (ajv throws
//                                on an unresolved ref) — no network / SSRF surface
//   - we ALSO reject any $ref / $dynamicRef / $recursiveRef / $data anywhere in
//     the document BEFORE compile (defense-in-depth; v1 schemas are self-contained)
//   - the document is meta-validated (ajv.validateSchema) BEFORE it is compiled
//   - compiled validators are cached once per schema id

import { Ajv, type ValidateFunction } from "ajv";

// allErrors: collect every violation for a clear rejection message.
// allowUnionTypes:false keeps schemas unambiguous under strict mode.
const ajv = new Ajv({ strict: true, allErrors: true, allowUnionTypes: false });

const compiledCache = new Map<string, ValidateFunction>();

const FORBIDDEN_KEYS = ["$ref", "$dynamicRef", "$recursiveRef", "$data"];

/** Recursively scan a parsed schema for forbidden (ref / $data) keywords. */
function scanForForbiddenKeys(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = scanForForbiddenKeys(item);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.includes(k)) return k;
      const hit = scanForForbiddenKeys((node as Record<string, unknown>)[k]);
      if (hit) return hit;
    }
  }
  return null;
}

function formatError(e: { instancePath?: string; schemaPath?: string; message?: string }): string {
  const path = e.instancePath || e.schemaPath || "";
  return `${path} ${e.message ?? "invalid"}`.trim();
}

export interface SchemaCheck {
  valid: boolean;
  errors: string[];
}

/**
 * Meta-validate a candidate schema document BEFORE it is ever compiled. Called
 * at registration time (register_task_schema). Three gates:
 *   1. it must be a plain JSON object,
 *   2. it must contain no $ref / $dynamicRef / $recursiveRef / $data,
 *   3. it must itself be a valid JSON Schema per ajv's meta-schema.
 * A document that fails here is NEVER passed to ajv.compile — the code-gen
 * surface is only reached by already-vetted documents.
 */
export function validateSchemaDocument(doc: unknown): SchemaCheck {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { valid: false, errors: ["schema must be a JSON object"] };
  }
  const forbidden = scanForForbiddenKeys(doc);
  if (forbidden) {
    return {
      valid: false,
      errors: [`forbidden schema keyword "${forbidden}" — refs and $data are not allowed`],
    };
  }
  let metaOk: boolean;
  try {
    metaOk = ajv.validateSchema(doc as object) as boolean;
  } catch (e) {
    return { valid: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
  if (!metaOk) {
    return { valid: false, errors: (ajv.errors ?? []).map(formatError) };
  }
  return { valid: true, errors: [] };
}

/** Compile-once-cache a vetted schema document, keyed by its stable id. */
function getValidator(id: string, doc: object): ValidateFunction {
  const cached = compiledCache.get(id);
  if (cached) return cached;
  const v = ajv.compile(doc);
  compiledCache.set(id, v);
  return v;
}

/**
 * Validate a parsed result object against a registered schema. The schema is
 * assumed already vetted by validateSchemaDocument at registration; we re-vet
 * defensively (cheap) so a tampered DB row can never reach ajv.compile unchecked.
 */
export function validateResult(id: string, doc: object, result: unknown): SchemaCheck {
  const docCheck = validateSchemaDocument(doc);
  if (!docCheck.valid) {
    return { valid: false, errors: [`stored schema "${id}" is invalid: ${docCheck.errors.join("; ")}`] };
  }
  let v: ValidateFunction;
  try {
    v = getValidator(id, doc);
  } catch (e) {
    return { valid: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
  const ok = v(result) as boolean;
  return ok ? { valid: true, errors: [] } : { valid: false, errors: (v.errors ?? []).map(formatError) };
}

/** Drop a single id (or all) from the compile cache. Test/teardown helper. */
export function clearSchemaCache(id?: string): void {
  if (id) compiledCache.delete(id);
  else compiledCache.clear();
}
