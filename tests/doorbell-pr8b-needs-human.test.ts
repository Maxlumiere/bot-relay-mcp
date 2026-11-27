// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 8b (gate brief §6; rulings 7eb82f49, 9ac81564): an HONEST state for an agent with no automatic wake.
 * The wake-coverage detector's UNCOVERED is split by POSITIVE evidence the RELAY OBSERVES (ruling cc9f2199): the CLI
 * profile of the agent's own nearest agent process, re-derived at every registration (agents.cli_profile_observed),
 * never the caller-supplied cli_profile. Known with autoWake false → NEEDS_HUMAN (a report on the same surfaces,
 * never an alarm). NULL and any read error stay UNCOVERED (the alarm); two live windows bound to an agent that armed
 * --until-wake stay UNCOVERED with reason two_windows.
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
/** `observed`: the profile the relay observed (what the verdict reads); `supplied`: the caller's (informational). */
function regressed(agent: string, observed: string | null = null, supplied: string | null = null): void {
  const { observed_gen } = db.registerAgent(agent, "r", [], { cli_profile: supplied });
  db.setObservedCliProfile(agent, observed, new Date(NOW - 80 * HOUR).toISOString(), { expectGen: observed_gen });
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
  it("a NULL observed profile → UNCOVERED; an unknown id is stored as NULL → UNCOVERED", () => {
    regressed("s-none", null);
    regressed("s-other", "some-future-cli");
    expect(db.getDb().prepare("SELECT cli_profile_observed FROM agents WHERE name = 's-other'").get()).toEqual({ cli_profile_observed: null });
    const cls = D.watchClassForDaemon(db.getDb(), DB);
    expect([cls("s-none"), cls("s-other")]).toEqual(["armed", "armed"]);
  });
  it("the CALLER's cli_profile is never read: supplied codex, observed NULL → UNCOVERED; supplied claude, observed codex → NEEDS_HUMAN", () => {
    regressed("s-claims", null, "codex");
    regressed("s-real", "codex", "claude");
    const cls = D.watchClassForDaemon(db.getDb(), DB);
    expect([cls("s-claims"), cls("s-real")]).toEqual(["armed", "never"]);
  });
  it("P1-c: a BINDINGS read error → UNCOVERED, decided BEFORE the profile, on EVERY path (no watch dir here; even an observed codex)", () => {
    regressed("s-codex", "codex");
    const real = db.getDb();
    const failingBindings = { prepare: (sql: string) => (/agent_bindings/i.test(sql) ? (() => { throw new Error("SQLITE_IOERR"); })() : real.prepare(sql)) } as unknown as Parameters<typeof D.watchClassForDaemon>[0];
    expect(D.watchClassForDaemon(failingBindings, DB)("s-codex")).toBe("armed");
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
  it("a PROFILE read error alone (the bindings read fine) → UNCOVERED, even for an observed codex", () => {
    regressed("s-codex", "codex");
    const real = db.getDb();
    const failingProfile = { prepare: (sql: string) => (/cli_profile_observed/i.test(sql) ? (() => { throw new Error("SQLITE_IOERR"); })() : real.prepare(sql)) } as unknown as Parameters<typeof D.watchClassForDaemon>[0];
    expect(D.watchClassForDaemon(failingProfile, DB)("s-codex")).toBe("armed");
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
    expect(M.length).toBeGreaterThanOrEqual(26);
    for (const m of M) expect(fs.readFileSync(path.join(REPO, m.file), "utf-8").split(m.find).length - 1, m.name).toBe(1);
    expect(new Set(M.map((m) => m.name)).size).toBe(M.length);
  });
});

describe("the relay OBSERVES the profile (ruling cc9f2199; 9d0bb9e6: the nearest agent decides; a bounded probe)", () => {
  beforeEach(() => reset());
  const L = () => import("../src/liveness.js");
  it("observedProfileOf: one process's identity → exactly one profile, else null", async () => {
    const { observedProfileOf } = await L();
    expect(observedProfileOf("/usr/local/bin/codex --foo", "codex")).toBe("codex");
    expect(observedProfileOf("/opt/claude/claude", "claude")).toBe("claude");
    expect(observedProfileOf("/usr/bin/node /x/bin/codex", "node")).toBe("codex");
    expect(observedProfileOf("/usr/bin/vim", "vim")).toBeNull();
    expect(observedProfileOf("/home/u/claude-tools/bin/zsh", "zsh")).toBeNull(); // a name in a PATH never matches
  });
  it("the NEAREST agent decides: a codex process under a claude ancestor → codex; a claude process alone → claude", async () => {
    const { findAgentProcess, parseProcessTable } = await L();
    const row = (pid: number, ppid: number, cmd: string) => `${pid} ${ppid} Mon Nov 24 10:00:00 2026 ${cmd}`;
    const nested = parseProcessTable([row(10, 1, "/opt/claude/claude"), row(20, 10, "/usr/local/bin/codex"), row(30, 20, "node /r/dist/index.js")].join("\n"));
    expect(findAgentProcess(30, nested)?.profile).toBe("codex");
    const alone = parseProcessTable([row(10, 1, "/opt/claude/claude"), row(30, 10, "node /r/dist/index.js")].join("\n"));
    expect(findAgentProcess(30, alone)?.profile).toBe("claude");
  });
  it("R2 P2-b: the command judge and the comm judge must AGREE (full width): a truncated codex-helper, a comm naming another CLI, no comm, or a comm read of another instance → NULL", async () => {
    const { probeAgentProfile } = await L();
    const START = "Mon Nov 24 10:00:00 2026";
    const fake = (bin: string, lstart = START, comm = `/usr/local/bin/${bin}`) => async (args: string[]) =>
      args.includes("pid=,lstart=,comm=") ? `4242 ${lstart} ${comm}` : `4242 ${lstart} /usr/local/bin/${bin} --flag`;
    // R2 P2-b: the two judges must AGREE. A width-limited command line (".../codex" for ".../codex-helper") → NULL,
    // never codex; the comm naming another CLI → NULL; no comm → NULL.
    const helper = await probeAgentProfile(4242, `${START} UTC`, { run: fake("codex", START, "/usr/local/bin/codex-helper") });
    expect(helper.profile, "a truncated codex-helper is never codex").toBeNull();
    expect(helper.why).toMatch(/do not agree/);
    expect((await probeAgentProfile(4242, `${START} UTC`, { run: fake("codex", START, "/opt/claude/claude") })).profile, "comm says claude, the command says codex").toBeNull();
    expect((await probeAgentProfile(4242, `${START} UTC`, { run: fake("codex", START, "") })).profile, "no comm").toBeNull();
    const otherStartComm = async (args: string[]) => (args.includes("pid=,lstart=,comm=") ? `4242 Tue Nov 25 10:00:00 2026 /usr/local/bin/codex` : `4242 ${START} /usr/local/bin/codex --flag`);
    expect((await probeAgentProfile(4242, `${START} UTC`, { run: otherStartComm })).profile, "a comm read of ANOTHER process instance (another start) is never used").toBeNull();
  });
  it("probeAgentProfile: the same process (start token equal) → its profile; another process now, a timeout, an error, no pid, no start → NULL with a why", async () => {
    const { probeAgentProfile } = await L();
    const START = "Mon Nov 24 10:00:00 2026";
    // ONE coherent snapshot per probe (pid, start and command in the same read): the fake counts its calls.
    // R2 P2-b: the FULL-WIDTH command line, then the comm read with the same start; both must agree.
    let seen: string[][] = [];
    const fake = (bin: string, lstart = START, comm = `/usr/local/bin/${bin}`) => async (args: string[]) => {
      seen.push(args);
      return args.includes("pid=,lstart=,comm=") ? `4242 ${lstart} ${comm}` : `4242 ${lstart} /usr/local/bin/${bin} --flag`;
    };
    expect(await probeAgentProfile(4242, `${START} UTC`, { run: fake("codex") })).toEqual({ profile: "codex" });
    expect(seen, "the command read and the comm read, both full width").toEqual([
      ["-ww", "-o", "pid=,lstart=,command=", "-p", "4242"],
      ["-ww", "-o", "pid=,lstart=,comm=", "-p", "4242"],
    ]);
    seen = [];
    expect((await probeAgentProfile(4242, `${START} UTC`, { run: fake("codex", "Tue Nov 25 10:00:00 2026") })).profile).toBeNull();
    const hang = () => new Promise<string>(() => {});
    const t0 = Date.now();
    const timed = await probeAgentProfile(4242, `${START} UTC`, { run: hang, timeoutMs: 80 });
    expect(timed.profile).toBeNull();
    expect(timed.why).toMatch(/timed out/);
    // A LIVENESS guard on the product's probe timeout (timeoutMs 80 here): the 2000 ms ceiling is a 25× margin, so a
    // slow runner cannot turn it into a flake. The property itself (a hanging ps is cut) is the `timed out` why above.
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((await probeAgentProfile(4242, `${START} UTC`, { run: async () => { throw new Error("ps failed"); } })).profile).toBeNull();
    expect((await probeAgentProfile(undefined, `${START} UTC`)).why).toBe("no agent pid");
    expect((await probeAgentProfile(4242, null)).why).toMatch(/no agent start token/);
  });
  /**
   * A fake `ps`: the table (`-axo pid=,ppid=,lstart=,command=`) has THIS process under `parentCmd`, under a claude
   * ancestor; a comm read (`-o pid=,lstart=,comm= -p <pid>`) answers that pid's argv0, or `comms[pid]` when given.
   */
  const table = (parentCmd: string, extra: string[] = [], comms: Record<number, string> = {}) => {
    const rows = [`9001 1 Mon Nov 24 09:00:00 2026 /opt/claude/claude`, `9002 9001 Mon Nov 24 09:00:01 2026 ${parentCmd}`, `${process.pid} 9002 Mon Nov 24 09:00:02 2026 node /r/dist/index.js`, ...extra];
    return async (args: string[] = []) => {
      if (!args.includes("pid=,lstart=,comm=")) return rows.join("\n");
      const pid = Number(args[args.length - 1]);
      const row = rows.map((r) => r.match(/^(\d+) \d+ (\S+ \S+ \S+ \S+ \S+) (\S+)/)).find((m) => m && Number(m[1]) === pid);
      return row ? `${pid} ${row[2]} ${comms[pid] ?? row[3]}` : "";
    };
  };
  const settle = () => new Promise((res) => setTimeout(res, 50));
  /** The registration generation the row carries now (registerAgent wrote it). */
  const genOf = (name: string) => (db.getDb().prepare("SELECT cli_profile_observed_gen AS g FROM agents WHERE name = ?").get(name) as { g: string }).g;
  it("a STDIO server walks its OWN ancestry at registration (the nearest agent decides); a supplied profile that disagrees writes ONE log line", async () => {
    const { setOwnDetectedAgent, _setAsyncPsRunnerForTests, _resetStdioObserverForTests } = await L();
    const { handleRegisterAgent } = await import("../src/tools/identity.js");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    setOwnDetectedAgent(null); // this process is a stdio server
    _setAsyncPsRunnerForTests(table("/usr/local/bin/codex"));
    try {
      handleRegisterAgent({ name: "s-obs", role: "r", capabilities: [], cli_profile: "claude" } as never);
      await settle();
      expect(db.getDb().prepare("SELECT cli_profile, cli_profile_observed FROM agents WHERE name = 's-obs'").get()).toEqual({ cli_profile: "claude", cli_profile_observed: "codex" });
      expect(warn.mock.calls.flat().map(String).filter((l) => l.includes("cli_profile supplied")).length).toBe(1);
    } finally {
      _setAsyncPsRunnerForTests(null);
      _resetStdioObserverForTests();
      warn.mockRestore();
    }
  });
  it("P1: on a STDIO server a caller-named pid NEVER selects the observation (a claude session naming a local codex pid stays claude)", async () => {
    const { setOwnDetectedAgent, _setAsyncPsRunnerForTests, _resetStdioObserverForTests } = await L();
    const { handleRegisterAgent } = await import("../src/tools/identity.js");
    setOwnDetectedAgent(null);
    // The ancestry: this relay under a plain shell under claude; a codex process 7777 exists elsewhere on the host.
    _setAsyncPsRunnerForTests(table("/bin/zsh", ["7777 1 Mon Nov 24 08:00:00 2026 /usr/local/bin/codex"]));
    try {
      handleRegisterAgent({ name: "s-p1", role: "r", capabilities: [], agent_pid: 7777, agent_pid_start: "Mon Nov 24 08:00:00 2026 UTC" } as never);
      await settle();
      expect(db.getDb().prepare("SELECT cli_profile_observed FROM agents WHERE name = 's-p1'").get()).toEqual({ cli_profile_observed: "claude" });
    } finally {
      _setAsyncPsRunnerForTests(null);
      _resetStdioObserverForTests();
    }
  });
  it("P1, transport \"both\": on a process that is ALSO a stdio server, an HTTP request still gets the HTTP probe of its named pid (never the relay's own ancestry)", async () => {
    const { setOwnDetectedAgent, _setAsyncPsRunnerForTests, _resetStdioObserverForTests } = await L();
    const { deriveObservedCliProfile } = await import("../src/tools/identity.js");
    const { requestContext } = await import("../src/request-context.js");
    setOwnDetectedAgent(null);
    regressed("s-both", null);
    const seen: string[][] = [];
    _setAsyncPsRunnerForTests(async (args) => {
      seen.push(args);
      return args.includes("-axo") ? (await table("/usr/local/bin/codex")(args)) : "4343 Mon Nov 24 08:00:00 2026 /opt/claude/claude";
    });
    try {
      requestContext.run({ transport: "http" } as never, () =>
        deriveObservedCliProfile("s-both", { name: "s-both", role: "r", capabilities: [], agent_pid: 4343, agent_pid_start: "Mon Nov 24 08:00:00 2026 UTC" } as never, genOf("s-both")),
      );
      await settle();
      expect(seen).toEqual([
        ["-ww", "-o", "pid=,lstart=,command=", "-p", "4343"],
        ["-ww", "-o", "pid=,lstart=,comm=", "-p", "4343"],
      ]);
      expect(db.getDb().prepare("SELECT cli_profile_observed FROM agents WHERE name = 's-both'").get()).toEqual({ cli_profile_observed: "claude" });
    } finally {
      _setAsyncPsRunnerForTests(null);
      _resetStdioObserverForTests();
    }
  });
  it("P2: FRESH at every registration on stdio (never the startup cache): the ancestry changed between two registrations → the second records the new nearest agent", async () => {
    const { setOwnDetectedAgent, _setAsyncPsRunnerForTests, _resetStdioObserverForTests } = await L();
    const { deriveObservedCliProfile } = await import("../src/tools/identity.js");
    setOwnDetectedAgent({ pid: 9002, startedAt: "Mon Nov 24 09:00:01 2026 UTC", profile: "codex" }); // the startup cache says codex
    regressed("s-fresh", null);
    try {
      _setAsyncPsRunnerForTests(table("/usr/local/bin/codex"));
      deriveObservedCliProfile("s-fresh", { name: "s-fresh", role: "r", capabilities: [] } as never, genOf("s-fresh"));
      await settle();
      expect(db.getDb().prepare("SELECT cli_profile_observed FROM agents WHERE name = 's-fresh'").get()).toEqual({ cli_profile_observed: "codex" });
      _setAsyncPsRunnerForTests(table("/bin/zsh")); // the codex ancestor exited: the nearest agent is claude now
      deriveObservedCliProfile("s-fresh", { name: "s-fresh", role: "r", capabilities: [] } as never, genOf("s-fresh"));
      await settle();
      expect(db.getDb().prepare("SELECT cli_profile_observed FROM agents WHERE name = 's-fresh'").get()).toEqual({ cli_profile_observed: "claude" });
    } finally {
      _setAsyncPsRunnerForTests(null);
      _resetStdioObserverForTests();
    }
  });
  it("RE-DERIVED at every registration (no COALESCE): the re-registration's own statement resets codex to NULL, with a NEW generation", () => {
    regressed("s-again", "codex");
    const before = genOf("s-again");
    const { observed_gen } = db.registerAgent("s-again", "r", []);
    expect(db.getDb().prepare("SELECT cli_profile_observed FROM agents WHERE name = 's-again'").get()).toEqual({ cli_profile_observed: null });
    expect(genOf("s-again")).toBe(observed_gen);
    expect(observed_gen).not.toBe(before);
  });
  it("R2 P2-a: A registers, B registers, A's probe answers LATE → never A's value (B's, or NULL while B's probe is pending)", async () => {
    const { setOwnDetectedAgent, _setAsyncPsRunnerForTests, _resetStdioObserverForTests } = await L();
    const { deriveObservedCliProfile } = await import("../src/tools/identity.js");
    setOwnDetectedAgent(null); // a stdio server: each probe walks the ancestry
    // Each probe's table read waits until the test releases it with that probe's answer.
    // The comm read follows its table read at once, so it answers for the parent released for THAT probe.
    const pending: Array<(parentCmd: string) => void> = [];
    let released = "/bin/zsh";
    _setAsyncPsRunnerForTests(async (args) => {
      if (args.includes("pid=,lstart=,comm=")) return table(released)(args);
      return new Promise<string>((res) =>
        pending.push((parentCmd) => {
          released = parentCmd;
          void table(parentCmd)(args).then(res);
        }),
      );
    });
    try {
      const a = db.registerAgent("s-race", "r", []); // registration A (its own statement installs A's generation)
      const b = db.registerAgent("s-race", "r", []); // registration B, before A's probe ran
      // B's probe starts first; A's starts LATE (A's handler resumes after B's whole registration, as across processes).
      deriveObservedCliProfile("s-race", { name: "s-race", role: "r", capabilities: [] } as never, b.observed_gen);
      deriveObservedCliProfile("s-race", { name: "s-race", role: "r", capabilities: [] } as never, a.observed_gen);
      await settle();
      expect(pending.length, "both probes are waiting").toBe(2);
      pending[1]!("/usr/local/bin/codex"); // A's probe answers codex
      await settle();
      expect(db.getDb().prepare("SELECT cli_profile_observed FROM agents WHERE name = 's-race'").get(), "A's answer writes nothing: the row carries B's generation").toEqual({ cli_profile_observed: null });
      pending[0]!("/bin/zsh"); // B's probe: the nearest agent is claude
      await settle();
      expect(db.getDb().prepare("SELECT cli_profile_observed FROM agents WHERE name = 's-race'").get()).toEqual({ cli_profile_observed: "claude" });
    } finally {
      _setAsyncPsRunnerForTests(null);
      _resetStdioObserverForTests();
    }
  });
  /**
   * "Registration never waits on the probe" is an ORDERING property, proven by ordering (never by elapsed time: a
   * loaded runner read 511 ms against a 500 ms proxy). The ps stub answers only through a GATE the test opens AFTER
   * handleRegisterAgent has returned: at that point the probe has started (the stub was called) and is unanswered.
   * The probe's bound then passes (its ONE timeout line; 10 s is a hang guard only), and the gate opens with a LATE
   * answer that must write nothing. `stallMs` blocks this thread after registration returned, as a loaded host does:
   * the property must not depend on it.
   */
  async function hangingPsRow(name: string, stallMs: number): Promise<void> {
    const { _setAsyncPsRunnerForTests } = await L();
    const { handleRegisterAgent } = await import("../src/tools/identity.js");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    let calls = 0;
    let open!: () => void;
    const gate = new Promise<void>((res) => (open = res));
    // Once the gate opens, a COHERENT answer (the command read and the comm read agree on codex, same start): a late
    // answer that landed would really write codex.
    _setAsyncPsRunnerForTests((args: string[]) => {
      calls++;
      return gate.then(() => (args.includes("pid=,lstart=,comm=") ? `${process.pid} Mon Nov 24 10:00:00 2026 /usr/local/bin/codex` : `${process.pid} Mon Nov 24 10:00:00 2026 /usr/local/bin/codex --flag`));
    });
    const observed = () => db.getDb().prepare("SELECT cli_profile_observed FROM agents WHERE name = ?").get(name);
    const timeoutLines = () => warn.mock.calls.flat().map(String).filter((l) => l.includes("was not observed") && l.includes("timed out")).length;
    try {
      const r = handleRegisterAgent({ name, role: "r", capabilities: [], agent_pid: process.pid, agent_pid_start: "Mon Nov 24 10:00:00 2026 UTC" } as never) as unknown;
      // ORDERING: registration has RETURNED (synchronously: a value, not a promise) while the probe is unanswered.
      expect(r instanceof Promise, "registration returns a value, not a promise").toBe(false);
      expect((r as { isError?: boolean }).isError).toBeFalsy();
      expect(calls, "the probe STARTED before registration returned (else this row proves nothing)").toBeGreaterThan(0);
      for (const end = Date.now() + stallMs; Date.now() < end; ); // the host stall: changes no ordering
      expect(observed()).toEqual({ cli_profile_observed: null });
      // The probe's bound passes with the gate still closed: its ONE timeout line (10 s: a hang guard, not the property).
      for (const end = Date.now() + 10_000; Date.now() < end && timeoutLines() === 0; ) await new Promise((res) => setTimeout(res, 20));
      expect(timeoutLines(), "the probe timed out, once").toBe(1);
      // The LATE answer (it would read codex): it writes nothing.
      open();
      await settle();
      expect(observed()).toEqual({ cli_profile_observed: null });
      expect(timeoutLines()).toBe(1);
    } finally {
      _setAsyncPsRunnerForTests(null);
      warn.mockRestore();
    }
  }
  it("the HTTP path with a HANGING ps: registration returns BEFORE its probe answers, the observed profile is NULL, and a LATE answer after the probe's bound writes nothing (one log line)", async () => {
    await hangingPsRow("s-http", 0);
  }, 15_000);
  it("the SAME property under a HOST STALL (a 600 ms block of this thread after registration returned, as a loaded runner does): the row still holds", async () => {
    await hangingPsRow("s-http-stall", 600);
  }, 15_000);
  it("P2: a late probe never overwrites a NEWER registration's value, even within the SAME millisecond (the CAS token is a per-registration generation)", () => {
    const sameMs = "2026-11-24T10:00:00.000Z";
    const r1 = db.registerAgent("s-cas", "r", []);
    const r2 = db.registerAgent("s-cas", "r", []); // a newer registration (two generations, whatever the clock says)
    expect(r1.observed_gen).not.toBe(r2.observed_gen);
    expect(db.setObservedCliProfile("s-cas", "codex", sameMs, { expectGen: r1.observed_gen })).toBe(false); // the old probe lands late
    expect(db.setObservedCliProfile("s-cas", "claude", sameMs, { expectGen: r2.observed_gen })).toBe(true); // the current one lands
    expect(db.getDb().prepare("SELECT cli_profile_observed FROM agents WHERE name = 's-cas'").get()).toEqual({ cli_profile_observed: "claude" });
  });
  it("schema v27: the two columns exist on a fresh DB", () => {
    expect(db.CURRENT_SCHEMA_VERSION).toBe(27);
    const cols = (db.getDb().prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["cli_profile_observed", "cli_profile_observed_at", "cli_profile_observed_gen"]));
  });
});

