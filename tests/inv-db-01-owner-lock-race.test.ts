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
 * - a DB the acquire just CREATED (materialized from its first image, linked into place) and its caller's verify
 *   refuses is removed only when it is provably that file (the same dev + ino and size as the created one);
 * - processes with DIFFERENT HOMEs (one in a minimal, launchd-like env) on one DB: exactly one owner; on macOS the lock
 *   is ONE dotfile in the DB's real parent dir (0600), whatever the spelling, and a planted one that is not private
 *   (a wider mode, a symlink, another owner) is a named refusal.
 * Ported from the INV-DB-01 single-owner draft (slice 2b-ii). Its native-PROBE rows are not here: under slice 2b's
 * design a native process does not probe (an RLYW header refuses it), so that probe is not in the module.
 * The racers run from FILES (an eval'd module breaks worker pools), under a SANDBOX HOME; every recorded child is
 * checked exited at the end.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "fs";
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
// 20 in CI; a local burst may lower it (INV_DB_01_RACE_ROUNDS) to fit a bounded run, and says so in its report.
const ROUNDS = Number(process.env.INV_DB_01_RACE_ROUNDS ?? 20);
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
    `try { await acquirePrimitive(db, { attempts: 1, initialBytes: new Uint8Array() }); process.stdout.write("OWNER\\n"); await new Promise((r) => setTimeout(r, Number(hold))); }\n` +
    `catch (e) { process.stdout.write("LOST " + (e.name || e.code) + " " + String(e && e.message || "").split("\\n")[0].slice(0, 1000) + "\\n"); }\n` +
    `process.exit(0);\n`
);
const HOLDER = path.join(ROOT, "holder.mjs");
fs.writeFileSync(
  HOLDER,
  `const { acquirePrimitive } = await import(${JSON.stringify(LOCK_JS)});\n` +
    `await acquirePrimitive(process.argv[2], { initialBytes: new Uint8Array() }); process.stdout.write("HELD\\n"); setInterval(() => {}, 1000);\n`
);
const HOLDER_PID = path.join(ROOT, "holder-pid.mjs");
fs.writeFileSync(
  HOLDER_PID,
  `const { acquirePrimitive } = await import(${JSON.stringify(LOCK_JS)});\n` +
    `await acquirePrimitive(process.argv[2], { initialBytes: new Uint8Array() }); process.stdout.write("HELD " + process.pid + "\\n"); setInterval(() => {}, 1000);\n`
);
// A holder that, AFTER taking the lock, spawns an UNRELATED long-lived child (no stdio passed): the lock's descriptor
// must not be inherited by it (O_CLOEXEC), or that child would keep the lock after the holder dies.
const HOLDER_SPAWNS = path.join(ROOT, "holder-spawns.mjs");
fs.writeFileSync(
  HOLDER_SPAWNS,
  `const { acquirePrimitive } = await import(${JSON.stringify(LOCK_JS)});\n` +
    `const { spawn } = await import("child_process");\n` +
    `await acquirePrimitive(process.argv[2], { initialBytes: new Uint8Array() });\n` +
    `const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true }); c.unref();\n` +
    `process.stdout.write("HELD " + process.pid + " " + c.pid + "\\n"); setInterval(() => {}, 1000);\n`
);
// Ruling 75be90fa (4): a SECOND open + close of the lock file in the owner's own process must not release the lock
// (a flock belongs to its open file; an fcntl lock would be dropped by that close).
const HOLDER_REOPENS = path.join(ROOT, "holder-reopens.mjs");
fs.writeFileSync(
  HOLDER_REOPENS,
  `const { acquirePrimitive, lockFilePath } = await import(${JSON.stringify(LOCK_JS)});\n` +
    `const fs = await import("fs");\n` +
    `await acquirePrimitive(process.argv[2], { initialBytes: new Uint8Array() });\n` +
    `fs.closeSync(fs.openSync(lockFilePath(process.argv[2]), "r"));\n` +
    `process.stdout.write("HELD\\n"); setInterval(() => {}, 1000);\n`
);
const ACQUIRER = path.join(ROOT, "acquirer.mjs");
fs.writeFileSync(
  ACQUIRER,
  `const { acquirePrimitive } = await import(${JSON.stringify(LOCK_JS)});\n` +
    `const t = performance.now();\n` +
    `try { const l = await acquirePrimitive(process.argv[2], { initialBytes: new Uint8Array() }); process.stdout.write("OWNER " + Math.round(performance.now() - t) + "\\n"); l.release(); }\n` +
    `catch (e) { process.stdout.write("LOST " + Math.round(performance.now() - t) + " " + e.message + "\\n"); }\n` +
    `process.exit(0);\n`
);
const env = { ...process.env, HOME, USERPROFILE: HOME };

function run(file: string, args: string[], envFor: NodeJS.ProcessEnv = env, asCommand = false): { child: ChildProcess; out: Promise<string>; stderr: () => string } {
  // asCommand: `file` is the program itself (e.g. sudo), not a script for this node.
  const child = asCommand
    ? spawn(file, args, { env: envFor, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(process.execPath, [file, ...args], { env: envFor, stdio: ["ignore", "pipe", "pipe"] });
  recorded.push(child);
  let buf = "";
  let errBuf = "";
  child.stdout!.on("data", (d) => (buf += d));
  child.stderr!.on("data", (d) => (errBuf += d));
  // "close", not "exit": a child can exit before its stdout is drained, and the LAST line (a COUNT, an OWNER) would be lost.
  return { child, out: new Promise((res) => child.on("close", () => res(buf))), stderr: () => errBuf };
}
async function holding(db: string): Promise<{ kill: () => Promise<void> }> {
  const h = run(HOLDER, [db]);
  // Bounded: a holder that dies (or never acquires) fails the row with its stderr, never hangs it.
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`precondition: the holder did not hold within 30 s\n${h.stderr()}`)), 30_000);
    h.child.stdout!.on("data", (d) => String(d).includes("HELD") && (clearTimeout(t), res()));
    h.child.once("exit", (code, sig) => (clearTimeout(t), rej(new Error(`precondition: the holder exited (${code ?? sig}) before holding\n${h.stderr()}`))));
  });
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

  it.skipIf(process.platform === "win32")("the lock is NEVER inherited by another child of the owner: the owner killed -9, its unrelated child still alive, a racer owns it within 2 s", async () => {
    const db = path.join(ROOT, "no-inherit.db");
    const h = run(HOLDER_SPAWNS, [db]);
    const [holderPid, childPid] = await new Promise<[number, number]>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`precondition: the holder did not hold within 30 s\n${h.stderr()}`)), 30_000);
      h.child.stdout!.on("data", (d) => {
        const m = /HELD (\d+) (\d+)/.exec(String(d));
        if (m) {
          clearTimeout(t);
          res([Number(m[1]), Number(m[2])]);
        }
      });
    });
    try {
      expect(await oneTry(db), "precondition: held").toMatch(/^LOST OwnerLockError .*held by another process/);
      process.kill(holderPid, "SIGKILL");
      await h.out;
      expect(() => process.kill(childPid, 0), "precondition: the unrelated child is still alive").not.toThrow();
      const t0 = Date.now();
      let got = "";
      while (Date.now() - t0 < 2000) {
        got = await oneTry(db);
        if (got.startsWith("OWNER")) break;
      }
      expect(got, "the lock went with the owner, not with its child").toMatch(/^OWNER/);
    } finally {
      try {
        process.kill(childPid, "SIGKILL"); // the recorded pid
      } catch {
        /* already gone */
      }
    }
  }, 60_000);

  it.skipIf(process.platform === "win32")("a flock run that FAILS (here: it cannot even start on a bad descriptor) is a named refusal, never an acquire (ruling 75be90fa: fail closed)", async () => {
    const m = (await import("../dist/db-owner-lock.js")) as unknown as { _flockFdForTests: (fd: number, file: string) => boolean };
    const f = path.join(ROOT, "flock-fails.lock");
    // A descriptor number above any process's limit, so it can never name an open file. A just-closed number made this
    // row return instead of throw on Linux CI (MEASURED); the likely cause (ASSUMED): another open in the test worker
    // reused the number, and flock locked that file.
    const fd = 1_000_000;
    expect(() => m._flockFdForTests(fd, f)).toThrow(/could not be locked: the system flock failed/);
  });

  it.skipIf(process.platform === "win32")("the DB's canonical path MOVES while the lock is taken: the acquire re-derives the key and ends holding the lock of the path's CURRENT file", async () => {
    const m = (await import("../dist/db-owner-lock.js")) as unknown as {
      acquirePrimitive: (p: string, o?: { attempts?: number }) => Promise<{ release(): void }>;
      holdsOwnerLock: (p: string) => boolean;
      _setAfterAcquireHookForTests: (fn: (() => void) | null) => void;
    };
    const db = path.join(ROOT, "rederive.db");
    const otherDir = path.join(ROOT, "rederive-elsewhere");
    fs.mkdirSync(otherDir, { recursive: true });
    const moved = path.join(otherDir, "moved.db");
    fs.writeFileSync(db, "");
    fs.writeFileSync(moved, "");
    let once = true;
    m._setAfterAcquireHookForTests(() => {
      if (!once) return;
      once = false;
      fs.rmSync(db);
      fs.symlinkSync(moved, db); // the name now resolves to another file, in another directory
    });
    try {
      const lock = await m.acquirePrimitive(db, { attempts: 5 });
      expect(m.holdsOwnerLock(db), "held under the CURRENT canonical file's key").toBe(true);
      lock.release();
    } finally {
      m._setAfterAcquireHookForTests(null);
    }
  }, 60_000);

  it.skipIf(process.platform === "win32")("a second open + close of the lock file in the OWNER's process does not release it: a racer still loses", async () => {
    const db = path.join(ROOT, "reopen.db");
    const h = run(HOLDER_REOPENS, [db]);
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`precondition: the holder did not hold within 30 s\n${h.stderr()}`)), 30_000);
      h.child.stdout!.on("data", (d) => String(d).includes("HELD") && (clearTimeout(t), res()));
    });
    try {
      expect(await oneTry(db), "still held after the owner's own open + close").toMatch(/^LOST OwnerLockError .*held by another process/);
    } finally {
      h.child.kill("SIGKILL");
      await h.out;
    }
  }, 60_000);

  // Non-vacuity twin: the SAME probe on an fcntl lock (python's lockf) does see the release (the hazard ruled out above).
  const hasPy = process.platform !== "win32" && spawnSync("python3", ["-c", "import fcntl"]).status === 0;
  it.skipIf(!hasPy)("twin: the same open + close DOES drop an fcntl (lockf) lock, and the probe sees it", async () => {
    const f = path.join(ROOT, "fcntl-twin.lock");
    fs.writeFileSync(f, "");
    const holder = spawn("python3", ["-c", [
      "import fcntl, os, sys, time",
      "fd = os.open(sys.argv[1], os.O_RDWR)",
      "fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
      "os.close(os.open(sys.argv[1], os.O_RDONLY))",
      "print('HELD', flush=True)",
      "time.sleep(60)",
    ].join("\n"), f], { stdio: ["ignore", "pipe", "pipe"] });
    recorded.push(holder);
    await new Promise<void>((res) => holder.stdout!.on("data", (d) => String(d).includes("HELD") && res()));
    try {
      const probe = spawnSync("python3", ["-c", [
        "import fcntl, os, sys",
        "fd = os.open(sys.argv[1], os.O_RDWR)",
        "try:\n  fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); print('OWNER')\nexcept OSError: print('LOST')",
      ].join("\n"), f], { encoding: "utf8" });
      expect(probe.stdout.trim(), "the fcntl lock was dropped by its holder's own open + close").toBe("OWNER");
    } finally {
      holder.kill("SIGKILL");
    }
  }, 60_000);

  it.skipIf(process.platform !== "linux")("R2 P1-1 (ruling 2b0d70f8: fail closed): Linux with NO trusted flock refuses owner mode by name, with the remedies; no owner of any other kind", async () => {
    const m = (await import("../dist/db-owner-lock.js")) as unknown as {
      acquirePrimitive: (p: string, o?: { initialBytes?: Uint8Array; attempts?: number }) => Promise<{ release(): void }>;
      _setLinuxSchemeForTests: (s: "flock" | "socket" | null) => void;
    };
    const db = path.join(ROOT, "no-flock.db");
    fs.writeFileSync(db, "");
    m._setLinuxSchemeForTests("socket"); // = no trusted flock on this host
    try {
      await expect(m.acquirePrimitive(db, { attempts: 1 })).rejects.toThrow(/no trusted system .?flock.*(util-linux|native driver|HTTP)/is);
    } finally {
      m._setLinuxSchemeForTests(null);
    }
  });

  it.skipIf(process.platform !== "linux")("R2 P2-4: statfs judges the CANONICAL directory (an alias in a local dir to a DB on a network filesystem is refused), and a statfs ERROR refuses", async () => {
    const m = (await import("../dist/db-owner-lock.js")) as unknown as { acquirePrimitive: (p: string, o?: { attempts?: number }) => Promise<{ release(): void }> };
    const remoteDir = path.join(ROOT, "pretend-nfs");
    const localDir = path.join(ROOT, "local-side");
    fs.mkdirSync(remoteDir, { recursive: true });
    fs.mkdirSync(localDir, { recursive: true });
    const target = path.join(remoteDir, "relay.db");
    fs.writeFileSync(target, "");
    const alias = path.join(localDir, "relay.db");
    fs.symlinkSync(target, alias);
    const remoteReal = fs.realpathSync.native(remoteDir);
    const real = fs.statfsSync;
    let spy = vi.spyOn(fs, "statfsSync").mockImplementation(((p: fs.PathLike, o?: unknown) => {
      const st = (real as (...a: unknown[]) => fs.StatsFs)(p, o);
      return fs.realpathSync.native(String(p)) === remoteReal ? { ...st, type: 0x6969 } : st;
    }) as typeof fs.statfsSync);
    try {
      await expect(m.acquirePrimitive(alias, { attempts: 1 })).rejects.toThrow(/network filesystem/);
    } finally {
      spy.mockRestore();
    }
    spy = vi.spyOn(fs, "statfsSync").mockImplementation((() => {
      throw Object.assign(new Error("EIO: i/o error, statfs"), { code: "EIO" });
    }) as typeof fs.statfsSync);
    try {
      await expect(m.acquirePrimitive(target, { attempts: 1 })).rejects.toThrow(/filesystem .*(EIO|could not be determined)/i);
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(process.platform !== "linux")("Linux: a DB on a NETWORK filesystem (statfs says NFS) is refused owner mode, by name, before anything is locked", async () => {
    const m = (await import("../dist/db-owner-lock.js")) as unknown as { acquirePrimitive: (p: string, o?: { initialBytes?: Uint8Array }) => Promise<{ release(): void }> };
    const db = path.join(ROOT, "on-nfs.db");
    const real = fs.statfsSync;
    const spy = vi.spyOn(fs, "statfsSync").mockImplementation(((p: fs.PathLike, o?: unknown) => ({ ...(real as (...a: unknown[]) => fs.StatsFs)(p, o), type: 0x6969 })) as typeof fs.statfsSync);
    try {
      await expect(m.acquirePrimitive(db, { initialBytes: new Uint8Array() })).rejects.toThrow(/network filesystem .*(NFS|0x6969)/i);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(db), "nothing was materialized").toBe(false);
  });

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
    // The case variant is the SAME FILE when stat says so (dev + ino), judged independently of realpath: the lock must
    // then collapse it, whatever spelling realpath gives (Codex #385 R1: a realpath-conditioned row proves nothing).
    const caseVariant = path.join(dir, "ALIAS.DB");
    const same = (a: string, b: string) => {
      try {
        const x = fs.statSync(a, { bigint: true });
        const y = fs.statSync(b, { bigint: true });
        return x.dev === y.dev && x.ino === y.ino;
      } catch {
        return false;
      }
    };
    if (same(caseVariant, db)) spellings.push(caseVariant);
    const h = await holding(db);
    try {
      // The SPECIFIC contention refusal (not any caught error).
      for (const s of spellings) expect(await oneTry(s), `${s} is the same owner`).toMatch(/^LOST OwnerLockError .*held by another process/);
    } finally {
      await h.kill();
    }
    // Twin: with no holder, every spelling ACQUIRES (the refusals above were the lock, not a broken spelling).
    for (const s of spellings) expect(await oneTry(s), `${s} acquires when unlocked`).toMatch(/^OWNER/);
    expect(spellings.length, "the spellings judged (the case variant only where the volume folds case)").toBeGreaterThanOrEqual(process.platform === "win32" ? 1 : 2);
  }, 60_000);

  type Acquire = (p: string, o?: { verifyCreated?: (p: string) => void; initialBytes?: Uint8Array }) => Promise<{ release(): void }>;
  const FIRST = new Uint8Array([1, 2, 3]); // a first image (its content is not this row's subject)
  const refuse = () => {
    throw new Error("refused by verify");
  };
  it("a DB the acquire just CREATED, refused by its verify, is REMOVED (provably its own: same dev + ino and size), and the refusal stands", async () => {
    const { acquirePrimitive } = (await import("../dist/db-owner-lock.js")) as { acquirePrimitive: Acquire };
    const db = path.join(ROOT, "refused-new.db");
    await expect(acquirePrimitive(db, { verifyCreated: refuse, initialBytes: FIRST })).rejects.toThrow(/refused by verify/);
    expect(fs.existsSync(db), "the file it created is gone").toBe(false);
  }, 60_000);

  it.each([
    ["a DIFFERENT file replaced it (another inode)", (p: string) => { fs.renameSync(p, `${p}.moved`); fs.writeFileSync(p, "abc"); }],
    ["its own file CHANGED size", (p: string) => fs.appendFileSync(p, "x")],
  ])("twin: NOT removed when %s, and the refusal says so", async (_label, meddle) => {
    const { acquirePrimitive } = (await import("../dist/db-owner-lock.js")) as { acquirePrimitive: Acquire };
    const db = path.join(ROOT, `kept-${Math.random().toString(36).slice(2)}.db`);
    await expect(acquirePrimitive(db, { initialBytes: FIRST, verifyCreated: (p) => { meddle(p); refuse(); } })).rejects.toThrow(/refused by verify.*NOT removed/);
    expect(fs.existsSync(db), "a file not provably its own is left in place").toBe(true);
  }, 60_000);

  it("twin: a DB that already EXISTED is never verified as created (nor removed)", async () => {
    const { acquirePrimitive } = (await import("../dist/db-owner-lock.js")) as { acquirePrimitive: Acquire };
    const db = path.join(ROOT, "pre-existing.db");
    fs.writeFileSync(db, "");
    let called = false;
    const lock = await acquirePrimitive(db, { initialBytes: FIRST, verifyCreated: () => { called = true; refuse(); } });
    lock.release();
    expect(called, "verifyCreated ran on a DB this call did not create").toBe(false);
    expect(fs.existsSync(db)).toBe(true);
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

  it.skipIf(process.platform !== "darwin")("macOS: a PLANTED lock file that is not private (a wider mode, a symlink) is a NAMED refusal for an acquire", async () => {
    const m = (await import("../dist/db-owner-lock.js")) as unknown as {
      acquirePrimitive: (p: string, o?: { attempts?: number }) => Promise<{ release(): void }>;
    };
    const dir = path.join(ROOT, "planted");
    fs.mkdirSync(dir);
    const wide = path.join(dir, "Wide.db");
    fs.writeFileSync(wide, "");
    fs.writeFileSync(path.join(dir, ".Wide.db.relay-owner"), "");
    fs.chmodSync(path.join(dir, ".Wide.db.relay-owner"), 0o644);
    await expect(m.acquirePrimitive(wide, { attempts: 1 })).rejects.toThrow(/owner lock file .* is not private/);
    const linked = path.join(dir, "Linked.db");
    fs.writeFileSync(linked, "");
    fs.symlinkSync(path.join(ROOT, "elsewhere"), path.join(dir, ".Linked.db.relay-owner"));
    await expect(m.acquirePrimitive(linked, { attempts: 1 })).rejects.toThrow(/owner lock file .* is not private|is a symlink/);
    expect(fs.existsSync(path.join(ROOT, "elsewhere")), "nothing was created through the planted symlink").toBe(false);
    // A lock file that EXISTS but cannot be opened (mode 000, so even its owner gets EACCES) is the same named refusal.
    const shut = path.join(dir, "Shut.db");
    fs.writeFileSync(shut, "");
    fs.writeFileSync(path.join(dir, ".Shut.db.relay-owner"), "");
    fs.chmodSync(path.join(dir, ".Shut.db.relay-owner"), 0o000);
    try {
      await expect(m.acquirePrimitive(shut, { attempts: 1 })).rejects.toThrow(/owner lock file .* is not private/);
    } finally {
      fs.chmodSync(path.join(dir, ".Shut.db.relay-owner"), 0o600);
    }
  }, 60_000);

  it.skipIf(process.platform !== "darwin")("macOS: a READ-ONLY DB directory with no lock file yet: an acquire is refused with the CREATE message, and nothing is created", async () => {
    const m = (await import("../dist/db-owner-lock.js")) as unknown as {
      acquirePrimitive: (p: string, o?: { attempts?: number }) => Promise<{ release(): void }>;
    };
    const dir = path.join(ROOT, "ro-db-dir");
    fs.mkdirSync(dir);
    const db = path.join(dir, "R.db");
    fs.writeFileSync(db, "");
    fs.chmodSync(dir, 0o500);
    try {
      await expect(m.acquirePrimitive(db, { attempts: 1 })).rejects.toThrow(/cannot create the owner lock file in .*ro-db-dir/);
      expect(fs.readdirSync(dir), "nothing was created").toEqual(["R.db"]);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  }, 60_000);

  const canSudo = process.platform === "darwin" && !!process.env.CI && spawnSync("sudo", ["-n", "true"]).status === 0;
  it.skipIf(!canSudo)("macOS CI: a PLANTED lock file owned by ANOTHER user (root) is a NAMED refusal", async () => {
    const m = (await import("../dist/db-owner-lock.js")) as unknown as {
      acquirePrimitive: (p: string, o?: { attempts?: number }) => Promise<{ release(): void }>;
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
  }, 60_000);

  // Ruling 594ca4cc (Codex #385 R1 P1-2): on Linux the lock must hold ACROSS network namespaces (two containers sharing
  // the DB's directory). Each racer runs in its OWN new network namespace (sudo unshare -n), dropped back to this
  // user (setpriv), on one shared directory: exactly ONE owner per round. An abstract socket fails this (per netns).
  const canNetns = process.platform === "linux" && !!process.env.CI && spawnSync("sudo", ["-n", "true"]).status === 0 &&
    spawnSync("sudo", ["-n", "unshare", "-n", "true"]).status === 0 && spawnSync("setpriv", ["--version"]).status === 0;
  const inNetns = (file: string, args: string[]) => {
    const uid = String(process.getuid!());
    const gid = String(process.getgid!());
    return run("sudo", ["-n", "unshare", "-n", "setpriv", `--reuid=${uid}`, `--regid=${gid}`, "--clear-groups", "env", `HOME=${HOME}`, `USERPROFILE=${HOME}`, `PATH=${process.env.PATH}`, process.execPath, file, ...args], undefined, true);
  };
  it.skipIf(!canNetns)(`Linux CI: racers each in their OWN network namespace on one shared dir: exactly ONE owner in each of ${ROUNDS} rounds`, async () => {
    const db = path.join(ROOT, "netns.db");
    fs.writeFileSync(db, "");
    const owners: number[] = [];
    for (let r = 0; r < ROUNDS; r++) {
      const go = path.join(ROOT, `go-netns-${r}`);
      const racers = Array.from({ length: 4 }, () => inNetns(RACER, [db, go, "400"]));
      await new Promise((res) => setTimeout(res, 300));
      fs.writeFileSync(go, "");
      const outs = await Promise.all(racers.map((x) => x.out));
      owners.push(outs.filter((o) => o.includes("OWNER")).length);
    }
    expect(owners, "owners per round, across network namespaces").toEqual(Array(ROUNDS).fill(1));
  }, 240_000);

  it.skipIf(!canNetns)("Linux CI: a holder in one network namespace killed -9 releases within 2 s to a racer in another; no holder process is left", async () => {
    const db = path.join(ROOT, "netns-kill.db");
    fs.writeFileSync(db, "");
    fs.writeFileSync(path.join(ROOT, "go-now"), ""); // the racers below start at once
    const h = inNetns(HOLDER_PID, [db]);
    const pid = await new Promise<number>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`precondition: the holder did not hold within 30 s\n${h.stderr()}`)), 30_000);
      h.child.stdout!.on("data", (d) => {
        const m = /HELD (\d+)/.exec(String(d));
        if (m) {
          clearTimeout(t);
          res(Number(m[1]));
        }
      });
    });
    expect(await inNetns(RACER, [db, path.join(ROOT, "go-now"), "0"]).out, "precondition: held across namespaces").toMatch(/^LOST .*held by another process/);
    process.kill(pid, "SIGKILL"); // the recorded pid of the holder itself (this user's process after setpriv)
    await h.out;
    const t0 = Date.now();
    let got = "";
    while (Date.now() - t0 < 2000) {
      got = await inNetns(RACER, [db, path.join(ROOT, "go-now"), "0"]).out;
      if (got.startsWith("OWNER")) break;
    }
    expect(got, "a racer in another namespace owns it within 2 s of the kill").toMatch(/^OWNER/);
    expect(() => process.kill(pid, 0), "the holder is gone").toThrow();
    const left = spawnSync("pgrep", ["-u", String(process.getuid!()), "-x", "flock"], { encoding: "utf8" }).stdout.trim();
    expect(left, "no flock process is left behind").toBe("");
  }, 120_000);

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
    acquireOwnerLock: (p: string, o?: { platform?: string; initialBytes?: Uint8Array }) => Promise<{ release(): void }>;
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
    // With a first image: an ungated acquire WOULD materialize it, so the absence below is the gate's doing.
    await expect(m.acquireOwnerLock(db, { platform: "freebsd", initialBytes: new Uint8Array([1]) })).rejects.toThrow(/wasm writes are refused on freebsd/);
    expect(fs.existsSync(db), "the DB was materialized").toBe(false);
    expect(lockFiles(), "a lock file was written").toEqual(before);
    expect(fs.existsSync(path.join(ROOT, ".gate-freebsd.db.relay-owner")), "a lock file was written beside the DB").toBe(false);
  });

  it.each(["darwin", "linux", "win32"])("twin: %s (measured green in CI) is enabled", async (platform) => {
    const m = (await import("../dist/db-owner-lock.js")) as unknown as Gate;
    expect(() => m.assertPlatformEnabled(platform)).not.toThrow();
  });
});
