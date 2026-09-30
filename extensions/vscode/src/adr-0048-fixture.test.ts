// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// ADR-0048 PR D — the TETHER side of the shared resolver state table
// (tests/fixtures/instance-resolution-table.json). Every applicable row goes
// through vault-path (which calls the relay's bundled resolver); the relay runs
// the same rows through resolveInstance (tests/adr-0048-d-fixture.test.ts). A
// path row must give the same DB (and so the vault beside it); an error row must
// be a MISS carrying the same reason: Tether never reads a vault the relay would
// not use.
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadResolutionTable, applyRow, expectedDb, rowApplies, outsideDir } from "../../../tests/fixtures/instance-resolution-table.js";
import { resolveRelayDbPath, resolveVaultTokenPath } from "./vault-path.js";

const table = loadResolutionTable();
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tether-fx-")));
const OUTSIDE = outsideDir("tether");
afterAll(() => {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

describe("ADR-0048 PR D — Tether resolves every row exactly as the relay does", () => {
  table.rows.forEach((row, i) => {
    it.skipIf(!rowApplies(row))(row.name, () => {
      const home = path.join(BASE, `row-${i}`);
      fs.mkdirSync(home, { recursive: true });
      const env = applyRow(row, home, OUTSIDE);
      const db = resolveRelayDbPath(env, home);
      const vault = resolveVaultTokenPath("fx-agent", env, home);
      if (row.expect.kind === "error") {
        expect(db, JSON.stringify(db)).toMatchObject({ miss: expect.stringContaining(row.expect.reason) });
        expect("miss" in vault, "no vault path for a row the relay refuses").toBe(true);
      } else {
        const want = expectedDb(row, home) as string;
        expect(db).toEqual({ dbPath: want });
        expect(vault).toEqual({ tokenPath: path.join(path.dirname(want), "agents", "fx-agent.token") });
      }
    });
  });
});
