// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0048 — `relay where` and the callers of the ONE resolver.
 *   - `relay where --json` and `relay pending --json` report the SAME resolution
 *     (one serializer) on every row where pending answers; where pending refuses,
 *     its exit code is its documented POLICY applied to where's FACTS.
 *   - `--expect-db`: 0 only for the same DB (the full gate is `relay deploy-gate`,
 *     tests/adr-0048-deploy-gate.test.ts).
 *   - the daemon RE-CHECKS containment AFTER create (TOCTOU): a parent swapped for
 *     an outside symlink between resolution and open is refused.
 *   - TRIPWIRES (ADR-0046: literal spellings only, a pinned limit): the approved
 *     roots are written in ONE module, and the instance layout literals live in
 *     instance.ts (plus the one writer PR B migrates: src/cli/init.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");
const DIST_DB = path.join(REPO_ROOT, "dist", "db.js");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adr0048w-")));
const HOME = path.join(ROOT, "home");
const RH = path.join(HOME, ".bot-relay");
const OUTSIDE = path.join(REPO_ROOT, "node_modules", ".cache", `adr0048w-outside-${process.pid}`);
const AGENT = "w-agent";

/** A real relay DB with AGENT registered, built by the real code in a child process. */
function seedDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    process.env.RELAY_DB_PATH = ${JSON.stringify(dbPath)};
    const db = await import(${JSON.stringify(DIST_DB)});
    db.registerAgent(${JSON.stringify(AGENT)}, "r", []);
    db.closeDb();`], { encoding: "utf-8", env: { PATH: process.env.PATH ?? "", HOME, RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(ROOT, "wc.json") } });
  expect(r.status, r.stderr).toBe(0);
}
function relay(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("node", [RELAY_BIN, ...args], {
    encoding: "utf-8",
    timeout: 20_000,
    env: { PATH: process.env.PATH ?? "", HOME, ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const where = (env: Record<string, string> = {}) => relay(["where", "--json"], env);
const pending = (env: Record<string, string> = {}) => relay(["pending", AGENT, "--json"], env);

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

describe("ADR-0048 — `relay where` == the resolution `relay pending` embeds (one serializer)", () => {
  const answering: Array<[string, () => Record<string, string>]> = [
    ["explicit RELAY_DB_PATH", () => { const p = path.join(HOME, "e", "relay.db"); seedDb(p); return { RELAY_DB_PATH: p }; }],
    ["instance via the marker", () => { seedDb(path.join(RH, "instances", "i1", "relay.db")); fs.symlinkSync("i1", path.join(RH, "active-instance")); return {}; }],
    ["instance via RELAY_INSTANCE_ID", () => { seedDb(path.join(RH, "instances", "i2", "relay.db")); return { RELAY_INSTANCE_ID: "i2" }; }],
    ["flat, legacy install", () => { seedDb(path.join(RH, "relay.db")); return {}; }],
  ];
  for (const [label, setup] of answering) {
    it(`${label}: pending answers, and its embedded resolution EQUALS where's`, () => {
      const env = setup();
      const w = where(env);
      const p = pending(env);
      expect(w.status, w.stderr).toBe(0);
      expect(p.status, p.stderr).toBe(0);
      expect(JSON.parse(p.stdout).resolution).toEqual(JSON.parse(w.stdout).resolution);
      expect(JSON.parse(w.stdout).vault_dir).toBe(path.join(path.dirname(JSON.parse(w.stdout).resolution.db_path), "agents"));
    });
  }

  // Where pending REFUSES, it prints nothing on stdout; its exit code is its policy
  // applied to where's facts.
  const refusing: Array<[string, () => Record<string, string>, (w: Record<string, unknown>) => void, number]> = [
    ["flat, NO DB file (no local relay here)", () => ({}), (w) => expect(w).toMatchObject({ kind: "flat", exists: false }), 3],
    ["explicit DB configured but MISSING", () => ({ RELAY_DB_PATH: path.join(HOME, "gone.db") }), (w) => expect(w).toMatchObject({ kind: "explicit-db", exists: false }), 1],
    ["AMBIGUOUS (instances, none selected)", () => { fs.mkdirSync(path.join(RH, "instances", "x"), { recursive: true }); return {}; }, (w) => expect(w).toMatchObject({ kind: "error", ambiguous: true }), 1],
    ["OUTSIDE the approved roots", () => ({ RELAY_DB_PATH: path.join(OUTSIDE, "relay.db") }), (w) => expect(w).toMatchObject({ kind: "error" }), 1],
  ];
  for (const [label, setup, expectWhere, code] of refusing) {
    it(`${label}: where reports the fact, pending exits ${code} with nothing on stdout`, () => {
      const env = setup();
      const w = where(env);
      expectWhere(JSON.parse(w.stdout).resolution);
      const p = pending(env);
      expect(p.status, p.stderr).toBe(code);
      expect(p.stdout).toBe("");
    });
  }
});

describe("ADR-0048 — `relay where --expect-db`: the same DB, by real path", () => {
  it("the same DB (by real path, through a symlinked alias) → exit 0, WHERE_MATCH", () => {
    const p = path.join(HOME, "real", "relay.db");
    seedDb(p);
    fs.symlinkSync(path.join(HOME, "real"), path.join(HOME, "alias"));
    const r = relay(["where", "--json", "--expect-db", path.join(HOME, "alias", "relay.db")], { RELAY_DB_PATH: p });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/WHERE_MATCH/);
  });
  it("a DIFFERENT DB → exit 1, WHERE_MISMATCH (the restart would move the daemon)", () => {
    const p = path.join(HOME, "a.db");
    seedDb(p);
    const r = relay(["where", "--expect-db", path.join(HOME, "b.db")], { RELAY_DB_PATH: p });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/WHERE_MISMATCH/);
  });
  it("a resolver FAULT → exit 1, WHERE_FAILED, never a match", () => {
    fs.mkdirSync(path.join(RH, "instances", "x"), { recursive: true });
    const r = relay(["where", "--expect-db", path.join(RH, "relay.db")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/WHERE_FAILED/);
  });
});

describe("ADR-0048 — the daemon re-checks containment AFTER create (TOCTOU)", () => {
  it("a parent swapped for an OUTSIDE symlink between resolution and open → REFUSED", async () => {
    const saved = { HOME: process.env.HOME, RELAY_DB_PATH: process.env.RELAY_DB_PATH };
    process.env.HOME = HOME;
    const dir = path.join(HOME, "racy");
    process.env.RELAY_DB_PATH = path.join(dir, "relay.db");
    const db = await import("../src/db.js");
    db.closeDb();
    // The racer: when the daemon creates the DB's directory, a symlink to OUTSIDE
    // appears there instead (resolution already said "contained").
    const realMkdir = fs.mkdirSync.bind(fs);
    vi.spyOn(fs, "mkdirSync").mockImplementation(((p: fs.PathLike, o?: unknown) => {
      if (String(p) === dir) {
        fs.symlinkSync(OUTSIDE, dir);
        return undefined;
      }
      return realMkdir(p, o as never);
    }) as never);
    try {
      await expect(db.initializeDb()).rejects.toThrow(/REFUSING the relay DB after opening it/);
    } finally {
      db.closeDb();
      process.env.HOME = saved.HOME;
      if (saved.RELAY_DB_PATH === undefined) delete process.env.RELAY_DB_PATH;
      else process.env.RELAY_DB_PATH = saved.RELAY_DB_PATH;
    }
  });
});

describe("ADR-0048 — tripwires (literal spellings only; the guards are the contract tests)", () => {
  const srcFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? srcFiles(p) : p.endsWith(".ts") ? [p] : [];
    });
  const rel = (p: string) => path.relative(REPO_ROOT, p);

  it("the approved roots are written in ONE module", () => {
    const hits = srcFiles(path.join(REPO_ROOT, "src")).filter((f) => /"\/var\/folders"|"\/private\/tmp"/.test(fs.readFileSync(f, "utf-8")));
    expect(hits.map(rel)).toEqual(["src/approved-roots.ts"]);
  });

  it("the instance layout literals live in instance.ts (+ the one pinned writer, src/cli/init.ts, which PR B migrates)", () => {
    const hits = srcFiles(path.join(REPO_ROOT, "src"))
      .filter((f) => /["']active-instance["']|["']instances["']/.test(fs.readFileSync(f, "utf-8")))
      .map(rel)
      .sort();
    expect(hits).toEqual(["src/cli/init.ts", "src/instance.ts"]);
  });
});

describe("ADR-0048 Q2 — `relay doctor` PRINTS the resolver error (never a crash, never a guess)", () => {
  it("an ambiguous home → FAIL 'instance resolution' with the reason, exit 1, no stack trace", () => {
    fs.mkdirSync(path.join(RH, "instances", "x"), { recursive: true });
    const r = relay(["doctor"], { RELAY_HTTP_PORT: "1" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL instance resolution: .*ambiguous/);
    expect(r.stdout + r.stderr).not.toMatch(/\n\s+at /);
  });
  const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(IS_ROOT)("Codex #287 P2-8: explicit DB + an UNREADABLE marker (mode 000) → the doctor REPORTS it (config FAIL), never crashes", () => {
    const db = path.join(HOME, "explicit", "relay.db");
    seedDb(db);
    fs.mkdirSync(RH, { recursive: true });
    const marker = path.join(RH, "active-instance");
    fs.writeFileSync(marker, "work");
    fs.chmodSync(marker, 0o000);
    try {
      const r = relay(["doctor"], { RELAY_HTTP_PORT: "1", RELAY_DB_PATH: db });
      expect(r.stdout, r.stderr).toMatch(/=== relay doctor ===/);
      expect(r.stdout).toMatch(/PASS instance resolution: explicit DB/);
      expect(r.stdout).toMatch(/FAIL config\.json: .*EACCES/);
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).not.toMatch(/\n\s+at /);
    } finally {
      fs.chmodSync(marker, 0o600);
    }
  });
  it("TWIN: a resolvable home → PASS 'instance resolution' naming the DB", () => {
    seedDb(path.join(RH, "relay.db"));
    const r = relay(["doctor"], { RELAY_HTTP_PORT: "1" });
    expect(r.stdout).toMatch(/PASS instance resolution: flat .*relay\.db/);
  });
});
