// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * STRUCTURAL: every NON-recursive fs.rmSync in src/ removes a path the product itself created as a REGULAR file, and
 * says so with `// rm: own regular file` on its line or the line above. WHY: on Node v24.13.0 (the Node the live
 * daemon runs), rmSync on a DANGLING symlink returns without error and LEAVES the link (measured). Anything that may
 * be a link must be removed with fs.unlinkSync, which removes the link itself on every Node.
 *   - A recursive rmSync (a directory tree) is out of scope here.
 *   - The KNOWN sites are listed: the scanner must still reach each (a guard that sees nothing proves nothing).
 *     A NEW site passes only with the justification.
 *   - The async forms (fs.promises.rm, rm from "fs/promises") and a renamed import of rmSync are refused outright:
 *     they would hide a site from this scan.
 * LIMITS (named, not covered): dynamic access (fs["rmSync"]), a removal through a child process (`rm`), and code
 * outside src/.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO, "src");
export const JUSTIFICATION = "// rm: own regular file";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && p.endsWith(".ts")) out.push(p);
  }
  return out;
}

export interface RmSite {
  file: string;
  line: number;
  firstArg: string;
  justified: boolean;
}

/** Every non-recursive rmSync call in `text` (the full argument list is read, across lines). Pure. */
export function rmSites(file: string, text: string): RmSite[] {
  const lines = text.split("\n");
  const out: RmSite[] = [];
  const re = /\brmSync\s*\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
    }
    const args = text.slice(m.index + m[0].length, i - 1);
    if (/recursive:\s*true/.test(args)) continue;
    const line = text.slice(0, m.index).split("\n").length;
    const here = lines[line - 1] ?? "";
    const above = lines[line - 2] ?? "";
    out.push({ file, line, firstArg: args.split(",")[0]!.trim(), justified: here.includes(JUSTIFICATION) || above.trim().startsWith(JUSTIFICATION) });
  }
  return out;
}

const FILES = walk(SRC);
const SITES = FILES.flatMap((f) => rmSites(path.relative(REPO, f), fs.readFileSync(f, "utf-8")));

/** The 14 sites known when this guard landed: each removes a temp, staged or snapshot file this code created. */
const KNOWN: ReadonlyArray<[string, string]> = [
  ["src/mint-secret.ts", "tmp"],
  ["src/fs-perms.ts", "tmp"],
  ["src/db-owner-lock.ts", "tmp"],
  ["src/owner-endpoint.ts", "tmp"],
  ["src/convert-journal.ts", "tmp"],
  ["src/sqlite-compat.ts", "tmp"],
  ["src/backup.ts", "snapshotDbPath"],
  ["src/backup.ts", "plainTar"],
  ["src/backup.ts", "newPath"],
  ["src/backup.ts", "newPath"],
  ["src/instance.ts", "tmp"],
  ["src/cli/pair.ts", "file"],
  ["src/cli/remote.ts", "tmp"],
  ["src/cli/remote.ts", "tmp"],
];

describe("every non-recursive rmSync in src/ removes the product's OWN regular file, and says so", () => {
  it("the scanner reaches every KNOWN site (a guard that sees nothing proves nothing)", () => {
    const found = SITES.map((s) => `${s.file} ${s.firstArg}`);
    for (const [file, arg] of KNOWN) {
      const k = `${file} ${arg}`;
      const need = KNOWN.filter(([f, a]) => `${f} ${a}` === k).length;
      expect(found.filter((x) => x === k).length, `${k}: expected ${need} site(s)`).toBeGreaterThanOrEqual(need);
    }
  });
  it(`every site carries "${JUSTIFICATION}" (on its line or the line above); anything that may be a link uses fs.unlinkSync`, () => {
    const bad = SITES.filter((s) => !s.justified).map((s) => `${s.file}:${s.line} rmSync(${s.firstArg}, …)`);
    expect(
      bad,
      `non-recursive rmSync without "${JUSTIFICATION}". If the path may be a link (or a dangling one), use fs.unlinkSync: ` +
        `on Node v24.13.0 rmSync on a dangling symlink returns without error and leaves the link. If it is a regular file ` +
        `this code created itself, add the justification.`,
    ).toEqual([]);
  });
  it("no async rm form and no renamed rmSync import in src/ (either would hide a site from this scan)", () => {
    const hits: string[] = [];
    for (const f of FILES) {
      const t = fs.readFileSync(f, "utf-8");
      if (/\bpromises\.rm\s*\(/.test(t) || /from\s+["'](node:)?fs\/promises["']/.test(t) && /\brm\b/.test(t.match(/import\s*\{[^}]*\}\s*from\s+["'](node:)?fs\/promises["']/)?.[0] ?? "")) hits.push(`${path.relative(REPO, f)}: async rm`);
      if (/\brmSync\s+as\s+\w+/.test(t)) hits.push(`${path.relative(REPO, f)}: rmSync renamed on import`);
    }
    expect(hits).toEqual([]);
  });
  it("PURE: the scanner reads multi-line calls, skips recursive ones, and accepts the justification only on the line or the line above", () => {
    const t = [
      "fs.rmSync(a, { force: true }); // rm: own regular file",
      "// rm: own regular file",
      "fs.rmSync(b);",
      "fs.rmSync(c,\n  { recursive: true, force: true });",
      "fs.rmSync(d, { force: true });",
      "// rm: own regular file",
      "",
      "fs.rmSync(e);",
    ].join("\n");
    expect(rmSites("x.ts", t).map((s) => [s.firstArg, s.justified])).toEqual([
      ["a", true],
      ["b", true],
      ["d", false],
      ["e", false],
    ]);
  });
});
