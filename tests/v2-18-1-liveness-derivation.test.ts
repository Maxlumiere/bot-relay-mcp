// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.18.1 — liveness derivation: presence that stops lying.
 *
 * Two root causes fixed:
 *   (a) the coarse `status` was derived from last_seen AGE — a live but
 *       rate-limited agent read "offline". Now derived from the VERDICT.
 *   (b) the verdict anchored ONLY on agent_pid — an agent with no/stale
 *       agent_pid read "unknown". Now an argv scan (RELAY_AGENT_NAME="<name>")
 *       finds the agent's OWN process.
 *
 * The ACCEPTANCE test reproduces codex-5-5's exact situation (agent_pid null,
 * process alive with the name in argv) and asserts snapshot/discover show ALIVE.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { agentProcessAdvertised, _resetOwnHostIdForTests } from "../src/liveness.js";

// ───────── Section A: the argv scan — prefix-substring + metachar + injection ─────────
describe("v2.18.1 — agentProcessAdvertised (argv scan, both-side anchored, literal)", () => {
  const runWith =
    (lines: string[]) =>
    (): string =>
      lines.join("\n");

  it("matches a name advertised EXACTLY in argv", () => {
    expect(agentProcessAdvertised("codex-5-5", runWith(['node app RELAY_AGENT_NAME="codex-5-5" --x']))).toBe(true);
  });

  it("HARD: does NOT prefix-substring match (foo ≠ foobar / foo-x)", () => {
    expect(
      agentProcessAdvertised("foo", runWith(['a RELAY_AGENT_NAME="foobar"', 'b RELAY_AGENT_NAME="foo-x"'])),
    ).toBe(false);
  });

  it("does NOT suffix/partial match (foo ≠ xfoo)", () => {
    expect(agentProcessAdvertised("foo", runWith(['RELAY_AGENT_NAME="xfoo"']))).toBe(false);
  });

  it("a `.` in the name is LITERAL, not regex-any (a.b ≠ axb)", () => {
    expect(agentProcessAdvertised("a.b", runWith(['RELAY_AGENT_NAME="a.b"']))).toBe(true);
    expect(agentProcessAdvertised("a.b", runWith(['RELAY_AGENT_NAME="axb"']))).toBe(false);
  });

  it("rejects a non-allowlisted name (belt-and-suspenders, no injection)", () => {
    expect(agentProcessAdvertised('x";rm -rf /', runWith(['whatever RELAY_AGENT_NAME="x";rm -rf /"']))).toBe(false);
    expect(agentProcessAdvertised("a b", runWith(['RELAY_AGENT_NAME="a b"']))).toBe(false);
  });

  it("empty / no ps output → false (never throws)", () => {
    expect(agentProcessAdvertised("foo", () => "")).toBe(false);
  });
});

// ───────── Section B: end-to-end verdict + status (the acceptance test) ─────────
describe("v2.18.1 — verdict cascade + status retire (acceptance)", () => {
  const OWN = "test-host-guid-liveness";
  let tmpRoot: string;
  const savedDb = process.env.RELAY_DB_PATH;
  let marker: ChildProcess | null = null;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "liveness-"));
    process.env.RELAY_DB_PATH = path.join(tmpRoot, "relay.db");
    _resetOwnHostIdForTests(OWN); // deterministic host-scope regardless of CI machine-id
    const { initializeDb } = await import("../src/db.js");
    await initializeDb();
  });
  afterEach(async () => {
    if (marker) {
      try {
        marker.kill("SIGKILL");
      } catch {
        /* */
      }
      marker = null;
    }
    try {
      (await import("../src/db.js")).closeDb();
    } catch {
      /* */
    }
    _resetOwnHostIdForTests(undefined);
    if (savedDb === undefined) delete process.env.RELAY_DB_PATH;
    else process.env.RELAY_DB_PATH = savedDb;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* */
    }
  });

  /** Register `name`, then force the codex-5-5 shape: agent_pid NULL + host_id = OWN. */
  async function registerAsUnanchored(name: string): Promise<void> {
    const { registerAgent, getDb } = await import("../src/db.js");
    registerAgent(name, "auditor", []);
    getDb().prepare("UPDATE agents SET agent_pid = NULL, agent_pid_start = NULL, host_id = ? WHERE name = ?").run(OWN, name);
  }

  async function findAgent(name: string) {
    const { getAgents } = await import("../src/db.js");
    return getAgents().find((a) => a.name === name);
  }

  it("ACCEPTANCE (codex-5-5): agent_pid NULL but process advertises the name → ALIVE / online, NOT offline", async () => {
    const name = "acc-agent";
    // A live process carrying RELAY_AGENT_NAME="acc-agent" in its argv (exactly
    // how the codex launch advertises it) — NOT this test's own process.
    marker = spawn(process.execPath, ["-e", "setInterval(function(){}, 1e9)", `RELAY_AGENT_NAME="${name}"`], {
      stdio: "ignore",
    });
    // Wait until it's visible in the process table (bounded).
    for (let i = 0; i < 40 && !agentProcessAdvertised(name); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(agentProcessAdvertised(name), "marker process not visible in ps").toBe(true);

    await registerAsUnanchored(name);
    const a = await findAgent(name);
    expect(a, "agent row missing").toBeTruthy();
    expect(a!.liveness).toBe("alive"); // argv scan found it despite no agent_pid
    expect(a!.status).toBe("online"); // coarse status = verdict, NOT last_seen age
    expect(["offline", "closed"]).not.toContain(a!.agent_status); // never dead for a live agent
  });

  it("INVARIANT (req 5): an unknown agent (no anchor, no live process) → unknown, NEVER offline", async () => {
    const name = "quiet-unanchored";
    await registerAsUnanchored(name); // no marker process for this name
    const a = await findAgent(name);
    expect(a!.liveness).toBe("unknown");
    expect(a!.status).toBe("unknown"); // NOT "offline" — the whole bug class
    expect(a!.status).not.toBe("offline");
  });

  it("status is verdict-derived, NEVER age-based (a stale last_seen alive agent is online)", async () => {
    const name = "stale-but-alive";
    marker = spawn(process.execPath, ["-e", "setInterval(function(){}, 1e9)", `RELAY_AGENT_NAME="${name}"`], {
      stdio: "ignore",
    });
    for (let i = 0; i < 40 && !agentProcessAdvertised(name); i++) await new Promise((r) => setTimeout(r, 50));
    await registerAsUnanchored(name);
    // Force an ancient last_seen — the OLD age-based status would read "offline".
    (await import("../src/db.js")).getDb().prepare("UPDATE agents SET last_seen = ? WHERE name = ?").run("2020-01-01T00:00:00.000Z", name);
    const a = await findAgent(name);
    expect(a!.status).toBe("online"); // age is irrelevant now
  });
});
