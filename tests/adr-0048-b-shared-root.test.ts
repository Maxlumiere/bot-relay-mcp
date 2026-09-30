// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0048 PR B — the SHARED-ROOT OWNERSHIP RULE (ssh StrictModes style).
 *
 * /tmp and /private/tmp are approved roots AND world-writable: another local user
 * can pre-plant a component there (the classic /tmp symlink attack). Below a
 * shared root, every EXISTING path component must be owned by the current uid
 * (or root) and not group- or other-writable, and the shared root itself must
 * carry the sticky bit; otherwise the path is refused (the resolver's error
 * kind). $HOME and /var/folders are per-user roots: unaffected.
 *
 * Ownership and the sticky bit cannot be produced without root, so those rows
 * inject the stat (vi.spyOn on fs.lstatSync, one path at a time); the
 * group-writable row is real (chmod).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { checkContainment } = await import("../src/approved-roots.js");
const inst = await import("../src/instance.js");

const UID = typeof process.getuid === "function" ? process.getuid() : -1;
const IS_ROOT = UID === 0;
// A real directory under the SHARED root (on macOS /tmp → /private/tmp).
const SHARED_DIR = fs.realpathSync(fs.mkdtempSync("/tmp/adr0048s-"));
const SHARED_ROOT = fs.realpathSync("/tmp");
// A per-user root that is NOT shared: HOME is pinned to a directory in the repo's
// gitignored cache (never /tmp, which is the OS temp dir on Linux), so the shared
// dir is outside HOME and HOME's own rows exercise the per-user rule.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(path.join(REPO_ROOT, "node_modules", ".cache"), { recursive: true });
const PER_USER = fs.realpathSync(fs.mkdtempSync(path.join(REPO_ROOT, "node_modules", ".cache", "adr0048u-")));
let savedHome: string | undefined;
let savedDb: string | undefined;
beforeEach(() => {
  savedHome = process.env.HOME;
  savedDb = process.env.RELAY_DB_PATH;
  process.env.HOME = PER_USER;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = savedHome;
  if (savedDb === undefined) delete process.env.RELAY_DB_PATH;
  else process.env.RELAY_DB_PATH = savedDb;
});
afterAll(() => {
  fs.rmSync(SHARED_DIR, { recursive: true, force: true });
  fs.rmSync(PER_USER, { recursive: true, force: true });
});

/** Make fs.lstatSync report `patch` for exactly one path (every other path is real). */
function patchLstat(target: string, patch: Partial<fs.Stats>) {
  const real = fs.lstatSync.bind(fs);
  return vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    const st = (real as (...a: unknown[]) => fs.Stats)(p, ...rest);
    if (String(p) !== target) return st;
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, patch);
  }) as never);
}
const refused = (p: string, why: RegExp) => {
  const c = checkContainment(p);
  expect(c.ok, JSON.stringify(c)).toBe(false);
  if (!c.ok) expect(c.reason).toMatch(why);
};

describe.skipIf(UID < 0)("ADR-0048 PR B — below a SHARED root, every existing component must be yours and not writable by others", () => {
  it("TWIN: your own 0700 directory under /tmp (and a DB not created yet) → accepted", () => {
    const c = checkContainment(path.join(SHARED_DIR, "relay.db"));
    expect(c).toMatchObject({ ok: true, exists: false });
  });
  it("a component owned by ANOTHER uid → refused (injected stat)", () => {
    patchLstat(SHARED_DIR, { uid: UID + 1 });
    refused(path.join(SHARED_DIR, "relay.db"), /owned by uid/);
  });
  it("TWIN: a component owned by root → accepted (injected stat)", () => {
    patchLstat(SHARED_DIR, { uid: 0 });
    expect(checkContainment(path.join(SHARED_DIR, "relay.db")).ok).toBe(true);
  });
  it("a GROUP-writable component → refused (real chmod)", () => {
    const d = path.join(SHARED_DIR, "gw");
    fs.mkdirSync(d);
    fs.chmodSync(d, 0o775);
    refused(path.join(d, "relay.db"), /group- or other-writable/);
  });
  it("an OTHER-writable existing DB file → refused (the final component counts too)", () => {
    const f = path.join(SHARED_DIR, "ow.db");
    fs.writeFileSync(f, "");
    fs.chmodSync(f, 0o606);
    refused(f, /group- or other-writable/);
  });
  it("the shared root WITHOUT the sticky bit → refused (injected stat)", () => {
    const st = fs.lstatSync(SHARED_ROOT);
    patchLstat(SHARED_ROOT, { mode: st.mode & ~0o1000 });
    refused(path.join(SHARED_DIR, "relay.db"), /sticky bit/);
  });
  it("a component whose stat FAILS (EACCES) → refused, never assumed safe", () => {
    const real = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === SHARED_DIR) throw Object.assign(new Error("EACCES: injected"), { code: "EACCES" });
      return (real as (...a: unknown[]) => fs.Stats)(p, ...rest);
    }) as never);
    refused(path.join(SHARED_DIR, "relay.db"), /EACCES/);
  });
  it("the resolver returns the ERROR kind for such a path (RELAY_DB_PATH under a group-writable /tmp dir)", () => {
    const d = path.join(SHARED_DIR, "gw2");
    fs.mkdirSync(d);
    fs.chmodSync(d, 0o770);
    process.env.RELAY_DB_PATH = path.join(d, "relay.db");
    expect(inst.resolveInstance()).toMatchObject({ kind: "error" });
  });
  it.skipIf(IS_ROOT)("TWIN: a per-user root is unaffected: a group-writable dir under it is accepted", () => {
    const d = path.join(PER_USER, "gw");
    fs.mkdirSync(d);
    fs.chmodSync(d, 0o775);
    expect(checkContainment(path.join(d, "relay.db")).ok).toBe(true);
  });
});

describe.skipIf(UID < 0)("Codex #288 R1 P1-1 — the rule covers EVERY traversed component (symlinks and their targets), not just the final path", () => {
  it("a FOREIGN-owned symlink in /tmp pointing at a safe target → refused (the link itself is a traversed component)", () => {
    const safe = path.join(SHARED_DIR, "safe1");
    fs.mkdirSync(safe);
    const link = path.join(SHARED_DIR, "foreign-link");
    fs.symlinkSync(safe, link);
    patchLstat(link, { uid: UID + 1 });
    refused(path.join(link, "relay.db"), /owned by uid/);
  });
  it("a /tmp link into ANOTHER user's per-user directory → refused (the target side is checked once the walk touched a shared root)", () => {
    const theirs = path.join(PER_USER, "their-dir");
    fs.mkdirSync(theirs);
    const link = path.join(SHARED_DIR, "to-theirs");
    fs.symlinkSync(theirs, link);
    patchLstat(theirs, { uid: UID + 1 });
    refused(path.join(link, "relay.db"), /owned by uid/);
  });
  it("a FOREIGN-owned /tmp parent holding a symlink to a safe /tmp target → refused (the parent is traversed)", () => {
    const safe = path.join(SHARED_DIR, "safe2");
    fs.mkdirSync(safe);
    const parent = path.join(SHARED_DIR, "foreign-parent");
    fs.mkdirSync(parent);
    fs.symlinkSync(safe, path.join(parent, "link"));
    patchLstat(parent, { uid: UID + 1 });
    refused(path.join(parent, "link", "relay.db"), /owned by uid/);
  });
  it("TWIN: your own /tmp link to your own /tmp target → accepted", () => {
    const safe = path.join(SHARED_DIR, "safe3");
    fs.mkdirSync(safe);
    const link = path.join(SHARED_DIR, "own-link");
    fs.symlinkSync(safe, link);
    expect(checkContainment(path.join(link, "relay.db")).ok).toBe(true);
  });
  it("TWIN: a symlink's OWN mode bits are ignored (Linux links are always 0777); its owner is not", () => {
    const safe = path.join(SHARED_DIR, "safe4");
    fs.mkdirSync(safe);
    const link = path.join(SHARED_DIR, "lax-link");
    fs.symlinkSync(safe, link);
    const st = fs.lstatSync(link);
    patchLstat(link, { mode: (st.mode & ~0o777) | 0o777 });
    expect(checkContainment(path.join(link, "relay.db")).ok).toBe(true);
  });
  it("TWIN: a walk that never touches a shared root is unaffected (a group-writable dir under a per-user root, reached by a link there)", () => {
    const d = path.join(PER_USER, "gw-target");
    fs.mkdirSync(d);
    fs.chmodSync(d, 0o775);
    const link = path.join(PER_USER, "link-to-gw");
    fs.symlinkSync(d, link);
    expect(checkContainment(path.join(link, "relay.db")).ok).toBe(true);
  });
});
