// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The off-CPU wait instrument (tests/_helpers/offcpu-watch.ts), VALIDATED BEFORE IT IS TRUSTED. Planted main-thread
 * waits must be NAMED as predicted (written before the first CI run, in the spec); a CPU-bound loop must read on-CPU
 * and an idle loop must record nothing. The parsers run everywhere (fixture lines); the planted rows need Linux /proc.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { startOffCpuWatch, offCpuLines, parseProcStat, parseProcSyscall, type StallRecord } from "./_helpers/offcpu-watch.js";

const LINUX = process.platform === "linux";
const requireHere = createRequire(import.meta.url);
const ON = { RELAY_TIMING_OFFCPU: "1" } as NodeJS.ProcessEnv;
const syscalls = (rs: StallRecord[]) => rs.flatMap((r) => r.samples.map((s) => s.syscall));
const stalls = (rs: StallRecord[], minMs = 150) => rs.filter((r) => r.durationMs >= minMs);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the parsers (fixture lines; every OS)", () => {
  it("stat: the state letter is the field after the LAST ')' (a command name may hold spaces and parens)", () => {
    expect(parseProcStat("1234 (node) S 1 1234 1234 0 -1")).toBe("S");
    expect(parseProcStat("1234 (a (weird) b) R 1 1234")).toBe("R");
    expect(parseProcStat("garbage")).toBe("?");
  });
  it("syscall: running, blocked outside a syscall, a known number (x64 and arm64), an unknown one, garbage", () => {
    expect(parseProcSyscall("running")).toEqual({ syscall: "running" });
    expect(parseProcSyscall("-1 0x7ffd 0x7f12")).toEqual({ syscall: "none" });
    expect(parseProcSyscall("202 0x7f00 0x80 0x0 0x0 0x0 0x0 0x7ffd 0x7f12", "x64")).toEqual({ syscall: "futex", arg0: 0x7f00 });
    expect(parseProcSyscall("98 0x10 0x80 0x0 0x0 0x0 0x0 0x7ffd 0x7f12", "arm64").syscall).toBe("futex");
    expect(parseProcSyscall("0 0x15 0x0 0x0 0x0 0x0 0x0 0x0 0x0", "x64")).toEqual({ syscall: "read", arg0: 0x15 });
    expect(parseProcSyscall("999 0x0", "x64").syscall).toBe("nr999");
    expect(parseProcSyscall("x y").syscall).toBe("?");
  });
});

describe("gating (every OS)", () => {
  it("INERT without RELAY_TIMING_OFFCPU=1: no watch, no worker, no line", () => {
    const w = startOffCpuWatch({ env: {} });
    expect(w).toBeNull();
    expect(offCpuLines("x", w, [])).toEqual([]);
  });
  it("off Linux: 'not supported', never a silent pass", async () => {
    const w = startOffCpuWatch({ env: ON, platform: "darwin" });
    expect(w?.supported).toBe(false);
    expect(await w!.stop()).toEqual([]);
    expect(offCpuLines("x", w, [])).toEqual(["OFFCPU x | not supported on darwin (Linux /proc only): no reading"]);
  });
});

describe.skipIf(!LINUX)("planted main-thread waits are NAMED as predicted (Linux)", () => {
  it("P1: Atomics.wait 300 ms → futex, state S", async () => {
    const w = startOffCpuWatch({ env: ON })!;
    await wait(50);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    await wait(50);
    const rs = await w.stop();
    console.log(offCpuLines("P1", w, rs).join("\n"));
    expect(stalls(rs).length, JSON.stringify(rs)).toBeGreaterThanOrEqual(1);
    expect(syscalls(stalls(rs))).toContain("futex");
    expect(stalls(rs)[0]!.samples.some((s) => s.state === "S")).toBe(true);
  });
  it("P2: execFileSync sleep 0.3 → epoll_wait/epoll_pwait/epoll_pwait2 (a nested loop), corroborated by a child running `sleep 0.3`", async () => {
    const w = startOffCpuWatch({ env: ON })!;
    await wait(50);
    execFileSync("sleep", ["0.3"]);
    await wait(50);
    const rs = await w.stop();
    console.log(offCpuLines("P2", w, rs).join("\n"));
    const st = stalls(rs);
    expect(st.length, JSON.stringify(rs)).toBeGreaterThanOrEqual(1);
    expect(syscalls(st).some((s) => /^epoll_(wait|pwait2?)$/.test(s)), JSON.stringify(st)).toBe(true);
    expect(st.flatMap((r) => r.samples.flatMap((s) => s.children ?? [])).some((c) => /\bsleep 0\.3\b/.test(c))).toBe(true);
  });
  it("P3: a SQLite busy wait (a child holds BEGIN IMMEDIATE ~400 ms) → clock_nanosleep or nanosleep", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offcpu-busy-"));
    const dbPath = path.join(dir, "busy.db");
    const Database = (await import("better-sqlite3")).default;
    const setup = new Database(dbPath);
    setup.pragma("journal_mode = WAL");
    setup.exec("CREATE TABLE t (x INTEGER)");
    setup.close();
    const holder = spawn(process.execPath, ["-e", `const D=require(${JSON.stringify(requireHere.resolve("better-sqlite3"))});const d=new D(${JSON.stringify(dbPath)});d.exec("BEGIN IMMEDIATE");d.exec("INSERT INTO t VALUES (1)");process.stdout.write("held\\n");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400);d.exec("COMMIT");d.close();`], { stdio: ["ignore", "pipe", "inherit"] });
    // Its exit is captured NOW: it exits while the main thread is blocked, before any later listener could attach.
    const holderExited = new Promise((res) => holder.once("exit", res));
    await new Promise<void>((res) => holder.stdout!.once("data", () => res()));
    const w = startOffCpuWatch({ env: ON })!;
    await wait(30);
    const db = new Database(dbPath, { timeout: 2000 });
    db.prepare("INSERT INTO t VALUES (2)").run(); // waits out the child's write lock in SQLite's busy handler
    db.close();
    await wait(50);
    const rs = await w.stop();
    await holderExited;
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(offCpuLines("P3", w, rs).join("\n"));
    expect(stalls(rs).length, JSON.stringify(rs)).toBeGreaterThanOrEqual(1);
    expect(syscalls(stalls(rs)).some((s) => s === "clock_nanosleep" || s === "nanosleep"), JSON.stringify(rs)).toBe(true);
  });
  it("P4: a FIFO read released by a child after 300 ms → read, and its fd names the FIFO", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offcpu-fifo-"));
    const fifo = path.join(dir, "pipe");
    execFileSync("mkfifo", [fifo]);
    const writer = spawn("sh", ["-c", `exec 3>"${fifo}"; sleep 0.3; echo x >&3`], { stdio: "ignore" });
    const writerExited = new Promise((res) => writer.once("exit", res)); // captured before it can happen
    const fd = fs.openSync(fifo, "r"); // returns once the writer has the FIFO open
    const w = startOffCpuWatch({ env: ON })!;
    await wait(30);
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, null); // blocks until the writer writes, ~300 ms after it opened
    fs.closeSync(fd);
    await wait(50);
    const rs = await w.stop();
    await writerExited;
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(offCpuLines("P4", w, rs).join("\n"));
    const reads = stalls(rs, 100).flatMap((r) => r.samples).filter((s) => s.syscall === "read");
    expect(reads.length, JSON.stringify(rs)).toBeGreaterThanOrEqual(1);
    expect(reads.some((s) => s.fdTarget === fifo), JSON.stringify(reads)).toBe(true);
  });
});

describe.skipIf(!LINUX)("negative controls (Linux)", () => {
  it("N1: a 300 ms CPU-bound loop → a stall IS seen, and it reads ON-CPU (state R, running), never a wait", async () => {
    const w = startOffCpuWatch({ env: ON })!;
    await wait(50);
    const until = performance.now() + 300;
    while (performance.now() < until) {
      /* burn CPU on the main thread */
    }
    await wait(50);
    const rs = await w.stop();
    console.log(offCpuLines("N1", w, rs).join("\n"));
    const samples = stalls(rs).flatMap((r) => r.samples);
    expect(samples.length, JSON.stringify(rs)).toBeGreaterThanOrEqual(1);
    expect(samples.some((s) => s.state === "R"), JSON.stringify(samples)).toBe(true);
    expect(samples.filter((s) => ["futex", "clock_nanosleep", "nanosleep", "read", "epoll_wait", "epoll_pwait", "epoll_pwait2"].includes(s.syscall)), JSON.stringify(samples)).toEqual([]);
  });
  it("N2: idle (no blocking, timers only) → no stall recorded", async () => {
    const w = startOffCpuWatch({ env: ON })!;
    await wait(400);
    const rs = await w.stop();
    expect(stalls(rs), JSON.stringify(rs)).toEqual([]);
  });
});
