// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The gate's LAST step, re-pack identity (scripts/pre-publish-check.sh): `npm publish` packs the tree again after the
 * gate returns and uploads THAT tarball, so the gate compares the tree's `npm pack --dry-run --json` integrity with the
 * tarball the release security gate packed and tested (pack_tested_tarball), and refuses a lifecycle script that would
 * run in between, a missing record, and a different integrity.
 *
 * The functions run as written in the gate (their source text, inlined into `bash -c`), against a scratch package with
 * the REAL npm on PATH, offline, in a sandboxed HOME, npm cache and TMPDIR: the twin row is a measurement of the
 * property the step relies on (a real pack and a later dry-run of the untouched tree agree).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { shellFunctionSource } from "./_helpers/shell-function.js";

const ROOT = path.resolve(__dirname, "..");
const GATE = path.join(ROOT, "scripts", "pre-publish-check.sh");
const FUNCTIONS = ["tested_pack_reset", "npm_pack_identity", "pack_tested_tarball", "repack_identity_gate"]
  .map((f) => shellFunctionSource(GATE, f))
  .join("\n");

let TMP = "";
beforeAll(() => {
  TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repack-identity-")));
});
afterAll(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
});

/** A sandbox (HOME, npm config, cache, TMPDIR) and a scratch package with `files: ["dist", "README.md"]`. */
function scratch(tag: string, scripts?: Record<string, string>): { pkg: string; env: NodeJS.ProcessEnv } {
  const base = path.join(TMP, tag);
  const home = path.join(base, "home");
  const tmpdir = path.join(base, "tmp");
  const pkg = path.join(base, "pkg");
  for (const d of [home, tmpdir, path.join(pkg, "dist")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, ".npmrc"), "");
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "repack-scratch", version: "1.0.0", files: ["dist", "README.md"], ...(scripts ? { scripts } : {}) }, null, 2));
  fs.writeFileSync(path.join(pkg, "dist", "index.js"), "export const x = 1;\n");
  fs.writeFileSync(path.join(pkg, "README.md"), "# scratch\n");
  fs.writeFileSync(path.join(pkg, "notes.txt"), "not packed\n");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: tmpdir,
    npm_config_userconfig: path.join(home, ".npmrc"),
    npm_config_globalconfig: path.join(home, "globalnpmrc"),
    npm_config_cache: path.join(base, "npm-cache"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  return { pkg, env };
}

/** Run `body` after the gate's functions, with PROJECT_ROOT = the scratch package and this run's record reset. */
function gate(pkg: string, env: NodeJS.ProcessEnv, body: string): { status: number | null; out: string } {
  const script = `set -u\nset -o pipefail\n${FUNCTIONS}\nPROJECT_ROOT=${JSON.stringify(pkg)}\ntested_pack_reset\n${body}\n`;
  const r = spawnSync("bash", ["-c", script], { cwd: pkg, env, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const integrities = (s: string) => [...s.matchAll(/sha512-[A-Za-z0-9+/=]+/g)].map((m) => m[0]);
/** Every refusal names the remedy: re-run the full gate, never --ignore-scripts. */
const REMEDY = /[Rr]e-run the full gate[^\n]*Never publish with --ignore-scripts to get past this\./;

describe.skipIf(process.platform === "win32")("re-pack identity: the uploaded tarball is the tested one", () => {
  it("TWIN: an untouched tree after the tested pack PASSES, and its dry-run integrity is the tested tarball's (the real npm, measured)", () => {
    const { pkg, env } = scratch("twin");
    const r = gate(pkg, env, `pack_tested_tarball || exit 7\nprintf 'RECORD %s %s\\n' "$tested_pack_integrity" "$tested_pack_file"\nsha=$(node -e 'process.stdout.write("sha512-"+require("crypto").createHash("sha512").update(require("fs").readFileSync(process.argv[1])).digest("base64"))' "$tested_pack_file")\nprintf 'FILEHASH %s\\n' "$sha"\nrepack_identity_gate`);
    expect(r.status, r.out).toBe(0);
    const record = /RECORD (sha512-\S+) (\S+)/.exec(r.out)!;
    expect(record, r.out).not.toBeNull();
    expect(/FILEHASH (\S+)/.exec(r.out)![1], "the recorded integrity is the packed file's own sha512").toBe(record[1]);
    expect(r.out).toContain(`the tree npm will pack is the tested one: ${record[1]}`);
    const npmVersion = execFileSync("npm", ["--version"], { env, encoding: "utf8" }).trim();
    process.stdout.write(`re-pack property: npm ${npmVersion} on ${process.platform}, a real pack and a later dry-run of the untouched tree agree\n`);
  });

  it("TWIN: a change to a file npm does NOT pack (outside `files`) still PASSES: the check is about the packed content", () => {
    const { pkg, env } = scratch("unpacked-change");
    const r = gate(pkg, env, `pack_tested_tarball || exit 7\nprintf 'changed\\n' >> "$PROJECT_ROOT/notes.txt"\nrepack_identity_gate`);
    expect(r.status, r.out).toBe(0);
  });

  it.each([
    ["a packed file changed after the tested pack", `printf 'tampered\\n' >> "$PROJECT_ROOT/dist/index.js"`],
    ["a file added to a packed directory after the tested pack", `printf 'x\\n' > "$PROJECT_ROOT/dist/extra.js"`],
    ["a packed root file changed after the tested pack", `printf 'tampered\\n' >> "$PROJECT_ROOT/README.md"`],
  ])("RED: %s is REFUSED, naming both integrities and the remedy", (_label, mutate) => {
    const { pkg, env } = scratch(`changed-${_label.split(" ").slice(1, 3).join("-")}`);
    const r = gate(pkg, env, `pack_tested_tarball || exit 7\n${mutate}\nrepack_identity_gate`);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/the tree npm would upload is not the tarball the release gate tested/);
    const shown = /tested\s+(sha512-\S+)\s+now\s+(sha512-\S+)/.exec(r.out);
    expect(shown, r.out).not.toBeNull();
    expect(shown![1]).not.toBe(shown![2]);
    expect(r.out).toMatch(REMEDY);
  });

  it.each(["prepack", "prepare", "postpack"])("RED: a %s script in package.json is REFUSED before npm runs anything", (hook) => {
    const marker = `ran-${hook}`;
    const { pkg, env } = scratch(`lifecycle-${hook}`, { [hook]: `node -e "require('fs').writeFileSync('${marker}', '')"` });
    // A record is present (planted in THIS run's variable): the refusal is the lifecycle script's, not "no record".
    const r = gate(pkg, env, `tested_pack_integrity=sha512-planted\nrepack_identity_gate`);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain(`package.json has a lifecycle script (${hook}): it would run between this check and npm's pack`);
    expect(r.out).toMatch(REMEDY);
    expect(fs.existsSync(path.join(pkg, marker)), "refused before any npm command could run the script").toBe(false);
  });

  it("RED: no tested pack in this run is REFUSED as no record, even with the CORRECT integrity planted in the environment and a tarball planted at a predictable path", () => {
    const { pkg, env } = scratch("planted");
    const dry = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: pkg, env, encoding: "utf8" })).at(-1);
    expect(dry.integrity, "precondition: the planted value is the tree's REAL integrity (a reader of it would pass)").toMatch(/^sha512-/);
    const plantedDir = path.join(env.TMPDIR!, "relay-tested-pack-planted");
    fs.mkdirSync(plantedDir);
    execFileSync("npm", ["pack", "--pack-destination", plantedDir], { cwd: pkg, env, encoding: "utf8" });
    const planted = { ...env, tested_pack_integrity: dry.integrity, tested_pack_file: path.join(plantedDir, dry.filename), tested_pack_dir: plantedDir };
    const r = gate(pkg, planted, `printf 'CHILD-SEES [%s]\\n' "$(bash -c 'printf %s "\${tested_pack_integrity:-}"')"\nrepack_identity_gate`);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("no record of a tested pack in this run");
    expect(r.out).toMatch(REMEDY);
    expect(r.out, "the reset also stops the planted value reaching child processes (never exported)").toContain("CHILD-SEES []");
  });

  it("RED: a failed tested pack (no dist/) leaves NO record, so the last step refuses", () => {
    const { pkg, env } = scratch("no-dist");
    fs.rmSync(path.join(pkg, "dist"), { recursive: true });
    const r = gate(pkg, env, `pack_tested_tarball && exit 7\nprintf 'RECORD [%s]\\n' "$tested_pack_integrity"\nrepack_identity_gate`);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("no dist/: build first");
    expect(r.out).toContain("RECORD []");
    expect(r.out).toContain("no record of a tested pack in this run");
  });

  it("npm_pack_identity fails closed: no JSON, an empty list, or an entry without a sha512 integrity prints nothing", () => {
    const { pkg, env } = scratch("parse");
    for (const input of ["", "not json", "[]", '[{"filename":"a.tgz"}]', '[{"filename":"a.tgz","integrity":"sha1-x"}]']) {
      const r = gate(pkg, env, `printf '%s' ${JSON.stringify(input)} | npm_pack_identity; echo "rc=$?"`);
      expect(r.out.trim(), `input ${JSON.stringify(input)}`).toBe("rc=1");
    }
  });
});

describe("re-pack identity: wiring, and the record is THIS run's only", () => {
  const source = fs.readFileSync(GATE, "utf8");
  const lines = source.split("\n");

  it("the record is reset at top level BEFORE the first step, and is assigned nowhere but the reset and the tested pack", () => {
    const reset = lines.findIndex((l) => l === "tested_pack_reset");
    const firstStep = lines.findIndex((l) => l.startsWith("step "));
    expect(reset, "a top-level `tested_pack_reset` call").toBeGreaterThan(-1);
    expect(reset).toBeLessThan(firstStep);
    const owners = ["tested_pack_reset", "pack_tested_tarball", "release_security_gate"].map((f) => shellFunctionSource(GATE, f));
    const outside = owners.reduce((s, body) => s.replace(body, ""), source);
    expect(outside, "no assignment of the record outside its owning functions").not.toMatch(/\btested_pack_(integrity|file|dir)=/);
    expect(source, "the record is never read from a file").not.toMatch(/tested_pack_\w+=\$\((cat|<)/);
  });

  it("the release security gate tests the tarball it packed itself (not release-invariants' own --pack)", () => {
    const body = shellFunctionSource(GATE, "release_security_gate");
    expect(body).toMatch(/^\s*pack_tested_tarball \|\| return 1$/m);
    expect(body).toContain(`release-invariants.mjs" candidate "$tested_pack_file"`);
    expect(body).not.toContain("--pack");
  });

  it.each([[[] as string[]], [["--full"]]])("the re-pack identity step is the LAST step of the run list (args %j), after the release security gate", (args) => {
    const out = execFileSync("bash", [GATE, ...args, "--list-steps"], { cwd: ROOT, encoding: "utf-8", timeout: 120_000 });
    const labels = out.split("\n").filter((l) => l.startsWith("list-step: ")).map((l) => l.slice("list-step: ".length).split(" :: ")[0]);
    expect(labels.at(-1)).toBe("re-pack identity (the uploaded tarball is the tested one)");
    expect(labels.indexOf("release security gate (packed install: candidate + known-bad control)")).toBeGreaterThan(-1);
  });

  it("package.json has NO prepack, prepare or postpack script today (adding one must fail HERE, in CI, not at publish time)", () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts ?? {};
    expect(["prepack", "prepare", "postpack"].filter((k) => Object.prototype.hasOwnProperty.call(scripts, k))).toEqual([]);
  });
});
