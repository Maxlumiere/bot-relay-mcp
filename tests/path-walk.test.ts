// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * src/path-walk.ts: THE path walk's contract, each clause with its known-good twin.
 *
 *   - `..` after a symlinked directory steps up PHYSICALLY (twin: a plain directory, where lexical and physical agree);
 *   - more than 40 links fail CLOSED as "loop" (twin: exactly 40 resolve), and a 2-link cycle is a loop;
 *   - a case-variant spelling maps to the SAME key on a case-insensitive volume (macOS and Windows CI), and to a
 *     DIFFERENT one on a case-sensitive volume (Linux CI); twin: a different name is always a different key;
 *   - a missing tail lands where a create-the-parents writer would (twin: without allowMissing it is "missing");
 *   - every hop is reported (each link with where it led);
 *   - a component below a file is "not-a-directory";
 *   - Windows forms: drive / UNC / \\?\ / device / drive-relative / root-relative / junction / 8.3 short name, through
 *     the fs seam on every OS, and the junction and the short name for REAL on the Windows job (each test says which).
 *   - parity with the operator tripwire's second copy (tests/_setup/operator-tripwire-preload.mjs canonicalPath) on the
 *     fixtures where both are defined; where they differ by design is listed in that test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { walkPath, pathKey, samePath, caseInsensitiveAt, PathWalkError, MAX_LINKS, type WalkFs, type WalkStat } from "../src/path-walk.js";
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

describe("path-walk: a case-variant spelling on a case-insensitive volume maps to the SAME key", () => {
  it("probes the volume, and folds exactly when it is case-insensitive", () => {
    const dir = path.join(base, "Case");
    fs.mkdirSync(path.join(dir, "Leaf"), { recursive: true });
    const variant = path.join(base, "CASE", "leaf");
    const insensitive = caseInsensitiveAt(dir);
    // MEASURED per CI OS (the job log carries this line): macOS and Windows runners are case-insensitive, Linux is not.
    console.error(`[path-walk] ${process.platform}: case-insensitive volume at the fixture = ${insensitive}`);
    if (process.env.CI && (process.platform === "darwin" || WIN)) expect(insensitive).toBe(true);
    if (process.env.CI && process.platform === "linux") expect(insensitive).toBe(false);
    const k1 = pathKey(path.join(dir, "Leaf"));
    const k2 = pathKey(variant);
    expect(k1.folded).toBe(insensitive);
    expect(k1.key === k2.key).toBe(insensitive);
    expect(samePath(path.join(dir, "Leaf"), variant)).toBe(insensitive);
    // On a case-insensitive volume the kernel agrees: both spellings are one inode.
    if (insensitive) expect(fs.statSync(variant).ino).toBe(fs.statSync(path.join(dir, "Leaf")).ino);
  });
  it("the same holds for a MISSING tail below the variant spelling", () => {
    const insensitive = caseInsensitiveAt(path.join(base, "Case"));
    expect(samePath(path.join(base, "Case", "nope", "config.json"), path.join(base, "CASE", "NOPE", "Config.json"))).toBe(insensitive);
  });
  it("known-good twin: a different name is a different key on every volume", () => {
    expect(samePath(path.join(base, "Case", "Leaf"), path.join(base, "Case", "Leaf2"))).toBe(false);
  });
});

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
    ["file/..", (f: string) => `${f}${path.sep}..`],
    ["file/ (trailing separator)", (f: string) => `${f}${path.sep}`],
  ])("%s", (_label, spell) => {
    expect(reason(() => walkPath(spell(path.join(real, "x")), { allowMissing: true }))).toBe("not-a-directory");
  });
  it("known-good twin: a trailing separator on a directory is fine", () => {
    expect(walkPath(`${sub}${path.sep}`).real).toBe(sub);
  });
});

// ---- the fs seam: Windows forms and failures, on every OS ------------------------------------------------------------

/** An absolute path in the fake fs's own flavour (the fake is win32-shaped on Windows, posix elsewhere). */
function abs(name: string): string {
  return WIN ? `C:\\f\\${name}` : `/f/${name}`;
}

type Flavour = "win32" | "posix";
function stat(kind: "dir" | "file" | "link", ino = 1): WalkStat {
  return {
    uid: 0,
    mode: kind === "dir" ? 0o40755 : 0o100644,
    dev: 1,
    ino,
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "link",
  };
}
/** Directories, files and links by exact spelling; every ancestor of a listed path is a directory; anything else ENOENT. */
function fakeFs(flavour: Flavour, spec: { links?: Record<string, string>; files?: string[]; dirs?: string[]; unreadable?: string[]; native?: Record<string, string> }): WalkFs {
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
  return {
    lstatSync(p) {
      if (spec.unreadable?.includes(p)) throw Object.assign(new Error(`EACCES ${p}`), { code: "EACCES" });
      if (spec.links && p in spec.links) return stat("link");
      if (spec.files?.includes(p)) return stat("file");
      if (dirs.has(p)) return stat("dir");
      throw enoent(p);
    },
    readlinkSync(p) {
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
        expect(samePath(w.real, fs.realpathSync.native(p))).toBe(true);
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
