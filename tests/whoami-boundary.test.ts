// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * whoami — SECURITY BOUNDARY guard (onboarding, #182 follow-on).
 *
 * whoami closes 3 of the 6 "an agent must be told" facts (name, instance_id,
 * db_path). The other 3 — token, http_secret, dashboard_secret — MUST stay
 * un-askable: the token is bcrypt-hashed and unrecoverable by construction; the two
 * secrets are OPERATOR credentials whose disclosure to an agent is privilege
 * escalation. This file guards the BOUNDARY, not the intention: it fails if a
 * secret-bearing field becomes reachable from the whoami response — by a spread, a
 * refactor, or a helpful addition — at the TYPE level (unrepresentable) and at
 * runtime (never emitted).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { WhoamiResult } from "../src/types.js";

const TMP = path.join(os.tmpdir(), "whoami-boundary-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TMP, "relay.db");

const { registerAgent, closeDb, getDb } = await import("../src/db.js");
const { handleWhoami } = await import("../src/tools/status.js");
const { requestContext } = await import("../src/request-context.js");

// ── COMPILE-TIME GUARANTEE: the response TYPE cannot carry a secret ──────────────
// If WhoamiResult ever gains one of these keys, `Extract<...>` stops being `never`
// and this assignment fails to compile — "the type cannot hold it" is a guarantee,
// not a promise. This is the load-bearing half; the runtime checks below confirm
// the implementation matches the type.
type ForbiddenKey =
  | "token" | "agent_token" | "token_hash"
  | "http_secret" | "dashboard_secret" | "secret" | "password";
type WhoamiHasNoSecret =
  Extract<keyof WhoamiResult, ForbiddenKey> extends never ? true : { COMPILE_ERROR: "WhoamiResult must not carry a secret field" };
const _typeLevelGuard: WhoamiHasNoSecret = true;
void _typeLevelGuard;

// Init the DB ONCE — the per-test schema setup (migrations + seed + purge) is the
// slow part; agents get unique names so tests stay independent without a reset.
beforeAll(() => {
  if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  try { closeDb(); } catch { /* */ }
  getDb();
  // Register once (bcrypt hashing is the slow part) — unique names keep tests
  // independent without a per-test DB reset.
  registerAgent("probe", "builder", ["a", "b"]);
  registerAgent("self", "builder", []);
  registerAgent("other", "builder", []);
}, 30000); // 3× bcrypt in setup; the default 10s hook-timeout starves under full-suite CPU contention
afterAll(() => {
  try { closeDb(); } catch { /* */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

const ALLOWED = ["agent_name", "role", "capabilities", "instance_id", "db_path", "host_id"].sort();

function callWhoamiAs(name: string): Record<string, unknown> {
  const res = requestContext.run({ transport: "stdio", callerName: name }, () => handleWhoami());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return JSON.parse((res.content[0] as any).text);
}

describe("whoami — security boundary", () => {
  it("returns exactly the closed identity fields and NO secret-shaped key", () => {
    const body = callWhoamiAs("probe");
    expect(body.success).toBe(true);
    // exactly the allowed fields (+ success) — no extras that could carry a secret.
    expect(Object.keys(body).sort()).toEqual(["success", ...ALLOWED].sort());
    // and NOTHING that looks like a credential, defensively (catches token_hash etc.).
    for (const k of Object.keys(body)) {
      expect(k, `whoami leaked a secret-shaped field: ${k}`).not.toMatch(/token|secret|hash|password/i);
    }
    // the answer is about the caller, resolved server-side.
    expect(body.agent_name).toBe("probe");
    expect(body.role).toBe("builder");
    expect(body.capabilities).toEqual(["a", "b"]);
    expect(typeof body.db_path).toBe("string");
  });

  it("the caller is the token-resolved name — a whoami cannot be aimed at another agent", () => {
    const body = callWhoamiAs("self"); // both "self" and "other" exist (registered in beforeAll)
    expect(body.agent_name).toBe("self"); // never "other"; there is no target field to aim
  });

  it("AUTH_FAILED when no caller is resolved (no token)", () => {
    const res = requestContext.run({ transport: "stdio" }, () => handleWhoami());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = JSON.parse((res.content[0] as any).text);
    expect(body.success).toBe(false);
    expect(body.error_code).toBe("AUTH_FAILED");
  });
});
