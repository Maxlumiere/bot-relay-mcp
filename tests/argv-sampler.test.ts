// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The argv sampler's own guarantees (tests/_helpers/argv-sampler.ts), driven with a substitute observer command:
 * a FAILED observation is never a sample; a BLIND one (exit 0, no witness of the target) is never a sample; a hold that
 * misses its deadline resolves false and no sample completing after the release counts; every wait, including
 * stop(), is bounded; a stuck observer's whole process GROUP is killed and reaped (no survivor, asserted by pid).
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { startArgvSampler, argvVerdict, sanitizeDiagnostic, witnesses, argvSamplerProbe, killObserverTree } from "./_helpers/argv-sampler.js";

const WIN = process.platform === "win32";
const W = "the-witness-marker"; // the target's non-secret argv marker
const sh = (script: string): [string, string[]] => ["sh", ["-c", script]];
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const recorded: number[] = []; // grandchildren the rows record, killed by pid if a row fails mid-way
afterEach(() => {
  for (const pid of recorded.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
});

describe("the witness and the diagnostics (pure)", () => {
  it("a table WITNESSES the target only with a line holding a pid AND the marker", () => {
    expect(witnesses(`  42 node x ${W}\n`, W)).toBe(true);
    expect(witnesses(``, W)).toBe(false);
    expect(witnesses(`node x ${W}\n`, W), "no pid").toBe(false);
    expect(witnesses(`  42 node x other\n`, W), "no marker").toBe(false);
  });
  it("diagnostics are sanitized: control characters stripped, length capped", () => {
    const d = sanitizeDiagnostic(`a\u0000b\u001b[31mc\n${"x".repeat(400)}`);
    expect(d).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(d.length).toBeLessThanOrEqual(161);
  });
  it("the verdict: failures → FAIL; a missed handshake with blind samples only → NOT_EVALUATED; else FAIL; held → PASS", () => {
    expect(argvVerdict([true], { failures: ["x"], blindSamples: 0, heldSamples: 4 }).kind).toBe("FAIL");
    expect(argvVerdict([false], { failures: [], blindSamples: 3, heldSamples: 0 }).kind).toBe("NOT_EVALUATED");
    expect(argvVerdict([false], { failures: [], blindSamples: 0, heldSamples: 2 }).kind).toBe("FAIL");
    expect(argvVerdict([], { failures: [], blindSamples: 0, heldSamples: 0 }).kind).toBe("FAIL");
    expect(argvVerdict([true, true], { failures: [], blindSamples: 0, heldSamples: 8 }).kind).toBe("PASS");
  });
});

describe.skipIf(WIN)("the argv sampler", () => {
  it("a FAILING observer (non-zero exit) is never counted: no samples, failures recorded, the hold resolves FALSE", async () => {
    const s = startArgvSampler("SECRET", W, { gapMs: 10, ps: sh("exit 3") });
    const ok = await s.waitForSamples(2, 600);
    await s.stop();
    expect(ok, "the handshake failed").toBe(false);
    expect(s.sampled).toBe(0);
    expect(s.heldSamples).toBe(0);
    expect(s.failures[0]).toMatch(/exited 3/);
  }, 10_000);

  it("a BLIND observer (exit 0, an EMPTY table) is never a sample: the hold is never satisfied, the verdict is NOT_EVALUATED", async () => {
    const s = startArgvSampler("SECRET", W, { gapMs: 10, ps: sh("exit 0") });
    const ok = await s.waitForSamples(2, 600);
    await s.stop();
    expect(ok).toBe(false);
    expect(s.sampled).toBe(0);
    expect(s.blindSamples).toBeGreaterThan(0);
    expect(s.failures).toEqual([]);
    expect(argvVerdict([ok], s).kind).toBe("NOT_EVALUATED");
  }, 10_000);

  it("a RESTRICTED table (other processes only, never the target) is blind too", async () => {
    const s = startArgvSampler("SECRET", W, { gapMs: 10, ps: sh("echo '  1 /sbin/launchd'; echo '  7 someone else'") });
    const ok = await s.waitForSamples(2, 600);
    await s.stop();
    expect(ok).toBe(false);
    expect(s.blindSamples).toBeGreaterThan(0);
  }, 10_000);

  it("an observer that cannot SPAWN is a failure, never a sample", async () => {
    const s = startArgvSampler("SECRET", W, { gapMs: 10, ps: ["/no/such/observer-binary", []] });
    const ok = await s.waitForSamples(1, 500);
    await s.stop();
    expect(ok).toBe(false);
    expect(s.sampled).toBe(0);
    expect(s.failures[0]).toMatch(/could not spawn/);
  }, 10_000);

  it("a hold that misses its deadline resolves FALSE, and a sample that STARTED inside it but COMPLETED after the release never counts", async () => {
    // Each observation takes ~700 ms. The hold opens during sample 1 (t≈100 ms) with a 1 s deadline; sample 2 STARTS
    // inside the hold (t≈710 ms) and COMPLETES after the release (t≈1410 > 1100 ms).
    const s = startArgvSampler("SECRET", W, { gapMs: 10, ps: sh(`sleep 0.7; echo "  42 target ${W}"`) });
    await new Promise((r) => setTimeout(r, 100));
    const ok = await s.waitForSamples(1, 1_000);
    await new Promise((r) => setTimeout(r, 700));
    await s.stop();
    expect(ok).toBe(false);
    expect(s.sampled, "both samples did complete").toBeGreaterThanOrEqual(2);
    expect(s.heldSamples, "sample 2 completed after the release: not held").toBe(0);
  }, 10_000);

  it("a hold is satisfied only by WITNESSING samples that started inside it and completed while it was held", async () => {
    const s = startArgvSampler("SECRET", W, { gapMs: 10, ps: sh(`echo "  42 target ${W}"; echo "  43 has-SECRET-inside"`) });
    const ok = await s.waitForSamples(3, 5_000);
    await s.stop();
    expect(ok).toBe(true);
    expect(s.heldSamples).toBeGreaterThanOrEqual(3);
    expect(s.leaked).toBe("  43 has-SECRET-inside");
    expect(s.failures).toEqual([]);
  }, 10_000);

  it("a STUCK observer: its whole process GROUP is killed and reaped at the timeout (no survivor, asserted by pid); stop() is bounded", async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sampler-stuck-")), "grandchild.pid");
    // sh forks a grandchild (sleep) and waits on it: killing sh alone would leave the sleep behind.
    const s = startArgvSampler("SECRET", W, { gapMs: 10, sampleTimeoutMs: 300, ps: sh(`sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`) });
    await new Promise((r) => setTimeout(r, 900)); // past the first timeout: its group was killed and reaped
    const t0 = Date.now();
    await s.stop();
    expect(Date.now() - t0, "stop() is bounded").toBeLessThan(3_000);
    const pid = Number(fs.readFileSync(pidFile, "utf-8").trim());
    recorded.push(pid);
    expect(pid).toBeGreaterThan(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid), `the grandchild ${pid} must not survive its group's kill`).toBe(false);
    expect(s.failures.some((f) => /timed out/.test(f)), JSON.stringify(s.failures)).toBe(true);
    expect(s.sampled).toBe(0);
  }, 15_000);

  it("a sample that stop() ENDS (killed in flight) is neither a sample nor a failure", async () => {
    // A slow observer is in flight when stop() lands: our own kill must never read as the observer failing.
    for (let i = 0; i < 5; i++) {
      const s = startArgvSampler("SECRET", W, { gapMs: 1, ps: sh(`sleep 0.2; echo "  42 target ${W}"`) });
      await new Promise((r) => setTimeout(r, 50 + i * 30));
      await s.stop();
      expect(s.failures, `run ${i}: stop()'s own kill is not a failure`).toEqual([]);
    }
  }, 15_000);

  it("stop() during a hold settles that hold FALSE (exactly once)", async () => {
    const s = startArgvSampler("SECRET", W, { gapMs: 10, ps: sh(`sleep 0.3; echo "  42 target ${W}"`) });
    const pending = s.waitForSamples(100, 20_000);
    await new Promise((r) => setTimeout(r, 100));
    await s.stop();
    expect(await pending).toBe(false);
  }, 10_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// THE FRAMED OBSERVER: ONE long-lived process answers one request with one frame (`@@BEGIN <seq>`, `<pid> <argv>` lines,
// `@@END <seq>`). On Windows it is a PowerShell loop over Win32_Process CommandLine; here a FAKE (node) drives the same
// contract on every OS: a sample STARTS when its request is written and COMPLETES at its frame's end.
// ---------------------------------------------------------------------------------------------------------------------
describe("the FRAMED observer (one long-lived process, one frame per request)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sampler-framed-"));
  // The fake's grandchild: on POSIX it stays in the observer's process group (what the group kill reaches); on WINDOWS it
  // is spawned detached, so a parent that dies leaves a TRUE orphan (what the by-parent-pid confirmation must find).
  // MEASURED on the Windows runner: a NON-detached grandchild died with its parent, so a parent-only kill left nothing to
  // find. The cause, REPORTED (not verified): libuv puts a non-detached child in a kill-on-close job with its parent.
  // TOPOLOGY modelled: the production observer itself is spawned NON-detached on Windows (tests/_helpers/argv-sampler.ts,
  // the framed observer's spawn); what this models is a CHILD of that observer, which PowerShell (not libuv) would
  // create outside any such job, so it would outlive a dying observer, as this detached grandchild does.
  const FAKE = path.join(dir, "fake-observer.mjs");
  fs.writeFileSync(
    FAKE,
    [
      "import fs from \"node:fs\";",
      "import readline from \"node:readline\";",
      "import { spawn } from \"node:child_process\";",
      "const [mode, pidFile, W] = process.argv.slice(2);",
      "fs.appendFileSync(pidFile, process.pid + \"\\n\");",
      "if (mode === \"exit\") process.exit(3);",
      "if (mode === \"stuck-child\") { const c = spawn(process.execPath, [\"-e\", \"setInterval(() => {}, 1000)\"], { stdio: \"ignore\", detached: process.platform === \"win32\" }); fs.appendFileSync(pidFile + \".grand\", c.pid + \"\\n\"); }",
      "let answered = 0;",
      "const w = (t) => process.stdout.write(t);",
      "readline.createInterface({ input: process.stdin }).on(\"line\", async (line) => {",
      "  const seq = line.trim();",
      "  if (mode === \"stuck\" || mode === \"stuck-child\") return;",
      "  if (mode === \"slow\") await new Promise((r) => setTimeout(r, 700));",
      "  if (mode === \"slow200\") await new Promise((r) => setTimeout(r, 200));",
      "  if (mode === \"malformed\") { w(\"garbage before any frame\\n\"); return; }",
      "  if (mode === \"error\") { w(\"@@ERROR \" + seq + \" the query failed\\n\"); return; }",
      "  const begin = mode === \"badseq\" ? \"999999\" : seq;",
      "  const end = mode === \"badend\" ? \"999999\" : seq;",
      "  const body = mode === \"blind\" ? \"\" : \"  \" + process.pid + \" node target \" + W + \"\\n  43 has-SECRET-inside\\n\";",
      "  w(\"@@BEGIN \" + begin + \"\\n\" + body + \"@@END \" + end + \"\\n\");",
      "  if (mode === \"exit-leave-child\" && ++answered === 1) { const c = spawn(process.execPath, [\"-e\", \"setInterval(() => {}, 1000)\"], { stdio: \"ignore\", detached: process.platform === \"win32\" }); fs.appendFileSync(pidFile + \".grand\", c.pid + \"\\n\"); setTimeout(() => process.exit(0), 30); }",
      "});",
    ].join("\n")
  );
  const pids = (f: string): number[] => (fs.existsSync(f) ? fs.readFileSync(f, "utf-8").split("\n").filter(Boolean).map(Number) : []);
  const fake = (mode: string, tag: string) => {
    const pidFile = path.join(dir, `${tag}.pids`);
    return { pidFile, framed: [process.execPath, [FAKE, mode, pidFile, W]] as [string, string[]] };
  };

  it("ONE observer process serves many samples: each frame that witnesses the target is a sample; a held hold settles TRUE", async () => {
    const f = fake("witness", "one");
    const s = startArgvSampler("SECRET", W, { gapMs: 5, framed: f.framed });
    const ok = await s.waitForSamples(5, 10_000);
    await s.stop();
    expect(ok).toBe(true);
    expect(s.heldSamples).toBeGreaterThanOrEqual(5);
    expect(s.leaked).toBe("  43 has-SECRET-inside");
    expect(s.failures).toEqual([]);
    expect(pids(f.pidFile), "one long-lived observer, not one per sample").toHaveLength(1);
  }, 15_000);

  it("a frame WITHOUT the target is a BLIND sample: the hold is never satisfied, the verdict is NOT_EVALUATED", async () => {
    const f = fake("blind", "blind");
    const s = startArgvSampler("SECRET", W, { gapMs: 5, framed: f.framed });
    const ok = await s.waitForSamples(1, 1_000);
    await s.stop();
    expect(ok).toBe(false);
    expect(s.sampled).toBe(0);
    expect(s.blindSamples).toBeGreaterThan(0);
    expect(argvVerdict([ok], s).kind).toBe("NOT_EVALUATED");
  }, 10_000);

  for (const [mode, why] of [
    ["malformed", /malformed|out of order/],
    ["badseq", /malformed|out of order/],
    ["badend", /malformed|out of order/],
    ["error", /the query failed/],
    ["exit", /exited/],
  ] as const) {
    it(`a ${mode.toUpperCase()} observer is a FAILURE, never a sample; the next sample gets a FRESH observer`, async () => {
      const f = fake(mode, `fail-${mode}`);
      const s = startArgvSampler("SECRET", W, { gapMs: 20, framed: f.framed });
      await new Promise((r) => setTimeout(r, 1_200));
      await s.stop();
      expect(s.sampled).toBe(0);
      expect(s.failures.length, JSON.stringify(s.failures)).toBeGreaterThan(0);
      expect(s.failures.some((x) => why.test(x)), JSON.stringify(s.failures)).toBe(true);
      expect(pids(f.pidFile).length, "a broken observer is replaced, not reused").toBeGreaterThanOrEqual(2);
    }, 15_000);
  }

  it("a STUCK observer: the sample times out (a failure) and the observer's whole TREE is killed (asserted by pid)", async () => {
    const f = fake("stuck-child", "stuck");
    const s = startArgvSampler("SECRET", W, { gapMs: 10, sampleTimeoutMs: 300, framed: f.framed });
    await new Promise((r) => setTimeout(r, 900));
    await s.stop();
    const observer = pids(f.pidFile)[0]!;
    const grand = pids(`${f.pidFile}.grand`)[0]!;
    recorded.push(grand);
    expect(observer).toBeGreaterThan(1);
    expect(grand).toBeGreaterThan(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(observer), `the observer ${observer} must not survive`).toBe(false);
    expect(alive(grand), `its child ${grand} must not survive (the tree is killed)`).toBe(false);
    expect(s.failures.some((x) => /timed out/.test(x)), JSON.stringify(s.failures)).toBe(true);
  }, 15_000);

  it("a kill the observer SURVIVES is retried: the handle is RETAINED, killed again and its exit CONFIRMED (asserted by pid)", async () => {
    const f = fake("stuck", "survive-once");
    const calls: number[] = [];
    // The FIRST kill attempt on each observer is ignored (the process survives it); later attempts are real.
    const s = startArgvSampler("SECRET", W, { gapMs: 10, sampleTimeoutMs: 300, framed: f.framed, killer: (p, attempt) => (calls.push(attempt), attempt >= 2 && killObserverTree(p)) });
    await new Promise((r) => setTimeout(r, 700));
    await s.stop();
    for (const pid of pids(f.pidFile)) recorded.push(pid);
    // Observers retire concurrently, so attempts interleave: what matters is that a SURVIVED kill is attempted again.
    expect(calls, "a survived kill is attempted AGAIN").toContain(2);
    await new Promise((r) => setTimeout(r, 200));
    for (const pid of pids(f.pidFile)) expect(alive(pid), `observer ${pid} confirmed gone`).toBe(false);
    expect(s.failures.some((x) => /possible surviving observer process/.test(x)), "a retried, confirmed kill is not a survivor").toBe(false);
  }, 30_000);

  it("an observer that survives EVERY kill is REPORTED by stop() (a visible failure naming it), never lost", async () => {
    const f = fake("stuck", "survive-all");
    const s = startArgvSampler("SECRET", W, { gapMs: 10, sampleTimeoutMs: 300, framed: f.framed, killer: () => false });
    await new Promise((r) => setTimeout(r, 500));
    await s.stop();
    const left = pids(f.pidFile);
    for (const pid of left) recorded.push(pid); // killed by pid in afterEach
    expect(left.length).toBeGreaterThan(0);
    expect(s.failures.some((x) => /possible surviving observer process: \d+/.test(x)), JSON.stringify(s.failures)).toBe(true);
    expect(left.some((pid) => s.failures.some((x) => x.includes(String(pid)))), "the survivor is named by its pid").toBe(true);
  }, 60_000);

  it("an observer that EXITS between frames, leaving a grandchild with its own stdio, is RETIRED (its tree killed) before it is replaced; the grandchild is confirmed dead", async () => {
    const f = fake("exit-leave-child", "leave-child");
    const s = startArgvSampler("SECRET", W, { gapMs: 100, framed: f.framed });
    await new Promise((r) => setTimeout(r, 900)); // the first observer answered, left its grandchild and exited; later ones too
    await s.stop();
    const grands = pids(`${f.pidFile}.grand`);
    for (const pid of [...grands, ...pids(f.pidFile)]) recorded.push(pid);
    expect(grands.length, "precondition: an observer left a grandchild").toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 200));
    for (const pid of grands) expect(alive(pid), `the grandchild ${pid} of an exited observer must not survive`).toBe(false);
    expect(s.failures.some((x) => /possible surviving/.test(x)), JSON.stringify(s.failures)).toBe(false);
  }, 30_000);

  it("an observer whose parent has ALREADY closed still gets its TREE kill issued", async () => {
    const f = fake("exit-leave-child", "closed-parent");
    const killed: number[] = [];
    const s = startArgvSampler("SECRET", W, { gapMs: 100, framed: f.framed, killer: (p) => (killed.push(p.pid ?? -1), killObserverTree(p)) });
    await new Promise((r) => setTimeout(r, 900));
    await s.stop();
    for (const pid of [...pids(`${f.pidFile}.grand`), ...pids(f.pidFile)]) recorded.push(pid);
    const first = pids(f.pidFile)[0]!;
    expect(killed, `the exited observer ${first} still had its tree kill issued`).toContain(first);
  }, 30_000);

  it("a killer that FAILS (its result checked) leaves the tree unconfirmed: stop() REPORTS the possible survivor by pid", async () => {
    const f = fake("stuck-child", "killer-fails");
    const s = startArgvSampler("SECRET", W, { gapMs: 10, sampleTimeoutMs: 300, framed: f.framed, killer: () => false });
    await new Promise((r) => setTimeout(r, 500));
    await s.stop();
    for (const pid of [...pids(`${f.pidFile}.grand`), ...pids(f.pidFile)]) recorded.push(pid); // killed by pid in afterEach
    const observers = pids(f.pidFile);
    expect(s.failures.some((x) => observers.some((pid) => x === `possible surviving observer process: ${pid}`)), JSON.stringify(s.failures)).toBe(true);
  }, 60_000);

  it("a kill that reaps only the PARENT leaves a grandchild: the by-PID check sees it, and stop() reports the possible survivor", async () => {
    const f = fake("stuck-child", "parent-only");
    // A kill that ends the observer itself but not its group: a close event would read as success; the tree is alive.
    const parentOnly = (p: ChildProcess) => {
      try {
        process.kill(p.pid!, "SIGKILL");
      } catch {
        /* gone */
      }
      return true;
    };
    const s = startArgvSampler("SECRET", W, { gapMs: 10, sampleTimeoutMs: 300, framed: f.framed, killer: parentOnly });
    await new Promise((r) => setTimeout(r, 500));
    await s.stop();
    for (const pid of [...pids(`${f.pidFile}.grand`), ...pids(f.pidFile)]) recorded.push(pid); // killed by pid in afterEach
    expect(s.failures.some((x) => /^possible surviving observer process: \d+$/.test(x)), JSON.stringify(s.failures)).toBe(true);
  }, 60_000);

  it("a killer that REPORTS failure is an unconfirmed attempt even if the tree did die (its result is checked, never assumed)", async () => {
    const f = fake("stuck", "reports-failure");
    const s = startArgvSampler("SECRET", W, { gapMs: 10, sampleTimeoutMs: 300, framed: f.framed, killer: (p) => (killObserverTree(p), false) });
    await new Promise((r) => setTimeout(r, 500));
    await s.stop();
    for (const pid of pids(f.pidFile)) recorded.push(pid);
    expect(s.failures.some((x) => /^possible surviving observer process: \d+$/.test(x)), JSON.stringify(s.failures)).toBe(true);
  }, 60_000);

  it("a frame that stop() ENDS (in flight) is neither a sample nor a failure", async () => {
    for (let i = 0; i < 5; i++) {
      const f = fake("slow200", `stop-${i}`);
      const s = startArgvSampler("SECRET", W, { gapMs: 1, framed: f.framed });
      await new Promise((r) => setTimeout(r, 50 + i * 30));
      await s.stop();
      expect(s.failures, `run ${i}: stop()'s own kill is not a failure`).toEqual([]);
    }
  }, 20_000);

  it("a frame that STARTED inside a hold but COMPLETED after its release never counts", async () => {
    const f = fake("slow", "late");
    const s = startArgvSampler("SECRET", W, { gapMs: 10, framed: f.framed });
    await new Promise((r) => setTimeout(r, 100));
    const ok = await s.waitForSamples(1, 1_000);
    await new Promise((r) => setTimeout(r, 700));
    await s.stop();
    expect(ok).toBe(false);
    expect(s.sampled, "the frames did complete").toBeGreaterThanOrEqual(2);
    expect(s.heldSamples, "a frame completing after the release is not held").toBe(0);
  }, 10_000);
});

describe.skipIf(!WIN)("the WINDOWS observer (PowerShell, Win32_Process CommandLine), measured on the runner", () => {
  it("the probe SEES a child's pid and full argv (own-user CommandLine readable without elevation)", () => {
    const p = argvSamplerProbe();
    console.log(`[argv-sampler] windows probe: ${p.visible ? "visible" : "NOT visible"}: ${p.why}`);
    expect(p, p.why).toMatchObject({ visible: true });
  }, 60_000);

  it("a PLANTED argv (the secret on a child's command line) is CAUGHT, on the child's witnessed pid", async () => {
    const secret = `win-planted-${process.pid}-${Date.now()}`;
    const marker = `win-witness-${process.pid}-${Date.now()}`;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker, secret], { stdio: "ignore" });
    recorded.push(child.pid!);
    try {
      const s = startArgvSampler(secret, marker, { gapMs: 20, sampleTimeoutMs: 20_000 });
      const ok = await s.waitForSamples(2, 45_000);
      await s.stop();
      expect(s.failures, JSON.stringify(s.failures)).toEqual([]);
      expect(ok, "two frames witnessed the child").toBe(true);
      // A failing assertion here may print the secret: it is SYNTHETIC (made for this row), never a real credential.
      expect(s.leaked, "the planted secret is caught").toContain(secret);
      expect(s.leaked.split("\n").some((l) => Number(/^\s*(\d+)/.exec(l)?.[1]) === child.pid), "on the child's own pid").toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  }, 90_000);

  it("PowerShell that cannot start → the probe is NOT visible, with the reason (the rows then report a coverage gap)", () => {
    const p = argvSamplerProbe({ powershell: "definitely-not-powershell-xyz.exe" });
    expect(p.visible).toBe(false);
    expect(p.why).toMatch(/PowerShell could not (start|run)/);
  }, 30_000);
});
