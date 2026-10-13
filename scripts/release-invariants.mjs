#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The RELEASE SECURITY GATE: check an INSTALLED package against the security invariants (security/invariants.json).
 *
 *   node scripts/release-invariants.mjs candidate <package.tgz>     the release candidate: every active invariant
 *                                                                    that applies to this OS must hold (exit 0), or 1
 *   node scripts/release-invariants.mjs candidate --pack            the same, on `npm pack` of THIS tree (its dist/
 *                                                                    must be built: pack ships whatever is there)
 *   node scripts/release-invariants.mjs control <package.tgz|latest> the KNOWN-BAD control (security/known-bad.json):
 *                                                                    every violation is reported; the gate FAILS only
 *                                                                    when the tarball IS the known-bad integrity and a
 *                                                                    must_fail tag's harms all PASS (the suite went
 *                                                                    blind). `latest` packs the registry's latest:
 *                                                                    offline, that FAILS (no skip).
 *
 * A package is identified by its tarball INTEGRITY, never its version. Every run prints: the mode, the tarball, its
 * integrity, its build stamp, its version (a label), the resolved-dependency digest, this OS, each invariant's
 * verdict, every pending invariant with its owner, and the waiver count and list. Exit 2 = a harness fault.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [mode, target] = process.argv.slice(2);
const fault = (msg) => {
  process.stderr.write(`release-invariants: ${msg}\n`);
  process.exit(2);
};
if (!["candidate", "control"].includes(mode) || !target) fault("usage: release-invariants.mjs candidate <package.tgz> | control <package.tgz|latest>");

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "security", "invariants.json"), "utf-8")).invariants;
const knownBad = JSON.parse(fs.readFileSync(path.join(ROOT, "security", "known-bad.json"), "utf-8"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "release-invariants-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

let tgz = target;
if (target === "--pack") {
  if (mode !== "candidate") fault("--pack is for the candidate only");
  if (!fs.existsSync(path.join(ROOT, "dist", "index.js"))) fault("no dist/: build first (npm pack ships whatever dist/ holds)");
  const pack = spawnSync(npm, ["pack", "--pack-destination", work, "--json"], { cwd: ROOT, encoding: "utf-8", shell: process.platform === "win32" });
  if (pack.status !== 0) fault(`npm pack failed: ${pack.stderr}`);
  tgz = path.join(work, JSON.parse(pack.stdout).at(-1).filename);
} else if (target === "latest") {
  if (mode !== "control") fault("`latest` is for the control only");
  const pack = spawnSync(npm, ["pack", "bot-relay-mcp@latest", "--pack-destination", work, "--json"], { encoding: "utf-8", shell: process.platform === "win32" });
  if (pack.status !== 0) {
    process.stderr.write(`release-invariants: FAIL: the known-bad control could not fetch bot-relay-mcp@latest from the registry (offline?). The gate does not skip it.\n${pack.stderr}\n`);
    process.exit(1);
  }
  tgz = path.join(work, JSON.parse(pack.stdout)[0].filename);
}
tgz = path.resolve(tgz);
if (!fs.existsSync(tgz)) fault(`no such tarball: ${tgz}`);

const results = path.join(work, "results.json");
const installReport = path.join(work, "install.json");
const vitest = spawnSync(
  process.execPath,
  [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", path.join(ROOT, "vitest.release.config.ts"), "--reporter=default", "--reporter=json", `--outputFile.json=${results}`],
  { cwd: ROOT, stdio: "inherit", env: { ...process.env, RELAY_RELEASE_TGZ: tgz, RELAY_RELEASE_REPORT: installReport } },
);
if (!fs.existsSync(results) || !fs.existsSync(installReport)) fault(`the suite produced no results (vitest exit ${vitest.status})`);
const install = JSON.parse(fs.readFileSync(installReport, "utf-8"));
const status = new Map(); // "<repo-relative file>::<test title>" -> passed | failed | skipped | ...
for (const f of JSON.parse(fs.readFileSync(results, "utf-8")).testResults) {
  const rel = path.relative(ROOT, f.name).split(path.sep).join("/");
  for (const a of f.assertionResults) status.set(`${rel}::${a.title}`, a.status);
}

const platform = process.platform;
const lines = [];
const out = (s = "") => lines.push(s);
out(`RELEASE SECURITY GATE: ${mode.toUpperCase()}`);
out(`  tarball    ${tgz}`);
out(`  integrity  ${install.integrity}`);
out(`  build      ${install.build ? `${install.build.commit ?? "no commit"}${install.build.dirty ? " (dirty)" : ""} build_id ${install.build.build_id}` : "unstamped"}`);
out(`  version    ${install.version} (a label, never the identity)`);
out(`  deps       sha256 ${install.depsDigest} (npm ls --json --all)`);
out(`  os         ${platform} / node ${process.version} / vitest exit ${vitest.status}`);
out();

let violated = 0;
const waivers = [];
for (const inv of registry) {
  if (inv.waiver) waivers.push(`${inv.id}: ${inv.waiver.reason} (ruling ${inv.waiver.ruling_id}; revisit when ${inv.waiver.revisit_when})`);
  if (inv.status !== "active") {
    out(`  PENDING   ${inv.id}: ${inv.pending?.reason ?? "?"} [owner ${inv.pending?.owner ?? "?"}; blocked by ${inv.pending?.blocked_by ?? "?"}]`);
    continue;
  }
  if (!inv.os.includes(platform)) {
    out(`  N/A       ${inv.id}: not enforced on ${platform}${inv.not_yet?.[platform] ? ` (${inv.not_yet[platform].reason}: ${inv.not_yet[platform].blocked_by})` : ""}`);
    continue;
  }
  const verdicts = inv.tests.map((t) => [t.id, status.get(t.id) ?? "NOT RUN"]);
  const bad = verdicts.filter(([, s]) => s !== "passed");
  if (bad.length) violated++;
  out(`  ${bad.length ? "VIOLATED" : "HOLDS   "}  ${inv.id}${inv.conditional_on ? ` (conditional on ${inv.conditional_on.join(", ")})` : ""}`);
  for (const [id, s] of bad) out(`              ${s.toUpperCase()}: ${id}`);
  for (const [osName, ny] of Object.entries(inv.not_yet ?? {})) out(`              not yet on ${osName}: ${ny.reason} [${ny.blocked_by}]`);
}
out();
out(`  waivers: ${waivers.length}${waivers.length ? `\n    ${waivers.join("\n    ")}` : ""}`);

let code;
if (mode === "candidate") {
  code = violated === 0 && vitest.status === 0 ? 0 : 1;
  out(`VERDICT: ${code === 0 ? "PASS" : "FAIL"} (${violated} invariant(s) violated${vitest.status !== 0 && violated === 0 ? "; the suite itself failed" : ""})`);
} else {
  out(`KNOWN-BAD: pinned ${knownBad.version} ${knownBad.integrity}`);
  if (install.integrity === knownBad.integrity) {
    const blind = [];
    for (const tag of knownBad.must_fail) {
      const harms = [...status].filter(([id]) => id.split("::")[1].startsWith(`${tag} HARM`));
      const failed = harms.filter(([, s]) => s === "failed");
      out(`  must_fail ${tag}: ${harms.length} harm test(s), ${failed.length} failed ${failed.length ? "(seen)" : "(BLIND)"}`);
      if (!harms.length || !failed.length) blind.push(tag);
    }
    code = blind.length ? 1 : 0;
    out(`VERDICT: ${code === 0 ? "PASS: the suite sees the drift that shipped" : `FAIL: the suite went BLIND to ${blind.join(", ")}`}`);
  } else {
    code = 0;
    out(`  this tarball is NOT the pinned known-bad (a newer publish): REPORT ONLY. ${violated} invariant(s) violated in it: each is a security-advisory item.`);
    out("VERDICT: REPORTED");
  }
}
process.stdout.write(`\n${lines.join("\n")}\n`);
fs.rmSync(work, { recursive: true, force: true });
process.exit(code);
