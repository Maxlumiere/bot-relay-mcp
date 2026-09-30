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
import { loadResolutionTable, applyRow, expectedDb, rowApplies, outsideDir, simulatedWalk } from "./fixtures/instance-resolution-table.js";

const { resolveInstance } = await import("../src/resolve-instance.js");
const { placeReal, checkContainment } = await import("../src/approved-roots.js");
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

// Codex #292 R1 #2 — the Windows part of the walk runs SIMULATED here, on every
// platform (path.win32 + an in-memory file system): an absolute symlink/junction
// target restarts the walk at ITS root, and a drive or UNC prefix is never
// queued as a component.
describe("ADR-0048 PR D — placement_sim: the real-path walk on a simulated file system (win32 drive, UNC, root-relative; a POSIX control)", () => {
  it("the table carries win32 rows (no platform is only skipped)", () => {
    expect(table.placement_sim.rows.filter((r) => r.flavour === "win32").length).toBeGreaterThanOrEqual(4);
  });
  for (const row of table.placement_sim.rows) {
    it(row.name, () => {
      const placed = placeReal(row.input, simulatedWalk(row));
      if ("error" in row.expect) {
        expect(placed.ok, JSON.stringify(placed)).toBe(false);
        expect(placed.ok ? "" : placed.reason).toContain(row.expect.error);
      } else {
        expect(placed).toMatchObject({ ok: true, realPath: row.expect.realPath, exists: row.expect.exists });
      }
    });
  }
});

// Codex #292 R1 #3 — ${OUTSIDE} must really be outside: a directory inside the
// checkout is INSIDE the roots when the checkout is under /tmp.
describe("ADR-0048 PR D — outsideDir is VERIFIED outside the approved roots", () => {
  it("the OUTSIDE the rows use is refused by the containment check as outside the approved roots", () => {
    const c = checkContainment(path.join(OUTSIDE, "relay.db"));
    expect(c.ok).toBe(false);
    expect(c.ok ? "" : c.reason).toContain("outside the approved roots");
  });
  it("a candidate INSIDE the roots (a checkout under the temp directory) is skipped for one verified outside", () => {
    const inside = path.join(fs.realpathSync(os.tmpdir()), `relay-fx-inside-${process.pid}`, "node_modules", ".cache");
    const out = path.join(path.parse(inside).root, `relay-fx-outside-${process.pid}`);
    expect(outsideDir("t", [inside, out])).toBe(out);
  });
  it("no verified candidate → it throws, never hands back an inside directory", () => {
    const inside = path.join(fs.realpathSync(os.tmpdir()), `relay-fx-inside-${process.pid}`);
    expect(() => outsideDir("t", [inside])).toThrow(/no directory verified outside the approved roots/);
  });
});
