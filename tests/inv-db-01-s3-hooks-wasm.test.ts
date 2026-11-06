// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 slice 3: the hooks open the DB natively (the sqlite3 CLI, `relay pending`) ONLY when the relay says they
 * may. `relay where --fields` gains a 7th line, the hooks' DB verdict (src/hook-db-verdict.ts), computed by the relay's
 * ONE reader of the instance declaration and the DB header, so bash never parses either (parity by construction).
 * - declared wasm, or an RLYW DB → no sqlite3 at all, and ONE named notice ("hooks deliver no mail on a wasm instance;
 *   use the HTTP owner");
 * - an unreadable header, an unknown token, an empty line or a 6-line answer (an older CLI: version skew) → the same
 *   skip, named;
 * - RLYN, legacy (0), absent, 0-byte → today's sqlite3 path, unchanged.
 * `where` computes the verdict with NO SQLite connection to the DB. Runs where the hooks run: bash on Linux and macOS
 * (check-relay.sh). Each row names its fixture.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import Database from "better-sqlite3";
import { budgetTree } from "./_helpers/hook-budget-tree.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = path.join(REPO, "hooks");
const RELAY = path.join(REPO, "bin", "relay");
const DIST_DB = pathToFileURL(path.join(REPO, "dist", "db.js")).href;
const BSQ = path.join(REPO, "node_modules", "better-sqlite3");
const WASM = 0x524c5957;
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s3hooks-")));
const HOME = path.join(ROOT, "home");
const STUBS = path.join(ROOT, "stubs");
const SQLITE_LOG = path.join(ROOT, "sqlite3.log");
const CURL_LOG = path.join(ROOT, "curl.log");
const AGENT = "s3-agent";
const SEAMED = budgetTree(path.join(ROOT, "seamed"), HOOKS, path.join(REPO, "bin"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const REAL_SQLITE = spawnSync("sh", ["-c", "command -v sqlite3"], { encoding: "utf-8" }).stdout.trim();
fs.mkdirSync(STUBS, { recursive: true });
// sqlite3: records every invocation, then runs the real one (the twins' reads still work).
fs.writeFileSync(
  path.join(STUBS, "sqlite3"),
  `#!/bin/sh\nprintf '%s\\n' "$*" >> "${SQLITE_LOG}"\n${REAL_SQLITE ? `exec "${REAL_SQLITE}" "$@"` : "exit 127"}\n`,
  { mode: 0o755 },
);
// curl: no daemon (every HTTP call fails fast), recorded.
fs.writeFileSync(path.join(STUBS, "curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${CURL_LOG}"\nexit 7\n`, { mode: 0o755 });
// node: unchanged, except `relay where --fields` when FAKE_WHERE asks for an older CLI (6 lines) or an unknown token.
fs.writeFileSync(
  path.join(STUBS, "node"),
  `#!/bin/sh\n` +
    `case "$2 $3" in "where --fields")\n` +
    `  case "$FAKE_WHERE" in\n` +
    `    six) "${process.execPath}" "$@" | head -n 6; exit 0 ;;\n` +
    `    unknown) "${process.execPath}" "$@" | sed '7s/.*/skip-or-maybe-not/'; exit 0 ;;\n` +
    `  esac ;;\n` +
    `esac\n` +
    `exec "${process.execPath}" "$@"\n`,
  { mode: 0o755 },
);

/** A real relay DB with AGENT registered (stamped RLYN by the native init), then re-stamped to `appId` if given. */
function seedDb(dbPath: string, appId?: number): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const r = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `process.env.RELAY_DB_PATH = ${JSON.stringify(dbPath)};
     const db = await import(${JSON.stringify(DIST_DB)});
     db.registerAgent(${JSON.stringify(AGENT)}, "r", []);
     db.closeDb();`,
  ], { encoding: "utf-8", env: { PATH: process.env.PATH ?? "", HOME, RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(ROOT, "wc.json") } });
  expect(r.status, r.stderr).toBe(0);
  if (appId !== undefined) {
    const d = new Database(dbPath);
    d.pragma("journal_mode = DELETE");
    d.pragma(`application_id = ${appId}`);
    d.close();
  }
}

const DB = () => path.join(HOME, "inst", "relay.db");
const CFG = () => path.join(HOME, "inst", "config.json");
const declare = (v: string) => {
  fs.mkdirSync(path.dirname(CFG()), { recursive: true });
  fs.writeFileSync(CFG(), JSON.stringify({ sqlite_driver: v }), { mode: 0o600 });
};
const FIXTURES: Record<string, () => void> = {
  rlyn: () => seedDb(DB()),
  legacy: () => seedDb(DB(), 0),
  rlyw: () => seedDb(DB(), WASM),
  "declared-wasm": () => {
    seedDb(DB(), 0);
    declare("wasm");
  },
  absent: () => fs.mkdirSync(path.dirname(DB()), { recursive: true }),
  "zero-byte": () => {
    fs.mkdirSync(path.dirname(DB()), { recursive: true });
    fs.writeFileSync(DB(), "");
  },
  foreign: () => seedDb(DB(), 0x12345678),
  "invalid-declaration": () => {
    seedDb(DB());
    declare("turbo");
  },
};
const envFor = (extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: `${STUBS}:${process.env.PATH ?? ""}`,
  HOME,
  RELAY_DB_PATH: DB(),
  RELAY_CONFIG_PATH: CFG(),
  RELAY_AGENT_NAME: AGENT,
  RELAY_HTTP_PORT: "1",
  RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(ROOT, "wc.json"),
  RELAY_TEST_CLOCK: "0",
  ...extra,
});
function where(extra: Record<string, string> = {}, nodeArgs: string[] = []) {
  return spawnSync(process.execPath, [...nodeArgs, RELAY, "where", "--fields"], { encoding: "utf-8", env: envFor(extra) });
}
function runSessionStart(extra: Record<string, string> = {}) {
  fs.rmSync(SQLITE_LOG, { force: true });
  fs.rmSync(CURL_LOG, { force: true });
  const r = spawnSync("bash", [path.join(SEAMED, "check-relay.sh")], { encoding: "utf-8", timeout: 30_000, input: "", env: envFor(extra) });
  const sqliteCalls = fs.existsSync(SQLITE_LOG) ? fs.readFileSync(SQLITE_LOG, "utf-8").split("\n").filter(Boolean) : [];
  const notices = (r.stdout ?? "").split("\n").filter((l) => /Hooks deliver no mail on a wasm instance; use the HTTP owner/.test(l));
  return { status: r.status, stdout: r.stdout ?? "", out: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, sqliteCalls, notices };
}

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
});

describe("INV-DB-01 slice 3: `relay where --fields` line 7, the hooks' DB verdict (one reader, no SQLite connection)", () => {
  const table: Array<[string, string]> = [
    ["rlyn", "sqlite3"],
    ["legacy", "sqlite3"],
    ["absent", "sqlite3"],
    ["zero-byte", "sqlite3"],
    ["rlyw", "skip-rlyw"],
    ["declared-wasm", "skip-declared-wasm"],
    ["foreign", "skip-unreadable"],
    ["invalid-declaration", "skip-unreadable"],
  ];
  it.each(table)("%s → line 7 is %s; lines 1-6 keep their positions", (fixture, verdict) => {
    FIXTURES[fixture]!();
    const r = where();
    const lines = r.stdout.split("\n");
    expect(lines.length, `7 lines + the final newline: ${JSON.stringify(r.stdout)}`).toBe(8);
    expect(lines[0], "line 1: kind").toBe("explicit-db");
    expect(lines[1], "line 2: db_path").toBe(DB());
    expect(lines[5], "line 6: vault_dir").toBe(path.join(path.dirname(DB()), "agents"));
    expect(lines[6], "line 7: the hooks' DB verdict").toBe(verdict);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an UNREADABLE header (the file exists, mode 000) → skip-unreadable (fail closed), never sqlite3", () => {
    seedDb(DB());
    fs.chmodSync(DB(), 0o000);
    try {
      expect(where().stdout.split("\n")[6]).toBe("skip-unreadable");
    } finally {
      fs.chmodSync(DB(), 0o600);
    }
  });

  it("a resolver ERROR still prints 7 lines (line 7 skip-unreadable), exit 1", () => {
    const r = where({ RELAY_DB_PATH: path.join(HOME, "a\nb", "relay.db") });
    expect(r.status).toBe(1);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("error");
    expect(lines.length).toBe(8);
    expect(lines[6]).toBe("skip-unreadable");
  });

  it("`where` opens NO SQLite connection to compute it (a spy on better-sqlite3 and sql.js sees none on RLYW), with a positive control", () => {
    seedDb(DB(), WASM);
    const spyLog = path.join(ROOT, "spy.log");
    const spy = path.join(ROOT, "spy.cjs");
    fs.writeFileSync(
      spy,
      `const M = require("module"); const fs = require("fs"); const load = M._load;\n` +
        `M._load = function (req, ...rest) { const m = load.call(this, req, ...rest);\n` +
        `  if (req === "better-sqlite3" && typeof m === "function") { return new Proxy(m, { construct(t, a) { fs.appendFileSync(${JSON.stringify(spyLog)}, "better-sqlite3 " + String(a[0]) + "\\n"); return Reflect.construct(t, a); } }); }\n` +
        `  if (req === "sql.js") fs.appendFileSync(${JSON.stringify(spyLog)}, "sql.js loaded\\n");\n` +
        `  return m; };\n`,
    );
    fs.rmSync(spyLog, { force: true });
    const control = spawnSync(process.execPath, ["--require", spy, "-e", `const D = require(${JSON.stringify(BSQ)}); new D(":memory:").close();`], { encoding: "utf-8" });
    expect(control.status, control.stderr).toBe(0);
    expect(fs.existsSync(spyLog) ? fs.readFileSync(spyLog, "utf-8") : "", "positive control: the spy sees a connection").toMatch(/better-sqlite3 :memory:/);
    fs.rmSync(spyLog, { force: true });
    const r = where({}, ["--require", spy]);
    expect(r.stdout.split("\n")[6]).toBe("skip-rlyw");
    expect(fs.existsSync(spyLog) ? fs.readFileSync(spyLog, "utf-8") : "", "no SQLite connection, no sql.js").toBe("");
  });

  it("the closed token set is pinned: the TS enum and the hooks' case arms name the same tokens, and only `sqlite3` enables a read", async () => {
    const { HOOK_DB_VERDICTS } = (await import("../src/hook-db-verdict.js")) as { HOOK_DB_VERDICTS: readonly string[] };
    const src = fs.readFileSync(path.join(HOOKS, "_vault-helpers.sh"), "utf-8");
    const fn = /^relay_hook_db_native_ok\(\) \{\n([\s\S]*?)\n\}\n/m.exec(src)?.[1] ?? "";
    expect(fn, "the gate exists").not.toBe("");
    const arms = [...fn.matchAll(/^\s+([a-z0-9-]+)\)/gm)].map((m) => m[1]!);
    expect(new Set(arms)).toEqual(new Set(HOOK_DB_VERDICTS));
    expect(/^\s+sqlite3\) return 0 ;;$/m.test(fn), "the ONE enabling arm").toBe(true);
    expect((fn.match(/return 0/g) ?? []).length, "and no other").toBe(1);
  });
});

describe.skipIf(process.platform === "win32" || !REAL_SQLITE)("INV-DB-01 slice 3: SessionStart runs NO sqlite3 on a wasm instance (a PATH-shim sqlite3 records every call)", () => {
  it.each(["rlyw", "declared-wasm"])("%s → zero sqlite3 invocations, and exactly ONE named notice", (fixture) => {
    FIXTURES[fixture]!();
    const r = runSessionStart();
    expect(r.sqliteCalls, r.out).toEqual([]);
    expect(r.notices.length, r.out).toBe(1);
    expect(r.notices[0]).toContain(fixture === "rlyw" ? "skip-rlyw" : "skip-declared-wasm");
    expect(r.notices[0]).toContain(DB());
  });

  it.each(["rlyn", "legacy"])("twin: %s → the sqlite3 path runs as today (at least one call), and no notice", (fixture) => {
    FIXTURES[fixture]!();
    const r = runSessionStart();
    expect(r.sqliteCalls.length, r.out).toBeGreaterThan(0);
    expect(r.notices, r.out).toEqual([]);
  });

  it("twin: absent → no notice (today's path)", () => {
    FIXTURES.absent!();
    const r = runSessionStart();
    expect(r.notices, r.out).toEqual([]);
  });

  it("an older relay CLI (a 6-line answer) → zero sqlite3 invocations and ONE notice naming the version skew", () => {
    FIXTURES.rlyn!();
    const r = runSessionStart({ FAKE_WHERE: "six" });
    expect(r.sqliteCalls, r.out).toEqual([]);
    expect(r.notices.length, r.out).toBe(1);
    expect(r.notices[0]).toMatch(/version skew/);
  });

  it("an UNKNOWN 7th token → zero sqlite3 invocations and ONE notice (only the exact token `sqlite3` enables a read)", () => {
    FIXTURES.rlyn!();
    const r = runSessionStart({ FAKE_WHERE: "unknown" });
    expect(r.sqliteCalls, r.out).toEqual([]);
    expect(r.notices.length, r.out).toBe(1);
    expect(r.notices[0]).toMatch(/unknown DB verdict/);
  });
});
