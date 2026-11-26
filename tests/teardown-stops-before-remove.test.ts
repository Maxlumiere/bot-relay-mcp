// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * TEARDOWN ORDER: a child that writes into a directory is STOPPED, its exit awaited, before that directory is removed.
 * A signal is asynchronous and a relay daemon's SIGTERM handler closes its DB, so `kill()` followed at once by
 * `rmSync()` races a child still writing there (its DB, the WAL and -shm side files, its owner endpoint record).
 *
 * RULE 1 (teardown bodies): in a test file that spawns a relay entry (dist/index.js) or a SQLite writer, every
 * after-hook, `finally` block and function or arrow body (a helper's `kill()` closure included; `describe` callbacks
 * excluded) that kills a child and THEN recursively removes a directory must stop through `stopAndRemove`
 * (tests/_helpers/stop-and-remove.ts), or await the child's exit between the kill and the removal. A removal BEFORE
 * any kill (setting a directory up) is not a teardown and is not flagged. The innermost such body is the one named.
 * RULE 2 (helpers): a helper function that spawns a relay entry or a SQLite writer must RETURN the spawned child (a
 * handle `stopAndRemove` can take), so a kill and a removal can never be split by a helper that hides the child.
 *
 * EXEMPT, by name, with the reason: a file whose relay-looking entry is a FAKE that writes nothing (EXEMPT below).
 * REMAINING BLIND SPOT (stated): a kill and a removal in DIFFERENT bodies (a kill in one test or helper, the removal
 * in another) with nothing shared between them, which RULE 2 narrows by keeping every spawned writer's handle
 * returnable; an entry path assembled at run time from parts this scan cannot read; and a removal through a helper
 * whose name does not say so (rmSync / rm with `recursive`).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files whose relay-looking entry is a fake that writes nothing, with the reason. */
export const EXEMPT: Record<string, string> = {
  "tests/adr-0047-fleet-verdicts.test.ts": "its children run a fake dist/index.js that only sleeps (setInterval); they write nothing",
};

/** Does this source spawn a relay entry or a SQLite writer? */
export function spawnsWriter(src: string): boolean {
  return /\bspawn(Sync)?\(/.test(src) && /(DIST_INDEX|\bENTRY\b|dist\/index\.js|["']dist["'],\s*["']index\.js["']|better-sqlite3)/.test(src);
}

/** The `{…}` body that starts at `open` (brace matching; strings and comments are not special-cased). */
function bodyAt(src: string, open: number): string {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(open, j + 1);
  }
  return src.slice(open);
}

const KILL = /\.kill\(|process\.kill\(/;
const RM = /\brmSync\([^)]*recursive|\brm\([^)]*recursive/;
const AWAITED_EXIT = /await[^;]*?(once\(\s*["'](exit|close)["']|\.out\b|waitExit|awaitExit|waitForExit|stopDaemon|stopAll|\bexited\b)/;

/** This guard's own file holds fixture SOURCE TEXT (strings that look like teardowns): never scanned. */
const SELF = "tests/teardown-stops-before-remove.test.ts";
/** A body opener: an arrow, a function, a `finally`, an after-hook. */
const OPENER = /=>\s*\{|\)\s*(?::\s*[^{=;]+)?\{|\bfinally\s*\{|\bafter(?:Each|All)\s*\([^{]*\{/g;

/** RULE 1: every innermost body (file:line) that kills a child and THEN removes a dir without awaiting the exit between. */
export function teardownViolations(files: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [file, src] of files) {
    if (file === SELF || EXEMPT[file] || !spawnsWriter(src)) continue;
    const spans: Array<[number, number]> = [];
    for (const m of src.matchAll(OPENER)) {
      const open = m.index! + m[0].length - 1;
      // A describe callback groups tests; its own kill and removal belong to different tests, judged there.
      const before = src.slice(Math.max(0, m.index! - 400), m.index!).replace(/\s+$/, "");
      if (/\bdescribe(?:\.\w+)*(?:\([^()]*\))?\(\s*(?:"[^"]*"|'[^']*'|`[^`]*`)\s*,\s*(?:async\s*)?\(\)\s*$/.test(before)) continue;
      const body = bodyAt(src, open);
      if (/\bstopAndRemove\(/.test(body)) continue;
      const k = body.search(KILL);
      if (k < 0) continue;
      const r = body.slice(k).search(RM); // a removal AFTER the kill (one before it is a setup, not a teardown)
      if (r < 0) continue;
      // An awaited exit anywhere BEFORE that removal (it may wrap the kill: await new Promise(… once("exit") … kill …)).
      const w = body.search(AWAITED_EXIT);
      if (w >= 0 && w < k + r) continue;
      spans.push([open, open + body.length]);
    }
    for (const [a, b] of spans) {
      if (spans.some(([c, d]) => (c !== a || d !== b) && a <= c && d <= b)) continue; // not the innermost
      out.push(`${file}:${src.slice(0, a).split("\n").length}`);
    }
  }
  return out.sort();
}

/** RULE 2: every helper (file:name) that spawns a relay entry or a SQLite writer without RETURNING the child. */
export function helperViolations(files: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  const HELPER = /(?:async\s+)?function\s+(\w+)\s*\([^)]*\)[^{]*\{|const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+?)?=>\s*\{/g;
  const WRITER_SPAWN = /(?:const|let)\s+(\w+)\s*=\s*(?:\w+\.)?spawn\(\s*[^,]+,\s*\[[^\]]*(DIST_INDEX|\bENTRY\b|dist\/index\.js|["']dist["'],\s*["']index\.js["'])/;
  for (const [file, src] of files) {
    if (file === SELF || EXEMPT[file]) continue;
    for (const m of src.matchAll(HELPER)) {
      const name = m[1] ?? m[2]!;
      const body = bodyAt(src, m.index! + m[0].length - 1);
      if (!/\bspawn\(/.test(body) || !(WRITER_SPAWN.test(body) || /\bspawn\([^)]*(DIST_INDEX|\bENTRY\b)/.test(body))) continue;
      const held = WRITER_SPAWN.exec(body);
      if (!held || !new RegExp(`\\breturn\\b[^;]*\\b${held[1]}\\b`).test(body)) out.push(`${file}:${name}`);
    }
  }
  return out.sort();
}

function testFiles(): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(path.join(REPO, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.ts$/.test(e.name)) m.set(rel.split(path.sep).join("/"), fs.readFileSync(path.join(REPO, rel), "utf-8"));
    }
  };
  walk("tests");
  return m;
}

describe("teardown order: a writing child is stopped before its directory is removed", () => {
  it("RULE 1: no teardown body (hook, finally, helper closure) kills a relay entry / SQLite writer and then removes its dir without awaiting its exit", () => {
    expect(teardownViolations(testFiles())).toEqual([]);
  });
  it("RULE 2: every helper that spawns a relay entry returns the child (a handle stopAndRemove can take)", () => {
    expect(helperViolations(testFiles())).toEqual([]);
  });
  it("each EXEMPT file exists and still spawns its fake entry (an exemption cannot outlive its reason)", () => {
    const files = testFiles();
    for (const f of Object.keys(EXEMPT)) {
      expect(files.has(f), `${f} exists`).toBe(true);
      expect(spawnsWriter(files.get(f)!), `${f} still spawns what it is exempt for`).toBe(true);
    }
  });
});

describe("the guard's own rows (fixtures)", () => {
  const SPAWN = `const daemon = spawn(process.execPath, [DIST_INDEX], {});\n`;
  const one = (src: string) => new Map([["tests/x.test.ts", src]]);
  it("RULE 1 flags kill → rm with no wait (an after-hook, and a finally)", () => {
    expect(teardownViolations(one(`${SPAWN}afterAll(() => {\n  daemon.kill("SIGKILL");\n  fs.rmSync(ROOT, { recursive: true, force: true });\n});\n`))).toEqual(["tests/x.test.ts:2"]);
    expect(teardownViolations(one(`${SPAWN}try { x(); } finally {\n  daemon.kill("SIGTERM");\n  await new Promise((r) => setTimeout(r, 200));\n  fs.rmSync(ROOT, { recursive: true, force: true });\n}\n`))).toEqual(["tests/x.test.ts:2"]);
  });
  it("RULE 1 passes stopAndRemove, and an awaited exit BEFORE the removal", () => {
    expect(teardownViolations(one(`${SPAWN}afterAll(async () => {\n  await stopAndRemove(daemon, ROOT);\n});\n`))).toEqual([]);
    expect(teardownViolations(one(`${SPAWN}afterAll(async () => {\n  daemon.kill("SIGKILL");\n  await new Promise((r) => daemon.once("exit", r));\n  fs.rmSync(ROOT, { recursive: true, force: true });\n});\n`))).toEqual([]);
  });
  it("RULE 1 passes an awaited exit that WRAPS the kill, and a describe whose title holds a comma is still a describe", () => {
    expect(teardownViolations(one(`${SPAWN}async function tearDown() {\n  await new Promise<void>((resolve) => {\n    daemon.once("exit", () => resolve());\n    daemon.kill("SIGTERM");\n  });\n  fs.rmSync(ROOT, { recursive: true, force: true });\n}\n`))).toEqual([]);
    expect(teardownViolations(one(`${SPAWN}describe("a, b", () => {\n  it("a", async () => {\n    daemon.kill("SIGKILL");\n    await new Promise((r) => daemon.once("exit", r));\n  });\n  it("b", () => {\n    fs.rmSync(ROOT, { recursive: true, force: true });\n  });\n});\n`))).toEqual([]);
  });
  it("RULE 1 flags an awaited exit that comes AFTER the removal", () => {
    expect(teardownViolations(one(`${SPAWN}afterAll(async () => {\n  daemon.kill("SIGKILL");\n  fs.rmSync(ROOT, { recursive: true, force: true });\n  await new Promise((r) => daemon.once("exit", r));\n});\n`))).toEqual(["tests/x.test.ts:2"]);
  });
  it("RULE 1 flags a helper's kill() CLOSURE that kills then removes (the split a hook scan misses)", () => {
    expect(teardownViolations(one(`${SPAWN}function start() {\n  return { kill: async () => {\n    daemon.kill("SIGKILL");\n    fs.rmSync(ROOT, { recursive: true, force: true });\n  } };\n}\n`))).toEqual(["tests/x.test.ts:3"]);
  });
  it("RULE 1 ignores a removal BEFORE any kill (setting a directory up), and a describe that groups a kill and a removal from different tests", () => {
    expect(teardownViolations(one(`${SPAWN}function build() {\n  fs.rmSync(ROOT, { recursive: true, force: true });\n  daemon.kill("SIGKILL");\n}\n`))).toEqual([]);
    expect(teardownViolations(one(`${SPAWN}describe("g", () => {\n  it("a", async () => {\n    daemon.kill("SIGKILL");\n    await new Promise((r) => daemon.once("exit", r));\n  });\n  it("b", () => {\n    fs.rmSync(ROOT, { recursive: true, force: true });\n  });\n});\n`))).toEqual([]);
  });
  it("RULE 1 ignores a file that spawns no relay entry or SQLite writer (a sleeper)", () => {
    expect(teardownViolations(one(`const m = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"]);\nafterEach(() => {\n  m.kill("SIGKILL");\n  fs.rmSync(ROOT, { recursive: true, force: true });\n});\n`))).toEqual([]);
  });
  it("RULE 2 flags a helper that spawns the relay entry without returning the child, and passes one that returns it", () => {
    expect(helperViolations(one(`async function startHidden(): Promise<void> {\n  const child = spawn(process.execPath, [DIST_INDEX], {});\n  procs.push(child);\n}\n`))).toEqual(["tests/x.test.ts:startHidden"]);
    expect(helperViolations(one(`async function startOwned(): Promise<{ child: ChildProcess }> {\n  const child = spawn(process.execPath, [DIST_INDEX], {});\n  return { child };\n}\n`))).toEqual([]);
  });
});
