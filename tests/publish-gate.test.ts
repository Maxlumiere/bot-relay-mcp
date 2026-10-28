// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * scripts/publish-gate.mjs: a real `npm publish` is refused unless the tree PROVES it is a fresh release tree
 * (fail-closed), and the registry the login is checked against is the one npm uploads to.
 *   - decide(): every condition, alone, refuses with its own named reason; a qualifying set passes.
 *   - the gatherer, on a REAL git fixture (a bare origin, a main checkout, .worktrees/ beside it): the main
 *     checkout, a linked node_modules, a node_modules entry or a dist/ linked out of the tree, a dirty tree, HEAD
 *     not the remote's main, a copied / re-minted / edited marker and git unavailable are each refused; a fresh
 *     release worktree, minted before npm ci, passes. NOT CAUGHT (accident gate, named): a hard-linked file.
 *   - every subprocess (git and npm) runs in an ISOLATED env: a temp HOME, no system or global git config, hooks
 *     off, a private npm userconfig. gather() forwards that env to git.
 *   - the PROPERTY the registry check relies on, with the npm on PATH (its version is in the row's messages):
 *     with no publishConfig, `npm config get registry` run inside prepublishOnly names the registry npm would
 *     publish to (the one its own ENEEDAUTH refusal names), for a CLI --registry, both env spellings and .npmrc.
 *     Every registry is 127.0.0.1:1 (nothing listens) and there is no login, so npm stops before any upload.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { decide, gather, MARKER_NAME, OUTPUT_ROOTS } from "../scripts/publish-gate.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(REPO, "scripts", "publish-gate.mjs");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "publish-gate-")));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Facts = Record<string, unknown>;
const SHA = "a".repeat(40);
const MARKER = { v: 1, sha: SHA, minted_at: "2026-10-27T00:00:00.000Z", tree: "/ws/.worktrees/rel", git_dir: "/ws/main/.git/worktrees/rel" };
const qualifying = (): Facts => ({
  top: "/ws/.worktrees/rel",
  gitDir: "/ws/main/.git/worktrees/rel",
  commonDir: "/ws/main/.git",
  sanctionedRoot: "/ws/.worktrees",
  underSanctionedRoot: true,
  head: SHA,
  prodMarker: false,
  nodeModules: { root: "real", "extensions/vscode": "real" },
  nmLinksOut: [],
  outputs: [],
  dirty: [],
  remoteMain: SHA,
  remoteTag: null,
  marker: { ...MARKER },
  pkg: { name: "bot-relay-mcp", version: "9.9.9", publishConfigRegistry: null },
  workspaceEnv: null,
});
const checks = (f: Facts, mint = false) => (decide(f, { mint }) as Array<{ check: string; reason: string }>);

describe("decide(): each condition alone refuses, named; the qualifying set passes", () => {
  it("TWIN: a qualifying release tree → no refusal", () => {
    expect(checks(qualifying())).toEqual([]);
  });
  const cases: Array<[string, Facts, string, RegExp]> = [
    ["git unavailable (undecidable)", { gitError: "spawn git ENOENT" }, "git", /git could not be asked \(spawn git ENOENT\)/],
    ["the main checkout", { gitDir: "/ws/main/.git", marker: { ...MARKER, git_dir: "/ws/main/.git" } }, "worktree", /the main checkout, not a linked worktree/],
    ["a worktree outside the sanctioned root", { underSanctionedRoot: false }, "worktree", /not under the sanctioned worktree root \(\/ws\/\.worktrees\)/],
    ["the serving-tree marker", { prodMarker: true }, "prod-marker", /\.relay-prod-tree/],
    ["a linked root node_modules", { nodeModules: { root: "link", "extensions/vscode": "real" } }, "node_modules", /root node_modules is a link/],
    ["a missing extension node_modules", { nodeModules: { root: "real", "extensions/vscode": "absent" } }, "node_modules", /extensions\/vscode node_modules is missing/],
    ["a node_modules resolving outside the tree", { nodeModules: { root: "outside", "extensions/vscode": "real" } }, "node_modules", /resolves outside the tree/],
    ["a dirty tree", { dirty: [" M src/x.ts"] }, "clean", /not clean \(1 change\(s\), e\.g\.  M src\/x\.ts\)/],
    ["an unreadable status (undecidable)", { dirty: null, statusError: "boom" }, "clean", /status could not be read \(boom\)/],
    ["HEAD is not the remote's main", { remoteMain: "b".repeat(40) }, "head", /HEAD aaaaaaa is neither the remote's main \(bbbbbbb\) nor its tag v9\.9\.9 \(absent\)/],
    ["the remote unreadable (undecidable)", { remoteError: "Could not read from remote repository." }, "head", /remote's main could not be read/],
    ["no release marker", { marker: null }, "marker", /no release marker/],
    ["an unreadable marker", { marker: "unreadable" }, "marker", /could not be read/],
    ["a marker for another SHA", { marker: { ...MARKER, sha: "c".repeat(40) } }, "marker", /minted for ccccccc, not HEAD aaaaaaa/],
    ["a marker of an unknown version", { marker: { ...MARKER, v: 2 } }, "marker", /unknown version \(2\)/],
    ["a marker whose sha is not a full commit id", { marker: { ...MARKER, sha: "abc123" } }, "marker", /not a full commit id/],
    ["a marker whose minted_at is not an ISO time", { marker: { ...MARKER, minted_at: "yesterday" } }, "marker", /minted_at is not an ISO time/],
    ["a marker minted for ANOTHER tree (copied)", { marker: { ...MARKER, tree: "/ws/.worktrees/other" } }, "marker", /minted for another tree \(\/ws\/\.worktrees\/other\)/],
    ["a marker naming another git dir (copied)", { marker: { ...MARKER, git_dir: "/ws/main/.git/worktrees/other" } }, "marker", /names another git dir: it was copied/],
    ["a marker with no tree binding (the old shape)", { marker: { v: 1, sha: SHA, minted_at: MARKER.minted_at } }, "marker", /minted for another tree \(none\)/],
    ["a serving-tree marker that cannot be inspected", { prodMarker: "EACCES" }, "prod-marker", /could not be inspected \(EACCES\)/],
    ["a node_modules entry linked out of the tree", { nmLinksOut: ["node_modules/x → /elsewhere/x"] }, "node_modules", /1 node_modules entry is a link out of the tree \(e\.g\. node_modules\/x → \/elsewhere\/x\)/],
    ["node_modules entries that cannot be inspected", { nmScanError: "EACCES" }, "node_modules", /entries could not be inspected \(EACCES\)/],
    ["a build-output problem (named as found)", { outputs: ["dist/index.js is a link: the build would write through it"] }, "output", /^dist\/index\.js is a link: the build would write through it$/],
    ["publishConfig.registry", { pkg: { name: "bot-relay-mcp", version: "9.9.9", publishConfigRegistry: "https://r.test/" } }, "registry", /publishConfig\.registry: not supported/],
    ["a scoped name", { pkg: { name: "@x/bot-relay-mcp", version: "9.9.9", publishConfigRegistry: null } }, "registry", /is scoped/],
    ["a workspace publish", { workspaceEnv: "npm_config_workspace=a" }, "workspace", /workspace publish \(npm_config_workspace=a\)/],
    ["an unreadable package.json", { pkg: null }, "package", /package\.json could not be read/],
  ];
  for (const [label, over, check, reason] of cases) {
    it(`HARM: ${label} → refused [${check}]`, () => {
      const r = checks({ ...qualifying(), ...over });
      expect(r.map((x) => x.check), JSON.stringify(r)).toEqual([check]);
      expect(r[0].reason).toMatch(reason);
    });
  }
  it("HEAD at the remote's TAG v<version> (not main) qualifies; any other HEAD does not", () => {
    expect(checks({ ...qualifying(), remoteMain: "b".repeat(40), remoteTag: SHA })).toEqual([]);
    expect(checks({ ...qualifying(), remoteMain: "b".repeat(40), remoteTag: "d".repeat(40) }).map((x) => x.check)).toEqual(["head"]);
  });
  it("--mint: only an ABSENT or LINKED node_modules (before npm ci); installed, outside or uninspectable are refused; no marker may exist", () => {
    const fresh = { ...qualifying(), marker: null, outputs: [], nodeModules: { root: "link", "extensions/vscode": "absent" } };
    expect(checks(fresh, true)).toEqual([]);
    const r = checks({ ...fresh, nodeModules: { root: "real", "extensions/vscode": "outside" } }, true);
    expect(r.map((x) => x.check)).toEqual(["node_modules", "node_modules"]);
    expect(r[0].reason).toMatch(/already installed: mint the marker when the tree is created/);
    expect(r[1].reason).toMatch(/extensions\/vscode node_modules resolves outside the tree: a tree is minted before npm ci/);
    expect(checks({ ...fresh, nodeModules: { root: "error", "extensions/vscode": "absent" } }, true)[0].reason).toMatch(/could not be inspected/);
    const again = checks({ ...fresh, marker: { ...MARKER } }, true);
    expect(again.map((x) => x.check)).toEqual(["marker"]);
    expect(again[0].reason).toMatch(/already exists for this tree: a tree is minted once/);
  });
});

describe("OUTPUT_ROOTS is every path the gate's own build steps write (read from the build configs)", () => {
  it("the root tsconfig outDir, write-build-info's dist/, the extension's tsconfig outDir and its esbuild outfile are each under a root", () => {
    const under = (p: string) => OUTPUT_ROOTS.some((r: string) => p === r || p.startsWith(`${r}/`));
    const outDir = (f: string) => JSON.parse(fs.readFileSync(path.join(REPO, f), "utf8")).compilerOptions.outDir as string;
    expect(under(outDir("tsconfig.json"))).toBe(true);
    expect(under(path.posix.join("extensions/vscode", outDir("extensions/vscode/tsconfig.json")))).toBe(true);
    const esb = fs.readFileSync(path.join(REPO, "extensions", "vscode", "esbuild.config.mjs"), "utf8");
    const outs = [...esb.matchAll(/resolve\(__dirname, "([^"]+)"\)/g)].map((m) => m[1]).filter((p) => /^out\//.test(p));
    expect(outs.length, "esbuild writes under out/").toBeGreaterThan(0);
    for (const o of outs) expect(under(`extensions/vscode/${o}`), o).toBe(true);
    expect(fs.readFileSync(path.join(REPO, "scripts", "write-build-info.mjs"), "utf8")).toMatch(/const dist = path\.join\(install, "dist"\)/);
    expect(under("dist")).toBe(true);
  });
});

describe("the gatherer on a REAL git fixture (bare origin, main checkout, .worktrees/ beside it)", () => {
  // ISOLATED: no system or global git config (a real one could sign, route or hook), a temp HOME; hooks off.
  const ISO_HOME = path.join(TMP, "iso-home");
  fs.mkdirSync(ISO_HOME, { recursive: true });
  fs.writeFileSync(path.join(ISO_HOME, "gitconfig"), "");
  const ISO_ENV: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: ISO_HOME,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(ISO_HOME, "gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", "-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, env: ISO_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let n = 0;
  /** A workspace: ws/origin.git (bare), ws/main (its clone), ws/.worktrees/<name> (a linked worktree at origin/main).
   *  extIgnored: extensions/ is untracked and ignored (so a fixture can replace it with a link without dirtying the tree). */
  const workspace = (pkg: Record<string, unknown> = { name: "bot-relay-mcp", version: "9.9.9" }, { extIgnored = false } = {}) => {
    const ws = path.join(TMP, `ws${++n}`);
    fs.mkdirSync(ws);
    git(ws, "init", "--bare", "-q", "origin.git");
    git(ws, "clone", "-q", path.join(ws, "origin.git"), "main");
    const main = path.join(ws, "main");
    fs.writeFileSync(path.join(main, "package.json"), JSON.stringify(pkg));
    // No trailing slashes: a LINKED node_modules or dist is ignored too (the rows test the link, not the status).
    fs.writeFileSync(path.join(main, ".gitignore"), `node_modules\ndist\n${extIgnored ? "extensions\n" : ""}`);
    if (!extIgnored) {
      fs.mkdirSync(path.join(main, "extensions", "vscode"), { recursive: true });
      fs.writeFileSync(path.join(main, "extensions", "vscode", "package.json"), "{}");
    }
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "init");
    git(main, "push", "-q", "origin", "HEAD:main");
    const tree = path.join(ws, ".worktrees", "rel");
    git(main, "worktree", "add", "-q", "--detach", tree, "origin/main");
    return { ws, main, tree };
  };
  const install = (tree: string) => {
    for (const d of [".", "extensions/vscode"]) fs.mkdirSync(path.join(tree, d, "node_modules", ".bin"), { recursive: true });
  };
  const runGate = (cwd: string, args: string[] = [], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [GATE, ...args], { cwd, encoding: "utf8", env: { ...ISO_ENV, ...env } });
    return { status: r.status, err: r.stderr };
  };
  const refusals = (cwd: string, env: Record<string, string> = {}) =>
    decide(gather({ cwd, env: { ...ISO_ENV, ...env } })) as Array<{ check: string; reason: string }>;
  const refusedChecks = (cwd: string, env: Record<string, string> = {}) => refusals(cwd, env).map((x) => x.check);
  /** A minted, installed tree that qualifies (the base each isolation row changes ONE thing in). */
  const qualifiedTree = () => {
    const w = workspace();
    expect(runGate(w.tree, ["--mint"]).status).toBe(0);
    install(w.tree);
    expect(refusedChecks(w.tree), "precondition: the tree qualifies").toEqual([]);
    return w;
  };
  const outsideDir = (tag: string) => {
    const d = path.join(TMP, `outside-${tag}-${++n}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  it("TWIN: a fresh release worktree, minted BEFORE npm ci, then installed → --check passes (exit 0); the marker lives in its private git dir", () => {
    const { tree } = workspace();
    const mint = runGate(tree, ["--mint"]);
    expect(mint.status, mint.err).toBe(0);
    const gitDir = git(tree, "rev-parse", "--absolute-git-dir");
    expect(JSON.parse(fs.readFileSync(path.join(gitDir, MARKER_NAME), "utf8")).sha).toBe(git(tree, "rev-parse", "HEAD"));
    expect(git(tree, "status", "--porcelain", "--untracked-files=all"), "the marker does not dirty the tree").toBe("");
    install(tree);
    const r = runGate(tree, ["--check"]);
    expect(r.status, r.err).toBe(0);
  });

  it("HARM: the MAIN checkout is refused [worktree]", () => {
    const { main } = workspace();
    install(main);
    expect(refusedChecks(main)).toContain("worktree");
    const r = runGate(main, ["--check"]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/\[worktree\] this is the main checkout/);
  });

  it("HARM: a worktree whose node_modules are LINKS to the main checkout (a worktree tool's default) is refused [node_modules]", () => {
    const { main, tree } = workspace();
    expect(runGate(tree, ["--mint"]).status).toBe(0);
    install(main);
    for (const d of [".", "extensions/vscode"]) fs.symlinkSync(path.join(main, d, "node_modules"), path.join(tree, d, "node_modules"), "junction");
    expect(refusedChecks(tree)).toEqual(["node_modules", "node_modules"]);
  });

  it("HARM: a DIRTY tree is refused [clean]; HEAD moved off the remote's main is refused [head] (and its marker no longer matches)", () => {
    const { tree } = workspace();
    expect(runGate(tree, ["--mint"]).status).toBe(0);
    install(tree);
    fs.writeFileSync(path.join(tree, "stray.txt"), "x");
    expect(refusedChecks(tree)).toEqual(["clean"]);
    fs.rmSync(path.join(tree, "stray.txt"));
    fs.writeFileSync(path.join(tree, "README.md"), "local change");
    git(tree, "add", "-A");
    git(tree, "commit", "-q", "-m", "local");
    expect(refusedChecks(tree)).toEqual(["head", "marker"]);
  });

  it("HARM: --mint is refused once real node_modules exist (the marker is minted at creation, before npm ci)", () => {
    const { tree } = workspace();
    install(tree);
    const r = runGate(tree, ["--mint"]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/NOT minting a release marker/);
    expect(r.err).toMatch(/already installed/);
  });

  it("HARM: git UNAVAILABLE (undecidable) is refused [git], never passed", () => {
    const { tree } = workspace();
    const emptyPath = path.join(TMP, "no-git-bin");
    fs.mkdirSync(emptyPath, { recursive: true });
    const r = runGate(tree, ["--check"], { PATH: emptyPath });
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/\[git\] git could not be asked/);
  });

  it("HARM: the remote UNREACHABLE (undecidable) is refused [head]", () => {
    const { ws, tree } = workspace();
    expect(runGate(tree, ["--mint"]).status).toBe(0);
    install(tree);
    fs.renameSync(path.join(ws, "origin.git"), path.join(ws, "origin-gone.git"));
    expect(refusedChecks(tree)).toEqual(["head"]);
  });

  it("HARM: a dist/ LINKED out of the tree is refused [output] (the build would write through it)", () => {
    const { tree } = qualifiedTree();
    fs.symlinkSync(outsideDir("dist"), path.join(tree, "dist"), "junction");
    expect(refusedChecks(tree)).toEqual(["output"]);
  });

  /** A qualified tree with a real, clean dist/ (files the build would overwrite). */
  const withDist = () => {
    const w = qualifiedTree();
    fs.mkdirSync(path.join(w.tree, "dist", "cli"), { recursive: true });
    fs.writeFileSync(path.join(w.tree, "dist", "cli", "bind.js"), "// built\n");
    return w;
  };
  it("TWIN: a real, clean dist/ (regular files, one link each) passes", () => {
    const { tree } = withDist();
    fs.writeFileSync(path.join(tree, "dist", "index.js"), "// built\n");
    expect(refusedChecks(tree)).toEqual([]);
  });
  it("HARM: dist/index.js LINKED into a fake serving tree is refused [output] (tsc would write the serving file)", () => {
    const { tree } = withDist();
    const serving = path.join(outsideDir("serving"), "dist");
    fs.mkdirSync(serving, { recursive: true });
    fs.writeFileSync(path.join(serving, "index.js"), "// the serving tree's live build\n");
    fs.symlinkSync(path.join(serving, "index.js"), path.join(tree, "dist", "index.js"));
    const r = refusals(tree);
    expect(r.map((x) => x.check)).toEqual(["output"]);
    expect(r[0].reason).toBe("dist/index.js is a link: the build would write through it");
  });
  it("HARM: a HARD-LINKED dist file is refused [output] (the build writes in place, into the shared inode)", () => {
    const { tree } = withDist();
    const shared = path.join(outsideDir("hard-out"), "index.js");
    fs.writeFileSync(shared, "// the serving tree's live build\n");
    fs.linkSync(shared, path.join(tree, "dist", "index.js"));
    const r = refusals(tree);
    expect(r.map((x) => x.check)).toEqual(["output"]);
    expect(r[0].reason).toMatch(/^dist\/index\.js is hard-linked \(2 links\)/);
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("HARM: an UNREADABLE dist/ entry is refused [output], never passed", () => {
    const { tree } = withDist();
    const locked = path.join(tree, "dist", "cli");
    fs.chmodSync(locked, 0o000);
    try {
      const r = refusals(tree);
      expect(r.map((x) => x.check)).toEqual(["output"]);
      expect(r[0].reason).toMatch(/^dist\/cli could not be read \(EACCES\)/);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
  it("HARM: the EXTENSION's build output (extensions/vscode/out) is scanned too: a link there is refused [output]", () => {
    const { tree } = qualifiedTree();
    fs.mkdirSync(path.join(tree, "extensions", "vscode", "out"), { recursive: true });
    fs.symlinkSync(path.join(outsideDir("ext-out"), "extension.js"), path.join(tree, "extensions", "vscode", "out", "extension.js"));
    expect(refusals(tree)[0]?.reason).toBe("extensions/vscode/out/extension.js is a link: the build would write through it");
  });

  it("HARM: a top-level node_modules entry, or a SCOPED one, LINKED out of the tree is refused [node_modules] (npm link's shape); TWIN: a link inside the tree passes", () => {
    const a = qualifiedTree();
    fs.symlinkSync(outsideDir("pkg"), path.join(a.tree, "node_modules", "linked-pkg"), "junction");
    const r = refusals(a.tree);
    expect(r.map((x) => x.check)).toEqual(["node_modules"]);
    expect(r[0].reason).toMatch(/node_modules\/linked-pkg → /);
    const b = qualifiedTree();
    fs.mkdirSync(path.join(b.tree, "extensions", "vscode", "node_modules", "@scope"), { recursive: true });
    fs.symlinkSync(outsideDir("scoped"), path.join(b.tree, "extensions", "vscode", "node_modules", "@scope", "pkg"), "junction");
    expect(refusals(b.tree)[0]?.reason).toMatch(/node_modules\/@scope\/pkg → /);
    const c = qualifiedTree();
    fs.mkdirSync(path.join(c.tree, "node_modules", "real-pkg"));
    fs.symlinkSync(path.join(c.tree, "node_modules", "real-pkg"), path.join(c.tree, "node_modules", "alias-pkg"), "junction");
    expect(refusedChecks(c.tree), "a link that stays inside the tree is not refused").toEqual([]);
  });

  it("NOT CAUGHT (a named exclusion, valid for READ-only inputs ONLY: node_modules; build outputs refuse it): a HARD-LINKED node_modules file passes", () => {
    const { tree } = qualifiedTree();
    const shared = path.join(outsideDir("hard"), "index.js");
    fs.writeFileSync(shared, "module.exports = 1;\n");
    fs.mkdirSync(path.join(tree, "node_modules", "hard-pkg"));
    fs.linkSync(shared, path.join(tree, "node_modules", "hard-pkg", "index.js"));
    expect(fs.statSync(shared).nlink, "precondition: the file really is shared").toBe(2);
    expect(refusedChecks(tree), "pinned: nlink > 1 would show the sharing, but the gate does not refuse it (an accident does not hard-link into another checkout)").toEqual([]);
  });

  // ACCEPTANCE of every other declared exclusion: each row passes the gate with ZERO refusals, so the exclusion is
  // pinned as behaviour, not only stated.
  it("NOT CAUGHT (named exclusion): a link BELOW the top level of node_modules passes, even resolving outside the tree", () => {
    const { tree } = qualifiedTree();
    fs.mkdirSync(path.join(tree, "node_modules", "pkg"));
    fs.symlinkSync(outsideDir("nested"), path.join(tree, "node_modules", "pkg", "linked-sub"), "junction");
    expect(fs.realpathSync(path.join(tree, "node_modules", "pkg", "linked-sub")).startsWith(tree), "precondition: it resolves outside").toBe(false);
    expect(refusedChecks(tree)).toEqual([]);
  });

  it("NOT CAUGHT (named exclusion): a package whose package.json \"main\" resolves OUTSIDE the tree passes (entry points are not resolved)", () => {
    const { tree } = qualifiedTree();
    const elsewhere = outsideDir("main");
    fs.writeFileSync(path.join(elsewhere, "index.js"), "module.exports = 1;\n");
    fs.mkdirSync(path.join(tree, "node_modules", "escaping-pkg"));
    fs.writeFileSync(path.join(tree, "node_modules", "escaping-pkg", "package.json"), JSON.stringify({ name: "escaping-pkg", main: path.relative(path.join(tree, "node_modules", "escaping-pkg"), path.join(elsewhere, "index.js")) }));
    expect(refusedChecks(tree)).toEqual([]);
  });
  it("NOT CAUGHT (named exclusion): an external node_modules/.bin link passes (below the top level)", () => {
    const { tree } = qualifiedTree();
    const tool = path.join(outsideDir("bin"), "tool");
    fs.writeFileSync(tool, "#!/bin/sh\n", { mode: 0o755 });
    fs.symlinkSync(tool, path.join(tree, "node_modules", ".bin", "tool"));
    expect(refusedChecks(tree)).toEqual([]);
  });

  /** A worktree created at the remote's tag v9.9.9 (not at main), minted and installed. */
  const atTag = (tagIt: (main: string) => void) => {
    const w = workspace();
    tagIt(w.main);
    git(w.main, "push", "-q", "origin", "refs/tags/v9.9.9");
    const tree = path.join(path.dirname(w.tree), "rel-tag");
    git(w.main, "worktree", "add", "-q", "--detach", tree, "v9.9.9^{commit}");
    expect(runGate(tree, ["--mint"]).status).toBe(0);
    install(tree);
    expect(git(tree, "rev-parse", "HEAD"), "precondition: HEAD is the tag, not the remote's main").not.toBe(git(tree, "ls-remote", "origin", "refs/heads/main").split("\t")[0]);
    return { ...w, tree };
  };
  it("ACCEPTED as written (the HEAD rule): a LIGHTWEIGHT tag AHEAD of main qualifies the tree", () => {
    const { tree } = atTag((main) => {
      fs.writeFileSync(path.join(main, "ahead.txt"), "ahead");
      git(main, "add", "-A");
      git(main, "commit", "-q", "-m", "ahead of main, not pushed to main");
      git(main, "tag", "v9.9.9"); // lightweight
    });
    expect(git(tree, "cat-file", "-t", "v9.9.9"), "precondition: lightweight (the tag names the commit itself)").toBe("commit");
    expect(refusedChecks(tree)).toEqual([]);
  });
  it("ACCEPTED as written (the HEAD rule): an annotated tag OFF main (a commit main never had) qualifies the tree", () => {
    const { tree, main } = atTag((m) => {
      const base = git(m, "rev-parse", "HEAD");
      fs.writeFileSync(path.join(m, "main-moves.txt"), "main moves on");
      git(m, "add", "-A");
      git(m, "commit", "-q", "-m", "main moves on");
      git(m, "push", "-q", "origin", "HEAD:main");
      git(m, "checkout", "-q", "--detach", base);
      fs.writeFileSync(path.join(m, "side.txt"), "a side line");
      git(m, "add", "-A");
      git(m, "commit", "-q", "-m", "off main");
      git(m, "tag", "-a", "-m", "release", "v9.9.9");
    });
    expect(spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { cwd: tree, env: ISO_ENV }).status, "precondition: not on main").not.toBe(0);
    expect(git(main, "cat-file", "-t", "v9.9.9"), "precondition: annotated").toBe("tag");
    expect(refusedChecks(tree)).toEqual([]);
  });
  it("ACCEPTED as written (trusted): a NON-DEFAULT origin URL that serves the same main qualifies the tree", () => {
    const { ws, main, tree } = qualifiedTree();
    const mirror = path.join(ws, "elsewhere", "mirror.git");
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    git(ws, "clone", "-q", "--bare", path.join(ws, "origin.git"), mirror);
    git(main, "remote", "set-url", "origin", mirror);
    expect(git(tree, "remote", "get-url", "origin"), "precondition: origin points elsewhere").toBe(mirror);
    expect(refusedChecks(tree)).toEqual([]);
  });

  it("HARM: --mint refuses a node_modules that a LINKED ANCESTOR routes outside the tree (state 'outside', not only 'real')", () => {
    const { tree } = workspace({ name: "bot-relay-mcp", version: "9.9.9" }, { extIgnored: true });
    const elsewhere = outsideDir("ext");
    fs.mkdirSync(path.join(elsewhere, "node_modules"));
    fs.mkdirSync(path.join(tree, "extensions"));
    fs.symlinkSync(elsewhere, path.join(tree, "extensions", "vscode"), "junction");
    const r = runGate(tree, ["--mint"]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/\[node_modules\] extensions\/vscode node_modules resolves outside the tree: a tree is minted before npm ci/);
  });

  it.skipIf(process.platform === "win32")("HARM: a DANGLING .relay-prod-tree link counts as the marker (existsSync would read it as absent)", () => {
    const { tree } = qualifiedTree();
    const p = path.join(tree, ".relay-prod-tree");
    fs.symlinkSync(path.join(TMP, "nowhere-at-all"), p);
    expect(fs.existsSync(p), "precondition: existsSync follows the link and says absent").toBe(false);
    expect(refusedChecks(tree)).toContain("prod-marker");
  });

  it("HARM: a marker COPIED from another worktree at the SAME SHA is refused (it names that tree and git dir)", () => {
    const { main, tree } = qualifiedTree();
    const other = path.join(path.dirname(tree), "rel2");
    git(main, "worktree", "add", "-q", "--detach", other, "origin/main");
    install(other);
    const from = path.join(git(tree, "rev-parse", "--absolute-git-dir"), MARKER_NAME);
    fs.copyFileSync(from, path.join(git(other, "rev-parse", "--absolute-git-dir"), MARKER_NAME));
    const r = refusals(other);
    expect(r.map((x) => x.check)).toEqual(["marker"]);
    expect(r[0].reason).toMatch(/minted for another tree/);
  });

  it("HARM: a tree is minted ONCE (a second --mint is refused, the marker unchanged); an edited minted_at is refused", () => {
    const { tree } = workspace();
    expect(runGate(tree, ["--mint"]).status).toBe(0);
    const p = path.join(git(tree, "rev-parse", "--absolute-git-dir"), MARKER_NAME);
    const before = fs.readFileSync(p, "utf8");
    const again = runGate(tree, ["--mint"]);
    expect(again.status).toBe(1);
    expect(again.err).toMatch(/already exists for this tree: a tree is minted once/);
    expect(fs.readFileSync(p, "utf8")).toBe(before);
    install(tree);
    fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(before), minted_at: "not-a-time" }));
    expect(refusals(tree)[0]?.reason).toMatch(/minted_at is not an ISO time/);
  });

  it("HARM: publishConfig.registry, a scoped name and a workspace publish are each refused on an otherwise qualifying tree", () => {
    for (const [pkg, env, check] of [
      [{ name: "bot-relay-mcp", version: "9.9.9", publishConfig: { registry: "https://r.test/" } }, {}, "registry"],
      [{ name: "@x/bot-relay-mcp", version: "9.9.9" }, {}, "registry"],
      [{ name: "bot-relay-mcp", version: "9.9.9" }, { npm_config_workspaces: "true" }, "workspace"],
      [{ name: "bot-relay-mcp", version: "9.9.9" }, { NPM_CONFIG_WORKSPACE: "a" }, "workspace"],
    ] as const) {
      const { tree } = workspace(pkg);
      expect(runGate(tree, ["--mint"]).status).toBe(0);
      install(tree);
      expect(refusedChecks(tree, env), JSON.stringify(pkg) + JSON.stringify(env)).toEqual([check]);
    }
  });
});

describe.skipIf(process.platform === "win32")("the PROPERTY the registry check relies on (the npm on PATH, no publishConfig)", () => {
  const NPM_HOME = path.join(TMP, "npm-version-home");
  fs.mkdirSync(NPM_HOME, { recursive: true });
  const npmVersion = spawnSync("npm", ["--version"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: NPM_HOME, npm_config_userconfig: path.join(NPM_HOME, ".npmrc"), npm_config_globalconfig: path.join(NPM_HOME, "globalnpmrc") },
  }).stdout.trim();
  it(`npm ${npmVersion}: inside prepublishOnly, \`npm config get registry\` is the registry npm would publish to (CLI, both env spellings, .npmrc)`, () => {
    const D = path.join(TMP, "npm-property");
    fs.mkdirSync(path.join(D, "home"), { recursive: true });
    const reg = (x: string) => `http://127.0.0.1:1/reg-${x}/`;
    fs.writeFileSync(path.join(D, "home", ".npmrc"), `registry=${reg("c")}\n`);
    const record = path.join(D, "record.js");
    fs.writeFileSync(
      record,
      `const r = require("child_process").execFileSync("npm", ["config", "get", "registry"], { encoding: "utf8" }).trim();\n` +
        `require("fs").writeFileSync(process.env.PROBE_OUT, r);\n`,
    );
    const run = (tag: string, args: string[], extraEnv: Record<string, string>) => {
      const dir = path.join(D, tag);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "publish-gate-probe", version: "0.0.0", scripts: { prepublishOnly: `node ${JSON.stringify(record)}` } }));
      const out = path.join(D, `${tag}.out`);
      const r = spawnSync("npm", ["publish", ...args], {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
        env: { PATH: process.env.PATH ?? "", HOME: path.join(D, "home"), npm_config_userconfig: path.join(D, "home", ".npmrc"), npm_config_globalconfig: path.join(D, "home", "globalnpmrc"), PROBE_OUT: out, ...extraEnv },
      });
      const all = `${r.stdout}\n${r.stderr}`;
      return { inScript: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null, target: (/logged in to (\S+)/.exec(all) ?? [])[1] ?? null, all };
    };
    for (const [tag, args, env, want] of [
      ["cli", ["--registry", reg("b")], {}, reg("b")],
      ["env-lower", [], { npm_config_registry: reg("b") }, reg("b")],
      ["env-upper", [], { NPM_CONFIG_REGISTRY: reg("b") }, reg("b")],
      ["npmrc", [], {}, reg("c")],
    ] as const) {
      const r = run(tag, [...args], { ...env });
      const msg = `npm ${npmVersion}, ${tag}: ${r.all.slice(-600)}`;
      expect(r.target, `precondition: npm named its target in its no-login refusal (${msg})`).not.toBeNull();
      expect(r.inScript, `precondition: prepublishOnly ran (${msg})`).not.toBeNull();
      expect(r.target, msg).toBe(want);
      expect(r.inScript, `the in-script registry is the target (${msg})`).toBe(r.target);
    }
    // On record (the ruling: log the npm version): which npm this property was verified with, on this runner. A direct
    // write: a passing test's console.log is not shown in every run (measured: hidden locally), this line always is.
    process.stdout.write(`real-npm property: npm ${npmVersion} on ${process.platform}, in-script registry == ENEEDAUTH target for CLI, both env spellings and .npmrc\n`);
  }, 120_000);
});
