// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01: the per-platform MEASUREMENT that enables a platform's single-owner lock (MEASURED_PLATFORMS). It drives
 * the UNGATED primitive (acquirePrimitive), so an unmeasured platform can be measured. It runs in CI on Linux, macOS
 * and Windows:
 * - 8 racer processes x 20 rounds, each round after a SIGKILLed holder: EXACTLY one owner every round;
 * - the key is stable across a rename persist (the wasm driver's tmp + rename gives the DB a new inode);
 * - alias spellings of one DB (a symlink, `..`, a case variant where the volume folds case) give one owner;
 * - Linux CI: a bind mount of the DB's directory gives one owner, when the runner can mount; otherwise UNMEASURED;
 * - a DB the acquire just CREATED and its caller's verify refuses is removed only when it is provably that file (the
 *   same dev + ino as the created fd, still empty), with the open fd held (on Windows too);
 * - native PROBERS (isOwnedElsewhere) racing each other never see an owner that is not there, and do see one that is;
 *   with probers at the GATING rate (8 x 20 probes/s, ASSUMED: the fleet records no per-open event; the busiest
 *   recorded 10 s window was 5 audit events), an acquirer takes the lock within its budget; a tight-loop probe storm
 *   is REPORT-ONLY (INV_DB_01_STORM=1: it prints how many rounds were starved, and never gates);
 * - a probe CREATES nothing (a read-only HOME, no locks dir: it answers FREE and no locks dir appears);
 * - processes with DIFFERENT HOMEs (one in a minimal, launchd-like env) on one DB: exactly one owner; on macOS the lock
 *   is ONE dotfile in the DB's real parent dir (0600), whatever the spelling, and a planted one that is not private
 *   (a wider mode, a symlink, another owner) is a named refusal;
 * - a probe of an ABSENT owner answers FREE within the probe bound; a connect that never answers is a named refusal.
 * The racers run from FILES (an eval'd module breaks worker pools), under a SANDBOX HOME; every recorded child is
 * checked exited at the end.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_JS = pathToFileURL(path.join(REPO, "dist", "db-owner-lock.js")).href;
const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "inv-db-01-race-")));
const HOME = path.join(ROOT, "home");
fs.mkdirSync(HOME);
// In-process lock calls (macOS keeps its lock files under os.homedir()) use the SANDBOX home too, never the operator's.
const SAVED_HOME = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const restoreHome = () => {
  for (const [k, v] of Object.entries(SAVED_HOME)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};
const PLATFORM_OK = ["darwin", "linux", "win32"].includes(process.platform);
const RACERS = 8;
const ROUNDS = 20;
const recorded: ChildProcess[] = [];
afterAll(async () => {
  // A child killed by afterEach may not have emitted "exit" yet: kill what is left and WAIT (bounded) for every one.
  const waitExit = (c: ChildProcess) =>
    c.exitCode !== null || c.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((res) => { c.once("exit", () => res()); setTimeout(res, 5000); });
  for (const c of recorded) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  await Promise.all(recorded.map(waitExit));
  const alive = recorded.filter((c) => c.exitCode === null && c.signalCode === null);
  restoreHome();
  fs.rmSync(ROOT, { recursive: true, force: true });
  expect(alive.length, "every recorded racer had exited").toBe(0);
});

const RACER = path.join(ROOT, "racer.mjs");
fs.writeFileSync(
  RACER,
  `const { acquirePrimitive } = await import(${JSON.stringify(LOCK_JS)});\n` +
    `const fs = await import("fs");\n` +
    `const [db, go, hold] = process.argv.slice(2);\n` +
    `while (!fs.existsSync(go)) await new Promise((r) => setTimeout(r, 2));\n` +
    `try { await acquirePrimitive(db, { attempts: 1 }); process.stdout.write("OWNER\\n"); await new Promise((r) => setTimeout(r, Number(hold))); }\n` +
    `catch (e) { process.stdout.write("LOST " + (e.name || e.code) + "\\n"); }\n` +
    `process.exit(0);\n`
);
const HOLDER = path.join(ROOT, "holder.mjs");
fs.writeFileSync(
  HOLDER,
  `const { acquirePrimitive } = await import(${JSON.stringify(LOCK_JS)});\n` +
    `await acquirePrimitive(process.argv[2]); process.stdout.write("HELD\\n"); setInterval(() => {}, 1000);\n`
);
const PROBER = path.join(ROOT, "prober.mjs");
fs.writeFileSync(
  PROBER,
  `const { isOwnedElsewhere } = await import(${JSON.stringify(LOCK_JS)});\n` +
    `const fs = await import("fs");\n` +
    `const [db, go] = process.argv.slice(2);\n` +
    `while (!fs.existsSync(go)) await new Promise((r) => setTimeout(r, 2));\n` +
    `const seen = [];\n` +
    `for (let i = 0; i < 5; i++) seen.push(await isOwnedElsewhere(db) ? "OWNED" : "FREE");\n` +
    `process.stdout.write(seen.join(" ") + "\\n");\n` +
    `process.exit(0);\n`
);
const LOOPER = path.join(ROOT, "looper.mjs");
fs.writeFileSync(
  LOOPER,
  `const { isOwnedElsewhere } = await import(${JSON.stringify(LOCK_JS)});\n` +
    `const fs = await import("fs");\n` +
    `const [db, stop, gapMs] = process.argv.slice(2);\n` +
    `const gap = Number(gapMs);\n` +
    `const end = Date.now() + 30000; // self-terminating, whatever the parent does\n` +
    `let n = 0;\n` +
    `while (!fs.existsSync(stop) && Date.now() < end) {\n` +
    `  await isOwnedElsewhere(db);\n` +
    `  if (++n === 1) process.stdout.write("SPIN\\n"); // the start barrier: this looper is probing\n` +
    `  if (gap > 0) await new Promise((r) => setTimeout(r, gap));\n` +
    `}\n` +
    `process.stdout.write("COUNT " + n + "\\n");\n` +
    `process.exit(0);\n`
);
const ACQUIRER = path.join(ROOT, "acquirer.mjs");
fs.writeFileSync(
  ACQUIRER,
  `const { acquirePrimitive } = await import(${JSON.stringify(LOCK_JS)});\n` +
    `const t = performance.now();\n` +
    `try { const l = await acquirePrimitive(process.argv[2]); process.stdout.write("OWNER " + Math.round(performance.now() - t) + "\\n"); l.release(); }\n` +
    `catch (e) { process.stdout.write("LOST " + Math.round(performance.now() - t) + " " + e.message + "\\n"); }\n` +
    `process.exit(0);\n`
);
const env = { ...process.env, HOME, USERPROFILE: HOME };

function run(file: string, args: string[], envFor: NodeJS.ProcessEnv = env): { child: ChildProcess; out: Promise<string> } {
  const child = spawn(process.execPath, [file, ...args], { env: envFor, stdio: ["ignore", "pipe", "pipe"] });
  recorded.push(child);
  let buf = "";
  child.stdout!.on("data", (d) => (buf += d));
  return { child, out: new Promise((res) => child.on("exit", () => res(buf))) };
}
async function holding(db: string): Promise<{ kill: () => Promise<void> }> {
  const h = run(HOLDER, [db]);
  await new Promise<void>((res) => h.child.stdout!.on("data", (d) => String(d).includes("HELD") && res()));
  return { kill: async () => { h.child.kill("SIGKILL"); await h.out; } };
}
async function oneTry(db: string): Promise<string> {
  const go = path.join(ROOT, `go-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(go, "");
  return run(RACER, [db, go, "0"]).out;
}

describe.skipIf(!PLATFORM_OK)(`INV-DB-01: the single-owner lock primitive, measured on ${process.platform}`, () => {
  it(`exactly ONE owner in each of ${ROUNDS} rounds of ${RACERS} racers, each round after a SIGKILLed holder`, async () => {
    const db = path.join(ROOT, "race.db");
    const owners: number[] = [];
    for (let r = 0; r < ROUNDS; r++) {
      const h = await holding(db);
      await h.kill();
      const go = path.join(ROOT, `go-${r}`);
      const racers = Array.from({ length: RACERS }, () => run(RACER, [db, go, "400"]));
      await new Promise((res) => setTimeout(res, 150));
      fs.writeFileSync(go, "");
      const outs = await Promise.all(racers.map((x) => x.out));
      owners.push(outs.filter((o) => o.includes("OWNER")).length);
    }
    expect(owners, "owners per round").toEqual(Array(ROUNDS).fill(1));
  }, 240_000);

  it("MEASURED: the key is stable across a rename persist (tmp + rename gives the DB a NEW inode, its directory keeps its own)", async () => {
    const { lockKey } = (await import("../dist/db-owner-lock.js")) as { lockKey: (p: string) => string };
    const db = path.join(ROOT, "persist.db");
    fs.writeFileSync(db, "v1");
    const inoBefore = fs.statSync(db, { bigint: true }).ino;
    const keyBefore = lockKey(db);
    fs.writeFileSync(`${db}.tmp`, "v2");
    fs.renameSync(`${db}.tmp`, db);
    const inoAfter = fs.statSync(db, { bigint: true }).ino;
    expect(inoAfter, "precondition: the rename gave the DB a new inode").not.toBe(inoBefore);
    expect(lockKey(db), "the key is unchanged").toBe(keyBefore);
    const h = await holding(db);
    try {
      expect(await oneTry(db), "after the rename, a new opener is refused").toMatch(/LOST/);
    } finally {
      await h.kill();
    }
  }, 60_000);

  it("alias spellings name ONE owner: a symlink, `..`, and a case variant where this volume folds case (the OS's own answer)", async () => {
    const dir = path.join(ROOT, "alias");
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    const db = path.join(dir, "Alias.db");
    fs.writeFileSync(db, "");
    const spellings: string[] = [path.join(dir, "sub", "..", "Alias.db")];
    if (process.platform !== "win32") {
      const link = path.join(ROOT, "alias-link.db");
      fs.symlinkSync(db, link);
      spellings.push(link);
    }
    const caseVariant = path.join(dir, "ALIAS.DB");
    const folds = fs.existsSync(caseVariant) && fs.realpathSync.native(caseVariant) === fs.realpathSync.native(db);
    if (folds) spellings.push(caseVariant);
    const h = await holding(db);
    try {
      for (const s of spellings) expect(await oneTry(s), `${s} is the same owner`).toMatch(/LOST/);
    } finally {
      await h.kill();
    }
    expect(spellings.length, "the spellings judged (the case variant only where the volume folds case)").toBeGreaterThanOrEqual(process.platform === "win32" ? 1 : 2);
  }, 60_000);

  type Acquire = (p: string, o?: { verifyCreated?: (p: string) => void }) => Promise<{ release(): void }>;
  const refuse = () => {
    throw new Error("refused by verify");
  };
  it("a DB the acquire just CREATED, refused by its verify, is REMOVED (provably its own: same dev + ino, empty), and the refusal stands", async () => {
    const { acquirePrimitive } = (await import("../dist/db-owner-lock.js")) as { acquirePrimitive: Acquire };
    const db = path.join(ROOT, "refused-new.db");
    await expect(acquirePrimitive(db, { verifyCreated: refuse })).rejects.toThrow(/refused by verify/);
    expect(fs.existsSync(db), "the file it created is gone").toBe(false);
  }, 60_000);

  it.each([
    ["a DIFFERENT empty file replaced it (another inode)", (p: string) => { fs.renameSync(p, `${p}.moved`); fs.writeFileSync(p, ""); }],
    ["its own file is no longer EMPTY", (p: string) => fs.appendFileSync(p, "x")],
  ])("twin: NOT removed when %s, and the refusal says so", async (_label, meddle) => {
    const { acquirePrimitive } = (await import("../dist/db-owner-lock.js")) as { acquirePrimitive: Acquire };
    const db = path.join(ROOT, `kept-${Math.random().toString(36).slice(2)}.db`);
    await expect(acquirePrimitive(db, { verifyCreated: (p) => { meddle(p); refuse(); } })).rejects.toThrow(/refused by verify.*NOT removed/);
    expect(fs.existsSync(db), "a file not provably its own is left in place").toBe(true);
  }, 60_000);

  it("twin: a DB that already EXISTED is never verified as created (nor removed)", async () => {
    const { acquirePrimitive } = (await import("../dist/db-owner-lock.js")) as { acquirePrimitive: Acquire };
    const db = path.join(ROOT, "pre-existing.db");
    fs.writeFileSync(db, "");
    let called = false;
    const lock = await acquirePrimitive(db, { verifyCreated: () => { called = true; refuse(); } });
    lock.release();
    expect(called, "verifyCreated ran on a DB this call did not create").toBe(false);
    expect(fs.existsSync(db)).toBe(true);
  }, 60_000);

  async function probeRound(db: string, tag: string): Promise<string[]> {
    const go = path.join(ROOT, `go-probe-${tag}`);
    const probers = Array.from({ length: RACERS }, () => run(PROBER, [db, go]));
    await new Promise((res) => setTimeout(res, 150));
    fs.writeFileSync(go, "");
    return (await Promise.all(probers.map((x) => x.out))).flatMap((o) => o.trim().split(" "));
  }
  it(`native PROBERS racing each other (${RACERS} x 5 probes, 5 rounds) with NO owner never see one`, async () => {
    const db = path.join(ROOT, "probe-free.db");
    fs.writeFileSync(db, "");
    const seen: string[] = [];
    for (let r = 0; r < 5; r++) seen.push(...(await probeRound(db, `free-${r}`)));
    expect(seen.filter((s) => s !== "FREE"), `false "owned" among ${seen.length} probes`).toEqual([]);
    expect(seen.length).toBe(5 * RACERS * 5);
  }, 120_000);

  it(`twin: with an owner ALIVE, every racing prober sees it`, async () => {
    const db = path.join(ROOT, "probe-held.db");
    fs.writeFileSync(db, "");
    const h = await holding(db);
    try {
      const seen = await probeRound(db, "held");
      expect(seen.filter((s) => s !== "OWNED"), `"free" among ${seen.length} probes of a held DB`).toEqual([]);
      expect(seen.length).toBe(RACERS * 5);
    } finally {
      await h.kill();
    }
  }, 60_000);

  /** Start RACERS loopers (gap ms between probes; 0 = a tight loop) and wait until EVERY one has probed once. */
  async function startLoopers(db: string, stop: string, gapMs: number) {
    const loopers = Array.from({ length: RACERS }, () => run(LOOPER, [db, stop, String(gapMs)]));
    await Promise.all(
      loopers.map(
        (x) =>
          new Promise<void>((res, rej) => {
            let buf = "";
            const t = setTimeout(() => rej(new Error("precondition: a looper did not start probing within 30 s")), 30_000);
            x.child.stdout!.on("data", (d) => {
              buf += d;
              if (buf.includes("SPIN")) {
                clearTimeout(t);
                res();
              }
            });
          })
      )
    );
    const t0 = performance.now();
    return {
      async stop() {
        fs.writeFileSync(stop, "");
        const counts = (await Promise.all(loopers.map((x) => x.out))).map((o) => Number(/COUNT (\d+)/.exec(o)?.[1] ?? 0));
        return { counts, seconds: (performance.now() - t0) / 1000 };
      },
    };
  }
  async function acquireRounds(db: string): Promise<string[]> {
    const results: string[] = [];
    for (let r = 0; r < 10; r++) results.push((await run(ACQUIRER, [db]).out).trim());
    return results;
  }

  const GATING_GAP_MS = 50; // 20 probes/s per looper, x8 = 160/s (ASSUMED; see the header)
  it(`GATING: with ${RACERS} probers at 20 probes/s each, an acquirer takes the lock within its budget in each of 10 rounds`, async () => {
    const db = path.join(ROOT, "probe-gating.db");
    fs.writeFileSync(db, "");
    const storm = await startLoopers(db, path.join(ROOT, "stop-gating"), GATING_GAP_MS);
    let results: string[] = [];
    let rate = { counts: [] as number[], seconds: 0 };
    try {
      results = await acquireRounds(db);
    } finally {
      rate = await storm.stop();
    }
    const total = rate.counts.reduce((a, b) => a + b, 0);
    const perSecond = total / rate.seconds;
    process.stdout.write(`gating probe load: ${perSecond.toFixed(0)} probes/s achieved (target 160); acquirer ${results.join(" | ")}\n`);
    expect(perSecond, "precondition: the probe load reached at least half its target (else the bar is vacuous)").toBeGreaterThanOrEqual(80);
    expect(results.filter((x) => !x.startsWith("OWNER ")), "an acquirer starved at the gating probe rate").toEqual([]);
  }, 120_000);

  it.skipIf(!process.env.INV_DB_01_STORM)(`REPORT-ONLY: a tight-loop probe storm (${RACERS} loopers): how many of 10 acquire rounds were starved`, async () => {
    const db = path.join(ROOT, "probe-storm.db");
    fs.writeFileSync(db, "");
    const storm = await startLoopers(db, path.join(ROOT, "stop-storm"), 0);
    let results: string[] = [];
    let rate = { counts: [] as number[], seconds: 0 };
    try {
      results = await acquireRounds(db);
    } finally {
      rate = await storm.stop();
    }
    const starved = results.filter((x) => !x.startsWith("OWNER ")).length;
    // A known liveness limit, measured and reported; it never gates.
    process.stdout.write(
      `adversarial probe storm (report-only): starved ${starved}/10 rounds; acquirer ms ${results.map((x) => x.split(" ").slice(0, 2).join(" ")).join(" | ")}; ` +
        `probes per looper ${rate.counts.join(",")} in ${rate.seconds.toFixed(1)} s\n`
    );
  }, 120_000);

  it("a probe CREATES nothing: in a read-only HOME with no locks dir it answers FREE, and no locks dir appears", async () => {
    const m = (await import("../dist/db-owner-lock.js")) as unknown as { isOwnedElsewhere: (p: string) => Promise<boolean> };
    const ro = path.join(ROOT, "ro-home");
    fs.mkdirSync(ro);
    const db = path.join(ROOT, "ro.db");
    fs.writeFileSync(db, "");
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = ro;
    process.env.USERPROFILE = ro;
    fs.chmodSync(ro, 0o500);
    try {
      expect(await m.isOwnedElsewhere(db)).toBe(false);
      expect(fs.existsSync(path.join(ro, ".bot-relay")), "the probe created the lock directory").toBe(false);
    } finally {
      fs.chmodSync(ro, 0o700);
      process.env.HOME = saved.HOME;
      process.env.USERPROFILE = saved.USERPROFILE;
    }
  }, 60_000);

  type Probe = {
    isOwnedElsewhere: (p: string) => Promise<boolean>;
    PROBE_TIMEOUT_MS: number;
    _setProbeConnectForTests: (fn: ((name: string) => net.Socket) | null) => void;
  };
  it("a probe of a DB with NO owner answers FREE within the probe bound (an absent socket or pipe never blocks)", async () => {
    const m = (await import("../dist/db-owner-lock.js")) as unknown as Probe;
    expect(typeof m.PROBE_TIMEOUT_MS, "the probe has an explicit bound").toBe("number");
    const db = path.join(ROOT, "probe-absent.db");
    fs.writeFileSync(db, "");
    const ms: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      expect(await m.isOwnedElsewhere(db)).toBe(false);
      ms.push(Math.round(performance.now() - t));
    }
    process.stdout.write(`absent-owner probe ms (bound ${m.PROBE_TIMEOUT_MS}): ${ms.join(",")}\n`);
    expect(Math.max(...ms)).toBeLessThan(m.PROBE_TIMEOUT_MS);
  }, 60_000);

  it.skipIf(process.platform === "darwin")("twin (where the probe CONNECTS): a connect that never answers is a NAMED refusal at the bound, never FREE", async () => {
    const m = (await import("../dist/db-owner-lock.js")) as unknown as Probe;
    const db = path.join(ROOT, "probe-silent.db");
    fs.writeFileSync(db, "");
    m._setProbeConnectForTests(() => new net.Socket()); // never connects, never errors
    try {
      const t = performance.now();
      await expect(m.isOwnedElsewhere(db)).rejects.toThrow(/could not tell within \d+ ms whether a wasm-driver process owns/);
      const el = performance.now() - t;
      expect(el, "it waited for the bound").toBeGreaterThanOrEqual(m.PROBE_TIMEOUT_MS - 50);
      expect(el, "and not much longer").toBeLessThan(m.PROBE_TIMEOUT_MS + 2000);
    } finally {
      m._setProbeConnectForTests(null);
    }
  }, 60_000);

  it("two processes with DIFFERENT HOMEs (one in a minimal, launchd-like env) on one DB: exactly ONE owner", async () => {
    const db = path.join(ROOT, "two-homes.db");
    fs.writeFileSync(db, "");
    const other = path.join(ROOT, "other-home");
    fs.mkdirSync(other, { recursive: true });
    const minimal: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: other,
      USERPROFILE: other,
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const h = await holding(db);
    try {
      const go = path.join(ROOT, "go-two-homes");
      fs.writeFileSync(go, "");
      expect(await run(RACER, [db, go, "0"], minimal).out, "a process with another HOME is the same contender").toMatch(/LOST/);
    } finally {
      await h.kill();
    }
  }, 60_000);

  it.skipIf(process.platform !== "darwin")("macOS: the lock is ONE dotfile in the DB's REAL parent dir (0600), whatever the spelling, never under HOME", async () => {
    const realDir = path.join(ROOT, "lf-real");
    const linkDir = path.join(ROOT, "lf-link");
    fs.mkdirSync(realDir);
    fs.mkdirSync(linkDir);
    const db = path.join(realDir, "Lf.db");
    fs.writeFileSync(db, "");
    const link = path.join(linkDir, "via-link.db");
    fs.symlinkSync(db, link);
    const h = await holding(link);
    try {
      const lf = path.join(fs.realpathSync.native(realDir), ".Lf.db.relay-owner");
      expect(fs.existsSync(lf), "the lock file sits beside the canonical DB").toBe(true);
      expect(fs.statSync(lf).mode & 0o777, "and is private").toBe(0o600);
      expect(fs.readdirSync(linkDir).filter((f) => f.includes("relay-owner")), "nothing beside the link").toEqual([]);
      expect(fs.existsSync(path.join(HOME, ".bot-relay", "locks")), "nothing under HOME").toBe(false);
      expect(await oneTry(db), "the canonical spelling is the same owner").toMatch(/LOST/);
    } finally {
      await h.kill();
    }
  }, 60_000);

  it.skipIf(process.platform !== "darwin")("macOS: a PLANTED lock file that is not private (a wider mode, a symlink) is a NAMED refusal, for an acquire and a probe", async () => {
    const m = (await import("../dist/db-owner-lock.js")) as unknown as {
      acquirePrimitive: (p: string, o?: { attempts?: number }) => Promise<{ release(): void }>;
      isOwnedElsewhere: (p: string) => Promise<boolean>;
    };
    const dir = path.join(ROOT, "planted");
    fs.mkdirSync(dir);
    const wide = path.join(dir, "Wide.db");
    fs.writeFileSync(wide, "");
    fs.writeFileSync(path.join(dir, ".Wide.db.relay-owner"), "");
    fs.chmodSync(path.join(dir, ".Wide.db.relay-owner"), 0o644);
    await expect(m.acquirePrimitive(wide, { attempts: 1 })).rejects.toThrow(/owner lock file .* is not private/);
    await expect(m.isOwnedElsewhere(wide)).rejects.toThrow(/owner lock file .* is not private/);
    const linked = path.join(dir, "Linked.db");
    fs.writeFileSync(linked, "");
    fs.symlinkSync(path.join(ROOT, "elsewhere"), path.join(dir, ".Linked.db.relay-owner"));
    await expect(m.acquirePrimitive(linked, { attempts: 1 })).rejects.toThrow(/owner lock file .* is not private|is a symlink/);
    await expect(m.isOwnedElsewhere(linked)).rejects.toThrow(/owner lock file .* is not private|is a symlink/);
    expect(fs.existsSync(path.join(ROOT, "elsewhere")), "nothing was created through the planted symlink").toBe(false);
  }, 60_000);

  const canSudo = process.platform === "darwin" && !!process.env.CI && spawnSync("sudo", ["-n", "true"]).status === 0;
  it.skipIf(!canSudo)("macOS CI: a PLANTED lock file owned by ANOTHER user (root) is a NAMED refusal", async () => {
    const m = (await import("../dist/db-owner-lock.js")) as unknown as {
      acquirePrimitive: (p: string, o?: { attempts?: number }) => Promise<{ release(): void }>;
      isOwnedElsewhere: (p: string) => Promise<boolean>;
    };
    const dir = path.join(ROOT, "foreign");
    fs.mkdirSync(dir);
    const db = path.join(dir, "F.db");
    fs.writeFileSync(db, "");
    const lf = path.join(dir, ".F.db.relay-owner");
    fs.writeFileSync(lf, "");
    fs.chmodSync(lf, 0o600);
    expect(spawnSync("sudo", ["-n", "chown", "0", lf]).status, "chown to root").toBe(0);
    await expect(m.acquirePrimitive(db, { attempts: 1 })).rejects.toThrow(/owner lock file .* is not private/);
    await expect(m.isOwnedElsewhere(db)).rejects.toThrow(/owner lock file .* is not private/);
  }, 60_000);

  const canBindMount = process.platform === "linux" && !!process.env.CI && spawnSync("sudo", ["-n", "true"]).status === 0;
  it.skipIf(!canBindMount)("Linux CI: a BIND MOUNT of the DB's directory names ONE owner (the parent directory's identity collapses it)", async () => {
    const src = path.join(ROOT, "bind-src");
    const dst = path.join(ROOT, "bind-dst");
    fs.mkdirSync(src);
    fs.mkdirSync(dst);
    fs.writeFileSync(path.join(src, "b.db"), "");
    expect(spawnSync("sudo", ["-n", "mount", "--bind", src, dst]).status, "mount --bind").toBe(0);
    try {
      const h = await holding(path.join(src, "b.db"));
      try {
        expect(await oneTry(path.join(dst, "b.db")), "the same DB through the bind mount is the same owner").toMatch(/LOST/);
      } finally {
        await h.kill();
      }
    } finally {
      spawnSync("sudo", ["-n", "umount", dst]);
    }
  }, 60_000);
});

describe("INV-DB-01: the enable gate, judged for ANY platform (so it runs on every OS)", () => {
  type Gate = {
    MEASURED_PLATFORMS: ReadonlySet<string>;
    assertPlatformEnabled: (p?: string) => void;
    acquireOwnerLock: (p: string, o?: { platform?: string }) => Promise<{ release(): void }>;
  };
  const lockFiles = () => {
    const d = path.join(HOME, ".bot-relay", "locks");
    return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
  };
  it("a platform NOT measured (freebsd) is refused by name, before anything is materialized or locked", async () => {
    const m = (await import("../dist/db-owner-lock.js")) as unknown as Gate;
    expect(m.MEASURED_PLATFORMS.has("freebsd"), "precondition: freebsd is not enabled").toBe(false);
    expect(() => m.assertPlatformEnabled("freebsd")).toThrow(/wasm writes are refused on freebsd: .*not been measured.*native driver/);
    const db = path.join(ROOT, "gate-freebsd.db");
    const before = lockFiles();
    await expect(m.acquireOwnerLock(db, { platform: "freebsd" })).rejects.toThrow(/wasm writes are refused on freebsd/);
    expect(fs.existsSync(db), "the DB was materialized").toBe(false);
    expect(lockFiles(), "a lock file was written").toEqual(before);
    expect(fs.existsSync(path.join(ROOT, ".gate-freebsd.db.relay-owner")), "a lock file was written beside the DB").toBe(false);
  });

  it.each(["darwin", "linux", "win32"])("twin: %s (measured green in CI) is enabled", async (platform) => {
    const m = (await import("../dist/db-owner-lock.js")) as unknown as Gate;
    expect(() => m.assertPlatformEnabled(platform)).not.toThrow();
  });
});
