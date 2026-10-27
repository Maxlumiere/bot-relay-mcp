// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * scripts/pre-publish-check.sh's preflight, and the extension-deps check (the 4.0.0 publish, 26 Oct):
 *   - the gate refuses to start in the SERVING tree (prebuild-guard --publish), before any step;
 *   - a real `npm publish` (npm_lifecycle_event=prepublishOnly) checks `npm whoami` BEFORE the gate, not after
 *     the ~20-minute run (the gate passed, then the upload failed on an expired login);
 *   - the extension steps install when a tool they run is missing, not only when node_modules is absent (an
 *     EMPTY node_modules skipped the install, and the bundle then failed on a missing esbuild).
 *
 * The script runs from a temp COPY of scripts/ (its PROJECT_ROOT is the copy's parent), with `npm` and `npx`
 * replaced by logging stubs on PATH and a private HOME, so nothing installs, builds or reaches the registry.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prepub-preflight-")));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("relay_ext_deps_missing (scripts/lib/ext-deps.sh): install when a tool is missing, not only when node_modules is absent", () => {
  const missing = (setup: (dir: string) => void) => {
    const dir = fs.mkdtempSync(path.join(TMP, "ext-"));
    setup(dir);
    const r = spawnSync("bash", ["-c", `. "${path.join(REPO, "scripts", "lib", "ext-deps.sh")}"; relay_ext_deps_missing "$1"`, "_", dir]);
    return r.status === 0;
  };
  const tool = (dir: string, name: string) => {
    fs.mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", ".bin", name), "#!/bin/sh\n", { mode: 0o755 });
  };
  it("node_modules absent → missing", () => expect(missing(() => {})).toBe(true));
  it("HARM: node_modules EMPTY → missing (the old `[ ! -d node_modules ]` read this as installed)", () => {
    expect(missing((d) => fs.mkdirSync(path.join(d, "node_modules")))).toBe(true);
    const old = spawnSync("bash", ["-c", 'cd "$1" && [ ! -d node_modules ]', "_", fs.mkdtempSync(path.join(TMP, "old-"))]);
    expect(old.status, "control: the old test on a dir WITHOUT node_modules says install").toBe(0);
    const emptyDir = fs.mkdtempSync(path.join(TMP, "old-empty-"));
    fs.mkdirSync(path.join(emptyDir, "node_modules"));
    expect(spawnSync("bash", ["-c", 'cd "$1" && [ ! -d node_modules ]', "_", emptyDir]).status, "the defect: the old test skips the install on an EMPTY node_modules").toBe(1);
  });
  it("only esbuild present → missing (tsc is needed too)", () => expect(missing((d) => tool(d, "esbuild"))).toBe(true));
  it("Windows: .cmd shims for both tools count as present; a .cmd for only one is still missing", () => {
    const cmd = (dir: string, name: string) => {
      fs.mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", ".bin", `${name}.cmd`), "@echo off\r\n");
    };
    expect(missing((d) => { cmd(d, "esbuild"); cmd(d, "tsc"); })).toBe(false);
    expect(missing((d) => cmd(d, "esbuild"))).toBe(true);
  });
  it("TWIN: esbuild and tsc present → not missing (no reinstall)", () => {
    expect(missing((d) => { tool(d, "esbuild"); tool(d, "tsc"); })).toBe(false);
  });
  it("the gate USES it: both extension install sites call relay_ext_deps_missing, and no `[ ! -d node_modules ]` is left", () => {
    const gate = fs.readFileSync(path.join(REPO, "scripts", "pre-publish-check.sh"), "utf-8");
    expect(gate.split('relay_ext_deps_missing "$ext_dir"').length - 1, "the bundle and the compile steps").toBe(2);
    expect(gate).not.toMatch(/\[ ! -d node_modules \]/);
    expect(gate).toMatch(/^\. "\$PROJECT_ROOT\/scripts\/lib\/ext-deps\.sh"$/m);
  });
});

describe("pre-publish-check.sh preflight: refused or stopped BEFORE any step", () => {
  /** A copy of scripts/ under a fresh root, plus PATH stubs for npm/npx that log every call. */
  const DEFAULT_REG = "https://reg.default.test/";
  const sandbox = (tag: string, opts: { marker?: boolean; whoami: "ok" | "fail"; publishRegistry?: string }) => {
    const root = path.join(TMP, tag);
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(path.join(REPO, "scripts"), path.join(root, "scripts"), { recursive: true });
    if (opts.marker) fs.writeFileSync(path.join(root, ".relay-prod-tree"), "");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "bot-relay-mcp", version: "0.0.0", ...(opts.publishRegistry ? { publishConfig: { registry: opts.publishRegistry } } : {}) }));
    const bin = path.join(root, ".stub-bin");
    fs.mkdirSync(bin);
    const log = path.join(root, "calls.log");
    fs.writeFileSync(
      path.join(bin, "npm"),
      `#!/bin/sh\necho "npm $*" >> "${log}"\n[ "$1 $2 $3" = "config get registry" ] && { echo "${DEFAULT_REG}"; exit 0; }\n[ "$1" = whoami ] && exit ${opts.whoami === "ok" ? 0 : 1}\nexit 1\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(bin, "npx"), `#!/bin/sh\necho "npx $*" >> "${log}"\nexit 1\n`, { mode: 0o755 });
    const home = path.join(root, ".home");
    fs.mkdirSync(home);
    return { root, bin, log, home };
  };
  const run = (s: ReturnType<typeof sandbox>, env: Record<string, string>) => {
    const r = spawnSync("bash", [path.join(s.root, "scripts", "pre-publish-check.sh")], {
      encoding: "utf-8",
      timeout: 60_000,
      env: { PATH: `${s.bin}:${process.env.PATH ?? ""}`, HOME: s.home, ...env },
    });
    const calls = fs.existsSync(s.log) ? fs.readFileSync(s.log, "utf-8").split("\n").filter(Boolean) : [];
    return { status: r.status, out: `${r.stdout}\n${r.stderr}`, calls };
  };

  it("HARM: the SERVING tree (.relay-prod-tree) is refused first: exit 1, no npm/npx call, no step started", () => {
    const s = sandbox("serving", { marker: true, whoami: "ok" });
    const r = run(s, { npm_lifecycle_event: "prepublishOnly", RELAY_ALLOW_PROD_BUILD: "1" });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/REFUSING to run the pre-publish gate in the PRODUCTION relay tree/);
    expect(r.calls, "nothing ran: not even the login check").toEqual([]);
    expect(r.out).not.toMatch(/=== pre-publish:/);
  });

  it("HARM: a publish with no valid npm login stops BEFORE the gate: exit 1, the only call is `npm whoami`", () => {
    const s = sandbox("nologin", { whoami: "fail" });
    const r = run(s, { npm_lifecycle_event: "prepublishOnly" });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/npm whoami --registry https:\/\/reg\.default\.test\/ failed: not logged in/);
    expect(r.calls, "the configured registry is asked, then the login is checked THERE").toEqual(["npm config get registry", `npm whoami --registry ${DEFAULT_REG}`]);
    expect(r.out).not.toMatch(/=== pre-publish:/);
  });

  it("TWIN: a publish WITH a login passes the preflight and reaches step 1 (the stubbed npx fails it there)", () => {
    const s = sandbox("login", { whoami: "ok" });
    const r = run(s, { npm_lifecycle_event: "prepublishOnly" });
    expect(r.calls.slice(0, 2)).toEqual(["npm config get registry", `npm whoami --registry ${DEFAULT_REG}`]);
    expect(r.out).toMatch(/=== pre-publish: tsc --noEmit ===/);
    expect(r.calls).toContain("npx tsc --noEmit");
  });

  it("publishConfig.registry wins: the login is checked against the registry npm publish will upload to", () => {
    const s = sandbox("pubreg", { whoami: "fail", publishRegistry: "https://reg.publish.test/" });
    const r = run(s, { npm_lifecycle_event: "prepublishOnly" });
    expect(r.status).toBe(1);
    expect(r.calls, "no fallback to the configured registry when publishConfig names one").toEqual(["npm whoami --registry https://reg.publish.test/"]);
  });

  it("TWIN: outside a publish (the gate run standalone, or CI's smoke) the login is never checked", () => {
    const s = sandbox("standalone", { whoami: "fail" });
    const r = run(s, {});
    expect(r.calls.some((c) => c.startsWith("npm whoami")), "no login check outside npm publish").toBe(false);
    expect(r.out).toMatch(/=== pre-publish: tsc --noEmit ===/);
  });
});
