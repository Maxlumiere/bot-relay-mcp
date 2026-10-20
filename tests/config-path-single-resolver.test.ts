// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ONE config-path resolver. src/config.ts getConfigPath (→ src/instance.ts) is the only code that decides where the
 * relay's config lives. A second copy drifts: backup.ts had one (RELAY_CONFIG_PATH else the flat ~/.bot-relay
 * file) that never got the per-instance resolution, so `relay backup` archived a stale config (MEASURED 20 Oct;
 * tests/backup-config-path.test.ts). This scan (tests/_helpers/config-path-sites.ts, the pinned parser) fails on any
 * READ of RELAY_CONFIG_PATH or any "config.json" path segment in src/ outside instance.ts and config.ts, unless it
 * is ALLOWLISTED below with its reason. Virtual fixtures prove it catches the forms the repo does not contain.
 */
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { srcProgram, virtualProgram } from "./_helpers/ts-binding.js";
import { configPathSites } from "./_helpers/config-path-sites.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // never URL.pathname: it keeps %20
/** The resolver itself. */
const RESOLVER_FILES = new Set(["src/config.ts", "src/instance.ts"]);

/** Sites that name the variable or the file name for another purpose, each with WHY it is not a resolution. */
const ALLOWLIST: Record<string, string> = {};

describe("ONE config-path resolver (src/config.ts → src/instance.ts)", () => {
  const rel = (f: string) => path.relative(REPO, f).split(path.sep).join("/");

  it("no code in src/ reads RELAY_CONFIG_PATH or builds a config.json path outside the resolver, unless allowlisted; no allowlist entry is stale", () => {
    const sites = configPathSites(srcProgram(), rel, (f) => f.startsWith("src/") && !RESOLVER_FILES.has(f));
    const offenders = sites.filter((s) => !(s.key in ALLOWLIST)).map((s) => `${s.key} (line ${s.line})`);
    expect(offenders, "resolve the config path through getConfigPath() (or instance.ts), or list the site with a reason").toEqual([]);
    const seen = new Set(sites.map((s) => s.key));
    expect(Object.keys(ALLOWLIST).filter((k) => !seen.has(k)), "allowlist entries that match no site (remove them)").toEqual([]);
    // CONTROL: the resolver itself does both, so a scan that sees nothing there is blind.
    const resolver = configPathSites(srcProgram(), rel, (f) => RESOLVER_FILES.has(f));
    expect(resolver.some((s) => s.form === "env-read"), "the scan sees the resolver's own RELAY_CONFIG_PATH read").toBe(true);
    expect(resolver.some((s) => s.form === "file-name"), "the scan sees the resolver's own config.json segment").toBe(true);
  });

  // One fixture per form, ONE assertion each (a fixture bundled behind another's failure has no RED of its own).
  const fixtures: Record<string, string> = {
    "globals.d.ts": "declare var process: { env: Record<string, string | undefined> }; declare const dir: string; declare function log(s: string): void; declare const env: Record<string, string | undefined>;",
    "node_modules/@types/path/index.d.ts": 'declare module "path" { export function join(...p: string[]): string; export function resolve(...p: string[]): string; }',
    // CAUGHT: reads of the override
    "src/read-dot.ts": "export function a() { return process.env.RELAY_CONFIG_PATH; }",
    "src/read-element.ts": 'export function b() { return process.env["RELAY_CONFIG_PATH"]; }',
    "src/read-destructure.ts": "export function c() { const { RELAY_CONFIG_PATH } = process.env; return RELAY_CONFIG_PATH; }",
    "src/read-renamed.ts": "export function d() { const { RELAY_CONFIG_PATH: p } = process.env; return p; }",
    "src/read-alias-object.ts": "export function e() { return env.RELAY_CONFIG_PATH; }",
    "src/read-presence.ts": "export function f() { return !process.env.RELAY_CONFIG_PATH; }",
    // CAUGHT: the file name used to build a path
    "src/name-join.ts": 'import path from "path"; export function g() { return path.join(dir, "config.json"); }',
    "src/name-named-import.ts": 'import { resolve } from "path"; export function h() { return resolve(dir, "config.json"); }',
    "src/name-const.ts": 'import path from "path"; const FILE = "config.json"; export function i() { return path.join(dir, FILE); }',
    "src/name-concat.ts": 'export function j() { return dir + "/config.json"; }',
    "src/name-template.ts": "export function k() { return `${dir}/config.json`; }",
    "src/name-fallback.ts": 'export function l() { return process.env.X || "/home/u/.bot-relay/config.json"; }',
    // PASSED: setting the override, naming it, or the name in a message
    "src/ok-assign.ts": "export function m() { process.env.RELAY_CONFIG_PATH = dir; }",
    "src/ok-delete.ts": "export function n() { delete process.env.RELAY_CONFIG_PATH; }",
    "src/ok-mention.ts": 'export const KEYS = ["RELAY_CONFIG_PATH", "RELAY_DB_PATH"];',
    "src/ok-message.ts": 'export function o() { log(`config at ${dir} (see config.json docs)`); return { name: "config.json" }; }',
    // THE BOUNDARY (documented, NOT seen): a name built at run time
    "src/boundary-runtime-name.ts": 'import path from "path"; export function p() { return path.join(dir, "config" + ".json"); }',
  };
  const virtualRel = (f: string) => f.replace(/\\/g, "/").replace(/^(?:[A-Za-z]:)?\/virtual\//, "");
  let cached: ReturnType<typeof configPathSites> | undefined;
  const sites = () => (cached ??= configPathSites(virtualProgram(fixtures), virtualRel, (f) => f.startsWith("src/")));
  const forms = (file: string) => sites().filter((s) => s.key.startsWith(`src/${file}::`)).map((s) => s.form);

  it.each(["read-dot.ts", "read-element.ts", "read-destructure.ts", "read-renamed.ts", "read-alias-object.ts", "read-presence.ts"])("CAUGHT a read of RELAY_CONFIG_PATH: %s", (f) =>
    expect(forms(f)).toContain("env-read"),
  );
  it.each(["name-join.ts", "name-named-import.ts", "name-const.ts", "name-concat.ts", "name-template.ts", "name-fallback.ts"])("CAUGHT the config file name building a path: %s", (f) =>
    expect(forms(f)).toContain("file-name"),
  );
  it.each(["ok-assign.ts", "ok-delete.ts", "ok-mention.ts", "ok-message.ts"])("PASSED setting, naming, or mentioning it: %s", (f) => expect(forms(f)).toEqual([]));
  it("BOUNDARY (documented, NOT seen): a file name built at run time", () => expect(forms("boundary-runtime-name.ts")).toEqual([]));
});
