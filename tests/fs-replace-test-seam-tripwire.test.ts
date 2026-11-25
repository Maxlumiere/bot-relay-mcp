// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The replace helper's test seam is TEST-ONLY: its name says so (a `__test` prefix), and NO file under src/ other than
 * its defining module may name it, so production code can never switch the retry's platform, rename or sleep.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as replace from "../src/fs-replace.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFINING = path.join("src", "fs-replace.ts");

/** Every file under `dir` (relative to the repo) whose text names a `__test`-prefixed identifier. */
export function srcFilesNamingTestSeams(root: string, dir = "src"): { file: string; names: string[] }[] {
  const out: { file: string; names: string[] }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(e.name)) {
        const names = [...new Set(fs.readFileSync(path.join(root, rel), "utf-8").match(/\b__test[A-Za-z0-9_]*/g) ?? [])];
        if (names.length) out.push({ file: rel, names });
      }
    }
  };
  walk(dir);
  return out;
}

describe("the replace helper's test seam is test-only", () => {
  it("the seam setter is named with the __test prefix, and the old name is gone", () => {
    expect(typeof (replace as Record<string, unknown>).__testSetReplaceDeps).toBe("function");
    expect((replace as Record<string, unknown>)._setReplaceDepsForTests).toBeUndefined();
  });
  it("no file under src/ other than its defining module names a __test seam", () => {
    const hits = srcFilesNamingTestSeams(REPO).filter((h) => h.file !== DEFINING);
    expect(hits, JSON.stringify(hits)).toEqual([]);
    expect(srcFilesNamingTestSeams(REPO).find((h) => h.file === DEFINING)?.names, "precondition: the defining module names it").toContain("__testSetReplaceDeps");
  });
  it("the tripwire sees a src/ caller (a fixture tree): a production file calling the seam is caught", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-tripwire-"));
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "fs-replace.ts"), "export function __testSetReplaceDeps() {}\n");
      fs.writeFileSync(path.join(root, "src", "backup.ts"), 'import { __testSetReplaceDeps } from "./fs-replace.js";\n__testSetReplaceDeps();\n');
      const hits = srcFilesNamingTestSeams(root).filter((h) => h.file !== DEFINING);
      expect(hits).toEqual([{ file: path.join("src", "backup.ts"), names: ["__testSetReplaceDeps"] }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// THE GENERAL RULE: any EXPORTED identifier that is a test seam by name (a "*ForTests" suffix or a "__test*" prefix) may
// be NAMED in src/ only by its own defining file. No hard-coded list: every seam in src/ is found by its export, so a
// new seam is covered the day it lands. Comments are stripped first (a comment that cites a seam is not a caller).
// ---------------------------------------------------------------------------------------------------------------------
/** A test seam, by name. */
export const SEAM_NAME = /^__test/;
const SRC_FILE = /\.(ts|mts|cts|js|mjs|cjs)$/;

/** The text with its comments removed (block and line comments; a "//" inside a string literal is kept). */
export function stripComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const n = text[i + 1];
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (c === "/" && n === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end - 1;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else {
      out += c;
    }
  }
  return out;
}

/** Every src/ file (relative path → its comment-stripped text). */
function srcTexts(root: string, dir = "src"): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (SRC_FILE.test(e.name)) m.set(rel, stripComments(fs.readFileSync(path.join(root, rel), "utf-8")));
    }
  };
  walk(dir);
  return m;
}

/** Each exported test seam, with the file(s) that define it. */
export function testSeamExports(root: string): Map<string, Set<string>> {
  const seams = new Map<string, Set<string>>();
  const add = (name: string, file: string) => {
    if (SEAM_NAME.test(name)) (seams.get(name) ?? seams.set(name, new Set()).get(name)!).add(file);
  };
  for (const [file, text] of srcTexts(root)) {
    for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]!, file);
    for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) for (const part of m[1]!.split(",")) add(part.trim().split(/\s+as\s+/).pop()!.trim(), file);
  }
  return seams;
}

/** Every src/ file that NAMES a test seam it does not define, with a message naming the seam. */
export function seamViolations(root: string): string[] {
  const seams = testSeamExports(root);
  const out: string[] = [];
  for (const [file, text] of srcTexts(root)) {
    for (const [name, defs] of seams) {
      if (defs.has(file)) continue;
      if (new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`).test(text)) out.push(`${file} names the test seam ${name} (defined in ${[...defs].join(", ")}): only its defining file may`);
    }
  }
  return out.sort();
}

describe("the general rule: a test seam is named in src/ only by its own defining file", () => {
  /** A fixture src/ tree. */
  const fixture = (files: Record<string, string>): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-rule-"));
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    return root;
  };
  it("THIS repo's src/ holds no violation (every seam is named only by its defining file)", () => {
    expect(seamViolations(REPO)).toEqual([]);
    expect(testSeamExports(REPO).size, "precondition: the rule sees the seams").toBeGreaterThan(1);
    expect(testSeamExports(REPO).get("__testSetReplaceDeps"), "and the replace helper's").toEqual(new Set([DEFINING]));
  });
  it("a src/ caller of a *ForTests seam FAILS, naming the seam", () => {
    const root = fixture({ "src/a.ts": "export function _setThingForTests(): void {}\n", "src/b.ts": 'import { _setThingForTests } from "./a.js";\n_setThingForTests();\n' });
    try {
      expect(seamViolations(root)).toEqual([`${path.join("src", "b.ts")} names the test seam _setThingForTests (defined in ${path.join("src", "a.ts")}): only its defining file may`]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("a src/ caller of a __test seam FAILS, naming the seam", () => {
    const root = fixture({ "src/a.ts": "export const __testHook = (): void => {};\n", "src/c.ts": 'import { __testHook } from "./a.js";\n__testHook();\n' });
    try {
      expect(seamViolations(root)).toEqual([`${path.join("src", "c.ts")} names the test seam __testHook (defined in ${path.join("src", "a.ts")}): only its defining file may`]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("the DEFINING file using its own seam passes; a COMMENT that cites a seam elsewhere passes", () => {
    const root = fixture({
      "src/a.ts": "export function _resetForTests(): void {}\nfunction internal(): void { _resetForTests(); }\n",
      "src/d.ts": "/** pattern: a.ts _resetForTests */\n// see _resetForTests\nconst url = \"http://x\"; // trailing _resetForTests mention\n",
    });
    try {
      expect(seamViolations(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
