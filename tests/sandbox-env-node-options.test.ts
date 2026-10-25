// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The sandbox child env (tests/_helpers/sandbox-env.ts: the release suite's sandbox and the SEC-24 black-box child) is
 * an ALLOWLIST, so no ambient code loader in the parent env reaches the child, where it would run BEFORE the operator
 * tripwire's own preload. One CONTROL per loader class, each with an UNFILTERED TWIN that shows the marker (so the
 * control can fire):
 *   - NODE_OPTIONS=--require <a preload that writes a marker>, in a fixture dir WITH SPACES (quoted per NODE_OPTIONS);
 *   - LD_PRELOAD (Linux): a NONEXISTENT .so, whose marker is ld.so's own "cannot be preloaded" line on stderr;
 *   - OPENSSL_CONF: a malformed config, whose marker is node's own "OpenSSL configuration error" at startup.
 * And the positive twin: PATH does arrive. On Windows, MEASURED: node re-adds SystemRoot to a child whose env omits it,
 * so nothing needs copying; the relay's own requirement (systemBinary() refuses without SystemRoot) holds in-process.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { sandboxEnv, WINDOWS_SYSTEM_VARS } from "./_helpers/sandbox-env.js";
import { systemBinary } from "../src/system-binary.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-env-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/**
 * A preload path in NODE_OPTIONS syntax: double-quoted, a backslash or a double quote escaped by a backslash (node
 * reads `\\` inside quotes as one backslash, so a Windows path survives). A path with spaces stays one argument.
 */
const nodeOptionsQuoted = (p: string) => `"${p.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** A fixture dir WITH spaces (the controls must hold for a TMPDIR or a Windows profile path that has them). */
function fixture(label: string) {
  const dir = path.join(ROOT, "dir with spaces", label);
  fs.mkdirSync(path.join(dir, "home"), { recursive: true });
  return { dir, home: path.join(dir, "home") };
}
const runNode = (env: NodeJS.ProcessEnv, code = "process.exit(0)") => spawnSync(process.execPath, ["-e", code], { env, encoding: "utf-8" });

describe("the sandbox child env is an allowlist: no ambient code loader reaches the child", () => {
  it("NODE_OPTIONS CONTROL: a planted --require preload (in a path with spaces) does NOT run in a sandbox child; its unfiltered TWIN does", () => {
    const f = fixture("node-options");
    const marker = path.join(f.dir, "PRELOAD-RAN");
    const preload = path.join(f.dir, "preload.cjs");
    fs.writeFileSync(preload, `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    expect(preload, "the plant's path holds a space (the quoting is exercised)").toMatch(/ /);
    const parent: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `--require ${nodeOptionsQuoted(preload)}` };
    const filtered = runNode(sandboxEnv(f.home, parent));
    expect(filtered.status, filtered.stderr).toBe(0);
    expect(fs.existsSync(marker), "the planted preload never ran in the sandbox child").toBe(false);
    const twin = runNode(parent);
    expect(twin.status, twin.stderr).toBe(0);
    expect(fs.existsSync(marker), "the TWIN (unfiltered) ran the planted preload").toBe(true);
  });

  it("LD_PRELOAD CONTROL (Linux): a planted nonexistent .so is NOT seen by a sandbox child's dynamic loader; its unfiltered TWIN prints ld.so's 'cannot be preloaded'", (ctx) => {
    if (process.platform !== "linux") ctx.skip(); // the glibc dynamic loader: Linux only
    const f = fixture("ld-preload");
    const parent: NodeJS.ProcessEnv = { ...process.env, LD_PRELOAD: path.join(f.dir, "sec24-missing.so") };
    const filtered = runNode(sandboxEnv(f.home, parent));
    expect(filtered.status, filtered.stderr).toBe(0);
    expect(filtered.stderr, "the sandbox child's loader never saw LD_PRELOAD").not.toMatch(/cannot be preloaded/);
    const twin = runNode(parent);
    expect(twin.stderr, "the TWIN (unfiltered): ld.so reports the planted object").toMatch(/cannot be preloaded/);
  });

  it("OPENSSL_CONF CONTROL: a planted malformed config is NOT read by a sandbox child's node; its unfiltered TWIN prints node's 'OpenSSL configuration error'", () => {
    const f = fixture("openssl-conf");
    const conf = path.join(f.dir, "bad.cnf");
    fs.writeFileSync(conf, "openssl_conf = bad\n[bad\nthis is not = valid ]][\n");
    const parent: NodeJS.ProcessEnv = { ...process.env, OPENSSL_CONF: conf };
    const filtered = runNode(sandboxEnv(f.home, parent));
    expect(filtered.status, filtered.stderr).toBe(0);
    expect(filtered.stderr, "the sandbox child's node never read OPENSSL_CONF").not.toMatch(/OpenSSL configuration error/);
    const twin = runNode(parent);
    expect(twin.stderr, "the TWIN (unfiltered): node read the planted config at startup").toMatch(/OpenSSL configuration error/);
  });

  it("the positive twin: PATH DOES arrive in a sandbox child (the allowlist does not starve it)", () => {
    const f = fixture("path");
    const parentPath = Object.entries(process.env).find(([k]) => k.toLowerCase() === "path")?.[1] ?? "";
    expect(parentPath.length, "the parent has a PATH").toBeGreaterThan(0);
    const r = runNode(sandboxEnv(f.home), "process.stdout.write(process.env.PATH ?? '')");
    expect(r.status, r.stderr).toBe(0);
    // The spawn decorator may prepend its stand-in dir: the parent's PATH is still the tail.
    expect(r.stdout.endsWith(parentPath), `the child's PATH carries the parent's: ${r.stdout.slice(0, 200)}`).toBe(true);
  });

  it("only the allowlist: a source full of loaders and strangers yields PATH, the HOME and temp spellings, the locale and the measured system vars, nothing else", () => {
    const src: NodeJS.ProcessEnv = { Path: "/bin", NODE_OPTIONS: "--require x", Node_Options: "--require y", LD_PRELOAD: "x.so", LD_AUDIT: "a.so", OPENSSL_CONF: "c", RELAY_HOME: "/r", VITEST_WORKER_ID: "1", FOO: "f", LANG: "C", SystemRoot: "C:\\Windows" };
    const home = fixture("allowlist").home;
    const env = sandboxEnv(home, src);
    const allowed = new Set<string>(["PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "LC_ALL", "LANG", "HOMEDRIVE", "HOMEPATH", ...WINDOWS_SYSTEM_VARS]);
    expect(Object.keys(env).filter((k) => !allowed.has(k))).toEqual([]);
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe(home);
    expect(env.TMPDIR).toBe(path.join(home, ".tmp"));
    expect(fs.statSync(env.TMPDIR!).isDirectory()).toBe(true);
    expect(env.LANG).toBe("C");
    expect("SystemRoot" in env, "no system variable is copied (none is measured as required)").toBe(false);
  });

  it("SystemRoot on Windows, MEASURED: node re-adds it to a child whose env omits it, so the relay's systemBinary() resolves; the relay's own requirement holds in-process (without it, systemBinary() refuses)", (ctx) => {
    if (process.platform !== "win32") ctx.skip();
    const f = fixture("systemroot");
    const env = sandboxEnv(f.home);
    expect(Object.keys(env).some((k) => k.toLowerCase() === "systemroot"), "the helper copies no SystemRoot").toBe(false);
    // In the child: SystemRoot is present anyway (node/libuv adds it on Windows), and systemBinary() resolves.
    const probe = path.join(f.dir, "probe.mjs");
    fs.writeFileSync(
      probe,
      `const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, "dist", "system-binary.js")).href)});\n` +
        `const root = Object.entries(process.env).find(([k]) => k.toLowerCase() === "systemroot")?.[1] ?? "";\n` +
        `try { process.stdout.write("ROOT=" + root + " RESOLVED " + m.systemBinary("whoami")); } catch (e) { process.stdout.write("ROOT=" + root + " REFUSED " + e.name); }\n`,
    );
    const r = spawnSync(process.execPath, [probe], { env, encoding: "utf-8" });
    expect(r.stdout, `node re-adds SystemRoot to the child, and systemBinary resolves: ${r.stderr}`).toMatch(/^ROOT=\S+ RESOLVED .*whoami\.exe$/i);
    // The relay's own requirement, in-process: an env without SystemRoot is refused (SEC-22's fail-closed).
    expect(() => systemBinary("whoami", { PATH: "C:\\Windows" })).toThrow(/SystemRoot/);
  });
});
