// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 7 (plan §v6.1 (4)): the Stop hook's WATCH RE-ARM HEAL, through the REAL hook
 * (hooks/stop-check.sh), the real `relay pending --watch-status`, and a real watch process.
 *   - an agent that armed a watch once and has none live → ONE block per session with a RUNNABLE re-arm command;
 *   - a live watch → no block, and the once is reset;
 *   - a hung watch (heartbeat old) → the block says hung;
 *   - an agent that NEVER armed one → untouched (the pre-PR 7 behaviour, byte for byte);
 *   - mail pending too → ONE block carrying both.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";

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
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill("SIGKILL");
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const env = (over: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? "", HOME, RELAY_DB_PATH: DB, RELAY_AGENT_NAME: "h-bob", RELAY_STOP_WAKE_DAMPER_SECS: "0", RELAY_FILESYSTEM_MARKERS: "0", ...over });
function stop(payload: Record<string, unknown> | null): { out: string; block: { decision: string; reason: string } | null } {
  const r = spawnSync("bash", [HOOK], { env: env(), input: payload ? JSON.stringify(payload) : "", encoding: "utf-8", timeout: 30_000 });
  const out = r.stdout ?? "";
  return { out, block: out ? JSON.parse(out) : null };
}
const natural = (sid = "sess-1") => ({ session_id: sid, stop_hook_active: false, hook_event_name: "Stop" });
const dir = () => W.watchDirFor(DB, "h-bob");
const armedOnce = () => fs.mkdirSync(dir(), { recursive: true, mode: 0o700 }); // a watch dir exists: it armed before
function startWatch(): ChildProcess {
  const c = spawn("node", [RELAY_BIN, "watch", "h-bob", "--until-wake", "--interval", "1"], { env: env(), stdio: "ignore" });
  children.push(c);
  return c;
}
async function untilLive(): Promise<void> {
  for (let i = 0; i < 75; i++) {
    if (spawnSync("node", [RELAY_BIN, "watch", "h-bob", "--lock-status"], { env: env(), encoding: "utf-8" }).stdout.trim() === "live") return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("the watch never became live");
}

describe("PR 7: the Stop hook's watch re-arm heal (the real hook)", () => {
  beforeEach(async () => {
    for (const c of children.splice(0)) {
      if (c.exitCode === null && c.signalCode === null) {
        const gone = new Promise((r) => c.once("close", r));
        c.kill("SIGKILL");
        await gone;
      }
    }
    db.closeDb();
    fs.rmSync(path.join(ROOT, "inst"), { recursive: true, force: true });
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, "inst"), { recursive: true });
    fs.mkdirSync(HOME, { recursive: true });
    db.getDb();
    db.registerAgent("h-alice", "s", []);
    db.registerAgent("h-bob", "r", []);
  });

  it("an agent that NEVER armed a watch is untouched: no block, empty stdout (the pre-PR 7 behaviour)", () => {
    expect(stop(natural()).out).toBe("");
    expect(fs.existsSync(dir())).toBe(false);
  });

  it("HARM: armed once, none live → ONE block per session with a RUNNABLE re-arm command; the same session is not blocked again; a NEW session is", async () => {
    armedOnce();
    const first = stop(natural("sess-1"));
    expect(first.block?.decision).toBe("block");
    expect(first.block?.reason).toMatch(/^\[RELAY\] Your relay watch is not running: .* Re-arm it now as a BACKGROUND task \(run_in_background\), once: RELAY_DB_PATH=.+ watch h-bob --until-wake Then continue\.$/);
    expect(stop(natural("sess-1")).out).toBe(""); // once per session
    expect(stop(natural("sess-2")).block?.decision).toBe("block");
    // The command it gives is RUNNABLE as printed: run it with mail pending → the watch wakes (exit 0).
    const cmd = (first.block as { reason: string }).reason.replace(/^.*once: /, "").replace(/ Then continue\.$/, "");
    db.sendMessage("h-alice", "h-bob", "x", "normal");
    const r = spawnSync("bash", ["-c", cmd], { env: env(), encoding: "utf-8", timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^relay mail pending for h-bob: 1 new message/);
  }, 60_000);

  it("a LIVE watch → no block, and seeing it live RESETS the once (a later loss in the same session heals again)", async () => {
    armedOnce();
    expect(stop(natural("sess-1")).block?.decision).toBe("block");
    const w = startWatch();
    await untilLive();
    expect(stop(natural("sess-1")).out).toBe("");
    const gone = new Promise((r) => w.once("close", r));
    w.kill("SIGKILL");
    await gone;
    expect(stop(natural("sess-1")).block?.decision).toBe("block");
  }, 60_000);

  it("a HUNG watch (lock held, heartbeat old) → the block says it is hung", async () => {
    startWatch();
    await untilLive();
    // Age the CURRENT holder (its sidecar's since and its own heartbeat): real time cannot pass 5 min.
    const old = new Date(Date.now() - W.HEARTBEAT_STALE_MS - 60_000).toISOString();
    const f = path.join(dir(), W.WATCH_HOLDER_FILE);
    const h = JSON.parse(fs.readFileSync(f, "utf-8"));
    fs.writeFileSync(f, JSON.stringify({ ...h, since: old }));
    W.writeHeartbeat(dir(), h.pid, old);
    expect(stop(natural()).block?.reason).toMatch(/^\[RELAY\] Your relay watch is hung \(its heartbeat stopped\)/);
  }, 60_000);

  it("mail pending AND no live watch → ONE block carrying the mail wake and the re-arm line", () => {
    armedOnce();
    db.sendMessage("h-alice", "h-bob", "x", "normal");
    const b = stop(natural()).block;
    expect(b?.decision).toBe("block");
    expect(b?.reason).toMatch(/^\[RELAY\] 1 pending message for h-bob, latest from h-alice\. .* this wake did not consume it\. \[RELAY\] Your relay watch is not running: .*--until-wake$/);
  });

  it("never inside our own continuation (stop_hook_active), and never without a session id (it cannot be bounded to once)", () => {
    armedOnce();
    expect(stop({ session_id: "sess-1", stop_hook_active: true }).out).toBe("");
    expect(stop({ stop_hook_active: false }).out).toBe("");
    expect(stop({ session_id: "bad id; rm -rf", stop_hook_active: false }).out).toBe("");
  });
});
