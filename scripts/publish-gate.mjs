#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PUBLISH GATE: POSITIVE QUALIFICATION. A real `npm publish` (prepublishOnly) is refused unless the tree
 * PROVES it is a fresh release tree. It fails CLOSED: a check it cannot decide (git missing, the remote
 * unreachable, a file it cannot inspect) is a refusal, named. This replaces detecting the serving tree by its
 * consumers (a parser that misses forms, and fails open); prebuild-guard.mjs keeps that parser for BUILDS.
 *
 * THREAT MODEL: an ACCIDENT gate. It stops an honest operator publishing from the wrong or a contaminated tree
 * (the 26 Oct incident: a publish in the serving tree swapped packages under the live daemon). It is NOT a
 * defence against someone with write access to the checkout, who can edit this script. So it checks what an
 * accident leaves (a link to another checkout, the serving tree's marker, a tree at the wrong SHA), and NAMES
 * what it does not check (NOT CAUGHT, below), each pinned by a test.
 *
 * A release tree, all of:
 *   1. a LINKED git worktree (its git dir is not the common dir), under the sanctioned root
 *      <parent of the main checkout>/.worktrees (the main checkout is the common dir's parent);
 *   2. no .relay-prod-tree entry (the serving tree's marker; any entry counts, a dangling link included; an
 *      entry that cannot be inspected is a refusal);
 *   3. ISOLATED build inputs and outputs: node_modules (root and extensions/vscode) are real directories inside
 *      the tree, never a link (a worktree tool links them to the main checkout until `npm ci`), and none of their
 *      top-level entries (scoped ones included) is a link resolving outside the tree (what `npm link` or a hand
 *      link leaves; `npm ci` never does); dist/ is absent or a real directory inside the tree, never a link;
 *   4. a clean tree whose HEAD is the remote's main (`git ls-remote`, read live) or the remote's tag
 *      v<package version>;
 *   5. a release marker minted for this tree, at HEAD (below).
 * And the package, for the registry the login is checked against (measured on npm 11.6.2 and 10.9.9: inside
 * prepublishOnly, `npm config get registry` names the real target for a CLI flag, either env spelling and
 * .npmrc, but NOT when publishConfig.registry is set, where a CLI and an env registry look identical):
 *   6. no publishConfig.registry;
 *   7. an UNSCOPED name (an @scope:registry mapping could override; not measured);
 *   8. no workspace publish (npm_config_workspace / npm_config_workspaces; not measured).
 * Inside prepublishOnly this runs AFTER any `npm ci`, so the isolation in 3 is checked on the installed tree.
 *
 * THE MARKER: <the worktree's private git dir>/relay-release-tree.json, {v:1, sha, minted_at, tree, git_dir}:
 * the SHA, an ISO time, and the canonical paths of the tree and of its private git dir, all validated. It is not
 * in the working tree (so it cannot dirty it) and `git worktree remove` deletes it with the tree. `--mint` writes
 * it once (never over an existing one) and only for a tree that passes 1, 2, 3's dist/ rule and 4, with no
 * node_modules installed yet (absent, or a link): minted at creation, before `npm ci`. It is an OPERATOR-
 * CONTROLLED ASSERTION ("this tree was created for this release"), not provenance: anyone who can write the
 * git dir can write it. Stronger provenance would need a trusted creator outside the mutable checkout.
 *
 * NOT CAUGHT (named exclusions, each pinned by a test or stated as untestable here):
 *   - a HARD-LINKED file inside node_modules or dist/ shared with another tree (a hard link is a plain file;
 *     nothing tells it apart without comparing inodes across trees): pinned by a NOT-caught test;
 *   - a BIND MOUNT over a directory (needs privileges to make; not tested here);
 *   - links BELOW the top level of node_modules (only the entries npm itself places are inspected);
 *   - the HEAD rule accepts a lightweight tag, a tag off main or ahead of it, and trusts whatever URL `origin`
 *     points at: the rule as written, not verified release provenance.
 *
 * MODES: no flag (what pre-publish-check.sh runs inside prepublishOnly) or `--check` (the same qualification,
 * on demand, for the release procedure) refuse unless 1-8 hold; `--mint` writes the marker (above). `--check`
 * proves QUALIFICATION only, never that the whole gate passed.
 *
 * KNOWN LIMIT: `npm publish --ignore-scripts` skips prepublishOnly, and with it this whole gate. Nothing that
 * runs at publish time could stop it, so a "gate passed" record would be a claim nothing reads. The procedure
 * (pre-publish-check.sh's header) allows it only to retry the UPLOAD after a run that completed every step and
 * failed at the upload itself, on the same tree at the same SHA.
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

const NM_WHY = {
  absent: "is missing",
  link: "is a link (to another checkout's packages)",
  outside: "resolves outside the tree",
  error: "could not be inspected",
};

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
  if (f.prodMarker === true) no("prod-marker", "this tree carries .relay-prod-tree: it is the serving tree");
  else if (f.prodMarker !== false) no("prod-marker", `.relay-prod-tree could not be inspected (${f.prodMarker})`);
  // 3
  for (const [where, state] of Object.entries(f.nodeModules)) {
    if (mint) {
      if (state === "real") no("node_modules", `${where} node_modules is already installed: mint the marker when the tree is created, before npm ci`);
      else if (state !== "absent" && state !== "link") no("node_modules", `${where} node_modules ${NM_WHY[state] ?? state}: a tree is minted before npm ci`);
    } else if (state !== "real") {
      no("node_modules", `${where} node_modules ${NM_WHY[state] ?? state}: run npm ci in this tree`);
    }
  }
  if (!mint) {
    if (f.nmScanError) no("node_modules", `node_modules entries could not be inspected (${f.nmScanError})`);
    else if (f.nmLinksOut && f.nmLinksOut.length) no("node_modules", `${f.nmLinksOut.length} node_modules entr${f.nmLinksOut.length === 1 ? "y is a link" : "ies are links"} out of the tree (e.g. ${f.nmLinksOut[0]}): a linked package is not this tree's`);
  }
  if (f.dist && f.dist !== "absent" && f.dist !== "real") {
    no("dist", `dist/ ${{ link: "is a link: the build would write through it", outside: "resolves outside the tree", error: "could not be inspected" }[f.dist] ?? f.dist}`);
  }
  // 4
  if (f.dirty === null) no("clean", `the tree's status could not be read (${f.statusError})`);
  else if (f.dirty.length) no("clean", `the tree is not clean (${f.dirty.length} change(s), e.g. ${f.dirty[0]})`);
  if (f.remoteError) no("head", `the remote's main could not be read (${f.remoteError})`);
  else if (f.head !== f.remoteMain && (f.remoteTag === null || f.head !== f.remoteTag)) {
    no("head", `HEAD ${short(f.head)} is neither the remote's main (${short(f.remoteMain)}) nor its tag v${f.pkg?.version ?? "?"}${f.remoteTag ? ` (${short(f.remoteTag)})` : " (absent)"}`);
  }
  // 5
  if (mint) {
    if (f.marker !== null) no("marker", "a release marker already exists for this tree: a tree is minted once (never re-minted)");
  } else {
    const bad = markerProblem(f);
    if (bad) no("marker", bad);
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

/** Why the marker does not qualify this tree at HEAD, or null. The full schema, then the binding. */
function markerProblem(f) {
  const m = f.marker;
  if (m === null) return "no release marker: create the tree with `node scripts/publish-gate.mjs --mint` before npm ci";
  if (m === "unreadable" || typeof m !== "object") return "the release marker could not be read";
  if (m.v !== 1) return `the release marker has an unknown version (${JSON.stringify(m.v)})`;
  if (typeof m.sha !== "string" || !/^[0-9a-f]{40}$/.test(m.sha)) return "the release marker's sha is not a full commit id";
  if (typeof m.minted_at !== "string" || Number.isNaN(Date.parse(m.minted_at)) || new Date(m.minted_at).toISOString() !== m.minted_at) {
    return "the release marker's minted_at is not an ISO time";
  }
  if (typeof m.tree !== "string" || m.tree !== f.top) return `the release marker was minted for another tree (${typeof m.tree === "string" ? m.tree : "none"}), not this one (${f.top})`;
  if (typeof m.git_dir !== "string" || m.git_dir !== f.gitDir) return "the release marker names another git dir: it was copied, not minted here";
  if (m.sha !== f.head) return `the release marker was minted for ${short(m.sha)}, not HEAD ${short(f.head)}`;
  return null;
}

const short = (s) => (typeof s === "string" ? s.slice(0, 7) : String(s));

function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** "absent" | "link" | "real" (a real directory inside the tree) | "outside" | "error". */
function dirState(top, p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    return e && e.code === "ENOENT" ? "absent" : "error";
  }
  if (st.isSymbolicLink()) return "link";
  if (!st.isDirectory()) return "error";
  try {
    return within(fs.realpathSync(p), top) ? "real" : "outside";
  } catch {
    return "error";
  }
}

/** Every top-level node_modules entry (and @scope/<name>) that is a link resolving outside the tree. Throws when unreadable. */
function linksOut(top, nm) {
  const out = [];
  const check = (dir, name) => {
    const p = path.join(dir, name);
    let target;
    try {
      target = fs.realpathSync(p);
    } catch {
      out.push(`${path.relative(top, p)} (a dangling link)`);
      return;
    }
    if (!within(target, top)) out.push(`${path.relative(top, p)} → ${target}`);
  };
  for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
    if (e.isSymbolicLink()) check(nm, e.name);
    else if (e.isDirectory() && e.name.startsWith("@")) {
      const scope = path.join(nm, e.name);
      for (const s of fs.readdirSync(scope, { withFileTypes: true })) if (s.isSymbolicLink()) check(scope, s.name);
    }
  }
  return out;
}

/** true (an entry exists, of any kind), false (ENOENT only), or the inspection error's text. */
function entryState(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    return e && e.code === "ENOENT" ? false : String((e && e.code) || e);
  }
}

/**
 * Gather the facts for decide(). `git` runs a git command in `cwd` with `env` and returns its trimmed stdout
 * (throws on failure); `env` is also where a workspace publish is read from.
 */
export function gather({ cwd, env = process.env, git = defaultGit(cwd, env) }) {
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
  f.top = top;
  f.sanctionedRoot = path.join(path.dirname(path.dirname(f.commonDir)), ".worktrees");
  f.underSanctionedRoot = within(top, f.sanctionedRoot);
  f.prodMarker = entryState(path.join(top, ".relay-prod-tree"));
  const nmDirs = { root: path.join(top, "node_modules"), "extensions/vscode": path.join(top, "extensions", "vscode", "node_modules") };
  for (const [where, p] of Object.entries(nmDirs)) f.nodeModules[where] = dirState(top, p);
  f.nmLinksOut = [];
  try {
    for (const [where, p] of Object.entries(nmDirs)) if (f.nodeModules[where] === "real") f.nmLinksOut.push(...linksOut(top, p));
  } catch (e) {
    f.nmScanError = firstLine(e);
  }
  f.dist = dirState(top, path.join(top, "dist"));
  try {
    f.dirty = git(["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean);
  } catch (e) {
    f.dirty = null;
    f.statusError = firstLine(e);
  }
  try {
    const p = JSON.parse(fs.readFileSync(path.join(top, "package.json"), "utf8"));
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
  const markerEntry = entryState(markerPath);
  if (markerEntry === false) f.marker = null;
  else {
    try {
      const m = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      f.marker = m && typeof m === "object" ? m : "unreadable";
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

function defaultGit(cwd, env) {
  return (args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim();
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
    const marker = { v: 1, sha: f.head, minted_at: new Date().toISOString(), tree: f.top, git_dir: f.gitDir };
    try {
      fs.writeFileSync(path.join(f.gitDir, MARKER_NAME), JSON.stringify(marker) + "\n", { flag: "wx" }); // never over an existing one
    } catch (e) {
      process.stderr.write(`\n✖ NOT minting a release marker: ${firstLine(e)}\n\n`);
      process.exit(1);
    }
    process.stderr.write(`release marker minted for ${f.head}\n`);
  }
  process.exit(0);
}

if (isDirectRun(import.meta.url)) {
  main();
}
