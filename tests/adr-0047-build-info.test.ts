// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0047 PR 1: a process reports the build it LOADED, never the one on disk.
 *
 * - `npm run build` stamps dist/build-info.js with a CONTENT HASH of dist/ (every
 *   file but the stamp; the dependency lock's digest is itself a dist file,
 *   dist/.build-lock), plus commit, dirty and built_at for humans.
 * - Every reporter (/health, health_check, whoami, `relay where --json`) imports
 *   that stamp statically: fixed at load, never re-read.
 * - checkInstall() recomputes "installed" from an install's CONTENT: a stamp that
 *   does not match it (a tsc-only rebuild, a hand edit, a lock changed without a
 *   rebuild) is INCONSISTENT.
 *
 * Runs against the worktree's built dist/ (CI builds first). Scratch installs are
 * copies under the temp dir; the dev tree is never built or touched.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO_ROOT, "dist");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adr0047-pr1-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const { computeBuildId, checkInstall, lockDigest } = await import("../dist/build-id.js");
const { BUILD_INFO: DIST_STAMP } = await import("../dist/build-info.js");
const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

/** A scratch INSTALL: a copy of dist/, package.json and the lock, with node_modules linked. */
function scratchInstall(tag: string, opts: { lock?: boolean } = {}): string {
  const dir = path.join(ROOT, tag);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(DIST, path.join(dir, "dist"), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(dir, "package.json"));
  if (opts.lock !== false) fs.copyFileSync(path.join(REPO_ROOT, "package-lock.json"), path.join(dir, "package-lock.json"));
  fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(dir, "node_modules"));
  return dir;
}

/** Rewrite a stamp's build_id on DISK (what a later build would do to the file). */
function overwriteStampOnDisk(install: string, buildId: string): void {
  const f = path.join(install, "dist", "build-info.js");
  const src = fs.readFileSync(f, "utf-8");
  const next = src.replace(/"build_id":\s*"[^"]*"/, `"build_id":"${buildId}"`);
  expect(next, "the stamp file carries a build_id to rewrite").not.toBe(src);
  fs.writeFileSync(f, next);
}

/** A stdio connector started from `install`, with an isolated DB/config/HOME. */
async function connectorFrom(install: string, tag: string): Promise<{ health: () => Promise<Record<string, any>>; close: () => Promise<void> }> {
  const tmp = path.join(ROOT, `conn-${tag}`);
  fs.mkdirSync(tmp, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(install, "dist", "index.js")],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: tmp,
      RELAY_DB_PATH: path.join(tmp, "relay.db"),
      RELAY_CONFIG_PATH: path.join(tmp, "no-config.json"),
      RELAY_TRANSPORT: "stdio",
      RELAY_SKIP_TTY_CHECK: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "adr0047-test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    health: async () => {
      const r = (await client.callTool({ name: "health_check", arguments: {} })) as { content: Array<{ text: string }> };
      return JSON.parse(r.content[0].text);
    },
    close: () => client.close(),
  };
}

describe("ADR-0047 PR 1 — the build stamp: a content hash of dist/, written by the build step", () => {
  it("dist/build-info.js carries a 64-hex build_id EQUAL to the recomputed content hash of dist/", () => {
    expect(DIST_STAMP.build_id).toMatch(/^[0-9a-f]{64}$/);
    const re = computeBuildId(DIST);
    expect(re).toEqual({ ok: true, build_id: DIST_STAMP.build_id });
  });
  it("commit / dirty / built_at are for humans: a 40-hex commit (or null), a boolean (or null), an ISO time", () => {
    expect(DIST_STAMP.commit === null || /^[0-9a-f]{40}$/.test(DIST_STAMP.commit)).toBe(true);
    expect(DIST_STAMP.dirty === null || typeof DIST_STAMP.dirty === "boolean").toBe(true);
    expect(Number.isNaN(Date.parse(DIST_STAMP.built_at))).toBe(false);
  });
  it("dist/.build-lock is the sha256 of the lock the build used (so the lock is INSIDE the content hash)", () => {
    expect(fs.readFileSync(path.join(DIST, ".build-lock"), "utf-8").trim()).toBe(sha256(fs.readFileSync(path.join(REPO_ROOT, "package-lock.json"))));
    expect(lockDigest(REPO_ROOT)).toBe(sha256(fs.readFileSync(path.join(REPO_ROOT, "package-lock.json"))));
  });
  it("TWIN: the freshly built worktree is CONSISTENT", () => {
    expect(checkInstall(REPO_ROOT)).toMatchObject({ consistent: true, stamped: DIST_STAMP.build_id, content: DIST_STAMP.build_id });
  });
});

describe("ADR-0047 PR 1 — the spec's mutation: the ON-DISK stamp changes after the connector started; it still reports what it LOADED", () => {
  it("a running stdio connector keeps its loaded build_id; a NEW connector from the same install reads the new one", async () => {
    const install = scratchInstall("ondisk");
    const loaded = computeBuildId(path.join(install, "dist"));
    const a = await connectorFrom(install, "a");
    try {
      expect((await a.health()).build.build_id).toBe(DIST_STAMP.build_id);
      overwriteStampOnDisk(install, "f".repeat(64));
      expect((await a.health()).build.build_id, "the running connector re-read the disk").toBe(DIST_STAMP.build_id);
      const b = await connectorFrom(install, "b");
      try {
        expect((await b.health()).build.build_id, "a new process loads what is on disk now").toBe("f".repeat(64));
      } finally {
        await b.close();
      }
    } finally {
      await a.close();
    }
    expect(loaded.ok).toBe(true);
  }, 60_000);
});

describe("ADR-0047 PR 1 — checkInstall: the stamp against the install's CONTENT (never the stamp against itself)", () => {
  it("MUTATION: a tsc-only rebuild after the stamp is INCONSISTENT (the placeholder is never a build)", () => {
    const install = scratchInstall("tsc-only");
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", REPO_ROOT, "--outDir", path.join(install, "dist")], { encoding: "utf-8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const c = checkInstall(install);
    expect(c.consistent, JSON.stringify(c)).toBe(false);
    expect(c.stamped).toBe("unbuilt");
    expect(c.reason).toMatch(/rebuild with npm run build/);
  }, 120_000);
  it("dist content edited after the stamp (one byte) → INCONSISTENT, naming both hashes", () => {
    const install = scratchInstall("edited");
    fs.appendFileSync(path.join(install, "dist", "server.js"), "\n");
    const c = checkInstall(install);
    expect(c.consistent).toBe(false);
    expect(c.stamped).toBe(DIST_STAMP.build_id);
    expect(c.content).not.toBe(DIST_STAMP.build_id);
  });
  it("the dependency lock changed without a rebuild → INCONSISTENT, naming the lock", () => {
    const install = scratchInstall("lock-drift");
    fs.appendFileSync(path.join(install, "package-lock.json"), "\n");
    const c = checkInstall(install);
    expect(c.consistent).toBe(false);
    expect(c.reason).toMatch(/package-lock\.json/);
  });
  it("TWIN: the lock changed, then the build step re-stamped → CONSISTENT again (the NEW lock is recorded)", () => {
    const install = scratchInstall("lock-rebuilt");
    fs.appendFileSync(path.join(install, "package-lock.json"), "\n");
    expect(checkInstall(install).consistent).toBe(false);
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "write-build-info.mjs"), install], { encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(path.join(install, "dist", ".build-lock"), "utf-8").trim()).toBe(sha256(fs.readFileSync(path.join(install, "package-lock.json"))));
    expect(checkInstall(install)).toMatchObject({ consistent: true });
  });
  it("an install that ships NO lock (the npm-registry shape) is checked on content alone: CONSISTENT", () => {
    expect(checkInstall(scratchInstall("no-lock", { lock: false }))).toMatchObject({ consistent: true });
  });
  it("an identical-output rebuild is NOT a deploy: re-stamping unchanged content gives the SAME build_id", () => {
    const install = scratchInstall("restamp");
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "write-build-info.mjs"), install], { encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    const c = checkInstall(install);
    expect(c).toMatchObject({ consistent: true, stamped: DIST_STAMP.build_id });
  });
  it("an install with no stamp at all is INCONSISTENT (never assumed current)", () => {
    const install = scratchInstall("no-stamp");
    fs.rmSync(path.join(install, "dist", "build-info.js"));
    expect(checkInstall(install).consistent).toBe(false);
  });
});

describe("ADR-0047 PR 1 — computeBuildId: what is and is not in the hash", () => {
  function tree(tag: string, files: Record<string, string>): string {
    const d = path.join(ROOT, "tree-" + tag, "dist");
    fs.rmSync(path.dirname(d), { recursive: true, force: true });
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
      fs.writeFileSync(path.join(d, rel), body);
    }
    return d;
  }
  const base = { "a.js": "A", "sub/b.js": "B", ".build-lock": "L" };
  const id = (files: Record<string, string>, tag: string) => computeBuildId(tree(tag, files));
  it("deterministic: the same files give the same id", () => {
    expect(id(base, "d1")).toEqual(id(base, "d2"));
  });
  it("a file's PATH is in the hash (a rename changes it)", () => {
    expect(id({ ...base }, "p1")).not.toEqual(id({ "a2.js": "A", "sub/b.js": "B", ".build-lock": "L" }, "p2"));
  });
  it("the lock digest (.build-lock) is in the hash", () => {
    expect(id(base, "l1")).not.toEqual(id({ ...base, ".build-lock": "M" }, "l2"));
  });
  it("the stamp files (build-info.*) are NOT in the hash (a stamp cannot hash itself)", () => {
    expect(id(base, "s1")).toEqual(id({ ...base, "build-info.js": "x", "build-info.d.ts": "y", "build-info.js.map": "z" }, "s2"));
  });
  it("a symlink inside dist/ is refused (content it does not own), never followed", () => {
    const d = tree("sym", base);
    fs.symlinkSync("/etc/hosts", path.join(d, "link.js"));
    expect(computeBuildId(d)).toMatchObject({ ok: false });
  });
});

describe("ADR-0047 PR 1 — TRIPWIRES: the loaded value is never re-read or recomputed", () => {
  const src = (f: string) => fs.readFileSync(path.join(REPO_ROOT, "src", f), "utf-8");
  it("src/build-info.ts imports NOTHING (a literal: no fs, no git, no package.json)", () => {
    expect(src("build-info.ts")).not.toMatch(/^\s*import\s/m);
  });
  for (const f of ["tools/status.ts", "transport/http.ts", "cli/where.ts"]) {
    it(`${f} reports BUILD_INFO from the static import and never imports the recompute (build-id)`, () => {
      expect(src(f)).toMatch(/import\s*\{[^}]*\bBUILD_INFO\b[^}]*\}\s*from\s*"\.\.\/build-info\.js"/);
      expect(src(f)).not.toMatch(/build-id\.js/);
    });
  }
});

describe("ADR-0047 PR 1 — where it shows: /health, health_check, whoami, relay where --json", () => {
  it("`relay where --json` carries build (the CLI's own loaded stamp)", () => {
    const home = path.join(ROOT, "where-home");
    fs.mkdirSync(home, { recursive: true });
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "relay"), "where", "--json"], { encoding: "utf-8", env: { PATH: process.env.PATH ?? "", HOME: home } });
    expect(JSON.parse(r.stdout).build).toEqual(DIST_STAMP);
  });
});
