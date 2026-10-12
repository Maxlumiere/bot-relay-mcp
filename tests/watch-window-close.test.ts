// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The test WINDOW's close() (tests/helpers/watch-window.ts). On main d3ecff4 the top-level afterAll of
 * tests/doorbell-pr7-watch.test.ts threw ENOTEMPTY from fs.rmSync(ROOT) after all 43 tests passed: close()
 * killed each run's node and the window, but NOT the run's subshell, which then wrote its <id>.code into the
 * dir being removed. The contract now (architect ruling 43899b6d): once close() returns, nothing in the
 * window's process group is left; an ESCAPE from the group is detected and fails close(); and nothing is ever
 * signalled unless the group's owner (the supervisor) is verified. Every test's cleanup is in `finally` and
 * independent of the close() under test (it kills only a group whose verified leader still lives).
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { openWindow, findEscapes, selfAndAncestors, snapshotProcessEnv } from "./helpers/watch-window.js";
import { isPidAlive, processStartedAt } from "../src/liveness.js";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "watch-window-close-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const env = { PATH: process.env.PATH ?? "" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listing = (dir: string) => fs.readdirSync(dir).sort();
const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};
const until = async (cond: () => boolean, ms = 5_000) => {
  for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await sleep(20);
  return cond();
};
const ppidOf = (pid: number) => Number(spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf-8" }).stdout.trim());

/** Independent cleanup: kill the window's group ONLY while its leader is the very process it was (never a reused id). */
function cleanup(w: { leaderPid: number }, leaderStart: string | null, extra: number[] = []): void {
  if (leaderStart !== null && isPidAlive(w.leaderPid) && processStartedAt(w.leaderPid) === leaderStart) {
    try {
      process.kill(-w.leaderPid, "SIGKILL");
    } catch {
      /* already empty */
    }
  }
  for (const p of extra) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

// POSIX only (a bash window and process groups); the Windows CI job does not run this file either.
describe.skipIf(process.platform === "win32")("the test window's close()", () => {
  it("openWindow returns only once the SUPERVISOR acknowledged the window: w.pid is a live bash whose parent is the group's leader", () => {
    const w = openWindow(path.join(ROOT, "ack"), env);
    const leaderStart = processStartedAt(w.leaderPid);
    try {
      expect(isPidAlive(w.pid) && ppidOf(w.pid) === w.leaderPid).toBe(true); // PRIMARY
    } finally {
      cleanup(w, leaderStart);
    }
  });

  // Linux's /bin/sh is dash, which gives a background command /dev/null as stdin before its own redirections
  // (CI cf4d6f6: every window read EOF and exited). macOS ships /bin/dash, so this pins it on both.
  it.skipIf(!fs.existsSync("/bin/dash"))("the window RUNS COMMANDS under dash (Linux's /bin/sh) as the supervisor's shell", async () => {
    const w = openWindow(path.join(ROOT, "dash"), env, { supervisorShell: "/bin/dash" });
    const leaderStart = processStartedAt(w.leaderPid);
    try {
      const r = w.runSleep(0);
      expect(await Promise.race([r.exited, sleep(5_000).then(() => "timeout")])).toBe(0); // PRIMARY
      expect(isPidAlive(w.pid)).toBe(true);
    } finally {
      cleanup(w, leaderStart);
    }
  }, 15_000);

  it("leaves NOTHING behind: no run's subshell writes into the dir after close() returns", async () => {
    const dir = path.join(ROOT, "quiet");
    const w = openWindow(dir, env, { codeWriteDelayS: 1 });
    const leaderStart = processStartedAt(w.leaderPid);
    try {
      await w.runSleep(30).pid();
      await w.close();
      const atClose = listing(dir);
      await sleep(1_500); // past the seam's delay: a subshell that outlived close() would write now
      expect(listing(dir)).toEqual(atClose); // PRIMARY
    } finally {
      cleanup(w, leaderStart);
    }
  }, 15_000);

  it("a COMPOUND command's grandchild writer (readiness proven, released AFTER close) never writes", async () => {
    const dir = path.join(ROOT, "compound");
    const f = { ready: path.join(dir, "ready"), release: path.join(dir, "release"), late: path.join(dir, "late") };
    const w = openWindow(dir, env);
    const leaderStart = processStartedAt(w.leaderPid);
    try {
      w.fixtures.compoundWriter(f);
      expect(await until(() => fs.existsSync(f.ready))).toBe(true); // the WRITER itself runs (not just its wrapper)
      await w.close();
      fs.writeFileSync(f.release, "");
      await sleep(1_000); // a surviving writer polls every 50 ms: it would write now
      expect(fs.existsSync(f.late)).toBe(false); // PRIMARY
    } finally {
      fs.writeFileSync(f.release, "");
      cleanup(w, leaderStart);
    }
  }, 15_000);

  // The environment marker is readable on Linux (/proc/<pid>/environ). MEASURED 8 Oct 2026 on macOS (Darwin
  // 27): neither `ps -E`/`eww` nor sysctl KERN_PROCARGS2 shows another process's environment, so there it
  // is UNREADABLE (never a hit) and the sweep cannot see an escape. CI's Linux job runs this.
  it.skipIf(process.platform !== "linux")("an ESCAPE (a grandchild that leaves the group: setsid) is DETECTED: close() fails naming it, and kills it", async () => {
    const dir = path.join(ROOT, "escape");
    const f = { ready: path.join(dir, "ready"), release: path.join(dir, "release"), late: path.join(dir, "late"), pidFile: path.join(dir, "escaped.pid") };
    const w = openWindow(dir, env);
    const leaderStart = processStartedAt(w.leaderPid);
    let escaped = 0;
    try {
      w.fixtures.detachedWriter(f);
      expect(await until(() => fs.existsSync(f.ready) && /^\d+$/.test(fs.readFileSync(f.pidFile, "utf-8").trim()))).toBe(true);
      escaped = Number(fs.readFileSync(f.pidFile, "utf-8").trim());
      await expect(w.close()).rejects.toThrow(new RegExp(`escaped the window's process group: pid ${escaped}\\b`)); // PRIMARY
      expect(await until(() => !isPidAlive(escaped), 2_000)).toBe(true); // ...and it was killed
    } finally {
      fs.writeFileSync(f.release, "");
      cleanup(w, leaderStart, escaped ? [escaped] : []);
    }
  }, 15_000);

  it("a group that is not empty within the bound fails close() LOUDLY, naming the group, well inside vitest's 10 s hook timeout", async () => {
    const dir = path.join(ROOT, "loud");
    const w = openWindow(dir, env, { closeWaitMs: 200, groupAlive: () => true });
    const leaderStart = processStartedAt(w.leaderPid);
    try {
      await w.runSleep(30).pid();
      const t0 = Date.now();
      await expect(w.close()).rejects.toThrow(new RegExp(`process group ${w.leaderPid} is not empty after 200 ms`)); // PRIMARY
      expect(Date.now() - t0).toBeLessThan(3_000);
    } finally {
      cleanup(w, leaderStart);
    }
  }, 15_000);

  it("ONE shutdown: concurrent calls share it, and a call after a REJECTION rejects the same way (never a false success)", async () => {
    const dir = path.join(ROOT, "once");
    const w = openWindow(dir, env, { closeWaitMs: 200, groupAlive: () => true });
    const leaderStart = processStartedAt(w.leaderPid);
    try {
      const a = w.close();
      const b = w.close();
      expect(b).toBe(a); // PRIMARY (concurrent)
      await expect(a).rejects.toThrow(/is not empty/);
      await expect(w.close()).rejects.toThrow(/is not empty/); // PRIMARY (after the rejection)
    } finally {
      cleanup(w, leaderStart);
    }
  }, 15_000);

  it("OWNERSHIP: the window (bash) killed by the test, close() later → the supervisor is verified and the whole group goes", async () => {
    const dir = path.join(ROOT, "owner-ok");
    const w = openWindow(dir, env);
    const leaderStart = processStartedAt(w.leaderPid);
    try {
      const a = await w.runSleep(30).pid();
      process.kill(w.pid, "SIGKILL"); // as the window-gone tests do
      await sleep(300);
      await w.close();
      expect([isPidAlive(a), isPidAlive(w.leaderPid), groupAlive(w.leaderPid)]).toEqual([false, false, false]); // PRIMARY
    } finally {
      cleanup(w, leaderStart);
    }
  }, 15_000);

  it("OWNERSHIP: an UNREADABLE supervisor start → close() fails 'cannot verify the window's owner' and signals NOTHING", async () => {
    const dir = path.join(ROOT, "owner-unreadable");
    let reads = 0;
    const w = openWindow(dir, env, { closeWaitMs: 300, leaderStart: (pid) => (reads++ === 0 ? processStartedAt(pid) : null) });
    const leaderStart = processStartedAt(w.leaderPid);
    let run = 0;
    try {
      run = await w.runSleep(30).pid();
      await expect(w.close()).rejects.toThrow(/cannot verify the window's owner: the start of its supervisor .* is unreadable; nothing is signalled/);
      expect([isPidAlive(run), isPidAlive(w.pid), isPidAlive(w.leaderPid)]).toEqual([true, true, true]); // PRIMARY: nothing signalled
    } finally {
      cleanup(w, leaderStart, run ? [run] : []);
    }
  }, 15_000);

  it("OWNERSHIP: the supervisor GONE → close() fails and signals nothing (no group id it cannot prove)", async () => {
    const dir = path.join(ROOT, "owner-gone");
    const w = openWindow(dir, env);
    let run = 0;
    try {
      run = await w.runSleep(30).pid();
      process.kill(w.leaderPid, "SIGKILL");
      expect(await until(() => !isPidAlive(w.leaderPid))).toBe(true);
      await expect(w.close()).rejects.toThrow(/cannot verify the window's owner: its supervisor \(pid \d+\) is gone; nothing is signalled/);
      expect(isPidAlive(run)).toBe(true); // PRIMARY: nothing signalled
    } finally {
      for (const p of [run, w.pid]) if (p) try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
    }
  }, 15_000);

  it("what a TEST already killed (a run's launching subshell) does not fail close(); every orphan is reached", async () => {
    const dir = path.join(ROOT, "killed");
    const w = openWindow(dir, env);
    const leaderStart = processStartedAt(w.leaderPid);
    try {
      const a = await w.runSleep(30).pid();
      const b = await w.runSleep(30).pid();
      process.kill(ppidOf(a), "SIGKILL"); // as the "refused after launch" test kills the watch's launching shell
      await sleep(100);
      await w.close();
      expect([isPidAlive(a), isPidAlive(b)]).toEqual([false, false]); // PRIMARY
    } finally {
      cleanup(w, leaderStart);
    }
  }, 15_000);

  it("only TYPED commands reach the window: a printed-command lookalike and an empty argument are refused", () => {
    const w = openWindow(path.join(ROOT, "typed"), env);
    const leaderStart = processStartedAt(w.leaderPid);
    try {
      expect(() => w.runPrintedRelayCommand("RELAY_DB_PATH='/x' '/y/relay' watch a --until-wake; rm -rf /")).toThrow(/not a command the relay prints/);
      expect(() => w.runPrintedRelayCommand("echo hi")).toThrow(/not a command the relay prints/);
      expect(() => w.runRelayWatch(["a", ""])).toThrow(/invalid argument/);
      expect(() => w.runSleep(Number.NaN)).toThrow(/invalid seconds/);
    } finally {
      cleanup(w, leaderStart);
    }
  });
});

describe("the escape sweep (pure; the safety conditions)", () => {
  const ID = "0123456789abcdef0123456789abcdef";
  const M = `WATCH_WINDOW_ID=${ID}`;

  it("matches the marker EXACTLY as an environment entry; a substring, another id, argv-like text or an unreadable environment is never a hit", () => {
    const envs: Record<number, string[] | null> = {
      10: ["PATH=/bin", M], // a hit
      11: [`X=${M}`], // the marker inside another value
      12: [`WATCH_WINDOW_ID=${ID}0`], // another id (longer)
      13: ["node", "-e", M], // argv-like text is NOT environment: the reader gives env only; here it is not an entry of the form
      14: null, // unreadable
    };
    const reader = (pid: number) => (pid === 13 ? ["node", "-e"] : (envs[pid] ?? null));
    expect(findEscapes(ID, [10, 11, 12, 13, 14], reader, new Set())).toEqual([10]); // PRIMARY
  });

  it("NEVER selects the runner or any of its ancestors, even when every process carries the marker", () => {
    const r = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf-8" });
    const table = new Map<number, number>();
    for (const l of r.stdout.split("\n")) {
      const f = l.trim().split(/\s+/);
      if (f.length === 2) table.set(Number(f[0]), Number(f[1]));
    }
    const mine = selfAndAncestors(table);
    expect(mine.has(process.pid) && mine.has(process.ppid)).toBe(true);
    const hits = findEscapes(ID, table.keys(), () => [M], mine);
    expect(hits.filter((p) => mine.has(p))).toEqual([]); // PRIMARY
    expect(hits.length).toBeGreaterThan(0); // the reader really claimed everything (not a vacuous pass)
  });

  it("the real environment snapshot never reads the runner as carrying a window's marker", () => {
    const read = snapshotProcessEnv();
    const own = read(process.pid);
    expect(own === null || !own.some((e) => e.startsWith("WATCH_WINDOW_ID="))).toBe(true);
  });
});
