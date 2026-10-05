// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 5 — `relay doorbell status` and the SessionStart line (plan v3 PR 5; V2; architect
 * ruling 9987c113).
 *   - V2's states, NEVER merged: healthy · stale (old, OR from the future) · not-installed ·
 *     disabled (in the enum, produced by nothing until PR 8) · UNREADABLE = exit 1, EMPTY stdout,
 *     a loud stderr.
 *   - `build` is a SEPARATE field (verdictForBuild against the install the heartbeat names): a
 *     STALE build never changes `state`.
 *   - Open escalations, METADATA ONLY: never message ids, never content.
 *   - The hook (the real check-relay.sh): silent when not-installed or all-well; otherwise the
 *     verb's lines; unreadable / no budget → DEGRADED, never silence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(REPO, "hooks", "check-relay.sh");
const S = await import("../src/cli/doorbell.js");
const HBM = await import("../src/doorbell-heartbeat.js");
const L = await import("../src/doorbell-log.js");
type Heartbeat = import("../src/doorbell-heartbeat.js").Heartbeat;
type Status = import("../src/cli/doorbell.js").DoorbellStatus;

let home: string;
let dbPath: string;
let stateDir: string;

/** The build the WORKTREE's dist actually loads (a real stamp), so a CURRENT verdict is real. */
const DIST_BUILD = JSON.parse(
  spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(path.join(REPO, "dist", "loaded-build.js"))}).then((m) => process.stdout.write(JSON.stringify(m.LOADED_BUILD)))`], { encoding: "utf-8" }).stdout,
) as Record<string, unknown>;

const NOW = Date.parse("2026-10-05T08:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
function heartbeat(over: Partial<Heartbeat> = {}): Heartbeat {
  return {
    v: 1, at: iso(Date.now()), pid: 4242, proc_start: "Mon Oct  5 08:00:00 2026 UTC", started_at: iso(Date.now() - 60_000), starts: 1,
    starts_since: iso(Date.now() - 60_000), cycles: 12, interval_ms: 5000, condition: "ok", condition_since: iso(Date.now() - 60_000), consecutive_failures: 0, cycle_failures: 0, last_failure: null,
    build: { ...DIST_BUILD }, install_dir: REPO,
    resolution: { kind: "explicit-db", db_path: dbPath, exists: true, containment: "strict", basis: "RELAY_DB_PATH" },
    ...over,
  };
}
const writeHb = (h: unknown) => fs.writeFileSync(path.join(stateDir, HBM.HEARTBEAT_FILENAME), typeof h === "string" ? h : JSON.stringify(h));
const RS = "1".repeat(64);
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
function escalation(state: "open" | "closed", reason: "agent_unresponsive" | "id_stuck", agent: string, at: string, id = uuid()) {
  return { v: 1, type: "escalation", at, escalation_id: id, agent_name: agent, reading_session: RS, reason, state, message_ids: ["msg-secret-id-1"], operator: null, close_reason: state === "open" ? null : "progress" };
}
const writeLog = (recs: unknown[]) => {
  for (const r of recs) expect(L.recordFault(r)).toBeNull(); // every fixture record is a VALID record
  fs.writeFileSync(path.join(stateDir, L.LOG_FILENAME), recs.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
};
async function runVerb(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const o = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => ((stdout += String(c)), true));
  const e = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => ((stderr += String(c)), true));
  const env = process.env.RELAY_DB_PATH;
  process.env.RELAY_DB_PATH = dbPath;
  try {
    return { code: await S.run(argv), stdout, stderr };
  } finally {
    o.mockRestore();
    e.mockRestore();
    if (env === undefined) delete process.env.RELAY_DB_PATH;
    else process.env.RELAY_DB_PATH = env;
  }
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-pr5-status-")));
  fs.mkdirSync(path.join(home, ".bot-relay"), { recursive: true });
  dbPath = path.join(home, ".bot-relay", "relay.db");
  const d = new Database(dbPath);
  d.pragma("journal_mode = WAL");
  d.exec(`
    CREATE TABLE IF NOT EXISTS agents (name TEXT PRIMARY KEY, role TEXT, capabilities TEXT, last_seen TEXT, session_id TEXT, auth_state TEXT DEFAULT 'active', token_hash TEXT);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, from_agent TEXT, to_agent TEXT, content TEXT, priority TEXT DEFAULT 'normal', status TEXT DEFAULT 'pending', created_at TEXT, resolved_at TEXT, read_by_session TEXT);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, from_agent TEXT, to_agent TEXT, title TEXT, status TEXT, priority TEXT, created_at TEXT);
  `);
  d.close();
  stateDir = path.join(home, ".bot-relay", "doorbell");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("Q1 (ii): staleness by WALL AGE only (pure)", () => {
  const at = (ageMs: number, interval = 5000) => HBM.judgeHeartbeat({ at: iso(NOW - ageMs), interval_ms: interval }, NOW).state;
  it("healthy up to max(3 × interval, 15 s) inclusive; stale beyond", () => {
    expect([at(0), at(15_000), at(15_001)]).toEqual(["healthy", "healthy", "stale"]);
    expect([at(30_000, 10_000), at(30_001, 10_000)]).toEqual(["healthy", "stale"]);
  });
  it("the 15 s FLOOR decides for a short interval: at 1 s, 10 s old is still healthy (3 × 1 s alone would say stale)", () => {
    expect([at(10_000, 1000), at(15_000, 1000), at(15_001, 1000)]).toEqual(["healthy", "healthy", "stale"]);
  });
  it("HARM (backward clock jump): `at` more than 5 s in the FUTURE is stale; within 5 s it is healthy", () => {
    expect([at(-5_000), at(-5_001)]).toEqual(["healthy", "stale"]);
  });
});

describe("V2's states from the verb, never merged", () => {
  it("not-installed: no heartbeat → exit 0, state not-installed, never healthy", async () => {
    const r = await runVerb(["status", "--json"]);
    expect(r.code).toBe(0);
    const st = JSON.parse(r.stdout) as Status;
    expect([st.state, st.build, st.condition]).toEqual(["not-installed", null, null]);
  });
  it("healthy: a fresh heartbeat on the CURRENT build", async () => {
    writeHb(heartbeat());
    const st = JSON.parse((await runVerb(["status", "--json"])).stdout) as Status;
    expect([st.state, st.build?.verdict, st.condition]).toEqual(["healthy", "CURRENT", "ok"]);
  });
  it("stale: an old heartbeat (a stopped job's leftover) → stale, with the age in `why`", async () => {
    writeHb(heartbeat({ at: iso(Date.now() - 600_000) }));
    const st = JSON.parse((await runVerb(["status", "--json"])).stdout) as Status;
    expect(st.state).toBe("stale");
    expect(st.why).toMatch(/ago/);
  });
  it("HARM (build is SEPARATE): a STALE build leaves `state` healthy; build says STALE", async () => {
    writeHb(heartbeat({ build: { ...DIST_BUILD, build_id: "a".repeat(64) } }));
    const st = JSON.parse((await runVerb(["status", "--json"])).stdout) as Status;
    expect([st.state, st.build?.verdict]).toEqual(["healthy", "STALE"]);
  });
  it("`disabled` is in the closed enum, and nothing in PR 5 produces it", async () => {
    expect(S.DOORBELL_STATES).toContain("disabled");
    const seen: string[] = [];
    seen.push((JSON.parse((await runVerb(["status", "--json"])).stdout) as Status).state);
    for (const hb of [heartbeat(), heartbeat({ at: iso(Date.now() - 600_000) }), heartbeat({ condition: "failing", consecutive_failures: 3 })]) {
      writeHb(hb);
      seen.push((JSON.parse((await runVerb(["status", "--json"])).stdout) as Status).state);
    }
    expect(seen).not.toContain("disabled");
  });
});

describe("UNREADABLE: a non-zero exit, EMPTY stdout, a loud stderr (F1's exit contract)", () => {
  for (const [label, prep] of [
    ["not JSON", () => writeHb("{nope")],
    ["an extra key", () => writeHb({ ...heartbeat(), extra: 1 })],
    ["a free-text failure kind", () => writeHb(heartbeat({ last_failure: { at: iso(Date.now()), kind: "EACCES /secret" as never } }))],
    ["a symlink (never followed)", () => { fs.writeFileSync(path.join(home, "elsewhere.json"), JSON.stringify(heartbeat())); fs.symlinkSync(path.join(home, "elsewhere.json"), path.join(stateDir, HBM.HEARTBEAT_FILENAME)); }],
    ["an invalid log record", () => { writeHb(heartbeat()); fs.writeFileSync(path.join(stateDir, L.LOG_FILENAME), '{"v":1,"type":"escalation"}\n'); }],
  ] as Array<[string, () => void]>) {
    it(`HARM: ${label} → exit 1, stdout empty, DOORBELL_STATUS_FAILED on stderr (for --json AND --hook)`, async () => {
      prep();
      for (const mode of ["--json", "--hook"]) {
        const r = await runVerb(["status", mode]);
        expect([r.code, r.stdout]).toEqual([1, ""]);
        expect(r.stderr).toMatch(/DOORBELL_STATUS_FAILED/);
      }
    });
  }
});

describe("open escalations: METADATA ONLY", () => {
  it("lists only the OPEN ones (agent, reason, operator, age); no message id ever appears", async () => {
    writeHb(heartbeat());
    const closedId = uuid();
    writeLog([
      escalation("open", "agent_unresponsive", "agent-a", iso(Date.now() - 7_200_000)),
      escalation("open", "id_stuck", "agent-b", iso(Date.now() - 600_000), closedId),
      escalation("closed", "id_stuck", "agent-b", iso(Date.now() - 60_000), closedId),
    ]);
    const r = await runVerb(["status", "--json"]);
    const st = JSON.parse(r.stdout) as Status;
    expect(st.escalations.items.map((e) => [e.agent, e.reason])).toEqual([["agent-a", "agent_unresponsive"]]);
    expect(st.escalations.items[0].age_seconds).toBeGreaterThanOrEqual(7_199);
    expect(r.stdout).not.toContain("msg-secret-id-1");
    const hook = await runVerb(["status", "--hook"]);
    expect(hook.stdout).not.toContain("msg-secret-id-1");
  });
});

describe("Q6: the hook's lines (pure renderer)", () => {
  const base = (over: Partial<Status> = {}): Status => ({
    ok: true, state: "healthy", why: "cycling", build: { verdict: "CURRENT", reason: "" }, condition: "ok", heartbeat: null,
    escalations: { open: 0, items: [] }, state_dir: "/x", db_path: "/x/relay.db", resolution: null, ...over,
  });
  const esc = (k: number) => Array.from({ length: k }, (_, i) => ({ agent: `agent-${i}`, reason: "agent_unresponsive", operator: null, opened_at: iso(NOW), age_seconds: 3600 }));
  it("SILENT: not-installed; healthy + CURRENT + ok + 0 escalations", () => {
    expect(S.hookLines(base({ state: "not-installed", build: null, condition: null }))).toEqual([]);
    expect(S.hookLines(base())).toEqual([]);
  });
  const waiting = (ageSeconds: number, intervalMs = 5000) =>
    base({
      condition: "waiting-for-writer",
      heartbeat: {
        at: iso(NOW), age_seconds: 1, pid: 1, proc_start: null, started_at: iso(NOW), starts: 1, starts_since: iso(NOW), cycles: 1, interval_ms: intervalMs,
        condition_since: iso(NOW - ageSeconds * 1000), condition_age_seconds: ageSeconds, consecutive_failures: 0, cycle_failures: 0, last_failure: null, install_dir: "/x",
      },
    });
  it("F1 (ruling b556c011): waiting-for-writer is SILENT within its grace, max(3 × interval, 60 s), and ONE line beyond it — both sides", () => {
    expect(S.hookLines(waiting(60))).toEqual([]); // 5 s interval → 60 s grace, at the edge
    expect(S.hookLines(waiting(61))).toEqual(["[RELAY] doorbell: waiting for a writer for 61s: no relay process holds the DB (daemon down? journal mode?)"]);
    expect(S.hookLines(waiting(90, 30_000))).toEqual([]); // 30 s interval → 90 s grace
    expect(S.hookLines(waiting(91, 30_000))).toHaveLength(1);
    expect(S.hookLines(waiting(3600))[0]).toMatch(/waiting for a writer for 60m/);
  });
  it("HARM: stale, a non-CURRENT build, log-full, failing, or ANY open escalation → one line", () => {
    for (const over of [{ state: "stale" as const }, { build: { verdict: "STALE", reason: "" } }, { build: { verdict: "UNKNOWN", reason: "" } }, { condition: "log-full" }, { condition: "failing" }, { escalations: { open: 1, items: esc(1) } }]) {
      const lines = S.hookLines(base(over));
      expect(lines.length, JSON.stringify(over)).toBeGreaterThan(0);
      expect(lines[0]).toMatch(/^\[RELAY\] doorbell: /);
    }
  });
  it("at most 5 escalation lines, then '+K more'; every line is [RELAY]-shaped", () => {
    const lines = S.hookLines(base({ escalations: { open: 7, items: esc(7) } }));
    expect(lines).toHaveLength(1 + 5 + 1);
    expect(lines.at(-1)).toBe("[RELAY]   +2 more");
    expect(lines[1]).toBe("[RELAY]   - agent-0: agent_unresponsive, open 60m");
    for (const l of lines) expect(l.startsWith("[RELAY]")).toBe(true);
  });
});

describe("the SessionStart hook (the real check-relay.sh)", () => {
  function runHook(env: Record<string, string> = {}) {
    const r = spawnSync("bash", [HOOK], {
      env: { ...process.env, HOME: home, RELAY_AGENT_NAME: "probe", RELAY_DB_PATH: dbPath, RELAY_HTTP_PORT: "1", RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(home, "wc.json"), ...env },
      encoding: "utf8",
      timeout: 20_000,
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  const doorbellLines = (out: string) => out.split("\n").filter((l) => l.startsWith("[RELAY] doorbell") || l.startsWith("[RELAY]   "));
  it("not-installed → NO doorbell line, and nothing about the doorbell in the verdict", () => {
    const r = runHook();
    expect(doorbellLines(r.stdout)).toEqual([]);
    expect(r.stdout).toMatch(/\[RELAY\] VERDICT=/); // precondition: the hook ran to its end
    expect(r.stdout).not.toMatch(/doorbell status/);
  });
  it("HARM: a stale doorbell with an open escalation → its line AND the escalation line in the session context (stdout), metadata only", () => {
    writeHb(heartbeat({ at: iso(Date.now() - 600_000) }));
    writeLog([escalation("open", "agent_unresponsive", "agent-a", iso(Date.now() - 3_600_000))]);
    const r = runHook();
    const lines = doorbellLines(r.stdout);
    expect(lines[0]).toMatch(/^\[RELAY\] doorbell: stale, build CURRENT, ok: 1 open escalation$/);
    expect(lines[1]).toMatch(/^\[RELAY\] {3}- agent-a: agent_unresponsive, open 60m$/);
    expect(r.stdout).not.toContain("msg-secret-id-1");
  });
  it("HARM: an unreadable heartbeat → the hook's VERDICT is DEGRADED with the reason, never silence", () => {
    writeHb("{nope");
    const r = runHook();
    expect(r.stdout).toMatch(/\[RELAY\] VERDICT=DEGRADED reason="[^"]*doorbell status unreadable/);
  });
  it("HARM (one deadline): with no time left, the doorbell step is SKIPPED LOUDLY (named on stderr; the verdict names it)", () => {
    // The hook's budget is fixed (10 s) and SECONDS is wall-clock, so the step is STARVED in a
    // hooks COPY: SECONDS=9 right before the doorbell block leaves 10 − 9 − 3 < 1 s. The copy
    // reaches the real CLI through a symlinked bin/relay.
    writeHb(heartbeat({ at: iso(Date.now() - 600_000) }));
    const copy = path.join(home, "starved");
    fs.cpSync(path.join(REPO, "hooks"), path.join(copy, "hooks"), { recursive: true });
    fs.mkdirSync(path.join(copy, "bin"));
    fs.symlinkSync(path.join(REPO, "bin", "relay"), path.join(copy, "bin", "relay"));
    const hook = path.join(copy, "hooks", "check-relay.sh");
    const src = fs.readFileSync(hook, "utf-8");
    const marker = "# --- Doorbell (ADR-0038 Q3/V2";
    expect(src.includes(marker)).toBe(true); // precondition: the block exists to starve
    fs.writeFileSync(hook, src.replace(marker, `SECONDS=9\n${marker}`));
    const r = spawnSync("bash", [hook], { env: { ...process.env, HOME: home, RELAY_AGENT_NAME: "probe", RELAY_DB_PATH: dbPath, RELAY_HTTP_PORT: "1", RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(home, "wc.json") }, encoding: "utf8", timeout: 20_000 });
    expect(r.stderr).toMatch(/no time budget left for the doorbell status/);
    expect(r.stdout).toMatch(/\[RELAY\] VERDICT=DEGRADED reason="[^"]*no time budget left for the doorbell status/);
    expect(r.stdout).not.toMatch(/\[RELAY\] doorbell:/); // skipped, not run
  });
  /** A hooks COPY with `inject` placed right before the doorbell block (the step is reached as normal). */
  function hookCopyWith(inject: string) {
    const copy = path.join(home, `inj-${Math.random().toString(36).slice(2)}`);
    fs.cpSync(path.join(REPO, "hooks"), path.join(copy, "hooks"), { recursive: true });
    fs.mkdirSync(path.join(copy, "bin"));
    fs.symlinkSync(path.join(REPO, "bin", "relay"), path.join(copy, "bin", "relay"));
    const hook = path.join(copy, "hooks", "check-relay.sh");
    const marker = "# --- Doorbell (ADR-0038 Q3/V2";
    const src = fs.readFileSync(hook, "utf-8");
    expect(src.includes(marker)).toBe(true); // precondition
    fs.writeFileSync(hook, src.replace(marker, `${inject}\n${marker}`));
    const r = spawnSync("bash", [hook], { env: { ...process.env, HOME: home, RELAY_AGENT_NAME: "probe", RELAY_DB_PATH: dbPath, RELAY_HTTP_PORT: "1", RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(home, "wc.json") }, encoding: "utf8", timeout: 20_000 });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }
  it("HARM (c927c81c D1): node missing AT the doorbell step → DEGRADED naming it (never a silent skip)", () => {
    const r = hookCopyWith('PATH="/nonexistent-dir"');
    expect(r.stdout).toMatch(/\[RELAY\] VERDICT=DEGRADED reason="[^"]*doorbell status: node not found/);
  });
  it("HARM (c927c81c D1): no relay CLI AT the doorbell step → DEGRADED naming the path", () => {
    const r = hookCopyWith('HOOKS_DIR="/nonexistent-dir/hooks"');
    expect(r.stdout).toMatch(/\[RELAY\] VERDICT=DEGRADED reason="[^"]*doorbell status: no relay CLI at [^"]*\/bin\/relay/);
  });
  it("HARM (#304 R1 F6): the 2nd mktemp failing never LEAKS the 1st file (it is registered the moment it exists)", () => {
    const mk = path.join(home, "mk");
    fs.mkdirSync(mk);
    const r = hookCopyWith(`mktemp() { if [ ! -e "${mk}/.first" ]; then : > "${mk}/.first"; command mktemp "${mk}/leak.XXXXXX"; else return 1; fi; }`);
    expect(fs.existsSync(path.join(mk, ".first"))).toBe(true); // precondition: the 1st mktemp ran (and succeeded)
    expect(fs.readdirSync(mk).filter((f) => f.startsWith("leak."))).toEqual([]);
    expect(r.stdout).toMatch(/VERDICT=DEGRADED reason="[^"]*doorbell status: could not create a private temp file/);
  });
  it("HARM (#304 R1 F8a): the hook relays ONLY [RELAY]-prefixed lines, at most 7, whatever the CLI prints (an injection boundary)", () => {
    const copy = path.join(home, "stub");
    fs.cpSync(path.join(REPO, "hooks"), path.join(copy, "hooks"), { recursive: true });
    fs.mkdirSync(path.join(copy, "bin"));
    fs.symlinkSync(path.join(REPO, "dist"), path.join(copy, "dist"));
    fs.writeFileSync(
      path.join(copy, "bin", "relay"),
      `if (process.argv[2] === "doorbell") {\n` +
        `  for (let i = 0; i < 3; i++) console.log("INJECTED not-prefixed " + i);\n` +
        `  for (let i = 0; i < 10; i++) console.log("[RELAY] doorbell stub line " + i);\n` +
        `  process.exit(0);\n}\n` +
        `const r = require("child_process").spawnSync(process.execPath, [${JSON.stringify(path.join(REPO, "bin", "relay"))}, ...process.argv.slice(2)], { stdio: "inherit" });\n` +
        `process.exit(r.status ?? 1);\n`,
    );
    const r = spawnSync("bash", [path.join(copy, "hooks", "check-relay.sh")], { env: { ...process.env, HOME: home, RELAY_AGENT_NAME: "probe", RELAY_DB_PATH: dbPath, RELAY_HTTP_PORT: "1", RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(home, "wc.json") }, encoding: "utf8", timeout: 20_000 });
    expect(r.stdout).not.toContain("INJECTED");
    expect(r.stdout.split("\n").filter((l) => l.startsWith("[RELAY] doorbell stub line"))).toHaveLength(7);
  });
  it("never silent: no relay CLI beside the hook → the hook is DEGRADED naming the missing CLI (before the doorbell step)", () => {
    const copy = path.join(home, "nocli");
    fs.cpSync(path.join(REPO, "hooks"), path.join(copy, "hooks"), { recursive: true });
    fs.symlinkSync(path.join(REPO, "dist"), path.join(copy, "dist")); // the resolver is there; only bin/relay is missing
    const r = spawnSync("bash", [path.join(copy, "hooks", "check-relay.sh")], { env: { ...process.env, HOME: home, RELAY_AGENT_NAME: "probe", RELAY_DB_PATH: dbPath, RELAY_HTTP_PORT: "1", RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(home, "wc.json") }, encoding: "utf8", timeout: 20_000 });
    expect(r.stdout).toMatch(/\[RELAY\] VERDICT=DEGRADED reason="[^"]*no relay CLI beside this hook/);
  });
});
