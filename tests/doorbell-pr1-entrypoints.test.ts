// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell plan v3, invariant I1 (architect ruling ab740fe3): ONE entrypoint registry
 * (src/entrypoints.ts) and its CI TRIPWIRE. Every way a relay process can be started
 * must be registered with its kind, and a long-lived entry that something INSTALLS must
 * have its currency mechanism built.
 *
 * The facts come from the real sources: package.json `bin`; the script the installers
 * write (installPaths().distEntry, which `relay init` puts in the launchd plist AND the
 * MCP server config; the plist's own ProgramArguments are parsed to prove it); and every
 * source file with a `#!` line. The rules themselves are proven able to FAIL on fixtures.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO_ROOT, "src");
const E = await import("../src/entrypoints.js");
const { installPaths, installMcpServer } = await import("../src/cli/init.js");
const { buildLaunchdPlist } = await import("../src/cli/launchd.js");

const rel = (p: string) => path.relative(REPO_ROOT, p).split(path.sep).join("/");
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}

/**
 * #300 R1 #5: INSTALLERS are discovered from the source, not assumed. A file that builds a
 * plist (`<key>ProgramArguments</key>`), runs `launchctl bootstrap`, or calls
 * `upsertMcpServer(` writes or loads an install. Each must be one the collector below
 * covers; a NEW installer fails this until the collector learns it.
 */
const INSTALLER_PATTERNS = [/<key>ProgramArguments<\/key>/, /["']bootstrap["']/, /\bupsertMcpServer\(/];
const KNOWN_INSTALLERS: Record<string, string> = {
  "src/cli/launchd.ts": "the daemon plist builder (collected: its ProgramArguments are parsed)",
  "src/cli/init.ts": "the MCP config writer (collected: the config it writes is read back) and the daemon plist's bootstrap",
  "src/cli/restart.ts": "re-bootstraps the daemon plist launchd.ts built (no script of its own)",
};
function discoverInstallers(files: Array<{ rel: string; text: string }>): string[] {
  return files
    .filter((f) => {
      const text = f.text.replace(/export function upsertMcpServer\(/g, ""); // the helper's own definition is not a call site
      return INSTALLER_PATTERNS.some((re) => re.test(text));
    })
    .map((f) => f.rel)
    .sort();
}
const srcFiles = () => walk(SRC).filter((f) => f.endsWith(".ts")).map((f) => ({ rel: rel(f), text: fs.readFileSync(f, "utf-8") }));

async function realFacts(): Promise<import("../src/entrypoints.js").EntrypointFacts> {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8")) as { bin: Record<string, string> };
  const binTargets = Object.values(pkg.bin).map((t) => t.replace(/^\.\//, ""));
  const { distEntry } = installPaths(REPO_ROOT);
  // The plist the daemon installer writes: its script is exactly the installers' distEntry.
  const plist = buildLaunchdPlist({ label: "x", nodePath: "/usr/bin/node", distEntry, workingDir: REPO_ROOT, port: 3777, transport: "http", logPath: "/tmp/x.log" });
  const args = [...plist.split("<key>ProgramArguments</key>")[1].split("</array>")[0].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const plistScripts = args.slice(1).filter((a) => a.startsWith(REPO_ROOT)).map(rel);
  const bootstrapped = walk(SRC)
    .filter((f) => f.endsWith(".ts") && fs.readFileSync(f, "utf-8").startsWith("#!"))
    .map((f) => "dist/" + rel(f).replace(/^src\//, "").replace(/\.ts$/, ".js"));
  // The MCP fact: the script in the config the installer ACTUALLY writes.
  const json = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "i1-mcp-")), "claude.json");
  installMcpServer(distEntry, json);
  const written = JSON.parse(fs.readFileSync(json, "utf-8")) as { mcpServers: Record<string, { args?: string[] }> };
  const mcpScripts = Object.values(written.mcpServers).flatMap((e) => e.args ?? []).filter((a) => a.startsWith(REPO_ROOT)).map(rel);
  const modules: Record<string, Record<string, unknown>> = {
    "./db.js": await import("../src/db.js"),
    "./fleet-verdicts.js": await import("../src/fleet-verdicts.js"),
  };
  return {
    binTargets,
    plistScripts,
    mcpScripts,
    bootstrapped,
    hasExport: (m, name) => typeof modules[m]?.[name] === "function",
  };
}

describe("I1: the entrypoint registry, on the REAL sources", () => {
  it("the tripwire is clean: every bin target, installed script and bootstrapped source file is registered", async () => {
    const f = await realFacts();
    expect(f.bootstrapped).toEqual(expect.arrayContaining(["dist/index.js", "dist/doorbell.js"])); // non-vacuous: it found the bootstraps
    expect(f.plistScripts).toEqual(["dist/index.js"]); // non-vacuous: it parsed the real plist
    expect(E.entrypointViolations(f)).toEqual([]);
  });
  it("every registered path exists in this checkout (no stale entry)", () => {
    for (const e of E.ENTRYPOINTS) expect(fs.existsSync(path.join(REPO_ROOT, e.path)), e.path).toBe(true);
  });
  it("the doorbell is registered long-lived with a heartbeat, and NOTHING installs it yet (its mechanism lands in PR 5b)", async () => {
    expect(E.ENTRYPOINTS.find((e) => e.path === "dist/doorbell.js")).toMatchObject({ lifetime: "long-lived", currency: ["heartbeat"] });
    expect(E.CURRENCY_MECHANISMS.heartbeat).toBeNull();
    const f = await realFacts();
    expect([...f.binTargets, ...f.plistScripts, ...f.mcpScripts]).not.toContain("dist/doorbell.js");
  });
});

describe("#300 R1 #5: installers are DISCOVERED from the source", () => {
  it("every installer in the source is one the collector covers (and none it lists is stale)", () => {
    expect(discoverInstallers(srcFiles())).toEqual(Object.keys(KNOWN_INSTALLERS).sort());
  });
  it("HARM (MEASURED shape): a NEW plist installer, bootstrap or MCP writer is discovered, so it cannot escape I1", () => {
    const fixtures = [
      ...srcFiles(),
      { rel: "src/cli/doorbell-install.ts", text: "const plist = `<key>ProgramArguments</key><array><string>${node}</string></array>`;" },
      { rel: "src/cli/other-boot.ts", text: 'execFileSync("launchctl", ["bootstrap", domain, p]);' },
      { rel: "src/cli/other-mcp.ts", text: 'upsertMcpServer(existing, "x", entry);' },
    ];
    expect(discoverInstallers(fixtures).filter((f) => !(f in KNOWN_INSTALLERS))).toEqual(["src/cli/doorbell-install.ts", "src/cli/other-boot.ts", "src/cli/other-mcp.ts"]);
  });
  it("the MCP fact is read from the config the installer WROTE (non-vacuous)", async () => {
    expect((await realFacts()).mcpScripts).toEqual(["dist/index.js"]);
  });
});

describe("I1: the tripwire FAILS on what it guards against (fixtures)", () => {
  const clean = (): import("../src/entrypoints.js").EntrypointFacts => ({
    binTargets: ["dist/index.js", "bin/relay"],
    plistScripts: ["dist/index.js"],
    mcpScripts: ["dist/index.js"],
    bootstrapped: ["dist/index.js", "dist/doorbell.js"],
    hasExport: () => true,
  });
  it("twin: the clean fixture has no violation", () => expect(E.entrypointViolations(clean())).toEqual([]));
  it("an UNREGISTERED bin target, plist script, MCP script or bootstrapped file is reported", () => {
    const v = E.entrypointViolations({ ...clean(), binTargets: ["dist/new-cli.js"], plistScripts: ["dist/worker.js"], mcpScripts: ["dist/other.js"], bootstrapped: ["dist/side.js"] });
    expect(v).toEqual([
      expect.stringMatching(/dist\/new-cli\.js is a package\.json bin target but is not in the entrypoint registry/),
      expect.stringMatching(/dist\/worker\.js is a launchd plist script/),
      expect.stringMatching(/dist\/other\.js is an MCP server config script/),
      expect.stringMatching(/dist\/side\.js is a source file with a process bootstrap/),
    ]);
  });
  it("INSTALLING the doorbell before its heartbeat mechanism exists is reported (the PR 5b ordering rule)", () => {
    expect(E.entrypointViolations({ ...clean(), plistScripts: ["dist/index.js", "dist/doorbell.js"] })).toEqual([
      expect.stringMatching(/dist\/doorbell\.js is installed and long-lived, but its currency mechanism "heartbeat" is not built/),
    ]);
  });
  it("a mechanism whose named export is missing is reported", () => {
    expect(E.entrypointViolations({ ...clean(), hasExport: (m) => m !== "./db.js" })).toEqual([expect.stringMatching(/"connectors-row" names \.\/db\.js recordOwnConnector, which does not exist/)]);
  });
  it("a long-lived entry with no mechanism, or a short-lived one with one, is reported", () => {
    const reg = [
      { path: "dist/index.js", lifetime: "long-lived" as const, currency: [] as const, note: "" },
      { path: "bin/relay", lifetime: "short-lived" as const, currency: ["heartbeat"] as const, note: "" },
      { path: "dist/doorbell.js", lifetime: "long-lived" as const, currency: ["heartbeat"] as const, note: "" },
    ];
    expect(E.entrypointViolations(clean(), reg)).toEqual([
      expect.stringMatching(/dist\/index\.js is long-lived but names no currency mechanism/),
      expect.stringMatching(/bin\/relay is short-lived but names a currency mechanism/),
    ]);
  });
});

describe("A1 §A2: no tool and no HTTP route accepts an intent", () => {
  it("only the doorbell's own modules import the doorbell (no server, transport or tool reaches it)", () => {
    // PR 7 (§v6): the watch IS the doorbell's wake path; it reuses the kernel lock, the read-only DB
    // open and the private-dir helper. Named here, and pinned unreachable from server/transport/tools below.
    const WATCH = ["src/cli/watch-until-wake.ts", "src/watch-wake.ts"];
    const importers = walk(SRC)
      .filter((f) => f.endsWith(".ts") && !/\/doorbell(-[a-z]+)?\.ts$/.test(f))
      .filter((f) => /from\s+["'][^"']*doorbell[^"']*["']|import\(\s*["'][^"']*doorbell/.test(fs.readFileSync(f, "utf-8")))
      .map(rel);
    expect(importers.sort()).toEqual(WATCH);
  });
  it("PR 7: no server, transport or tool module imports the watch's doorbell-reaching modules", () => {
    const reach = walk(SRC)
      .filter((f) => /\/(server\.ts|transport\/[^/]+\.ts|tools\/[^/]+\.ts)$/.test(f))
      .filter((f) => /watch-wake|watch-until-wake|cli\/watch(\.js)?["']/.test(fs.readFileSync(f, "utf-8")))
      .map(rel);
    expect(walk(path.join(SRC, "tools")).length).toBeGreaterThan(3); // non-vacuous
    expect(reach).toEqual([]);
  });
  it("no MCP tool is named for a doorbell or an intent", async () => {
    const text = fs.readFileSync(path.join(SRC, "server.ts"), "utf-8");
    const names = [...text.matchAll(/^\s+name:\s*"([a-z_]+)",/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(20); // non-vacuous: it read the real tool list
    expect(names).toContain("send_message");
    expect(names.filter((n) => /doorbell|intent|ring/.test(n))).toEqual([]);
  });
  it("no HTTP route path names a doorbell or an intent", () => {
    const routes = walk(path.join(SRC, "transport"))
      .concat([path.join(SRC, "dashboard.ts")])
      .filter((f) => fs.existsSync(f))
      .flatMap((f) => [...fs.readFileSync(f, "utf-8").matchAll(/\.(?:get|post|put|patch|delete|all|use)\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]));
    expect(routes.length).toBeGreaterThan(3); // non-vacuous: it read the real routes
    expect(routes.filter((r) => /doorbell|intent/i.test(r))).toEqual([]);
  });
});
