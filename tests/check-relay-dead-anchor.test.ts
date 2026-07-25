// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0012 (Fork B) — the SessionStart dead-anchor diagnostic in
 * hooks/check-relay.sh, exercised through the SHIPPED hook (not a surrogate).
 *
 * THE NEGATIVE CONTROL (victra's gate): a row that reads LIVE to the 120s skip
 * gate (session_id + fresh last_seen + host_shell_pids) but whose recorded
 * agent_pid anchor is DEAD on this host is UNWAKEABLE — yet the config-level
 * self-check still upgrades the verdict to HEALTHY. This test seeds a HEALTHY
 * ~/.claude.json (so the baseline verdict IS HEALTHY) and asserts the diagnostic
 * OVERRIDES it to a loud UNWAKEABLE that names the exact recovery command. Remove
 * the diagnostic block and the verdict stays HEALTHY → both assertions below flip
 * red. That is the false-HEALTHY the whole arc exists to kill.
 *
 * Plus the two non-fire / honest-refusal cases: a genuinely-live anchor must NOT
 * false-fire (stays HEALTHY — the crux that makes this safe on a real concurrent
 * terminal), and a no-anchor LIVE row must read UNVERIFIABLE (never guessed dead,
 * never auto-taken-over), naming the --override remedy.
 *
 * Same-host cases need a resolvable machine GUID (the gate is same-host by
 * design); gated on it. The unverifiable case runs everywhere.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const REAL_HOOKS = path.join(REPO_ROOT, "hooks");
const HELPER = path.join(REAL_HOOKS, "_vault-helpers.sh"); // for GUID/lstart only — v2-6-2 never mutates this
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-dead-anchor-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
// The hook is exercised from a BYTE-IDENTICAL COPY (not the real hooks/): a
// sibling file, tests/v2-6-2-hook-contracts.test.ts, transiently DELETES the
// real hooks/_verdict.sh to prove the fallback fires, and vitest runs test files
// in parallel — so a hook subprocess reading the real _verdict.sh mid-deletion
// would emit the fallback CANNOT-JUDGE. The copy lives under a path containing
// "/bot-relay-mcp/hooks/" so the hook's own truncation self-check stays quiet.
const HOOK_COPY_DIR = path.join(TEST_ROOT, "bot-relay-mcp", "hooks");
const HOOK = path.join(HOOK_COPY_DIR, "check-relay.sh");

const DEAD_PID = 2_147_483_646;
const LIVE_PID = process.pid;

process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

/** The EXACT own-host GUID the hook's relay_machine_guid() will compute. */
function ownGuid(): string {
  const r = spawnSync("bash", ["-c", `. "$1"; relay_machine_guid`, "bash", HELPER], { encoding: "utf-8" });
  return (r.stdout ?? "").trim();
}
const GUID = ownGuid();

/** The real lstart token for a pid (matches the hook's relay_pid_start). */
function pidStart(pid: number): string {
  const r = spawnSync("bash", ["-c", `. "$1"; relay_pid_start "$2"`, "bash", HELPER, String(pid)], {
    encoding: "utf-8",
  });
  return (r.stdout ?? "").trim();
}

function resetRoot(): void {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true, mode: 0o700 });
}

/** A HEALTHY canonical bot-relay entry → the config self-check upgrades to HEALTHY. */
function writeHealthyClaudeJson(): void {
  const cfg = {
    mcpServers: { "bot-relay": { type: "stdio", command: "node", args: [DIST_INDEX] } },
  };
  fs.writeFileSync(path.join(TEST_ROOT, ".claude.json"), JSON.stringify(cfg));
}

async function seedLiveRow(opts: { pid: number | null; start: string | null; host: string | null }): Promise<void> {
  const { registerAgent, getDb, closeDb } = await import("../src/db.js");
  registerAgent("stale", "builder", ["tasks"]);
  getDb()
    .prepare(
      "UPDATE agents SET session_id = ?, host_shell_pids = ?, agent_pid = ?, agent_pid_start = ?, " +
        "host_id = ?, last_seen = ?, agent_status = 'online' WHERE name = ?"
    )
    .run("sess-live", "[111,222]", opts.pid, opts.start, opts.host, new Date().toISOString(), "stale");
  closeDb();
}

function runHook(): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("bash", [HOOK], {
    encoding: "utf-8",
    timeout: 12_000,
    input: "",
    env: {
      HOME: TEST_ROOT,
      RELAY_HOME: TEST_ROOT,
      PATH: process.env.PATH || "/usr/bin:/bin",
      RELAY_DB_PATH: TEST_DB_PATH,
      RELAY_AGENT_NAME: "stale",
      RELAY_AGENT_ROLE: "builder",
      RELAY_AGENT_CAPABILITIES: "",
      RELAY_AGENT_TOKEN: "dummy-token-no-daemon",
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HTTP_PORT: "54997", // nothing listening → daemon probes fail fast
    },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

beforeEach(async () => {
  resetRoot();
  fs.cpSync(REAL_HOOKS, HOOK_COPY_DIR, { recursive: true }); // isolated, byte-identical hooks
  writeHealthyClaudeJson();
  const { closeDb } = await import("../src/db.js");
  closeDb();
  // Re-assert OUR db path: a sibling test file sharing this vitest worker may
  // have overwritten process.env.RELAY_DB_PATH at its module top. Set after
  // closeDb so the next getDb() re-reads it and seedLiveRow writes the row the
  // hook subprocess (which gets the path explicitly) will actually read.
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  expect(fs.existsSync(DIST_INDEX), "dist/index.js missing — run npm run build first").toBe(true);
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe.skipIf(!GUID)("ADR-0012 Fork B — dead-anchor diagnostic (same-host)", () => {
  it("NEGATIVE CONTROL: LIVE-reading row + DEAD anchor → verdict flips HEALTHY→UNWAKEABLE, names release-binding", async () => {
    await seedLiveRow({ pid: DEAD_PID, start: null, host: GUID });
    const r = runHook();

    // The false-HEALTHY is dead: the loud verdict replaces it.
    expect(r.stdout, r.stderr).toMatch(/VERDICT=UNWAKEABLE/);
    expect(r.stdout).not.toMatch(/VERDICT=HEALTHY/);
    // The exact, copy-pasteable recovery command is named (with the agent name).
    expect(r.stdout).toMatch(/release-binding stale/);
    expect(r.stdout).toMatch(/STALE BINDING/);
  });

  it("NO FALSE FIRE: LIVE-reading row + genuinely-LIVE anchor → stays HEALTHY (concurrent-terminal crux)", async () => {
    await seedLiveRow({ pid: LIVE_PID, start: pidStart(LIVE_PID), host: GUID });
    const r = runHook();

    expect(r.stdout, r.stderr).toMatch(/VERDICT=HEALTHY/);
    expect(r.stdout).not.toMatch(/UNWAKEABLE/);
    expect(r.stdout).not.toMatch(/STALE BINDING/);
  });
});

describe("ADR-0012 Fork B — dead-anchor diagnostic (unverifiable, host-independent)", () => {
  it("LIVE-reading row + NO anchor → UNVERIFIABLE, never guessed dead, names --override", async () => {
    // No agent_pid → relay_anchor_liveness cannot verify → the hook refuses to
    // guess and points at the deliberate --override remedy (release-binding would
    // refuse the bare command here — naming it would deadlock).
    await seedLiveRow({ pid: null, start: null, host: GUID || "some-host-guid" });
    const r = runHook();

    expect(r.stdout, r.stderr).toMatch(/VERDICT=TAKEOVER_LIVENESS_UNVERIFIABLE/);
    expect(r.stdout).not.toMatch(/VERDICT=HEALTHY/);
    expect(r.stdout).toMatch(/--override/);
  });
});
