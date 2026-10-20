// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The release suite's global setup: install the tarball under test ONCE, and tell every test where it is.
 *
 * - `RELAY_RELEASE_TGZ` must name an existing .tgz: a package is the TARBALL, identified by its INTEGRITY (sha512,
 *   the form npm records), never by its version (the release candidate and the published 3.0.1 both say "3.0.1").
 *   Without one, the run REFUSES: this suite never checks a source tree.
 * - `RELAY_RELEASE_LIST_ONLY=1` (the registry meta-test's `vitest list`) skips the install: tests are collected,
 *   never run.
 * - The install runs with its install scripts ON (the shipped user path; with them off the native SQLite driver is
 *   missing) into a scratch prefix, with HOME set to a scratch dir. Its resolved dependency tree is digested
 *   (`npm ls --json --all`): two runs on the same integrity can still resolve different dependencies.
 * - The operator's relay config is hashed before the run and checked after it (SEC-11): a change fails the run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import type { TestProject } from "vitest/node";

export interface ReleaseInstall {
  /** The tarball under test, absolute. */
  tgz: string;
  /** "sha512-<base64>", the npm integrity of the tarball's bytes. */
  integrity: string;
  /** The installed package directory (…/node_modules/bot-relay-mcp). */
  pkg: string;
  /** package.json's version (a label only: never an identity). */
  version: string;
  /** sha256 of the resolved dependency tree (`npm ls --json --all`, keys sorted). */
  depsDigest: string;
  /** A scratch directory for this run's sandboxes (removed at teardown). */
  work: string;
  /** The tarball's own build stamp (dist/build-info.js): which commit and code it was built from, or null. */
  build: { build_id?: string; commit?: string | null; dirty?: boolean; built_at?: string } | null;
}

declare module "vitest" {
  export interface ProvidedContext {
    release: ReleaseInstall | null;
  }
}

const OPERATOR_RELAY_CONFIG = path.join(os.userInfo().homedir, ".bot-relay", "config.json");
const sha = (algo: string, buf: Buffer | string) => crypto.createHash(algo).update(buf).digest();
const fileHash = (f: string) => (fs.existsSync(f) ? sha("sha256", fs.readFileSync(f)).toString("hex") : "absent");

/** JSON with object keys sorted, so a digest does not depend on key order. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

export default function setup(project: TestProject): () => void {
  if (process.env.RELAY_RELEASE_LIST_ONLY === "1") {
    project.provide("release", null);
    return () => undefined;
  }
  const tgz = process.env.RELAY_RELEASE_TGZ ? path.resolve(process.env.RELAY_RELEASE_TGZ) : "";
  if (!tgz || !tgz.endsWith(".tgz") || !fs.statSync(tgz, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`release suite: RELAY_RELEASE_TGZ must name an existing .tgz (got ${JSON.stringify(process.env.RELAY_RELEASE_TGZ ?? "")}). It never runs against a source tree.`);
  }
  const integrity = `sha512-${sha("sha512", fs.readFileSync(tgz)).toString("base64")}`;
  const operatorBefore = fileHash(OPERATOR_RELAY_CONFIG);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-release-")));
  const prefix = path.join(work, "prefix");
  const installHome = path.join(work, "install-home");
  fs.mkdirSync(prefix, { recursive: true });
  fs.mkdirSync(installHome, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmEnv = { ...process.env, HOME: installHome, USERPROFILE: installHome, npm_config_cache: path.join(work, "npm-cache") };
  const inst = spawnSync(npm, ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error", tgz], { encoding: "utf-8", env: npmEnv, shell: process.platform === "win32" });
  if (inst.status !== 0) throw new Error(`release suite: npm install of ${tgz} failed (exit ${inst.status}): ${(inst.stderr || inst.stdout || "").slice(-1500)}`);
  const pkg = path.join(prefix, "node_modules", "bot-relay-mcp");
  const version = (JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf-8")) as { version: string }).version;
  // The dependency inventory is MEASURED or the run stops: a failed, non-zero or malformed `npm ls` is never hashed
  // (the hash of `{}` is not a dependency tree), and the inventory must hold the package just installed, at its version.
  const ls = spawnSync(npm, ["ls", "--json", "--all", "--prefix", prefix], { encoding: "utf-8", env: npmEnv, maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" });
  if (ls.error || ls.status !== 0) {
    throw new Error(`release suite: npm ls --json --all failed (exit ${ls.status}${ls.error ? `; ${ls.error.message}` : ""}): the dependency inventory is not measured. ${(ls.stderr || "").slice(-1500)}`);
  }
  let inventory: { dependencies?: Record<string, { version?: string }> };
  try {
    inventory = JSON.parse(ls.stdout) as typeof inventory;
  } catch (err) {
    throw new Error(`release suite: npm ls printed no JSON inventory (${(err as Error).message}): ${(ls.stdout || "").slice(0, 500)}`);
  }
  if (inventory?.dependencies?.["bot-relay-mcp"]?.version !== version) {
    throw new Error(`release suite: the npm ls inventory does not hold bot-relay-mcp@${version} (the package just installed): ${(ls.stdout || "").slice(0, 500)}`);
  }
  const depsDigest = sha("sha256", JSON.stringify(canonical(inventory))).toString("hex");
  // The stamp is READ, never imported: it is generated as `export const BUILD_INFO = Object.freeze(<json>);`, so its JSON
  // is parsed from the text (and a guard refuses a computed import specifier). Absent or another shape (a build that
  // predates the stamp, e.g. 3.0.1): null, reported as "unstamped".
  let build: ReleaseInstall["build"] = null;
  try {
    const text = fs.readFileSync(path.join(pkg, "dist", "build-info.js"), "utf-8");
    const json = text.slice(text.indexOf("Object.freeze(") + "Object.freeze(".length, text.lastIndexOf(");"));
    build = JSON.parse(json) as ReleaseInstall["build"];
  } catch {
    build = null;
  }
  const release: ReleaseInstall = { tgz, integrity, pkg, version, depsDigest, work, build };
  fs.writeFileSync(path.join(work, "release-install.json"), JSON.stringify(release, null, 2));
  if (process.env.RELAY_RELEASE_REPORT) fs.writeFileSync(process.env.RELAY_RELEASE_REPORT, JSON.stringify(release, null, 2));
  process.stdout.write(`[release] tarball ${path.basename(tgz)} integrity ${integrity} version ${version} build ${build?.commit ?? "unstamped"}${build?.dirty ? " (dirty)" : ""} deps ${depsDigest.slice(0, 16)}\n`);
  project.provide("release", release);
  return () => {
    fs.rmSync(work, { recursive: true, force: true });
    const operatorAfter = fileHash(OPERATOR_RELAY_CONFIG);
    if (operatorAfter !== operatorBefore) {
      throw new Error(`SEC-11: the operator's relay config ${OPERATOR_RELAY_CONFIG} CHANGED during the release suite (sha256 ${operatorBefore} -> ${operatorAfter}).`);
    }
  };
}
