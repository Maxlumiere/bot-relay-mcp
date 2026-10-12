// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 7 (plan §v6.1 (4); Codex R1 #4): the Stop hook's WATCH RE-ARM HEAL, through the REAL
 * hook (hooks/stop-check.sh), the real `relay pending --watch-status`, and a real watch running inside
 * the agent's bound window (tests/helpers/watch-window.ts).
 *   - an agent that armed a watch once and has none live → ONE block per session with a RUNNABLE re-arm command;
 *   - a live watch → no block, and the once is reset;
 *   - a hung watch → the block says hung;
 *   - an agent that NEVER armed one → untouched (the pre-PR 7 behaviour, byte for byte);
 *   - mail pending too → ONE block carrying both;
 *   - the once lives in the AGENT's watch dir inside the instance, never under $HOME, and a planted link
 *     there is replaced, never followed (Codex R1 #4).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { openWindow, within, type TestWindow } from "./helpers/watch-window.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(REPO, "hooks", "stop-check.sh");
const RELAY_BIN = path.join(REPO, "bin", "relay");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-pr7-heal-")));
const DB = path.join(ROOT, "inst", "relay.db");
const HOME = path.join(ROOT, "home");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const db = await import("../src/db.js");
const W = await import("../src/watch-wake.js");
const { getOwnHostId, processStartedAt } = await import("../src/liveness.js");
const OWN = getOwnHostId();
const windows: TestWindow[] = [];
afterAll(async () => {
  for (const w of windows) await w.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const env = (over: Record<string, string> = {}): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME, RELAY_DB_PATH: DB, RELAY_AGENT_NAME: "h-bob", RELAY_STOP_WAKE_DAMPER_SECS: "0", RELAY_FILESYSTEM_MARKERS: "0", ...over });
function stop(payload: Record<string, unknown> | null): { out: string; block: { decision: string; reason: string } | null } {
  const r = spawnSync("bash", [HOOK], { env: env(), input: payload ? JSON.stringify(payload) : "", encoding: "utf-8", timeout: 30_000 });
  const out = r.stdout ?? "";
  return { out, block: out ? JSON.parse(out) : null };
}
const natural = (sid = "sess-1") => ({ session_id: sid, stop_hook_active: false, hook_event_name: "Stop" });
const agentDir = () => W.watchAgentDir(DB, "h-bob");
const healFile = () => path.join(agentDir(), W.HEAL_FILE);
const armedOnce = () => fs.mkdirSync(agentDir(), { recursive: true, mode: 0o700 }); // the agent dir exists: it armed before
let win: TestWindow;
const startWatch = () => win.runRelayWatch(["h-bob", "--until-wake", "--interval", "1", "--dormant-check-s", "1"]);
async function untilLive(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (spawnSync("node", [RELAY_BIN, "watch", "h-bob", "--lock-status"], { env: env(), encoding: "utf-8" }).stdout.trim() === "live") return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("the watch never became live");
}

describe.skipIf(!OWN)("PR 7: the Stop hook's watch re-arm heal (the real hook)", () => {
  beforeEach(async () => {
    for (const w of windows.splice(0)) await w.close();
    db.closeDb();
    fs.rmSync(path.join(ROOT, "inst"), { recursive: true, force: true });
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, "inst"), { recursive: true });
    fs.mkdirSync(HOME, { recursive: true });
    db.getDb();
    db.registerAgent("h-alice", "s", []);
    db.registerAgent("h-bob", "r", []);
    win = openWindow(path.join(ROOT, `win-${Date.now()}`), env());
    windows.push(win);
    db.upsertAgentBinding(db.getDb(), { hostId: OWN as string, windowPid: win.pid, windowPidStart: processStartedAt(win.pid) as string, agentName: "h-bob", agentClass: null, conversationId: `conv-${win.pid}`, conversationTitle: null, cwd: ROOT, boundVia: "launch-intent" });
  });

  it("an agent that NEVER armed a watch is untouched: no block, empty stdout (the pre-PR 7 behaviour)", () => {
    expect(stop(natural()).out).toBe("");
    expect(fs.existsSync(agentDir())).toBe(false);
  });

  it("HARM: armed once, none live → ONE block per session with a RUNNABLE re-arm command; the same session is not blocked again; a NEW session is", async () => {
    armedOnce();
    const first = stop(natural("sess-1"));
    expect(first.block?.decision).toBe("block");
    expect(first.block?.reason).toMatch(/^\[RELAY\] Your relay watch is not running: .* Re-arm it: run RELAY_DB_PATH=.+ watch h-bob --arm-check and, if it says arm, run the command it gives as a BACKGROUND task \(run_in_background\)\. Then continue\.$/);
    expect(fs.readFileSync(healFile(), "utf-8")).toBe("sess-1"); // the once lives in the AGENT dir
    expect(fs.existsSync(path.join(HOME, ".bot-relay"))).toBe(false); // never under $HOME (Codex R1 #4)
    expect(stop(natural("sess-1")).out).toBe(""); // once per session
    expect(stop(natural("sess-2")).block?.decision).toBe("block");
    // The steps it gives are RUNNABLE as printed, in the agent's window: the arm-check says arm and
    // gives the background command; with mail pending, that watch wakes.
    const check = (first.block as { reason: string }).reason.replace(/^.*Re-arm it: run /, "").replace(/ and, if it says arm, .*$/, "");
    const a = win.runPrintedRelayCommand(check);
    expect(await within(a.exited, 30_000), a.err()).toBe(0);
    expect(a.out()).toMatch(/^arm: .*once: /);
    const cmd = a.out().trim().replace(/^arm: .*once: /, "");
    db.sendMessage("h-alice", "h-bob", "x", "normal");
    const r = win.runPrintedRelayCommand(cmd);
    expect(await within(r.exited, 30_000), r.err()).toBe(0);
    expect(r.out()).toMatch(/^relay mail pending for h-bob: 1 new message/);
  }, 60_000);

  it("a LIVE watch → no block, and seeing it live RESETS the once (a later loss in the same session heals again)", async () => {
    armedOnce();
    expect(stop(natural("sess-1")).block?.decision).toBe("block");
    const w = startWatch();
    await untilLive();
    expect(stop(natural("sess-1")).out).toBe("");
    expect(fs.existsSync(healFile())).toBe(false);
    process.kill(await w.pid(), "SIGKILL");
    await w.exited;
    expect(stop(natural("sess-1")).block?.decision).toBe("block");
  }, 60_000);

  it.skipIf(W.awakeNowMs() === null)("a HUNG watch (lock held, its holder silent past the stale bound) → the block says it is hung", async () => {
    startWatch();
    await untilLive();
    // Age the CURRENT holder: its own heartbeat, stamped past the stale bound on the AWAKE clock.
    const dir = W.watchWindowDir(DB, "h-bob", { pid: win.pid, start: processStartedAt(win.pid) as string });
    const h = JSON.parse(fs.readFileSync(path.join(dir, W.watchHolderFile(0)), "utf-8"));
    W.writeHeartbeat(dir, { pid: h.pid, gen: 0, at: new Date().toISOString(), awake_ms: (W.awakeNowMs() as number) - W.HEARTBEAT_STALE_MS - 60_000 });
    expect(stop(natural()).block?.reason).toMatch(/^\[RELAY\] Your relay watch is hung \(it stopped checking\)/);
  }, 60_000);

  it("mail pending AND no live watch → ONE block carrying the mail wake and the re-arm line", () => {
    armedOnce();
    db.sendMessage("h-alice", "h-bob", "x", "normal");
    const b = stop(natural()).block;
    expect(b?.decision).toBe("block");
    expect(b?.reason).toMatch(/^\[RELAY\] 1 pending message for h-bob, latest from h-alice\. .* this wake did not consume it\. \[RELAY\] Your relay watch is not running: .*--arm-check and, if it says arm, .*\(run_in_background\)\.$/);
  });

  it("never inside our own continuation (stop_hook_active), and never without a valid session id (it cannot be bounded to once)", () => {
    armedOnce();
    expect(stop({ session_id: "sess-1", stop_hook_active: true }).out).toBe("");
    expect(stop({ stop_hook_active: false }).out).toBe("");
    expect(stop({ session_id: "bad id; rm -rf", stop_hook_active: false }).out).toBe("");
  });

  it("HARM (Codex R1 #4): a PLANTED LINK at the heal state is REPLACED, never followed: its target is untouched", () => {
    armedOnce();
    const target = path.join(ROOT, "pretend-claude.json");
    fs.writeFileSync(target, "ORIGINAL");
    fs.symlinkSync(target, healFile());
    expect(stop(natural("sess-9")).block?.decision).toBe("block");
    expect(fs.readFileSync(target, "utf-8")).toBe("ORIGINAL"); // the link's target was never written
    expect(fs.lstatSync(healFile()).isSymbolicLink()).toBe(false); // the link itself was replaced
    expect(fs.readFileSync(healFile(), "utf-8")).toBe("sess-9");
    // A link to a DIRECTORY (where a shell `mv` would drop a file INSIDE it) is replaced too.
    const targetDir = path.join(ROOT, "pretend-dot-claude");
    fs.mkdirSync(targetDir);
    fs.rmSync(healFile());
    fs.symlinkSync(targetDir, healFile());
    expect(stop(natural("sess-10")).block?.decision).toBe("block");
    expect(fs.readdirSync(targetDir)).toEqual([]);
    expect(fs.lstatSync(healFile()).isSymbolicLink()).toBe(false);
  });

  it("HARM (Codex R1 #4): the agent's watch dir itself a LINK → nothing is read or written through it (no heal)", () => {
    const elsewhere = path.join(ROOT, "elsewhere");
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.mkdirSync(path.dirname(agentDir()), { recursive: true, mode: 0o700 });
    fs.symlinkSync(elsewhere, agentDir());
    expect(stop(natural()).out).toBe("");
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("HARM (Codex R2 (a)): a link at the PARENT <instance>/watch (to an outside dir holding a real <agent> dir) → nothing is read or written through it", () => {
    const outside = path.join(ROOT, "outside");
    fs.mkdirSync(path.join(outside, "h-bob"), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, path.dirname(agentDir())); // <instance>/watch → outside
    expect(stop(natural("sess-p")).out).toBe("");
    expect(fs.readdirSync(path.join(outside, "h-bob"))).toEqual([]); // no heal-session outside the instance
  });
});
