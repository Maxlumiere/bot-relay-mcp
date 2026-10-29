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
 * - Linux CI: a bind mount of the DB's directory gives one owner, when the runner can mount; otherwise UNMEASURED.
 * The racers run from FILES (an eval'd module breaks worker pools), under a SANDBOX HOME; every recorded child is
 * checked exited at the end.
 */
import { describe, it, expect, afterAll } from "vitest";
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
const PLATFORM_OK = ["darwin", "linux", "win32"].includes(process.platform);
const RACERS = 8;
const ROUNDS = 20;
const recorded: ChildProcess[] = [];
afterAll(() => {
  const alive = recorded.filter((c) => c.exitCode === null && c.signalCode === null);
  for (const c of alive) c.kill("SIGKILL");
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
const env = { ...process.env, HOME, USERPROFILE: HOME };

function run(file: string, args: string[]): { child: ChildProcess; out: Promise<string> } {
  const child = spawn(process.execPath, [file, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
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
