// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0047 PR 4 — `relay fleet --deploy-check`: the PR 3 engine, OBSERVED TWICE.
 *   0 PASS: every connector (bound or UNBOUND), every live bound window and the
 *           daemon CURRENT, and the two observations agree;
 *   1 FAIL: anything not CURRENT, each offender named;
 *   3 CANNOT-VERIFY: the two observations disagree, or the board cannot be read.
 * Plus the ruled Codex-shape row (coverage ruling 37529ef6), on REAL processes: an
 * UNBOUND connector launched through a SYMLINKED install, then the install rebuilt
 * → STALE → exit 1; its twin before the rebuild → CURRENT, UNBOUND → exit 0. The
 * real rows are isolated to the test's own pids, so the live windows on the machine
 * running the tests never change a verdict.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adr0047-pr4-")));
process.env.RELAY_DB_PATH = path.join(ROOT, "relay.db");
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill("SIGKILL");
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const V = await import("../src/fleet-verdicts.js");
const { realSystemDeps } = await import("../src/fleet-system.js");
type FleetSnapshot = import("../src/fleet-verdicts.js").FleetSnapshot;
type ProcessView = import("../src/fleet-verdicts.js").ProcessView;

// --- a small snapshot builder (the PR 3 shapes) ---------------------------------
const CODE = "c".repeat(64);
const DEPS = "d".repeat(64);
const INSTALL = "/opt/relay";
const SCRIPT = `${INSTALL}/dist/index.js`;
const START = (n: number) => `Thu Oct  1 07:00:${String(n).padStart(2, "0")} 2026 UTC`;
const p = (pid: number, ppid: number, command: string, comm: string, n: number): ProcessView => ({ pid, ppid, start: START(n), command, comm, cwd: null, argv: null });
const fsx: import("../src/fleet-verdicts.js").ClassifyFs = {
  isFile: (x) => x === SCRIPT,
  realpath: (x) => (x === SCRIPT ? x : null),
  packageName: (d) => (d === INSTALL ? "bot-relay-mcp" : null),
};
const installed = (content = CODE) => ({
  check: { consistent: true, stamped: content, content, deps: DEPS, deps_state: "known" as const, reason: "ok" },
  stamp: { commit: "abc1234", dirty: false, built_at: "2026-10-01T10:00:00Z" },
});
const build = (id = CODE) => ({ build_id: id, deps_id: DEPS, deps_state: "known", commit: "abc1234", dirty: false, built_at: "2026-10-01T10:00:00Z", node: "v22.0.0" });
const row = (pid: number, n: number, id = CODE, parent: number | null = 10) => ({
  pid, pid_start: START(n), parent_pid: parent, parent_start: parent === null ? null : START(1), build_id: id, deps_id: DEPS, deps_state: "known",
  node: "v22.0.0", commit_sha: "abc1234", dirty: 0, built_at: "2026-10-01T10:00:00Z", install_dir: INSTALL,
});
function snap(over: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    processes: [p(10, 1, "claude", "claude", 1), p(11, 10, `node ${SCRIPT}`, "node", 2), p(99, 1, `node ${SCRIPT}`, "node", 9)],
    listeners: [99],
    rows: [row(11, 2)],
    bindings: [{ agent_name: "architect", window_pid: 10, window_pid_start: START(1) }],
    daemon: { port: 3777, listenerPids: [99], health: { ok: true, build: build() } },
    installed: () => installed(),
    nodeOnPath: "v22.0.0",
    ...over,
  };
}
const judge = (s: FleetSnapshot) => V.judgeFleet(s, fsx);
const check = (a: FleetSnapshot, b: FleetSnapshot = a) => {
  let n = 0;
  return V.deployCheck(async () => (n++ === 0 ? a : b), { judge });
};

describe("the exit contract", () => {
  it("all CURRENT, twice alike → PASS (0)", async () => {
    const o = await check(snap());
    expect([o.outcome, o.exit]).toEqual(["PASS", 0]);
    expect(o.reason).toMatch(/observed twice/);
  });
  const failing: Array<[string, FleetSnapshot, RegExp]> = [
    ["a STALE bound connector", snap({ rows: [row(11, 2, "e".repeat(64))] }), /STALE/],
    ["a STALE UNBOUND connector (never informational)", snap({ bindings: [], rows: [row(11, 2, "e".repeat(64), null)] }), /STALE/],
    ["a connector with no row (UNKNOWN)", snap({ rows: [] }), /UNKNOWN/],
    ["an INSTALL INCONSISTENT install", snap({ installed: () => ({ ...installed(), check: { ...installed().check, consistent: false, reason: "rebuild" } }) }), /INSTALL INCONSISTENT/],
    ["a live window with NO CONNECTOR", snap({ processes: [p(10, 1, "claude", "claude", 1), p(99, 1, `node ${SCRIPT}`, "node", 9)], rows: [] }), /NO CONNECTOR/],
    ["the daemon STALE (not restarted)", snap({ daemon: { port: 3777, listenerPids: [99], health: { ok: true, build: build("e".repeat(64)) } } }), /STALE/],
    ["no daemon listening", snap({ daemon: { port: 3777, listenerPids: [], health: { ok: false, error: "x", unreachable: true } } }), /UNKNOWN/],
    ["a daemon that predates the build stamp (a verdict, not a blind spot)", snap({ daemon: { port: 3777, listenerPids: [99], health: V.healthBuild({ ok: true }) } }), /UNKNOWN/],
  ];
  for (const [label, s, verdict] of failing) {
    it(`${label} → FAIL (1), named`, async () => {
      const o = await check(s);
      expect([o.outcome, o.exit]).toEqual(["FAIL", 1]);
      const named = [...o.judgement.connectors.map((e) => e.verdict), ...o.judgement.windows.map((w) => w.verdict), o.judgement.daemon.verdict];
      expect(named.join(" ")).toMatch(verdict);
    });
  }
  it("a window restarting between the two observations → CANNOT-VERIFY (3), never a PASS on a half-read", async () => {
    const before = snap();
    const after = snap({ processes: [p(10, 1, "claude", "claude", 1), p(12, 10, `node ${SCRIPT}`, "node", 7), p(99, 1, `node ${SCRIPT}`, "node", 9)], rows: [row(12, 7)] });
    const o = await check(before, after);
    expect([o.outcome, o.exit]).toEqual(["CANNOT-VERIFY", 3]);
    expect(o.reason).toMatch(/changed while it was being checked/);
  });
  it("the same processes but a verdict that FLIPS between the looks (an install mid-rebuild) → CANNOT-VERIFY (3)", async () => {
    // ONE unbound connector flips STALE → CURRENT; no window, and the daemon is unchanged.
    const o = await check(snap({ bindings: [], rows: [row(11, 2, "e".repeat(64), null)] }), snap({ bindings: [], rows: [row(11, 2, CODE, null)] }));
    expect([o.outcome, o.exit]).toEqual(["CANNOT-VERIFY", 3]);
  });
  it("#298 Codex R1 P2 (MEASURED): a daemon RESTARTED at the same pid between the looks (both CURRENT) → CANNOT-VERIFY (3)", async () => {
    const later = snap({ processes: [p(10, 1, "claude", "claude", 1), p(11, 10, `node ${SCRIPT}`, "node", 2), p(99, 1, `node ${SCRIPT}`, "node", 20)] });
    expect(judge(later).daemon).toMatchObject({ pid: 99, verdict: "CURRENT" }); // precondition: the second daemon also reads CURRENT
    const o = await check(snap(), later);
    expect([o.outcome, o.exit]).toEqual(["CANNOT-VERIFY", 3]);
  });
  it("twin: the SAME daemon (pid AND start) twice → PASS (0)", async () => {
    const o = await check(snap(), snap());
    expect(o.judgement.daemon).toMatchObject({ pid: 99, start: START(9) });
    expect([o.outcome, o.exit]).toEqual(["PASS", 0]);
  });
  it("#298 Codex R2 (MEASURED): the listening daemon is ABSENT from an otherwise readable process table → CANNOT-VERIFY (3), never FAIL", async () => {
    const noDaemonRow = snap({ processes: [p(10, 1, "claude", "claude", 1), p(11, 10, `node ${SCRIPT}`, "node", 2)] });
    expect(judge(noDaemonRow).daemon).toMatchObject({ pid: 99, start: null }); // precondition: its identity was not obtained
    const o = await check(noDaemonRow);
    expect([o.outcome, o.exit]).toEqual(["CANNOT-VERIFY", 3]);
    expect(o.reason).toMatch(/daemon .*pid 99.*identity/);
  });
  it("#298 Codex R2 (MEASURED): an EMPTY daemon start token in both looks → CANNOT-VERIFY (3), never PASS", async () => {
    const empty = snap({ processes: [p(10, 1, "claude", "claude", 1), p(11, 10, `node ${SCRIPT}`, "node", 2), { ...p(99, 1, `node ${SCRIPT}`, "node", 9), start: "" }] });
    expect(judge(empty).daemon).toMatchObject({ pid: 99, start: "", verdict: "CURRENT" }); // precondition: otherwise it would PASS
    const o = await check(empty);
    expect([o.outcome, o.exit]).toEqual(["CANNOT-VERIFY", 3]);
  });
  it("the second observation is taken AFTER the first (afterFirstObservation runs between them)", async () => {
    const order: string[] = [];
    await V.deployCheck(async () => (order.push("observe"), snap()), { judge, afterFirstObservation: () => void order.push("between") });
    expect(order).toEqual(["observe", "between", "observe"]);
  });
  const blind: Array<[string, Partial<FleetSnapshot>]> = [
    ["the process table", { processes: { error: "ps returned no processes" } }],
    ["the TCP listeners", { listeners: { error: "lsof missing" } }],
    ["the daemon's port listener", { daemon: { port: 3777, listenerPids: { error: "lsof" }, health: { ok: false, error: "x" } } }],
    ["the daemon's /health (it listens, but the read fails)", { daemon: { port: 3777, listenerPids: [99], health: { ok: false, error: "ECONNRESET", unreachable: true } } }],
  ];
  for (const [label, over] of blind) {
    it(`${label} unreadable → CANNOT-VERIFY (3)`, async () => {
      const o = await check(snap(over));
      expect([o.outcome, o.exit]).toEqual(["CANNOT-VERIFY", 3]);
    });
  }
});

describe("#298 Codex R1 P3: the text report prints every connector warning, whatever the outcome", () => {
  const ELSEWHERE = "/opt/another-relay";
  // A CURRENT UNBOUND connector loaded from another install than the daemon's (MEASURED shape).
  const s = snap({ bindings: [], rows: [{ ...row(11, 2, CODE, null), install_dir: ELSEWHERE }] });
  it("PASS: the warning is printed and the exit stays 0", async () => {
    const o = await check(s);
    expect([o.outcome, o.exit]).toEqual(["PASS", 0]);
    expect(o.judgement.connectors[0].warnings).toEqual([`it was loaded from ${ELSEWHERE}, not the daemon's install (${INSTALL})`]); // precondition
    expect(V.deployCheckText(o)).toContain(`it was loaded from ${ELSEWHERE}, not the daemon's install (${INSTALL})`);
  });
  it("FAIL: the warning of a CURRENT connector is printed too (not only the offenders)", async () => {
    const failing = snap({ bindings: [], rows: [{ ...row(11, 2, CODE, null), install_dir: ELSEWHERE }], daemon: { port: 3777, listenerPids: [99], health: { ok: true, build: build("e".repeat(64)) } } });
    const o = await check(failing);
    expect([o.outcome, o.exit]).toEqual(["FAIL", 1]);
    expect(V.deployCheckText(o)).toContain(`it was loaded from ${ELSEWHERE}`);
    expect(V.deployCheckText(o)).toMatch(/STALE {2}daemon pid 99/);
  });
});

describe("relay fleet --deploy-check (the CLI)", () => {
  const RELAY = path.join(REPO_ROOT, "bin", "relay");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [RELAY, "fleet", ...args], { encoding: "utf-8", env: { PATH: process.env.PATH ?? "", HOME: ROOT, RELAY_HOME: ROOT, RELAY_HTTP_PORT: "1" }, timeout: 60_000 });
  it("a board that cannot be read (no DB) is CANNOT-VERIFY (3), not FAIL", () => {
    const r = run("--deploy-check", "--db-path", path.join(ROOT, "absent.db"));
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/FLEET_FAILED/);
  });
  it("--connectors with --deploy-check is a usage error (2)", () => {
    expect(run("--connectors", "--deploy-check").status).toBe(2);
  });
});

// --- the ruled Codex-shape row, on REAL processes -------------------------------
const hasLsof = spawnSync("sh", ["-c", "command -v lsof"]).status === 0;
describe("the Codex shape, REAL processes: an UNBOUND connector through a SYMLINKED install", () => {
  const freePort = () =>
    new Promise<number>((res) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const port = (s.address() as net.AddressInfo).port;
        s.close(() => res(port));
      });
    });

  it.skipIf(!hasLsof)("CURRENT + UNBOUND → exit 0; the install rebuilt → the connector (and the daemon) STALE → exit 1", async () => {
    // A scratch install: this build's package.json + dist, its node_modules linked.
    const install = path.join(ROOT, "scratch install");
    fs.mkdirSync(install);
    fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(install, "package.json"));
    fs.cpSync(path.join(REPO_ROOT, "dist"), path.join(install, "dist"), { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(install, "node_modules"));
    const link = path.join(ROOT, "relay-link"); // the Codex shape: launched through a symlink
    fs.symlinkSync(install, link);
    const db = path.join(ROOT, "e2e.db");
    const port = await freePort();
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: ROOT,
      RELAY_DB_PATH: db,
      RELAY_CONFIG_PATH: path.join(ROOT, "none.json"),
      RELAY_HTTP_PORT: String(port),
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_SKIP_TTY_CHECK: "1",
      RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(ROOT, "wc.json"),
    };
    const daemon = spawn(process.execPath, [path.join(link, "dist", "index.js")], { env: { ...env, RELAY_TRANSPORT: "http" }, stdio: "ignore" });
    children.push(daemon);
    let up = false;
    for (let t0 = Date.now(); !up && Date.now() - t0 < 15_000; ) {
      try {
        up = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    expect(up, "precondition: the scratch daemon is up").toBe(true);
    // The connector: a real stdio server, its stdin held open; its parent is this test (no agent window) → UNBOUND.
    const connector = spawn(process.execPath, [path.join(link, "dist", "index.js")], { env: { ...env, RELAY_TRANSPORT: "stdio" }, stdio: ["pipe", "ignore", "ignore"] });
    children.push(connector);

    process.env.RELAY_DB_PATH = db;
    const dbm = await import("../src/db.js");
    dbm.closeDb();
    const mine = new Set([daemon.pid as number, connector.pid as number]);
    const keep = <T>(m: Map<number, T>) => new Map([...m].filter(([pid]) => mine.has(pid)));
    const sys = {
      ...realSystemDeps,
      processTable: () => keep(realSystemDeps.processTable()),
      allListeners: () => {
        const all = realSystemDeps.allListeners();
        return Array.isArray(all) ? all.filter((x) => mine.has(x)) : all;
      },
    };
    const observe = () =>
      V.observeFleet(sys, { liveRows: (startOf) => dbm.liveConnectors({ startOf }), liveBindings: () => [] }, port);
    for (let t0 = Date.now(); Date.now() - t0 < 15_000; ) {
      if (dbm.liveConnectors({ startOf: (pid) => realSystemDeps.processTable().get(pid)?.startedAt ?? null }).some((r) => r.pid === connector.pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const pass = await V.deployCheck(observe);
    expect(pass.judgement.connectors.map((e) => [e.pid, e.unbound, e.verdict, e.install_dir])).toEqual([
      [connector.pid, true, "CURRENT", fs.realpathSync(install)],
    ]);
    expect(pass.judgement.daemon.verdict).toBe("CURRENT");
    expect([pass.outcome, pass.exit], pass.reason).toEqual(["PASS", 0]);

    // "Rebuild" the install: new code, a new consistent stamp. Both running processes now run the OLD build.
    fs.appendFileSync(path.join(install, "dist", "fleet-verdicts.js"), "\n// rebuilt\n");
    const stamp = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "write-build-info.mjs"), install], { encoding: "utf-8" });
    expect(stamp.status, stamp.stderr).toBe(0);
    const fail = await V.deployCheck(observe);
    expect([fail.outcome, fail.exit]).toEqual(["FAIL", 1]);
    expect(fail.judgement.connectors).toMatchObject([{ pid: connector.pid, unbound: true, verdict: "STALE" }]);
    expect(fail.judgement.daemon.verdict).toBe("STALE");
    dbm.closeDb();
  }, 90_000);
});
