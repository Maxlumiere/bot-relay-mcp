// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.25.x regression: getDb()'s native lazy-init fallback used a bare
 * `require("module")`, which throws "require is not defined" in this ESM
 * ("type":"module") build. It only fired in a REAL Node ESM runtime on the
 * pre-initializeDb() path — vitest provides a `require` shim, so the unit
 * suite never caught it, and the live server never hits it (it always
 * `await initializeDb()` first). This test runs the BUILT dist in a real ESM
 * `node` child to prove getDb() no longer throws that error and returns a
 * usable database. It guards the npm-v12 wasm-hatch guidance (docs) against a
 * silent reintroduction of the bare require on the sync accessor.
 *
 * dist-dependent: the pre-publish gate and every CI job build before tests.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIST_DB = path.resolve("dist/db.js");

describe("v2.25 getDb() ESM-safe native require (real-runtime regression)", () => {
  let tmpDir: string | null = null;
  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("getDb() before initializeDb() works in a real ESM node runtime (no 'require is not defined')", () => {
    // Precondition: dist must be built (the pre-publish gate + CI build before tests).
    expect(
      fs.existsSync(DIST_DB),
      `built dist not found at ${DIST_DB} — run npm run build`,
    ).toBe(true);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-getdb-esm-"));
    const dbPath = path.join(tmpDir, "relay.db");

    // Import the BUILT dist (real ESM) and hit the native lazy-init fallback by
    // calling getDb() before initializeDb(). Under the old bug this threw
    // "require is not defined"; createRequire (imported at top of db.ts) fixes it.
    const script = `
      import { getDb, closeDb } from ${JSON.stringify(DIST_DB)};
      const db = getDb();
      const n = db.prepare("select count(*) as n from sqlite_master").get().n;
      closeDb();
      process.stdout.write("GETDB_OK rows=" + n);
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, RELAY_DB_PATH: dbPath, RELAY_SQLITE_DRIVER: "native" },
    });

    const combined = (res.stdout || "") + (res.stderr || "");
    // The exact symptom of the bug — must never reappear.
    expect(combined).not.toMatch(/require is not defined/);
    expect(res.status, `child exited non-zero:\n${combined}`).toBe(0);
    expect(res.stdout).toContain("GETDB_OK");
  });
});
