// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * stopAndRemove (tests/_helpers/stop-and-remove.ts): a spawned child that is still WRITING into its directory while it
 * shuts down (the daemon writes its owner endpoint record and SQLite's side files there) must have EXITED before the
 * directory is removed; otherwise the removal races the child (ENOTEMPTY, or the directory comes back). The stub child
 * below makes that deterministic: on SIGTERM it writes into the directory (recreating it) for ~300 ms, then exits.
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { stopAndRemove } from "./_helpers/stop-and-remove.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "stop-and-remove-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const WIN = process.platform === "win32"; // a POSIX signal handler in the child: SIGTERM on Windows just terminates
// No stub may outlive its row, whatever the helper under test did (a broken helper must fail the row, not hang the run).
const spawned: import("node:child_process").ChildProcess[] = [];
afterEach(() => {
  for (const c of spawned.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
});

/** A child that, on SIGTERM, keeps writing into `dir` (recreating it) for ~300 ms and then exits; it prints "ready". */
function writerOnTerm(dir: string, opts: { ignoreTerm?: boolean } = {}) {
  const src = opts.ignoreTerm
    ? `process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);`
    : `const fs = require("fs"), path = require("path"); const dir = ${JSON.stringify(dir)};
       process.on("SIGTERM", () => {
         let n = 0;
         const t = setInterval(() => {
           fs.mkdirSync(dir, { recursive: true });
           fs.writeFileSync(path.join(dir, "late-" + (n++) + ".tmp"), "x");
           if (n >= 6) { clearInterval(t); process.exit(0); }
         }, 50);
       });
       console.log("ready"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", src], { stdio: ["ignore", "pipe", "inherit"] });
  spawned.push(child);
  const ready = new Promise<void>((res) => child.stdout!.once("data", () => res()));
  const exited = new Promise<void>((res) => child.once("exit", () => res()));
  return { child, ready, exited };
}

describe.skipIf(WIN)("stopAndRemove: the child has EXITED before its directory is removed", () => {
  it("a child that writes into the dir WHILE it shuts down → after stopAndRemove the dir is GONE, and stays gone", async () => {
    const dir = path.join(ROOT, "writer");
    fs.mkdirSync(dir);
    const w = writerOnTerm(dir);
    await w.ready;
    await stopAndRemove(w.child, dir);
    await Promise.race([w.exited, new Promise((res) => setTimeout(res, 3000))]); // the child is done writing either way
    expect(fs.existsSync(dir), `the directory came back: ${fs.existsSync(dir) ? fs.readdirSync(dir).join(",") : ""}`).toBe(false);
  }, 15_000);

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
