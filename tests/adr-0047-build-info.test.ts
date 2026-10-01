// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0047 PR 1: a process reports the build it LOADED AT START, never the one on
 * disk. The identity covers exactly what a long-lived process loads at start:
 *   CODE ID  package.json + dist/** (stamped by the build step; the stamp enters
 *            as one constant entry and must be byte-identical to its template);
 *   DEPS ID  npm's installed-tree record (node_modules/.package-lock.json) plus
 *            every native addon under node_modules, snapshotted by the process
 *            when it starts (the entry's FIRST import).
 * hooks/*.sh and bin/relay run fresh per call: OUT.
 *
 * checkInstall() recomputes an install from its CONTENT, observed twice.
 * Runs against the worktree's built dist/ (CI builds first). Scratch installs are
 * copies under the temp dir; the dev tree is never built or touched.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO_ROOT, "dist");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adr0047-pr1-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const { computeCodeId, checkInstall, parseStamp, renderStamp } = await import("../dist/build-id.js");
const { computeDepsId } = await import("../dist/deps-snapshot.js");
const { BUILD_INFO: DIST_STAMP } = await import("../dist/build-info.js");
const STAMP_TEXT = fs.readFileSync(path.join(DIST, "build-info.js"), "utf-8");

/**
 * A scratch INSTALL: a copy of dist/, package.json, hooks/ and bin/. Its
 * node_modules holds a real copy of npm's installed-tree record and one SYMLINK per
 * top-level package of the repo's, except the packages in `realCopies`, which are
 * copied so a test can change them.
 */
function scratchInstall(tag: string, opts: { realCopies?: string[] } = {}): string {
  const dir = path.join(ROOT, tag);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  for (const p of ["dist", "hooks", "bin"]) fs.cpSync(path.join(REPO_ROOT, p), path.join(dir, p), { recursive: true, verbatimSymlinks: true });
  fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(dir, "package.json"));
  const nm = path.join(REPO_ROOT, "node_modules");
  const real = new Set(opts.realCopies ?? []);
  fs.copyFileSync(path.join(nm, ".package-lock.json"), path.join(dir, "node_modules", ".package-lock.json"));
  for (const top of fs.readdirSync(nm)) {
    if (top.startsWith(".")) continue;
    const entries = top.startsWith("@") ? fs.readdirSync(path.join(nm, top)).map((s) => `${top}/${s}`) : [top];
    for (const name of entries) {
      fs.mkdirSync(path.dirname(path.join(dir, "node_modules", name)), { recursive: true });
      if (real.has(name)) fs.cpSync(path.join(nm, name), path.join(dir, "node_modules", name), { recursive: true, verbatimSymlinks: true });
      else fs.symlinkSync(path.join(nm, name), path.join(dir, "node_modules", name));
    }
  }
  return dir;
}

/** Rewrite a stamp's build_id on DISK, keeping the exact template (what a later build would write). */
function overwriteStampOnDisk(install: string, buildId: string): void {
  const f = path.join(install, "dist", "build-info.js");
  const parsed = parseStamp(fs.readFileSync(f, "utf-8"));
  expect(parsed.ok).toBe(true);
  fs.writeFileSync(f, renderStamp({ ...parsed.info, build_id: buildId }));
}

/** A stdio connector started from `install`, with an isolated DB/config/HOME. */
async function connectorFrom(install: string, tag: string) {
  const tmp = path.join(ROOT, `conn-${tag}`);
  fs.mkdirSync(tmp, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(install, "dist", "index.js")],
    env: { PATH: process.env.PATH ?? "", HOME: tmp, RELAY_DB_PATH: path.join(tmp, "relay.db"), RELAY_CONFIG_PATH: path.join(tmp, "none.json"), RELAY_TRANSPORT: "stdio", RELAY_SKIP_TTY_CHECK: "1" },
    stderr: "pipe",
  });
  const client = new Client({ name: "adr0047-test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    health: async () => {
      const r = (await client.callTool({ name: "health_check", arguments: {} })) as { content: Array<{ text: string }> };
      return JSON.parse(r.content[0].text) as { build: Record<string, unknown> };
    },
    close: () => client.close(),
  };
}

/** What an `npm install`/`update` does to the installed-tree record (a new byte content). */
const touchRecord = (install: string) => {
  const f = path.join(install, "node_modules", ".package-lock.json");
  const j = JSON.parse(fs.readFileSync(f, "utf-8"));
  j.name = `${j.name}-reinstalled`;
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
};
const depsIdOf = (install: string) => (computeDepsId(install) as { state: string; id: string }).id;

describe("ADR-0047 PR 1 — the build stamp: the CODE ID, written by the build step", () => {
  it("dist/build-info.js is byte-identical to its template, and its build_id EQUALS the recomputed code id", () => {
    const p = parseStamp(STAMP_TEXT);
    expect(p.ok).toBe(true);
    expect(DIST_STAMP.build_id).toMatch(/^[0-9a-f]{64}$/);
    expect(computeCodeId(REPO_ROOT)).toEqual({ ok: true, id: DIST_STAMP.build_id });
  });
  it("commit / dirty / built_at are for humans: a 40-hex commit (or null), a boolean (or null), an ISO time", () => {
    expect(DIST_STAMP.commit === null || /^[0-9a-f]{40}$/.test(DIST_STAMP.commit)).toBe(true);
    expect(DIST_STAMP.dirty === null || typeof DIST_STAMP.dirty === "boolean").toBe(true);
    expect(Number.isNaN(Date.parse(DIST_STAMP.built_at))).toBe(false);
  });
  it("TWIN: the freshly built worktree is CONSISTENT", () => {
    expect(checkInstall(REPO_ROOT)).toMatchObject({ consistent: true, stamped: DIST_STAMP.build_id, content: DIST_STAMP.build_id });
  });
});

describe("ADR-0047 PR 1 — the spec's mutation: the disk changes after the connector started; it still reports what it LOADED", () => {
  it("a running stdio connector keeps its loaded build_id AND deps_id; a NEW connector from the same install reads the new ones", async () => {
    const install = scratchInstall("ondisk");
    const a = await connectorFrom(install, "a");
    try {
      const before = (await a.health()).build;
      expect(before.build_id).toBe(DIST_STAMP.build_id);
      expect(before.deps_id).toBe(depsIdOf(install));
      expect(before.deps_state).toBe("known");
      expect(before.node).toBe(process.version);
      overwriteStampOnDisk(install, "f".repeat(64));
      touchRecord(install);
      const after = (await a.health()).build;
      expect(after.build_id, "the running connector re-read the stamp").toBe(DIST_STAMP.build_id);
      expect(after.deps_id, "the running connector re-read its dependencies").toBe(before.deps_id);
      const b = await connectorFrom(install, "b");
      try {
        const fresh = (await b.health()).build;
        expect(fresh.build_id, "a new process loads what is on disk now").toBe("f".repeat(64));
        expect(fresh.deps_id).not.toBe(before.deps_id);
      } finally {
        await b.close();
      }
    } finally {
      await a.close();
    }
  }, 90_000);
});

describe("ADR-0047 PR 1 — the deps snapshot is EAGER: taken at start, not on first access", () => {
  it("node_modules changes AFTER start, THEN the FIRST health_check: it reports the PRE-change deps id", async () => {
    const install = scratchInstall("eager");
    const pre = depsIdOf(install);
    const a = await connectorFrom(install, "eager");
    try {
      touchRecord(install);
      expect(depsIdOf(install)).not.toBe(pre);
      const first = (await a.health()).build;
      expect(first.deps_id, "a lazy digest would report the post-change id as loaded (a false CURRENT)").toBe(pre);
    } finally {
      await a.close();
    }
  }, 60_000);
});

describe("ADR-0047 PR 1 — P1-a: the boundary. IN: dist/** and package.json. OUT: hooks and bin/relay (they run fresh per call)", () => {
  const code = (install: string) => (computeCodeId(install) as { id: string }).id;
  it("a HOOK-only change and a bin/relay-only change leave the code id alone: still CONSISTENT (connectors stay CURRENT)", () => {
    const install = scratchInstall("hook-only");
    const before = code(install);
    fs.appendFileSync(path.join(install, "hooks", "check-relay.sh"), "\n# changed\n");
    fs.appendFileSync(path.join(install, "bin", "relay"), "\n// changed\n");
    expect(code(install)).toBe(before);
    expect(checkInstall(install).consistent).toBe(true);
  });
  it("a dist/ change moves the code id (a connector that loaded the old one is STALE); the stamp no longer matches", () => {
    const install = scratchInstall("dist-change");
    fs.appendFileSync(path.join(install, "dist", "server.js"), "\n");
    expect(code(install)).not.toBe(DIST_STAMP.build_id);
    expect(checkInstall(install)).toMatchObject({ consistent: false, stamped: DIST_STAMP.build_id });
  });
  it("a package.json change moves the code id too", () => {
    const install = scratchInstall("pkg-change");
    fs.appendFileSync(path.join(install, "package.json"), "\n");
    expect(code(install)).not.toBe(DIST_STAMP.build_id);
    expect(checkInstall(install).consistent).toBe(false);
  });
});

describe("ADR-0047 PR 1 — the DEPS ID: npm's installed-tree record + EVERY native addon under node_modules", () => {
  const deps = (install: string) => computeDepsId(install) as { state: string; id?: string; reason?: string };
  it("an install, update or removal (npm rewrites .package-lock.json) changes the deps id", () => {
    const install = scratchInstall("dep-record");
    const before = depsIdOf(install);
    touchRecord(install);
    expect(depsIdOf(install)).not.toBe(before);
  });
  it("a NATIVE ADDON rebuilt with no record change (npm rebuild) changes the deps id", () => {
    const install = scratchInstall("dep-native", { realCopies: ["better-sqlite3"] });
    const before = depsIdOf(install);
    const addon = spawnSync("find", [path.join(install, "node_modules", "better-sqlite3"), "-name", "*.node"], { encoding: "utf-8" }).stdout.trim().split("\n")[0];
    expect(addon, "better-sqlite3 ships a native addon").toMatch(/\.node$/);
    fs.appendFileSync(addon, Buffer.from([0]));
    expect(depsIdOf(install)).not.toBe(before);
  });
  it("EVERY addon counts, not only those a closure reaches: one added to any package (a peer, a dev package) changes it", () => {
    const install = scratchInstall("dep-any-addon", { realCopies: ["uuid"] });
    const before = depsIdOf(install);
    fs.writeFileSync(path.join(install, "node_modules", "uuid", "extra.node"), "x");
    expect(depsIdOf(install)).not.toBe(before);
  });
  it("a SYMLINKED addon is followed: its target's bytes count", () => {
    const install = scratchInstall("dep-sym-addon", { realCopies: ["uuid"] });
    const target = path.join(ROOT, "addon-target.bin");
    fs.writeFileSync(target, "one");
    fs.symlinkSync(target, path.join(install, "node_modules", "uuid", "linked.node"));
    const before = depsIdOf(install);
    fs.writeFileSync(target, "two");
    expect(depsIdOf(install)).not.toBe(before);
  });
  it("a symlink CYCLE under node_modules → INCONSISTENT (never a silent pass)", () => {
    const install = scratchInstall("dep-cycle", { realCopies: ["uuid"] });
    fs.symlinkSync(path.join(install, "node_modules"), path.join(install, "node_modules", "uuid", "loop"));
    expect(deps(install).state).toBe("error");
    const c = checkInstall(install);
    expect(c.consistent).toBe(false);
    expect(c.reason).toMatch(/cycle/);
  });
  it("a DANGLING symlink under node_modules → INCONSISTENT", () => {
    const install = scratchInstall("dep-dangling", { realCopies: ["uuid"] });
    fs.symlinkSync(path.join(ROOT, "nowhere"), path.join(install, "node_modules", "uuid", "gone"));
    expect(checkInstall(install).consistent).toBe(false);
  });
  it("NO .package-lock.json (yarn, pnpm, a copied tree) → UNKNOWN, never a known id", () => {
    const install = scratchInstall("dep-unknown");
    fs.rmSync(path.join(install, "node_modules", ".package-lock.json"));
    expect(deps(install).state).toBe("unknown");
    const c = checkInstall(install);
    expect(c).toMatchObject({ deps: null, deps_state: "unknown" });
    expect(c.reason).toMatch(/only npm installs are supported/);
  });
  it("#8: a record that is JSON null (or not an object) → INCONSISTENT, and a connector still STARTS (deps_state error)", async () => {
    const install = scratchInstall("dep-null");
    fs.writeFileSync(path.join(install, "node_modules", ".package-lock.json"), "null");
    expect(deps(install).state).toBe("error");
    expect(checkInstall(install).consistent).toBe(false);
    fs.writeFileSync(path.join(install, "node_modules", ".package-lock.json"), "[1]");
    expect(deps(install).state).toBe("error");
    fs.writeFileSync(path.join(install, "node_modules", ".package-lock.json"), "null");
    const a = await connectorFrom(install, "null-record");
    try {
      expect((await a.health()).build).toMatchObject({ deps_id: null, deps_state: "error" });
    } finally {
      await a.close();
    }
  }, 60_000);
  it("the project lockfile (package-lock.json) is not read: changing or deleting it changes nothing", () => {
    const install = scratchInstall("no-lock");
    const before = depsIdOf(install);
    fs.writeFileSync(path.join(install, "package-lock.json"), "{}");
    expect(depsIdOf(install)).toBe(before);
    fs.rmSync(path.join(install, "package-lock.json"));
    expect(depsIdOf(install)).toBe(before);
  });
});

describe("ADR-0047 PR 1 — P2-c: the stamp must be BYTE-IDENTICAL to its template", () => {
  let n = 0;
  const refused = (text: string) => {
    const install = scratchInstall(`stamp-${n++}`);
    fs.writeFileSync(path.join(install, "dist", "build-info.js"), text);
    const c = checkInstall(install);
    expect(c.consistent, text).toBe(false);
    expect(c.reason).toMatch(/stamp is refused/);
  };
  it("Codex's case: a comment naming the matching id, then an export of 'unbuilt' → refused", () => {
    refused(`// previous build_id: "${DIST_STAMP.build_id}"\nexport const BUILD_INFO = Object.freeze({"build_id":"unbuilt","commit":null,"dirty":null,"built_at":null});\n`);
  });
  it("a TRUNCATED stamp → refused", () => refused(STAMP_TEXT.slice(0, 80)));
  it("extra executable code before the stamp → refused", () => refused(`globalThis.x = 1;\n${STAMP_TEXT}`));
  it("extra executable code after the stamp → refused", () => refused(`${STAMP_TEXT}globalThis.x = 1;\n`));
  it("the same values spelled differently (a space in the JSON) → refused: byte-identical, not equivalent", () => {
    refused(STAMP_TEXT.replace('{"build_id":', '{"build_id": '));
  });
  it("the fields reordered → refused", () => {
    const i = (parseStamp(STAMP_TEXT) as { info: Record<string, unknown> }).info;
    refused(`export const BUILD_INFO = Object.freeze(${JSON.stringify({ commit: i.commit, build_id: i.build_id, dirty: i.dirty, built_at: i.built_at })});\n`);
  });
  it("the tsc-only rebuild MUTATION: tsc re-emits the placeholder over the stamp → refused, INCONSISTENT, never current", () => {
    const install = scratchInstall("tsc-only");
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", REPO_ROOT, "--outDir", path.join(install, "dist")], { encoding: "utf-8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const c = checkInstall(install);
    expect(c.consistent, JSON.stringify(c)).toBe(false);
    expect(c.reason).toMatch(/rebuild with npm run build/);
  }, 120_000);
  it("an identical-output rebuild is NOT a deploy: re-stamping unchanged content gives the SAME build_id", () => {
    const install = scratchInstall("restamp");
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "write-build-info.mjs"), install], { encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(checkInstall(install)).toMatchObject({ consistent: true, stamped: DIST_STAMP.build_id });
  });
  it("no stamp at all → INCONSISTENT", () => {
    const install = scratchInstall("no-stamp");
    fs.rmSync(path.join(install, "dist", "build-info.js"));
    expect(checkInstall(install).consistent).toBe(false);
  });
});

describe("ADR-0047 PR 1 — P2-d: observed twice, the same answer required", () => {
  it("an install that changes BETWEEN the two observations (a compile racing the check) is inconsistent", () => {
    const install = scratchInstall("race");
    let calls = 0;
    const c = checkInstall(install, {
      afterFirstObservation: () => {
        calls++;
        fs.appendFileSync(path.join(install, "dist", "server.js"), "\n");
      },
    });
    expect(calls).toBe(1);
    expect(c.consistent).toBe(false);
    expect(c.reason).toMatch(/changed while it was being checked/);
  });
});

describe("ADR-0047 PR 1 — the code id: what is and is not in the hash", () => {
  function tree(tag: string, files: Record<string, string>): string {
    const d = path.join(ROOT, "tree-" + tag);
    fs.rmSync(d, { recursive: true, force: true });
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
      fs.writeFileSync(path.join(d, rel), body);
    }
    return d;
  }
  const base = { "package.json": "{}", "dist/a.js": "A", "dist/sub/b.js": "B" };
  const id = (files: Record<string, string>, tag: string) => computeCodeId(tree(tag, files));
  it("deterministic: the same files give the same id", () => expect(id(base, "d1")).toEqual(id(base, "d2")));
  it("a file's PATH is in the hash (a rename changes it)", () => {
    expect(id(base, "p1")).not.toEqual(id({ "package.json": "{}", "dist/a2.js": "A", "dist/sub/b.js": "B" }, "p2"));
  });
  it("the stamp's content is NOT (it enters as one constant: the id cannot hash itself)", () => {
    expect(id(base, "s1")).toEqual(id({ ...base, "dist/build-info.js": "anything" }, "s2"));
  });
  it("a symlink inside dist/ is refused, never followed", () => {
    const d = tree("sym", base);
    fs.symlinkSync("/etc/hosts", path.join(d, "dist", "link.js"));
    expect(computeCodeId(d)).toMatchObject({ ok: false });
  });
});

describe("ADR-0047 PR 1 — TRIPWIRES: the loaded value is never re-read or recomputed", () => {
  const src = (f: string) => fs.readFileSync(path.join(REPO_ROOT, "src", f), "utf-8");
  it("src/build-info.ts imports NOTHING (a literal: no fs, no git, no package.json)", () => {
    expect(src("build-info.ts")).not.toMatch(/^\s*import\s/m);
  });
  it("dist/index.js imports the deps snapshot FIRST (ESM evaluates in source order: nothing is loaded before it)", () => {
    const imports = fs.readFileSync(path.join(DIST, "index.js"), "utf-8").split("\n").filter((l) => /^\s*import[\s{"']/.test(l));
    expect(imports[0], imports.slice(0, 3).join("\n")).toMatch(/^import\s+["']\.\/deps-snapshot\.js["'];?$/);
  });
  it("dist/deps-snapshot.js imports only node: builtins", () => {
    const specs = [...fs.readFileSync(path.join(DIST, "deps-snapshot.js"), "utf-8").matchAll(/^\s*import[^'"]*["']([^'"]+)["']/gm)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((x) => !x.startsWith("node:"))).toEqual([]);
  });
  it("src/loaded-build.ts never recomputes the CODE id (only the stamp names it)", () => {
    expect(src("loaded-build.ts")).not.toMatch(/computeCodeId|checkInstall/);
  });
  for (const f of ["tools/status.ts", "transport/http.ts"]) {
    it(`${f} reports LOADED_BUILD from the static import and never imports build-id`, () => {
      expect(src(f)).toMatch(/import\s*\{[^}]*\bLOADED_BUILD\b[^}]*\}\s*from\s*"\.\.\/loaded-build\.js"/);
      expect(src(f)).not.toMatch(/build-id\.js/);
    });
  }
  it("cli/where.ts takes LOADED_BUILD only for --json (a one-shot process: still its load), never build-id; --fields, on every hook's path, does not pay for it", () => {
    expect(src("cli/where.ts")).toMatch(/const\s*\{\s*LOADED_BUILD\s*\}\s*=\s*await import\("\.\.\/loaded-build\.js"\)/);
    expect(src("cli/where.ts")).not.toMatch(/^import[^\n]*loaded-build/m);
    expect(src("cli/where.ts")).not.toMatch(/build-id\.js/);
  });
});

describe("ADR-0047 PR 1 — where it shows: /health, health_check, whoami, relay where --json", () => {
  it("`relay where --json` carries build: the CLI's own loaded stamp, deps id and node", () => {
    const home = path.join(ROOT, "where-home");
    fs.mkdirSync(home, { recursive: true });
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "relay"), "where", "--json"], { encoding: "utf-8", env: { PATH: process.env.PATH ?? "", HOME: home } });
    const b = JSON.parse(r.stdout).build;
    expect(b).toMatchObject({ ...DIST_STAMP, node: process.version, deps_state: "known" });
    expect(b.deps_id).toBe(depsIdOf(REPO_ROOT));
  });
});
