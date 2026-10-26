// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * src/path-walk.ts: THE path walk's contract, each clause with its known-good twin.
 *
 *   - `..` after a link lands where THIS OS's kernel lands (POSIX physical, Windows lexical; the test asks the kernel);
 *   - more than 40 links fail CLOSED as "loop" (twin: exactly 40 resolve), and a 2-link cycle is a loop;
 *   - a missing tail lands where a create-the-parents writer would (twin: without allowMissing it is "missing");
 *   - comparing two paths is THREE-valued: same (one file, by dev + inode), different, or INCONCLUSIVE (missing
 *     tails that differ only by case or Unicode form); mixed volumes are NOT measured (ASSUMED: see that comment);
 *   - a link target ending in a separator must reach a directory; `.` and `..` are looked up (search permission);
 *   - every hop is reported (each link with where it led);
 *   - a component below a file is "not-a-directory";
 *   - Windows forms: drive / UNC / \\?\ / device / drive-relative / root-relative / junction / 8.3 short name, and the
 *     REFUSED component forms (trailing period or space, reserved device names, `name:stream`) and target forms
 *     (`.` / `..` inside a target, a device target), through
 *     the fs seam on every OS, and the junction and the short name for REAL on the Windows job (each test says which).
 *   - parity with the operator tripwire's second copy (tests/_setup/operator-tripwire-preload.mjs canonicalPath) on the
 *     fixtures where both are defined; where they differ by design is listed in that test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { walkPath, comparePaths, PathWalkError, MAX_LINKS, type WalkFs, type WalkStat } from "../src/path-walk.js";
import { canonicalPath } from "./_setup/operator-tripwire-preload.mjs";

const WIN = process.platform === "win32";
/** A directory link: a junction on Windows (no privilege needed, absolute targets only), a symlink elsewhere. */
const dirLink = (target: string, at: string) => fs.symlinkSync(target, at, WIN ? "junction" : "dir");

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof PathWalkError) return err.reason;
    return `NOT A PathWalkError: ${(err as Error)?.message}`;
  }
  return "did not throw";
}

let base: string;
let real: string; // base/real, holding sub/ and a file
let sub: string;
let alias: string; // base/alias -> base/real/sub
let plain: string; // base/plain/sub (no links)
beforeAll(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "path-walk-")));
  real = path.join(base, "real");
  sub = path.join(real, "sub");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(real, "x"), "real/x");
  fs.writeFileSync(path.join(sub, "leaf"), "sub/leaf");
  fs.writeFileSync(path.join(base, "x"), "base/x");
  alias = path.join(base, "alias");
  dirLink(sub, alias);
  plain = path.join(base, "plain");
  fs.mkdirSync(path.join(plain, "sub"), { recursive: true });
  fs.writeFileSync(path.join(plain, "x"), "plain/x");
});
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("path-walk: `..` after a link lands where THIS OS's kernel lands", () => {
  it("alias/../x: the walk agrees with the kernel (POSIX: real/x, physical; Windows: base/x, lexical)", () => {
    const p = `${alias}${path.sep}..${path.sep}x`;
    // The kernel's own answer, read through the same spelling.
    const kernel = fs.readFileSync(p, "utf-8") === "real/x" ? path.join(real, "x") : path.join(base, "x");
    expect(walkPath(p).real).toBe(kernel);
    // MEASURED per OS: POSIX steps up from the link's target; Windows normalizes `..` before any junction
    // (windows-2022, d727efc). A walk that applied one OS's rule on the other would land elsewhere than the kernel.
    expect(kernel).toBe(WIN ? path.join(base, "x") : path.join(real, "x"));
    if (!WIN) expect(path.resolve(p)).toBe(path.join(base, "x")); // the lexical answer this replaces on POSIX
  });
  it("known-good twin: a plain directory, where lexical and physical agree", () => {
    expect(walkPath(`${plain}${path.sep}sub${path.sep}..${path.sep}x`).real).toBe(path.join(plain, "x"));
  });
  it("reports every hop: the link, with where its target resolved to", () => {
    const w = walkPath(path.join(alias, "leaf"));
    const link = w.entries.find((e) => e.path === alias);
    expect(link?.stat.isSymbolicLink()).toBe(true);
    expect(link?.resolved).toBe(sub);
    expect(w.entries[0].path).toBe(path.parse(base).root); // the root is an entry too: a per-hop check judges it
    expect(w.entries.map((e) => e.path)).toContain(sub); // the link's target components are entries
    expect(w.entries.at(-1)?.path).toBe(path.join(sub, "leaf"));
    expect(fs.readFileSync(path.join(alias, "leaf"), "utf-8")).toBe("sub/leaf"); // the kernel agrees
  });
});

describe("path-walk: a loop fails CLOSED", () => {
  it.skipIf(WIN)("a 2-link cycle is a loop (real fs)", () => {
    const a = path.join(base, "loop-a");
    const b = path.join(base, "loop-b");
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);
    expect(reason(() => walkPath(path.join(a, "x")))).toBe("loop");
    expect(reason(() => walkPath(path.join(a, "x"), { allowMissing: true }))).toBe("loop"); // never read as "missing"
  });
  it.skipIf(WIN)("41 chained links are a loop; the known-good twin, 40, resolves (real fs)", () => {
    const chain = path.join(base, "chain");
    fs.mkdirSync(chain);
    fs.writeFileSync(path.join(chain, "end"), "end");
    // l0 -> l1 -> ... -> l(n-1) -> end
    const make = (n: number, tag: string) => {
      for (let i = n - 1; i >= 0; i--) fs.symlinkSync(i === n - 1 ? "end" : `${tag}${i + 1}`, path.join(chain, `${tag}${i}`));
      return path.join(chain, `${tag}0`);
    };
    expect(walkPath(make(MAX_LINKS, "ok")).real).toBe(path.join(chain, "end"));
    expect(reason(() => walkPath(make(MAX_LINKS + 1, "over")))).toBe("loop");
  });
  it("a cycle through the fs seam is a loop on every OS", () => {
    const fake = fakeFs(WIN ? "win32" : "posix", { links: { [abs("a")]: abs("b"), [abs("b")]: abs("a") } });
    expect(reason(() => walkPath(abs("a"), { fs: fake, platform: WIN ? "win32" : "linux" }))).toBe("loop");
  });
});

describe("path-walk: comparing two paths is THREE-valued (same / different / inconclusive), never a guessed case rule", () => {
  it("two EXISTING spellings are the same iff the kernel resolves them to one file (dev + inode), on every volume", () => {
    const dir = path.join(base, "Case");
    fs.mkdirSync(path.join(dir, "Leaf"), { recursive: true });
    const variant = path.join(base, "CASE", "leaf");
    // The KERNEL's answer, independent of the walk: does the variant spelling open the same file?
    let kernelSame: boolean;
    try {
      kernelSame = fs.statSync(variant).ino === fs.statSync(path.join(dir, "Leaf")).ino;
    } catch {
      kernelSame = false;
    }
    // MEASURED per CI OS (the job log carries this line): macOS and Windows runners resolve it, Linux does not.
    console.error(`[path-walk] ${process.platform}: the case-variant spelling opens the same file = ${kernelSame}`);
    if (process.env.CI && (process.platform === "darwin" || WIN)) expect(kernelSame).toBe(true);
    if (process.env.CI && process.platform === "linux") expect(kernelSame).toBe(false);
    expect(comparePaths(path.join(dir, "Leaf"), variant)).toBe(kernelSame ? "same" : "different");
  });
  // Ruled on #357 R2 (D1): below the existing part NOTHING is folded or judged. Byte-identical missing tails
  // under the same entry are "same"; ANY other pair of tails is "inconclusive", whether or not some casing or
  // normalization rule would call them equal (σ/ς, ß/SS, İ/i: lowercasing is not Unicode case folding, and no fold is
  // the filesystem's).
  it.each([
    ["ASCII case", "config.json", "Config.json"],
    ["NFC vs NFD", "caf\u00e9", "cafe\u0301"],
    ["Greek sigma (σ / ς)", "\u03c3x", "\u03c2x"],
    ["German sharp s (ß / SS)", "stra\u00dfe", "STRASSE"],
    ["Turkish dotted I (İ / i)", "\u0130d", "id"],
    ["names no rule relates", "a", "b"],
    ["tails of different length", "a", "a/b"],
  ])("two MISSING tails that differ (%s) are INCONCLUSIVE, never different or same", (_label, x, y) => {
    expect(comparePaths(path.join(base, "Case", "nope", x), path.join(base, "Case", "nope", y))).toBe("inconclusive");
  });
  it("known-good twins: a byte-identical missing tail is the same; different EXISTING entries are different", () => {
    expect(comparePaths(path.join(base, "Case", "nope", "x"), path.join(base, "Case", "nope", "x"))).toBe("same");
    expect(comparePaths(path.join(base, "Case", "Leaf"), path.join(base, "Case", "Leaf2"))).toBe("different");
  });
  it("identity is (dev, ino) as BIGINT, end to end: the default fs yields bigints (no number ever stands in)", () => {
    const st = walkPath(path.join(base, "Case", "Leaf")).existingStat;
    expect(typeof st.dev).toBe("bigint");
    expect(typeof st.ino).toBe("bigint");
  });
  it("two inodes a JavaScript number cannot tell apart (2^53 and 2^53+1, same dev) are DIFFERENT (fs seam)", () => {
    const P = WIN ? path.win32 : path.posix;
    const fake = fakeFs(WIN ? "win32" : "posix", { files: [abs("big1"), abs("big2")], inos: { [abs("big1")]: 2n ** 53n, [abs("big2")]: 2n ** 53n + 1n } });
    const platform = WIN ? ("win32" as const) : ("linux" as const);
    expect(Number(2n ** 53n) === Number(2n ** 53n + 1n), "the precondition: as numbers they are equal").toBe(true);
    expect(comparePaths(abs("big1"), abs("big2"), { fs: fake, platform })).toBe("different");
    expect(comparePaths(abs("big1"), P.join(abs(""), "big1"), { fs: fake, platform }), "twin: the same entry").toBe("same");
  });
});

describe("path-walk: the ONLY sanctioned readers of a verdict (ruled on #357 R2)", () => {
  it("isProtected: same and inconclusive are protected, different is not (a write guard's safe direction)", async () => {
    const mod = (await import("../src/path-walk.js")) as Record<string, unknown>;
    expect(typeof mod.isProtected, "isProtected is exported").toBe("function");
    const isProtected = mod.isProtected as (r: string) => boolean;
    expect([isProtected("same"), isProtected("inconclusive"), isProtected("different")]).toEqual([true, true, false]);
  });
  it("isTrustedMatch: ONLY same is a match (a trust check's safe direction)", async () => {
    const mod = (await import("../src/path-walk.js")) as Record<string, unknown>;
    expect(typeof mod.isTrustedMatch, "isTrustedMatch is exported").toBe("function");
    const isTrustedMatch = mod.isTrustedMatch as (r: string) => boolean;
    expect([isTrustedMatch("same"), isTrustedMatch("inconclusive"), isTrustedMatch("different")]).toEqual([true, false, false]);
  });
});

// MIXED VOLUMES are NOT measured here (ASSUMED). A case-sensitive disk image under the insensitive system volume, and an
// insensitive one under that, would exercise comparePaths across mount boundaries; on the GitHub macOS runner `hdiutil
// attach` is "Permission denied" both at a mount point under the test's tmp (job 121391950657, 6e9cc36) and at its
// default /Volumes (job 121403898565, b1a9fb8). The design does not depend on it: comparePaths judges the existing part
// by file identity (dev + inode), which the kernel resolves on whatever volume it is, and reports a missing case
// variant as "inconclusive" without consulting any volume's case rule.

describe("path-walk: a missing tail", () => {
  it("lands where a create-the-parents writer would, through the real directory", () => {
    const w = walkPath(path.join(alias, "missing", "y"), { allowMissing: true });
    expect(w.real).toBe(path.join(sub, "missing", "y"));
    expect(w.existing).toBe(sub);
    expect(w.missing).toEqual(["missing", "y"]);
  });
  it("known-good twin: without allowMissing the same path is \"missing\", never a guess", () => {
    expect(reason(() => walkPath(path.join(alias, "missing", "y")))).toBe("missing");
  });
  it("a `..` cancels a missing name; one that climbs back out resumes the walk by this OS's rule", () => {
    const sep = path.sep;
    expect(walkPath(`${alias}${sep}nope${sep}..${sep}x`, { allowMissing: true }).real).toBe(path.join(sub, "x"));
    // POSIX: nope/.. returns to alias's REAL target (real/sub), and the next .. is its physical parent, real/.
    // Windows: both are lexical, so they cancel `nope` and `alias`.
    expect(walkPath(`${alias}${sep}nope${sep}..${sep}..${sep}x`, { allowMissing: true }).real).toBe(WIN ? path.join(base, "x") : path.join(real, "x"));
  });
  it.skipIf(WIN)("a dangling link lands on its target", () => {
    const dangling = path.join(base, "dangling");
    fs.symlinkSync(path.join(base, "nowhere", "z"), dangling);
    expect(walkPath(dangling, { allowMissing: true }).real).toBe(path.join(base, "nowhere", "z"));
    expect(reason(() => walkPath(dangling))).toBe("missing");
  });
});

describe("path-walk: below a file is not-a-directory", () => {
  it.each([
    ["file/name", (f: string) => path.join(f, "name")],
    ["file/ (trailing separator)", (f: string) => `${f}${path.sep}`],
  ])("%s", (_label, spell) => {
    expect(reason(() => walkPath(spell(path.join(real, "x")), { allowMissing: true }))).toBe("not-a-directory");
  });
  it("file/..: the walk agrees with the kernel (POSIX: ENOTDIR; Windows: the lexical `..` names the file's directory)", () => {
    const p = `${path.join(real, "x")}${path.sep}..`;
    let kernel: string;
    try {
      kernel = fs.statSync(p).isDirectory() ? "directory" : "file";
    } catch (err) {
      kernel = (err as NodeJS.ErrnoException).code ?? "error";
    }
    // MEASURED per OS: POSIX refuses to step below a file; Windows normalizes `x\..` away first (48d127a, windows-2022).
    expect(kernel).toBe(WIN ? "directory" : "ENOTDIR");
    if (WIN) expect(walkPath(p).real).toBe(real);
    else expect(reason(() => walkPath(p, { allowMissing: true }))).toBe("not-a-directory");
  });
  it("known-good twin: a trailing separator on a directory is fine", () => {
    expect(walkPath(`${sub}${path.sep}`).real).toBe(sub);
  });
});

describe.skipIf(WIN)("path-walk: a link target ending in a separator must reach a directory (POSIX ENOTDIR; Codex #357 R1 #4)", () => {
  const file = () => path.join(real, "x");
  it.each([
    ["an absolute target", (dir: string) => fs.symlinkSync(`${file()}/`, path.join(dir, "l"))],
    ["a relative target", (dir: string) => fs.symlinkSync(`${path.relative(dir, file())}/`, path.join(dir, "l"))],
    [
      "a nested link (l -> m/, m -> the file)",
      (dir: string) => {
        fs.symlinkSync(file(), path.join(dir, "m"));
        fs.symlinkSync("m/", path.join(dir, "l"));
      },
    ],
  ])("%s", (_label, make) => {
    const dir = fs.mkdtempSync(path.join(base, "tsep-"));
    make(dir);
    const l = path.join(dir, "l");
    expect(() => fs.statSync(l), "the kernel refuses it").toThrow(/ENOTDIR/);
    expect(reason(() => walkPath(l, { allowMissing: true }))).toBe("not-a-directory");
  });
  it("known-good twin: a target `dir/` reaching a directory resolves", () => {
    const dir = fs.mkdtempSync(path.join(base, "tsep-"));
    fs.symlinkSync(`${sub}/`, path.join(dir, "l"));
    expect(walkPath(path.join(dir, "l")).real).toBe(sub);
  });
});

describe.skipIf(WIN)("path-walk: `.` and `..` are looked up, so they need search permission (Codex #357 R1 #5)", () => {
  // Root bypasses directory permissions, so this cannot be measured as root: skipped there, and the log says so.
  const root = process.getuid?.() === 0;
  if (root) console.error("[path-walk] running as root: the search-permission cases are NOT measured");
  (root ? it.skip : it).each([
    ["blocked/.", (b: string) => `${b}/.`],
    ["blocked/../x", (b: string) => `${b}/../x`],
  ])("%s, with no search permission on blocked, is unreadable (as the kernel says)", (_label, spell) => {
    const b = fs.mkdtempSync(path.join(base, "blocked-"));
    fs.chmodSync(b, 0o600);
    try {
      expect(() => fs.statSync(spell(b)), "the kernel refuses it").toThrow(/EACCES/);
      expect(reason(() => walkPath(spell(b), { allowMissing: true }))).toBe("unreadable");
    } finally {
      fs.chmodSync(b, 0o700);
    }
  });
  it("known-good twin: with search permission both resolve", () => {
    const b = fs.mkdtempSync(path.join(base, "open-"));
    expect(walkPath(`${b}/.`).real).toBe(b);
    expect(walkPath(`${b}/../x`).real).toBe(path.join(base, "x"));
  });
});

// ---- the fs seam: Windows forms and failures, on every OS ------------------------------------------------------------

/** An absolute path in the fake fs's own flavour (the fake is win32-shaped on Windows, posix elsewhere). */
function abs(name: string): string {
  return WIN ? `C:\\f\\${name}` : `/f/${name}`;
}

type Flavour = "win32" | "posix";
function stat(kind: "dir" | "file" | "link", ino: bigint = 1n): WalkStat {
  return {
    uid: 0,
    mode: kind === "dir" ? 0o40755 : 0o100644,
    dev: 1n,
    ino,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "link",
  };
}
/** Directories, files and links by exact spelling; every ancestor of a listed path is a directory; anything else ENOENT. */
function fakeFs(flavour: Flavour, spec: { links?: Record<string, string>; files?: string[]; dirs?: string[]; unreadable?: string[]; native?: Record<string, string>; inos?: Record<string, bigint> }): WalkFs {
  const P = flavour === "win32" ? path.win32 : path.posix;
  const dirs = new Set<string>(spec.dirs ?? []);
  const addAncestors = (p: string) => {
    for (let d = P.dirname(p); ; d = P.dirname(d)) {
      dirs.add(d);
      if (d === P.dirname(d)) break;
    }
  };
  for (const p of [...Object.keys(spec.links ?? {}), ...(spec.files ?? []), ...(spec.dirs ?? [])]) addAncestors(p);
  const enoent = (p: string) => Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
  /** A lookup through a trailing `.` or `..` (the walk looks dots up): the fake resolves it on its own spellings. */
  const dots = (p: string): string => {
    const sep = flavour === "win32" ? "\\" : "/";
    if (p.endsWith(`${sep}..`)) return P.dirname(p.slice(0, -3));
    if (p.endsWith(`${sep}.`)) return p.slice(0, -2) || sep;
    return p;
  };
  return {
    lstatSync(p) {
      p = dots(p);
      if (spec.unreadable?.includes(p)) throw Object.assign(new Error(`EACCES ${p}`), { code: "EACCES" });
      if (spec.links && p in spec.links) return stat("link");
      if (spec.files?.includes(p)) return stat("file", spec.inos?.[p] ?? 1n);
      if (dirs.has(p)) return stat("dir");
      throw enoent(p);
    },
    readlinkSync(p) {
      p = dots(p);
      if (spec.links && p in spec.links) return spec.links[p];
      throw Object.assign(new Error(`EINVAL ${p}`), { code: "EINVAL" });
    },
    realpathNativeSync(p) {
      if (spec.native && p in spec.native) return spec.native[p];
      throw enoent(p);
    },
  };
}

describe("path-walk: Windows forms through the fs seam (every OS; ASSUMED shape of the real APIs, see the real-fs tests)", () => {
  const W = { platform: "win32" as const };
  it("a drive-absolute path is walked from its drive root", () => {
    const fake = fakeFs("win32", { files: ["C:\\a\\b.txt"] });
    const w = walkPath("C:\\a\\b.txt", { ...W, fs: fake });
    expect(w.real).toBe("C:\\a\\b.txt");
    expect(w.entries.map((e) => e.path)).toEqual(["C:\\", "C:\\a", "C:\\a\\b.txt"]);
  });
  it("a UNC path is walked from its share root", () => {
    const fake = fakeFs("win32", { files: ["\\\\srv\\share\\a\\b.txt"], dirs: ["\\\\srv\\share\\"] });
    const w = walkPath("\\\\srv\\share\\a\\b.txt", { ...W, fs: fake });
    expect(w.entries[0].path).toBe("\\\\srv\\share\\");
    expect(w.real).toBe("\\\\srv\\share\\a\\b.txt");
  });
  it("\\\\?\\C:\\ and \\\\?\\UNC\\ are rewritten to the plain form", () => {
    const fake = fakeFs("win32", { files: ["C:\\a\\b.txt", "\\\\srv\\share\\c.txt"], dirs: ["\\\\srv\\share\\"] });
    expect(walkPath("\\\\?\\C:\\a\\b.txt", { ...W, fs: fake }).real).toBe("C:\\a\\b.txt");
    expect(walkPath("\\\\?\\UNC\\srv\\share\\c.txt", { ...W, fs: fake }).real).toBe("\\\\srv\\share\\c.txt");
  });
  it.each([
    ["a device path", "\\\\.\\PhysicalDrive0"],
    ["a volume GUID path", "\\\\?\\Volume{0b1c}\\x"],
    ["a drive-relative path", "C:x\\y"],
    ["a root-relative path", "\\x\\y"],
  ])("%s is unsupported (fail closed)", (_label, p) => {
    expect(reason(() => walkPath(p, { ...W, fs: fakeFs("win32", {}), cwd: "C:\\cwd" }))).toBe("unsupported");
  });
  it("a junction is followed like a link, its \\\\?\\ target rewritten; a `..` after it is LEXICAL (as Windows does)", () => {
    const fake = fakeFs("win32", { links: { "C:\\j": "\\\\?\\C:\\real\\sub" }, files: ["C:\\real\\sub\\y", "C:\\x"] });
    const w = walkPath("C:\\j\\y", { ...W, fs: fake });
    expect(w.real).toBe("C:\\real\\sub\\y");
    expect(w.entries.find((e) => e.path === "C:\\j")?.resolved).toBe("C:\\real\\sub");
    expect(walkPath("C:\\j\\..\\x", { ...W, fs: fake }).real).toBe("C:\\x");
  });
  it("a \\\\?\\ path holding . or .. is unsupported (Windows does not normalize it)", () => {
    expect(reason(() => walkPath("\\\\?\\C:\\a\\..\\b", { ...W, fs: fakeFs("win32", { files: ["C:\\b"] }) }))).toBe("unsupported");
  });
  it("an 8.3 short name is expanded through the OS resolver to the same directory's long name", () => {
    const fake = fakeFs("win32", { dirs: ["C:\\Users\\RUNNER~1", "C:\\Users\\runneradmin\\t"], native: { "C:\\Users\\RUNNER~1": "C:\\Users\\runneradmin" } });
    expect(walkPath("C:\\Users\\RUNNER~1\\t", { ...W, fs: fake }).real).toBe("C:\\Users\\runneradmin\\t");
  });
  it("an 8.3 short name that expands OUTSIDE its directory, or cannot be expanded, is unsupported", () => {
    const elsewhere = fakeFs("win32", { dirs: ["C:\\Users\\RUNNER~1"], native: { "C:\\Users\\RUNNER~1": "D:\\other\\runneradmin" } });
    expect(reason(() => walkPath("C:\\Users\\RUNNER~1", { ...W, fs: elsewhere }))).toBe("unsupported");
    const opaque = fakeFs("win32", { dirs: ["C:\\Users\\RUNNER~1"] });
    expect(reason(() => walkPath("C:\\Users\\RUNNER~1", { ...W, fs: opaque }))).toBe("unsupported");
  });
  // Codex #357 R1 #1: a link TARGET is checked like the input. Windows substitutes a relative target lexically
  // against the link's directory, which no native test here pins, so a target holding `.` or `..` is refused.
  it.each([
    ["a relative target holding ..", "j\\..\\x"],
    ["a relative target holding .", ".\\x"],
    ["a \\\\?\\ target holding ..", "\\\\?\\C:\\a\\..\\x"],
    ["a target component with a trailing period", "x."],
    ["a target component with a trailing space", "x "],
    ["a target that is a device path", "\\\\.\\PIPE\\x"],
    ["a target naming a reserved device", "NUL"],
  ])("a link whose target is %s is unsupported", (_label, target) => {
    const fake = fakeFs("win32", { links: { "C:\\b\\link": target, "C:\\b\\j": "C:\\other\\sub" }, files: ["C:\\b\\x", "C:\\x", "C:\\other\\x"], dirs: ["C:\\other\\sub", "C:\\a"] });
    expect(reason(() => walkPath("C:\\b\\link", { ...W, fs: fake }))).toBe("unsupported");
  });
  it("known-good twin: a plain relative target resolves against the link's directory", () => {
    const fake = fakeFs("win32", { links: { "C:\\b\\link": "sub\\y" }, files: ["C:\\b\\sub\\y"] });
    expect(walkPath("C:\\b\\link", { ...W, fs: fake }).real).toBe("C:\\b\\sub\\y");
  });
  // Codex #357 R1 #3: the Win32 API trims a trailing period or space (node's fs does not: MEASURED), maps reserved
  // device names, and opens an alternate data stream through `name:stream`; the \\?\ namespace does none of that. No
  // spelling with such a component is walked: each is refused, in the input and in a target.
  it.each([
    ["a trailing period", "C:\\safe\\config.json."],
    ["a trailing space", "C:\\safe\\config.json "],
    ["a reserved device name", "C:\\safe\\NUL"],
    ["a reserved device name with an extension", "C:\\safe\\com1.txt"],
    ["an alternate data stream", "C:\\safe\\config.json:evil"],
    ["a trailing period inside \\\\?\\", "\\\\?\\C:\\safe\\config.json."],
  ])("%s is unsupported", (_label, p) => {
    const fake = fakeFs("win32", { files: ["C:\\safe\\config.json"] });
    expect(reason(() => walkPath(p, { ...W, fs: fake, allowMissing: true }))).toBe("unsupported");
  });
  // Codex #357 R2 #3: a reserved device name with ANY extension suffix is the device (Microsoft: `NUL.tar.gz` is
  // `NUL`), in the input, a relative target, an absolute target and the \\?\ namespace alike.
  it.each([
    ["input: NUL.tar.gz", "C:\\safe\\NUL.tar.gz"],
    ["input: COM1.log.old", "C:\\safe\\COM1.log.old"],
    ["input: lpt9.a.b.c", "C:\\safe\\lpt9.a.b.c"],
    ["input in the \\\\?\\ namespace: NUL.tar.gz", "\\\\?\\C:\\safe\\NUL.tar.gz"],
  ])("a reserved name with several extensions is unsupported, %s", (_label, p) => {
    expect(reason(() => walkPath(p, { ...W, fs: fakeFs("win32", { files: ["C:\\safe\\x"] }), allowMissing: true }))).toBe("unsupported");
  });
  it.each([
    ["a relative target", "NUL.tar.gz"],
    ["an absolute target", "C:\\x\\COM1.log.old"],
    ["a \\\\?\\ target", "\\\\?\\C:\\x\\AUX.a.b"],
  ])("a reserved name with several extensions is unsupported in %s", (_label, target) => {
    const fake = fakeFs("win32", { links: { "C:\\b\\link": target }, dirs: ["C:\\x"] });
    expect(reason(() => walkPath("C:\\b\\link", { ...W, fs: fake, allowMissing: true }))).toBe("unsupported");
  });
  // Ruled on #357 R2 (D3): the extended / device namespaces are accepted ONLY in their MEASURED canonical
  // backslash spelling (\\?\<drive>:\ and \\?\UNC\, pinned by the native test below). A forward or mixed separator,
  // \\.\, \??\ or any other unmeasured form is refused BEFORE any normalization, in the input and in a link target.
  it.each([
    ["\\\\?\\ with a forward slash inside", "\\\\?\\C:\\safe/x"],
    ["\\\\?\\ spelled with forward slashes", "//?/C:/safe/x"],
    ["\\\\?\\ with a mixed prefix", "\\\\?/C:\\safe\\x"],
    ["\\\\?\\UNC\\ with a forward slash", "\\\\?\\UNC\\srv/share\\x"],
    ["the NT object namespace \\??\\", "\\??\\C:\\safe\\x"],
    ["the device namespace \\\\.\\ to a drive", "\\\\.\\C:\\safe\\x"],
    ["\\\\?\\ to a volume GUID", "\\\\?\\Volume{0b1c}\\x"],
  ])("an extended spelling outside the measured canonical form is unsupported: %s", (_label, p) => {
    const fake = fakeFs("win32", { files: ["C:\\safe\\x", "\\\\srv\\share\\x"], dirs: ["\\\\srv\\share\\"] });
    expect(reason(() => walkPath(p, { ...W, fs: fake, allowMissing: true }))).toBe("unsupported");
  });
  it.each([
    ["a \\\\?\\ target with a forward slash", "\\\\?\\C:\\safe/x"],
    ["a \\??\\ target", "\\??\\C:\\safe\\x"],
  ])("the same holds for a link target: %s", (_label, target) => {
    const fake = fakeFs("win32", { links: { "C:\\b\\link": target }, files: ["C:\\safe\\x"] });
    expect(reason(() => walkPath("C:\\b\\link", { ...W, fs: fake, allowMissing: true }))).toBe("unsupported");
  });
  it("known-good twins: the canonical \\\\?\\<drive>:\\ and \\\\?\\UNC\\ spellings are walked as their plain form", () => {
    const fake = fakeFs("win32", { files: ["C:\\safe\\x", "\\\\srv\\share\\x"], dirs: ["\\\\srv\\share\\"] });
    expect(walkPath("\\\\?\\C:\\safe\\x", { ...W, fs: fake }).real).toBe("C:\\safe\\x");
    expect(walkPath("\\\\?\\UNC\\srv\\share\\x", { ...W, fs: fake }).real).toBe("\\\\srv\\share\\x");
  });
  it("known-good twins: an inner period, a leading period, a name that only starts like a device", () => {
    const ok = ["C:\\safe\\a.b", "C:\\safe\\.hidden", "C:\\safe\\nullable", "C:\\safe\\com10", "C:\\safe\\nullable.tar.gz", "C:\\safe\\com10.log.old", "C:\\safe\\a.nul"];
    const fake = fakeFs("win32", { files: ok });
    for (const p of ok) expect(walkPath(p, { ...W, fs: fake }).real).toBe(p);
  });
  it("known-good twin: a ~ not followed by a digit is an ordinary name", () => {
    const fake = fakeFs("win32", { dirs: ["C:\\a~b"] });
    expect(walkPath("C:\\a~b", { ...W, fs: fake }).real).toBe("C:\\a~b");
  });
});

describe("path-walk: failures are named, never raw (fs seam)", () => {
  const flavour: Flavour = WIN ? "win32" : "posix";
  const platform = WIN ? ("win32" as const) : ("linux" as const);
  it("an lstat that fails for any reason but absence is unreadable, even with allowMissing", () => {
    const fake = fakeFs(flavour, { files: [abs("x")], unreadable: [abs("x")] });
    expect(reason(() => walkPath(abs("x"), { fs: fake, platform, allowMissing: true }))).toBe("unreadable");
  });
  it("41 links through the seam are a loop; 40 resolve", () => {
    const links: Record<string, string> = {};
    for (let i = 0; i < MAX_LINKS + 1; i++) links[abs(`l${i}`)] = i === MAX_LINKS ? abs("end") : abs(`l${i + 1}`);
    const fake = fakeFs(flavour, { links, files: [abs("end")] });
    expect(walkPath(abs("l1"), { fs: fake, platform }).real).toBe(abs("end"));
    expect(reason(() => walkPath(abs("l0"), { fs: fake, platform }))).toBe("loop");
  });
  it("an empty path or one holding NUL is unsupported", () => {
    expect(reason(() => walkPath(""))).toBe("unsupported");
    expect(reason(() => walkPath("a\0b"))).toBe("unsupported");
  });
});

describe("path-walk on the REAL Windows filesystem (the Windows CI job; skipped elsewhere)", () => {
  it.skipIf(!WIN)("a real junction is followed, and a `..` after it is lexical, as the kernel resolves it (MEASURED on windows-2022)", () => {
    // `alias` is a junction here (dirLink).
    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(walkPath(path.join(alias, "leaf")).real).toBe(path.join(sub, "leaf"));
    expect(fs.readFileSync(`${alias}\\..\\x`, "utf-8")).toBe("base/x");
    expect(walkPath(`${alias}\\..\\x`).real).toBe(path.join(base, "x"));
  });
  it.skipIf(!WIN)("the canonical \\\\?\\<drive>:\\ spelling: node opens the same file through it, and the walk lands on its plain form (MEASURED)", () => {
    const f = path.join(base, "pw-ext");
    fs.writeFileSync(f, "ext");
    expect(fs.readFileSync(`\\\\?\\${f}`, "utf-8"), "node reads the file through \\\\?\\").toBe("ext");
    expect(walkPath(`\\\\?\\${f}`).real).toBe(f);
    // What node's readlink returns for a real junction (the form a link TARGET takes), logged for the record.
    console.error(`[path-walk] win32: readlink of a junction -> ${JSON.stringify(fs.readlinkSync(alias))}`);
  });
  it.skipIf(!WIN)("a trailing period is refused whatever node's open does with it (what node does is MEASURED and logged)", () => {
    const f = path.join(base, "pw-tail");
    fs.writeFileSync(f, "tail");
    let opened: string;
    try {
      opened = fs.readFileSync(`${f}.`, "utf-8") === "tail" ? "opens the file without the period" : "opens another file";
    } catch (err) {
      opened = (err as NodeJS.ErrnoException).code ?? "error";
    }
    // MEASURED on windows-2022 (6e9cc36): ENOENT. The Win32 API itself trims (Microsoft's documentation), so a
    // non-node program may open the file the walk would call missing: the spelling is refused, never judged.
    console.error(`[path-walk] win32: node reading "<file>." -> ${opened}`);
    expect(reason(() => walkPath(`${f}.`, { allowMissing: true }))).toBe("unsupported");
  });
  // MEASURED (fbca6f9, windows-2022): the test temp dir lives under the run's private HOME, so it carries NO short
  // name; C:\PROGRA~1 is probed too. Each prints whether it exercised an expansion: a run where neither did has
  // MEASURED nothing about real 8.3 names, and the job log says so.
  it.skipIf(!WIN)("a real 8.3 short name (temp dir, C:\\PROGRA~1) is expanded to the OS's own long spelling", () => {
    const raw = fs.mkdtempSync(path.join(os.tmpdir(), "pw-short-"));
    try {
      for (const p of [raw, "C:\\PROGRA~1"]) {
        const exists = fs.existsSync(p);
        console.error(`[path-walk] win32: ${JSON.stringify(p)} exists=${exists}, short-name expansion exercised = ${exists && /~\d/.test(p)}`);
        if (!exists) continue;
        const w = walkPath(p);
        expect(/~\d/.test(w.real)).toBe(false);
        expect(comparePaths(w.real, fs.realpathSync.native(p))).toBe("same");
      }
    } finally {
      fs.rmSync(raw, { recursive: true, force: true });
    }
  });
});

describe("path-walk: parity with the operator tripwire's second copy (tests/_setup/operator-tripwire-preload.mjs)", () => {
  // Where the two DIFFER (not compared here): a loop or an unreadable component (the tripwire's realpath catch-all
  // reads it as missing and joins lexically; the walk fails closed), a component below a file, and on WINDOWS a `..`
  // after a junction (the tripwire steps up physically; Windows, and the walk, lexically: MEASURED d727efc). Ticketed:
  // two implementations of the walk, because the tripwire is a plain-JS preload that cannot import src.
  it.each([
    ["a plain path", () => path.join(plain, "x")],
    ["a missing tail below a link", () => path.join(alias, "missing", "leaf")],
    ["a `..` cancelling a missing name", () => `${real}${path.sep}nope${path.sep}..${path.sep}x`],
  ] as Array<[string, () => string]>)("%s", (_label, spell) => {
    const p = spell();
    expect(walkPath(p, { allowMissing: true }).real).toBe(canonicalPath(p, false));
  });
  it.skipIf(WIN)("`..` after a symlinked directory (POSIX only: on Windows the kernel and the walk resolve it lexically, the tripwire physically; ticketed)", () => {
    const p = `${alias}${path.sep}..${path.sep}x`;
    expect(walkPath(p, { allowMissing: true }).real).toBe(canonicalPath(p, false));
  });
});
