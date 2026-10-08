// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The OPERATOR TRIPWIRE's own tests (tests/_setup/vitest-tripwire-base.mjs, operator-tripwire.ts,
 * operator-tripwire-preload.mjs, operator-tripwire-global.mjs).
 *
 * This file itself never trips the tripwire: a recorded violation fails the WHOLE run at teardown (that
 * is the point), so every HARM case runs in a NESTED vitest run under the real base config, against
 * operator STAND-INS made operator by being that run's ambient config: a canary port as its
 * RELAY_HTTP_PORT, a synthetic relay root as its RELAY_HOME. The outer test reads each nested test's
 * verdict from the JSON reporter, counts the canary's connections (it must see ZERO), and checks the run
 * failed at teardown. Controls in the same run must pass, so a red cannot be a broken harness.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { decorateChildEnv, privateHomeEnv, spawnNestedRun, tripwireView, isLocalAddress } from "./_setup/operator-tripwire.js";
import { canonicalPath, snapshotFromEnv, underOperatorRoot } from "./_setup/operator-tripwire-preload.mjs";
import { discoverOperator } from "./_setup/vitest-tripwire-base.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // never URL.pathname: it keeps %20

describe("PROTECTION: this worker and every child start away from the operator", () => {
  it("this worker's HOME is private (inside the run directory), and RELAY_HTTP_PORT is 1", () => {
    const { privateHome, runDir, realHome } = tripwireView();
    expect(process.env.HOME).toBe(privateHome);
    expect(privateHome.startsWith(runDir + path.sep)).toBe(true);
    expect(privateHome).not.toBe(realHome);
    expect(process.env.RELAY_HTTP_PORT).toBe("1");
  });
  it("a child built FROM SCRATCH (env {}) gets the private HOME, every Windows spelling, port 1 and the preload", () => {
    const { privateHome } = tripwireView();
    const r = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify([process.env.HOME, process.env.USERPROFILE, process.env.RELAY_HTTP_PORT, process.env.NODE_OPTIONS]))"], { encoding: "utf-8", env: {} });
    const [home, profile, port, opts] = JSON.parse(r.stdout);
    expect([home, profile, port]).toEqual([privateHome, privateHome, "1"]);
    expect(opts).toMatch(/--import=file:.*operator-tripwire-preload\.mjs/);
  });
  it("a child env's OWN HOME and port are kept (a test that pins its own is not overridden)", () => {
    const e = decorateChildEnv({ PATH: "/usr/bin:/bin", HOME: "/tmp/elsewhere", RELAY_HTTP_PORT: "40123" });
    expect([e.HOME, e.RELAY_HTTP_PORT]).toEqual(["/tmp/elsewhere", "40123"]);
  });
  it("an EMPTY value is repaired like a missing one (Codex #305 R2 NEW-1): the hooks read an empty port as 3777, node an empty HOME as the account's", () => {
    const { privateHome } = tripwireView();
    const e = decorateChildEnv({ PATH: "/usr/bin:/bin", HOME: "", USERPROFILE: "", HOMEPATH: "", RELAY_HTTP_PORT: "", RELAY_HOME: "", RELAY_DB_PATH: "", RELAY_CONFIG_PATH: "" });
    expect([e.HOME, e.USERPROFILE, e.RELAY_HTTP_PORT]).toEqual([privateHome, privateHome, "1"]);
    // An empty instance override means "use the default" to every consumer (resolve-instance.ts, config.ts): it is
    // removed, so the default resolves under the private HOME.
    expect([e.RELAY_HOME, e.RELAY_DB_PATH, e.RELAY_CONFIG_PATH]).toEqual([undefined, undefined, undefined]);
  });
  it.skipIf(process.platform === "win32")("a shell child given RELAY_HTTP_PORT=\"\" resolves the hooks' port expression to 1, never 3777", () => {
    const r = spawnSync("/bin/sh", ["-c", 'printf %s "${RELAY_HTTP_PORT:-3777}"'], { encoding: "utf-8", env: { PATH: "/usr/bin:/bin", RELAY_HTTP_PORT: "" } });
    expect(r.stdout).toBe("1");
  });
});

describe("PARITY (Windows): the private home is set in EVERY spelling a process may resolve it from", () => {
  /**
   * Node's os.homedir() on Windows (libuv uv_os_homedir) returns USERPROFILE when it is set, and
   * otherwise the ACCOUNT's profile directory from the OS, which no env redirects. So without
   * USERPROFILE a Windows child would resolve the operator's real home even with HOME private. This host
   * may not be Windows, so that resolution is SIMULATED here.
   */
  const windowsHomedir = (env: NodeJS.ProcessEnv, accountProfile: string) => env.USERPROFILE ?? accountProfile;
  const WIN_PRIVATE = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\bot-relay-tripwire-ab12\\home";
  it("win32: USERPROFILE is the private home, HOMEDRIVE + HOMEPATH spell the same path, and TEMP/TMP sit inside it", () => {
    const e = privateHomeEnv(WIN_PRIVATE, "win32");
    const temp = `${WIN_PRIVATE}\\AppData\\Local\\Temp`;
    expect(e).toEqual({ HOME: WIN_PRIVATE, USERPROFILE: WIN_PRIVATE, HOMEDRIVE: "C:", HOMEPATH: "\\Users\\runneradmin\\AppData\\Local\\Temp\\bot-relay-tripwire-ab12\\home", TEMP: temp, TMP: temp });
    expect(`${e.HOMEDRIVE}${e.HOMEPATH}`).toBe(WIN_PRIVATE);
    expect(windowsHomedir(e, "C:\\Users\\operator")).toBe(WIN_PRIVATE);
  });
  it("this worker and a child built from scratch carry USERPROFILE = the private home (simulated Windows resolution)", () => {
    const { privateHome } = tripwireView();
    expect(process.env.USERPROFILE).toBe(privateHome);
    expect(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`).toBe(privateHome);
    const child = decorateChildEnv({ PATH: "/usr/bin:/bin" });
    expect(windowsHomedir(child, "ACCOUNT-PROFILE")).toBe(privateHome);
    expect(`${child.HOMEDRIVE}${child.HOMEPATH}`).toBe(privateHome);
  });
});

describe("DETECTION primitives (pure: nothing is accessed, nothing is recorded)", () => {
  it("THIS HOST is decided on the address, never its spelling (dotted, mapped, hex, expanded, case)", () => {
    for (const a of ["127.0.0.1", "127.9.9.9", "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "::FFFF:7F00:1", "[::1]", "::1", "0:0:0:0:0:0:0:1", "0.0.0.0", "::"]) {
      expect(isLocalAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "::ffff:808:808", "2001:db8::1", "localhost", "relay.example"]) expect(isLocalAddress(a), a).toBe(false); // names are RESOLVED first
  });
  describe("paths are compared CANONICALLY on both sides", () => {
    let dir: string;
    let root: string;
    let alias: string;
    beforeAll(() => {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tw-canon-")));
      root = path.join(dir, "home", ".bot-relay");
      fs.mkdirSync(path.join(root, "instances"), { recursive: true });
      alias = path.join(dir, "alias");
      fs.symlinkSync(root, alias);
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
    const snap = () => snapshotFromEnv({ RELAY_TEST_OPERATOR_HOME: path.join(dir, "home"), RELAY_TEST_OPERATOR_ROOTS: JSON.stringify([root]), RELAY_TEST_OPERATOR_PORTS: "3777" });
    it("the root itself, a path under it, a symlink alias, `..` spellings and a not-yet-existing file under it all match", () => {
      for (const p of [root, path.join(root, "relay.db"), path.join(alias, "relay.db"), path.join(root, "instances", "..", "x"), path.join(alias, "instances", "new", "deep.json")]) {
        expect(underOperatorRoot(p, snap()), p).toBe(root);
      }
    });
    it("a sibling with the root as a name PREFIX does not match", () => {
      expect(underOperatorRoot(`${root}-other/relay.db`, snap())).toBeNull();
      expect(underOperatorRoot(path.join(dir, "home", "x"), snap())).toBeNull();
    });
    it("on a case-insensitive volume, a case-swapped spelling matches; on a case-sensitive one it is another path", () => {
      const swapped = path.join(root, "relay.db").replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
      let insensitive = false;
      try {
        insensitive = fs.statSync(swapped.slice(0, swapped.lastIndexOf(path.sep))).ino === fs.statSync(root).ino;
      } catch {
        insensitive = false;
      }
      expect(underOperatorRoot(swapped, snap())).toBe(insensitive ? root : null);
    });
    it("canonicalPath resolves a symlinked ancestor of a missing leaf", () => {
      expect(canonicalPath(path.join(alias, "missing", "leaf"), false)).toBe(path.join(root, "missing", "leaf"));
    });
    it("`..` AFTER a symlink is resolved from where the link POINTS, as the kernel does (Codex #305 R2 NEW-4; a RAW string: path.join would erase it)", () => {
      const aliasInst = path.join(dir, "alias-inst"); // -> <root>/instances
      if (!fs.existsSync(aliasInst)) fs.symlinkSync(path.join(root, "instances"), aliasInst);
      const raw = `${aliasInst}${path.sep}..${path.sep}relay.db`; // the kernel reaches <root>/relay.db
      expect(underOperatorRoot(raw, snap())).toBe(root);
      expect(canonicalPath(raw, false)).toBe(path.join(root, "relay.db"));
      // and a `..` inside a MISSING suffix collapses lexically (nothing there can be a link)
      expect(canonicalPath(`${root}${path.sep}nope${path.sep}..${path.sep}relay.db`, false)).toBe(path.join(root, "relay.db"));
    });
  });
});

describe("DISCOVERY: every operator root and config, failing CLOSED", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tw-disc-")));
  });
  afterAll(() => {
    try {
      fs.chmodSync(path.join(dir, "home-2", ".bot-relay", "config.json"), 0o600);
    } catch {
      /* not created */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("reads the home root, its instances, an ambient RELAY_HOME (all roots, not the first), and RELAY_CONFIG_PATH", () => {
    const home = path.join(dir, "home");
    const r1 = path.join(home, ".bot-relay");
    const r2 = path.join(dir, "elsewhere");
    fs.mkdirSync(path.join(r1, "instances", "a"), { recursive: true });
    fs.mkdirSync(path.join(r2, "instances", "b"), { recursive: true });
    fs.writeFileSync(path.join(r1, "config.json"), JSON.stringify({ http_port: 4001 }));
    fs.writeFileSync(path.join(r1, "instances", "a", "config.json"), JSON.stringify({ http_port: 4002 }));
    fs.writeFileSync(path.join(r2, "instances", "b", "config.json"), JSON.stringify({ http_port: 4003 }));
    const cfg = path.join(dir, "custom.json");
    fs.writeFileSync(cfg, JSON.stringify({ http_port: 4004 }));
    const op = discoverOperator({ RELAY_HOME: r2, RELAY_CONFIG_PATH: cfg, RELAY_HTTP_PORT: "4005" }, home);
    expect(op.ports.sort()).toEqual([3777, 4001, 4002, 4003, 4004, 4005]);
    expect(op.roots).toEqual([r1, r2, cfg]);
  });
  it("RELATIVE overrides are discovered as production resolves them, against the launch cwd (Codex #305 R2 NEW-2)", () => {
    const home = path.join(dir, "home-3");
    const cwd = path.join(dir, "launch");
    const relRoot = path.join(dir, "rel-root");
    fs.mkdirSync(path.join(relRoot, "instances", "c"), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(relRoot, "instances", "c", "config.json"), JSON.stringify({ http_port: 4011 }));
    fs.writeFileSync(path.join(dir, "rel-cfg.json"), JSON.stringify({ http_port: 4012 }));
    const op = discoverOperator({ RELAY_HOME: path.join("..", "rel-root"), RELAY_CONFIG_PATH: path.join("..", "rel-cfg.json"), RELAY_DB_PATH: path.join("..", "rel-db", "relay.db") }, home, cwd);
    expect(op.roots).toEqual(expect.arrayContaining([relRoot, path.join(dir, "rel-cfg.json"), path.join(dir, "rel-db", "relay.db")]));
    expect(op.ports).toEqual(expect.arrayContaining([4011, 4012]));
  });
  it("an UNREADABLE or INVALID config is an ERROR, never 'no port'; an absent one is fine", () => {
    const home = path.join(dir, "home-2"); // its own: the case above left an instance with a port
    fs.mkdirSync(path.join(home, ".bot-relay"), { recursive: true });
    const f = path.join(home, ".bot-relay", "config.json");
    fs.writeFileSync(f, "{not json");
    expect(() => discoverOperator({}, home)).toThrow(/not valid JSON/);
    if (process.platform !== "win32" && process.getuid?.() !== 0) { // chmod 000 denies nothing on Windows, or to root
      fs.writeFileSync(f, "{}");
      fs.chmodSync(f, 0o000);
      expect(() => discoverOperator({}, home)).toThrow(/cannot read/);
      fs.chmodSync(f, 0o600);
    }
    fs.rmSync(f);
    expect(discoverOperator({}, home).ports).toEqual([3777]);
  });
});

// ---------------------------------------------------------------------------------------------------
// NESTED runs: the harm cases, under the real base config, tripwire and run guard.

interface Canary { port: number; hits: () => number; close: () => Promise<void> }
async function canary(): Promise<Canary> {
  let hits = 0;
  const srv = http.createServer((_req, res) => res.end("ok"));
  srv.on("connection", () => hits++);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  return { port, hits: () => hits, close: () => new Promise((r) => srv.close(() => r())) };
}

interface Verdict { status: string; messages: string }
/**
 * Start a nested run from THIS worker's env, minus what the nested run builds itself (the snapshot,
 * vitest's own vars) and minus this run's own private relay paths (the hermetic RELAY_CONFIG_PATH etc.:
 * the nested base would discover them as the operator's), plus `overlay` (the operator stand-ins).
 */
async function nestedRun(filter: string, overlay: NodeJS.ProcessEnv, work: string): Promise<{ code: number | null; out: string; verdicts: Record<string, Verdict> }> {
  const report = path.join(work, `report-${filter}.json`);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (k.startsWith("RELAY_TEST_") || k.startsWith("VITEST") || ["RELAY_HOME", "RELAY_DB_PATH", "RELAY_CONFIG_PATH", "RELAY_INSTANCE_ID"].includes(k)) delete childEnv[k];
  Object.assign(childEnv, overlay);
  const child = spawnNestedRun(process.execPath, [path.join(REPO, "node_modules", "vitest", "vitest.mjs"), "run", "--config", path.join(REPO, "tests", "fixtures", "operator-tripwire", "vitest.config.ts"), "--reporter=json", `--outputFile=${report}`, filter], { cwd: REPO, env: childEnv });
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (out += d));
  const code = await new Promise<number | null>((r) => child.on("close", r));
  const verdicts: Record<string, Verdict> = {};
  const json = JSON.parse(fs.readFileSync(report, "utf-8")) as { testResults: Array<{ assertionResults: Array<{ title: string; status: string; failureMessages: string[] }> }> };
  for (const f of json.testResults) for (const a of f.assertionResults) verdicts[a.title] = { status: a.status, messages: a.failureMessages.join("\n") };
  return { code, out, verdicts };
}

describe.skipIf(process.platform === "win32")("NESTED: every harm is refused, never delivered, and FAILS its test even when swallowed", () => {
  let work: string;
  let op: Canary;
  let plain: Canary;
  let root: string;
  let result: Awaited<ReturnType<typeof nestedRun>>;
  beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tw-nested-")));
    root = path.join(work, "synthetic-relay-root");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "relay.db"), "not a real db");
    fs.symlinkSync(root, path.join(work, "alias"));
    fs.mkdirSync(path.join(root, "instances"));
    fs.symlinkSync(path.join(root, "instances"), path.join(work, "alias-inst"));
    op = await canary();
    plain = await canary();
    result = await nestedRun(
      "harm.fixture",
      // RELAY_HOME RELATIVE to the nested run's cwd (REPO): production resolves it there, and so must discovery.
      { RELAY_HTTP_PORT: String(op.port), RELAY_HOME: path.relative(REPO, root), TRIPWIRE_SYNTH_ALIAS_INST: path.join(work, "alias-inst"), TRIPWIRE_FIXTURE_PORT: String(op.port), TRIPWIRE_PLAIN_PORT: String(plain.port), TRIPWIRE_SYNTH_ROOT: root, TRIPWIRE_SYNTH_ALIAS: path.join(work, "alias"), TMPDIR: work },
      work,
    );
  }, 120_000);
  afterAll(async () => {
    await Promise.all([op?.close(), plain?.close()]);
    fs.rmSync(work, { recursive: true, force: true });
  });

  it("precondition: the fixture ran (every test has a verdict) and its controls PASSED", () => {
    expect(Object.keys(result.verdicts).length, result.out.slice(-1500)).toBeGreaterThanOrEqual(12);
    for (const [t, v] of Object.entries(result.verdicts)) if (t.startsWith("control")) expect(v.status, `${t}: ${v.messages}`).toBe("passed");
    expect(plain.hits(), "the control reached the non-operator canary").toBe(1);
  });
  it("every HARM test FAILED, naming the tripwire (a swallowed refusal is still failed by afterEach)", () => {
    const harms = Object.entries(result.verdicts).filter(([t]) => t.startsWith("HARM"));
    expect(harms.length).toBeGreaterThanOrEqual(10);
    for (const [t, v] of harms) {
      if (v.status === "skipped") continue; // the case-swap harm on a case-sensitive volume
      expect(v.status, t).toBe("failed");
      expect(v.messages, t).toMatch(/OPERATOR_TRIPWIRE/);
    }
  });
  it("each harm names WHAT was refused (so the failure says which route)", () => {
    const m = (prefix: string) => Object.entries(result.verdicts).find(([t]) => t.startsWith(prefix))![1].messages;
    expect(m("HARM http")).toMatch(new RegExp(`connect 127\\.0\\.0\\.1:${op.port}`));
    expect(m("HARM mapped-hex")).toMatch(/connect ::ffff:7f00:1/);
    expect(m("HARM lookup")).toMatch(/relay\.example\.invalid \(127\.0\.0\.1\)/);
    expect(m("HARM fs-alias")).toMatch(/readFileSync .*alias/);
    expect(m("HARM child-net")).toMatch(/node pid=\d+ connect 127\.0\.0\.1/);
    expect(m("HARM child-frozen")).toMatch(/fs pid=\d+ readFileSync/);
    expect(m("HARM child-home")).toMatch(/refused to spawn|names the OPERATOR's home or relay root/);
    expect(m("HARM record-lost")).toMatch(/could not record a violation/);
    expect(m("HARM fs-dotdot-alias")).toMatch(/readFileSync .*alias-inst.*\.\./);
    expect(m("HARM child-record-lost (sync)")).toMatch(/exited 97/);
    expect(m("HARM child-record-lost (async)")).toMatch(/exited 97/);
  });
  it("NOTHING was delivered: the operator canary saw ZERO connections", () => {
    expect(op.hits()).toBe(0);
  });
  it("the run FAILED at teardown, listing the violations (catch-proof), and kept its run directory", () => {
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/OPERATOR_TRIPWIRE: \d+ operator-tripwire violation\(s\) in this run/);
  });
});

describe.skipIf(process.platform === "win32")("NESTED: a violation NO test can see still fails the run (the teardown backstop)", () => {
  it("a child that reaches the operator port after its test (and afterEach) finished: every test PASSES, the run FAILS", async () => {
    const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tw-late-")));
    const op = await canary();
    try {
      const r = await nestedRun("late.fixture", { RELAY_HTTP_PORT: String(op.port), TRIPWIRE_FIXTURE_PORT: String(op.port), TMPDIR: work }, work);
      expect(Object.values(r.verdicts).map((v) => v.status), r.out.slice(-1500)).toEqual(["passed"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/OPERATOR_TRIPWIRE: 1 operator-tripwire violation\(s\) in this run[\s\S]*node pid=\d+ connect 127\.0\.0\.1/);
      expect(op.hits()).toBe(0);
    } finally {
      await op.close();
      fs.rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});
