// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * STRUCTURAL: every non-recursive fs rm / rmSync in src/ removes a path the product itself created as a REGULAR file,
 * and says so with `// rm: own regular file` (on its statement's line, or directly above it). WHY: on Node v24.13.0
 * (the Node the live daemon runs), rmSync on a DANGLING symlink returns without error and LEAVES the link (MEASURED on
 * macOS and on the Linux 24.13.0 CI leg); anything that may be a link is removed with fs.unlinkSync.
 * Built on the TYPE-CHECKER scanner (tests/_helpers/rm-guard.ts over fs-open-sites.ts), never a regex (ruling bac8abd5,
 * Codex #472 R1): aliases, namespaces, destructuring and fs/promises resolve through the checker; `recursive` is read
 * from the options OBJECT LITERAL (a non-literal options argument needs the justification); one justification per
 * call (two removal calls on one line are refused); a value use of rm/rmSync is refused.
 * NAMED LIMITS: code outside src/, and a child process running `rm`.
 */
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { srcProgram, virtualProgram } from "./_helpers/ts-binding.js";
import { rmScan, rejectedUses, JUSTIFICATION } from "./_helpers/rm-guard.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (f: string) => path.relative(REPO, f).split(path.sep).join("/");
const inSrc = (f: string) => f.startsWith("src/");

/** The sites known when the guard was rebuilt: each removes a temp, snapshot or tar file this code created itself. */
const KNOWN: ReadonlyArray<[string, string]> = [
  ["src/mint-secret.ts", "tmp"],
  ["src/fs-perms.ts", "tmp"],
  ["src/convert-journal.ts", "tmp"],
  ["src/backup.ts", "snapshotDbPath"],
  ["src/backup.ts", "plainTar"],
  ["src/instance.ts", "tmp"],
  ["src/cli/pair.ts", "file"],
];

/**
 * fs named outside a static import, REVIEWED: no rm or rmSync is reached through it (the same site the fs-open
 * inventory lists, tests/inv-db-01-fs-open-scan.test.ts). A new one fails until it is reviewed and named here.
 */
/**
 * Pinned by its EXACT text, its COUNT and every use made THROUGH it (ruling 276d0f4b): an added `anyFs.rmSync(p)`
 * (invisible to the checker through `any`) changes the uses and fails.
 */
const REVIEWED_REJECTED: Readonly<Record<string, { text: string; uses: string[]; why: string }>> = {
  "src/cli/doctor.ts::checkDiskSpace::rejected": { text: "anyFs = fs as any", uses: [".statfsSync", ".statfsSync()"], why: "statfsSync only (Node 18.15+, best effort): no removal reached through it" },
};

describe("src/: every non-recursive rm / rmSync is justified; no value use hides one", () => {
  const program = srcProgram();
  const scanned = rmScan(program, rel, inSrc);
  const sites = scanned.sites;
  const findings = scanned.findings.filter((f) => !(f.key in REVIEWED_REJECTED));
  it("every REVIEWED rejected site is pinned: one site, its exact text, and exactly the reviewed uses made through it", () => {
    for (const [k, pin] of Object.entries(REVIEWED_REJECTED)) {
      const hits = scanned.findings.filter((f) => f.key === k);
      expect(hits.map((h) => h.text), `${k}: one site, this exact text`).toEqual([pin.text]);
      expect(rejectedUses(program, hits[0]!.node), `${k}: the uses made through it`).toEqual(pin.uses);
    }
  });
  it("the scanner reaches every KNOWN site (a guard that sees nothing proves nothing)", () => {
    const found = sites.map((s) => `${s.file} ${s.firstArg}`);
    for (const [file, arg] of KNOWN) expect(found, `${file} rmSync(${arg}, …)`).toContain(`${file} ${arg}`);
  });
  it(`no finding: each site carries "${JUSTIFICATION}"; anything that may be a link uses fs.unlinkSync`, () => {
    expect(findings.map((f) => `${f.file}:${f.line} ${f.problem}`)).toEqual([]);
  });
});

const NODE_FS = {
  "node_modules/@types/node/fs.d.ts": `declare module "fs" {
    export function unlinkSync(p: unknown): void;
    export function rmSync(p: unknown, o?: unknown): void;
    export * as promises from "fs/promises";
  }
  declare module "node:fs" { export * from "fs"; }`,
  "node_modules/@types/node/fs/promises.d.ts": `declare module "fs/promises" { export function unlink(p: unknown): Promise<void>; export function rm(p: unknown, o?: unknown): Promise<void>; }
  declare module "node:fs/promises" { export * from "fs/promises"; }`,
};
const vrel = (f: string) => f.replace(/\\/g, "/").replace(/^(?:[A-Za-z]:)?\/virtual\//, "");
const scan = (code: string) => rmScan(virtualProgram({ ...NODE_FS, "src/x.ts": code }), vrel, (f) => f === "src/x.ts");

describe("Codex #472 R1's four evasions: each is CAUGHT", () => {
  it("a string that SAYS recursive (`note: \"recursive: true\"`) does not make a call recursive: unjustified → a finding", () => {
    const r = scan(`import fs from "node:fs";\nexport function f(a: string) { fs.rmSync(a, { force: true, note: "recursive: true" }); }`);
    expect(r.findings.map((f) => f.problem)).toEqual([expect.stringMatching(/non-recursive removal without/)]);
  });
  it("fs/promises through a namespace (`fsp.rm(p)`) is seen: unjustified → a finding", () => {
    const r = scan(`import * as fsp from "node:fs/promises";\nexport async function f(p: string) { await fsp.rm(p); }`);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings.some((f) => /non-recursive removal without/.test(f.problem))).toBe(true);
  });
  it("a destructured alias (`const {rmSync: remove} = fs; remove(p)`) is refused as a value use", () => {
    const r = scan(`import fs from "node:fs";\nconst { rmSync: remove } = fs;\nexport function f(p: string) { remove(p); }`);
    expect(r.findings.some((f) => /VALUE use of rm\/rmSync/.test(f.problem))).toBe(true);
  });
  it("two calls on one line under ONE justification: refused (one justification per call)", () => {
    const r = scan(`import fs from "node:fs";\nexport function f(a: string, b: string) { g(fs.rmSync(a), fs.rmSync(b)); } // rm: own regular file\nfunction g(..._x: unknown[]) {}`);
    expect(r.findings.some((f) => /two removal calls on one line/.test(f.problem))).toBe(true);
  });
});

describe("review R2 (ruling 276d0f4b)", () => {
  it("a COMPUTED property (or a spread) in the options literal makes them unreadable: `{recursive: true, [\"recursive\"]: false}` needs the justification", () => {
    const r = scan(`import fs from "node:fs";\nexport function f(d: string) { fs.rmSync(d, { recursive: true, ["recursive"]: false }); }`);
    expect(r.findings.map((f) => f.problem)).toEqual([expect.stringMatching(/options the guard cannot read/)]);
  });
  it("what is done THROUGH a rejected `fs as any` is read: an added `.rmSync()` shows in its uses (so a pinned allowance fails)", () => {
    const program = virtualProgram({ ...NODE_FS, "src/x.ts": `import fs from "node:fs";\nexport function f(d: string, p: string) {\n  const anyFs = fs as any;\n  if (typeof anyFs.statfsSync === "function") anyFs.statfsSync(d);\n  anyFs.rmSync(p);\n}` });
    const r = rmScan(program, vrel, (f) => f === "src/x.ts");
    const rejected = r.findings.filter((f) => f.key.endsWith("::rejected"));
    expect(rejected.length).toBe(1);
    expect(rejectedUses(program, rejected[0]!.node)).toEqual([".statfsSync", ".statfsSync()", ".rmSync()"]);
  });
});

describe("the guard's own rules (controls)", () => {
  it("a justified call (trailing, or on the line directly above) has no finding; two lines above does not count", () => {
    expect(scan(`import fs from "node:fs";\nexport function f(a: string) { fs.rmSync(a, { force: true }); } // rm: own regular file: its temp`).findings).toEqual([]);
    expect(scan(`import fs from "node:fs";\nexport function f(a: string) {\n  // rm: own regular file: its temp\n  fs.rmSync(a);\n}`).findings).toEqual([]);
    expect(scan(`import fs from "node:fs";\nexport function f(a: string) {\n  // rm: own regular file: its temp\n\n  fs.rmSync(a);\n}`).findings.length).toBe(1);
  });
  it("a LITERAL `recursive: true` is out of scope; `recursive: false`, a non-literal value or a non-literal options object needs the justification", () => {
    expect(scan(`import fs from "node:fs";\nexport function f(d: string) { fs.rmSync(d, { recursive: true, force: true }); }`).findings).toEqual([]);
    expect(scan(`import fs from "node:fs";\nexport function f(d: string) { fs.rmSync(d, { recursive: false }); }`).findings.length).toBe(1);
    expect(scan(`import fs from "node:fs";\nexport function f(d: string, r: boolean) { fs.rmSync(d, { recursive: r }); }`).findings.map((f) => f.problem)).toEqual([expect.stringMatching(/options the guard cannot read/)]);
    expect(scan(`import fs from "node:fs";\nexport function f(d: string, o: object) { fs.rmSync(d, o); }`).findings.map((f) => f.problem)).toEqual([expect.stringMatching(/options the guard cannot read/)]);
  });
  it("a justification inside a STRING on the line does not count (only a comment does)", () => {
    expect(scan(`import fs from "node:fs";\nexport function f(a: string) { fs.rmSync(a); const s = "// rm: own regular file"; }`).findings.length).toBe(1);
  });
});
