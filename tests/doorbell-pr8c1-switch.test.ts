// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 8c-1: THE SWITCH. The ONE policy file 8a validates (doorbell-policy.json) gains version 2 with an optional
 * `arm` map {agent: "task" | "stop-hook"}, default "task", allowed ONLY for opted-in agents, ONE key per agent (so the
 * two arming mechanisms can never both be active for one agent: one watcher by construction). Version 1 files stay
 * valid (arm = task). An unknown value, a non-opted agent or an extra key is policy_invalid: loud, no wakes, as in 8a.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { validatePolicy, readWakePolicy, armOf, POLICY_FILENAME } from "../src/wake-policy.js";
import { startToken } from "./helpers/start-token.js";
import { systemBinarySeamPath } from "./_helpers/system-binary-seam-env.js";
import { budgetTree } from "./_helpers/hook-budget-tree.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO, "bin", "relay");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-pr8c1-")));
const INST = path.join(ROOT, "inst");
const DB = path.join(INST, "relay.db");
const POLICY = path.join(INST, POLICY_FILENAME);
const MARKER = path.join(INST, "doorbell-enabled");
const HOME = path.join(ROOT, "home");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
const db = await import("../src/db.js");
afterAll(() => {
  db.closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
function resetInstance(): void {
  db.closeDb();
  fs.rmSync(INST, { recursive: true, force: true });
  fs.mkdirSync(INST, { recursive: true });
  fs.mkdirSync(HOME, { recursive: true });
  process.env.RELAY_DB_PATH = DB;
  db.getDb();
  for (const a of ["p-alice", "p-bob", "p-carol"]) db.registerAgent(a, "r", []);
}
function writePolicy(body: unknown): void {
  fs.writeFileSync(POLICY, typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });
  fs.chmodSync(POLICY, 0o600);
}
const cliEnv = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME, RELAY_DB_PATH: DB, RELAY_FILESYSTEM_MARKERS: "0", NODE_OPTIONS: `--require ${systemBinarySeamPath()}` });
const relay = (args: string[]) => spawnSync("node", [RELAY_BIN, ...args], { env: cliEnv(), encoding: "utf-8", timeout: 30_000 });
const POL = (arm?: Record<string, string>) => ({ version: 2, optIn: ["p-bob", "p-alice"], wake: [{ from: "*", to: "p-bob" }], pairWakesPerHour: 4, ...(arm ? { arm } : {}) });

const v2 = (extra: Record<string, unknown> = {}) => ({ version: 2, optIn: ["alpha", "beta"], wake: [{ from: "*", to: "alpha" }], pairWakesPerHour: 4, ...extra });
const v1 = () => ({ version: 1, optIn: ["alpha"], wake: [{ from: "*", to: "alpha" }], pairWakesPerHour: 4 });

describe("PR 8c-1: the switch (policy version 2, an optional arm map)", () => {
  it("version 2 with arm: an opted-in agent's arm is the named mechanism; an opted-in agent with no key arms by task (the default)", () => {
    const r = validatePolicy(v2({ arm: { alpha: "stop-hook" } }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(armOf(r.file, "alpha")).toBe("stop-hook");
    expect(armOf(r.file, "beta"), "no key: the default").toBe("task");
    expect(armOf(r.file, "gamma"), "not opted in: no arm at all").toBeNull();
  });
  it("version 2 WITHOUT arm is valid: every opted-in agent arms by task", () => {
    const r = validatePolicy(v2());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect([armOf(r.file, "alpha"), armOf(r.file, "beta")]).toEqual(["task", "task"]);
  });
  it("a version 1 file stays valid and means arm = task", () => {
    const r = validatePolicy(v1());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(armOf(r.file, "alpha")).toBe("task");
  });
  it("policy_invalid: arm on a NON-opted agent; an unknown arm value; arm in a version 1 file; an unknown version; arm not an object", () => {
    const bad = (v: unknown) => {
      const r = validatePolicy(v);
      expect(r.ok, JSON.stringify(r)).toBe(false);
      return r.ok ? "" : r.why;
    };
    expect(bad(v2({ arm: { gamma: "task" } }))).toMatch(/arm\[0\] is not opted in/);
    expect(bad(v2({ arm: { alpha: "wake-me" } }))).toMatch(/arm\[0\] must be task or stop-hook/);
    expect(bad({ ...v1(), arm: { alpha: "task" } })).toMatch(/unexpected field/);
    expect(bad(v2({ version: 3 }))).toMatch(/version must be 1 or 2/);
    expect(bad(v2({ arm: ["alpha"] }))).toMatch(/arm is not an object/);
  });
  it("a reason never echoes a value (it names a field or an index): the agent name and the bad value are absent", () => {
    const r = validatePolicy(v2({ arm: { "secret-agent-name": "zzz-value" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.why).not.toContain("secret-agent-name");
      expect(r.why).not.toContain("zzz-value");
    }
  });
  it("ONE key per agent: a DUPLICATE arm key in the FILE is refused at read (JSON would keep the last one silently)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr8c1-"));
    try {
      const text = `{"version": 2, "optIn": ["alpha"], "wake": [{"from": "*", "to": "alpha"}], "pairWakesPerHour": 4, "arm": {"alpha": "task", "alpha": "stop-hook"}}`;
      fs.writeFileSync(path.join(dir, POLICY_FILENAME), text, { mode: 0o600 });
      const r = readWakePolicy(dir);
      expect(r.ok, JSON.stringify(r)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PR 8c-1 (a): `relay doorbell --arm-of <agent> --json`, the ONE reader for the hook and the operator scripts", () => {
  beforeEach(() => resetInstance());
  const armOfJson = (agent: string) => {
    const r = relay(["doorbell", "--arm-of", agent, "--json"]);
    return { status: r.status, j: r.stdout.trim() ? (JSON.parse(r.stdout) as Record<string, unknown>) : null, stderr: r.stderr };
  };
  it("an opted-in agent with arm=task / with arm=stop-hook → exit 0, policy valid, opted_in true, its arm", () => {
    writePolicy(POL({ "p-alice": "stop-hook" }));
    expect(armOfJson("p-bob")).toMatchObject({ status: 0, j: { agent: "p-bob", policy: "valid", opted_in: true, arm: "task" } });
    expect(armOfJson("p-alice")).toMatchObject({ status: 0, j: { agent: "p-alice", policy: "valid", opted_in: true, arm: "stop-hook" } });
  });
  it("a NON-opted agent → exit 0, policy valid, opted_in false, arm null", () => {
    writePolicy(POL());
    expect(armOfJson("p-carol")).toMatchObject({ status: 0, j: { agent: "p-carol", policy: "valid", opted_in: false, arm: null } });
  });
  it("a version 1 file → arm task", () => {
    writePolicy({ version: 1, optIn: ["p-bob"], wake: [{ from: "*", to: "p-bob" }], pairWakesPerHour: 4 });
    expect(armOfJson("p-bob")).toMatchObject({ status: 0, j: { policy: "valid", opted_in: true, arm: "task" } });
  });
  it("an INVALID policy → exit 1, policy invalid with its why, opted_in NEVER true (false), arm null", () => {
    writePolicy({ ...POL(), arm: { "p-carol": "task" } }); // arm on a non-opted agent
    const r = armOfJson("p-bob");
    expect(r).toMatchObject({ status: 1, j: { agent: "p-bob", policy: "invalid", opted_in: false, arm: null } });
    expect(String(r.j?.why)).toMatch(/arm\[0\] is not opted in/);
  });
  it("a MISSING file → exit 1, its own state (missing), opted_in false; it writes nothing", () => {
    const before = fs.readdirSync(INST).sort();
    expect(armOfJson("p-bob")).toMatchObject({ status: 1, j: { policy: "missing", opted_in: false, arm: null } });
    expect(fs.readdirSync(INST).sort()).toEqual(before);
  });
  it("usage: no agent, or a value that is not an agent name → exit 2", () => {
    expect(relay(["doorbell", "--arm-of"]).status).toBe(2);
    expect(relay(["doorbell", "--arm-of", "bad name!", "--json"]).status).toBe(2);
  });
  it("`--hook`: the pair ONLY for an opted-in agent with arm=task (valid policy); nothing otherwise; exit 0 for any policy state", () => {
    writePolicy(POL({ "p-alice": "stop-hook" }));
    const task = relay(["doorbell", "--arm-of", "p-bob", "--hook"]);
    const lines = task.stdout.trim().split("\n");
    expect(task.status).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[RELAY\] doorbell: .*watch p-bob --arm-check.*FOREGROUND/);
    expect(lines[1]).toMatch(/^\[RELAY\] doorbell: .*--until-wake.*BACKGROUND/);
    for (const agent of ["p-alice", "p-carol"]) expect(relay(["doorbell", "--arm-of", agent, "--hook"])).toMatchObject({ status: 0, stdout: "" });
    fs.rmSync(POLICY);
    expect(relay(["doorbell", "--arm-of", "p-bob", "--hook"])).toMatchObject({ status: 0, stdout: "" });
  });
});

describe("PR 8c-1 (c): THE ENABLE MARKER (`relay doorbell enable | disable`)", () => {
  beforeEach(() => resetInstance());
  it("enable writes <instance>/doorbell-enabled (a regular file, 0600); again → already enabled, exit 0; disable removes it; again → exit 0", () => {
    expect(fs.existsSync(MARKER)).toBe(false);
    const e1 = relay(["doorbell", "enable"]);
    expect(e1.status, e1.stderr).toBe(0);
    const st = fs.lstatSync(MARKER);
    expect(st.isFile()).toBe(true);
    if (process.platform !== "win32") expect(st.mode & 0o777).toBe(0o600);
    expect(relay(["doorbell", "enable"]).stdout).toMatch(/already enabled/);
    const d1 = relay(["doorbell", "disable"]);
    expect(d1.status, d1.stderr).toBe(0);
    expect(fs.existsSync(MARKER)).toBe(false);
    const d2 = relay(["doorbell", "disable"]);
    expect([d2.status, d2.stdout]).toEqual([0, expect.stringMatching(/already disabled/)]);
  });
  it.skipIf(process.platform === "win32")("a SYMLINKED marker is refused: enable and disable exit 1 and leave the link and its target untouched; the reader says not enabled (a link)", async () => {
    const target = path.join(ROOT, "elsewhere-marker");
    fs.writeFileSync(target, "x", { mode: 0o600 });
    fs.symlinkSync(target, MARKER);
    expect(relay(["doorbell", "enable"]).status).toBe(1);
    expect(relay(["doorbell", "disable"]).status).toBe(1);
    expect(fs.lstatSync(MARKER).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toBe("x");
    const { readEnableMarker } = await import("../src/doorbell-enable.js");
    expect(readEnableMarker(INST)).toEqual({ enabled: false, why: "a link" });
  });
});

const DIST_BUILD = JSON.parse(
  spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(path.join(REPO, "dist", "loaded-build.js")).href)}).then((m) => process.stdout.write(JSON.stringify(m.LOADED_BUILD)))`], { encoding: "utf-8" }).stdout,
) as Record<string, unknown>;
function writeLiveHeartbeat(): void {
  const iso = (ms: number) => new Date(ms).toISOString();
  const now = Date.now();
  const hb = {
    v: 1, at: iso(now), pid: 4242, proc_start: "Mon Oct  5 08:00:00 2026 UTC", started_at: iso(now - 60_000), starts: 1, starts_since: iso(now - 60_000), cycles: 12, interval_ms: 5000,
    condition: "ok", condition_since: iso(now - 60_000), consecutive_failures: 0, cycle_failures: 0, last_failure: null, build: { ...DIST_BUILD }, install_dir: REPO,
    resolution: { kind: "explicit-db", db_path: DB, exists: true, containment: "strict", basis: "RELAY_DB_PATH" }, not_evaluated: null,
  };
  const dir = path.join(INST, "doorbell");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify(hb));
}

describe("PR 8c-1 (c): status: a running job WITHOUT the marker is `disabled`, NEVER healthy", () => {
  beforeEach(() => resetInstance());
  it("a live heartbeat + no marker → disabled; enable → healthy; disable → disabled again", async () => {
    const S = await import("../src/cli/doorbell.js");
    writeLiveHeartbeat();
    expect((await S.readDoorbellStatus(DB, null)).state).toBe("disabled");
    expect(relay(["doorbell", "enable"]).status).toBe(0);
    expect((await S.readDoorbellStatus(DB, null)).state).toBe("healthy");
    expect(relay(["doorbell", "disable"]).status).toBe(0);
    expect((await S.readDoorbellStatus(DB, null)).state).toBe("disabled");
  });
  it.skipIf(process.platform === "win32")("a SYMLINKED marker → disabled (never healthy), with the reason", async () => {
    const S = await import("../src/cli/doorbell.js");
    writeLiveHeartbeat();
    const target = path.join(ROOT, "elsewhere-marker-2");
    fs.writeFileSync(target, "x", { mode: 0o600 });
    fs.rmSync(MARKER, { force: true });
    fs.symlinkSync(target, MARKER);
    const st = await S.readDoorbellStatus(DB, null);
    expect(st.state).toBe("disabled");
    expect(st.why).toMatch(/a link/);
  });
  it("the SessionStart rendering: disabled is QUIET (intentional) when nothing else is wrong; an open escalation still speaks", async () => {
    const S = await import("../src/cli/doorbell.js");
    writeLiveHeartbeat();
    const st = await S.readDoorbellStatus(DB, null);
    expect(st.state).toBe("disabled");
    expect(st.build?.verdict).toBe("CURRENT"); // precondition: only the marker differs from all-well
    expect(S.hookLines(st)).toEqual([]);
    const loud = { ...st, escalations: { open: 1, items: [{ agent: "p-bob", reason: "agent_unresponsive", operator: null, opened_at: new Date().toISOString(), age_seconds: 60 }] } };
    expect(S.hookLines(loud)[0]).toMatch(/^\[RELAY\] doorbell: disabled, /);
  });
});

const { getOwnHostId } = await import("../src/liveness.js");
const HOST = getOwnHostId();
describe.skipIf(!HOST)("PR 8c-1 (c): the JOB reads the marker each cycle: without it, it wakes and boards no one", () => {
  beforeEach(() => {
    resetInstance();
    db.upsertAgentBinding(db.getDb(), { hostId: HOST as string, windowPid: process.pid, windowPidStart: startToken(process.pid), agentName: "p-bob", agentClass: null, conversationId: "conv-bob", conversationTitle: null, cwd: ROOT, boundVia: "launch-intent" });
    db.sendMessage("p-alice", "p-bob", "x", "normal");
  });
  const LOG = path.join(INST, "doorbell", "actuation.jsonl");
  const acting = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string }) : []).filter((r) => r.type !== "header");
  async function once(): Promise<{ code: number; stderr: string }> {
    const { runDoorbell } = await import("../src/doorbell-run.js");
    let stderr = "";
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => ((stderr += String(c)), true));
    try {
      return { code: await runDoorbell(["--once", "--window-s", "10", "--horizon-s", "60"]), stderr }; // PRODUCTION options
    } finally {
      spy.mockRestore();
    }
  }
  it("no marker → the cycle acts on nothing (no board, no intent, no escalation), says DISABLED once, and still writes its heartbeat", async () => {
    const r = await once();
    expect(r.code, r.stderr).toBe(0);
    expect(acting()).toEqual([]);
    expect(r.stderr).toMatch(/DISABLED/);
    expect(fs.existsSync(path.join(INST, "doorbell", "heartbeat.json"))).toBe(true);
  });
  it("CONTROL: with the marker, the SAME instance boards its missing watch (production: no_driver / watch_absent)", async () => {
    expect(relay(["doorbell", "enable"]).status).toBe(0);
    const r = await once();
    expect(r.code, r.stderr).toBe(0);
    expect(acting().map((x) => x.type)).toContain("board");
  });
});

describe("PR 8c-1 (b): the SessionStart hook prints the arm pair iff valid && opted in && arm=task; never silent when the check cannot run", () => {
  const SEAMED = fs.mkdtempSync(path.join(os.tmpdir(), "pr8c1-seamed-"));
  const HOOK = path.join(budgetTree(SEAMED, path.join(REPO, "hooks"), path.join(REPO, "bin")), "check-relay.sh");
  afterAll(() => fs.rmSync(SEAMED, { recursive: true, force: true }));
  beforeEach(() => resetInstance());
  const runHook = (agent: string, env: Record<string, string> = {}) => {
    const r = spawnSync("bash", [HOOK], {
      env: { ...process.env, HOME, RELAY_AGENT_NAME: agent, RELAY_DB_PATH: DB, RELAY_HTTP_PORT: "1", RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(HOME, "wc.json"), RELAY_TEST_CLOCK: "0", ...env },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const armLines = (out: string) => out.split("\n").filter((l) => /--arm-check|--until-wake|arm check did not run/.test(l));
  it("an opted-in agent with arm=task → the pair (the --arm-check line, then the --until-wake line)", () => {
    writePolicy(POL({ "p-alice": "stop-hook" }));
    const r = runHook("p-bob");
    expect(r.stdout).toMatch(/\[RELAY\] VERDICT=/); // precondition: the hook ran to its end
    const lines = armLines(r.stdout);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/watch p-bob --arm-check/);
    expect(lines[1]).toMatch(/--until-wake/);
  });
  it("arm=stop-hook, a non-opted agent, a missing policy → NO arm line (and no failure line)", () => {
    writePolicy(POL({ "p-alice": "stop-hook" }));
    expect(armLines(runHook("p-alice").stdout)).toEqual([]);
    expect(armLines(runHook("p-carol").stdout)).toEqual([]);
    fs.rmSync(POLICY);
    const r = runHook("p-bob");
    expect(r.stdout).toMatch(/\[RELAY\] VERDICT=/);
    expect(armLines(r.stdout)).toEqual([]);
  });
  it("HARM (budget): the arm check SKIPPED for time → ONE loud line naming the command to run, never silence", () => {
    writePolicy(POL());
    const r = runHook("p-bob", { RELAY_TEST_STARVE: "the doorbell arm check" });
    expect(armLines(r.stdout)).toEqual(["[RELAY] doorbell arm check did not run: run `relay doorbell --arm-of p-bob`"]);
  });
});
