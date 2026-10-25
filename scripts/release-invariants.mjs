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
 *                                                                    on the pinned integrity, every must_fail harm (an
 *                                                                    exact title) must be SEEN (failed WITH its
 *                                                                    observation mark); one
 *                                                                    that passes is BLIND (exit 1). Another integrity
 *                                                                    (a newer publish) is report-only. `latest` packs
 *                                                                    the registry's latest: offline, that FAILS.
 *   node scripts/release-invariants.mjs in-process                  the registry's IN-PROCESS tests that apply to this
 *                                                                    OS, run from the source tree: each must PASS
 *
 * Every mode first VALIDATES the registry (scripts/release-registry.mjs, the same rules the main suite checks): an
 * invalid registry is a harness fault before anything is judged. A package is identified by its tarball INTEGRITY,
 * never its version. Every run prints: the mode, the tarball, its integrity, its build stamp, its version (a label),
 * the resolved-dependency digest, this OS, each invariant's verdict, every pending invariant with its owner, and the
 * waiver count and list.
 *
 * Exit 0 = pass; 1 = a violation (or a BLIND control); 2 = a HARNESS FAULT: an invalid registry, a suite that did not
 * report, a file that failed to collect or set up, an expected test missing or skipped, or (control) a harm that failed
 * WITHOUT its observation mark, i.e. before its stimulus returned (a fixture fault is never "the drift was seen").
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectPools, loadRegistry, mustFailIds, validateRegistry } from "./release-registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [mode, target] = process.argv.slice(2);
const fault = (msg) => {
  process.stderr.write(`release-invariants: HARNESS FAULT: ${msg}\n`);
  process.exit(2);
};
if (!["candidate", "control", "in-process"].includes(mode) || (mode !== "in-process" && !target)) {
  fault("usage: release-invariants.mjs candidate <package.tgz>|--pack | control <package.tgz|latest> | in-process");
}

// 1. The registry is VALID, or nothing is judged.
const { invariants: registry, knownBad } = loadRegistry(ROOT);
let pools;
try {
  pools = collectPools(ROOT, registry);
} catch (err) {
  fault(`the registry's tests could not be listed: ${err.message}`);
}
const registryFaults = validateRegistry(registry, knownBad, pools);
if (registryFaults.length) fault(`the registry is invalid (${registryFaults.length}):\n  ${registryFaults.map((f) => `[${f.check}] ${f.msg}`).join("\n  ")}`);

const platform = process.platform;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "release-invariants-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const applies = (inv) => inv.status === "active" && inv.os.includes(platform);

/**
 * Run vitest under `config` with a JSON report; returns { vitest, byId, fileFaults }. byId maps
 * "<repo-relative file>::<test title>" to { status, observed, failures }. fileFaults: files that failed to collect or
 * whose hooks failed (a suite-level message), each a harness fault.
 */
function runSuite(config, files, env) {
  const results = path.join(work, `results-${path.basename(config)}.json`);
  const vitest = spawnSync(
    process.execPath,
    [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", path.join(ROOT, config), ...files, "--reporter=default", "--reporter=json", `--outputFile.json=${results}`],
    { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } },
  );
  if (!fs.existsSync(results)) fault(`the suite (${config}) produced no results (vitest exit ${vitest.status})`);
  let report;
  try {
    report = JSON.parse(fs.readFileSync(results, "utf-8"));
  } catch (err) {
    fault(`the suite's report (${config}) is not JSON: ${err.message}`);
  }
  if (!Array.isArray(report?.testResults) || report.testResults.length === 0) fault(`the suite (${config}) reported no test files (vitest exit ${vitest.status})`);
  const byId = new Map();
  const fileFaults = [];
  for (const f of report.testResults) {
    const rel = path.relative(ROOT, f.name).split(path.sep).join("/");
    if (typeof f.message === "string" && f.message.trim()) fileFaults.push(`${rel}: ${f.message.trim().split("\n")[0].slice(0, 300)}`);
    for (const a of f.assertionResults ?? []) {
      byId.set(`${rel}::${a.title}`, { status: a.status, observed: a.meta?.stimulus_returned === true, failures: a.failureMessages ?? [] });
    }
  }
  return { vitest, byId, fileFaults };
}

// 2. IN-PROCESS: the registry's source-tree tests for this OS must each PASS.
if (mode === "in-process") {
  const expected = registry.filter(applies).flatMap((inv) => inv.tests.filter((t) => t.mode === "in-process").map((t) => [inv.id, t.id]));
  const lines = [`RELEASE SECURITY GATE: IN-PROCESS`, `  os         ${platform} / node ${process.version}`, ""];
  if (expected.length === 0) {
    lines.push(`  no active invariant names an in-process test on ${platform}`, "VERDICT: PASS (0 expected)");
    process.stdout.write(`\n${lines.join("\n")}\n`);
    fs.rmSync(work, { recursive: true, force: true });
    process.exit(0);
  }
  const files = [...new Set(expected.map(([, id]) => id.split("::")[0]))];
  const { vitest, byId, fileFaults } = runSuite("vitest.config.ts", files, {});
  if (fileFaults.length) fault(`a test file failed to collect or set up:\n  ${fileFaults.join("\n  ")}`);
  const bad = [];
  for (const [inv, id] of expected) {
    const r = byId.get(id);
    if (!r) fault(`${inv}: expected in-process test ${id} has NO result (not collected or not run)`);
    if (r.status !== "passed") bad.push(`${inv}: ${r.status.toUpperCase()}: ${id}`);
  }
  for (const [inv, id] of expected) lines.push(`  ${byId.get(id).status === "passed" ? "passed  " : byId.get(id).status.toUpperCase().padEnd(8)}  ${inv}: ${id}`);
  lines.push("", `VERDICT: ${bad.length ? `FAIL (${bad.length} of ${expected.length} expected in-process tests did not pass)` : `PASS (${expected.length} expected in-process tests passed; vitest exit ${vitest.status})`}`);
  process.stdout.write(`\n${lines.join("\n")}\n`);
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(bad.length ? 1 : 0);
}

// 3. CANDIDATE / CONTROL: the installed package.
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

const installReport = path.join(work, "install.json");
const { vitest, byId: status, fileFaults } = runSuite("vitest.release.config.ts", [], { RELAY_RELEASE_TGZ: tgz, RELAY_RELEASE_REPORT: installReport });
if (!fs.existsSync(installReport)) fault(`the suite installed nothing (vitest exit ${vitest.status})`);
const install = JSON.parse(fs.readFileSync(installReport, "utf-8"));

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
const flush = () => process.stdout.write(`\n${lines.join("\n")}\n`);
if (fileFaults.length) {
  flush();
  fault(`a release test file failed to collect or set up (nothing in it was observed):\n  ${fileFaults.join("\n  ")}`);
}

let violated = 0;
const missing = [];
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
  // This gate runs the INSTALLED-package suite only, so only those tests decide here. An in-process test is run by
  // the `in-process` mode (the same workflow), against the source tree: it is listed here, never judged. An active
  // invariant with no installed test is WAIVED only with its waiver (the registry check requires one), never HOLDS.
  const judged = inv.tests.filter((t) => t.mode === "installed");
  const inProcess = inv.tests.filter((t) => t.mode !== "installed");
  const verdicts = judged.map((t) => [t.id, status.get(t.id)?.status ?? "NOT RUN"]);
  for (const [id, s] of verdicts) if (s === "NOT RUN") missing.push(`${inv.id}: ${id}`);
  const bad = verdicts.filter(([, s]) => s !== "passed");
  if (bad.length || (!judged.length && !inv.waiver)) violated++;
  const label = bad.length ? "VIOLATED" : judged.length ? "HOLDS   " : inv.waiver ? "WAIVED  " : "VIOLATED";
  out(`  ${label}  ${inv.id}${inv.conditional_on ? ` (conditional on ${inv.conditional_on.join(", ")})` : ""}`);
  for (const [id, s] of bad) out(`              ${s.toUpperCase()}: ${id}`);
  for (const t of inProcess) out(`              in-process (run by the in-process mode, not judged here): ${t.id}`);
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
    // Each must_fail harm (an exact title, FROM THE REGISTRY): SEEN only when it failed WITH its observation mark (its
    // stimulus returned a well-formed response first). Passed = BLIND. Failed without the mark, skipped, or absent = a
    // harness fault. Every listed harm must be seen; harms NOT listed are reported below, never judged.
    const blind = [];
    const faults = [];
    let seenCount = 0;
    for (const title of knownBad.must_fail) {
      const r = status.get(mustFailIds(registry, title)[0]);
      let label;
      if (r && r.status === "failed" && r.observed) {
        label = "SEEN";
        seenCount++;
      } else if (r && r.status === "passed") {
        label = "BLIND (passed)";
        blind.push(title);
      } else {
        const why = !r
          ? "no result"
          : r.status === "failed"
            ? `FAILED BEFORE ITS STIMULUS RETURNED (a fixture fault, not an observation): ${(r.failures[0] ?? "").split("\n")[0].slice(0, 200)}`
            : `${r.status.toUpperCase()} (not executed)`;
        label = "FAULT";
        faults.push(`${title}: ${why}`);
      }
      out(`  must_fail ${label.padEnd(14)} ${title}`);
    }
    const listed = new Set(knownBad.must_fail);
    for (const [id, r] of status) {
      const title = id.split("::").slice(1).join("::");
      if (/^SEC-[0-9.]+T[0-9]+ HARM /.test(title) && !listed.has(title)) out(`  reported      ${r.status}${r.observed ? " (observed)" : ""}: ${title} (not judged on the known-bad)`);
    }
    if (faults.length) {
      for (const f of faults) out(`  FAULT     ${f}`);
      out("VERDICT: HARNESS FAULT: the control did not observe what it claims (exit 2)");
      flush();
      fs.rmSync(work, { recursive: true, force: true });
      process.exit(2);
    }
    code = blind.length ? 1 : 0;
    out(`VERDICT: ${code === 0 ? `PASS: the suite sees the drift that shipped (${seenCount}/${knownBad.must_fail.length} harms seen)` : `FAIL: the suite went BLIND to:\n    ${blind.join("\n    ")}`}`);
  } else {
    // Report-only, but only on a COMPLETE report: every applicable installed test executed.
    if (missing.length) {
      out(`  FAULT     ${missing.length} applicable installed test(s) have no result:\n              ${missing.join("\n              ")}`);
      out("VERDICT: HARNESS FAULT: an incomplete report is not a report (exit 2)");
      flush();
      fs.rmSync(work, { recursive: true, force: true });
      process.exit(2);
    }
    code = 0;
    out(`  this tarball is NOT the pinned known-bad (a newer publish): REPORT ONLY. ${violated} invariant(s) violated in it: each is a security-advisory item.`);
    out("VERDICT: REPORTED");
  }
}
flush();
fs.rmSync(work, { recursive: true, force: true });
process.exit(code);
