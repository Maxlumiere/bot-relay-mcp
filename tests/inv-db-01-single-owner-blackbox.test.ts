// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 single owner, tested from OUTSIDE (a black-box file written from the behaviour spec only, without
 * reading the implementation). Every relay here is a real `node dist/index.js` child process in its own sandbox
 * HOME, with its own RELAY_DB_PATH directory and RELAY_CONFIG_PATH; RELAY_HOME is never set.
 *
 * Three launch modes (relayEnv):
 *   - OWNER: the INSTANCE declares the wasm driver (`{"sqlite_driver":"wasm"}` in its RELAY_CONFIG_PATH file), with
 *     no RELAY_SQLITE_DRIVER in the env. Owner mode comes ONLY from this declaration.
 *   - LEGACY: env-only RELAY_SQLITE_DRIVER=wasm with a config of `{}`: the legacy wasm mode, never an owner.
 *   - NATIVE: no RELAY_SQLITE_DRIVER and a config of `{}`.
 *
 * The contract, as observed from outside:
 *   1. BIRTH STAMP: an OWNER daemon on a path with no DB creates it, and bytes 68-71 of the file read 0x524C5957
 *      ("RLYW"); its twin, a LEGACY daemon on a new path, creates an UNSTAMPED DB (bytes 68-71 read 0). The bytes
 *      are read only after every relay process on that DB has exited.
 *   2. ONE OWNER: K concurrent OWNER daemons on one DB, over several rounds (a fresh DB each): exactly one ever
 *      answers /health 200; every other one exits non-zero by itself and its stderr names the cause.
 *      Twin: K concurrent LEGACY daemons on a fresh legacy DB all answer /health (no lock), and the stamp still
 *      reads 0 after they all exit.
 *      The header decides regardless of env: a LEGACY process on an existing RLYW DB while an owner runs is
 *      refused like any contender.
 *   3. STDIO REFUSED on an RLYW DB, with and without an owner running: non-zero exit, and stderr carries an HTTP
 *      client config hint.
 *   4. ON AN RLYW DB THE HEADER DECIDES, NOT THE CONFIGURATION. A process with no wasm selector anywhere (its own
 *      config `{}`, no env):
 *      4a. a NATIVE daemon while an owner is live exits non-zero, naming the owner cause;
 *      4b. a NATIVE daemon with no owner live BECOMES the owner (answers /health), a contender is refused while it
 *          runs, and the stamp still reads RLYW after it exits;
 *      4c. a NATIVE-ONLY opener (`relay pending`, which reads the DB file directly, never through a daemon) with no
 *          daemon running exits non-zero, naming the wasm ownership with an HTTP client config hint, and leaves
 *          the DB file's bytes unchanged.
 *   5. RELEASE ON EXIT: while an owner runs a contender is refused (so the release below is not vacuous); after the
 *      owner is stopped (SIGTERM, then its exit is awaited), a new daemon becomes the owner.
 *   6. NO ACKNOWLEDGED WRITE LOST: writes acknowledged over the public HTTP API survive an owner hand-over, read back
 *      through the same API.
 *
 * Hygiene: every child is recorded at launch and killed in afterEach (SIGTERM, then SIGKILL); an orphan that
 * survives both fails the test. Every wait has a deadline. The test process never opens the DB file while a relay
 * process may hold it.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getFreePort } from "./_helpers/port.js";
import { sandboxEnv } from "./_helpers/sandbox-env.js";
import { mintSecretFor } from "./_helpers/mint.js";
import { toolCallResult } from "./_helpers/mcp-tool-call.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
/** The unified CLI (`relay <subcommand>`); it dispatches to the built dist/cli scripts. */
const BIN_RELAY = path.join(REPO_ROOT, "bin", "relay");

/** The header stamps (application_id, bytes 68-71, big-endian). */
const STAMP_WASM = 0x524c5957; // "RLYW"
const STAMP_NATIVE = 0x524c594e; // "RLYN"
const STAMP_NONE = 0; // a legacy (unstamped) DB

/** What a refused contender's stderr must name (spec item 2). */
const OWNER_CAUSE = /owned|lock|single-owner/i;
/** A copy-pasteable HTTP client config hint (spec item 3). */
const HTTP_HINT = /"type"\s*:\s*"http"|http:\/\/127\.0\.0\.1:\d+/;

/** Race shape (spec bounds: K <= 4, rounds <= 5). */
const K = 3;
const ROUNDS = 3;

/** Deadlines (ms). Every wait in this file draws from one of these. */
const HEALTH_DEADLINE = 15_000;
const EXIT_DEADLINE = 12_000;
const RACE_DEADLINE = 15_000;
const STOP_DEADLINE = 6_000;
const KILL_DEADLINE = 3_000;
const HTTP_REQUEST_TIMEOUT = 1_000;

const OUTPUT_CAP = 256 * 1024;
const IS_WINDOWS = process.platform === "win32";
const NO_GRACEFUL_STOP =
  "on Windows child.kill('SIGTERM') is TerminateProcess: there is no graceful-exit path for this step to drive";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(8, "0")}`;
const tail = (s: string, n = 1200) => (s.length > n ? `...${s.slice(-n)}` : s);

// ---------------------------------------------------------------------------------------------------------------
// Process records
// ---------------------------------------------------------------------------------------------------------------

type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };

interface Proc {
  label: string;
  child: ChildProcess;
  pid: number | undefined;
  port?: number;
  stderr: () => string;
  stdout: () => string;
  exited: () => ExitInfo | null;
  exit: Promise<ExitInfo>;
}

/** Every child this file launched, recorded at launch. afterEach empties it. */
const procs: Proc[] = [];
/** Every sandbox root this file made. afterEach removes them. */
const roots: string[] = [];

/** `argv` defaults to the relay entrypoint; a CLI launch passes its script and arguments instead. */
function launch(label: string, env: NodeJS.ProcessEnv, stdinPipe = false, argv: string[] = [DIST_INDEX]): Proc {
  expect(fs.existsSync(argv[0]!), `${argv[0]} is missing: the runner builds before tests`).toBe(true);
  const child = spawn(process.execPath, argv, {
    env,
    cwd: REPO_ROOT,
    stdio: [stdinPipe ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let err = "";
  let out = "";
  let exitInfo: ExitInfo | null = null;
  child.stderr?.on("data", (d: Buffer) => {
    if (err.length < OUTPUT_CAP) err += d.toString("utf-8");
  });
  child.stdout?.on("data", (d: Buffer) => {
    if (out.length < OUTPUT_CAP) out += d.toString("utf-8");
  });
  child.stdin?.on("error", () => {
    /* EPIPE once a refused server has exited: expected */
  });
  const exit = new Promise<ExitInfo>((resolve) => {
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
    child.once("error", (e) => {
      err += `\n[launch error] ${e.message}`;
      if (!exitInfo) {
        exitInfo = { code: -1, signal: null };
        resolve(exitInfo);
      }
    });
  });
  const p: Proc = { label, child, pid: child.pid, stderr: () => err, stdout: () => out, exited: () => exitInfo, exit };
  procs.push(p);
  return p;
}

/** The process's exit within `ms`, or null when it is still running at the deadline. */
async function waitExit(p: Proc, ms: number): Promise<ExitInfo | null> {
  const done = p.exited();
  if (done) return done;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms);
  });
  try {
    return await Promise.race([p.exit, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** SIGTERM, then await the exit; SIGKILL when the deadline passes. Returns the exit, or null if it survived both. */
async function stop(p: Proc, termMs = STOP_DEADLINE): Promise<ExitInfo | null> {
  if (p.exited()) return p.exited();
  // Signalled through the ChildProcess handle: once the child is reaped the handle is closed, so a reused pid
  // can never be signalled from here.
  try {
    p.child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  const r = await waitExit(p, termMs);
  if (r) return r;
  try {
    p.child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  return waitExit(p, KILL_DEADLINE);
}

function describeProc(p: Proc): string {
  const e = p.exited();
  const state = e ? `exited code=${e.code} signal=${e.signal}` : "STILL RUNNING";
  return `[${p.label} pid=${p.pid}${p.port ? ` port=${p.port}` : ""}] ${state}\n  stderr: ${tail(p.stderr())}`;
}

afterEach(async () => {
  const survivors: string[] = [];
  for (const p of procs.splice(0)) {
    if (p.exited()) continue;
    const r = await stop(p, KILL_DEADLINE);
    if (!r) survivors.push(describeProc(p));
  }
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best effort: a temp dir */
    }
  }
  if (survivors.length > 0) throw new Error(`orphan relay process(es) survived SIGTERM and SIGKILL:\n${survivors.join("\n")}`);
}, 30_000);

// ---------------------------------------------------------------------------------------------------------------
// Sandboxes and relay launches
// ---------------------------------------------------------------------------------------------------------------

interface Sandbox {
  home: string;
  dir: string;
  dbPath: string;
  /** The instance declaration of owner mode: `{"sqlite_driver":"wasm"}`. */
  ownerConfigPath: string;
  /** A config with no sqlite_driver key: `{}` (legacy and native launches). */
  plainConfigPath: string;
}

/** A fresh HOME, a fresh DB directory (no DB in it), and the two config files the launch modes use. */
function makeSandbox(label: string): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `inv-db-01-bb-${label}-`));
  roots.push(root);
  const home = path.join(root, "home");
  // INSIDE the sandbox HOME: the relay approves a DB path under HOME or a shared temp root, and Windows has no shared
  // root, so a DB beside HOME is refused there ("outside the approved roots"; MEASURED on windows-2022).
  const dir = path.join(home, "instance");
  const plainDir = path.join(home, "plain");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(plainDir, { recursive: true, mode: 0o700 });
  const ownerConfigPath = path.join(dir, "config.json");
  fs.writeFileSync(ownerConfigPath, `${JSON.stringify({ sqlite_driver: "wasm" })}\n`, { mode: 0o600 });
  const plainConfigPath = path.join(plainDir, "config.json");
  fs.writeFileSync(plainConfigPath, "{}\n", { mode: 0o600 });
  return { home, dir, dbPath: path.join(dir, "relay.db"), ownerConfigPath, plainConfigPath };
}

/** owner: the instance config declares wasm, no env selector. legacy: env-only wasm, config `{}`. native: neither. */
type Mode = "owner" | "legacy" | "native";

/**
 * The child env: the sandbox allowlist (HOME/USERPROFILE set to the sandbox, nothing ambient), then the relay's
 * variables by name. RELAY_HOME is never set. Owner mode comes ONLY from the instance declaration (the owner config
 * file); legacy mode is RELAY_SQLITE_DRIVER=wasm with the plain config; native sets no selector at all.
 */
function relayEnv(sb: Sandbox, transport: "http" | "stdio", mode: Mode, port: number): NodeJS.ProcessEnv {
  const env = sandboxEnv(sb.home);
  delete env.RELAY_HOME;
  env.RELAY_TRANSPORT = transport;
  env.RELAY_DB_PATH = sb.dbPath;
  env.RELAY_CONFIG_PATH = mode === "owner" ? sb.ownerConfigPath : sb.plainConfigPath;
  env.RELAY_HTTP_HOST = "127.0.0.1";
  env.RELAY_HTTP_PORT = String(port);
  if (transport === "stdio") {
    // The stdio daemon-launch guard (stdin EOF with no byte) is not under test here: bypass it so a refusal can
    // only come from the DB-ownership rule. stdin is also held open and fed a real client handshake.
    env.RELAY_SKIP_TTY_CHECK = "1";
  }
  if (mode === "legacy") env.RELAY_SQLITE_DRIVER = "wasm";
  else delete env.RELAY_SQLITE_DRIVER;
  return env;
}

async function startDaemon(sb: Sandbox, mode: Mode, label: string, port?: number): Promise<Proc> {
  const p = port ?? (await getFreePort());
  const proc = launch(label, relayEnv(sb, "http", mode, p));
  proc.port = p;
  return proc;
}

/** One /health probe: true only on HTTP 200 with a JSON body. Bounded by HTTP_REQUEST_TIMEOUT. */
async function healthOk(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT) });
    const text = await r.text();
    if (r.status !== 200) return false;
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Poll /health until 200 (true), the process exits (false) or the deadline (false). */
async function waitHealth(p: Proc, ms = HEALTH_DEADLINE): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (p.exited()) return false;
    if (await healthOk(p.port!)) return true;
    await sleep(100);
  }
  return false;
}

async function expectOwner(p: Proc, why: string): Promise<void> {
  const ok = await waitHealth(p);
  expect(ok, `${why}: expected /health 200 within ${HEALTH_DEADLINE}ms\n${describeProc(p)}`).toBe(true);
}

/**
 * Read the stamp. CALLER CONTRACT: every relay process on this DB has exited (asserted here over the records),
 * so the test process never opens a DB a relay may hold.
 */
function readStamp(sb: Sandbox): number {
  const live = procs.filter((p) => !p.exited());
  expect(live.map((p) => p.label), "readStamp: a relay process may still hold the DB").toEqual([]);
  const buf = fs.readFileSync(sb.dbPath);
  expect(buf.length, `${sb.dbPath} is shorter than a SQLite header`).toBeGreaterThanOrEqual(100);
  return buf.readUInt32BE(68);
}

/** A stopped daemon: it exited cleanly on SIGTERM (code 0), or by the signal itself on Windows. */
function expectCleanStop(p: Proc, r: ExitInfo | null): void {
  expect(r, `${p.label} did not exit after SIGTERM within ${STOP_DEADLINE}ms\n${describeProc(p)}`).not.toBeNull();
  if (!IS_WINDOWS) expect(r!.code, `${p.label} exit after SIGTERM\n${describeProc(p)}`).toBe(0);
}

/** Create an RLYW DB at rest: an owner daemon is born on the empty path, answers /health, and is stopped. */
async function bornWasmDb(sb: Sandbox, label: string): Promise<void> {
  expect(fs.existsSync(sb.dbPath), "precondition: no DB yet").toBe(false);
  const d = await startDaemon(sb, "owner", `${label}-birth`);
  await expectOwner(d, `${label}: the birth daemon`);
  expectCleanStop(d, await stop(d));
  expect(hex(readStamp(sb)), `${label}: the born DB's stamp`).toBe(hex(STAMP_WASM));
}

/** Refused = exited by itself within the deadline, with a non-zero code (not killed by a signal we sent). */
function expectRefusedExit(p: Proc, r: ExitInfo | null, why: string): void {
  expect(r, `${why}: expected the process to exit within ${EXIT_DEADLINE}ms\n${describeProc(p)}`).not.toBeNull();
  expect(r!.code, `${why}: expected an exit CODE (it exited by itself)\n${describeProc(p)}`).not.toBeNull();
  expect(r!.code, `${why}: expected a non-zero exit\n${describeProc(p)}`).not.toBe(0);
}

/**
 * A contender on a held DB: it never serves /health, exits by itself non-zero within EXIT_DEADLINE, and its
 * stderr names the owner cause (spec item 2).
 */
async function expectRefusedContender(c: Proc, why: string): Promise<void> {
  let answered = false;
  const deadline = Date.now() + EXIT_DEADLINE;
  while (Date.now() < deadline && !c.exited()) {
    if (await healthOk(c.port!)) answered = true;
    await sleep(100);
  }
  expect(answered, `${why}: must never serve /health on a held RLYW DB\n${describeProc(c)}`).toBe(false);
  expectRefusedExit(c, c.exited(), why);
  expect(c.stderr(), `${why}: stderr names the owner cause\n${describeProc(c)}`).toMatch(OWNER_CAUSE);
}

/** Precondition for the native rows: the native launch's config declares no driver (and relayEnv sets no env one). */
function expectNoDriverDeclared(sb: Sandbox): void {
  const config = JSON.parse(fs.readFileSync(sb.plainConfigPath, "utf-8")) as Record<string, unknown>;
  expect(config.sqlite_driver, "precondition: the native config names no driver").toBeUndefined();
}

/** The whole DB file. Same CALLER CONTRACT as readStamp: every relay process on this DB has exited. */
function readDbBytes(sb: Sandbox): Buffer {
  const live = procs.filter((p) => !p.exited());
  expect(live.map((p) => p.label), "readDbBytes: a relay process may still hold the DB").toEqual([]);
  return fs.readFileSync(sb.dbPath);
}

// ---------------------------------------------------------------------------------------------------------------
// Public HTTP API (item 6)
// ---------------------------------------------------------------------------------------------------------------

let rpcId = 0;
async function rpc(port: number, tool: string, args: Record<string, unknown>, headers: Record<string, string> = {}): Promise<any> {
  const id = ++rpcId;
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(10_000),
  });
  return toolCallResult(res, { tool, id });
}

/** The daemon's registration secret: beside the DB (documented), or under the sandbox HOME's relay dir. */
async function findMintSecret(sb: Sandbox, ms = 5_000): Promise<string> {
  const candidates = [sb.dir, path.join(sb.home, ".bot-relay")];
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    for (const c of candidates) {
      try {
        return mintSecretFor(c);
      } catch (e) {
        last = (e as Error).message;
      }
    }
    await sleep(100);
  }
  throw new Error(`no registration secret under ${candidates.map((c) => path.join(c, "secrets", "mint.secret")).join(" or ")}: ${last}`);
}

// ---------------------------------------------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------------------------------------------

describe("INV-DB-01 single owner (black box: real relay processes only)", () => {
  it("1. birth stamp: an owner daemon (the instance declares wasm) on a path with no DB creates it, stamped RLYW", async () => {
    const sb = makeSandbox("birth");
    expect(fs.existsSync(sb.dbPath)).toBe(false);
    const d = await startDaemon(sb, "owner", "birth");
    await expectOwner(d, "the birth daemon");
    expectCleanStop(d, await stop(d));
    expect(fs.existsSync(sb.dbPath), "the daemon created the DB at RELAY_DB_PATH").toBe(true);
    const stamp = readStamp(sb);
    expect(hex(stamp)).toBe(hex(STAMP_WASM));
    expect(stamp).not.toBe(STAMP_NATIVE);
  }, 30_000);

  it("1-twin. a LEGACY daemon (env-only wasm, config {}) on a path with no DB creates an UNSTAMPED DB (bytes 68-71 read 0)", async () => {
    const sb = makeSandbox("birth-legacy");
    expect(fs.existsSync(sb.dbPath)).toBe(false);
    const d = await startDaemon(sb, "legacy", "birth-legacy");
    await expectOwner(d, "the legacy birth daemon");
    expectCleanStop(d, await stop(d));
    expect(fs.existsSync(sb.dbPath), "the daemon created the DB at RELAY_DB_PATH").toBe(true);
    expect(hex(readStamp(sb)), "env-only wasm is never an owner: no stamp").toBe(hex(STAMP_NONE));
  }, 30_000);

  it(`2-twin. no lock in legacy mode: ${K} concurrent LEGACY daemons on a fresh legacy DB all answer /health, and the stamp still reads 0 after they exit`, async () => {
    const sb = makeSandbox("legacy-many");
    const ports = new Set<number>();
    while (ports.size < K) ports.add(await getFreePort());
    const daemons = [...ports].map((port, i) => {
      const p = launch(`legacy${i}`, relayEnv(sb, "http", "legacy", port));
      p.port = port;
      return p;
    });
    const healthy = await Promise.all(daemons.map((p) => waitHealth(p)));
    const report = daemons.map(describeProc).join("\n");
    expect(healthy, `every legacy daemon answers /health (legacy mode takes no lock)\n${report}`).toEqual(daemons.map(() => true));
    for (const p of daemons) expect(p.exited(), `${p.label} is still running with the others\n${report}`).toBeNull();
    for (const p of daemons) expectCleanStop(p, await stop(p));
    expect(hex(readStamp(sb)), "a legacy DB stays unstamped after K legacy processes").toBe(hex(STAMP_NONE));
  }, 45_000);

  it("2-header. the header decides regardless of env: a LEGACY process on an RLYW DB while an owner runs is refused like any contender", async () => {
    const sb = makeSandbox("legacy-on-w");
    const owner = await startDaemon(sb, "owner", "owner");
    await expectOwner(owner, "the owner");
    const c = await startDaemon(sb, "legacy", "legacy-contender");
    let answered = false;
    const deadline = Date.now() + EXIT_DEADLINE;
    while (Date.now() < deadline && !c.exited()) {
      if (await healthOk(c.port!)) answered = true;
      await sleep(100);
    }
    expect(answered, `the legacy contender must never serve /health on an owned RLYW DB\n${describeProc(c)}`).toBe(false);
    expectRefusedExit(c, c.exited(), "the legacy contender on an RLYW DB");
    expect(c.stderr(), `the legacy contender's stderr names the cause\n${describeProc(c)}`).toMatch(OWNER_CAUSE);
    expect(await healthOk(owner.port!), `the owner still answers after the refusal\n${describeProc(owner)}`).toBe(true);
    expectCleanStop(owner, await stop(owner));
    expect(hex(readStamp(sb))).toBe(hex(STAMP_WASM));
  }, 45_000);

  it(`2. one owner: ${K} concurrent owner daemons on one DB, ${ROUNDS} rounds; exactly one answers /health, the rest exit non-zero naming the cause`, async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const sb = makeSandbox(`race${round}`);
      const ports = new Set<number>();
      while (ports.size < K) ports.add(await getFreePort());
      // Launched back to back, no await between them: a real race on a path where no DB exists.
      const racers = [...ports].map((port, i) => {
        const p = launch(`r${round}-racer${i}`, relayEnv(sb, "http", "owner", port));
        p.port = port;
        return p;
      });

      const everHealthy = new Set<number>();
      const deadline = Date.now() + RACE_DEADLINE;
      while (Date.now() < deadline) {
        await Promise.all(
          racers.map(async (p, i) => {
            if (!p.exited() && (await healthOk(p.port!))) everHealthy.add(i);
          }),
        );
        const exitedCount = racers.filter((p) => p.exited()).length;
        if (exitedCount === K) break; // nobody left: 0 owners, asserted below
        if (exitedCount === K - 1 && everHealthy.size >= 1) break; // settled: one left standing
        if (everHealthy.size >= 2) break; // already a violation
        await sleep(100);
      }

      const report = `round ${round}:\n${racers.map(describeProc).join("\n")}\nanswered /health 200: [${[...everHealthy].join(", ")}]`;
      expect(everHealthy.size, `exactly one owner answers /health (never 0, never 2)\n${report}`).toBe(1);
      const ownerIdx = [...everHealthy][0]!;
      const owner = racers[ownerIdx]!;
      expect(owner.exited(), `the owner is still running\n${report}`).toBeNull();
      for (const [i, p] of racers.entries()) {
        if (i === ownerIdx) continue;
        expectRefusedExit(p, p.exited(), `round ${round}: contender ${p.label}`);
        expect(p.stderr(), `round ${round}: contender ${p.label}'s stderr names the cause\n${report}`).toMatch(OWNER_CAUSE);
      }

      expectCleanStop(owner, await stop(owner));
      expect(hex(readStamp(sb)), `round ${round}: the raced DB's stamp`).toBe(hex(STAMP_WASM));
    }
  }, 75_000);

  for (const withOwner of [false, true]) {
    it(`3${withOwner ? "b" : "a"}. a stdio server is refused on an RLYW DB (${withOwner ? "an owner running" : "no owner running"}), with an HTTP client config hint`, async () => {
      const sb = makeSandbox(withOwner ? "stdio-owned" : "stdio-rest");
      let owner: Proc | undefined;
      if (withOwner) {
        owner = await startDaemon(sb, "owner", "stdio-owner");
        await expectOwner(owner, "the owner");
      } else {
        await bornWasmDb(sb, "stdio-rest");
      }

      const port = owner?.port ?? (await getFreePort());
      const s = launch("stdio", relayEnv(sb, "stdio", "owner", port), true);
      // A real client handshake, stdin kept OPEN: a refusal is the server's own decision, not a closed pipe.
      const frames = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "inv-db-01-blackbox", version: "0.0.0" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "health_check", arguments: {} } },
      ];
      for (const f of frames) s.child.stdin?.write(`${JSON.stringify(f)}\n`);

      const r = await waitExit(s, EXIT_DEADLINE);
      expectRefusedExit(s, r, "the stdio server on an RLYW DB");
      expect(s.stderr(), `the stdio refusal carries an HTTP client config hint\n${describeProc(s)}`).toMatch(HTTP_HINT);

      if (owner) {
        expect(await healthOk(owner.port!), `the owner still answers after the stdio refusal\n${describeProc(owner)}`).toBe(true);
        expectCleanStop(owner, await stop(owner));
      }
      expect(hex(readStamp(sb)), "the stamp after the stdio refusal").toBe(hex(STAMP_WASM));
    }, 45_000);
  }

  it("4a. the header decides: a NATIVE daemon (no wasm selector anywhere) on an RLYW DB while an owner is live exits non-zero, naming the owner cause", async () => {
    const sb = makeSandbox("native-owned");
    expectNoDriverDeclared(sb);
    const owner = await startDaemon(sb, "owner", "native-owned-owner");
    await expectOwner(owner, "the owner");

    const n = await startDaemon(sb, "native", "native-contender");
    await expectRefusedContender(n, "the native daemon while an owner is live");
    expect(await healthOk(owner.port!), `the owner still answers after the native refusal\n${describeProc(owner)}`).toBe(true);
    expectCleanStop(owner, await stop(owner));
    expect(hex(readStamp(sb)), "the stamp after the native refusal").toBe(hex(STAMP_WASM));
  }, 45_000);

  it("4b. the header decides: a NATIVE daemon on an RLYW DB with no owner live BECOMES the owner; a contender is refused while it runs; the stamp stays RLYW", async () => {
    const sb = makeSandbox("native-adopts");
    expectNoDriverDeclared(sb);
    await bornWasmDb(sb, "native-adopts");

    const n = await startDaemon(sb, "native", "native-owner");
    await expectOwner(n, "the native-configured daemon on an RLYW DB with no owner live");

    // Non-vacuity: the native-configured daemon really HOLDS the DB, so a contender of either configuration is
    // refused while it runs (started concurrently: K <= 4 relays at once, the owner included).
    const contenders = [
      await startDaemon(sb, "native", "native-owner-contender-native"),
      await startDaemon(sb, "owner", "native-owner-contender-owner"),
    ];
    await Promise.all(contenders.map((c) => expectRefusedContender(c, `${c.label} while the native-configured owner runs`)));
    expect(await healthOk(n.port!), `the native-configured owner still answers after the refusals\n${describeProc(n)}`).toBe(true);

    expectCleanStop(n, await stop(n));
    expect(hex(readStamp(sb)), "a native-configured owner leaves the stamp RLYW").toBe(hex(STAMP_WASM));
  }, 45_000);

  it("4c. the header decides: a NATIVE-ONLY opener (`relay pending`, a direct DB read) on an RLYW DB with no daemon running exits non-zero, naming the wasm ownership with an HTTP client config hint, and the DB bytes are unchanged", async () => {
    const sb = makeSandbox("native-cli");
    expectNoDriverDeclared(sb);
    await bornWasmDb(sb, "native-cli");
    const before = readDbBytes(sb);

    // `relay pending AGENT --db-path P` reads the DB at P read-only, with the daemon down (its --help, README
    // "PostToolUse" and docs/post-tool-use-hook.md). Launched with a native process's sandbox env.
    const env = relayEnv(sb, "http", "native", await getFreePort());
    const cli = launch("native-cli-pending", env, false, [BIN_RELAY, "pending", "inv-nobody", "--db-path", sb.dbPath]);
    const r = await waitExit(cli, EXIT_DEADLINE);
    expectRefusedExit(cli, r, "relay pending (a native-only opener) on an RLYW DB");
    expect(r!.code, `exit 2 is a usage error, not a refusal: the launch itself is wrong\n${describeProc(cli)}`).not.toBe(2);

    const said = `${cli.stderr()}\n${cli.stdout()}`;
    const shown = `stdout: ${tail(cli.stdout())}\n${describeProc(cli)}`;
    expect(said, `the native-only refusal names wasm\n${shown}`).toMatch(/wasm/i);
    expect(said, `the native-only refusal names ownership\n${shown}`).toMatch(/own/i);
    expect(said, `the native-only refusal carries an HTTP client config hint\n${shown}`).toMatch(HTTP_HINT);

    const after = readDbBytes(sb);
    expect(after.length, "the DB file's size after the native-only refusal").toBe(before.length);
    expect(after.equals(before), "the DB file's bytes are unchanged by the native-only refusal").toBe(true);
    expect(hex(after.readUInt32BE(68))).toBe(hex(STAMP_WASM));
  }, 45_000);

  it.skipIf(IS_WINDOWS)(`5. the owner releases on exit: a contender is refused while it runs, and a new daemon owns the DB after it stops (skipped on Windows: ${NO_GRACEFUL_STOP})`, async () => {
    const sb = makeSandbox("release");
    const a = await startDaemon(sb, "owner", "owner-a");
    await expectOwner(a, "the first owner");

    // Non-vacuity: the DB IS held right now, so the success below is a release, not an absent lock.
    const c = await startDaemon(sb, "owner", "contender");
    const cr = await waitExit(c, EXIT_DEADLINE);
    expectRefusedExit(c, cr, "a contender while the owner runs");
    expect(c.stderr()).toMatch(OWNER_CAUSE);
    expect(await healthOk(a.port!), `the first owner still answers\n${describeProc(a)}`).toBe(true);

    expectCleanStop(a, await stop(a));
    const b = await startDaemon(sb, "owner", "owner-b");
    await expectOwner(b, "the new owner after the first one exited");
    expectCleanStop(b, await stop(b));
    expect(hex(readStamp(sb))).toBe(hex(STAMP_WASM));
  }, 60_000);

  it.skipIf(IS_WINDOWS)(`6. no acknowledged write lost: writes acknowledged by one owner are all served by the next (skipped on Windows: ${NO_GRACEFUL_STOP})`, async () => {
    const N = 5;
    const sb = makeSandbox("writes");
    const a = await startDaemon(sb, "owner", "writer-a");
    await expectOwner(a, "the writing owner");
    const secret = await findMintSecret(sb);

    // Acknowledged writes: each call below is a 2xx with a non-error tool result (toolCallResult enforces both).
    const sender = await rpc(a.port!, "register_agent", { name: "inv-sender", role: "test", capabilities: [] }, { "X-Relay-Secret": secret });
    const recipient = await rpc(a.port!, "register_agent", { name: "inv-recipient", role: "test", capabilities: [] }, { "X-Relay-Secret": secret });
    expect(typeof sender.agent_token).toBe("string");
    expect(typeof recipient.agent_token).toBe("string");
    const nonce = `${process.pid}-${Date.now()}`;
    const contents = Array.from({ length: N }, (_, i) => `inv-db-01-write-${i}-${nonce}`);
    for (const content of contents) {
      await rpc(a.port!, "send_message", { from: "inv-sender", to: "inv-recipient", content }, { "X-Agent-Token": sender.agent_token });
    }

    expectCleanStop(a, await stop(a));
    const b = await startDaemon(sb, "owner", "reader-b");
    await expectOwner(b, "the next owner");

    // Read back through the public API. The recipient's token authenticating at all proves its registration
    // survived; the messages prove the sends did.
    const got = await rpc(b.port!, "get_messages", { agent_name: "inv-recipient", status: "all", limit: 100, peek: true }, { "X-Agent-Token": recipient.agent_token });
    const body = JSON.stringify(got);
    const missing = contents.filter((c) => !body.includes(c));
    expect(missing, `acknowledged writes missing after the hand-over (body head: ${body.slice(0, 600)})`).toEqual([]);
    expectCleanStop(b, await stop(b));
  }, 60_000);
});
