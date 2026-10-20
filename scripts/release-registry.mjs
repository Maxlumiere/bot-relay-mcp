// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The security invariant registry (security/invariants.json + security/known-bad.json): ONE place that loads it,
 * lists the tests it names, and VALIDATES it. Both consumers call this module, so the rules cannot drift:
 *   - scripts/release-invariants.mjs: a mandatory prerequisite of every gate run (an invalid registry is a harness
 *     fault, exit 2, before anything is judged);
 *   - tests/security-registry.test.ts: the same checks in the main suite, one test per check.
 * A security rule with no test is not a rule (the release security gate, R1).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const STATUSES = ["active", "pending"];
export const MODES = ["installed", "in-process"];
export const OSES = ["darwin", "linux", "win32"];
export const CHECKS = ["shape", "active-coverage", "orphans", "waivers", "pending", "known-bad"];

/** The registry and the known-bad control, parsed (a parse failure throws: there is nothing to validate). */
export function loadRegistry(root) {
  const invariants = JSON.parse(fs.readFileSync(path.join(root, "security", "invariants.json"), "utf-8")).invariants;
  const knownBad = JSON.parse(fs.readFileSync(path.join(root, "security", "known-bad.json"), "utf-8"));
  return { invariants, knownBad };
}

/**
 * "<repo-relative file>::<test title>" for every test vitest collects under `config` (`vitest list --json`: nothing
 * runs). Throws when the listing fails: an unlisted suite is never read as an empty one.
 */
export function listTests(root, config, files = []) {
  const r = spawnSync(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "list", "--json", "--config", path.join(root, config), ...files], {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, RELAY_RELEASE_LIST_ONLY: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`vitest list (${config}) failed (exit ${r.status}): ${(r.stderr || "").slice(-1500)}`);
  const out = new Set();
  for (const t of JSON.parse(r.stdout)) {
    const title = t.name.split(" > ").at(-1);
    out.add(`${path.relative(root, t.file).split(path.sep).join("/")}::${title}`);
  }
  return out;
}

/** The files the registry's in-process tests live in. */
export function inProcessFiles(invariants) {
  return [...new Set(invariants.flatMap((i) => (Array.isArray(i.tests) ? i.tests : []).filter((t) => t.mode === "in-process").map((t) => String(t.id).split("::")[0])))];
}

/** Both test pools, listed by vitest itself: the release suite, and the main suite's files the registry names. */
export function collectPools(root, invariants) {
  const files = inProcessFiles(invariants);
  return {
    releaseTests: listTests(root, "vitest.release.config.ts"),
    inProcessTests: files.length ? listTests(root, "vitest.config.ts", files) : new Set(),
  };
}

const filled = (v) => typeof v === "string" && v.trim().length > 0;
/**
 * A title `vitest list` cannot resolve: it reads titles STATICALLY, so a template's `${...}` or an it.each `%s` stays
 * unexpanded (MEASURED 20 Oct, vitest 5), and an id built from the expanded title never matches.
 */
const STATIC_TITLE_HINT = "title not statically resolvable: use a literal title (vitest list reads titles statically; a template ${...} or an it.each %s stays unexpanded)";
const dynamicTitle = (id) => /\$\{|%[sdifjo#]/.test(String(id).split("::").slice(1).join("::"));

/**
 * Every rule the registry must meet, as `{ check, msg }` faults (empty = valid). `pools` comes from collectPools: an
 * id that no collected test matches does not exist. `check` is one of CHECKS.
 */
export function validateRegistry(invariants, knownBad, pools) {
  const faults = [];
  const fault = (check, msg) => faults.push({ check, msg });
  if (!Array.isArray(invariants) || invariants.length === 0) {
    fault("shape", "the registry holds no invariants");
    return faults;
  }
  const ids = invariants.map((i) => i?.id);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) fault("shape", `${id}: duplicate id`);
  for (const i of invariants) {
    const id = i?.id ?? "<no id>";
    if (!filled(i?.id)) fault("shape", "an invariant has no id");
    if (!(typeof i?.statement === "string" && i.statement.length > 10)) fault("shape", `${id}: no statement`);
    if (!filled(i?.source)) fault("shape", `${id}: no source`);
    if (!Array.isArray(i?.os) || i.os.length === 0) fault("shape", `${id}: no os list`);
    else for (const o of i.os) if (!OSES.includes(o)) fault("shape", `${id}: unknown os ${JSON.stringify(o)}`);
    if (!STATUSES.includes(i?.status)) fault("shape", `${id}: unknown status ${JSON.stringify(i?.status)} (one of ${STATUSES.join(", ")})`);
    if (!Array.isArray(i?.tests)) fault("shape", `${id}: tests is not a list`);
    else for (const t of i.tests) {
      if (!filled(t?.id) || !String(t.id).includes("::")) fault("shape", `${id}: a test id is not "<file>::<title>": ${JSON.stringify(t?.id)}`);
      if (!MODES.includes(t?.mode)) fault("shape", `${id}: unknown test mode ${JSON.stringify(t?.mode)} (one of ${MODES.join(", ")})`);
    }
  }
  const testsOf = (i) => (Array.isArray(i?.tests) ? i.tests : []);

  // An ACTIVE invariant names at least one test, and each one RESOLVES to a collected test.
  for (const i of invariants.filter((x) => x?.status === "active")) {
    if (testsOf(i).length === 0) fault("active-coverage", `${i.id}: active with no test`);
    for (const t of testsOf(i)) {
      const pool = t.mode === "installed" ? pools.releaseTests : pools.inProcessTests;
      if (dynamicTitle(t.id)) fault("active-coverage", `${i.id}: ${t.mode} test ${t.id}: ${STATIC_TITLE_HINT}`);
      else if (!pool.has(t.id)) fault("active-coverage", `${i.id}: ${t.mode} test ${t.id} matches no collected test`);
    }
  }

  // Every release test belongs to an invariant (no orphan the gate would never report).
  const named = new Set(invariants.flatMap((i) => testsOf(i).map((t) => t.id)));
  if (pools.releaseTests.size === 0) fault("orphans", "the release suite collected no tests");
  for (const t of pools.releaseTests) {
    if (dynamicTitle(t)) fault("orphans", `release test ${t}: ${STATIC_TITLE_HINT}`);
    else if (!named.has(t)) fault("orphans", `release test ${t} belongs to no invariant`);
  }

  // An active invariant with no INSTALLED test carries a complete waiver; every waiver is complete.
  for (const i of invariants) {
    if (i?.status === "active" && testsOf(i).length > 0 && !testsOf(i).some((t) => t.mode === "installed") && !i.waiver) {
      fault("waivers", `${i.id}: only in-process tests and no waiver`);
    }
    if (i?.waiver) for (const k of ["reason", "ruling_id", "revisit_when"]) if (!filled(i.waiver[k])) fault("waivers", `${i.id}: waiver.${k} missing`);
  }

  // A PENDING invariant names its reason, owner and blocker; so does a per-OS gap; conditions name real invariants.
  for (const i of invariants) {
    if (i?.status === "pending") for (const k of ["reason", "owner", "blocked_by"]) if (!filled(i.pending?.[k])) fault("pending", `${i.id}: pending.${k} missing`);
    for (const [o, gap] of Object.entries(i?.not_yet ?? {})) {
      if (!OSES.includes(o)) fault("pending", `${i.id}: not_yet names an unknown os ${JSON.stringify(o)}`);
      if (Array.isArray(i.os) && i.os.includes(o)) fault("pending", `${i.id}: not_yet.${o}, but os includes ${o}`);
      for (const k of ["reason", "owner", "blocked_by"]) if (!filled(gap?.[k])) fault("pending", `${i.id}: not_yet.${o}.${k} missing`);
    }
    for (const c of i?.conditional_on ?? []) if (!ids.includes(c)) fault("pending", `${i.id}: conditional_on names an unknown invariant ${c}`);
  }

  // The known-bad control pins an INTEGRITY, and each must_fail entry is the exact title of ONE HARM test in the registry.
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(String(knownBad?.integrity))) fault("known-bad", `the known-bad control pins no sha512 integrity: ${JSON.stringify(knownBad?.integrity)}`);
  if (!Array.isArray(knownBad?.must_fail) || knownBad.must_fail.length === 0) fault("known-bad", "the known-bad control names no must_fail harm");
  for (const title of knownBad?.must_fail ?? []) {
    const n = mustFailIds(invariants, title).length;
    if (!/^SEC-[0-9.]+T[0-9]+ HARM /.test(String(title))) fault("known-bad", `must_fail ${JSON.stringify(title)} is not a HARM test title`);
    else if (n !== 1) fault("known-bad", `must_fail ${JSON.stringify(title)} names ${n} registry tests (exactly 1 expected)`);
  }
  return faults;
}

/** The registry test id(s) (full "<file>::<title>") whose title IS a must_fail entry, FROM THE REGISTRY (so a missing result is seen). */
export function mustFailIds(invariants, title) {
  return invariants.flatMap((i) => (Array.isArray(i.tests) ? i.tests : []).map((t) => t.id)).filter((id) => String(id).split("::").slice(1).join("::") === title);
}
