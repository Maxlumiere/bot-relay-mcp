// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * TOOL inputSchema CONTRACT GUARD (external, client-visible).
 *
 * Every tool's `inputSchema` — the JSON Schema emitted by `tools/list` — is a
 * CONTRACT WITH EXTERNAL MCP CLIENTS. Clients build their argument forms and
 * client-side validation from it; a shape change (a property renamed/removed, a
 * `required` set narrowed/widened, an enum's members, `additionalProperties`,
 * `$ref`/`$defs` factoring) can silently break a client — and, until this guard,
 * NO test of ours failed when a schema-touching change went out. This was an
 * unguarded external surface (surfaced while scoping the zod 3→4 migration, whose
 * converter swap would rewrite exactly these documents).
 *
 * This pins the STRUCTURE of every tool's emitted schema against a committed
 * golden. Any structural diff fails LOUD. Do NOT reflexively re-bless the golden:
 * a diff here is a contract change that a client sees. If it is intentional,
 * regenerate deliberately (UPDATE_TOOL_SCHEMA_GOLDEN=1) and review the diff as a
 * client-facing change.
 *
 * KEY ORDER IS DELIBERATELY NOT ASSERTED. The comparison is structural
 * (Vitest `toEqual`), not byte/serialization-exact. JSON object key order is
 * semantically insignificant, so an order-sensitive comparison would manufacture
 * FALSE failures on a harmless reserialization — and an over-strict guard that
 * cries wolf is the guard that gets disabled, which protects nothing. Structural
 * equality is the correct strength: it catches every client-observable change —
 * a property added/removed/renamed, a type change, a narrowed/widened `required`
 * set, changed enum members, `additionalProperties`, `$ref`/`$defs` factoring —
 * without the order noise. (Order was considered and excluded on purpose.)
 *
 * The listing is taken CONFIGLESS (see tests/helpers/list-tools.ts): the helper
 * pins RELAY_CONFIG_PATH to a nonexistent temp file so this snapshots the full
 * default surface deterministically, never whatever operator config is ambient.
 *
 * Payoff: with this in place the parked zod 4 migration becomes a measurement —
 * swap the converter and the golden diff either is empty or names exactly which
 * of the tools' shapes moved.
 *
 * dist-dependent: the helper spawns dist/index.js, so `npm run build` runs first
 * (the pre-publish gate + CI build before tests).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { listTools, PROJECT_ROOT } from "./helpers/list-tools.js";

const GOLDEN = path.join(PROJECT_ROOT, "tests/fixtures/tool-inputschemas.golden.json");

/** name -> inputSchema, key-sorted for a stable, reviewable golden. */
function emittedSchemas(): Record<string, unknown> {
  const tools = listTools();
  const out: Record<string, unknown> = {};
  for (const name of tools.map((t) => t.name).sort()) {
    out[name] = tools.find((t) => t.name === name)!.inputSchema;
  }
  return out;
}

const RE_BLESS_HELP =
  "\n\n⚠ These inputSchemas are a CLIENT-VISIBLE MCP contract — external clients build their forms and " +
  "validation from them. A diff here means a client sees a different shape. Do NOT just re-bless the golden. " +
  "If the change is intentional, regenerate with `UPDATE_TOOL_SCHEMA_GOLDEN=1 npx vitest run " +
  "tests/v2-25-tool-inputschema-contract.test.ts` and review the golden diff as a client-facing contract change.";

describe("tool inputSchema contract — emitted schemas match the golden (external surface)", () => {
  const emitted = emittedSchemas();

  // Deliberate, visible update path — never automatic on mismatch.
  if (process.env.UPDATE_TOOL_SCHEMA_GOLDEN === "1") {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify(emitted, null, 2) + "\n");
  }

  it("the golden exists (regenerate with UPDATE_TOOL_SCHEMA_GOLDEN=1 to create it)", () => {
    expect(fs.existsSync(GOLDEN), `golden not found at ${GOLDEN}`).toBe(true);
  });

  const golden: Record<string, unknown> = fs.existsSync(GOLDEN)
    ? JSON.parse(fs.readFileSync(GOLDEN, "utf8"))
    : {};

  it("the SET of tools is unchanged (a tool added/removed is a contract change)", () => {
    expect(Object.keys(emitted).sort(), `tool set changed vs the golden.${RE_BLESS_HELP}`).toEqual(
      Object.keys(golden).sort(),
    );
  });

  // Structural equality (key order deliberately not asserted — see the header).
  it.each(Object.keys(golden))("tool '%s' inputSchema structurally matches the golden", (name) => {
    expect(emitted[name], `inputSchema for '${name}' changed vs the golden.${RE_BLESS_HELP}`).toEqual(golden[name]);
  });
});
