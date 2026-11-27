// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE BUDGETED STEP's PROCESS GROUP (rulings 231a8b8f, e6458926): relay_run_streamed runs each budgeted hook step under
 * a perl SUPERVISOR that leads a new process group, enforces the deadline, and kills the group (never a recycled id),
 * so a forking wrapper's children cannot hold the command substitution's pipe past the budget. Without perl, or where
 * setpgrp cannot make a group (MEASURED per OS: Windows' msys perl), the bound covers the direct child only, said ONCE,
 * loudly. Each row reads the MODE the helpers chose on this machine and asserts that mode's contract.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = path.join(REPO, "hooks", "_vault-helpers.sh");
const BASH = process.platform === "win32" ? "bash" : "/bin/bash";
const LOUD = /relay hook: step budget covers the direct child only: /;

/** A copy of the helpers with `edit` applied (for a seam a row needs: the live hooks are never edited). */
function helperCopy(edit: (src: string) => string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "step-group-helpers-"));
  const p = path.join(dir, "_vault-helpers.sh");
  fs.writeFileSync(p, edit(fs.readFileSync(HELPER, "utf-8")));
  return p;
}
/** `$(relay_run_streamed SECS fakecmd)` with `fakecmd` = a sh wrapper with `body`, from the given helpers. */
function run(body: string, opts: { helper?: string; secs?: number; env?: Record<string, string> } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "step-group-bin-"));
  try {
    fs.writeFileSync(path.join(bin, "fakecmd"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const t0 = Date.now();
    const r = spawnSync(BASH, ["-c", `. "$1"; out=$(relay_run_streamed ${opts.secs ?? 1} fakecmd); printf "rc=%s out=%s mode=%s" "$?" "$out" "\${RELAY_RUN_GROUP:-unset}"`, "run", opts.helper ?? HELPER], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, ...opts.env },
      timeout: 25_000,
    });
    return { ms: Date.now() - t0, signal: r.signal, out: r.stdout ?? "", err: r.stderr ?? "" };
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
}
const modeOf = (out: string) => (out.match(/mode=(\S+)$/) ?? [])[1];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the budgeted step's process group: the deadline holds for a forking wrapper (or the mode says why not, loudly)", () => {
  it("the MODE is decided once per load: macOS and Linux run grouped; elsewhere either grouped or the ONE loud line", () => {
    const r = run("true");
    const mode = modeOf(r.out);
    if (process.platform !== "win32") expect(mode, `stderr: ${r.err}`).toBe("1");
    else expect(mode === "1" || (mode === "0" && LOUD.test(r.err)), `Windows mode ${mode}, stderr: ${r.err}`).toBe(true);
  });
  it("(1) a FORKING wrapper (its child holds the pipe) → the deadline holds (grouped), and its child is gone", () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "step-group-pid-")), "child");
    const r = run(`sleep 30 & echo $! > "${pidFile}"\nwait`);
    if (modeOf(r.out) !== "1") return void expect(r.err).toMatch(LOUD); // the direct-child bound, said loudly
    expect(r.signal, "finished on its own").toBeNull();
    expect(r.out).toMatch(/^rc=124 /);
    expect(r.ms, "a hang guard only: well under the wrapper's 30 s").toBeLessThan(10_000);
    const child = Number(fs.readFileSync(pidFile, "utf-8").trim());
    expect(alive(child), `the wrapper's child ${child} was killed with its group`).toBe(false);
  }, 30_000);
  it("(2) a wrapper that BACKGROUNDS a sleeper and EXITS → no hang (the finished step's strays are killed)", () => {
    const r = run("sleep 30 &\necho done\nexit 0");
    if (modeOf(r.out) !== "1") return void expect(r.err).toMatch(LOUD);
    expect(r.signal, "finished on its own").toBeNull();
    expect(r.out).toMatch(/^rc=0 out=done /);
    expect(r.ms, "a hang guard only").toBeLessThan(10_000);
  }, 30_000);
  it.skipIf(process.platform === "win32")("(3) perl ABSENT → ONE loud line, and the old direct-child bound is kept (a non-forking stall is still cut)", () => {
    const tools = fs.mkdtempSync(path.join(os.tmpdir(), "step-group-noperl-"));
    try {
      for (const t of ["sh", "sleep", "cat", "grep", "sed", "tr", "uname", "head", "date"]) {
        const real = spawnSync("/bin/sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
        if (real) fs.symlinkSync(real, path.join(tools, t));
      }
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), "step-group-np-"));
      fs.writeFileSync(path.join(bin, "fakecmd"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
      const t0 = Date.now();
      const x = spawnSync(BASH, ["-c", '. "$1"; out=$(relay_run_streamed 1 fakecmd); printf "rc=%s mode=%s" "$?" "${RELAY_RUN_GROUP:-unset}"', "run", HELPER], { encoding: "utf8", env: { HOME: process.env.HOME ?? "", PATH: `${bin}:${tools}` }, timeout: 25_000 });
      fs.rmSync(bin, { recursive: true, force: true });
      expect(x.signal).toBeNull();
      expect(x.stdout).toBe("rc=124 mode=0");
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect((x.stderr ?? "").split("\n").filter((l) => /step budget covers the direct child only: perl not found/.test(l)), "ONE loud line").toHaveLength(1);
    } finally {
      fs.rmSync(tools, { recursive: true, force: true });
    }
  }, 30_000);
  it.skipIf(process.platform === "win32")("(e6458926 1) the BACKSTOP firing on a STUCK supervisor (its own alarm made late) → TERM first: the step group dies, no survivor, no hang, 124", () => {
    const helper = helperCopy((src) => {
      expect(src, "precondition: the supervisor arms its deadline with alarm").toContain("alarm $secs;");
      return src.replace("alarm $secs;", "alarm $secs + 60;");
    });
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "step-group-pid-")), "child");
    const r = run(`sleep 30 & echo $! > "${pidFile}"\nwait`, { helper });
    expect(r.signal, "finished on its own (the backstop's TERM reached the supervisor's trap)").toBeNull();
    expect(r.out).toMatch(/^rc=124 /);
    expect(r.ms, "a hang guard only").toBeLessThan(10_000);
    const child = Number(fs.readFileSync(pidFile, "utf-8").trim());
    expect(alive(child), `no step survivor (${child})`).toBe(false);
  }, 30_000);
  it.skipIf(process.platform === "win32")("(e6458926 2) setpgrp FAILING (a probe that cannot make a group) → the same ONE loud line, the direct-child bound", () => {
    const helper = helperCopy((src) => {
      expect(src, "precondition: the helpers probe setpgrp once at load").toContain("RELAY_RUN_GROUP_PROBE");
      return src.replace(/RELAY_RUN_GROUP_PROBE='[^']*'/, "RELAY_RUN_GROUP_PROBE='exit 1'");
    });
    const r = run("true", { helper });
    expect(modeOf(r.out)).toBe("0");
    expect(r.err.split("\n").filter((l) => /step budget covers the direct child only: perl cannot start a process group/.test(l)), "ONE loud line").toHaveLength(1);
  }, 30_000);
  it("MEASURED, report only (e6458926 3): the per-step overhead of the supervisor, against the hook budget", () => {
    // Two loops of N steps in ONE shell each, timed from here: (grouped − plain) / N is the supervisor's cost per step.
    const N = 15;
    const loop = (cmd: string) => {
      const t0 = performance.now();
      const r = spawnSync(BASH, ["-c", `. "$1" 2>/dev/null; i=0; while [ $i -lt ${N} ]; do ${cmd} >/dev/null 2>&1; i=$((i+1)); done`, "m", HELPER], { encoding: "utf8", timeout: 60_000 });
      expect(r.status, r.stderr).toBe(0);
      return performance.now() - t0;
    };
    const grouped = loop("relay_run_streamed 2 true");
    const plain = loop("true");
    console.log(`[step overhead] ${process.platform}: ${((grouped - plain) / N).toFixed(1)} ms per bounded step (relay_run_streamed 2 true vs a plain true; N=${N}; loop totals ${grouped.toFixed(0)} / ${plain.toFixed(0)} ms)`);
  }, 90_000);
});
