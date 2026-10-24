// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-24: the HTTP request body's STRUCTURAL BOUND.
 *
 * INVARIANT: no HTTP request body reaches any schema validator (the relay's or the MCP SDK's) with an array longer
 * than MAX_ARRAY or nesting deeper than MAX_DEPTH. It is enforced by one middleware mounted right after
 * express.json and BEFORE auth and every route, so it holds for unauthenticated callers too, and whatever
 * RELAY_HTTP_BODY_LIMIT is raised to.
 *
 * WHY: a schema validator does work, and allocates one issue, per element of an array it rejects. MEASURED (24 Oct,
 * one 1 MB body of 500,000 invalid elements, peak RSS of one process): 328 MB through the relay's own (v3-API)
 * schemas, 737 MB through the MCP SDK's validator before zod 4.6.6, 477 MB after it. The 4.6.6 fix
 * (GHSA-mrhx-c7xc-m3w5) stops early only for a v4 array that declares a length cap; the relay's schemas have none.
 * Bounding the STRUCTURE before any schema runs closes the class for every validator at once.
 *
 * The values were fixed BEFORE any measurement (24 Oct) and are not tuned to one. The largest legitimate array
 * any tool takes is 100 (resolve_messages' message_ids).
 *
 * The walk is ITERATIVE (an explicit stack) and stops at the first violation, so a deeply nested body can never
 * overflow the call stack. JSON.parse has already produced the value; the walk visits each element at most once.
 *
 * NOT covered (stated in SECURITY.md): stdio. The SDK's stdio ReadBuffer allows a 10 MB message, and its peer is
 * the local parent process, outside this boundary.
 */
import type { Request, Response, NextFunction } from "express";
import { ERROR_CODES } from "./error-codes.js";
import { log } from "./logger.js";

export const MAX_ARRAY = 1000;
export const MAX_DEPTH = 64;

/**
 * The first structural violation in `body`, or null. Depth counts containers: the body's own object or array is
 * depth 1, so MAX_DEPTH containers may nest and the next one is a violation.
 */
export function structuralViolation(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const stack: Array<[unknown, number]> = [[body, 1]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop()!;
    if (depth > MAX_DEPTH) return `nesting deeper than ${MAX_DEPTH} levels`;
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY) return `an array of ${value.length} elements (at most ${MAX_ARRAY})`;
      for (const v of value) if (v !== null && typeof v === "object") stack.push([v, depth + 1]);
    } else {
      for (const v of Object.values(value as Record<string, unknown>)) if (v !== null && typeof v === "object") stack.push([v, depth + 1]);
    }
  }
  return null;
}

/** The middleware: a named 400 before any route, auth or schema sees the body. */
export function structuralBoundMiddleware(req: Request, res: Response, next: NextFunction): void {
  const violation = structuralViolation(req.body);
  if (violation === null) return next();
  log.warn(`[http] SEC-24: rejected a ${req.method} ${req.path} body: ${violation}`);
  res.status(400).json({
    error: `Request body exceeds the structural bound (SEC-24): ${violation}. No array may exceed ${MAX_ARRAY} elements and nothing may nest deeper than ${MAX_DEPTH} levels.`,
    error_code: ERROR_CODES.BODY_STRUCTURE_LIMIT,
  });
}
