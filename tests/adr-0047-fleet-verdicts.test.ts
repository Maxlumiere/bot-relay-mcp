// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0047 PR 3 — the verdict engine (src/fleet-verdicts.ts) and `relay fleet --connectors`.
 *
 *   - verdictForBuild: the ONE comparison (connectors and the daemon); only CURRENT passes.
 *   - classifyProcess: D3 (the first non-option argument) + D9 (the script resolved by
 *     EXISTENCE on macOS: exactly one space-joined prefix; none or several → UNKNOWN;
 *     any TCP listener excluded). Real processes for the "Claude AI" path and the
 *     symlinked (Codex-shape) launch.
 *   - judgeFleet: the connector set = processes UNION rows; UNBOUND is a label; a
 *     row-less connector is UNKNOWN, never CURRENT; NO CONNECTOR only on positive
 *     absence; the worst verdict per window; the daemon line.
 *   - local only: nothing of this reaches the off-machine snapshot.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "adr0047-pr3-")));
process.env.RELAY_DB_PATH = path.join(ROOT, "relay.db");
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill("SIGKILL");
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const V = await import("../src/fleet-verdicts.js");
const { realSystemDeps } = await import("../src/fleet-system.js");
type ProcessView = import("../src/fleet-verdicts.js").ProcessView;
type FleetSnapshot = import("../src/fleet-verdicts.js").FleetSnapshot;
type InstalledFacts = import("../src/fleet-verdicts.js").InstalledFacts;
type ClassifyFs = import("../src/fleet-verdicts.js").ClassifyFs;

// --- fixtures ---------------------------------------------------------------
const CODE = "c".repeat(64);
const DEPS = "d".repeat(64);
const installedOk = (over: Partial<InstalledFacts["check"]> = {}): InstalledFacts => ({
  check: { consistent: true, stamped: CODE, content: CODE, deps: DEPS, deps_state: "known", reason: "the stamp matches the code", ...over },
  stamp: { commit: "abcdef0123", dirty: false, built_at: "2026-10-01T10:00:00Z" },
});
const loaded = (over: Partial<import("../src/fleet-verdicts.js").LoadedFacts> = {}) => ({
  build_id: CODE,
  deps_id: DEPS,
  deps_state: "known",
  commit: "abcdef0123",
  dirty: false,
  built_at: "2026-10-01T10:00:00Z",
  node: "v22.0.0",
  ...over,
});

describe("verdictForBuild: the ONE comparison; only CURRENT passes", () => {
  const rows: Array<[string, ReturnType<typeof loaded>, InstalledFacts, string, RegExp]> = [
    ["the install fails checkInstall → INSTALL INCONSISTENT", loaded(), installedOk({ consistent: false, reason: "the build stamp does not match the code: rebuild with npm run build" }), "INSTALL INCONSISTENT", /rebuild/],
    ["an unstamped build → UNKNOWN", loaded({ build_id: "unbuilt" }), installedOk(), "UNKNOWN", /unstamped/],
    ["its deps were not identified at start → UNKNOWN", loaded({ deps_state: "unknown", deps_id: null }), installedOk(), "UNKNOWN", /not identified/],
    ["the install's deps are unknown → UNKNOWN", loaded(), installedOk({ deps_state: "unknown", deps: null, reason: "the dependencies are UNKNOWN: only npm installs" }), "UNKNOWN", /only npm/],
    ["code and deps equal → CURRENT", loaded(), installedOk(), "CURRENT", /installed build/],
    ["the code differs → STALE", loaded({ build_id: "e".repeat(64) }), installedOk(), "STALE", /its code differ/],
    ["the deps differ → STALE", loaded({ deps_id: "f".repeat(64) }), installedOk(), "STALE", /its dependencies differ/],
    ["both differ → STALE", loaded({ build_id: "e".repeat(64), deps_id: "f".repeat(64) }), installedOk(), "STALE", /code and dependencies differ.*restart needed/],
  ];
  for (const [label, l, inst, verdict, why] of rows) {
    it(label, () => {
      const v = V.verdictForBuild(l, inst);
      expect(v.verdict).toBe(verdict);
      expect(v.reason).toMatch(why);
    });
  }
});

// --- classification -----------------------------------------------------------
/** A fake file system: `files` exist as regular files; `links` map a path to its realpath; `pkgs` dir → name. */
function fakeFs(files: string[], pkgs: Record<string, string | { error: string }>, links: Record<string, string> = {}): ClassifyFs {
  return {
    isFile: (p) => files.includes(p),
    realpath: (p) => links[p] ?? (files.includes(p) ? p : null),
    packageName: (dir) => (dir in pkgs ? pkgs[dir] : null),
  };
}
const proc = (over: Partial<ProcessView>): ProcessView => ({ pid: 100, ppid: 1, start: "Thu Oct  1 07:00:00 2026 UTC", command: "", comm: "/usr/local/bin/node", cwd: null, argv: null, ...over });
const SPACED = "/Users/m/LLMs/Claude AI/bot-relay-mcp";

describe("classifyProcess (D3 + D9)", () => {
  const relayFs = fakeFs([`${SPACED}/dist/index.js`], { [SPACED]: "bot-relay-mcp" });
  it("the \"Claude AI\" path: exactly one space-joined prefix exists → a connector of that install", () => {
    const c = V.classifyProcess(proc({ command: `node ${SPACED}/dist/index.js` }), new Set(), relayFs);
    expect(c).toEqual({ kind: "connector", script: `${SPACED}/dist/index.js`, installDir: SPACED });
  });
  it("a planted SECOND existing prefix → UNKNOWN (ambiguous), never a guess", () => {
    const fsx = fakeFs(["/Users/m/LLMs/Claude", `${SPACED}/dist/index.js`], { [SPACED]: "bot-relay-mcp" });
    const c = V.classifyProcess(proc({ command: `node ${SPACED}/dist/index.js` }), new Set(), fsx);
    expect(c.kind).toBe("unknown");
    expect((c as { reason: string }).reason).toMatch(/ambiguous: 2/);
  });
  it("no prefix exists → UNKNOWN", () => {
    expect(V.classifyProcess(proc({ command: `node ${SPACED}/dist/index.js` }), new Set(), fakeFs([], {})).kind).toBe("unknown");
  });
  it("ANY TCP listener is excluded (the daemon), whatever it runs (D9.2)", () => {
    const c = V.classifyProcess(proc({ pid: 4242, command: `node ${SPACED}/dist/index.js` }), new Set([4242]), relayFs);
    expect(c.kind).toBe("not-relay");
  });
  it("not node → not relay", () => {
    expect(V.classifyProcess(proc({ comm: "/usr/bin/python3", command: `python3 ${SPACED}/dist/index.js` }), new Set(), relayFs).kind).toBe("not-relay");
  });
  it("node options are skipped, and an option's VALUE is never taken for the script (D3)", () => {
    const fsx = fakeFs(["/pre.js", `${SPACED}/dist/index.js`], { [SPACED]: "bot-relay-mcp" });
    const c = V.classifyProcess(proc({ command: `node --enable-source-maps --require /pre.js ${SPACED}/dist/index.js` }), new Set(), fsx);
    expect(c).toMatchObject({ kind: "connector", installDir: SPACED });
  });
  it("node -e has no script → not relay", () => {
    expect(V.classifyProcess(proc({ command: "node -e 1" }), new Set(), relayFs).kind).toBe("not-relay");
  });
  it("a relative script resolves against the process's cwd; with no cwd → UNKNOWN", () => {
    expect(V.classifyProcess(proc({ command: "node dist/index.js", cwd: SPACED }), new Set(), relayFs)).toMatchObject({ kind: "connector", installDir: SPACED });
    expect(V.classifyProcess(proc({ command: "node dist/index.js", cwd: null }), new Set(), relayFs).kind).toBe("unknown");
  });
  it("the Codex shape: a symlinked launch path → the REALPATH install", () => {
    const fsx = fakeFs(["/Users/m/bot-relay-mcp/dist/index.js"], { [SPACED]: "bot-relay-mcp" }, {
      "/Users/m/bot-relay-mcp/dist/index.js": `${SPACED}/dist/index.js`,
    });
    expect(V.classifyProcess(proc({ command: "node /Users/m/bot-relay-mcp/dist/index.js" }), new Set(), fsx)).toMatchObject({ kind: "connector", installDir: SPACED });
  });
  it("another package's dist/index.js → not relay; an unreadable package.json → UNKNOWN", () => {
    expect(V.classifyProcess(proc({ command: `node ${SPACED}/dist/index.js` }), new Set(), fakeFs([`${SPACED}/dist/index.js`], { [SPACED]: "n8n-mcp" })).kind).toBe("not-relay");
    expect(V.classifyProcess(proc({ command: `node ${SPACED}/dist/index.js` }), new Set(), fakeFs([`${SPACED}/dist/index.js`], { [SPACED]: { error: "EACCES" } })).kind).toBe("unknown");
  });
  describe("#297 Codex R1 P1: a node option can never hide a connector", () => {
    const optFs = fakeFs(["/tmp/config.env", "/tmp/a b.js", "/w/b.js", `${SPACED}/dist/index.js`, "/opt/other/dist/index.js"], {
      [SPACED]: "bot-relay-mcp",
      "/opt/other": "something-else",
    });
    it("the MEASURED shape: --env-file-if-exists VALUE is never taken for the script (ps-joined AND exact argv)", () => {
      const cmd = `node --env-file-if-exists /tmp/config.env ${SPACED}/dist/index.js`;
      expect(V.classifyProcess(proc({ command: cmd }), new Set(), optFs).kind).not.toBe("not-relay");
      expect(V.classifyProcess(proc({ command: "x", argv: ["node", "--env-file-if-exists", "/tmp/config.env", `${SPACED}/dist/index.js`] }), new Set(), optFs)).toMatchObject({
        kind: "connector",
        installDir: SPACED,
      });
    });
    it("EVERY value-taking option of node's own table, in the space form, skips its value (exact argv)", () => {
      expect(V.NODE_OPTIONS_WITH_VALUE.size).toBeGreaterThan(60); // non-vacuous: the table, not a sample
      for (const opt of V.NODE_OPTIONS_WITH_VALUE) {
        if (V.NODE_NO_SCRIPT.has(opt)) continue; // --eval / --run: node runs no script file at all
        const c = V.classifyProcess(proc({ command: "x", argv: ["node", opt, "/tmp/config.env", `${SPACED}/dist/index.js`] }), new Set(), optFs);
        expect([opt, c.kind]).toEqual([opt, "connector"]);
      }
    });
    it("an option node's table does not know, in the space form, before a relay entrypoint → UNKNOWN, never not-relay", () => {
      const c = V.classifyProcess(proc({ command: `node --frobnicate /tmp/config.env ${SPACED}/dist/index.js` }), new Set(), optFs);
      expect(c).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/--frobnicate/) });
    });
    it("twin: an unknown option whose EVERY reading is not relay, and no relay entrypoint in argv → not relay", () => {
      // Read as a flag: the script is /opt/other (another package). Read as taking a value: no script at all.
      expect(V.classifyProcess(proc({ command: "node --frobnicate /opt/other/dist/index.js" }), new Set(), optFs).kind).toBe("not-relay");
    });
    it("twin: an unknown option whose readings DISAGREE (one cannot be confirmed) → UNKNOWN, naming the option", () => {
      // As a flag the script is "4096", which does not exist: that reading cannot be confirmed.
      const c = V.classifyProcess(proc({ command: "node --frobnicate 4096 /opt/other/dist/index.js", cwd: "/w" }), new Set(), optFs);
      expect(c).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/--frobnicate .*readings of its argv disagree/) });
    });
    it("twin: one reading finds a connector, another does not → UNKNOWN, never a guessed connector", () => {
      // As a flag the script is the relay entrypoint; taking a value, the script is /tmp/config.env.
      const c = V.classifyProcess(proc({ command: `node --frobnicate ${SPACED}/dist/index.js /tmp/config.env` }), new Set(), optFs);
      expect(c.kind).toBe("unknown");
    });
    it("twin: an unknown option in the --opt=value form is ONE argument: certain, the connector is found", () => {
      expect(V.classifyProcess(proc({ command: `node --frobnicate=/tmp/config.env ${SPACED}/dist/index.js` }), new Set(), optFs)).toMatchObject({
        kind: "connector",
        installDir: SPACED,
      });
    });
    it("ps-joined argv: a space-form value that itself contains a space cannot hide the connector → UNKNOWN", () => {
      // The real value is "/tmp/a b.js"; skipping ONE token lands on "b.js", which exists relative to the cwd.
      const c = V.classifyProcess(proc({ command: `node --require /tmp/a b.js ${SPACED}/dist/index.js`, cwd: "/w" }), new Set(), optFs);
      expect(c.kind).toBe("unknown");
    });
    it("node's OWN option table (`node --help` of the running node) is pinned: every option, with the same arity", () => {
      const help = spawnSync(process.execPath, ["--help"], { encoding: "utf-8" }).stdout;
      const value = new Set<string>();
      const flag = new Set<string>();
      for (const line of help.split("\n")) {
        const m = /^ {2}(-[^ ].*?)(?: {2,}| [A-Z(]|$)/.exec(line);
        if (!m) continue;
        const aliases = m[1].split(/, /).map((s) => s.trim());
        const lm = /^(-{1,2}[A-Za-z0-9][A-Za-z0-9.-]*)(.*)$/.exec(aliases[aliases.length - 1]);
        if (!lm) continue; // "-" (stdin) and "--"
        for (const a of aliases) {
          const am = /^(-{1,2}[A-Za-z0-9][A-Za-z0-9.-]*)/.exec(a);
          if (am) (lm[2].startsWith("=") ? value : flag).add(am[1]);
        }
      }
      expect(value.size + flag.size).toBeGreaterThan(150); // non-vacuous: the parse read the real table
      expect([...value].filter((o) => !V.NODE_OPTIONS_WITH_VALUE.has(o))).toEqual([]);
      expect([...flag].filter((o) => !V.NODE_FLAGS.has(o) && !V.NODE_NO_SCRIPT.has(o))).toEqual([]);
      expect([...flag].filter((o) => V.NODE_OPTIONS_WITH_VALUE.has(o))).toEqual([]);
    });
  });
  describe("#297 Codex R1 P2: missing identification metadata is UNKNOWN, never a positive exclusion", () => {
    it("a relay-shaped dist/index.js whose package.json is MISSING → UNKNOWN", () => {
      const c = V.classifyProcess(proc({ command: `node ${SPACED}/dist/index.js` }), new Set(), fakeFs([`${SPACED}/dist/index.js`], {}));
      expect(c).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/package\.json/) });
    });
  });
  it("an EXACT argv (Linux /proc) is read directly: no ambiguity", () => {
    const fsx = fakeFs(["/Users/m/LLMs/Claude", `${SPACED}/dist/index.js`], { [SPACED]: "bot-relay-mcp" });
    const c = V.classifyProcess(proc({ command: "ignored", argv: ["node", `${SPACED}/dist/index.js`] }), new Set(), fsx);
    expect(c).toMatchObject({ kind: "connector", installDir: SPACED });
  });

  describe("REAL processes and a real file system", () => {
    // A fake relay install whose path contains a space; its dist/index.js just sleeps.
    const install = path.join(ROOT, "Claude AI", "bot-relay-mcp");
    fs.mkdirSync(path.join(install, "dist"), { recursive: true });
    fs.writeFileSync(path.join(install, "package.json"), JSON.stringify({ name: "bot-relay-mcp" }));
    fs.writeFileSync(path.join(install, "dist", "index.js"), "setInterval(() => {}, 1000);\n");
    const link = path.join(ROOT, "linked-relay");
    fs.symlinkSync(install, link);

    function launch(script: string): number {
      const c = spawn(process.execPath, [script], { stdio: "ignore" });
      children.push(c);
      return c.pid as number;
    }
    /** The process as the REAL system reads it (ps + lsof), with argv forced to the macOS (ps-joined) form. */
    function viewOf(pid: number): ProcessView {
      for (let i = 0; i < 50; i++) {
        const table = realSystemDeps.processTable();
        const e = table.get(pid);
        if (e && e.command.includes("index.js")) {
          return { pid, ppid: e.ppid, start: e.startedAt, command: e.command, comm: e.comm, cwd: realSystemDeps.cwds([pid]).get(pid) ?? null, argv: null };
        }
        spawnSync("sleep", ["0.1"]);
      }
      throw new Error(`pid ${pid} never appeared in the process table`);
    }
    it("a connector launched from a path with a SPACE is classified, from ps output alone", () => {
      const c = V.classifyProcess(viewOf(launch(path.join(install, "dist", "index.js"))), new Set());
      expect(c).toMatchObject({ kind: "connector", installDir: fs.realpathSync(install) });
    });
    it("launched through a SYMLINK (the Codex shape): install_dir is the realpath", () => {
      const c = V.classifyProcess(viewOf(launch(path.join(link, "dist", "index.js"))), new Set());
      expect(c).toMatchObject({ kind: "connector", installDir: fs.realpathSync(install) });
    });
    it("a planted second existing prefix makes the REAL process UNKNOWN", () => {
      const pid = launch(path.join(install, "dist", "index.js"));
      const view = viewOf(pid);
      fs.writeFileSync(path.join(ROOT, "Claude"), "planted"); // "<ROOT>/Claude" now exists too
      try {
        expect(V.classifyProcess(view, new Set()).kind).toBe("unknown");
      } finally {
        fs.rmSync(path.join(ROOT, "Claude"));
      }
    });
  });
});

// --- judgement ---------------------------------------------------------------
const START = (n: number) => `Thu Oct  1 07:00:${String(n).padStart(2, "0")} 2026 UTC`;
const node = (pid: number, ppid: number, script: string, n = 0): ProcessView =>
  proc({ pid, ppid, start: START(n), command: `node ${script}`, comm: "/usr/local/bin/node" });
const win = (pid: number, n = 0): ProcessView => proc({ pid, ppid: 1, start: START(n), command: "claude", comm: "claude" });
const INSTALL = "/opt/relay";
const SCRIPT = `${INSTALL}/dist/index.js`;
const judgeFs = fakeFs([SCRIPT, "/opt/other/dist/index.js"], { [INSTALL]: "bot-relay-mcp", "/opt/other": "something-else" });
const row = (pid: number, n: number, over: Partial<import("../src/fleet-verdicts.js").RowView> = {}) => ({
  pid,
  pid_start: START(n),
  parent_pid: 10,
  parent_start: START(1),
  build_id: CODE,
  deps_id: DEPS,
  deps_state: "known",
  node: "v22.0.0",
  commit_sha: "abcdef0123",
  dirty: 0,
  built_at: "2026-10-01T10:00:00Z",
  install_dir: INSTALL,
  ...over,
});
function snapshot(over: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    processes: [win(10, 1), node(11, 10, SCRIPT, 2), node(99, 1, SCRIPT, 9)],
    listeners: [99],
    rows: [row(11, 2)],
    bindings: [{ agent_name: "architect", window_pid: 10, window_pid_start: START(1) }],
    daemon: { port: 3777, listenerPids: [99], health: { ok: true, build: loaded() } },
    installed: () => installedOk(),
    nodeOnPath: "v22.0.0",
    ...over,
  };
}

describe("judgeFleet", () => {
  it("all CURRENT: the bound connector carries its agent; the daemon (a listener) is never a connector; nothing fails", () => {
    const j = V.judgeFleet(snapshot(), judgeFs);
    expect(j.connectors.map((e) => [e.pid, e.agent, e.unbound, e.verdict])).toEqual([[11, "architect", false, "CURRENT"]]);
    expect(j.daemon).toMatchObject({ verdict: "CURRENT", pid: 99, install_dir: INSTALL });
    expect(j.windows).toEqual([{ agent: "architect", window_pid: 10, verdict: "CURRENT", reason: "its connector's verdict", connectors: [11] }]);
    expect(j.failing).toBe(0);
  });
  it("a connector process with NO row → UNKNOWN, never CURRENT", () => {
    const j = V.judgeFleet(snapshot({ rows: [] }), judgeFs);
    expect(j.connectors).toMatchObject([{ pid: 11, has_row: false, verdict: "UNKNOWN", agent: "architect" }]);
    expect(j.failing).toBe(1);
  });
  it("an UNBOUND connector is judged like any other: STALE fails, labelled UNBOUND", () => {
    const j = V.judgeFleet(snapshot({ bindings: [], rows: [row(11, 2, { build_id: "e".repeat(64) })] }), judgeFs);
    expect(j.connectors).toMatchObject([{ pid: 11, unbound: true, agent: null, verdict: "STALE" }]);
    expect(j.failing).toBe(1);
  });
  it("twin: an UNBOUND CURRENT connector passes, still labelled UNBOUND", () => {
    const j = V.judgeFleet(snapshot({ bindings: [] }), judgeFs);
    expect(j.connectors).toMatchObject([{ pid: 11, unbound: true, verdict: "CURRENT" }]);
    expect(j.failing).toBe(0);
  });
  it("identity is (pid, start): a row and a LATER process on the same pid are two connectors, never merged", () => {
    // The row's start (2) is not the process's start (5): a reused pid, as the table shows it.
    const j = V.judgeFleet(snapshot({ processes: [win(10, 1), node(11, 10, SCRIPT, 5), node(99, 1, SCRIPT, 9)] }), judgeFs);
    expect(j.connectors.map((e) => [e.pid, e.start, e.verdict, e.has_row]).sort()).toEqual([
      [11, START(2), "CURRENT", true],
      [11, START(5), "UNKNOWN", false],
    ]);
  });
  it("a row whose process the snapshot cannot classify is still judged (processes UNION rows)", () => {
    const j = V.judgeFleet(snapshot({ processes: [win(10, 1), node(99, 1, SCRIPT, 9)] }), judgeFs);
    expect(j.connectors.map((e) => [e.pid, e.verdict])).toEqual([[11, "CURRENT"]]);
  });
  it("NO CONNECTOR only on POSITIVE absence, with the honest D7 text", () => {
    const j = V.judgeFleet(snapshot({ processes: [win(10, 1), node(12, 10, "/opt/other/dist/index.js", 3), node(99, 1, SCRIPT, 9)], rows: [] }), judgeFs);
    expect(j.windows).toEqual([{ agent: "architect", window_pid: 10, verdict: "NO CONNECTOR", reason: V.NO_CONNECTOR_REASON, connectors: [] }]);
    expect(V.NO_CONNECTOR_REASON).toMatch(/MCP-mute, OR HTTP-configured: VIA DAEMON not yet supported, known gap/);
    expect(j.failing).toBe(1);
  });
  it("twin: one descendant that cannot be classified → UNKNOWN, never NO CONNECTOR", () => {
    const j = V.judgeFleet(snapshot({ processes: [win(10, 1), node(12, 10, "/gone/dist/index.js", 3), node(99, 1, SCRIPT, 9)], rows: [] }), judgeFs);
    // The unclassifiable node process is listed (fail closed) AND the window reads through it.
    expect(j.connectors).toMatchObject([{ pid: 12, kind: "unclassified", verdict: "UNKNOWN" }]);
    expect(j.windows).toMatchObject([{ window_pid: 10, verdict: "UNKNOWN" }]);
  });
  it("several connectors under one window: all listed, the window takes the WORST", () => {
    const j = V.judgeFleet(
      snapshot({
        processes: [win(10, 1), node(11, 10, SCRIPT, 2), node(13, 10, SCRIPT, 4), node(99, 1, SCRIPT, 9)],
        rows: [row(11, 2), row(13, 4, { build_id: "e".repeat(64) })],
      }),
      judgeFs,
    );
    expect(j.connectors.map((e) => [e.pid, e.verdict])).toEqual([[13, "STALE"], [11, "CURRENT"]]);
    expect(j.windows).toMatchObject([{ window_pid: 10, verdict: "STALE", connectors: [11, 13] }]);
    expect(j.failing).toBe(1); // the STALE connector, once
  });
  it("#297 Codex R1 P1 (MEASURED): a rowless connector behind --env-file-if-exists is on the board and fails", () => {
    const fsx = fakeFs([SCRIPT, "/tmp/config.env"], { [INSTALL]: "bot-relay-mcp" });
    const j = V.judgeFleet(
      snapshot({ processes: [win(10, 1), proc({ pid: 11, ppid: 1, start: START(2), command: `node --env-file-if-exists /tmp/config.env ${SCRIPT}` }), node(99, 1, SCRIPT, 9)], rows: [], bindings: [] }),
      fsx,
    );
    expect(j.connectors).toMatchObject([{ pid: 11, verdict: "UNKNOWN" }]);
    expect(j.failing).toBe(1);
  });
  it("#297 Codex R1 P2 (MEASURED): a rowless connector whose install lost its package.json → the window is UNKNOWN, never NO CONNECTOR", () => {
    const j = V.judgeFleet(snapshot({ rows: [] }), fakeFs([SCRIPT], {}));
    expect(j.windows).toMatchObject([{ window_pid: 10, verdict: "UNKNOWN", connectors: [11] }]);
    expect(j.windows[0].verdict).not.toBe("NO CONNECTOR");
  });
  it("#297 Codex R1 P2 (MEASURED): window ownership is (pid, START): a reused window pid never inherits an old connector", () => {
    // Connector 11 recorded parent (10, START(1)) and was reparented; pid 10 is now ANOTHER bound window (START(7)).
    const j = V.judgeFleet(
      snapshot({
        processes: [win(10, 7), node(11, 1, SCRIPT, 2), node(99, 1, SCRIPT, 9)],
        bindings: [{ agent_name: "newcomer", window_pid: 10, window_pid_start: START(7) }],
      }),
      judgeFs,
    );
    expect(j.connectors).toMatchObject([{ pid: 11, unbound: true, verdict: "CURRENT" }]);
    expect(j.windows).toMatchObject([{ agent: "newcomer", window_pid: 10, verdict: "NO CONNECTOR", connectors: [] }]);
    expect(j.failing).toBe(1);
  });
  it("twin: the SAME window (pid AND start) still owns its connector", () => {
    const j = V.judgeFleet(snapshot({ processes: [win(10, 1), node(11, 1, SCRIPT, 2), node(99, 1, SCRIPT, 9)] }), judgeFs);
    expect(j.windows).toMatchObject([{ window_pid: 10, verdict: "CURRENT", connectors: [11] }]);
  });
  it("#297 Codex R1 P2 (MEASURED): an owned connector does not hide a STALE descendant recording another parent: the worst of BOTH", () => {
    const j = V.judgeFleet(
      snapshot({
        processes: [win(10, 1), node(11, 10, SCRIPT, 2), node(12, 10, SCRIPT, 3), node(99, 1, SCRIPT, 9)],
        rows: [row(11, 2), row(12, 3, { parent_pid: 77, parent_start: START(5), build_id: "e".repeat(64) })],
      }),
      judgeFs,
    );
    expect(j.windows).toMatchObject([{ window_pid: 10, verdict: "STALE", connectors: [11, 12] }]);
  });
  it("a binding still in the legacy (pre-UTC) start form reads UNKNOWN with the reason, never NO CONNECTOR", () => {
    const j = V.judgeFleet(snapshot({ rows: [], processes: [win(10, 1), node(99, 1, SCRIPT, 9)], bindings: [{ agent_name: "a", window_pid: 10, window_pid_start: "Thu Oct  1 15:00:01 2026" }] }), judgeFs);
    expect(j.windows).toMatchObject([{ verdict: "UNKNOWN", reason: expect.stringMatching(/predates the UTC start token/) }]);
  });
  it("an unreadable process table: rows are judged, windows are UNKNOWN, and the daemon is UNKNOWN", () => {
    const j = V.judgeFleet(snapshot({ processes: { error: "ps returned no processes" } }), judgeFs);
    expect(j.connectors.map((e) => e.verdict)).toEqual(["CURRENT"]);
    expect(j.windows).toMatchObject([{ verdict: "CURRENT", connectors: [11] }]);
    expect(j.daemon.verdict).toBe("UNKNOWN");
    const none = V.judgeFleet(snapshot({ processes: { error: "x" }, rows: [] }), judgeFs);
    expect(none.windows).toMatchObject([{ verdict: "UNKNOWN", connectors: [] }]);
  });
  it("unreadable listeners: no process can be cleared as not-relay-by-listening → node processes are UNKNOWN", () => {
    const j = V.judgeFleet(snapshot({ listeners: { error: "lsof missing" }, rows: [] }), judgeFs);
    expect(j.connectors.every((e) => e.verdict === "UNKNOWN")).toBe(true);
  });
  describe("the daemon line", () => {
    it("STALE: not restarted after the install", () => {
      const j = V.judgeFleet(snapshot({ daemon: { port: 3777, listenerPids: [99], health: { ok: true, build: loaded({ build_id: "e".repeat(64) }) } } }), judgeFs);
      expect(j.daemon).toMatchObject({ verdict: "STALE", reason: expect.stringMatching(/^not restarted after the install/) });
      expect(j.failing).toBe(1);
    });
    it("compared against ITS OWN install (the listener's), not a connector's", () => {
      // The connector is on /opt/relay2 (current there); the daemon's install /opt/relay holds a NEWER build.
      const j = V.judgeFleet(
        snapshot({
          rows: [row(11, 2, { install_dir: "/opt/relay2" })],
          installed: (d) => (d === INSTALL ? installedOk({ content: "e".repeat(64), stamped: "e".repeat(64) }) : installedOk()),
        }),
        judgeFs,
      );
      expect(j.connectors[0].verdict).toBe("CURRENT");
      expect(j.daemon).toMatchObject({ verdict: "STALE", install_dir: INSTALL });
    });
    it("no listener / unreadable listener / /health without build / not a relay install → UNKNOWN", () => {
      expect(V.judgeFleet(snapshot({ daemon: { port: 3777, listenerPids: [], health: { ok: false, error: "x" } } }), judgeFs).daemon.verdict).toBe("UNKNOWN");
      expect(V.judgeFleet(snapshot({ daemon: { port: 3777, listenerPids: { error: "lsof" }, health: { ok: false, error: "x" } } }), judgeFs).daemon.verdict).toBe("UNKNOWN");
      expect(V.healthBuild({ ok: true })).toMatchObject({ ok: false, error: expect.stringMatching(/predates the build stamp/) });
      const other = V.judgeFleet(snapshot({ processes: [win(10, 1), node(11, 10, SCRIPT, 2), node(99, 1, "/opt/other/dist/index.js", 9)] }), judgeFs);
      expect(other.daemon).toMatchObject({ verdict: "UNKNOWN", reason: expect.stringMatching(/not recognisable as a relay install/) });
    });
  });
  it("warnings never change a verdict: another node on PATH, another install than the daemon's", () => {
    const j = V.judgeFleet(snapshot({ nodeOnPath: "v24.1.0", rows: [row(11, 2, { install_dir: "/opt/relay2" })], installed: () => installedOk() }), judgeFs);
    expect(j.connectors[0].verdict).toBe("CURRENT");
    expect(j.connectors[0].warnings).toEqual([
      "it runs node v22.0.0; the node on PATH is v24.1.0",
      "it was loaded from /opt/relay2, not the daemon's install (/opt/relay)",
    ]);
  });
});

describe("local only: no build or connector field reaches the off-machine snapshot", () => {
  it("buildKanbanSnapshot carries no key named build*, connector*, commit, install_dir or deps*", async () => {
    const db = await import("../src/db.js");
    db.closeDb();
    await db.initializeDb();
    db.registerAgent("a1", "user", []);
    const { buildKanbanSnapshot } = await import("../src/dashboard-push.js");
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (keys.add(k), walk(x));
    };
    walk(buildKanbanSnapshot(new Date().toISOString()));
    expect(keys.size).toBeGreaterThan(3); // non-vacuous: it walked a real snapshot
    expect([...keys].filter((k) => /^(build|connector|deps)|^commit$|^install_dir$/i.test(k))).toEqual([]);
    db.closeDb();
  });
});

describe("relay fleet --connectors (the CLI, read-only)", () => {
  const RELAY = path.join(REPO_ROOT, "bin", "relay");
  const run = (dbPath: string, ...args: string[]) =>
    spawnSync(process.execPath, [RELAY, "fleet", "--connectors", ...args, "--db-path", dbPath], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", HOME: ROOT, RELAY_HOME: ROOT, RELAY_HTTP_PORT: "1" },
      timeout: 60_000,
    });
  it("a DB without the connectors table refuses loudly (exit 1), never an empty board", async () => {
    // A full DB with the connectors table removed: every other check passes, so the refusal is this one.
    const db = await import("../src/db.js");
    const p = path.join(ROOT, "pre-v26.db");
    process.env.RELAY_DB_PATH = p;
    db.closeDb();
    await db.initializeDb();
    db.closeDb();
    const Better = (await import("better-sqlite3")).default;
    const h = new Better(p);
    h.exec("DROP TABLE connectors");
    h.close();
    const r = run(p);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FLEET_FAILED: .*no connectors table/);
  });
  it("--json: the judgement object, read-only (the DB file is byte-identical after)", async () => {
    const db = await import("../src/db.js");
    const p = path.join(ROOT, "v26.db");
    process.env.RELAY_DB_PATH = p;
    db.closeDb();
    await db.initializeDb();
    db.closeDb();
    const before = fs.readFileSync(p);
    const r = run(p, "--json");
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout) as { connectors: unknown[]; windows: unknown[]; daemon: { verdict: string }; failing: number };
    expect(Array.isArray(j.connectors) && Array.isArray(j.windows)).toBe(true);
    expect(j.daemon.verdict).toBe("UNKNOWN"); // port 1: nothing listens
    expect(fs.readFileSync(p).equals(before)).toBe(true);
  });
});
