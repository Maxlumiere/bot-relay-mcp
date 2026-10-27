// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * scripts/publish-gate.mjs: a real `npm publish` is refused unless the tree PROVES it is a fresh release tree
 * (fail-closed), and the registry the login is checked against is the one npm uploads to.
 *   - decide(): every condition, alone, refuses with its own named reason; a qualifying set passes.
 *   - the gatherer, on a REAL git fixture (a bare origin, a main checkout, .worktrees/ beside it): the main
 *     checkout, a linked node_modules, a dirty tree, HEAD not the remote's main and git unavailable are each
 *     refused; a fresh release worktree, minted before npm ci, passes.
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
import { decide, gather, MARKER_NAME } from "../scripts/publish-gate.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(REPO, "scripts", "publish-gate.mjs");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "publish-gate-")));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

type Facts = Record<string, unknown>;
const SHA = "a".repeat(40);
const qualifying = (): Facts => ({
  gitDir: "/ws/main/.git/worktrees/rel",
  commonDir: "/ws/main/.git",
  sanctionedRoot: "/ws/.worktrees",
  underSanctionedRoot: true,
  head: SHA,
  prodMarker: false,
  nodeModules: { root: "real", "extensions/vscode": "real" },
  dirty: [],
  remoteMain: SHA,
  remoteTag: null,
  marker: { sha: SHA },
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
    ["the main checkout", { gitDir: "/ws/main/.git" }, "worktree", /the main checkout, not a linked worktree/],
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
    ["a marker for another SHA", { marker: { sha: "c".repeat(40) } }, "marker", /minted for ccccccc, not HEAD aaaaaaa/],
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
  it("--mint: refused once real node_modules exist (minted at creation, before npm ci); a link or none is fine; no marker needed", () => {
    expect(checks({ ...qualifying(), marker: null, nodeModules: { root: "link", "extensions/vscode": "absent" } }, true)).toEqual([]);
    const r = checks({ ...qualifying(), marker: null }, true);
    expect(r.map((x) => x.check)).toEqual(["node_modules", "node_modules"]);
    expect(r[0].reason).toMatch(/already installed: mint the marker when the tree is created/);
  });
});

describe("the gatherer on a REAL git fixture (bare origin, main checkout, .worktrees/ beside it)", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let n = 0;
  /** A workspace: ws/origin.git (bare), ws/main (its clone), ws/.worktrees/<name> (a linked worktree at origin/main). */
  const workspace = (pkg: Record<string, unknown> = { name: "bot-relay-mcp", version: "9.9.9" }) => {
    const ws = path.join(TMP, `ws${++n}`);
    fs.mkdirSync(ws);
    git(ws, "init", "--bare", "-q", "origin.git");
    git(ws, "clone", "-q", path.join(ws, "origin.git"), "main");
    const main = path.join(ws, "main");
    fs.writeFileSync(path.join(main, "package.json"), JSON.stringify(pkg));
    fs.writeFileSync(path.join(main, ".gitignore"), "node_modules\n"); // no trailing slash: a LINKED node_modules is ignored too (the row tests the link, not the status)
    fs.mkdirSync(path.join(main, "extensions", "vscode"), { recursive: true });
    fs.writeFileSync(path.join(main, "extensions", "vscode", "package.json"), "{}");
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
    const r = spawnSync(process.execPath, [GATE, ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: TMP, ...env } });
    return { status: r.status, err: r.stderr };
  };
  const refusedChecks = (cwd: string, env: Record<string, string> = {}) =>
    (decide(gather({ cwd, env: { ...env } })) as Array<{ check: string }>).map((x) => x.check);

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
  const npmVersion = spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout.trim();
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
  }, 120_000);
});
