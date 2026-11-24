// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 8b (gate brief §6; rulings 7eb82f49, 9ac81564): an HONEST state for an agent with no automatic wake.
 * The wake-coverage detector's UNCOVERED is split by POSITIVE evidence from the relay's own registration record: an
 * agent whose registered CLI profile is known and has autoWake false reads NEEDS_HUMAN (a report on the same
 * surfaces, never an alarm). A NULL or unknown profile and any read error stay UNCOVERED (the alarm); two live
 * windows bound to an agent that armed --until-wake stay UNCOVERED with reason two_windows.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
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
const ST = await import("../src/wake-coverage-status.js");
const W = await import("../src/watch-wake.js");
const { log } = await import("../src/logger.js");
const { getOwnHostId } = await import("../src/liveness.js");
const OWN = getOwnHostId();

const HOUR = 3_600_000;
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
function regressed(agent: string, cli_profile: string | null = null): void {
  db.registerAgent(agent, "r", [], { cli_profile });
  db.getDb().prepare("UPDATE agents SET last_drain_at = ? WHERE name = ?").run(new Date(NOW - 72 * HOUR).toISOString(), agent);
  db.getDb()
    .prepare("INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, 'x', ?, 'm', 'normal', 'pending', ?)")
    .run(`stuck-${agent}`, agent, new Date(NOW - 50 * HOUR).toISOString());
}
const env = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: path.join(ROOT, "home"), RELAY_DB_PATH: DB, RELAY_FILESYSTEM_MARKERS: "0", RELAY_HTTP_PORT: "1", RELAY_WAKE_COVERAGE_STATUS_PATH: SINK });

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

describe("the daemon's derivation (watchClassForDaemon): the REGISTERED CLI profile, positive evidence only", () => {
  beforeEach(async () => {
    await Promise.allSettled(windows.splice(0).map((w) => w.close()));
    reset();
  });
  it("a codex agent (autoWake false) with stuck mail → NEEDS_HUMAN", () => {
    regressed("s-codex", "codex");
    expect(D.watchClassForDaemon(db.getDb(), DB)("s-codex")).toBe("never");
    expect(D.classifyWakeCoverage(db.getDb(), { ...OPTS, watchClass: D.watchClassForDaemon(db.getDb(), DB) })[0]).toMatchObject({ agent: "s-codex", verdict: "needs_human" });
  });
  it("a claude agent (autoWake true) → UNCOVERED, the alarm", () => {
    regressed("s-claude", "claude");
    expect(D.classifyWakeCoverage(db.getDb(), { ...OPTS, watchClass: D.watchClassForDaemon(db.getDb(), DB) })[0]).toMatchObject({ verdict: "uncovered" });
  });
  it("a NULL profile → UNCOVERED; an UNKNOWN profile string is normalised to NULL at registration → UNCOVERED", () => {
    regressed("s-none", null);
    regressed("s-other", "some-future-cli");
    expect(db.getDb().prepare("SELECT cli_profile FROM agents WHERE name = 's-other'").get()).toEqual({ cli_profile: null });
    const cls = D.watchClassForDaemon(db.getDb(), DB);
    expect([cls("s-none"), cls("s-other")]).toEqual(["armed", "armed"]);
  });
  it("ANY read error → UNCOVERED (a read error never silences the alarm)", () => {
    regressed("s-codex", "codex");
    const broken = {
      prepare: () => {
        throw new Error("SQLITE_IOERR");
      },
    } as unknown as Parameters<typeof D.watchClassForDaemon>[0];
    expect(D.watchClassForDaemon(broken, DB)("s-codex")).toBe("armed");
  });
  it("the registry: codex has autoWake false, claude true; profileHasNoAutoWake is true ONLY for a known profile with autoWake false", async () => {
    const P = await import("../src/agent-cli-profiles.js");
    expect([P.getAgentCliProfile("codex")?.autoWake, P.getAgentCliProfile("claude")?.autoWake]).toEqual([false, true]);
    expect([P.profileHasNoAutoWake("codex"), P.profileHasNoAutoWake("claude"), P.profileHasNoAutoWake(null), P.profileHasNoAutoWake(""), P.profileHasNoAutoWake("unknown-cli")]).toEqual([true, false, false, false, false]);
  });
  it.skipIf(!OWN)("two live windows bound to an agent that armed --until-wake → two_windows (the e1288f6f RED)", async () => {
    regressed("s-bob", "claude");
    fs.mkdirSync(W.watchAgentDir(DB, "s-bob") as string, { recursive: true });
    for (let i = 0; i < 2; i++) {
      const w = openWindow(path.join(ROOT, `win-${i}-${Date.now()}`), env());
      windows.push(w);
      db.upsertAgentBinding(db.getDb(), { hostId: OWN as string, windowPid: w.pid, windowPidStart: startToken(w.pid), agentName: "s-bob", agentClass: null, conversationId: `conv-${w.pid}`, conversationTitle: null, cwd: ROOT, boundVia: "launch-intent" });
    }
    expect(D.watchClassForDaemon(db.getDb(), DB)("s-bob")).toBe("two_windows");
    const [f] = D.classifyWakeCoverage(db.getDb(), { ...OPTS, watchClass: D.watchClassForDaemon(db.getDb(), DB) });
    expect(f).toMatchObject({ verdict: "uncovered", reason: "two_windows" });
  }, 30_000);
});

describe("the daemon's sweep: NEEDS_HUMAN reaches the log, the sink and doorbell status", () => {
  beforeEach(() => reset());
  const run = () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const h = D.startWakeCoverageSweep(db.getDb(), { scheduler: { setInterval: () => ({ stop: () => {} }) }, now: () => NOW, dbPath: DB });
    h.stop();
    const lines = warn.mock.calls.flat().map(String);
    warn.mockRestore();
    return lines;
  };
  it("a codex agent is NEEDS_HUMAN, a claude agent UNCOVERED, in the log AND the sink AND doorbell status (classed report / alarm)", () => {
    regressed("s-codex", "codex");
    regressed("s-bob", "claude");
    const lines = run().join("\n");
    expect(lines).toContain("[wake-coverage] NEEDS_HUMAN — s-codex");
    expect(lines).toContain("[wake-coverage] UNCOVERED — s-bob");
    const sink = ST.readWakeCoverageStatus(SINK);
    expect(sink?.findings.map((f) => [f.agent, f.verdict]).sort()).toEqual([["s-bob", "uncovered"], ["s-codex", "needs_human"]]);
    const j = JSON.parse(spawnSync("node", [RELAY_BIN, "doorbell", "status", "--json"], { env: env(), encoding: "utf-8" }).stdout) as { wake_coverage: { state: string; findings: Array<Record<string, unknown>> } };
    expect(j.wake_coverage.state).toBe("read");
    const by = Object.fromEntries(j.wake_coverage.findings.map((x) => [x.agent, x]));
    expect(by["s-codex"]).toMatchObject({ verdict: "needs_human", class: "report", pending_count: 1 });
    expect(by["s-bob"]).toMatchObject({ verdict: "uncovered", class: "alarm", pending_count: 1 });
    expect(spawnSync("node", [RELAY_BIN, "doorbell", "status"], { env: env(), encoding: "utf-8" }).stdout).toContain("s-codex=needs_human");
  }, 30_000);
  it("no sink → doorbell status says wake_coverage unknown (never an empty, healthy list)", () => {
    const j = JSON.parse(spawnSync("node", [RELAY_BIN, "doorbell", "status", "--json"], { env: env(), encoding: "utf-8" }).stdout) as { wake_coverage: unknown };
    expect(j.wake_coverage).toEqual({ state: "unknown" });
  }, 30_000);
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
    const line = ST.formatWakeCoverageStatusLine(rec([f("s-codex", "needs_human")]) as never, NOW, 3 * HOUR);
    expect(line).not.toContain("***");
    expect(line).toContain("NEEDS_HUMAN");
    expect(line).toContain("s-codex (2 message(s), oldest 2d)");
  });
  it("UNCOVERED + NEEDS_HUMAN → the alarm, with the queued agents appended (never dropped); two_windows is named", () => {
    const line = ST.formatWakeCoverageStatusLine(rec([f("s-bob", "uncovered", { reason: "two_windows" }), f("s-codex", "needs_human")]) as never, NOW, 3 * HOUR);
    expect(line).toContain("*** wake-coverage: 1 agent(s) UNCOVERED");
    expect(line).toContain("s-bob (two windows bound: close one)");
    expect(line).toContain("Queued for a person");
    expect(line).toContain("s-codex");
  });
});

describe("A1 §A2 (the doorbell stays unreachable from the server): the daemon's sweep reaches NO doorbell or watch module", () => {
  /** The TRANSITIVE closure of relative imports (static and dynamic) from a src/ module. */
  function closure(entry: string): string[] {
    const seen = new Set<string>();
    const visit = (abs: string) => {
      if (seen.has(abs)) return;
      seen.add(abs);
      const text = fs.readFileSync(abs, "utf-8");
      for (const m of text.matchAll(/(?:from\s+|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
        const target = path.resolve(path.dirname(abs), m[1]!.replace(/\.js$/, ".ts"));
        if (fs.existsSync(target)) visit(target);
      }
    };
    visit(path.join(REPO, entry));
    return [...seen].map((p) => path.relative(REPO, p)).sort();
  }
  it("src/wake-coverage-detector.ts (what the HTTP daemon starts) never reaches doorbell-* / watch-wake / watch-owner / watch-until-wake", () => {
    const reach = closure("src/wake-coverage-detector.ts");
    expect(reach.length).toBeGreaterThan(5); // non-vacuous: it followed the imports
    expect(reach).toContain("src/window-judge.ts");
    expect(reach.filter((f) => /\/doorbell[-.]|\/watch-wake\.ts$|\/watch-owner\.ts$|\/watch-until-wake\.ts$/.test(f))).toEqual([]);
  });
  it("and neither does the HTTP transport as a whole", () => {
    const reach = closure("src/transport/http.ts");
    expect(reach).toContain("src/wake-coverage-detector.ts");
    expect(reach.filter((f) => /\/doorbell[-.]|\/watch-wake\.ts$|\/watch-owner\.ts$|\/watch-until-wake\.ts$/.test(f))).toEqual([]);
  });
});

describe("the mutation fixture (tests/fixtures/doorbell-pr8b-mutants.json)", () => {
  it("every mutant still applies: its find text occurs exactly once in its file; names are unique", () => {
    const M = JSON.parse(fs.readFileSync(path.join(REPO, "tests", "fixtures", "doorbell-pr8b-mutants.json"), "utf-8")) as Array<{ name: string; file: string; find: string }>;
    expect(M.length).toBeGreaterThanOrEqual(12);
    for (const m of M) expect(fs.readFileSync(path.join(REPO, m.file), "utf-8").split(m.find).length - 1, m.name).toBe(1);
    expect(new Set(M.map((m) => m.name)).size).toBe(M.length);
  });
});

