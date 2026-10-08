// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The test WINDOW's close() (tests/helpers/watch-window.ts). On main d3ecff4 the top-level afterAll of
 * tests/doorbell-pr7-watch.test.ts threw ENOTEMPTY from fs.rmSync(ROOT) after all 43 tests passed:
 * close() killed each run's node and the window, but NOT the run's subshell, which then wrote its
 * <id>.code into the dir being removed. The property: once close() returns, NOTHING the window started
 * is left to write into its dir, whatever the command's shape. The seam (codeWriteDelayS) holds the
 * subshell's code write back, so a close() that leaves it alive is caught every run, not only when the
 * write lands inside rmSync.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { openWindow } from "./helpers/watch-window.js";

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
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// POSIX only (a bash window and process groups); the Windows CI job does not run this file either.
describe.skipIf(process.platform === "win32")("the test window's close()", () => {
  it("leaves NOTHING behind: no run's subshell writes into the dir after close() returns", async () => {
    const dir = path.join(ROOT, "quiet");
    const w = openWindow(dir, env, { codeWriteDelayS: 1 });
    try {
      const r = w.run("sleep 30");
      await r.pid();
      await w.close();
      const atClose = listing(dir);
      await sleep(1_500); // past the seam's delay: a subshell that outlived close() would write now
      expect(listing(dir)).toEqual(atClose);
      expect(groupAlive(w.pid)).toBe(false);
    } finally {
      await w.close();
    }
  }, 15_000);

  it("a COMPOUND command's grandchild is killed too (`$!` is not the writer): nothing writes after close()", async () => {
    const dir = path.join(ROOT, "compound");
    const late = path.join(dir, "late.txt");
    const w = openWindow(dir, env);
    try {
      const r = w.run(`sh -c ${sq(`sleep 1; echo late > ${sq(late)}`)} && true`);
      await r.pid();
      await w.close();
      await sleep(1_500); // past the grandchild's sleep: if it survived close(), it writes now
      expect(fs.existsSync(late)).toBe(false);
    } finally {
      await w.close();
    }
  }, 15_000);

  it("a group that is not empty within the bound fails close() LOUDLY, naming the group (never a hang)", async () => {
    const dir = path.join(ROOT, "loud");
    const w = openWindow(dir, env, { closeWaitMs: 200, groupAlive: () => true });
    const r = w.run("sleep 30");
    await r.pid();
    await expect(w.close()).rejects.toThrow(new RegExp(`process group ${w.pid} is not empty after 200 ms`));
    // The seam only lied about the probe: the real group was killed before it was asked.
    for (let i = 0; i < 100 && groupAlive(w.pid); i++) await sleep(20);
    expect(groupAlive(w.pid)).toBe(false);
  }, 15_000);

  it("what a TEST already killed (the window itself, a run's launching subshell) does not fail close(); the rest is killed", async () => {
    const dir = path.join(ROOT, "killed");
    const w = openWindow(dir, env);
    try {
      const a = w.run("sleep 30");
      const b = w.run("sleep 30");
      const aPid = await a.pid();
      const bPid = await b.pid();
      const subshell = Number(spawnSync("ps", ["-o", "ppid=", "-p", String(aPid)], { encoding: "utf-8" }).stdout.trim());
      expect(subshell).toBeGreaterThan(1);
      process.kill(subshell, "SIGKILL"); // as the "refused after launch" test kills the watch's launching shell
      process.kill(w.pid, "SIGKILL"); // as the window-gone tests kill the window
      await sleep(100);
      await expect(w.close()).resolves.toBeUndefined();
      for (const p of [aPid, bPid]) expect(() => process.kill(p, 0)).toThrow(); // every orphan was reached
      expect(groupAlive(w.pid)).toBe(false);
    } finally {
      await w.close();
    }
  }, 15_000);
});
