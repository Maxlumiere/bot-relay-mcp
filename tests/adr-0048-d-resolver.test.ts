// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0048 PR D — the resolver is a PURE module (src/resolve-instance.ts) that
 * Tether bundles instead of copying.
 *   1. The environment is a parameter: resolveInstance({ env }) resolves for a
 *      FOREIGN env in-process and never reads or mutates process.env for it;
 *      without `env` it is exactly the old behaviour (process.env).
 *   4. Version skew is VISIBLE: RESOLVER_REVISION is a content hash of the
 *      resolver's two source files (pinned here), and the relay reports it on
 *      /health and in `relay where --json`.
 *   5. Windows is an EXPLICIT branch: with no uid (process.getuid undefined) the
 *      result is labeled `containment: "roots-only"`; it neither crashes nor
 *      silently claims the ownership rule.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adr0048d-")));
const A = path.join(ROOT, "a");
const B = path.join(ROOT, "b");
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const R = await import("../src/resolve-instance.js");

const KEYS = ["HOME", "RELAY_HOME", "RELAY_DB_PATH", "RELAY_INSTANCE_ID", "RELAY_ALLOW_LEGACY_FALLBACK"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  fs.rmSync(A, { recursive: true, force: true });
  fs.rmSync(B, { recursive: true, force: true });
  fs.mkdirSync(path.join(A, ".bot-relay", "instances", "ia"), { recursive: true });
  fs.symlinkSync("ia", path.join(A, ".bot-relay", "active-instance"));
  fs.mkdirSync(path.join(B, ".bot-relay", "instances", "ib"), { recursive: true });
  fs.symlinkSync("ib", path.join(B, ".bot-relay", "active-instance"));
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("ADR-0048 PR D (1) — the environment is a PARAMETER", () => {
  it("resolveInstance({ env }) resolves for a FOREIGN env, never the process's own", () => {
    process.env.HOME = A;
    const r = R.resolveInstance({ env: { HOME: B } });
    expect(r).toMatchObject({ kind: "instance", id: "ib", dbPath: path.join(B, ".bot-relay", "instances", "ib", "relay.db") });
  });
  it("…and never MUTATES process.env", () => {
    process.env.HOME = A;
    const before = { ...process.env };
    R.resolveInstance({ env: { HOME: B, RELAY_INSTANCE_ID: "ib" } });
    expect({ ...process.env }).toEqual(before);
  });
  it("…and never READS process.env for that resolution (a trapped process.env throws on any read)", () => {
    process.env.HOME = A;
    const real = process.env;
    const trap = new Proxy(real, {
      get(t, k) {
        if (typeof k === "string" && (KEYS as readonly string[]).includes(k)) throw new Error(`process.env.${k} was read`);
        return Reflect.get(t, k);
      },
    });
    Object.defineProperty(process, "env", { value: trap, configurable: true, writable: true });
    try {
      expect(R.resolveInstance({ env: { HOME: B } })).toMatchObject({ kind: "instance", id: "ib" });
    } finally {
      Object.defineProperty(process, "env", { value: real, configurable: true, writable: true });
    }
  });
  it("TWIN: without `env` it is exactly process.env (every existing caller)", () => {
    process.env.HOME = A;
    expect(R.resolveInstance()).toEqual(R.resolveInstance({ env: process.env }));
    expect(R.resolveInstance()).toMatchObject({ kind: "instance", id: "ia" });
  });
  it("a foreign env with no HOME falls back to the account's directory-service home (what that process would get)", () => {
    expect(R.homeFor({})).toBe(os.userInfo().homedir);
  });
});

describe("ADR-0048 PR D (4) — the resolver's revision is pinned and reported", () => {
  it("RESOLVER_REVISION is the content hash of src/resolve-instance.ts + src/approved-roots.ts", () => {
    const a = fs
      .readFileSync(path.join(REPO_ROOT, "src", "resolve-instance.ts"), "utf-8")
      .replace(/RESOLVER_REVISION = "[0-9a-f]*"/, 'RESOLVER_REVISION = ""');
    const b = fs.readFileSync(path.join(REPO_ROOT, "src", "approved-roots.ts"), "utf-8");
    const want = crypto.createHash("sha256").update(a).update("\0").update(b).digest("hex").slice(0, 12);
    expect(R.RESOLVER_REVISION, `the resolver changed: set RESOLVER_REVISION = "${want}" in src/resolve-instance.ts`).toBe(want);
  });
  it("`relay where --json` reports it", () => {
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "relay"), "where", "--json"], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", HOME: A },
    });
    expect(JSON.parse(r.stdout).resolver_revision).toBe(R.RESOLVER_REVISION);
  });
  // The HTTP daemon's /health carries it too: measured over HTTP in tests/http.test.ts.
});

describe("ADR-0048 PR D (5) — Windows is an EXPLICIT branch: labeled, never a crash, never a silent pass", () => {
  it("POSIX: containment \"strict\"", () => {
    process.env.HOME = A;
    expect(R.resolveInstance()).toMatchObject({ containment: "strict" });
  });
  it("no uid (process.getuid undefined, as on win32): containment \"roots-only\", no crash", () => {
    process.env.HOME = A;
    const getuid = process.getuid;
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true, writable: true });
    try {
      const r = R.resolveInstance();
      expect(r).toMatchObject({ kind: "instance", id: "ia", containment: "roots-only" });
      expect(R.serializeResolution(r)).toMatchObject({ containment: "roots-only" });
    } finally {
      Object.defineProperty(process, "getuid", { value: getuid, configurable: true, writable: true });
    }
  });
});
