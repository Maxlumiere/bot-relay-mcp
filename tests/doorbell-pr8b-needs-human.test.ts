// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 8b (gate brief §6; rulings 7eb82f49, 1cd77de6 "A'"): an HONEST state for an agent with no automatic
 * wake. The wake-coverage detector's UNCOVERED is split by the agent's watch history, DERIVED from the relay's own
 * record: a write-once watch-seen marker that BOTH watch kinds write at start. No marker past a 7-day grace →
 * NEEDS_HUMAN (a report on the same surfaces, never an alarm); a watch that existed → UNCOVERED (the alarm), with
 * reason two_windows when two live windows are bound. Within the grace nothing is split.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { openWindow, type TestWindow } from "./helpers/watch-window.js";
import { startToken } from "./helpers/start-token.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO, "bin", "relay");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-pr8b-")));
const INST = path.join(ROOT, "inst");
const DB = path.join(INST, "relay.db");
const SINK = path.join(ROOT, "wake-coverage-status.json");
process.env.RELAY_DB_PATH = DB;
process.env.RELAY_WAKE_COVERAGE_STATUS_PATH = SINK;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const db = await import("../src/db.js");
const D = await import("../src/wake-coverage-detector.js");
const SEEN = await import("../src/watch-seen.js");
const ST = await import("../src/wake-coverage-status.js");
const W = await import("../src/watch-wake.js");
const { log } = await import("../src/logger.js");
const { getOwnHostId } = await import("../src/liveness.js");
const OWN = getOwnHostId();

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const OPTS = { nowMs: NOW, boundMs: 24 * HOUR, antiFlapMarginMs: 24 * HOUR };
const windows: TestWindow[] = [];
afterAll(async () => {
  await Promise.allSettled(windows.map((w) => w.close()));
  db.closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function reset(): void {
  db.closeDb();
  fs.rmSync(INST, { recursive: true, force: true });
  fs.rmSync(SINK, { force: true });
  fs.mkdirSync(INST, { recursive: true });
  db.getDb();
}
/** An agent that drained before, then went dark with mail stuck past the 48 h threshold: today's UNCOVERED. */
function regressed(agent: string): void {
  db.registerAgent(agent, "r", []);
  db.getDb().prepare("UPDATE agents SET last_drain_at = ? WHERE name = ?").run(new Date(NOW - 72 * HOUR).toISOString(), agent);
  db.getDb()
    .prepare("INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, 'x', ?, 'm', 'normal', 'pending', ?)")
    .run(`stuck-${agent}`, agent, new Date(NOW - 50 * HOUR).toISOString());
}
/** Backdate the store's creation stamp (the grace's start). */
function stampAgo(ms: number): void {
  const dir = SEEN.ensureWatchSeenStore(DB);
  fs.writeFileSync(path.join(dir, SEEN.WATCH_SEEN_STAMP), new Date(NOW - ms).toISOString());
}
const env = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: path.join(ROOT, "home"), RELAY_DB_PATH: DB, RELAY_FILESYSTEM_MARKERS: "0", RELAY_HTTP_PORT: "1" });

describe("the watch-seen store: write-once, no-follow, private", () => {
  beforeEach(() => reset());
  it("a record creates the store (0700) with its creation stamp, and the agent's marker (0600) holding an ISO time; a second record keeps the first", () => {
    SEEN.recordWatchSeen(DB, "s-bob", new Date(NOW - 5000));
    const dir = SEEN.watchSeenDir(DB);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    const marker = path.join(dir, "s-bob");
    expect(fs.statSync(marker).mode & 0o777).toBe(0o600);
    const first = fs.readFileSync(marker, "utf-8");
    expect(Date.parse(first)).toBe(NOW - 5000);
    SEEN.recordWatchSeen(DB, "s-bob", new Date(NOW));
    expect(fs.readFileSync(marker, "utf-8")).toBe(first);
    expect(Number.isFinite(Date.parse(fs.readFileSync(path.join(dir, SEEN.WATCH_SEEN_STAMP), "utf-8")))).toBe(true);
  });
  it("a LINKED store is refused (its target untouched); a linked marker is never followed and never reads as seen", () => {
    const target = path.join(ROOT, "elsewhere");
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, SEEN.watchSeenDir(DB));
    expect(() => SEEN.recordWatchSeen(DB, "s-bob")).toThrow(/not a real directory/);
    expect(fs.readdirSync(target)).toEqual([]);
    fs.rmSync(SEEN.watchSeenDir(DB));
    SEEN.ensureWatchSeenStore(DB);
    const victim = path.join(ROOT, "victim");
    fs.writeFileSync(victim, "keep");
    fs.symlinkSync(victim, path.join(SEEN.watchSeenDir(DB), "s-eve"));
    SEEN.recordWatchSeen(DB, "s-eve");
    expect(fs.readFileSync(victim, "utf-8")).toBe("keep");
    stampAgo(8 * DAY);
    expect(SEEN.readWatchSeen(DB, NOW).seen("s-eve")).toBe(false);
  });
  it("the grace: absent store → not over; 6 days → not over; 8 days → over", () => {
    expect(SEEN.readWatchSeen(DB, NOW).graceOver).toBe(false);
    stampAgo(6 * DAY);
    expect(SEEN.readWatchSeen(DB, NOW).graceOver).toBe(false);
    stampAgo(8 * DAY);
    expect(SEEN.readWatchSeen(DB, NOW).graceOver).toBe(true);
  });
});

describe("the split (classify with a watchClass): ONLY 'never' leaves the alarm", () => {
  beforeEach(() => reset());
  it("never → NEEDS_HUMAN, with the queued line, the count and the oldest age", () => {
    regressed("s-codex");
    const [f] = D.classifyWakeCoverage(db.getDb(), { ...OPTS, watchClass: () => "never" });
    expect(f).toMatchObject({ agent: "s-codex", verdict: "needs_human", pendingCount: 1 });
    expect(D.formatWakeCoverageFindings([f!])).toEqual(["[wake-coverage] NEEDS_HUMAN — s-codex: queued: no automatic wake exists for this agent; mail waits for a person (1 message(s), oldest 50.0h)."]);
  });
  it("armed (a watch existed: absent, stale, dormant, live) → UNCOVERED, the alarm, as before", () => {
    regressed("s-bob");
    const [f] = D.classifyWakeCoverage(db.getDb(), { ...OPTS, watchClass: () => "armed" });
    expect(f).toMatchObject({ verdict: "uncovered" });
    expect(f!.reason).toBeUndefined();
    expect(D.formatWakeCoverageFindings([f!])[0]).toContain("[wake-coverage] UNCOVERED — s-bob");
  });
  it("two_windows → UNCOVERED with that reason and the line", () => {
    regressed("s-bob");
    const [f] = D.classifyWakeCoverage(db.getDb(), { ...OPTS, watchClass: () => "two_windows" });
    expect(f).toMatchObject({ verdict: "uncovered", reason: "two_windows" });
    expect(D.formatWakeCoverageFindings([f!])).toEqual(["[wake-coverage] UNCOVERED — s-bob: two windows are bound to s-bob; close one (no wake until then) (1 pending, oldest 50.0h)."]);
  });
  it("no watchClass (any other caller) → UNCOVERED exactly as before 8b", () => {
    regressed("s-bob");
    expect(D.classifyWakeCoverage(db.getDb(), OPTS)[0]).toMatchObject({ verdict: "uncovered" });
  });
  it("UNOBSERVABLE is not split (no drain marker: never NEEDS_HUMAN)", () => {
    db.registerAgent("s-quiet", "r", []);
    db.getDb().prepare("INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES ('q1', 'x', 's-quiet', 'm', 'normal', 'pending', ?)").run(new Date(NOW - 50 * HOUR).toISOString());
    expect(D.classifyWakeCoverage(db.getDb(), { ...OPTS, watchClass: () => "never" })[0]).toMatchObject({ verdict: "unobservable" });
  });
});

describe("the daemon's derivation (watchClassForDaemon): the watch-seen marker, past the grace", () => {
  beforeEach(async () => {
    await Promise.allSettled(windows.splice(0).map((w) => w.close()));
    reset();
  });
  it("WITHIN the grace, no marker → armed (the split is off: UNCOVERED as before)", () => {
    stampAgo(1 * DAY);
    expect(D.watchClassForDaemon(db.getDb(), DB, NOW)("s-bob")).toBe("armed");
  });
  it("PAST the grace, no marker → never; with a marker → armed", () => {
    stampAgo(8 * DAY);
    const cls = D.watchClassForDaemon(db.getDb(), DB, NOW);
    expect(cls("s-codex")).toBe("never");
    SEEN.recordWatchSeen(DB, "s-bob");
    expect(D.watchClassForDaemon(db.getDb(), DB, NOW)("s-bob")).toBe("armed");
  });
  it("PIN: it reads the watch-seen marker, NOT the --until-wake agent dir (that dir alone, no marker, past the grace → never)", () => {
    stampAgo(8 * DAY);
    fs.mkdirSync(W.watchAgentDir(DB, "s-bob") as string, { recursive: true });
    expect(D.watchClassForDaemon(db.getDb(), DB, NOW)("s-bob")).toBe("never");
  });
  it("an unreadable store (a stamp that is not a time) → the grace is NOT over (never a NEEDS_HUMAN from a broken store)", () => {
    SEEN.ensureWatchSeenStore(DB);
    fs.writeFileSync(path.join(SEEN.watchSeenDir(DB), SEEN.WATCH_SEEN_STAMP), "garbage");
    expect(D.watchClassForDaemon(db.getDb(), DB, NOW + 30 * DAY)("s-codex")).toBe("armed");
  });
  it.skipIf(!OWN)("two live windows bound to an agent that armed --until-wake → two_windows (the e1288f6f RED)", async () => {
    db.registerAgent("s-bob", "r", []);
    SEEN.recordWatchSeen(DB, "s-bob");
    fs.mkdirSync(W.watchAgentDir(DB, "s-bob") as string, { recursive: true });
    for (let i = 0; i < 2; i++) {
      const w = openWindow(path.join(ROOT, `win-${i}-${Date.now()}`), env());
      windows.push(w);
      db.upsertAgentBinding(db.getDb(), { hostId: OWN as string, windowPid: w.pid, windowPidStart: startToken(w.pid), agentName: "s-bob", agentClass: null, conversationId: `conv-${w.pid}`, conversationTitle: null, cwd: ROOT, boundVia: "launch-intent" });
    }
    expect(D.watchClassForDaemon(db.getDb(), DB, NOW)("s-bob")).toBe("two_windows");
    // and with pending mail stuck past the threshold, the daemon's sweep reports it UNCOVERED with that reason
    db.getDb().prepare("UPDATE agents SET last_drain_at = ? WHERE name = 's-bob'").run(new Date(NOW - 72 * HOUR).toISOString());
    db.getDb().prepare("INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES ('tw1', 'x', 's-bob', 'm', 'normal', 'pending', ?)").run(new Date(NOW - 50 * HOUR).toISOString());
    const [f] = D.classifyWakeCoverage(db.getDb(), { ...OPTS, watchClass: D.watchClassForDaemon(db.getDb(), DB, NOW) });
    expect(f).toMatchObject({ verdict: "uncovered", reason: "two_windows" });
  }, 30_000);
});

describe("the daemon's sweep: the store exists from its first sweep; NEEDS_HUMAN reaches the sink and the log", () => {
  beforeEach(() => reset());
  const run = () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const h = D.startWakeCoverageSweep(db.getDb(), { scheduler: { setInterval: () => ({ stop: () => {} }) }, now: () => NOW, dbPath: DB });
    h.stop();
    const lines = warn.mock.calls.flat().map(String);
    warn.mockRestore();
    return lines;
  };
  it("first sweep: creates the store and its stamp; a no-marker agent is UNCOVERED (inside the grace)", () => {
    regressed("s-codex");
    const lines = run();
    expect(fs.existsSync(path.join(SEEN.watchSeenDir(DB), SEEN.WATCH_SEEN_STAMP))).toBe(true);
    expect(lines.join("\n")).toContain("[wake-coverage] UNCOVERED — s-codex");
  });
  it("past the grace: a no-marker agent is NEEDS_HUMAN in the log AND the sink; a marked agent stays UNCOVERED", () => {
    regressed("s-codex");
    regressed("s-bob");
    stampAgo(8 * DAY);
    SEEN.recordWatchSeen(DB, "s-bob");
    const lines = run().join("\n");
    expect(lines).toContain("[wake-coverage] NEEDS_HUMAN — s-codex");
    expect(lines).toContain("[wake-coverage] UNCOVERED — s-bob");
    const sink = ST.readWakeCoverageStatus(SINK);
    expect(sink?.findings.map((f) => [f.agent, f.verdict]).sort()).toEqual([["s-bob", "uncovered"], ["s-codex", "needs_human"]]);
  });
});

describe("the status sink and the SessionStart line: NEEDS_HUMAN is REPORTED, never an alarm, never hidden", () => {
  const rec = (findings: object[]) => ({ v: 1, generatedAt: new Date(NOW).toISOString(), thresholdMs: 48 * HOUR, findings });
  const f = (agent: string, verdict: string, extra: object = {}) => ({ agent, verdict, pendingCount: 2, oldestCreatedAt: new Date(NOW - 50 * HOUR).toISOString(), oldestAgeMs: 50 * HOUR, thresholdMs: 48 * HOUR, ...extra });
  it("v:1 stays; needs_human and reason two_windows are valid; an unknown reason is not (UNKNOWN, fail-closed)", () => {
    expect(ST.isValidWakeCoverageStatus(rec([f("a", "needs_human")]))).toBe(true);
    expect(ST.isValidWakeCoverageStatus(rec([f("a", "uncovered", { reason: "two_windows" })]))).toBe(true);
    expect(ST.isValidWakeCoverageStatus(rec([f("a", "uncovered", { reason: "something_else" })]))).toBe(false);
  });
  it("only NEEDS_HUMAN → a report line (no *** alarm), naming the agent, its count and oldest age", () => {
    const line = ST.formatWakeCoverageStatusLine(rec([f("s-codex", "needs_human")]) as never, NOW);
    expect(line).not.toContain("***");
    expect(line).toContain("NEEDS_HUMAN");
    expect(line).toContain("s-codex (2 message(s), oldest 2d)");
  });
  it("UNCOVERED + NEEDS_HUMAN → the alarm, with the queued agents appended (never dropped); two_windows is named", () => {
    const line = ST.formatWakeCoverageStatusLine(rec([f("s-bob", "uncovered", { reason: "two_windows" }), f("s-codex", "needs_human")]) as never, NOW);
    expect(line).toContain("*** wake-coverage: 1 agent(s) UNCOVERED");
    expect(line).toContain("s-bob (two windows bound: close one)");
    expect(line).toContain("Queued for a person");
    expect(line).toContain("s-codex");
  });
});

describe("both watch kinds write the marker at start; a marker failure never stops a watch", () => {
  beforeEach(() => reset());
  function streaming(agent: string, sendAfterMs: number | null): Promise<{ woke: boolean; err: string }> {
    return new Promise((resolve) => {
      const w = spawn(process.execPath, [RELAY_BIN, "watch", agent, "--json", "--interval", "1"], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      w.stderr.on("data", (d) => (err += d));
      w.stdout.on("data", (d) => {
        out += d;
        if (out.includes('"event":"wake"')) w.kill("SIGTERM");
      });
      const send = sendAfterMs === null ? null : setTimeout(() => db.sendMessage("s-alice", agent, "x", "normal"), sendAfterMs);
      const stop = setTimeout(() => w.kill("SIGTERM"), sendAfterMs === null ? 2500 : 15_000);
      w.on("exit", () => {
        if (send) clearTimeout(send);
        clearTimeout(stop);
        resolve({ woke: out.includes('"event":"wake"'), err });
      });
    });
  }
  it("the STREAMING watch writes its marker; the --until-wake agent dir is NOT created (a stopgap agent is never told to arm --until-wake: its Stop-hook heal stays silent)", async () => {
    db.registerAgent("s-bob", "r", []);
    await streaming("s-bob", null);
    expect(fs.statSync(path.join(SEEN.watchSeenDir(DB), "s-bob")).isFile()).toBe(true);
    expect(fs.existsSync(W.watchAgentDir(DB, "s-bob") as string)).toBe(false);
    const p = spawnSync("node", [RELAY_BIN, "pending", "s-bob", "--json", "--watch-status"], { env: env(), encoding: "utf-8" });
    expect((JSON.parse(p.stdout) as { watch: string }).watch).toBe("never"); // what the Stop hook reads: no heal block
  }, 30_000);
  it("a marker-write FAILURE (the store is a file) → one stderr note, and the streaming watch still wakes", async () => {
    db.registerAgent("s-alice", "s", []);
    db.registerAgent("s-bob", "r", []);
    fs.writeFileSync(SEEN.watchSeenDir(DB), "not a dir");
    const r = await streaming("s-bob", 1500);
    expect(r.woke).toBe(true);
    expect(r.err.split("\n").filter((l) => l.includes("watch-seen marker")).length).toBe(1);
  }, 30_000);
  it("--until-wake writes its marker too (even when it then refuses to arm: no window here)", async () => {
    db.registerAgent("s-bob", "r", []);
    const w = spawn(process.execPath, [RELAY_BIN, "watch", "s-bob", "--until-wake", "--interval", "1"], { env: env(), stdio: "ignore" });
    const marker = path.join(SEEN.watchSeenDir(DB), "s-bob");
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
    w.kill("SIGTERM");
    expect(fs.existsSync(marker)).toBe(true);
  }, 30_000);
});

describe("TRIPWIRES: one reader, no remover", () => {
  const srcFiles = (): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts")) out.push([path.relative(REPO, p), fs.readFileSync(p, "utf-8")]);
      }
    };
    walk(path.join(REPO, "src"));
    return out;
  };
  it("readWatchSeen is read ONLY by the wake-coverage detector", () => {
    const readers = srcFiles().filter(([f, t]) => f !== "src/watch-seen.ts" && /\breadWatchSeen\b/.test(t)).map(([f]) => f);
    expect(readers).toEqual(["src/wake-coverage-detector.ts"]);
  });
  it("no src/ code removes the watch-seen store or its files (watch-seen.ts has no unlink/rm/rmdir; nothing else names the store)", () => {
    const own = srcFiles().find(([f]) => f === "src/watch-seen.ts")![1];
    expect(own).not.toMatch(/\b(unlinkSync|rmSync|rmdirSync|unlink|rm|rmdir|renameSync)\s*\(/);
    const namers = srcFiles().filter(([f, t]) => f !== "src/watch-seen.ts" && /["'`]watch-seen["'`]|WATCH_SEEN_DIR/.test(t)).map(([f]) => f);
    expect(namers).toEqual([]);
  });
});
