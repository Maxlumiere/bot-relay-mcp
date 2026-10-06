// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0048 PR B (Codex #288 R1 P1-2) — every RAW better-sqlite3 handle a CLI verb
 * opens on the relay DB gets db.ts's post-open re-check (assertStillContained:
 * containment + the shared-root ownership rule) through ONE helper,
 * src/cli/_instance-db.ts openRawRelayDb. A DB that was missing at resolution and
 * then created by another user under /tmp is refused before the handle is used.
 *
 * Ownership cannot be produced without root, so the foreign owner is an injected
 * lstat on exactly the DB path (every other path is real).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UID = typeof process.getuid === "function" ? process.getuid() : -1;
const SHARED_DIR = fs.realpathSync(fs.mkdtempSync("/tmp/adr0048r-"));
fs.mkdirSync(path.join(REPO_ROOT, "node_modules", ".cache"), { recursive: true });
const PER_USER = fs.realpathSync(fs.mkdtempSync(path.join(REPO_ROOT, "node_modules", ".cache", "adr0048r-")));
const SEED = path.join(PER_USER, "seed.db");

/** A real relay DB, built by the real code in a child process. */
function seedDb(dbPath: string): void {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    process.env.RELAY_DB_PATH = ${JSON.stringify(dbPath)};
    const db = await import(${JSON.stringify(path.join(REPO_ROOT, "dist", "db.js"))});
    db.registerAgent("r-agent", "r", []);
    db.closeDb();`], { encoding: "utf-8", env: { PATH: process.env.PATH ?? "", HOME: PER_USER, RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(PER_USER, "wc.json") } });
  expect(r.status, r.stderr).toBe(0);
}
seedDb(SEED);

const ENV = ["HOME", "RELAY_DB_PATH", "RELAY_INSTANCE_ID", "RELAY_WAKE_COVERAGE_STATUS_PATH"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  delete process.env.RELAY_INSTANCE_ID;
  process.env.HOME = PER_USER;
  process.env.RELAY_WAKE_COVERAGE_STATUS_PATH = path.join(PER_USER, "wc.json");
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(() => {
  fs.rmSync(SHARED_DIR, { recursive: true, force: true });
  fs.rmSync(PER_USER, { recursive: true, force: true });
});

/** fs.lstatSync reports another owner for exactly `target` (once it exists). */
function foreignOwner(target: string) {
  const real = fs.lstatSync.bind(fs);
  return vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    const st = (real as (...a: unknown[]) => fs.Stats)(p, ...rest);
    return String(p) === target ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: UID + 1 }) : st;
  }) as never);
}

describe.skipIf(UID < 0)("ADR-0048 PR B — openRawRelayDb: the raw handle gets the post-open re-check", () => {
  for (const readonly of [true, false]) {
    it(`a foreign-owned DB under /tmp is REFUSED after the open (readonly=${readonly})`, async () => {
      const p = path.join(SHARED_DIR, `foreign-${readonly}.db`);
      fs.copyFileSync(SEED, p);
      foreignOwner(p);
      const { openRawRelayDb } = await import("../src/cli/_instance-db.js");
      await expect(openRawRelayDb(p, { readonly })).rejects.toThrow(/owned by uid/);
    });
  }
  it("TWIN: your own DB under /tmp opens", async () => {
    const p = path.join(SHARED_DIR, "own.db");
    fs.copyFileSync(SEED, p);
    const { openRawRelayDb } = await import("../src/cli/_instance-db.js");
    const db = await openRawRelayDb(p, { readonly: true });
    db.close();
  });

  it("`relay fleet`: a DB MISSING at resolution and then created by another user is refused before it is read (end to end, in-process)", async () => {
    const p = path.join(SHARED_DIR, "race.db");
    process.env.RELAY_DB_PATH = p;
    // The race: the file appears (another user's) right after resolution said "absent".
    const realExists = fs.existsSync.bind(fs);
    let planted = false;
    vi.spyOn(fs, "existsSync").mockImplementation(((q: fs.PathLike) => {
      if (String(q) === p && !planted) {
        planted = true;
        fs.copyFileSync(SEED, p);
      }
      return realExists(q);
    }) as never);
    foreignOwner(p);
    let err = "";
    vi.spyOn(process.stderr, "write").mockImplementation(((c: string | Uint8Array) => {
      err += String(c);
      return true;
    }) as never);
    vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    const fleet = await import("../src/cli/fleet.js");
    const code = await fleet.run([]);
    expect(planted, "precondition: the race fired").toBe(true);
    expect(code, err).not.toBe(0);
    expect(err).toMatch(/owned by uid/);
  });
});

describe("ADR-0048 PR B — TRIPWIRE: no module opens a SQLite driver handle except the three that re-check it after opening", () => {
  /**
   * src/-wide (Codex #288 R2 #2): a driver import (better-sqlite3 or sql.js, any
   * spelling: import(), from, require(), createRequire's req()) appears ONLY in
   *   - src/sqlite-compat.ts  (the driver layer; openReadOnly re-checks privately),
   *   - src/db.ts             (initializeDb/getDb re-check assertStillContained),
   *   - src/cli/_instance-db.ts (openRawRelayDb, the verbs' raw handle),
   * plus ONE named exception that never opens the relay DB:
   *   - src/doorbell-lock.ts  (the doorbell's kernel-held instance lock: its OWN file,
   *     `<state dir>/doorbell.lock.db`; pinned by the next test). Why: a kernel lock needs
   *     a held driver connection, and this one never opens the relay DB, so the post-open
   *     re-check has nothing to guard. Ruling ecf50062; exception accepted in c79321c9.
   *     That the state dir is the RESOLVED instance's is pinned in
   *     tests/doorbell-pr5-heartbeat.test.ts ("the lock lives in the RESOLVED instance's state dir").
   * Type declarations (.d.ts) are not code.
   */
  it("the SQLite driver is referenced in src/ ONLY by the three checked modules", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
          // Code forms only (a comment may NAME the package): import("x"), from "x",
          // require("x"), createRequire's req("x"), and a bare import "x".
          if (/(?:\bimport\s*\(|\bfrom|\brequire\s*\(|\breq\s*\(|\bimport)\s*["'`](better-sqlite3|sql\.js)["'`]/.test(fs.readFileSync(full, "utf-8"))) {
            hits.push(path.relative(REPO_ROOT, full));
          }
        }
      }
    };
    walk(path.join(REPO_ROOT, "src"));
    expect(hits.sort()).toEqual(["src/cli/_instance-db.ts", "src/db.ts", "src/doorbell-lock.ts", "src/sqlite-compat.ts"]);
  });

  it("the doorbell-lock exception opens exactly ONE driver handle, on its own lock file (never the relay DB)", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "src", "doorbell-lock.ts"), "utf-8");
    // Exactly one construction, and its path argument is the lock path...
    expect(src.match(/\bnew\s+Database\s*\(/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/\bnew\s+Database\s*\(\s*lockPath\s*,/);
    // ...which is bound once, to the lock filename inside the doorbell state dir.
    expect(src.match(/\blockPath\s*=/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/\bconst\s+lockPath\s*=\s*path\.join\(\s*stateDir\s*,\s*LOCK_DB_FILENAME\s*\)/);
    expect(src).toMatch(/\bexport\s+const\s+LOCK_DB_FILENAME\s*=\s*"doorbell\.lock\.db"/);
  });
});
