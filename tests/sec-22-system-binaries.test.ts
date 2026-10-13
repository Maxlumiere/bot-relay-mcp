// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-22: every security- or liveness-relevant subprocess is invoked by an ABSOLUTE trusted path, never resolved
 * through PATH (src/system-binary.ts).
 *
 * THE DEFECT (MEASURED, windows-2022, the release gate's first catch): the relay ran `whoami /user` BY NAME. Under Git
 * Bash, Git's GNU coreutils `whoami` comes first on PATH and answers "extra operand '/user'": the relay could not read
 * its own SID and refused its own registration secret. A planted `whoami` first on PATH could also report a forged SID
 * to the owner-only checks.
 *
 * Here:
 *   - systemBinary's validation (every OS): a missing, relative or UNC SystemRoot, a non-Windows platform, or a missing
 *     exe is a NAMED SystemBinaryError, never a PATH lookup;
 *   - Windows: with Git's usr/bin FIRST on PATH, the relay still reads its real SID (RED before the fix: null); with a
 *     PLANTED whoami printing a forged SID first on PATH, the relay ignores it (RED before: the forged SID);
 *   - the source scan: every call that binds to child_process's spawn family in src/ starts its program through
 *     systemBinary(...) or process.execPath, or is on ALLOWLIST with its reason. The scan resolves bindings (aliases,
 *     namespaces) with the pinned parser; virtual fixtures prove it catches the forms the repo does not contain.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { srcProgram, virtualProgram } from "./_helpers/ts-binding.js";
import { subprocessSites } from "./_helpers/subprocess-sites.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // never URL.pathname: it keeps %20
const { systemBinary, SystemBinaryError } = await import("../src/system-binary.js");

describe("SEC-22: systemBinary validates SystemRoot and fails CLOSED with a named error", () => {
  it.each([
    ["not Windows", { SystemRoot: "C:\\Windows" }, "linux", /it is a Windows tool/],
    ["SystemRoot missing", {}, "win32", /SystemRoot invalid \(null/],
    ["SystemRoot relative", { SystemRoot: "Windows" }, "win32", /SystemRoot invalid/],
    ["SystemRoot UNC", { SystemRoot: "\\\\attacker\\share" }, "win32", /SystemRoot invalid/],
    ["SystemRoot drive-relative", { SystemRoot: "C:Windows" }, "win32", /SystemRoot invalid/],
  ] as const)("HARM %s → SystemBinaryError", (_label, env, platform, msg) => {
    expect(() => systemBinary("whoami", env, platform)).toThrow(SystemBinaryError);
    expect(() => systemBinary("whoami", env, platform)).toThrow(msg);
  });

  it("HARM a valid-looking SystemRoot whose exe is absent → a named 'not a regular file', never a PATH lookup", () => {
    const fake = process.platform === "win32" ? path.join(os.tmpdir(), "no-such-systemroot") : "Z:\\NoSuchWindows";
    expect(() => systemBinary("icacls", { SystemRoot: fake }, "win32")).toThrow(/cannot locate the system icacls: .*is not a regular file/);
  });

  it.runIf(process.platform === "win32")("TWIN (Windows) each tool resolves to its absolute System32 path, and it exists", () => {
    const root = process.env.SystemRoot!;
    expect(systemBinary("whoami")).toBe(path.win32.join(root, "System32", "whoami.exe"));
    expect(systemBinary("icacls")).toBe(path.win32.join(root, "System32", "icacls.exe"));
    expect(systemBinary("powershell")).toBe(path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  });
});

describe.runIf(process.platform === "win32")("SEC-22 (Windows): the relay's SID never comes from a PATH-found whoami", () => {
  const savedPath = process.env.Path ?? process.env.PATH;
  const savedNodeOptions = process.env.NODE_OPTIONS;
  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedNodeOptions;
    vi.resetModules();
  });
  /** The real SID, from the system whoami by absolute path. */
  const realSid = () => /"(S-1-[0-9-]+)"\s*$/m.exec(spawnSync(path.win32.join(process.env.SystemRoot!, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf-8" }).stdout)![1];
  /** A FRESH fs-perms (its SID cache empty), as a newly started relay has. */
  const freshUserSid = async () => {
    vi.resetModules();
    return (await import("../src/fs-perms.js")).windowsUserSid();
  };

  it("HARM Git Bash's PATH (GNU whoami first): the relay still reads its real SID", async () => {
    const gitUsrBin = "C:\\Program Files\\Git\\usr\\bin";
    expect(fs.existsSync(path.join(gitUsrBin, "whoami.exe")), "precondition: the runner has Git's GNU whoami").toBe(true);
    process.env.PATH = `${gitUsrBin};${savedPath}`;
    expect(await freshUserSid()).toBe(realSid());
  });

  it("HARM a PLANTED whoami first on PATH, printing a forged SID: the relay ignores it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec22-planted-"));
    fs.copyFileSync(process.execPath, path.join(dir, "whoami.exe")); // a real exe named whoami...
    const forge = path.join(dir, "forge.cjs"); // ...that prints a forged SID before node parses its arguments
    fs.writeFileSync(forge, 'process.stdout.write(\'"planted\\\\user","S-1-5-21-1-2-3-4242"\\r\\n\'); process.exit(0);\n');
    process.env.PATH = `${dir};${savedPath}`;
    expect(forge, "a temp path with no spaces (NODE_OPTIONS splits on them)").not.toMatch(/\s/);
    process.env.NODE_OPTIONS = `${savedNodeOptions ?? ""} --require ${forge}`.trim();
    // Control: the plant works when found by name, or this twin proves nothing.
    expect(spawnSync("whoami", ["/user"], { encoding: "utf-8" }).stdout, "the planted whoami answers by name").toMatch(/S-1-5-21-1-2-3-4242/);
    const sid = await freshUserSid();
    expect(sid).not.toBe("S-1-5-21-1-2-3-4242");
    expect(sid).toBe(realSid());
  });
});

describe.runIf(process.platform === "win32")("SEC-22 (Windows): the host id (MachineGuid) never comes from a PATH-found reg", () => {
  const savedPath = process.env.Path ?? process.env.PATH;
  const savedNodeOptions = process.env.NODE_OPTIONS;
  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedNodeOptions;
    vi.resetModules();
  });

  it("HARM a PLANTED reg.exe first on PATH, printing a forged MachineGuid: the relay reads the real one (Codex #336 R1 P1)", async () => {
    const realReg = path.win32.join(process.env.SystemRoot!, "System32", "reg.exe");
    const real = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(spawnSync(realReg, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf-8" }).stdout)?.[1];
    expect(real, "precondition: the system reg reads this host's MachineGuid").toMatch(/^[0-9a-f-]{36}$/i);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec22-reg-"));
    fs.copyFileSync(process.execPath, path.join(dir, "reg.exe")); // a real exe named reg...
    const forge = path.join(dir, "forge.cjs"); // ...that prints a forged MachineGuid before node parses its arguments
    fs.writeFileSync(forge, "process.stdout.write('    MachineGuid    REG_SZ    00000000-0000-0000-0000-000000004242\\r\\n'); process.exit(0);\n");
    expect(forge, "a temp path with no spaces (NODE_OPTIONS splits on them)").not.toMatch(/\s/);
    process.env.PATH = `${dir};${savedPath}`;
    process.env.NODE_OPTIONS = `${savedNodeOptions ?? ""} --require ${forge}`.trim();
    expect(spawnSync("reg", ["query"], { encoding: "utf-8" }).stdout, "control: the planted reg answers by name").toMatch(/000000004242/);
    vi.resetModules();
    const guid = (await import("../src/liveness.js")).machineGuid("win32");
    expect(guid).not.toBe("00000000-0000-0000-0000-000000004242");
    expect(guid).toBe(real);
  });
});

/**
 * Every subprocess in src/ that does NOT go through systemBinary(...) or process.execPath, by
 * "<file>::<enclosing top-level function>::<first argument>", with WHY it may. A new one fails this test until it is
 * either moved to systemBinary or listed here with its reason.
 */
const ALLOWLIST: Record<string, string> = {
  // SEC-22 POSIX FOLLOW-UP (named, not this change): the same class, by name today.
  // A CLOSED set checked at run time (POSIX_BY_NAME = ps, ioreg, cat; any other command, or win32, is refused), so a
  // Windows tool cannot hide under it (Codex #336 R1 P1: reg did, under the old function-wide entry).
  "src/liveness.ts::runPosixByName::cmd": "ps / ioreg / cat (liveness, INV-LIVE-01), a closed set: SEC-22 POSIX follow-up (-> /bin/ps ...)",
  "src/watch-wake.ts::awakeNowMs::c": "sysctl / ioreg (the awake clock): SEC-22 POSIX follow-up",
  "src/deploy-gate.ts::cmd::bin": "launchctl / plutil (the deploy gate): SEC-22 POSIX follow-up",
  "src/deploy-gate.ts::defaultGateDeps::\"lsof\"": "lsof (the deploy gate): SEC-22 POSIX follow-up",
  "src/fleet-system.ts::lsofPids::\"lsof\"": "lsof (fleet view): SEC-22 POSIX follow-up",
  "src/fleet-system.ts::<module>::\"lsof\"": "lsof (fleet view): SEC-22 POSIX follow-up",
  "src/cli/init.ts::realDaemonDeps::\"launchctl\"": "launchctl (relay init, the user's own service): SEC-22 POSIX follow-up",
  "src/cli/restart.ts::run::\"launchctl\"": "launchctl (relay restart, the user's own service): SEC-22 POSIX follow-up",
  "src/backup.ts::runTar::\"tar\"": "tar (relay backup): SEC-22 POSIX follow-up",
  // DELIBERATE: the user's own programs, found the way the user's shell finds them; not a security or liveness decision.
  "src/fleet-system.ts::<module>::\"node\"": "reports the user's own node on PATH (fleet view): deliberate",
  "src/spawn/dispatcher.ts::defaultHasBinary::probe": "a `command -v` probe: is the user's terminal app installed (asks PATH by design)",
  "src/spawn/dispatcher.ts::spawnAgent::cmd.exec": "launches the user's terminal / agent CLI (spawn_agent): deliberate",
  "src/focus/dispatcher.ts::runCommand::exec": "the dashboard's 'Raise terminal' desktop action (osascript/wmctrl/powershell): not a security decision",
  "src/cli/open.ts::run::driver.command": "opens the dashboard in the user's browser: deliberate",
};

describe("SEC-22: no subprocess in src/ is started by a PATH-resolved name outside the reasoned allowlist", () => {
  const rel = (f: string) => path.relative(REPO, f).split(path.sep).join("/");

  it("every child_process call in src/ goes through systemBinary(...) or process.execPath, or is ALLOWLISTED; no allowlist entry is stale", () => {
    const sites = subprocessSites(srcProgram(), rel, (f) => f.startsWith("src/"));
    expect(sites.length, "the scan found the spawn family at all").toBeGreaterThan(10);
    const offenders = sites
      .filter((s) => s.program !== "systemBinary" && s.program !== "execPath" && !(s.program === "other" && s.key in ALLOWLIST))
      .map((s) => `${s.program} ${s.api} ${s.key}${s.why ? ` [${s.why}]` : ""}`);
    expect(offenders, "started by a bare name or an unchecked expression: use systemBinary(...), or list it with a reason").toEqual([]);
    expect(sites.filter((s) => s.program === "systemBinary").length, "the Windows tools go through systemBinary").toBeGreaterThan(0);
    const seen = new Set(sites.map((s) => s.key));
    expect(Object.keys(ALLOWLIST).filter((k) => !seen.has(k)), "allowlist entries that match no site (remove them)").toEqual([]);
  });

  // Each form Codex #336 R1 named (P2 DESIGN: references, not only calls; P2 DETAIL: options per API, the real
  // `process`), and the architect's rejects. Each fixture file holds ONE form; `by(file)` is what the scan made of it.
  const decl = `declare module "child_process" {
    export function spawn(c: string, a?: string[], o?: object): unknown; export function spawnSync(c: string, a?: string[], o?: object): unknown;
    export function execFileSync(c: string, a?: string[], o?: object): unknown; export function execSync(c: string, o?: object): unknown;
    export function fork(m: string, a?: string[], o?: object): unknown; }`;
  const fixtures: Record<string, string> = {
    "child_process.d.ts": decl,
    "node_modules/@types/node/process.d.ts": "declare var process: { execPath: string };",
    "globals.d.ts": "declare function require(m: string): any; declare function createRequire(u: string): (m: string) => any; declare class Worker { constructor(s: string, o?: object); } declare const opts: object; declare function doIt(f: unknown): void;",
    "src/system-binary.ts": "export function systemBinary(n: string): string { return n; }",
    // the program
    "src/bad-literal.ts": 'import { spawnSync } from "child_process"; export function a() { spawnSync("whoami", ["/user"]); }',
    "src/bad-alias-import.ts": 'import { spawnSync as run } from "child_process"; export function b() { run("icacls", []); }',
    "src/bad-namespace.ts": 'import * as cp from "child_process"; export function c() { cp.execFileSync("powershell.exe", []); }',
    "src/bad-variable.ts": 'import { spawnSync } from "child_process"; export function d() { const w = "whoami"; spawnSync(w); }',
    "src/bad-shell-api.ts": 'import { execSync } from "child_process"; export function e() { execSync("whoami /user"); }',
    // references (value uses)
    "src/ref-local-alias.ts": 'import { spawnSync } from "child_process"; export function f() { const run = spawnSync; run("whoami"); }',
    "src/ref-destructure.ts": 'import * as cp from "child_process"; export function g() { const { spawnSync: run } = cp; run("whoami"); }',
    "src/ref-argument.ts": 'import { spawnSync } from "child_process"; export function h() { doIt(spawnSync); }',
    // rejected outright
    "src/rej-require.ts": 'export function i() { const cp = require("child_process"); cp.spawnSync("whoami"); }',
    "src/rej-create-require.ts": 'export function j() { createRequire("x")("node:child_process").spawnSync("whoami"); }',
    "src/rej-dynamic-import.ts": 'export async function k() { const { spawnSync } = await import("child_process"); spawnSync("whoami"); }',
    "src/rej-computed.ts": 'import * as cp from "child_process"; export function l() { (cp as any)["spawnSync"]("whoami"); }',
    // options, per API
    "src/opt-shell-string.ts": 'import { spawnSync } from "child_process"; import { systemBinary } from "./system-binary.js"; export function m() { spawnSync(systemBinary("whoami"), [], { shell: "cmd.exe" }); }',
    "src/opt-shell-true.ts": 'import { spawnSync } from "child_process"; import { systemBinary } from "./system-binary.js"; export function n() { spawnSync(systemBinary("whoami"), [], { shell: true }); }',
    "src/opt-unreadable.ts": 'import { spawnSync } from "child_process"; import { systemBinary } from "./system-binary.js"; export function o() { spawnSync(systemBinary("whoami"), [], opts); }',
    "src/opt-fork-execpath.ts": 'import { fork } from "child_process"; export function p() { fork("m.js", [], { execPath: "whoami" }); }',
    "src/opt-shadowed-process.ts": 'import { spawn } from "child_process"; export function q() { const process = { execPath: "whoami" }; spawn(process.execPath, []); }',
    // the right ones
    "src/good-system.ts": 'import { spawnSync } from "child_process"; import { systemBinary } from "./system-binary.js"; export function r() { spawnSync(systemBinary("whoami"), []); }',
    "src/good-shell-false.ts": 'import { spawnSync } from "child_process"; import { systemBinary } from "./system-binary.js"; export function s() { spawnSync(systemBinary("whoami"), [], { ...opts, shell: false }); }',
    "src/good-execpath.ts": 'import { spawn } from "child_process"; export function t() { spawn(process.execPath, ["x.js"]); }',
    "src/good-fork.ts": 'import { fork } from "child_process"; export function u() { fork("m.js"); }',
    "src/not-cp.ts": 'function spawnSync(x: string) { return x; } export function v() { spawnSync("whoami"); }',
    // THE NAMED BOUNDARY (not seen, by design)
    "src/boundary-eval-string.ts": 'export function w() { new Worker("require(\'child_process\').spawnSync(\'whoami\')", { eval: true }); }',
    "node_modules/cross-spawn/index.ts": 'import { spawnSync } from "child_process"; export function x() { spawnSync("whoami"); }',
  };
  const virtualRel = (f: string) => f.replace(/\\/g, "/").replace(/^(?:[A-Za-z]:)?\/virtual\//, "");
  const scanned = () => subprocessSites(virtualProgram(fixtures), virtualRel, (f) => f.startsWith("src/"));
  const by = (sites: ReturnType<typeof scanned>, file: string) => sites.filter((s) => s.key.startsWith(`src/${file}::`)).map((s) => s.program);

  it("CAUGHT: a bare or unchecked program, a shell API, an aliased import, a namespace call", () => {
    const sites = scanned();
    for (const f of ["bad-literal.ts", "bad-alias-import.ts", "bad-namespace.ts", "bad-variable.ts", "bad-shell-api.ts"]) expect(by(sites, f), f).toEqual(["other"]);
  });

  it("CAUGHT (references): a local alias, a destructured property, a function passed as a value", () => {
    const sites = scanned();
    for (const f of ["ref-local-alias.ts", "ref-destructure.ts", "ref-argument.ts"]) expect(by(sites, f), f).toContain("reference");
  });

  it("REJECTED: require, createRequire, dynamic import of child_process, and computed member access on it", () => {
    const sites = scanned();
    for (const f of ["rej-require.ts", "rej-create-require.ts", "rej-dynamic-import.ts", "rej-computed.ts"]) expect(by(sites, f), f).toContain("rejected");
  });

  it("CAUGHT (options, per API): a shell option (string or true), unreadable options, fork's execPath, a shadowed `process`", () => {
    const sites = scanned();
    for (const f of ["opt-shell-string.ts", "opt-shell-true.ts", "opt-unreadable.ts", "opt-fork-execpath.ts", "opt-shadowed-process.ts"]) expect(by(sites, f), f).toEqual(["other"]);
  });

  it("PASSED: systemBinary (also with { ...opts, shell: false }), the real process.execPath, a plain fork; a local function NAMED spawnSync is not child_process", () => {
    const sites = scanned();
    expect(by(sites, "good-system.ts")).toEqual(["systemBinary"]);
    expect(by(sites, "good-shell-false.ts")).toEqual(["systemBinary"]);
    expect(by(sites, "good-execpath.ts")).toEqual(["execPath"]);
    expect(by(sites, "good-fork.ts")).toEqual(["execPath"]);
    expect(by(sites, "not-cp.ts")).toEqual([]);
  });

  it("BOUNDARY (documented, NOT seen): a subprocess inside an evaluated string, and dependency code outside src/", () => {
    const sites = scanned();
    expect(by(sites, "boundary-eval-string.ts")).toEqual([]);
    expect(sites.filter((s) => s.key.startsWith("node_modules/"))).toEqual([]);
  });
});
