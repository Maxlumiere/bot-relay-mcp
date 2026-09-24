// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 S1 completion, step 3 — `relay fleet --lines`: one restart line per
 * window that needs resuming, built from the record, never from a request.
 *
 * ADR-0040 (architect): every field that goes into a pasted shell line is validated
 * and quoted, and on any failure the line is NOT emitted and the reason is shown.
 * A LIVE agent's line is marked "already open — do not paste" (two windows on one
 * conversation = two windows claiming one identity). Lines only for this edge.
 * Victra: a sub-agent is never a resume target; point at the parent.
 *
 * The line reproduces the persona launchers' launch intent (MEASURED in ~/.zshrc:
 * `cd "<dir>" && RELAY_AGENT_NAME=<name> claude …`) with `claude --resume <id>`.
 * It carries NO --model: a Claude transcript records `claude-opus-5-5` without its
 * `[1m]` window (MEASURED), so a --model taken from it would reopen a 900k
 * conversation in a 200k window.
 *
 * PROVEN BY EXECUTION: each emitted line runs through /bin/sh against a fake
 * `claude` that records its cwd, argv and RELAY_AGENT_NAME.
 *
 * Harness copied from tests/adr-0036-s1-relay-fleet.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");

const TEST_ROOT = path.join(os.tmpdir(), `bot-relay-s1c-lines-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
const HOME_DIR = path.join(TEST_ROOT, "home");

process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

/** A pid that is live on this host, and one that provably is not. */
const LIVE_PID = process.pid;
const DEAD_PID = 2_147_483_646;

const CONV_A = "aaaaaaaa-0000-1111-2222-333333333333";
const CONV_B = "bbbbbbbb-0000-1111-2222-333333333333";

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runFleet(args: string[] = []): RunResult {
  const r = spawnSync("node", [RELAY_BIN, "fleet", ...args], {
    encoding: "utf-8",
    timeout: 20_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: HOME_DIR,
      RELAY_HOME: HOME_DIR,
      RELAY_DB_PATH: TEST_DB_PATH,
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The real start-time token for a pid, so a seeded anchor is genuinely live. */
async function realStart(pid: number): Promise<string> {
  const { processStartedAt } = await import("../src/liveness.js");
  return processStartedAt(pid) ?? "";
}

async function seedSchema(): Promise<void> {
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  const { getDb, closeDb } = await import("../src/db.js");
  getDb();
  closeDb();
}

/** Write a binding through the SANCTIONED writer, never raw SQL. */
async function seedBinding(opts: {
  agentName: string | null;
  conversationId: string;
  pid: number;
  startedAt: string;
  boundVia?: string;
  cwd?: string | null;
}): Promise<void> {
  const Better = (await import("better-sqlite3")).default;
  const { upsertAgentBinding } = await import("../src/db.js");
  const { getOwnHostId } = await import("../src/liveness.js");
  const db = new Better(TEST_DB_PATH) as never;
  try {
    upsertAgentBinding(db, {
      hostId: getOwnHostId() ?? "test-host",
      windowPid: opts.pid,
      windowPidStart: opts.startedAt,
      agentName: opts.agentName,
      agentClass: null,
      conversationId: opts.conversationId,
      conversationTitle: null,
      cwd: opts.cwd ?? "/tmp/fleet-test",
      boundVia: opts.boundVia ?? "launch-intent",
    });
  } finally {
    (db as unknown as { close(): void }).close();
  }
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const { closeDb } = await import("../src/db.js");
  closeDb();
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  await seedSchema();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

/** Write a Claude transcript for `conv` where the meter will find it. */
function writeTranscript(conv: string, lines: unknown[]): void {
  const dir = path.join(HOME_DIR, ".claude", "projects", "-some-project");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${conv}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function assistant(read: number, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    isSidechain: false,
    sessionId: CONV_B,
    message: { model: "claude-opus-5-5", usage: { input_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: 0 } },
    ...extra,
  };
}

/** The command lines (everything that is not a comment or blank). */
function commands(out: string): string[] {
  return out.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
}

/** Run one emitted line through /bin/sh with a fake `claude`; return what it saw. */
function execLine(line: string): { cwd: string; argv: string[]; name: string | null; runs: number } {
  const bin = path.join(TEST_ROOT, "fakebin");
  const log = path.join(TEST_ROOT, "fake-claude.log");
  fs.mkdirSync(bin, { recursive: true });
  fs.rmSync(log, { force: true });
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/bin/sh\nprintf '%s\\n' "$(pwd -P)" >> '${log}'\nprintf '%s\\n' "$*" >> '${log}'\nprintf '%s\\n' "\${RELAY_AGENT_NAME-<unset>}" >> '${log}'\n`,
    { mode: 0o755 },
  );
  const r = spawnSync("/bin/sh", ["-c", line], {
    encoding: "utf-8",
    cwd: TEST_ROOT,
    env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  expect(r.status, `line failed: ${line}\n${r.stderr}`).toBe(0);
  const out = fs.existsSync(log) ? fs.readFileSync(log, "utf-8").split("\n").filter((x) => x !== "") : [];
  return { cwd: out[0] ?? "", argv: (out[1] ?? "").split(" "), name: out[2] === "<unset>" ? null : (out[2] ?? null), runs: out.length / 3 };
}

describe("S1 completion — relay fleet --lines", () => {
  it("a named window that needs resuming gets a line that cds, sets the launch intent and resumes THAT conversation", async () => {
    fs.mkdirSync(path.join(HOME_DIR, "Claude AI", "proj"), { recursive: true });
    const cwd = fs.realpathSync(path.join(HOME_DIR, "Claude AI", "proj"));
    await seedBinding({ agentName: "lines-dead", conversationId: CONV_B, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026", cwd });
    const r = runFleet(["--lines"]);
    expect(r.status, r.stderr).toBe(0);
    const cmds = commands(r.stdout);
    expect(cmds).toHaveLength(1);
    const seen = execLine(cmds[0]);
    expect(seen.runs).toBe(1);
    expect(seen.cwd).toBe(cwd);
    expect(seen.argv).toEqual(["--resume", CONV_B]);
    expect(seen.name).toBe("lines-dead");
  }, 30_000);

  it("an UNNAMED window's line carries no RELAY_AGENT_NAME", async () => {
    const cwd = path.join(HOME_DIR, "unnamed");
    fs.mkdirSync(cwd, { recursive: true });
    await seedBinding({ agentName: null, conversationId: CONV_B, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026", cwd });
    const cmds = commands(runFleet(["--lines"]).stdout);
    expect(cmds).toHaveLength(1);
    expect(execLine(cmds[0]).name).toBeNull();
  }, 30_000);

  it("a LIVE window gets NO command, only a comment saying it is already open", async () => {
    const cwd = path.join(HOME_DIR, "live");
    fs.mkdirSync(cwd, { recursive: true });
    await seedBinding({ agentName: "lines-live", conversationId: CONV_A, pid: LIVE_PID, startedAt: await realStart(LIVE_PID), cwd });
    const r = runFleet(["--lines"]);
    expect(commands(r.stdout)).toEqual([]);
    expect(r.stdout).toMatch(/lines-live.*already open.*do not paste/i);
  }, 30_000);

  it("a folder OUTSIDE the home root gets no command, and the comment says why", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "s1c-outside-"));
    try {
      await seedBinding({ agentName: "lines-out", conversationId: CONV_B, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026", cwd: outside });
      const r = runFleet(["--lines"]);
      expect(commands(r.stdout)).toEqual([]);
      expect(r.stdout).toMatch(/lines-out.*no line.*allowlisted root/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 30_000);

  it("a HOSTILE but real folder name is quoted: the line reaches it and runs nothing else", async () => {
    const cwd = path.join(HOME_DIR, "a'b; touch PWNED $(touch PWNED2)");
    fs.mkdirSync(cwd, { recursive: true });
    await seedBinding({ agentName: "lines-hostile", conversationId: CONV_B, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026", cwd });
    const cmds = commands(runFleet(["--lines"]).stdout);
    expect(cmds).toHaveLength(1);
    const seen = execLine(cmds[0]);
    expect(seen.runs).toBe(1);
    expect(seen.cwd).toBe(fs.realpathSync(cwd));
    const strays = [TEST_ROOT, HOME_DIR, cwd].flatMap((d) => fs.readdirSync(d).filter((f) => f.startsWith("PWNED")));
    expect(strays).toEqual([]);
  }, 30_000);

  it("no line ever carries --model (the transcript does not record the window)", async () => {
    const cwd = path.join(HOME_DIR, "m");
    fs.mkdirSync(cwd, { recursive: true });
    await seedBinding({ agentName: "lines-model", conversationId: CONV_B, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026", cwd });
    writeTranscript(CONV_B, [assistant(420_000)]);
    const r = runFleet(["--lines"]);
    expect(commands(r.stdout)).toHaveLength(1);
    expect(r.stdout).not.toMatch(/--model/);
  }, 30_000);

  it("the meter shows in the row's comment: context, window, level, compactions", async () => {
    const cwd = path.join(HOME_DIR, "meter");
    fs.mkdirSync(cwd, { recursive: true });
    await seedBinding({ agentName: "lines-meter", conversationId: CONV_B, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026", cwd });
    writeTranscript(CONV_B, [{ type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 969_632 } }, assistant(420_000)]);
    const r = runFleet(["--lines"]);
    const comment = r.stdout.split("\n").find((l) => l.startsWith("#") && l.includes("lines-meter")) ?? "";
    expect(comment).toMatch(/420k/);
    expect(comment).toMatch(/1M/);
    expect(comment).toMatch(/amber/);
    expect(comment).toMatch(/1 compaction/);
  }, 30_000);

  it("no transcript found: the meter says unknown, and the line is still emitted", async () => {
    const cwd = path.join(HOME_DIR, "nt");
    fs.mkdirSync(cwd, { recursive: true });
    await seedBinding({ agentName: "lines-nt", conversationId: CONV_B, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026", cwd });
    const r = runFleet(["--lines"]);
    expect(commands(r.stdout)).toHaveLength(1);
    expect(r.stdout).toMatch(/lines-nt.*context unknown/i);
  }, 30_000);

  it("a SUB-AGENT transcript gets no line; the comment names the parent", async () => {
    const cwd = path.join(HOME_DIR, "sub");
    fs.mkdirSync(cwd, { recursive: true });
    await seedBinding({ agentName: "lines-sub", conversationId: CONV_B, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026", cwd });
    writeTranscript(CONV_B, [assistant(1_000, { isSidechain: true, agentId: "a7fd6783b23434a9f", sessionId: CONV_A })]);
    const r = runFleet(["--lines"]);
    expect(commands(r.stdout)).toEqual([]);
    expect(r.stdout).toMatch(/sub-agent/i);
    expect(r.stdout).toContain(CONV_A);
  }, 30_000);

  it("--lines and --json together is a usage error on stderr, stdout empty", () => {
    const r = runFleet(["--lines", "--json"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/Usage: relay fleet/);
  }, 30_000);
});
