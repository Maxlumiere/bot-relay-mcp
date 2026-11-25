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
