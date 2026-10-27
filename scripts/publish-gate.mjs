#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PUBLISH GATE: POSITIVE QUALIFICATION. A real `npm publish` (prepublishOnly) is refused unless the tree
 * PROVES it is a fresh release tree. It fails CLOSED: a check it cannot decide (git missing, the remote
 * unreachable, a file it cannot read) is a refusal, named. This replaces detecting the serving tree by its
 * consumers (a parser that misses forms, and fails open); prebuild-guard.mjs keeps that parser for BUILDS.
 *
 * A release tree, all of:
 *   1. a LINKED git worktree (its git dir is not the common dir), under the sanctioned root
 *      <parent of the main checkout>/.worktrees (the main checkout is the common dir's parent);
 *   2. no .relay-prod-tree marker (the serving tree's);
 *   3. its OWN node_modules, root and extensions/vscode: real directories inside the tree, never a link
 *      (a worktree tool links them to the main checkout until `npm ci`);
 *   4. a clean tree whose HEAD is the remote's main (`git ls-remote`, read live) or the remote's tag
 *      v<package version>;
 *   5. a release marker minted for HEAD when the tree was created (`--mint`, below).
 * And the package, for the registry the login is checked against (measured on npm 11.6.2: inside
 * prepublishOnly, `npm config get registry` names the real target for a CLI flag, either env spelling and
 * .npmrc, but NOT when publishConfig.registry is set, where a CLI and an env registry look identical):
 *   6. no publishConfig.registry;
 *   7. an UNSCOPED name (an @scope:registry mapping could override; not measured);
 *   8. no workspace publish (npm_config_workspace / npm_config_workspaces; not measured).
 *
 * THE MARKER: <the worktree's private git dir>/relay-release-tree.json, {v:1, sha, minted_at}. It is not in
 * the working tree (so it cannot dirty it) and `git worktree remove` deletes it with the tree. `--mint`
 * writes it only for a tree that passes 1, 2 and 4 and has NO real node_modules yet: minted at creation,
 * before `npm ci`, for the SHA the tree was created at.
 *
 * MODES: no flag (what pre-publish-check.sh runs inside prepublishOnly) or `--check` (the same qualification,
 * on demand, for the release procedure) refuse unless 1-8 hold; `--mint` writes the marker (above).
 *
 * KNOWN LIMIT: `npm publish --ignore-scripts` skips prepublishOnly, and with it this whole gate. Nothing that
 * runs at publish time could stop it, so a "gate passed" record would be a claim nothing reads. The procedure
 * (pre-publish-check.sh's header) allows --ignore-scripts only to retry an upload right after a fully gated run
 * on the same tree at the same SHA, with `--check` passing there again first.
 *
 * THE LAYOUT IS THIS WORKSPACE'S: condition 1 encodes it (worktrees beside the main checkout, in .worktrees/).
 * A publish from any other layout is refused by design: only the owner publishes.
 *
 * NOT shipped to npm users (`scripts/` is not in package.json `files`).
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { isDirectRun } from "./lib/entrypoint.mjs";

export const MARKER_NAME = "relay-release-tree.json";

/** The refusals for a set of gathered facts (pure). An empty list qualifies the tree. */
export function decide(f, { mint = false } = {}) {
  const out = [];
  const no = (check, reason) => out.push({ check, reason });
  if (f.gitError) {
    no("git", `git could not be asked (${f.gitError}): nothing about the tree can be decided`);
    return out;
  }
  // 1
  if (f.gitDir === f.commonDir) no("worktree", "this is the main checkout, not a linked worktree: publish from a fresh worktree created for the release");
  else if (!f.underSanctionedRoot) no("worktree", `the tree is not under the sanctioned worktree root (${f.sanctionedRoot})`);
  // 2
  if (f.prodMarker) no("prod-marker", "this tree carries .relay-prod-tree: it is the serving tree");
  // 3
  for (const [where, state] of Object.entries(f.nodeModules)) {
    if (mint) {
      if (state === "real") no("node_modules", `${where} node_modules is already installed: mint the marker when the tree is created, before npm ci`);
      else if (state === "error") no("node_modules", `${where} node_modules could not be inspected`);
    } else if (state !== "real") {
      const why = { absent: "is missing", link: "is a link (to another checkout's packages)", outside: "resolves outside the tree", error: "could not be inspected" }[state] ?? state;
      no("node_modules", `${where} node_modules ${why}: run npm ci in this tree`);
    }
  }
  // 4
  if (f.dirty === null) no("clean", `the tree's status could not be read (${f.statusError})`);
  else if (f.dirty.length) no("clean", `the tree is not clean (${f.dirty.length} change(s), e.g. ${f.dirty[0]})`);
  if (f.remoteError) no("head", `the remote's main could not be read (${f.remoteError})`);
  else if (f.head !== f.remoteMain && (f.remoteTag === null || f.head !== f.remoteTag)) {
    no("head", `HEAD ${short(f.head)} is neither the remote's main (${short(f.remoteMain)}) nor its tag v${f.pkg?.version ?? "?"}${f.remoteTag ? ` (${short(f.remoteTag)})` : " (absent)"}`);
  }
  // 5
  if (!mint) {
    if (f.marker === null) no("marker", `no release marker: create the tree with \`node scripts/publish-gate.mjs --mint\` before npm ci`);
    else if (f.marker === "unreadable") no("marker", "the release marker could not be read");
    else if (f.marker.sha !== f.head) no("marker", `the release marker was minted for ${short(f.marker.sha)}, not HEAD ${short(f.head)}`);
  }
  // 6-8
  if (!mint) {
    if (f.pkg === null) no("package", "package.json could not be read");
    else {
      if (f.pkg.publishConfigRegistry) no("registry", "package.json sets publishConfig.registry: not supported (with it, a CLI and an env registry cannot be told apart from here)");
      if (f.pkg.name.startsWith("@")) no("registry", `the package name ${f.pkg.name} is scoped: an @scope:registry mapping could pick the target (not measured)`);
    }
    if (f.workspaceEnv) no("workspace", `a workspace publish (${f.workspaceEnv}) is not supported (not measured)`);
  }
  return out;
}

const short = (s) => (typeof s === "string" ? s.slice(0, 7) : String(s));

function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function nodeModulesState(top, rel) {
  const p = path.join(top, rel, "node_modules");
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    return e && e.code === "ENOENT" ? "absent" : "error";
  }
  if (st.isSymbolicLink()) return "link";
  if (!st.isDirectory()) return "error";
  try {
    return within(fs.realpathSync(p), fs.realpathSync(top)) ? "real" : "outside";
  } catch {
    return "error";
  }
}

/** Gather the facts for decide(). `git` runs a git command in `cwd` and returns its trimmed stdout (throws on failure). */
export function gather({ cwd, env = process.env, git = defaultGit(cwd) }) {
  const f = { nodeModules: {} };
  let top;
  try {
    top = fs.realpathSync(git(["rev-parse", "--show-toplevel"]));
    f.gitDir = fs.realpathSync(git(["rev-parse", "--absolute-git-dir"]));
    f.commonDir = fs.realpathSync(path.resolve(top, git(["rev-parse", "--git-common-dir"])));
    f.head = git(["rev-parse", "HEAD"]);
  } catch (e) {
    f.gitError = firstLine(e);
    return f;
  }
  f.sanctionedRoot = path.join(path.dirname(path.dirname(f.commonDir)), ".worktrees");
  f.underSanctionedRoot = within(top, f.sanctionedRoot);
  f.prodMarker = fs.existsSync(path.join(top, ".relay-prod-tree"));
  f.nodeModules = { root: nodeModulesState(top, "."), "extensions/vscode": nodeModulesState(top, "extensions/vscode") };
  try {
    f.dirty = git(["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean);
  } catch (e) {
    f.dirty = null;
    f.statusError = firstLine(e);
  }
  try {
    const raw = fs.readFileSync(path.join(top, "package.json"), "utf8");
    const p = JSON.parse(raw);
    f.pkg = { name: String(p.name ?? ""), version: String(p.version ?? ""), publishConfigRegistry: (p.publishConfig && p.publishConfig.registry) || null };
  } catch {
    f.pkg = null;
  }
  try {
    const tag = f.pkg ? `refs/tags/v${f.pkg.version}` : null;
    const lines = git(["ls-remote", "origin", "refs/heads/main", ...(tag ? [tag, `${tag}^{}`] : [])]).split("\n").filter(Boolean);
    const ref = (name) => (lines.find((l) => l.split("\t")[1] === name) ?? "").split("\t")[0] || null;
    f.remoteMain = ref("refs/heads/main");
    f.remoteTag = tag ? ref(`${tag}^{}`) ?? ref(tag) : null;
    if (!f.remoteMain) f.remoteError = "the remote has no refs/heads/main";
  } catch (e) {
    f.remoteError = firstLine(e);
  }
  const markerPath = path.join(f.gitDir, MARKER_NAME);
  if (!fs.existsSync(markerPath)) f.marker = null;
  else {
    try {
      const m = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      f.marker = m && m.v === 1 && typeof m.sha === "string" ? { sha: m.sha } : "unreadable";
    } catch {
      f.marker = "unreadable";
    }
  }
  const ws = Object.keys(env).find((k) => /^npm_config_workspaces?$/i.test(k) && env[k] !== "" && env[k] !== "false");
  f.workspaceEnv = ws ? `${ws}=${env[ws]}` : null;
  return f;
}

function firstLine(e) {
  const s = e && typeof e === "object" && "stderr" in e && e.stderr ? String(e.stderr) : e instanceof Error ? e.message : String(e);
  return s.split("\n").find((l) => l.trim()) ?? "unknown error";
}

function defaultGit(cwd) {
  return (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim();
}

function main() {
  const mint = process.argv.includes("--mint");
  const cwd = process.cwd();
  let f;
  try {
    f = gather({ cwd });
  } catch (e) {
    f = { gitError: `the gate could not gather facts: ${firstLine(e)}` };
  }
  const refusals = decide(f, { mint });
  if (refusals.length) {
    process.stderr.write(`\n✖ ${mint ? "NOT minting a release marker" : "REFUSING to publish"}: this is not a qualified release tree.\n`);
    for (const r of refusals) process.stderr.write(`  - [${r.check}] ${r.reason}\n`);
    process.stderr.write(`  A release tree: a fresh linked worktree at the remote's main, minted (--mint) before npm ci, its own node_modules.\n\n`);
    process.exit(1);
  }
  if (mint) {
    fs.writeFileSync(path.join(f.gitDir, MARKER_NAME), JSON.stringify({ v: 1, sha: f.head, minted_at: new Date().toISOString() }) + "\n", { flag: "w" });
    process.stderr.write(`release marker minted for ${f.head}\n`);
  }
  process.exit(0);
}

if (isDirectRun(import.meta.url)) {
  main();
}
