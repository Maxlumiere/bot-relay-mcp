// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0048 PR D — the RELAY side of the shared resolver state table
 * (tests/fixtures/instance-resolution-table.json). Every applicable row goes
 * through resolveInstance({ env }); Tether runs the same rows through its vault
 * resolver (extensions/vscode/src/adr-0048-fixture.test.ts). Also: every row
 * carries an explicit platform AND containment stance, and the table states its
 * Windows stance, so no platform is a silent gap.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { loadResolutionTable, applyRow, expectedDb, rowApplies, outsideDir } from "./fixtures/instance-resolution-table.js";

const { resolveInstance } = await import("../src/resolve-instance.js");
const table = loadResolutionTable();
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adr0048d-fx-")));
const OUTSIDE = outsideDir("relay");
afterAll(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

describe("ADR-0048 PR D — the shared table: every row declares its stances (no silent platform gap)", () => {
  it("the table states its Windows stance", () => {
    expect(table.win32.trim().length).toBeGreaterThan(0);
  });
  for (const row of table.rows) {
    it(`stances declared: ${row.name}`, () => {
      expect(["posix", "all"], "platform stance").toContain(row.platform);
      expect(["strict", "n/a"], "containment stance").toContain(row.containment);
      expect(row.containment === "n/a", "containment is n/a exactly for error rows").toBe(row.expect.kind === "error");
    });
  }
});

describe("ADR-0048 PR D — the RELAY resolves every row as the table says", () => {
  table.rows.forEach((row, i) => {
    it.skipIf(!rowApplies(row))(row.name, () => {
      const home = path.join(BASE, `row-${i}`);
      fs.mkdirSync(home, { recursive: true });
      const env = applyRow(row, home, OUTSIDE);
      const r = resolveInstance({ env });
      if (row.expect.kind === "error") {
        expect(r.kind, JSON.stringify(r)).toBe("error");
        if (r.kind === "error") expect(r.reason).toContain(row.expect.reason);
      } else {
        expect(r, JSON.stringify(r)).toMatchObject({
          kind: row.expect.kind,
          dbPath: expectedDb(row, home),
          exists: row.expect.exists,
          containment: row.containment,
        });
      }
    });
  });
});
