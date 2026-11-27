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
/** Alive, asked through bash's own `kill -0`: the pid file holds the WRAPPER's pid namespace (msys on Windows). */
const alive = (pid: number) => spawnSync(BASH, ["-c", 'kill -0 "$1" 2>/dev/null', "alive", String(pid)]).status === 0;
/** Every assertion carries what the run produced, so a CI failure says what happened (a hang, a mode, the stderr). */
const diag = (r: { ms: number; signal: NodeJS.Signals | null; out: string; err: string }) => JSON.stringify({ ms: r.ms, signal: r.signal, out: r.out, err: r.err.slice(0, 800) });
const fwd = (p: string) => p.replace(/\\/g, "/");

describe("the budgeted step's process group: the deadline holds for a forking wrapper (or the mode says why not, loudly)", () => {
  it("the MODE is decided once per load: macOS and Linux run grouped; elsewhere either grouped or the ONE loud line", () => {
    const r = run("true");
    const mode = modeOf(r.out);
    if (process.platform !== "win32") expect(mode, `stderr: ${r.err}`).toBe("1");
    else expect(mode === "1" || (mode === "0" && LOUD.test(r.err)), `Windows mode ${mode}, stderr: ${r.err}`).toBe(true);
  });
  it("(1) a FORKING wrapper (its child holds the pipe) → the deadline holds (grouped), and its child is gone", () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "step-group-pid-")), "child");
    const r = run(`sleep 30 & echo $! > "${fwd(pidFile)}"\nwait`);
    expect(r.signal, `finished on its own: ${diag(r)}`).toBeNull();
    if (modeOf(r.out) !== "1") return void expect(r.err, diag(r)).toMatch(LOUD); // the direct-child bound, said loudly
    expect(r.out, diag(r)).toMatch(/^rc=124 /);
    expect(r.ms, `a hang guard only: well under the wrapper's 30 s: ${diag(r)}`).toBeLessThan(10_000);
    const child = Number(fs.readFileSync(pidFile, "utf-8").trim());
    expect(alive(child), `the wrapper's child ${child} was killed with its group: ${diag(r)}`).toBe(false);
  }, 30_000);
  it("(2) a wrapper that BACKGROUNDS a sleeper and EXITS → no hang (the finished step's strays are killed)", () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "step-group-pid-")), "child");
    const r = run(`sleep 30 & echo $! > "${fwd(pidFile)}"\necho done\nexit 0`);
    expect(r.signal, `finished on its own: ${diag(r)}`).toBeNull();
    if (modeOf(r.out) !== "1") return void expect(r.err, diag(r)).toMatch(LOUD);
    const child = Number(fs.readFileSync(pidFile, "utf-8").trim());
    expect(alive(child), `the finished step's stray ${child} was killed with its group: ${diag(r)}`).toBe(false);
    expect(r.out, diag(r)).toMatch(/^rc=0 out=done /);
    expect(r.ms, `a hang guard only: ${diag(r)}`).toBeLessThan(10_000);
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
    const r = run(`sleep 30 & echo $! > "${fwd(pidFile)}"\nwait`, { helper });
    expect(r.signal, `finished on its own (the backstop's TERM reached the supervisor's trap): ${diag(r)}`).toBeNull();
    expect(r.out, diag(r)).toMatch(/^rc=124 /);
    expect(r.ms, `a hang guard only: ${diag(r)}`).toBeLessThan(10_000);
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
  it("MEASURED, report only (ruling 7671d762): row (2)'s scenario 10 times, each outcome NAMED (a hang dumps the process table with groups, and the supervisor's own account of its group kill)", () => {
    // A test COPY of the helpers whose supervisor reports its group kill on stderr: the shipped line is never edited.
    const killLine = 'if ($grouped && eval { setpgrp(0, $orig); 1 } && getpgrp(0) != $$) { kill "KILL", -$$ }';
    const helper = helperCopy((src) => {
      expect(src, "precondition: the supervisor's group-kill line").toContain(killLine);
      // A replacer FUNCTION: a replacement string would turn perl's `$$` into `$`.
      return src.replace(killLine, () => [
        'my $how = "not grouped";',
        "if ($grouped) {",
        '  my $moved = eval { setpgrp(0, $orig); 1 } && getpgrp(0) != $$;',
        '  if ($moved) { my $k = kill("KILL", -$$); my $e = $!; $how = "moved out to " . getpgrp(0) . ", kill(-group) returned " . $k . ", errno " . ($e + 0) }',
        '  else { $how = "could not move out, pgrp " . getpgrp(0) }',
        "}",
        'print STDERR "supervisor pid " . $$ . " orig " . $orig . " grouped " . ($grouped ? 1 : 0) . " child " . $c . ": " . $how . "\\n";',
      ].join("\n"));
    });
    const script = [
      "#!/bin/bash",
      'H="$1"; D="$2"',
      '. "$H" 2>/dev/null',
      'PATH="$D:$PATH"',
      '( out=$(relay_run_streamed 1 fakecmd 2>"$D/sup.err"); echo "rc=$? out=$out" > "$D/res" ) &',
      "w=$!",
      "i=0",
      'while [ $i -lt 60 ] && [ ! -s "$D/res" ]; do sleep 0.1; i=$((i+1)); done',
      'if [ -s "$D/res" ]; then echo "FINISHED within ~$((i * 100)) ms: $(cat "$D/res")"; else echo "HUNG at 6 s"; fi',
      'echo "supervisor: $(cat "$D/sup.err" 2>/dev/null)"',
      's=$(cat "$D/pid" 2>/dev/null)',
      'echo "the wrapper\'s sleeper $s alive: $(kill -0 "$s" 2>/dev/null && echo yes || echo no)"',
      'echo "the table at the wrapper\'s start:"; cat "$D/ps-start" 2>/dev/null',
      'echo "the table now:"; ps 2>/dev/null | head -40',
      '[ -n "$s" ] && kill -KILL "$s" 2>/dev/null',
      'wait "$w" 2>/dev/null',
    ].join("\n");
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "step-group-diag-"));
      try {
        const D = fwd(d);
        fs.writeFileSync(path.join(d, "diag.sh"), script + "\n", { mode: 0o755 });
        fs.writeFileSync(path.join(d, "fakecmd"), `#!/bin/sh\nsleep 30 & echo $! > "${D}/pid"\nps > "${D}/ps-start" 2>&1\necho done\nexit 0\n`, { mode: 0o755 });
        const r = spawnSync(BASH, [`${D}/diag.sh`, fwd(helper), D], { encoding: "utf8", timeout: 15_000 });
        outcomes.push(`#${i + 1} signal=${r.signal} ${(r.stdout ?? "").trim()}${r.stderr ? `\nstderr: ${r.stderr.trim().slice(0, 400)}` : ""}`);
      } finally {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
    const hung = outcomes.filter((o) => o.includes("HUNG") || !o.includes("FINISHED")).length;
    console.log(`[row 2 x10] ${process.platform}: ${10 - hung} finished, ${hung} hung or cut\n${outcomes.map((o) => (o.includes("FINISHED") && !o.includes("alive: yes") ? o.split("\n").slice(0, 3).join("\n") : o)).join("\n----\n")}`);
  }, 200_000);
  it("MEASURED, report only (ruling 40431fc6): what the shell reports for the fixed system ps/readlink paths (owner uid, mode, type)", () => {
    // GNU stat (Linux, msys) first, BSD stat (macOS) second: the owner as the SHELL sees it, which is what a hook checks.
    const r = spawnSync(BASH, ["-c", 'for p in /bin/ps /usr/bin/ps /usr/bin/readlink /bin/readlink; do if [ -e "$p" ]; then stat -L -c "%n uid=%u gid=%g mode=%a type=%F" "$p" 2>/dev/null || stat -L -f "%N uid=%u gid=%g mode=%Lp type=%HT" "$p"; else echo "$p absent"; fi; done; echo "id -u=$(id -u)"'], { encoding: "utf8", timeout: 20_000 });
    console.log(`[system binaries] ${process.platform}:\n${(r.stdout ?? "").trim()}${r.stderr ? `\nstderr: ${r.stderr.trim()}` : ""}`);
  }, 30_000);
});
