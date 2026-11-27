// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * stopAndRemove (tests/_helpers/stop-and-remove.ts): a spawned child that is still WRITING into its directory while it
 * shuts down (the daemon writes its owner endpoint record and SQLite's side files there) must have EXITED before the
 * directory is removed; otherwise the removal races the child (ENOTEMPTY, or the directory comes back). The stub child
 * below makes that deterministic: on SIGTERM it writes into the directory (recreating it) six times, then writes a
 * DONE marker OUTSIDE the directory and exits; the rows wait for that confirmed completion, never for elapsed time.
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { stopAndRemove } from "./_helpers/stop-and-remove.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "stop-and-remove-"));
const WIN = process.platform === "win32"; // a POSIX signal handler in the child: SIGTERM on Windows just terminates

/** Resolves when `cond()` holds; REJECTS past `ms` (a deadline, never a pass). */
async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// No stub may outlive its row, whatever the helper under test did: SIGKILL, then AWAIT its exit (bounded), so none can
// race the next row or afterAll's removal of ROOT.
const spawned: ChildProcess[] = [];
afterEach(async () => {
  for (const c of spawned.splice(0)) {
    if (c.exitCode !== null || c.signalCode !== null) continue;
    const exited = new Promise<void>((res) => c.once("exit", () => res()));
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    await Promise.race([exited, new Promise((res) => setTimeout(res, 5_000))]);
  }
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** A child that, on SIGTERM, writes into `dir` (recreating it) six times, then writes `<dir>.done` and exits. */
function writerOnTerm(dir: string, opts: { ignoreTerm?: boolean } = {}) {
  const src = opts.ignoreTerm
    ? `process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);`
    : `const fs = require("fs"), path = require("path"); const dir = ${JSON.stringify(dir)};
       process.on("SIGTERM", () => {
         let n = 0;
         const t = setInterval(() => {
           fs.mkdirSync(dir, { recursive: true });
           fs.writeFileSync(path.join(dir, "late-" + (n++) + ".tmp"), "x");
           if (n >= 6) { clearInterval(t); fs.writeFileSync(dir + ".done", "done"); process.exit(0); }
         }, 50);
       });
       console.log("ready"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", src], { stdio: ["ignore", "pipe", "inherit"] });
  spawned.push(child);
  const ready = new Promise<void>((res) => child.stdout!.once("data", () => res()));
  return { child, ready };
}

describe.skipIf(WIN)("stopAndRemove: the child has EXITED before its directory is removed", () => {
  it("a child that writes into the dir WHILE it shuts down → once its writes are CONFIRMED done, the dir is GONE", async () => {
    const dir = path.join(ROOT, "writer");
    fs.mkdirSync(dir);
    const w = writerOnTerm(dir);
    await w.ready;
    await stopAndRemove(w.child, dir);
    // CONFIRMED completion (the marker the stub writes after its last write, and its exit), with a rejecting deadline.
    await until(() => fs.existsSync(`${dir}.done`) && (w.child.exitCode !== null || w.child.signalCode !== null), 10_000, "the stub's last write");
    expect(fs.existsSync(dir), `the directory came back: ${fs.existsSync(dir) ? fs.readdirSync(dir).join(",") : ""}`).toBe(false);
  }, 20_000);

  it("a child that IGNORES SIGTERM is killed after the grace (SIGKILL), then the dir is removed", async () => {
    const dir = path.join(ROOT, "stubborn");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "f"), "x");
    const w = writerOnTerm(dir, { ignoreTerm: true });
    await w.ready;
    const t0 = Date.now();
    await stopAndRemove(w.child, dir, { graceMs: 300 });
    expect(w.child.signalCode, "killed by SIGKILL after the grace").toBe("SIGKILL");
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(fs.existsSync(dir)).toBe(false);
  }, 15_000);

  it("SEVERAL children writing into one dir (a daemon and its writer) → ALL have EXITED before the dir is removed; a null entry is skipped", async () => {
    const dir = path.join(ROOT, "two-writers");
    fs.mkdirSync(dir);
    const a = writerOnTerm(dir);
    const b = writerOnTerm(dir);
    await Promise.all([a.ready, b.ready]);
    await stopAndRemove([a.child, null, b.child], dir);
    for (const w of [a, b]) expect(w.child.exitCode !== null || w.child.signalCode !== null, `child ${w.child.pid} exited before the removal`).toBe(true);
    expect(fs.existsSync(dir), `the directory came back: ${fs.existsSync(dir) ? fs.readdirSync(dir).join(",") : ""}`).toBe(false);
  }, 20_000);

  it("a child that has ALREADY exited → no wait, the dir is removed", async () => {
    const dir = path.join(ROOT, "gone");
    fs.mkdirSync(dir);
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    spawned.push(child);
    await new Promise((res) => child.once("exit", res));
    await stopAndRemove(child, dir);
    expect(fs.existsSync(dir)).toBe(false);
  }, 15_000);
});

describe("stopAndRemove: every wait is bounded (every OS)", () => {
  it("a child that is STILL alive after SIGKILL and its bound → REJECTS within the bounds, and the dir is NOT removed", async () => {
    const dir = path.join(ROOT, "unreapable");
    fs.mkdirSync(dir);
    // A child whose exit never arrives (a stalled reap): it takes both signals and never emits "exit".
    const signals: string[] = [];
    const fake = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, kill: (s: string) => (signals.push(s), true) }) as unknown as ChildProcess;
    const t0 = Date.now();
    await expect(stopAndRemove(fake, dir, { graceMs: 100, killGraceMs: 100 })).rejects.toThrow(/still alive after SIGKILL; its directory was NOT removed/);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(fs.existsSync(dir), "the directory stays: never removed under a live writer").toBe(true);
  }, 10_000);
});
