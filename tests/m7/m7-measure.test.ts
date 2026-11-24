// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 8, M7: MEASURE the shipped doorbell on the current main before any PR 8 code. A report, not a gate:
 * each check records PASS, FAIL or NOT_DRIVEN with its evidence (exit codes, the exact lines, elapsed times), and
 * the commit, into $M7_REPORT (JSON). Never part of the default suite.
 * Run only through tests/m7/run-m7.sh.
 *
 * Real processes: each window is a real shell (tests/helpers/watch-window.ts), bound to a test agent in a SANDBOXED
 * relay DB under a temp dir; every relay command is the real CLI (bin/relay → dist). Nothing here reads or writes a
 * live relay home: HOME is a temp dir, RELAY_DB_PATH names the temp DB, and the file refuses to load otherwise.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { openWindow, within, type TestWindow, type WindowRun } from "../helpers/watch-window.js";
import { startToken } from "../helpers/start-token.js";
import { budgetTree } from "../_helpers/hook-budget-tree.js";
import { systemBinarySeamPath } from "../_helpers/system-binary-seam-env.js";

// Launched ONLY by tests/m7/run-m7.sh (its refusals run first): any other launcher (the full config, a bare vitest)
// is refused before a window opens or a DB is touched.
if (process.env.M7_RUNNER !== "1") throw new Error("m7: refusing: run tests/m7/run-m7.sh (it checks the sandbox before anything is written)");
// ISOLATION, AGAIN, FIRST (ruling 0c3deae0: the runner marker alone is never enough): before this file creates any
// temp dir, the temp root must resolve outside the real (passwd) home. Read-only.
{
  const { isolationFault } = await import("./isolation.mjs");
  const fault = isolationFault(process.env);
  if (fault) throw new Error(`m7: refusing: ${fault}`);
}
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RELAY_BIN = path.join(REPO, "bin", "relay");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "m7-measure-")));
const DB = path.join(ROOT, "inst", "relay.db");
const HOME = path.join(ROOT, "home");
const REAL_HOME = os.homedir();
// THE SANDBOX, asserted before anything opens a DB: the DB is under the temp root, never under the real home's relay dir.
if (!DB.startsWith(fs.realpathSync(os.tmpdir())) || DB.startsWith(path.join(REAL_HOME, ".bot-relay"))) throw new Error("m7: refusing: the DB is not in a temp sandbox");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_HOME;
delete process.env.RELAY_INSTANCE_ID;

const SEAMED_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "m7-seamed-"));
const STOP_HOOK = path.join(budgetTree(SEAMED_ROOT, path.join(REPO, "hooks"), path.join(REPO, "bin")), "stop-check.sh");

const W = await import("../../src/watch-wake.js");
const db = await import("../../src/db.js");
const { getOwnHostId } = await import("../../src/liveness.js");
const OWN = getOwnHostId();

const SHA = process.env.M7_SHA ?? "unknown";
const REPORT = process.env.M7_REPORT ?? path.join(ROOT, "m7-report.json");
type Verdict = "PASS" | "FAIL" | "NOT_DRIVEN";
const results: Array<{ check: string; verdict: Verdict; evidence: string[]; note?: string }> = [];
// THE REPORT: created EXCLUSIVELY (O_CREAT|O_EXCL|O_NOFOLLOW, 0600): an existing path or a link is refused, never
// written through. Every update rewrites it through this one descriptor.
const reportFd = fs.openSync(REPORT, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW), 0o600);
const write = () => {
  const body = Buffer.from(JSON.stringify({ sha: SHA, platform: `${process.platform} ${os.release()}`, node: process.version, at: new Date().toISOString(), results }, null, 2));
  fs.ftruncateSync(reportFd, 0);
  fs.writeSync(reportFd, body, 0, body.length, 0);
};

/** One check: `fn` collects evidence and asserts; a throw is FAIL (with the assertion's text), recorded, then rethrown. */
async function measure(check: string, fn: (ev: string[]) => Promise<string | void>): Promise<void> {
  const ev: string[] = [];
  try {
    const note = await fn(ev);
    results.push({ check, verdict: "PASS", evidence: ev, ...(note ? { note } : {}) });
  } catch (err) {
    results.push({ check, verdict: "FAIL", evidence: [...ev, `FAILED: ${err instanceof Error ? err.message.split("\n").slice(0, 6).join(" | ") : String(err)}`] });
    throw err;
  } finally {
    write();
  }
}

const env = (over: Record<string, string> = {}): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME, RELAY_DB_PATH: DB, RELAY_FILESYSTEM_MARKERS: "0", NODE_OPTIONS: `--require ${systemBinarySeamPath()}`, ...over });
const AGENT = "m7-bob";
const WATCH = ["--until-wake", "--interval", "1", "--dormant-check-s", "1"];
const relay = (args: string[], over: Record<string, string> = {}) => spawnSync("node", [RELAY_BIN, ...args], { env: env(over), encoding: "utf-8", timeout: 30_000 });
const lockStatus = () => relay(["watch", AGENT, "--lock-status"]).stdout.trim();
const send = (body = "hello") => db.sendMessage("m7-alice", AGENT, body, "normal").id;
/** The woken turn's DRAIN: what get_messages(status=pending) does, marking the mail read. */
const drain = () => db.getMessages(AGENT, "pending", 100).map((m) => m.id);
const bind = (w: { pid: number }, agent: string | null = AGENT) =>
  db.upsertAgentBinding(db.getDb(), { hostId: OWN as string, windowPid: w.pid, windowPidStart: startToken(w.pid), agentName: agent, agentClass: null, conversationId: `conv-${w.pid}`, conversationTitle: null, cwd: ROOT, boundVia: "launch-intent" });
const winDir = (w: { pid: number }) => W.watchWindowDir(DB, AGENT, { pid: w.pid, start: startToken(w.pid) });
const wakeLines = (s: string) => s.split("\n").filter((l) => l.startsWith("relay mail pending for "));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function untilStatus(want: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries && lockStatus() !== want; i++) await new Promise((r) => setTimeout(r, 150));
  expect(lockStatus()).toBe(want);
}
function dormantPids(dir: string): number[] {
  try {
    return fs
      .readdirSync(path.join(dir, W.DORMANT_DIR))
      .filter((n) => !n.startsWith("."))
      .flatMap((n) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(dir, W.DORMANT_DIR, n), "utf-8")) as { pid: number; reason: string }];
        } catch {
          return [];
        }
      })
      .map((r) => r.pid);
  } catch {
    return [];
  }
}
function dormantReason(dir: string, pid: number): string | null {
  try {
    for (const n of fs.readdirSync(path.join(dir, W.DORMANT_DIR))) {
      if (n.startsWith(".")) continue;
      const r = JSON.parse(fs.readFileSync(path.join(dir, W.DORMANT_DIR, n), "utf-8")) as { pid: number; reason: string };
      if (r.pid === pid) return r.reason;
    }
  } catch {
    /* none yet */
  }
  return null;
}
async function untilDormant(dir: string, pid: number): Promise<string> {
  for (let i = 0; i < 150; i++) {
    const r = dormantReason(dir, pid);
    if (r !== null) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`no dormant record for pid ${pid}`);
}
const windows: TestWindow[] = [];
let win: TestWindow;
const openWin = (agent: string | null = AGENT) => {
  const w = openWindow(path.join(ROOT, `win-${windows.length}-${Date.now()}`), env());
  windows.push(w);
  recordWindow(w);
  if (agent) bind(w, agent);
  return w;
};
const short = (s: string) => s.trim().replace(/RELAY_DB_PATH='[^']+'/g, "RELAY_DB_PATH='<sandbox>'").replace(/'[^']*\/bin\/relay'/g, "'<repo>/bin/relay'");

/** Every pid ever recorded for a window this file opened: its shell, every node it ran, its supervisor. */
const recordedPids = new Set<number>();
const recordWindow = (w: TestWindow) => {
  for (const p of [w.pid, w.leaderPid, ...w.pids]) if (Number.isInteger(p) && p > 1) recordedPids.add(p);
};
/**
 * Close EVERY window even when one close rejects, then SIGKILL every RECORDED pid still alive (never by pattern).
 * Returns the recorded pids that STILL survive (verified with kill -0).
 */
async function closeAll(ws: TestWindow[]): Promise<number[]> {
  for (const w of ws) recordWindow(w);
  await Promise.allSettled(ws.map((w) => w.close()));
  for (const w of ws) recordWindow(w); // pids a run added while closing
  const targets = [...recordedPids].filter((p) => alive(p));
  for (const p of targets) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* gone between the check and the kill */
    }
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && targets.some((p) => alive(p))) await new Promise((r) => setTimeout(r, 50));
  return targets.filter((p) => alive(p));
}

afterAll(async () => {
  const survivors = await closeAll(windows.splice(0));
  if (survivors.length > 0) {
    // LOUD: a process this run started outlives it. The run FAILS, even if every check passed.
    results.push({ check: "cleanup", verdict: "FAIL", evidence: [`${survivors.length} recorded process(es) still alive after the kill: pids ${survivors.join(", ")}`] });
    write();
    throw new Error(`m7: cleanup FAILED: recorded pids still alive: ${survivors.join(", ")}`);
  }
  write();
  db.closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(SEAMED_ROOT, { recursive: true, force: true });
});

describe.skipIf(!OWN)(`M7 (doorbell PR 8 gate brief §4) on ${SHA}`, () => {
  beforeEach(async () => {
    const left = await closeAll(windows.splice(0));
    if (left.length > 0) throw new Error(`m7: cleanup FAILED between checks: recorded pids still alive: ${left.join(", ")}`);
    db.closeDb();
    fs.rmSync(path.join(ROOT, "inst"), { recursive: true, force: true });
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, "inst"), { recursive: true });
    fs.mkdirSync(HOME, { recursive: true });
    db.getDb();
    db.registerAgent("m7-alice", "s", []);
    db.registerAgent(AGENT, "r", []);
    win = openWin();
  });

  it("check 1: --arm-check, then --until-wake in the background; mail → exit 0 with ONE line; the woken turn drains", () =>
    measure("1", async (ev) => {
      const a = win.runRelayWatch([AGENT, "--arm-check"]);
      const aCode = await within(a.exited, 20_000);
      ev.push(`--arm-check: exit ${aCode}, stdout: ${short(a.out())}`);
      expect(aCode).toBe(0);
      expect(a.out()).toMatch(/^arm: /);
      const r = win.runRelayWatch([AGENT, ...WATCH]);
      await untilStatus("live");
      ev.push("--until-wake: lock-status live (listening)");
      const t0 = Date.now();
      const id = send();
      const code = await within(r.exited, 20_000);
      ev.push(`mail ${id.slice(0, 8)} sent → exit ${code} after ${Date.now() - t0} ms; stdout lines: ${r.out().trim().split("\n").length}; line: ${short(r.out())}`);
      expect(code).toBe(0);
      expect(r.out().trim().split("\n")).toHaveLength(1);
      expect(wakeLines(r.out())).toHaveLength(1);
      const drained = drain();
      ev.push(`the woken turn drains: get_messages(pending) returned ${drained.length} (${drained.map((x) => x.slice(0, 8)).join(",")}); pending after: ${db.getMessages(AGENT, "pending", 100, true).length}`);
      expect(drained).toEqual([id]);
      expect(db.getMessages(AGENT, "pending", 100, true)).toHaveLength(0);
    }), 60_000);

  it("check 2: an already-drained backlog → no exit (the spin trap); an undrained set wakes ONCE, not twice", () =>
    measure("2", async (ev) => {
      send();
      drain();
      const r = win.runRelayWatch([AGENT, ...WATCH]);
      const drainedWait = await within(r.exited, 5_000);
      ev.push(`drained backlog (1 message read): armed watch after 5 s: ${drainedWait === "timeout" ? "still waiting (no exit)" : `EXITED ${drainedWait}: ${short(r.out())}`}`);
      expect(drainedWait).toBe("timeout");
      process.kill(await r.pid(), "SIGTERM");
      await within(r.exited, 5_000);
      send();
      const first = win.runRelayWatch([AGENT, ...WATCH]);
      const c1 = await within(first.exited, 20_000);
      ev.push(`undrained set (1 new message): first watch exit ${c1}, wake lines ${wakeLines(first.out()).length}`);
      expect(c1).toBe(0);
      expect(wakeLines(first.out())).toHaveLength(1);
      const again = win.runRelayWatch([AGENT, ...WATCH]);
      const c2 = await within(again.exited, 5_000);
      ev.push(`re-armed, the SAME set still undrained: after 5 s: ${c2 === "timeout" ? "still waiting (no second wake)" : `EXITED ${c2}: ${short(again.out())}`}`);
      expect(c2).toBe("timeout");
      expect(again.out()).toBe("");
    }), 60_000);

  it("check 3: a second watch for the same (agent, window) loses", () =>
    measure("3", async (ev) => {
      const first = win.runRelayWatch([AGENT, ...WATCH]);
      await untilStatus("live");
      const fg = win.runRelayWatch([AGENT, "--arm-check"]);
      const fgCode = await within(fg.exited, 20_000);
      ev.push(`--arm-check with a watch live: exit ${fgCode}, stdout: ${short(fg.out())}`);
      const second = win.runRelayWatch([AGENT, ...WATCH]);
      const pid = await second.pid();
      const reason = await untilDormant(winDir(win), pid);
      const still = await within(second.exited, 2_500);
      ev.push(`a second --until-wake in the same window: DORMANT, reason "${reason}"; exited within 2.5 s: ${still === "timeout" ? "no" : still}; stdout so far: ${JSON.stringify(second.out())}`);
      ev.push(`the holder: lock-status ${lockStatus()}, first watch alive ${alive(await first.pid())}`);
      expect(reason).toMatch(/^already watched/);
      expect(still).toBe("timeout");
      expect(lockStatus()).toBe("live");
      send();
      const c = await within(first.exited, 20_000);
      ev.push(`mail → the holder exits ${c} with ${wakeLines(first.out()).length} wake line; the loser: ${wakeLines(second.out()).length} wake line(s)`);
      expect(wakeLines(first.out())).toHaveLength(1);
      expect(wakeLines(second.out())).toHaveLength(0);
      return "the brief's quoted line `no-mail: already watched` is NOT printed by a background --until-wake: since D1 the loser goes DORMANT silently (stdout empty, the reason in its dormant record), and exits silently with its window; the FOREGROUND --arm-check prints the `live:` line instead (the pr7 suite pins an exiting loser as a mutant).";
    }), 60_000);

  it("check 4: ONE inbox wakes exactly ONE session: two windows bound to the same agent never wake twice", () =>
    measure("4", async (ev) => {
      const a = win.runRelayWatch([AGENT, ...WATCH]);
      await untilStatus("live");
      const apid = await a.pid();
      const winB = openWin(); // the SAME agent name bound in a second live window
      const aReason = await untilDormant(winDir(win), apid);
      ev.push(`window A's watch, once window B binds the same agent: DORMANT, reason "${aReason}"`);
      const bCheck = winB.runRelayWatch([AGENT, "--arm-check"]);
      const bCode = await within(bCheck.exited, 20_000);
      ev.push(`window B --arm-check: exit ${bCode}, stdout: ${short(bCheck.out())}`);
      const b = winB.runRelayWatch([AGENT, ...WATCH]);
      await new Promise((r) => setTimeout(r, 3_000));
      send();
      await new Promise((r) => setTimeout(r, 5_000));
      const total = wakeLines(a.out()).length + wakeLines(b.out()).length;
      ev.push(`mail with both windows bound: wake lines A=${wakeLines(a.out()).length} B=${wakeLines(b.out()).length} (total ${total}); B's watch (no arm-check, launched anyway): ${dormantReason(W.watchAgentDir(DB, AGENT), await b.pid()) ?? dormantReason(winDir(winB), await b.pid()) ?? "no dormant record"}, exited: ${await within(b.exited, 10)}`);
      expect(aReason).toMatch(/binding moved|ambiguous/);
      expect(bCode).toBe(2);
      expect(bCheck.out()).toMatch(/ambiguous_binding/);
      expect(total).toBeLessThanOrEqual(1);
      return total === 0 ? "with two live windows bound, NEITHER wakes (both refuse: ambiguous); the mail stays pending, never two wakes" : undefined;
    }), 60_000);

  it("check 5: close the window → the watch exits silently", () =>
    measure("5", async (ev) => {
      const r = win.runRelayWatch([AGENT, ...WATCH]);
      await untilStatus("live");
      const pid = await r.pid();
      const dir0 = winDir(win); // keyed by the window's start token: read it BEFORE the window dies
      const t0 = Date.now();
      process.kill(win.pid, "SIGKILL");
      const code = await within(r.exited, 15_000);
      ev.push(`window SIGKILLed while the watch listens: exit ${code} after ${Date.now() - t0} ms; stdout ${JSON.stringify(r.out())}; dormant record seen: ${dormantPids(dir0).includes(pid)}; lock-status after: ${lockStatus()}`);
      expect(code).toBe(0);
      expect(r.out()).toBe("");
      const loserWin = openWin();
      const holder = loserWin.runRelayWatch([AGENT, ...WATCH]);
      await untilStatus("live");
      const loser = loserWin.runRelayWatch([AGENT, ...WATCH]);
      const lpid = await loser.pid();
      const dir1 = winDir(loserWin);
      const reason = await untilDormant(dir1, lpid);
      const t1 = Date.now();
      process.kill(loserWin.pid, "SIGKILL");
      const lc = await within(loser.exited, 15_000);
      const hc = await within(holder.exited, 15_000);
      ev.push(`a DORMANT watch (reason "${reason}"), its window SIGKILLed: exit ${lc} after ${Date.now() - t1} ms, stdout ${JSON.stringify(loser.out())}, record removed ${!dormantPids(dir1).includes(lpid)}; its holder: exit ${hc}, stdout ${JSON.stringify(holder.out())}`);
      expect(lc).toBe(0);
      expect(loser.out()).toBe("");
      expect(hc).toBe(0);
      return "a LISTENING watch exits silently at once (no dormant step: nothing to go dormant for); a DORMANT one exits silently with its window and removes its record.";
    }), 90_000);

  it("check 6: `relay pending --watch-status` and `relay doorbell status` in the never, live, stale and absent states", () =>
    measure("6", async (ev) => {
      const states: Record<string, string> = {};
      const doorbell: Record<string, string> = {};
      const read = (label: string) => {
        const p = relay(["pending", AGENT, "--json", "--watch-status"]);
        const d = relay(["doorbell", "status"]);
        const dj = relay(["doorbell", "status", "--json"]);
        let watch = "(unparsed)";
        try {
          watch = String((JSON.parse(p.stdout) as { watch?: unknown }).watch);
        } catch {
          /* recorded as unparsed */
        }
        let dormant = "(unparsed)";
        try {
          dormant = JSON.stringify((JSON.parse(dj.stdout) as { dormant_watches?: unknown }).dormant_watches);
        } catch {
          /* recorded as unparsed */
        }
        states[label] = watch;
        let shape = "(unparsed)";
        try {
          const j = JSON.parse(dj.stdout) as Record<string, unknown>;
          shape = typeof j.state === "string" && typeof j.dormant_watches === "object" && j.dormant_watches !== null && typeof j.escalations === "object" ? "ok" : "missing fields";
        } catch {
          /* recorded as unparsed */
        }
        doorbell[label] = `${d.status}/${dj.status}/${shape}`;
        ev.push(`${label}: pending exit ${p.status}, watch=${watch}; doorbell status exit ${d.status}: ${short(d.stdout).slice(0, 200)}; --json exit ${dj.status}, shape ${shape}, dormant_watches=${dormant}`);
      };
      read("never");
      const r = win.runRelayWatch([AGENT, ...WATCH]);
      await untilStatus("live");
      read("live");
      const pid = await r.pid();
      process.kill(pid, "SIGSTOP");
      const dir = winDir(win);
      const h = JSON.parse(fs.readFileSync(path.join(dir, W.watchHolderFile(0)), "utf-8")) as { pid: number };
      const now = W.awakeNowMs() as number;
      W.writeHeartbeat(dir, { pid: h.pid, gen: 0, at: new Date().toISOString(), awake_ms: now - W.HEARTBEAT_STALE_MS - 60_000 });
      read("stale");
      process.kill(pid, "SIGKILL");
      await within(r.exited, 10_000);
      read("absent");
      expect(states).toEqual({ never: "never", live: "live", stale: "stale", absent: "absent" });
      // `relay doorbell status` (text and --json) answers in every state: exit 0 and the documented JSON shape.
      expect(doorbell).toEqual({ never: "0/0/ok", live: "0/0/ok", stale: "0/0/ok", absent: "0/0/ok" });
      return "the stale state is INDUCED (the holder SIGSTOPped and its heartbeat aged past HEARTBEAT_STALE_MS on the awake clock), as the pr7 suite does; `doorbell status` reports the supervisor (not-installed in a sandbox) and dormant-watch counts, not a per-agent watch state.";
    }), 60_000);

  it("check 7: the Stop-hook heal fires ONCE for an agent that armed a watch and has none now", () =>
    measure("7", async (ev) => {
      const hookEnv = env({ RELAY_AGENT_NAME: AGENT, RELAY_STOP_WAKE_DAMPER_SECS: "0", RELAY_TEST_CLOCK: "0", NODE_OPTIONS: "" });
      const stop = (sid: string) => {
        const r = spawnSync("bash", [STOP_HOOK], { env: hookEnv, input: JSON.stringify({ session_id: sid, stop_hook_active: false, hook_event_name: "Stop" }), encoding: "utf-8", timeout: 30_000 });
        return r.stdout ?? "";
      };
      const neverArmed = stop("m7-sess-0");
      ev.push(`never armed: hook stdout ${JSON.stringify(neverArmed)}`);
      const r = win.runRelayWatch([AGENT, ...WATCH]);
      await untilStatus("live");
      const whileLive = stop("m7-sess-1");
      ev.push(`armed and LIVE: hook stdout ${JSON.stringify(whileLive)}`);
      process.kill(await r.pid(), "SIGKILL");
      await within(r.exited, 10_000);
      const first = stop("m7-sess-1");
      const second = stop("m7-sess-1");
      const otherSession = stop("m7-sess-2");
      const decision = (s: string) => {
        try {
          return (JSON.parse(s) as { decision?: string }).decision ?? "(none)";
        } catch {
          return s === "" ? "(empty)" : "(unparsed)";
        }
      };
      ev.push(`armed, none now: 1st Stop → ${decision(first)}: ${short(first).slice(0, 160)}; 2nd Stop, same session → ${decision(second)}; a new session → ${decision(otherSession)}`);
      expect(neverArmed).toBe("");
      expect(whileLive).toBe("");
      expect(decision(first)).toBe("block");
      expect(second).toBe("");
      expect(decision(otherSession)).toBe("block");
    }), 90_000);

  it("check 8: the cost of a re-arm inside a woken turn (M5g)", () =>
    measure("8", async (ev) => {
      const holder = win.runRelayWatch([AGENT, ...WATCH]);
      await untilStatus("live");
      const loser = win.runRelayWatch([AGENT, ...WATCH]);
      await untilDormant(winDir(win), await loser.pid());
      const quick = await within(loser.exited, 5_000);
      ev.push(`the mechanism only: a LOSING watch (lost race) after 5 s: ${quick === "timeout" ? "has NOT exited (dormant), so its background task sends no completion notification" : `EXITED ${quick}`}; stdout ${JSON.stringify(loser.out())}`);
      ev.push(`a re-arm's own cost in CLI terms: --arm-check is one foreground command; the watch is one background command printing nothing until it wakes (holder stdout so far ${JSON.stringify(holder.out())})`);
      expect(quick).toBe("timeout");
      results.push({ check: "8", verdict: "NOT_DRIVEN", evidence: ev, note: "the TOKEN/turn cost needs a real model session (a woken turn re-arming, counted in its transcript): not drivable in this harness. MEASURED here, the mechanism behind M5g: a losing watch does not exit (it goes dormant), so it cannot trigger an extra turn by itself." });
      write();
      throw new SkipRecord();
    }).catch((e) => {
      if (!(e instanceof SkipRecord)) throw e;
      results.splice(results.findIndex((x) => x.check === "8" && x.verdict === "FAIL"), 1);
      write();
    }), 60_000);

  it("check 9: SIGTERM to a real --until-wake, LISTENING and DORMANT: exit 0 within the drain bound, one `no-mail: stopped (signal)` line, the lock released", () =>
    measure("9", async (ev) => {
      const BOUND_MS = 2_000;
      const r = win.runRelayWatch([AGENT, ...WATCH]);
      await untilStatus("live");
      let t0 = Date.now();
      process.kill(await r.pid(), "SIGTERM");
      const code = await within(r.exited, 10_000);
      const listenMs = Date.now() - t0;
      const lines = r.out().trim().split("\n").filter(Boolean);
      ev.push(`LISTENING, SIGTERM: exit ${code} after ${listenMs} ms (bound ${BOUND_MS}); stdout lines ${lines.length}: ${short(r.out())}`);
      const after = win.runRelayWatch([AGENT, "--arm-check"]);
      const ac = await within(after.exited, 20_000);
      ev.push(`then --arm-check: exit ${ac}, stdout: ${short(after.out()).slice(0, 80)}; lock-status ${lockStatus()}`);
      expect(code).toBe(0);
      expect(listenMs).toBeLessThanOrEqual(BOUND_MS);
      expect(lines).toEqual([expect.stringMatching(/^no-mail: stopped \(signal\)/)]);
      expect(ac).toBe(0);
      expect(after.out()).toMatch(/^arm: /);
      const holder = win.runRelayWatch([AGENT, ...WATCH]);
      await untilStatus("live");
      const loser = win.runRelayWatch([AGENT, ...WATCH]);
      const lpid = await loser.pid();
      const reason = await untilDormant(winDir(win), lpid);
      t0 = Date.now();
      process.kill(lpid, "SIGTERM");
      const lc = await within(loser.exited, 10_000);
      const dormantMs = Date.now() - t0;
      const llines = loser.out().trim().split("\n").filter(Boolean);
      ev.push(`DORMANT ("${reason.slice(0, 40)}…"), SIGTERM: exit ${lc} after ${dormantMs} ms; stdout lines ${llines.length}: ${short(loser.out()).slice(0, 160)}; record removed ${!dormantPids(winDir(win)).includes(lpid)}; the holder still ${lockStatus()}`);
      expect(lc).toBe(0);
      expect(dormantMs).toBeLessThanOrEqual(BOUND_MS);
      expect(llines).toEqual([expect.stringMatching(/^no-mail: stopped \(signal\)/)]);
      expect(lockStatus()).toBe("live");
      process.kill(await holder.pid(), "SIGTERM");
      await within(holder.exited, 10_000);
      const final = win.runRelayWatch([AGENT, "--arm-check"]);
      const fc = await within(final.exited, 20_000);
      ev.push(`the holder SIGTERMed too → --arm-check: exit ${fc}, stdout: ${short(final.out()).slice(0, 80)}`);
      expect(fc).toBe(0);
      expect(final.out()).toMatch(/^arm: /);
      return "a DORMANT watch holds no lock (the holder does): \"the lock is released\" is measured as the --arm-check after the HOLDER's SIGTERM.";
    }), 90_000);
});

class SkipRecord extends Error {}
export type { WindowRun };
