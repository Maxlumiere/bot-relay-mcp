// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0048 — instance resolution is ONE strict function: a fault never selects a
 * different DB.
 *
 * THE CONTRACT (the state table, Codex #285 R2, extended by the plan review):
 * resolveInstance() returns a CLOSED result that reports FACTS:
 *   explicit-db{dbPath, exists} | instance{id, dbPath, exists} | flat{dbPath, exists} | error{reason}
 *   - flat ONLY on a POSITIVE absence of any instance: the active-instance marker is
 *     ENOENT AND instances/ is ENOENT, empty, or holds no directories;
 *   - ONE marker read; the path is instanceDir(id);
 *   - any other fault (EIO, EACCES, ELOOP, ENOTDIR, an unreadable or malformed
 *     marker, containment) is `error`, never flat;
 *   - containment: realpath of the deepest EXISTING ancestor (climbing ONLY on
 *     ENOENT) + the remaining segments, under the realpath'd approved roots.
 * TWO-SIDED: every fault row has a positive-absence twin that still yields flat, so
 * a legacy install keeps working.
 *
 * Fault injection wraps the real `fs` calls (vi.spyOn), one row at a time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adr0048-")));
const HOME = path.join(ROOT, "home");
const RH = path.join(HOME, ".bot-relay");
// Outside HOME and every temp root: the repo's own gitignored cache.
const OUTSIDE = path.join(REPO_ROOT, "node_modules", ".cache", `adr0048-outside-${process.pid}`);

const inst = await import("../src/instance.js");

const ENV_KEYS = ["HOME", "RELAY_HOME", "RELAY_DB_PATH", "RELAY_INSTANCE_ID", "RELAY_ALLOW_LEGACY_FALLBACK", "RELAY_CONFIG_PATH"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HOME = HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

const touch = (p: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "");
};
const errno = (code: string) => Object.assign(new Error(`${code}: injected`), { code });
/** Make fs.<fn> throw `code` for any path matching `match` (the n-th call onward). */
function fault(fn: "lstatSync" | "readlinkSync" | "readFileSync" | "readdirSync" | "realpathSync" | "statSync", match: (p: string) => boolean, code: string, fromCall = 1) {
  const real = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[fn].bind(fs);
  let n = 0;
  return vi.spyOn(fs, fn as never).mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (match(String(p))) {
      n++;
      if (n >= fromCall) throw errno(code);
    }
    return real(p, ...rest);
  }) as never);
}

const flatDb = () => path.join(RH, "relay.db");
const instDb = (id: string) => path.join(RH, "instances", id, "relay.db");

describe("ADR-0048 — the state table: positive rows", () => {
  it("RELAY_DB_PATH, file present → explicit-db, exists", () => {
    const p = path.join(HOME, "x", "relay.db");
    touch(p);
    process.env.RELAY_DB_PATH = p;
    expect(inst.resolveInstance()).toEqual({ kind: "explicit-db", dbPath: p, exists: true, basis: "RELAY_DB_PATH" });
  });

  it("RELAY_DB_PATH, file absent (parent present) → explicit-db, NOT exists", () => {
    fs.mkdirSync(path.join(HOME, "x"));
    const p = path.join(HOME, "x", "relay.db");
    process.env.RELAY_DB_PATH = p;
    expect(inst.resolveInstance()).toEqual({ kind: "explicit-db", dbPath: p, exists: false, basis: "RELAY_DB_PATH" });
  });

  it("RELAY_DB_PATH with an ABSENT parent → explicit-db, NOT exists (the walk climbs on ENOENT)", () => {
    const p = path.join(HOME, "no", "such", "dir", "relay.db");
    process.env.RELAY_DB_PATH = p;
    expect(inst.resolveInstance()).toEqual({ kind: "explicit-db", dbPath: p, exists: false, basis: "RELAY_DB_PATH" });
  });

  it("an explicit --db-path input outranks everything", () => {
    const p = path.join(HOME, "flag.db");
    touch(p);
    process.env.RELAY_DB_PATH = path.join(HOME, "env.db");
    expect(inst.resolveInstance({ dbPath: p })).toEqual({ kind: "explicit-db", dbPath: p, exists: true, basis: "--db-path" });
  });

  it("RELAY_INSTANCE_ID valid → instance (env), exists as found", () => {
    touch(instDb("work"));
    process.env.RELAY_INSTANCE_ID = "work";
    expect(inst.resolveInstance()).toEqual({ kind: "instance", id: "work", dbPath: instDb("work"), exists: true, basis: "RELAY_INSTANCE_ID" });
    process.env.RELAY_INSTANCE_ID = "other";
    expect(inst.resolveInstance()).toEqual({ kind: "instance", id: "other", dbPath: instDb("other"), exists: false, basis: "RELAY_INSTANCE_ID" });
  });

  it("marker symlink → instance (active-instance)", () => {
    touch(instDb("a"));
    fs.symlinkSync("a", path.join(RH, "active-instance"));
    expect(inst.resolveInstance()).toEqual({ kind: "instance", id: "a", dbPath: instDb("a"), exists: true, basis: "active-instance" });
  });

  it("marker FILE with an id → instance", () => {
    fs.mkdirSync(RH, { recursive: true });
    fs.writeFileSync(path.join(RH, "active-instance"), "b\n");
    expect(inst.resolveInstance()).toEqual({ kind: "instance", id: "b", dbPath: instDb("b"), exists: false, basis: "active-instance" });
  });
});

describe("ADR-0048 — flat ONLY on a POSITIVE absence (the legacy install still works)", () => {
  it("no relay home at all → flat, NOT exists", () => {
    expect(inst.resolveInstance()).toEqual({ kind: "flat", dbPath: flatDb(), exists: false });
  });
  it("relay home, no marker, no instances/, flat DB present → flat, exists", () => {
    touch(flatDb());
    expect(inst.resolveInstance()).toEqual({ kind: "flat", dbPath: flatDb(), exists: true });
  });
  it("instances/ EMPTY → flat", () => {
    fs.mkdirSync(path.join(RH, "instances"), { recursive: true });
    expect(inst.resolveInstance()).toMatchObject({ kind: "flat", dbPath: flatDb() });
  });
  it("instances/ holding only FILES → flat", () => {
    touch(path.join(RH, "instances", "stray.txt"));
    expect(inst.resolveInstance()).toMatchObject({ kind: "flat", dbPath: flatDb() });
  });
});

describe("ADR-0048 — every FAULT is `error`, never flat", () => {
  const isError = (r: { kind: string }) => expect(r.kind, JSON.stringify(r)).toBe("error");

  it("instances hold a dir, no marker (AMBIGUOUS) → error; RELAY_ALLOW_LEGACY_FALLBACK=1 → flat WITH a warning", () => {
    fs.mkdirSync(path.join(RH, "instances", "w"), { recursive: true });
    isError(inst.resolveInstance());
    process.env.RELAY_ALLOW_LEGACY_FALLBACK = "1";
    const r = inst.resolveInstance();
    expect(r).toMatchObject({ kind: "flat", dbPath: flatDb() });
    expect((r as { warning?: string }).warning).toMatch(/instances exist/);
  });
  it("marker file EMPTY → error", () => {
    fs.mkdirSync(RH, { recursive: true });
    fs.writeFileSync(path.join(RH, "active-instance"), "  \n");
    isError(inst.resolveInstance());
  });
  it("marker is a DIRECTORY → error", () => {
    fs.mkdirSync(path.join(RH, "active-instance"), { recursive: true });
    isError(inst.resolveInstance());
  });
  it("marker id with forbidden characters → error", () => {
    fs.mkdirSync(RH, { recursive: true });
    fs.writeFileSync(path.join(RH, "active-instance"), "bad/../id");
    isError(inst.resolveInstance());
  });
  it("RELAY_INSTANCE_ID with forbidden characters → error", () => {
    process.env.RELAY_INSTANCE_ID = "../escape";
    isError(inst.resolveInstance());
  });
  for (const code of ["EACCES", "EIO"]) {
    it(`lstat of the relay home fails (${code}) → error`, () => {
      fault("lstatSync", (p) => p === RH, code);
      isError(inst.resolveInstance());
    });
    it(`lstat of the marker fails (${code}) → error`, () => {
      fs.mkdirSync(RH, { recursive: true });
      fault("lstatSync", (p) => p.endsWith("active-instance"), code);
      isError(inst.resolveInstance());
    });
    it(`readlink of the marker fails (${code}) → error`, () => {
      fs.mkdirSync(RH, { recursive: true });
      fs.symlinkSync("a", path.join(RH, "active-instance"));
      fault("readlinkSync", (p) => p.endsWith("active-instance"), code);
      isError(inst.resolveInstance());
    });
    it(`reading the marker file fails (${code}) → error`, () => {
      fs.mkdirSync(RH, { recursive: true });
      fs.writeFileSync(path.join(RH, "active-instance"), "a");
      fault("readFileSync", (p) => p.endsWith("active-instance"), code);
      isError(inst.resolveInstance());
    });
    it(`lstat of instances/ fails (${code}) → error`, () => {
      fs.mkdirSync(RH, { recursive: true });
      fault("lstatSync", (p) => p.endsWith(`${path.sep}instances`), code);
      isError(inst.resolveInstance());
    });
    it(`listing instances/ fails (${code}) → error`, () => {
      fs.mkdirSync(path.join(RH, "instances"), { recursive: true });
      fault("readdirSync", (p) => p.endsWith(`${path.sep}instances`), code);
      isError(inst.resolveInstance());
    });
    it(`realpath of an EXISTING ancestor fails (${code}) → error (the walk climbs ONLY on ENOENT)`, () => {
      const p = path.join(HOME, "x", "relay.db");
      touch(p);
      process.env.RELAY_DB_PATH = p;
      fault("realpathSync", (q) => q === p || q === path.dirname(p), code);
      isError(inst.resolveInstance());
    });
  }
  it("a marker symlink LOOP (ELOOP on the DB path's parent) → error", () => {
    fs.mkdirSync(path.join(RH, "instances"), { recursive: true });
    fs.symlinkSync("loop", path.join(RH, "instances", "loop"));
    fs.symlinkSync("loop", path.join(RH, "active-instance"));
    isError(inst.resolveInstance());
  });
});

describe("ADR-0048 — ONE marker read (the #285 read-twice row)", () => {
  it("the first marker read succeeds and a second would fail → still the INSTANCE (the marker is read once)", () => {
    touch(instDb("once"));
    fs.symlinkSync("once", path.join(RH, "active-instance"));
    const spy = fault("readlinkSync", (p) => p.endsWith("active-instance"), "EIO", 2);
    expect(inst.resolveInstance()).toMatchObject({ kind: "instance", id: "once", dbPath: instDb("once") });
    expect(spy.mock.calls.filter((c) => String(c[0]).endsWith("active-instance")).length).toBe(1);
  });
});

describe("ADR-0048 — containment: realpath, inside the resolver", () => {
  it("a DB path outside the approved roots → error", () => {
    process.env.RELAY_DB_PATH = path.join(OUTSIDE, "relay.db");
    expect(inst.resolveInstance()).toMatchObject({ kind: "error" });
  });
  it("a SYMLINKED PARENT under HOME that points outside → error (path.resolve alone would accept it)", () => {
    fs.symlinkSync(OUTSIDE, path.join(HOME, "escape"));
    process.env.RELAY_DB_PATH = path.join(HOME, "escape", "relay.db");
    const r = inst.resolveInstance();
    expect(r, JSON.stringify(r)).toMatchObject({ kind: "error" });
    expect((r as { reason: string }).reason).toMatch(/outside the approved roots/);
  });
  it("a symlinked parent that STAYS inside → accepted (the twin)", () => {
    fs.mkdirSync(path.join(HOME, "real"));
    fs.symlinkSync(path.join(HOME, "real"), path.join(HOME, "alias"));
    process.env.RELAY_DB_PATH = path.join(HOME, "alias", "relay.db");
    expect(inst.resolveInstance()).toMatchObject({ kind: "explicit-db", exists: false });
  });
  it("`..` segments are normalised lexically first: HOME/a/../../outside → error", () => {
    // Built by concatenation: path.join would normalise the `..` away before the resolver sees it.
    process.env.RELAY_DB_PATH = `${HOME}/a/${"../".repeat(40)}${OUTSIDE.slice(1)}/relay.db`;
    expect(process.env.RELAY_DB_PATH).toContain("/../");
    expect(inst.resolveInstance()).toMatchObject({ kind: "error" });
  });
  it("the OS temp dir is an approved root via its realpath (macOS /var → /private/var)", () => {
    const p = path.join(os.tmpdir(), `adr0048-tmp-${process.pid}.db`);
    process.env.RELAY_DB_PATH = p;
    expect(inst.resolveInstance()).toMatchObject({ kind: "explicit-db" });
  });
  it("a RELAY_HOME outside the approved roots → error (flat or instance alike)", () => {
    process.env.RELAY_HOME = OUTSIDE;
    expect(inst.resolveInstance()).toMatchObject({ kind: "error" });
  });
});

describe("ADR-0048 — consumers are strict: no fault reaches the flat DB through them", () => {
  it("resolveInstanceDbPath THROWS on a fault (it used to return the flat DB)", () => {
    fs.mkdirSync(path.join(RH, "instances"), { recursive: true });
    touch(flatDb());
    fault("readdirSync", (p) => p.endsWith(`${path.sep}instances`), "EIO");
    expect(() => inst.resolveInstanceDbPath()).toThrow(/EIO/);
  });
  it("resolveActiveInstanceId THROWS on a marker fault (it used to return null → flat)", () => {
    fs.mkdirSync(RH, { recursive: true });
    fs.symlinkSync("a", path.join(RH, "active-instance"));
    fault("readlinkSync", (p) => p.endsWith("active-instance"), "EACCES");
    expect(() => inst.resolveActiveInstanceId()).toThrow(/EACCES/);
  });
  it("the daemon's startup assertion REFUSES on every error kind (containment included)", () => {
    process.env.RELAY_DB_PATH = path.join(OUTSIDE, "relay.db");
    expect(() => inst.assertInstanceResolution(() => {})).toThrow(/REFUSING TO START/);
  });
  it("getDbPath (db.ts) throws on a fault instead of returning the flat DB", async () => {
    const db = await import("../src/db.js");
    fs.mkdirSync(RH, { recursive: true });
    touch(flatDb());
    fs.symlinkSync("a", path.join(RH, "active-instance"));
    fault("readlinkSync", (p) => p.endsWith("active-instance"), "EIO");
    expect(() => db.getDbPath()).toThrow(/EIO/);
  });
  it("the config path follows the same strict resolution", () => {
    fs.mkdirSync(RH, { recursive: true });
    fs.symlinkSync("a", path.join(RH, "active-instance"));
    expect(inst.resolveInstanceConfigPath()).toBe(path.join(RH, "instances", "a", "config.json"));
    fault("readlinkSync", (p) => p.endsWith("active-instance"), "EIO");
    expect(() => inst.resolveInstanceConfigPath()).toThrow(/EIO/);
  });
});
