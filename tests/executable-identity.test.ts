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
  function seamedWalk(env: Record<string, string>, opts: { edit?: (src: string) => string; script?: string } = {}): { out: string; err: string; status: number | null; signal: string | null } {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "exe-walk-"));
    try {
      const hooks = budgetTree(path.join(tree, "t"), path.join(REPO, "hooks"), path.join(REPO, "bin"));
      const helper = path.join(hooks, "_vault-helpers.sh");
      if (opts.edit) fs.writeFileSync(helper, opts.edit(fs.readFileSync(helper, "utf-8")));
      const script = opts.script ?? '. "$1"; printf "%s|%s" "$(relay_agent_pid)" "$PPID"';
      // The bash child's stderr is passed through to the node parent's stderr, which this spawn captures.
      const r = spawnSync(process.execPath, ["-e", `process.stdout.write(require("child_process").execFileSync("bash", ["-c", ${JSON.stringify(script)}, "walk", ${JSON.stringify(helper)}], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "inherit"] }))`], { encoding: "utf8", env: { ...process.env, RELAY_TEST_CLOCK: "0", ...env }, timeout: 20_000 });
      return { out: r.stdout ?? "", err: r.stderr ?? "", status: r.status, signal: r.signal };
    } finally {
      fs.rmSync(tree, { recursive: true, force: true });
    }
  }
  /** PATH wrappers for ps, readlink and env that COUNT their calls and then stall (a hostile or broken PATH). */
  function stallingWrappers(): { bin: string; count: () => number } {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "stall-wrappers-"));
    const log = path.join(bin, "calls");
    for (const t of ["ps", "readlink", "env"]) fs.writeFileSync(path.join(bin, t), `#!/bin/sh\necho ${t} >> "${log}"\nsleep 30\n`, { mode: 0o755 });
    return { bin, count: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf-8").split("\n").filter(Boolean).length : 0) };
  }
  it.skipIf(process.platform === "win32")("ruling 40431fc6 (3): STALLED PATH wrappers for ps/readlink/env are NEVER invoked by the walk or the start-time read (the fixed system binaries are), and the walk COMPLETES", () => {
    const w = stallingWrappers();
    try {
      const t0 = Date.now();
      const r = seamedWalk({ PATH: `${w.bin}:${process.env.PATH ?? ""}` }, { script: '. "$1"; a=$(relay_agent_pid); printf "%s|%s|%s" "$a" "$PPID" "$(relay_pid_start "$PPID")"' });
      expect(r.signal, `the walk finished on its own: ${r.err}`).toBeNull();
      expect(Date.now() - t0, "a hang guard only").toBeLessThan(15_000);
      expect(w.count(), "no PATH wrapper was ever invoked").toBe(0);
      const [found, parent, start] = r.out.split("|");
      expect(found, `the walk completed and found its node parent: ${r.err}`).toBe(parent);
      expect(start, "the start-time read completed through the system ps").toMatch(/ UTC$/);
    } finally {
      fs.rmSync(w.bin, { recursive: true, force: true });
    }
  }, 30_000);
  it.skipIf(process.platform === "win32")("ruling e1998638 (2): on the REAL system ps the walk asks the budget per lookup and stops, NAMED, when it runs out (no PATH wrapper is ever run)", () => {
    const w = stallingWrappers();
    const count = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "starve-sys-")), "n");
    try {
      // The first lookup (this shell's ppid) runs; the second is refused by the budget seam.
      const r = seamedWalk({ PATH: `${w.bin}:${process.env.PATH ?? ""}`, RELAY_TEST_STARVE: "a process lookup*", RELAY_TEST_STARVE_AFTER: "1", RELAY_TEST_STARVE_COUNT: count });
      expect(r.status, r.err).toBe(0);
      expect(w.count(), "the system ps was used: no PATH wrapper ran").toBe(0);
      expect(Number(fs.readFileSync(count, "utf-8").trim()), "the walk asked the budget again after its first lookup").toBeGreaterThanOrEqual(2);
      expect(r.out.split("|")[0], "a cut walk returns no pid").toBe("");
      expect(r.err, "the cut is NAMED").toMatch(/no time budget left for a process lookup/);
    } finally {
      fs.rmSync(w.bin, { recursive: true, force: true });
    }
  }, 30_000);
  it.skipIf(process.platform === "win32")("ruling e1998638 (3): THE SEAM can only narrow: a fixed list naming a USER-OWNED ps is rejected by the same check → the fallback (supervised + the line); that ps never runs unsupervised", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "seam-user-ps-"));
    try {
      const log = path.join(bin, "pgids");
      const wrapper = path.join(bin, "ps");
      fs.writeFileSync(wrapper, `#!/bin/sh\n/bin/ps -o pgid= -p $$ | tr -d ' ' >> "${log}"\nexec /bin/ps "$@"\n`, { mode: 0o755 });
      const r = seamedWalk({ PATH: `${bin}:${process.env.PATH ?? ""}` }, {
        edit: (src) => {
          expect(src, "precondition: the fixed system-binary list").toMatch(/RELAY_SYS_PS_PATHS='[^']*'/);
          return src.replace(/RELAY_SYS_PS_PATHS='[^']*'/, `RELAY_SYS_PS_PATHS='${wrapper}'`);
        },
        script: '. "$1"; a=$(relay_agent_pid); printf "%s|%s|%s|%s" "$a" "$PPID" "$(/bin/ps -o pgid= -p $$ | tr -d " ")" "$RELAY_SYS_PS"',
      });
      const [found, parent, shellPgid, chosen] = r.out.split("|");
      expect(chosen, "the user-owned file was NOT accepted as the system ps").toBe("");
      expect(found, r.err).toBe(parent);
      expect(r.err.split("\n").filter((l) => /relay hook: no system ps qualifies/.test(l)), `ONE loud line: ${r.err}`).toHaveLength(1);
      const pgids = fs.readFileSync(log, "utf-8").split("\n").filter(Boolean);
      expect(pgids.length, "precondition: the wrapper ran (through the fallback)").toBeGreaterThan(0);
      expect(pgids.every((g) => g !== shellPgid), `never unsupervised: ${pgids.join(",")} vs the shell's ${shellPgid}`).toBe(true);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }, 30_000);
  it.skipIf(process.platform === "win32")("ruling 0fceafe7: on Windows (a MINGW uname) the start time is NOT read, said by name, and the anchor check trusts the pid (\"alive\", never \"dead\")", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mingw-uname-"));
    try {
      fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\necho MINGW64_NT-10.0-26100\n", { mode: 0o755 });
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "mingw-home-"));
      const r = spawnSync("bash", ["-c", '. "$1"; s=$(relay_pid_start "$2"); l=$(relay_pid_start_legacy "$2"); v=$(relay_anchor_liveness "$2" "Thu Oct  1 07:37:33 2026 UTC" H H); printf "%s|%s|%s" "$s" "$l" "$v"', "w", path.join(REPO, "hooks", "_vault-helpers.sh"), String(process.pid)], { encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` }, timeout: 20_000 });
      expect(r.stdout, r.stderr).toBe("||alive");
      expect(r.stderr, "the reason is named").toMatch(/the agent's start time is not read on Windows/);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }, 30_000);
  it.skipIf(process.platform === "win32")("ruling 40431fc6 (3): NO qualifying system binary → the PATH binary, SUPERVISED (its own process group), plus ONE loud line", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "nosys-ps-"));
    try {
      const log = path.join(bin, "pgids");
      // The PATH ps records its process group (through the real system ps), then runs the real ps.
      fs.writeFileSync(path.join(bin, "ps"), `#!/bin/sh\n/bin/ps -o pgid= -p $$ | tr -d ' ' >> "${log}"\nexec /bin/ps "$@"\n`, { mode: 0o755 });
      const r = seamedWalk({ PATH: `${bin}:${process.env.PATH ?? ""}` }, {
        edit: (src) => {
          expect(src, "precondition: the fixed system-binary list").toMatch(/RELAY_SYS_PS_PATHS='[^']*'/);
          return src.replace(/RELAY_SYS_PS_PATHS='[^']*'/, "RELAY_SYS_PS_PATHS='/nonexistent/ps'");
        },
        script: '. "$1"; a=$(relay_agent_pid); printf "%s|%s|%s" "$a" "$PPID" "$(/bin/ps -o pgid= -p $$ | tr -d " ")"',
      });
      const [found, parent, shellPgid] = r.out.split("|");
      expect(found, r.err).toBe(parent);
      const pgids = fs.readFileSync(log, "utf-8").split("\n").filter(Boolean);
      expect(pgids.length, "the PATH ps was used").toBeGreaterThan(0);
      expect(pgids.every((g) => g !== shellPgid), `every PATH ps ran in its own group (supervised): ${pgids.join(",")} vs the shell's ${shellPgid}`).toBe(true);
      expect(r.err.split("\n").filter((l) => /relay hook: no system ps qualifies/.test(l)), `ONE loud line: ${r.err}`).toHaveLength(1);
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
