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
 * excluded) that kills a child and THEN removes a directory (rmSync / rm with `recursive`, rimraf) must stop EACH
 * killed child before the removal: a `stopAndRemove` that names THAT child (tests/_helpers/stop-and-remove.ts), or an
 * awaited exit of THAT child. An unrelated child's stop never counts. A removal BEFORE any kill (setting a directory
 * up) is not a teardown and is not flagged. The innermost such body is the one named. A spawn through a SIMPLE alias
 * (`const x = spawn`, `cp.spawn`, a destructured or renamed import) is a spawn.
 * RULE 2 (helpers): a helper function that spawns a relay entry or a SQLite writer (a better-sqlite3 script, inline or
 * in a variable the file defines) must RETURN the spawned child (a handle `stopAndRemove` can take), so a kill and a
 * removal can never be split by a helper that hides the child.
 *
 * EXEMPT, by name, with the reason: a file whose relay-looking entry is a FAKE that only sleeps (EXEMPT below); a row
 * requires that fake to still be a bare timer.
 * REMAINING BLIND SPOT (stated): a kill and a removal in DIFFERENT bodies (a kill in one test or helper, the removal
 * in another) with nothing shared between them, which RULE 2 narrows by keeping every spawned writer's handle
 * returnable; a spawn reached through any indirection other than a simple alias (passed as a parameter, re-exported);
 * an entry path assembled at run time from parts this scan cannot read; and a removal through a helper whose name does
 * not say so.
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

/**
 * Does an EXEMPT file's fake relay entry still only SLEEP? Every fake `index.js` the file writes must be a bare timer
 * (`setInterval(() => {}, N);`) and nothing else: no write, no DB, no other call.
 */
export function exemptFakeSleeps(src: string): boolean {
  const writes = [...src.matchAll(/writeFileSync\(\s*path\.join\([^)]*["']index\.js["']\)\s*,\s*(["'`])([\s\S]*?)\1/g)];
  return writes.length > 0 && writes.every((m) => /^\s*setInterval\(\(\) => \{\}, \d+\);(?:\\n)?\s*$/.test(m[2]!));
}

/** A relay entry or a SQLite writer, as a spawn's argument shows it. */
const WRITER_MARK = /(DIST_INDEX|\bENTRY\b|dist\/index\.js|["']dist["'],\s*["']index\.js["']|better-sqlite3)/;
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The names that call child_process.spawn in this source: `spawn` itself and SIMPLE aliases (`const x = spawn`,
 * `const x = cp.spawn`, `const { spawn: x } = …`, `import { spawn as x }`). An alias through any other indirection is
 * in the stated blind spot.
 */
export function spawnNames(src: string): string[] {
  const names = new Set(["spawn"]);
  for (const m of src.matchAll(/\bconst\s+(\w+)\s*=\s*(?:\w+\.)?spawn\b(?!\s*\()/g)) names.add(m[1]!);
  for (const m of src.matchAll(/\{[^{}]*?\bspawn\s*(?::|\bas\b)\s*(\w+)[^{}]*\}/g)) names.add(m[1]!);
  return [...names];
}
const spawnCall = (names: readonly string[]) => new RegExp(`(?:\\b\\w+\\.)?\\b(?:${names.map(escapeRe).join("|")})(?:Sync)?\\(`);

/** Does this source spawn a relay entry or a SQLite writer (through spawn or a simple alias of it)? */
export function spawnsWriter(src: string): boolean {
  return spawnCall(spawnNames(src)).test(src) && WRITER_MARK.test(src);
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

const RM = /\brmSync\([^)]*recursive|\brm\([^)]*recursive|\brimraf(?:\.sync)?\(/;

/** This guard's own file holds fixture SOURCE TEXT (strings that look like teardowns): never scanned. */
const SELF = "tests/teardown-stops-before-remove.test.ts";
/** A body opener: an arrow, a function, a `finally`, an after-hook. */
const OPENER = /=>\s*\{|\)\s*(?::\s*[^{=;]+)?\{|\bfinally\s*\{|\bafter(?:Each|All)\s*\([^{]*\{/g;

/**
 * The children a body KILLS: each `X.kill(` / `X?.kill(` receiver (not `process`), with a loop variable mapped to the
 * list it iterates (`for (const c of LIST) … c.kill(` → LIST).
 */
function killedChildren(body: string): string[] {
  const loops = new Map<string, string>();
  for (const m of body.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s+([\w.]+)\s*\)/g)) loops.set(m[1]!, m[2]!);
  const out = new Set<string>();
  for (const m of body.matchAll(/([\w.]+?)\??\.kill\(/g)) {
    if (m[1] === "process") continue;
    out.add(loops.get(m[1]!) ?? m[1]!);
  }
  return [...out];
}

/** Is child X stopped before `limit` in `body`: a stopAndRemove that NAMES it, or an awaited exit of X itself? */
function stoppedBefore(body: string, x: string, limit: number): boolean {
  const X = escapeRe(x);
  const head = body.slice(0, limit);
  return (
    new RegExp(`\\bstopAndRemove\\(\\s*(?:\\[[^\\]]*\\b${X}\\b[^\\]]*\\]|${X}\\b)`).test(body) ||
    new RegExp(`await[^;]*?\\b${X}\\b\\??\\.(?:once\\(\\s*["'](?:exit|close)["']|out\\b|exited\\b)`).test(head) ||
    new RegExp(`await[^;]*?\\b(?:waitExit|awaitExit|waitForExit)\\(\\s*${X}\\b`).test(head) ||
    new RegExp(`await[^;]*?\\b${X}\\.map\\(\\s*(?:waitExit|awaitExit|waitForExit)\\b`).test(head)
  );
}

/**
 * RULE 1: every innermost body (file:line) that kills a child and THEN removes a dir while ANY killed child is not
 * itself stopped first (an unrelated child's stopAndRemove or awaited exit never counts).
 */
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
      const k = body.search(/\.kill\(/);
      if (k < 0) continue;
      const r = body.slice(k).search(RM); // a removal AFTER the kill (one before it is a setup, not a teardown)
      if (r < 0) continue;
      const killed = killedChildren(body);
      if (killed.length > 0 && killed.every((x) => stoppedBefore(body, x, k + r))) continue;
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
  for (const [file, src] of files) {
    if (file === SELF || EXEMPT[file]) continue;
    // An ASYNC spawn only: a spawnSync's child has exited when the call returns (there is nothing to hand back).
    const call = `(?:\\b\\w+\\.)?\\b(?:${spawnNames(src).map(escapeRe).join("|")})\\(`;
    for (const m of src.matchAll(HELPER)) {
      const name = m[1] ?? m[2]!;
      const body = bodyAt(src, m.index! + m[0].length - 1);
      const sp = new RegExp(`${call}([^;]*)`).exec(body);
      if (!sp) continue;
      // A writer: the spawn's own arguments name one, or name a script variable this file defines as one.
      const args = sp[1]!;
      const scriptVars = [...args.matchAll(/\b([A-Za-z_]\w*)\b/g)].map((x) => x[1]!);
      const writer = WRITER_MARK.test(args) || scriptVars.some((v) => new RegExp(`\\b${escapeRe(v)}\\s*=[^;]{0,800}better-sqlite3`).test(src));
      if (!writer) continue;
      const held = new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*${call}`).exec(body);
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
  it("each EXEMPT file exists, still spawns its fake entry, and that fake still only sleeps (an exemption cannot outlive its reason)", () => {
    const files = testFiles();
    for (const f of Object.keys(EXEMPT)) {
      expect(files.has(f), `${f} exists`).toBe(true);
      expect(spawnsWriter(files.get(f)!), `${f} still spawns what it is exempt for`).toBe(true);
      expect(exemptFakeSleeps(files.get(f)!), `${f}'s fake entry still only SLEEPS (writes nothing)`).toBe(true);
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
  it("RULE 1 matches the SPECIFIC child: an unrelated child's stopAndRemove or awaited exit does not excuse killing ANOTHER child and removing its dir", () => {
    const src = `${SPAWN}const other = spawn(process.execPath, [DIST_INDEX], {});\n`;
    expect(teardownViolations(one(`${src}afterAll(async () => {\n  await stopAndRemove(other, OTHER);\n  daemon.kill("SIGKILL");\n  fs.rmSync(ROOT, { recursive: true, force: true });\n});\n`))).toEqual(["tests/x.test.ts:3"]);
    expect(teardownViolations(one(`${src}afterAll(async () => {\n  await other.out;\n  daemon.kill("SIGKILL");\n  fs.rmSync(ROOT, { recursive: true, force: true });\n});\n`))).toEqual(["tests/x.test.ts:3"]);
  });
  it("RULE 1 ORDERING: a stop that comes AFTER the removal does not count (kill, rm, then stopAndRemove FAILS)", () => {
    expect(teardownViolations(one(`${SPAWN}afterAll(async () => {\n  daemon.kill("SIGKILL");\n  fs.rmSync(ROOT, { recursive: true, force: true });\n  await stopAndRemove(daemon, ROOT);\n});\n`))).toEqual(["tests/x.test.ts:2"]);
  });
  it("RULE 1 accepts an awaited promise wrapping the child's exit listener, created BEFORE the kill", () => {
    expect(teardownViolations(one(`${SPAWN}afterAll(async () => {\n  const done = new Promise((r) => daemon.once("exit", r));\n  daemon.kill("SIGTERM");\n  await done;\n  fs.rmSync(ROOT, { recursive: true, force: true });\n});\n`))).toEqual([]);
  });
  it("a spawn ALIAS (const launch = spawn; a destructured or renamed import) is still a spawn: both rules see it", () => {
    const alias = `const launch = spawn;\nconst d = launch(process.execPath, [DIST_INDEX], {});\n`;
    expect(teardownViolations(one(`${alias}afterAll(() => {\n  d.kill("SIGKILL");\n  fs.rmSync(ROOT, { recursive: true, force: true });\n});\n`))).toEqual(["tests/x.test.ts:3"]);
    expect(helperViolations(one(`import { spawn as run } from "node:child_process";\nfunction startHidden(): void {\n  const child = run(process.execPath, [DIST_INDEX], {});\n  procs.push(child);\n}\n`))).toEqual(["tests/x.test.ts:startHidden"]);
  });
  it("RULE 2 covers a SQLite WRITER too: a helper spawning a better-sqlite3 script without returning the child is flagged", () => {
    expect(helperViolations(one(`function startWriter(): void {\n  const w = spawn(process.execPath, ["-e", "const D = require('better-sqlite3'); new D(process.argv[1]).exec('x')"], {});\n  procs.push(w);\n}\n`))).toEqual(["tests/x.test.ts:startWriter"]);
  });
  it("RULE 2 ignores a spawnSync writer (its child has exited when the call returns: nothing to hand back)", () => {
    expect(helperViolations(one(`function leaveHotWal(file: string): void {\n  const r = spawnSync(process.execPath, [HOT, "better-sqlite3", file]);\n  if (r.status !== 0) throw new Error("x");\n}\n`))).toEqual([]);
  });
  it("rimraf.sync is a removal too", () => {
    expect(teardownViolations(one(`${SPAWN}afterAll(() => {\n  daemon.kill("SIGKILL");\n  rimraf.sync(ROOT);\n});\n`))).toEqual(["tests/x.test.ts:2"]);
  });
  it("an EXEMPT file's fake must still be a SLEEPER: a fake that writes is no longer exempt", () => {
    expect(exemptFakeSleeps(`fs.writeFileSync(path.join(install, "dist", "index.js"), "setInterval(() => {}, 1000);\\n");`)).toBe(true);
    expect(exemptFakeSleeps(`fs.writeFileSync(path.join(install, "dist", "index.js"), "require('fs').writeFileSync('x', '1'); setInterval(() => {}, 1000);\\n");`)).toBe(false);
  });
  it("RULE 2 flags a helper that spawns the relay entry without returning the child, and passes one that returns it", () => {
    expect(helperViolations(one(`async function startHidden(): Promise<void> {\n  const child = spawn(process.execPath, [DIST_INDEX], {});\n  procs.push(child);\n}\n`))).toEqual(["tests/x.test.ts:startHidden"]);
    expect(helperViolations(one(`async function startOwned(): Promise<{ child: ChildProcess }> {\n  const child = spawn(process.execPath, [DIST_INDEX], {});\n  return { child };\n}\n`))).toEqual([]);
  });
});
