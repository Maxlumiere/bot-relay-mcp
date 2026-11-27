// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE EXECUTABLE IDENTITY (MEASURED, CI diagnostic: on Linux, Node 24 names its main thread "MainThread", and a
 * process's comm IS its main thread's name, so `ps -o comm=` and /proc/<pid>/comm read "MainThread" for a node process
 * on 24.13.0 and 24.22.3; /proc/<pid>/exe still names the binary; macOS is unaffected). Every consumer that read comm
 * as "the executable" now reads the KERNEL's executable (Linux: /proc/<pid>/exe, " (deleted)" stripped), else comm:
 *   1. the hooks' relay_agent_pid ancestry walk;
 *   2. findAgentProcess (the stdio relay's own ancestry) and classifyProcess (fleet / deploy), via the process table;
 *   3. 8b's second profile judge (agreedProfileOf), bracketed by the instance's start, independent of argv.
 * The safe side differs by consumer when the exe is unreadable: agent detection → not an agent (8b: NULL);
 * classifyProcess with a runtime THREAD name for comm → UNKNOWN, never not-relay.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { executableIdentity, isRuntimeThreadName } from "../src/proc-exe.js";
import { buildProcessTable, findAgentProcess, agreedProfileOf, executableJudgeOf } from "../src/liveness.js";
import { classifyProcess } from "../src/fleet-verdicts.js";
import { budgetTree } from "./_helpers/hook-budget-tree.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const START = "Mon Nov 24 10:00:00 2026";

describe("executableIdentity: the kernel's executable (Linux /proc/<pid>/exe), never the thread-named comm", () => {
  it("Linux: the link's target; a trailing \" (deleted)\" (the binary replaced while running) is stripped", () => {
    const rl = (t: string) => (p: string) => (p === "/proc/42/exe" ? t : (() => { throw new Error("ENOENT"); })());
    expect(executableIdentity(42, { platform: "linux", readlink: rl("/opt/node/bin/node") })).toBe("/opt/node/bin/node");
    expect(executableIdentity(42, { platform: "linux", readlink: rl("/opt/node/bin/node (deleted)") })).toBe("/opt/node/bin/node");
  });
  it("Linux, unreadable (another user's process, gone): undefined (the caller falls back to comm)", () => {
    expect(executableIdentity(42, { platform: "linux", readlink: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } })).toBeUndefined();
  });
  it("macOS: undefined, and /proc is never read (ps's comm IS the executable path there)", () => {
    let calls = 0;
    expect(executableIdentity(42, { platform: "darwin", readlink: () => (calls++, "/x") })).toBeUndefined();
    expect(calls).toBe(0);
  });
  it("the runtime THREAD names measured on Linux Node 24 are recognized; an executable name is not", () => {
    for (const n of ["MainThread", "DelayedTaskSche", "V8Worker", "SignalInspector"]) expect(isRuntimeThreadName(n), n).toBe(true);
    for (const n of ["node", "/usr/bin/node", "claude", "codex", "bash"]) expect(isRuntimeThreadName(n), n).toBe(false);
  });
});

describe("consumer 2: the process table carries the exe; findAgentProcess and classifyProcess judge exe ?? comm", () => {
  const SELF = 300;
  const psRun = (rows: string[], comms: Record<number, string>) => (_cmd: string, args: string[]) =>
    args.includes("pid=,comm=") ? Object.entries(comms).map(([p, c]) => `${p} ${c}`).join("\n") : rows.join("\n");
  it("buildProcessTable sets exe for EVERY row on Linux (comm is the field we distrust)", () => {
    const rows = [`100 1 ${START} /opt/node/bin/node /usr/local/bin/codex`, `200 100 ${START} bash`, `${SELF} 200 ${START} node /r/dist/index.js`];
    const exes: Record<number, string> = { 100: "/opt/node/bin/node", 200: "/usr/bin/bash", [SELF]: "/opt/node/bin/node" };
    const t = buildProcessTable(psRun(rows, { 100: "MainThread", 200: "bash", [SELF]: "MainThread" }) as never, { platform: "linux", readlink: (p: string) => exes[Number(p.split("/")[2])] ?? (() => { throw new Error("ENOENT"); })() });
    expect([...t.values()].map((e) => [e.pid, e.comm, e.exe])).toEqual([
      [100, "MainThread", "/opt/node/bin/node"],
      [200, "bash", "/usr/bin/bash"],
      [SELF, "MainThread", "/opt/node/bin/node"],
    ]);
  });
  it("findAgentProcess: a node-hosted codex whose comm reads MainThread is FOUND (by its exe), with its profile", () => {
    const table = new Map([
      [100, { pid: 100, ppid: 1, startedAt: START, command: "/opt/node/bin/node /usr/local/bin/codex", comm: "MainThread", exe: "/opt/node/bin/node" }],
      [SELF, { pid: SELF, ppid: 100, startedAt: START, command: "node /r/dist/index.js", comm: "MainThread", exe: "/opt/node/bin/node" }],
    ]);
    expect(findAgentProcess(SELF, table as never)).toEqual({ pid: 100, startedAt: START, profile: "codex" });
  });
  it("findAgentProcess, exe UNREADABLE and comm MainThread: NOT an agent (the safe side for detection)", () => {
    const table = new Map([
      [100, { pid: 100, ppid: 1, startedAt: START, command: "MainThread-garbled", comm: "MainThread" }],
      [SELF, { pid: SELF, ppid: 100, startedAt: START, command: "node /r/dist/index.js", comm: "MainThread" }],
    ]);
    expect(findAgentProcess(SELF, table as never)).toBeNull();
  });
  const view = (over: Record<string, unknown>) => ({ pid: 77, ppid: 1, start: START, command: "node /nowhere/dist/index.js", cwd: null, argv: ["node", "/nowhere/dist/index.js"], ...over });
  const noFs = { isFile: () => false, realpath: () => null, packageName: () => null } as never;
  it("classifyProcess: comm MainThread + exe node → judged AS NODE (never \"not a node process\")", () => {
    const c = classifyProcess(view({ comm: "MainThread", exe: "/opt/node/bin/node" }) as never, new Set(), noFs);
    expect(c.kind === "not-relay" ? c.why : "", "judged as node: past the executable check").not.toMatch(/not a node process/);
  });
  it("classifyProcess: exe UNREADABLE + comm a runtime THREAD name → UNKNOWN, NEVER not-relay (a live old relay must never read \"not a relay\")", () => {
    const c = classifyProcess(view({ comm: "MainThread" }) as never, new Set(), noFs);
    expect(c.kind).toBe("unknown");
  });
  it("CONTROL: exe unreadable + comm a non-node executable (python3) → not-relay, not a node process", () => {
    const c = classifyProcess(view({ comm: "python3", command: "python3 x.py", argv: ["python3", "x.py"] }) as never, new Set(), noFs);
    expect([c.kind, c.why]).toEqual(["not-relay", "not a node process"]);
  });
});

describe("consumer 3: 8b's two judges (ruling adf82e6b): exe = the CLI, or exe = a runtime the REGISTRY lists as a host of that CLI", () => {
  it("native agree: command codex, exe codex → codex", () => {
    expect(agreedProfileOf("/usr/local/bin/codex --flag", "/usr/local/bin/codex")).toBe("codex");
  });
  it("native agree from the npx VENDOR directory (…/vendor/<triple>/bin/codex): judged by BASENAME, never rejected for its unusual directory", () => {
    const vendored = "/home/u/.npm/_npx/0a1b2c/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex";
    expect(agreedProfileOf(`${vendored} --flag`, vendored)).toBe("codex");
    const table = new Map([
      [100, { pid: 100, ppid: 1, startedAt: START, command: `${vendored} --flag`, comm: "codex", exe: vendored }],
      [300, { pid: 300, ppid: 100, startedAt: START, command: "node /r/dist/index.js", comm: "MainThread", exe: "/opt/node/bin/node" }],
    ]);
    expect(findAgentProcess(300, table as never)).toEqual({ pid: 100, startedAt: START, profile: "codex" });
  });
  it("runtime-hosted agree: node running claude (node is a registered host of claude) → claude; node running codex → codex", () => {
    expect(agreedProfileOf("node /usr/local/bin/claude", "/opt/node/bin/node")).toBe("claude");
    expect(agreedProfileOf("node /usr/local/bin/codex", "/opt/node/bin/node")).toBe("codex");
  });
  it("mismatch → NULL: exe names another CLI; a runtime the registry does NOT list as a host of that CLI (deno running codex)", () => {
    expect(agreedProfileOf("/usr/local/bin/codex", "/usr/local/bin/claude")).toBeNull();
    expect(agreedProfileOf("deno /usr/local/bin/codex", "/usr/bin/deno")).toBeNull();
  });
  it("the Linux Node 24 case no longer forces NULL: the judge is the EXE (MainThread is only the fallback when the exe is unreadable, and then NULL)", () => {
    expect(agreedProfileOf("node /usr/local/bin/codex", "/opt/node/bin/node")).toBe("codex");
    expect(agreedProfileOf("node /usr/local/bin/codex", "MainThread")).toBeNull();
  });
  it("executableJudgeOf (Linux): the exe, BRACKETED by the instance's start; the start changes across the read → null; exe unreadable → the comm read (same start)", async () => {
    const run = (startNow: string, comm = "MainThread") => async (args: string[]) =>
      args.includes("pid=,lstart=,comm=") ? `4242 ${startNow} ${comm}` : `4242 ${startNow}`;
    const rl = (p: string) => (p === "/proc/4242/exe" ? "/opt/node/bin/node" : (() => { throw new Error("ENOENT"); })());
    expect(await executableJudgeOf(run(START), 4242, START, 500, { platform: "linux", readlink: rl })).toBe("/opt/node/bin/node");
    expect(await executableJudgeOf(run("Tue Nov 25 10:00:00 2026"), 4242, START, 500, { platform: "linux", readlink: rl }), "another instance now").toBeNull();
    expect(await executableJudgeOf(run(START), 4242, START, 500, { platform: "linux", readlink: () => { throw new Error("EACCES"); } }), "fallback").toBe("MainThread");
    expect(await executableJudgeOf(run(START, "/usr/local/bin/codex"), 4242, START, 500, { platform: "darwin", readlink: rl }), "macOS: comm").toBe("/usr/local/bin/codex");
  });
});

describe("consumer 1: the hooks' relay_agent_pid (real processes)", () => {
  it.skipIf(process.platform === "win32")("relay_agent_pid, run from a bash child of a node parent, finds that node parent (Linux Node 24: by its exe, comm reads MainThread)", () => {
    const helper = path.join(REPO, "hooks", "_vault-helpers.sh");
    const out = execFileSync(process.execPath, ["-e", `process.stdout.write(require("child_process").execFileSync("bash", ["-c", '. "$1"; printf "%s|%s" "$(relay_agent_pid)" "$PPID"', "walk", ${JSON.stringify(helper)}], { encoding: "utf8" }))`], { encoding: "utf8" });
    const [found, parent] = out.split("|");
    expect(found, `relay_agent_pid answered [${found}] for node parent ${parent}`).toBe(parent);
  });
  /** relay_agent_pid from the budget-SEAMED helpers (a budgetTree copy), run from a bash child of a node parent. */
  function seamedWalk(env: Record<string, string>): { out: string; status: number | null; signal: string | null } {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "exe-walk-"));
    try {
      const hooks = budgetTree(path.join(tree, "t"), path.join(REPO, "hooks"), path.join(REPO, "bin"));
      const helper = path.join(hooks, "_vault-helpers.sh");
      const r = spawnSync(process.execPath, ["-e", `process.stdout.write(require("child_process").execFileSync("bash", ["-c", '. "$1"; printf "%s|%s" "$(relay_agent_pid)" "$PPID"', "walk", ${JSON.stringify(helper)}], { encoding: "utf8", env: process.env }))`], { encoding: "utf8", env: { ...process.env, RELAY_TEST_CLOCK: "0", ...env }, timeout: 20_000 });
      return { out: r.stdout ?? "", status: r.status, signal: r.signal };
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  }
  it.skipIf(process.platform === "win32")("Codex #470 R1: a STALLED readlink (a PATH wrapper) never blocks the walk past its budget", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "stall-readlink-"));
    try {
      fs.writeFileSync(path.join(bin, "readlink"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
      const t0 = Date.now();
      const r = seamedWalk({ PATH: `${bin}:${process.env.PATH ?? ""}` });
      expect(r.signal, "the walk finished on its own (the harness did not have to kill it)").toBeNull();
      expect(Date.now() - t0, "a hang guard only: well under the stalled readlink's 30 s").toBeLessThan(15_000);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }, 30_000);
  it.skipIf(process.platform === "win32")("Codex #470 R1: the budget EXPIRES mid-walk (after the agent's comm matched) → NO pid, never one whose command line was not read", () => {
    const count = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "starve-count-")), "n");
    // Lookups 1-2 run (this shell's ppid, then the node parent's comm, which matches); every later lookup is starved.
    const r = seamedWalk({ RELAY_TEST_STARVE: "a process lookup*", RELAY_TEST_STARVE_AFTER: "2", RELAY_TEST_STARVE_COUNT: count });
    const [found] = r.out.split("|");
    expect(r.status, r.out).toBe(0);
    expect(Number(fs.readFileSync(count, "utf-8").trim()), "precondition: the walk reached a starved lookup").toBeGreaterThan(2);
    expect(found, "a cut walk returns no pid").toBe("");
  });
  /**
   * relay_run_streamed's deadline (ruling 231a8b8f): the budgeted step runs as its own PROCESS-GROUP leader, and the
   * GROUP is killed at the deadline and right after the step exits, so a forking wrapper's children cannot hold the
   * command substitution's pipe past the budget. Each row: `$(relay_run_streamed 1 <wrapper>)` from the real helpers.
   */
  function streamedRun(wrapperBody: string, env: Record<string, string> = {}): { ms: number; signal: string | null; out: string; err: string } {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "streamed-"));
    try {
      fs.writeFileSync(path.join(bin, "fakecmd"), `#!/bin/sh\n${wrapperBody}\n`, { mode: 0o755 });
      const helper = path.join(REPO, "hooks", "_vault-helpers.sh");
      const t0 = Date.now();
      const r = spawnSync("/bin/bash", ["-c", '. "$1"; out=$(relay_run_streamed 1 fakecmd); printf "rc=%s out=%s" "$?" "$out"', "run", helper], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, ...env }, timeout: 25_000 });
      return { ms: Date.now() - t0, signal: r.signal, out: r.stdout ?? "", err: r.stderr ?? "" };
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }
  it.skipIf(process.platform === "win32")("ruling 231a8b8f (1): a FORKING wrapper (its child holds the pipe) → the 1 s deadline holds", () => {
    const r = streamedRun("sleep 30 &\nwait");
    expect(r.signal, "finished on its own").toBeNull();
    expect(r.out).toMatch(/^rc=124 /);
    expect(r.ms, "a hang guard only: well under the wrapper's 30 s").toBeLessThan(10_000);
  }, 30_000);
  it.skipIf(process.platform === "win32")("ruling 231a8b8f (2): a wrapper that BACKGROUNDS a sleeper and EXITS → no hang (the finished step's strays are killed)", () => {
    const r = streamedRun("sleep 30 &\necho done\nexit 0");
    expect(r.signal, "finished on its own").toBeNull();
    expect(r.out).toBe("rc=0 out=done");
    expect(r.ms, "a hang guard only").toBeLessThan(10_000);
  }, 30_000);
  it.skipIf(process.platform === "win32")("ruling 231a8b8f (3): perl ABSENT → ONE loud line, and the old direct-child bound is kept (a non-forking stall is still cut)", () => {
    // A PATH holding only what the helper and the row need, without perl.
    const tools = fs.mkdtempSync(path.join(os.tmpdir(), "noperl-"));
    try {
      for (const t of ["sh", "sleep", "cat", "grep", "sed", "tr", "uname", "head", "date"]) {
        const real = spawnSync("/bin/sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
        if (real) fs.symlinkSync(real, path.join(tools, t));
      }
      const r2 = (() => {
        const bin = fs.mkdtempSync(path.join(os.tmpdir(), "streamed-np-"));
        fs.writeFileSync(path.join(bin, "fakecmd"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
        const t0 = Date.now();
        const x = spawnSync("/bin/bash", ["-c", '. "$1"; out=$(relay_run_streamed 1 fakecmd); printf "rc=%s" "$?"', "run", path.join(REPO, "hooks", "_vault-helpers.sh")], { encoding: "utf8", env: { HOME: process.env.HOME ?? "", PATH: `${bin}:${tools}` }, timeout: 25_000 });
        fs.rmSync(bin, { recursive: true, force: true });
        return { ms: Date.now() - t0, signal: x.signal, out: x.stdout ?? "", err: x.stderr ?? "" };
      })();
      expect(r2.signal).toBeNull();
      expect(r2.out).toBe("rc=124");
      expect(r2.ms).toBeLessThan(10_000);
      expect(r2.err.split("\n").filter((l) => /step budget covers the direct child only: perl not found/.test(l)), "ONE loud line").toHaveLength(1);
    } finally {
      fs.rmSync(tools, { recursive: true, force: true });
    }
  }, 30_000);
  it.skipIf(process.platform !== "linux")("MEASURED, report only (ruling Q2): the cost of reading /proc/<pid>/exe for EVERY row of a real process table", () => {
    const t0 = performance.now();
    const table = buildProcessTable();
    const ms = performance.now() - t0;
    const withExe = [...table.values()].filter((e) => e.exe).length;
    const t1 = performance.now();
    for (const e of table.values()) executableIdentity(e.pid);
    const exeOnly = performance.now() - t1;
    console.log(`[exe cost] ${table.size} rows, ${withExe} with a readable exe; whole table ${ms.toFixed(1)} ms; the exe reads alone ${exeOnly.toFixed(1)} ms`);
    expect(withExe).toBeGreaterThan(0);
    expect(fs.existsSync("/proc/self/exe")).toBe(true);
  });
});
