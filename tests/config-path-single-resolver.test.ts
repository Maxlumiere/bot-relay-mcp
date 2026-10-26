// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ONE config-path resolver. src/config.ts getConfigPath (→ src/instance.ts) is the only code that decides where the
 * relay's config lives. A second copy drifts: backup.ts had one (RELAY_CONFIG_PATH else the flat ~/.bot-relay
 * file) that never got the per-instance resolution, so `relay backup` archived a stale config (MEASURED 20 Oct;
 * tests/backup-config-path.test.ts). This scan (tests/_helpers/config-path-sites.ts, the pinned parser) fails on any
 * READ of RELAY_CONFIG_PATH or any "config.json" name in src/ outside instance.ts and config.ts, unless that EXACT
 * expression is ALLOWLISTED below with its occurrence count and reason. Virtual fixtures prove it catches the forms the repo does not contain.
 */
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { srcProgram, virtualProgram } from "./_helpers/ts-binding.js";
import { configPathSites } from "./_helpers/config-path-sites.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // never URL.pathname: it keeps %20
/** The resolver itself. */
const RESOLVER_FILES = new Set(["src/config.ts", "src/instance.ts"]);

/**
 * Sites that name the variable or the file name for another purpose: the EXACT expression (the site's parent, as the
 * printer writes it), how many times it occurs, and WHY it is not a resolution. Never a whole function (Codex #343 R1:
 * a function-wide entry admits a replacement resolver written inside it).
 */
type Allowed = { count: number; why: string };
const ALLOWLIST: Record<string, Allowed> = {
  // The backup ARCHIVE MEMBER: the file inside the staging dir and the tar entry, not where the relay's config lives.
  'src/backup.ts::exportRelayState::file-name:path.join(stagingDir, "config.json")': { count: 2, why: "the staging dir's archive member (copy target, then its existence check)" },
  'src/backup.ts::exportRelayState::file-name:entries.push("config.json")': { count: 1, why: "the tar entry list's member name" },
  // doctor's report ROW LABEL (the path itself comes from run()'s one resolution).
  'src/cli/doctor.ts::checkConfig::file-name:name: "config.json"': { count: 5, why: "the report row's label, one per outcome" },
  // Save / restore of the env AROUND one resolution (the value is put back unchanged; nothing is resolved from it).
  "src/cli/doctor.ts::run::env-read:config: process.env.RELAY_CONFIG_PATH": { count: 1, why: "doctor saves the env it pins to the ONE resolution it reports, to restore it" },
  "src/cli/test.ts::run::env-read:originalConfigPath = process.env.RELAY_CONFIG_PATH": { count: 1, why: "relay test saves the operator's override to restore it after its sandbox run" },
  // `relay test`'s OWN sandbox: a config file in a fresh tmp dir, set as the explicit override for its child run.
  'src/cli/test.ts::run::file-name:path.join(tmpDir, "config.json")': { count: 1, why: "relay test's own tmp sandbox config (set as RELAY_CONFIG_PATH), not the operator's" },
  // The CLI's source REPORT (cli | env | default) for --config: it names where a value came from, it resolves nothing.
  'src/cli.ts::<module>::env-read:classify("config_path", "RELAY_CONFIG_PATH", flags.config, "__unreachable__")': { count: 1, why: "the source report names the env var a flag maps to" },
};

/** Judge sites against an allowlist: an unlisted key, a count that differs (more = a new site, fewer = stale), a listed key never seen. */
function judge(sites: ReturnType<typeof configPathSites>, allow: Record<string, Allowed>) {
  const counts = new Map<string, { n: number; lines: number[] }>();
  for (const s of sites) {
    const c = counts.get(s.key) ?? { n: 0, lines: [] };
    c.n++;
    c.lines.push(s.line);
    counts.set(s.key, c);
  }
  const offenders = [...counts].filter(([k]) => !(k in allow)).map(([k, c]) => `${k} (line ${c.lines.join(", ")})`);
  const miscounted = [...counts].filter(([k, c]) => k in allow && allow[k].count !== c.n).map(([k, c]) => `${k}: ${c.n} seen, ${allow[k].count} allowed (lines ${c.lines.join(", ")})`);
  const stale = Object.keys(allow).filter((k) => !counts.has(k));
  return { offenders, miscounted, stale };
}

describe("ONE config-path resolver (src/config.ts → src/instance.ts)", () => {
  const rel = (f: string) => path.relative(REPO, f).split(path.sep).join("/");

  it("no code in src/ reads RELAY_CONFIG_PATH or names config.json outside the resolver, unless that exact expression is allowlisted with its count; no entry is stale", () => {
    const sites = configPathSites(srcProgram(), rel, (f) => f.startsWith("src/") && !RESOLVER_FILES.has(f));
    const { offenders, miscounted, stale } = judge(sites, ALLOWLIST);
    expect(offenders, "resolve the config path through getConfigPath() (or instance.ts), or list the exact expression with a reason").toEqual([]);
    expect(miscounted, "an allowlisted expression occurs a different number of times").toEqual([]);
    expect(stale, "allowlist entries that match no site (remove them)").toEqual([]);
    // CONTROL: the resolver itself does both, so a scan that sees nothing there is blind.
    const resolver = configPathSites(srcProgram(), rel, (f) => RESOLVER_FILES.has(f));
    expect(resolver.some((s) => s.form === "env-read"), "the scan sees the resolver's own RELAY_CONFIG_PATH read").toBe(true);
    expect(resolver.some((s) => s.form === "file-name"), "the scan sees the resolver's own config.json segment").toBe(true);
  });

  // One fixture per form, ONE assertion each (a fixture bundled behind another's failure has no RED of its own).
  const fixtures: Record<string, string> = {
    "globals.d.ts": "declare var process: { env: Record<string, string | undefined> }; declare const dir: string; declare const stagingDir: string; declare function log(s: string): void; declare const env: Record<string, string | undefined>; declare const os: { homedir(): string };",
    "node_modules/@types/path/index.d.ts": 'declare module "path" { export function join(...p: string[]): string; export function resolve(...p: string[]): string; }',
    // CAUGHT: reads of the override
    "src/read-dot.ts": "export function a() { return process.env.RELAY_CONFIG_PATH; }",
    "src/read-element.ts": 'export function b() { return process.env["RELAY_CONFIG_PATH"]; }',
    "src/read-destructure.ts": "export function c() { const { RELAY_CONFIG_PATH } = process.env; return RELAY_CONFIG_PATH; }",
    "src/read-renamed.ts": "export function d() { const { RELAY_CONFIG_PATH: p } = process.env; return p; }",
    "src/read-alias-object.ts": "export function e() { return env.RELAY_CONFIG_PATH; }",
    "src/read-presence.ts": "export function f() { return !process.env.RELAY_CONFIG_PATH; }",
    "src/read-literal-key.ts": 'export function f2() { const { "RELAY_CONFIG_PATH": p } = process.env; return p; }',
    "src/read-computed-key.ts": 'export function f3() { const { ["RELAY_CONFIG_PATH"]: p } = process.env; return p; }',
    "src/read-const-key.ts": 'const K = "RELAY_CONFIG_PATH"; export function f4() { return process.env[K]; }',
    "src/read-name-list.ts": 'export const KEYS = ["RELAY_CONFIG_PATH", "RELAY_DB_PATH"];',
    // CAUGHT: the config file name, wherever it appears
    "src/name-join.ts": 'import path from "path"; export function g() { return path.join(dir, "config.json"); }',
    "src/name-named-import.ts": 'import { resolve } from "path"; export function h() { return resolve(dir, "config.json"); }',
    "src/name-const.ts": 'import path from "path"; const FILE = "config.json"; export function i() { return path.join(dir, FILE); }',
    "src/name-concat.ts": 'export function j() { return dir + "/config.json"; }',
    "src/name-template.ts": "export function k() { return `${dir}/config.json`; }",
    "src/name-fallback.ts": 'export function l() { return process.env.X || "/home/u/.bot-relay/config.json"; }',
    "src/name-assign.ts": 'import path from "path"; export function l2() { let name; name = "config.json"; return path.join(dir, name); }',
    "src/name-default.ts": 'import path from "path"; export function l3(name = "config.json") { return path.join(dir, name); }',
    "src/name-property.ts": 'import path from "path"; const o = { file: "config.json" }; export function l4() { return path.join(dir, o.file); }',
    "src/name-array.ts": 'import path from "path"; export function l5() { return path.join(dir, ...["config.json"]); }',
    // PASSED: setting the override, or a mention in prose
    "src/ok-assign.ts": "export function m() { process.env.RELAY_CONFIG_PATH = dir; }",
    "src/ok-assign-element.ts": 'export function m2() { process.env["RELAY_CONFIG_PATH"] = dir; }',
    "src/ok-delete.ts": "export function n() { delete process.env.RELAY_CONFIG_PATH; }",
    "src/ok-message.ts": 'export function o() { log(`config at ${dir} (see config.json docs)`); log("set RELAY_CONFIG_PATH to move it"); }',
    // THE BOUNDARY (documented, NOT seen): a name built at run time
    "src/boundary-runtime-name.ts": 'import path from "path"; export function p() { return path.join(dir, "config" + ".json"); }',
    // Codex #343 R1 #4: a REPLACEMENT resolver written inside an allowlisted function, and a second copy of an
    // allowlisted expression. Judged against an allowlist naming only the legitimate member expressions.
    "src/scoped/export.ts":
      'import path from "path"; export function exportState() { const a = path.join(stagingDir, "config.json"); const live = path.join(os.homedir(), ".bot-relay", "config.json"); return [a, live]; }',
    "src/scoped/twice.ts":
      'import path from "path"; export function twice() { const a = path.join(stagingDir, "config.json"); const b = path.join(stagingDir, "config.json"); return [a, b]; }',
  };
  const virtualRel = (f: string) => f.replace(/\\/g, "/").replace(/^(?:[A-Za-z]:)?\/virtual\//, "");
  let cached: ReturnType<typeof configPathSites> | undefined;
  const sites = () => (cached ??= configPathSites(virtualProgram(fixtures), virtualRel, (f) => f.startsWith("src/")));
  const forms = (file: string) => sites().filter((s) => s.key.startsWith(`src/${file}::`)).map((s) => s.form);

  it.each([
    "read-dot.ts",
    "read-element.ts",
    "read-destructure.ts",
    "read-renamed.ts",
    "read-alias-object.ts",
    "read-presence.ts",
    "read-literal-key.ts",
    "read-computed-key.ts",
    "read-const-key.ts",
    "read-name-list.ts",
  ])("CAUGHT a read of RELAY_CONFIG_PATH: %s", (f) => expect(forms(f)).toContain("env-read"));
  it.each(["name-join.ts", "name-named-import.ts", "name-const.ts", "name-concat.ts", "name-template.ts", "name-fallback.ts", "name-assign.ts", "name-default.ts", "name-property.ts", "name-array.ts"])(
    "CAUGHT the config file name: %s",
    (f) => expect(forms(f)).toContain("file-name"),
  );
  it.each(["ok-assign.ts", "ok-assign-element.ts", "ok-delete.ts", "ok-message.ts"])("PASSED setting the override, or a mention in prose: %s", (f) => expect(forms(f)).toEqual([]));
  it("BOUNDARY (documented, NOT seen): a file name built at run time", () => expect(forms("boundary-runtime-name.ts")).toEqual([]));

  const scoped = (file: string) => sites().filter((s) => s.key.startsWith(`src/scoped/${file}::`));
  it("CAUGHT a replacement resolver inside a function whose member expression is allowlisted", () => {
    const allow = { 'src/scoped/export.ts::exportState::file-name:path.join(stagingDir, "config.json")': { count: 1, why: "member" } };
    expect(judge(scoped("export.ts"), allow).offenders).toEqual([expect.stringContaining('path.join(os.homedir(), ".bot-relay", "config.json")')]);
  });
  it("CAUGHT a second copy of an allowlisted expression (the count)", () => {
    const allow = { 'src/scoped/twice.ts::twice::file-name:path.join(stagingDir, "config.json")': { count: 1, why: "member" } };
    expect(judge(scoped("twice.ts"), allow).miscounted).toHaveLength(1);
  });
  it("known-good twin: the allowlisted expression at its count passes", () => {
    const allow = { 'src/scoped/twice.ts::twice::file-name:path.join(stagingDir, "config.json")': { count: 2, why: "member" } };
    expect(judge(scoped("twice.ts"), allow)).toEqual({ offenders: [], miscounted: [], stale: [] });
  });
});
