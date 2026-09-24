// bot-relay-mcp Kanban board — the verifier must never "pass" without running.
// Run: npm test  (from dashboard/)
//
// verify-deploy.mjs decided whether it was the program being run by comparing
// import.meta.url with `file://${process.argv[1]}`. The module URL percent-encodes
// a space ("Claude%20AI") while argv keeps it literal, so from any checkout path
// containing a space the CLI silently skipped main() and exited 0 with no output:
// a green verifier that had verified nothing. These tests run the REAL script as a
// subprocess from the path shapes that broke it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DASH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [];

// Stage a runnable copy of the verifier (script + the lib/ it imports + the
// package.json that marks lib/*.js as ESM) under `dirName`. The root is
// realpath'd: on macOS os.tmpdir() is /var/folders/…, itself a symlink to
// /private/var/folders/…, and a symlinked path component was a SECOND way the old
// entrypoint check silently skipped main(). The control must not carry that shape.
function stageCopy(dirName) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-entry-")));
  roots.push(root);
  const dest = path.join(root, dirName);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(DASH, "verify-deploy.mjs"), path.join(dest, "verify-deploy.mjs"));
  fs.copyFileSync(path.join(DASH, "package.json"), path.join(dest, "package.json"));
  fs.cpSync(path.join(DASH, "lib"), path.join(dest, "lib"), { recursive: true });
  return { root, dest };
}

// Run with NO board env, so a verifier that really runs must exit 2 and name the
// missing variables. A silent exit 0 means main() never ran.
function runCli(scriptPath) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    timeout: 15_000,
  });
}

function assertActuallyRan(r, label) {
  assert.notEqual(r.status, 0, `${label}: exited 0 — the verifier did not run`);
  assert.equal(r.status, 2, `${label}: expected the missing-env exit code`);
  assert.match(r.stderr, /Missing required env: BOARD_URL/, `${label}: must name the missing env`);
}

test("control: a direct run from a plain path actually runs", () => {
  const { dest } = stageCopy("plain");
  assertActuallyRan(runCli(path.join(dest, "verify-deploy.mjs")), "plain path");
});

test("a direct run from a path containing a SPACE actually runs (was a silent exit 0)", () => {
  const { dest } = stageCopy("dir with space");
  assertActuallyRan(runCli(path.join(dest, "verify-deploy.mjs")), "space path");
});

test("a direct run through a SYMLINK actually runs", () => {
  const { root, dest } = stageCopy("real");
  const linkDir = path.join(root, "linked");
  fs.mkdirSync(linkDir);
  const link = path.join(linkDir, "verify-deploy.mjs");
  fs.symlinkSync(path.join(dest, "verify-deploy.mjs"), link);
  assertActuallyRan(runCli(link), "symlink path");
});

test("a direct run through a SYMLINKED DIRECTORY in the path actually runs (the macOS /var → /private/var shape)", () => {
  const { root, dest } = stageCopy("realdir");
  const linkedDir = path.join(root, "linkeddir");
  fs.symlinkSync(dest, linkedDir, "dir");
  assertActuallyRan(runCli(path.join(linkedDir, "verify-deploy.mjs")), "symlinked-directory path");
});

test("entrypointStatus: main for this file, imported for another program, mismatch for a look-alike", async () => {
  const { entrypointStatus } = await import("../verify-deploy.mjs");
  const { dest } = stageCopy("dir with space");
  const script = path.join(dest, "verify-deploy.mjs");
  const url = pathToFileURL(fs.realpathSync(script)).href;
  assert.equal(entrypointStatus(url, script), "main");
  assert.equal(entrypointStatus(url, path.join(DASH, "test", "deploy-check.test.mjs")), "imported");
  assert.equal(entrypointStatus(url, undefined), "imported");
  // Same basename, different file: looks like a direct run but is not this module.
  const other = stageCopy("elsewhere");
  assert.equal(entrypointStatus(url, path.join(other.dest, "verify-deploy.mjs")), "mismatch");
});

test("exitCodeFor never returns 0 when zero checks ran", async () => {
  const { exitCodeFor } = await import("../verify-deploy.mjs");
  const pass = { step: "1. page reachable + token-gated", ok: true, level: "pass" };
  assert.notEqual(exitCodeFor({ results: [], ok: true }), 0, "zero checks must not be success");
  assert.notEqual(exitCodeFor({ results: undefined, ok: true }), 0);
  assert.equal(exitCodeFor({ results: [pass], ok: true }), 0);
  assert.equal(exitCodeFor({ results: [pass], ok: false }), 1);
  assert.equal(exitCodeFor({ results: [pass], ok: true, aborted: "unreachable" }), 1);
});

test.after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
