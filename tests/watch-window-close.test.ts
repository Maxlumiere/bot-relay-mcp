// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The test WINDOW's close() (tests/helpers/watch-window.ts). On main d3ecff4 the top-level afterAll of
 * tests/doorbell-pr7-watch.test.ts threw ENOTEMPTY from fs.rmSync(ROOT) after all 43 tests passed:
 * close() killed each run's node and the window, but NOT the run's subshell, which then wrote its
 * <id>.code into the dir being removed. The property: once close() returns, nothing of the window
 * writes into its dir. The seam (codeWriteDelayS) holds the subshell's code write back, so a close()
 * that does not wait for it is caught every run, not only when the write lands inside rmSync.
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

describe("the test window's close()", () => {
  it("returns only once every run's subshell has finished: NOTHING writes into its dir afterwards", async () => {
    const dir = path.join(ROOT, "quiet");
    const w = openWindow(dir, env, { codeWriteDelayS: 1 });
    const r = w.run("sleep 30");
    await r.pid();
    await w.close();
    const atClose = listing(dir);
    expect(atClose).toContain(`${r.id}.code`); // the subshell finished BEFORE close() returned
    await sleep(1_500); // past the seam's delay: a subshell that outlived close() would write now
    expect(listing(dir)).toEqual(atClose);
  }, 15_000);

  it("a run whose subshell does not finish within the bound fails close() LOUDLY, naming the run (never a hang)", async () => {
    const dir = path.join(ROOT, "loud");
    const w = openWindow(dir, env, { codeWriteDelayS: 2, closeWaitMs: 300 });
    const r = w.run("sleep 30");
    await r.pid();
    await expect(w.close()).rejects.toThrow(new RegExp(`${r.id} never finished \\(no ${r.id}\\.code within 300 ms, its subshell alive\\)`));
    // Self-cleaning: the held-back subshell finishes on its own (its node is already dead).
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, `${r.id}.code`)); i++) await sleep(50);
    expect(fs.existsSync(path.join(dir, `${r.id}.code`))).toBe(true);
  }, 15_000);

  it("a run whose subshell a TEST killed (no writer left; no code file ever) does NOT fail close()", async () => {
    const dir = path.join(ROOT, "killed");
    const w = openWindow(dir, env, { closeWaitMs: 300 });
    const r = w.run("sleep 30");
    const nodePid = await r.pid();
    const subshell = Number(spawnSync("ps", ["-o", "ppid=", "-p", String(nodePid)], { encoding: "utf-8" }).stdout.trim());
    expect(subshell).toBeGreaterThan(1);
    expect(Number(fs.readFileSync(path.join(dir, `${r.id}.spid`), "utf-8").trim())).toBe(subshell); // the recorded pid IS the parent
    process.kill(subshell, "SIGKILL"); // as the "refused after launch" test kills the watch's launching shell
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(subshell, 0);
      } catch {
        break;
      }
      await sleep(20);
    }
    await expect(w.close()).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dir, `${r.id}.code`))).toBe(false); // it never wrote one, and it cannot now
  }, 15_000);
});
