// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.5 — stdio + hooks + doctor all read the same per-instance DB the
 * HTTP daemon writes to.
 *
 * Closes the split-brain bug Codex 5.5 caught during the v2.4.4 R2 audit:
 * agent registered via HTTP daemon (per-instance DB), but the operator's
 * stdio session's mailbox check ran the bash hook which hardcoded the
 * legacy ~/.bot-relay/relay.db. Two state stores, agents/messages don't
 * cross, auth fails silently.
 *
 * Q1 — bash hook helper falls back to legacy when no env + no symlink.
 * Q2 — bash hook helper resolves the active-instance symlink target.
 * Q3 — bash hook helper honours RELAY_INSTANCE_ID env override.
 * Q4 — bash hook helper honours RELAY_DB_PATH explicit override.
 * Q5 — bash hook helper rejects malformed active-instance content and falls
 *      back to legacy (path-traversal defense-in-depth, mirrors instance.ts).
 * Q6 — `relay doctor`'s helper reports the per-instance DB path under
 *      multi-instance mode (pre-v2.4.5 it printed legacy + lied about PASS).
 * Q7 — end-to-end: a TS process under instance X writes to the per-instance
 *      DB; a re-initialized DB handle under the same instance X reads the
 *      same row back. Proves resolveInstanceDbPath is the single resolution
 *      gate for the TS surface (the bash hooks now mirror it).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const HOOK_PATH = path.join(PROJECT_ROOT, "hooks", "check-relay.sh");

// Pin RELAY_HOME at module load (instance.ts reads it lazily, but TEST_HOME
// is a single fixed root for the whole file — per-test we override below).
const FILE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-v245-stdio-"));
process.env.RELAY_HOME = FILE_HOME;

delete process.env.RELAY_INSTANCE_ID;
delete process.env.RELAY_DB_PATH;

const {
  generateInstanceId,
  createInstance,
  resolveInstanceDbPath,
  setActiveInstance,
} = await import("../src/instance.js");
const dbMod = await import("../src/db.js");

/**
 * Run the resolve_relay_db_path() bash function from check-relay.sh against
 * a controlled $HOME. We extract the function body via sed (sourcing the
 * whole hook would trigger AGENT_NAME validation + exits) and invoke it.
 *
 * The bash hook reads `$HOME/.bot-relay/active-instance` etc — so HOME is
 * the test's tmp dir, and the per-instance setup lives at
 * `<HOME>/.bot-relay/instances/<id>/relay.db`.
 */
function runHookResolver(env: { HOME: string } & Record<string, string | undefined>): string {
  // Inline the function definition by reading the hook + extracting the
  // resolve_relay_db_path body. Robust against the hook's exit-early
  // validation (which we don't want to trigger).
  const hookSource = fs.readFileSync(HOOK_PATH, "utf8");
  const m = hookSource.match(/^resolve_relay_db_path\(\)\s*\{[\s\S]*?\n\}/m);
  if (!m) throw new Error("could not extract resolve_relay_db_path() from check-relay.sh");
  const fnSrc = m[0];

  const exports = Object.entries(env)
    .map(([k, v]) => (v === undefined ? `unset ${k};` : `export ${k}=${JSON.stringify(v)};`))
    .join(" ");
  const cmd = `${exports} ${fnSrc}\n resolve_relay_db_path`;
  const r = spawnSync("bash", ["-c", cmd], {
    encoding: "utf8",
    timeout: 5_000,
    env: {
      // Strip RELAY_* from parent env to avoid leakage.
      PATH: process.env.PATH ?? "",
    },
  });
  if (r.status !== 0) {
    throw new Error(
      `runHookResolver failed: status=${r.status} stderr=${r.stderr} stdout=${r.stdout}`,
    );
  }
  return r.stdout.trim();
}

function freshHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-v245-home-"));
}

describe("v2.4.5 — bash hook resolver mirrors src/instance.ts", () => {
  let HOME: string;

  beforeEach(() => {
    HOME = freshHome();
    fs.mkdirSync(path.join(HOME, ".bot-relay"), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(HOME, { recursive: true, force: true });
  });

  it("(Q1) falls back to legacy when no env + no symlink (backward compat)", () => {
    const resolved = runHookResolver({ HOME });
    expect(resolved).toBe(path.join(HOME, ".bot-relay", "relay.db"));
  });

  it("(Q2) follows the active-instance symlink to the per-instance DB", () => {
    const id = "test-instance-q2";
    fs.mkdirSync(path.join(HOME, ".bot-relay", "instances", id), { recursive: true });
    fs.symlinkSync(id, path.join(HOME, ".bot-relay", "active-instance"));
    const resolved = runHookResolver({ HOME });
    expect(resolved).toBe(path.join(HOME, ".bot-relay", "instances", id, "relay.db"));
  });

  it("(Q3) honours RELAY_INSTANCE_ID env override", () => {
    const id = "test-instance-q3";
    const resolved = runHookResolver({ HOME, RELAY_INSTANCE_ID: id });
    expect(resolved).toBe(path.join(HOME, ".bot-relay", "instances", id, "relay.db"));
  });

  it("(Q4) RELAY_DB_PATH explicit override beats every other knob", () => {
    const explicit = path.join(HOME, "custom", "relay.db");
    const resolved = runHookResolver({
      HOME,
      RELAY_DB_PATH: explicit,
      RELAY_INSTANCE_ID: "should-be-ignored",
    });
    expect(resolved).toBe(explicit);
  });

  it("(Q5) rejects malformed active-instance content and falls back to legacy", () => {
    // active-instance file with content that fails the [A-Za-z0-9._-] guard.
    // Pre-v2.4.5 the hook didn't read the file at all; v2.4.5 must defend
    // against an attacker-controlled active-instance file the same way
    // instance.ts:instanceDir() does.
    fs.writeFileSync(path.join(HOME, ".bot-relay", "active-instance"), "../escape\n");
    const resolved = runHookResolver({ HOME });
    expect(resolved).toBe(path.join(HOME, ".bot-relay", "relay.db"));
  });
});

describe("v2.4.5 — TS-side per-instance resolution (doctor + parity)", () => {
  beforeEach(() => {
    delete process.env.RELAY_INSTANCE_ID;
    delete process.env.RELAY_DB_PATH;
    // Pin RELAY_HOME at FILE_HOME for these tests; clean it between runs.
    process.env.RELAY_HOME = FILE_HOME;
    if (fs.existsSync(FILE_HOME)) fs.rmSync(FILE_HOME, { recursive: true, force: true });
    fs.mkdirSync(FILE_HOME, { recursive: true });
  });
  afterEach(() => {
    delete process.env.RELAY_INSTANCE_ID;
    delete process.env.RELAY_DB_PATH;
  });

  it("(Q6) resolveInstanceDbPath returns the per-instance path under multi-instance mode (doctor surrogate)", () => {
    // doctor.ts now routes through resolveInstanceDbPath / Config so its
    // PASS/WARN labels match the file the daemon + stdio actually open.
    // Pre-v2.4.5 doctor printed legacy unconditionally — exactly the
    // class of false-PASS that hid the split-brain in production.
    const id = generateInstanceId();
    createInstance(id, "2.4.5");
    setActiveInstance(id);

    // RELAY_HOME at FILE_HOME means the per-instance dir lives at
    // <FILE_HOME>/instances/<id>/, NOT <FILE_HOME>/.bot-relay/instances/<id>/.
    // (RELAY_HOME IS the bot-relay root in the TS test seam — see
    // src/instance.ts:botRelayRoot.)
    const expected = path.join(FILE_HOME, "instances", id, "relay.db");
    expect(resolveInstanceDbPath()).toBe(expected);
  });

  it("(Q7) two TS processes under the same RELAY_INSTANCE_ID see the same DB rows", async () => {
    // The split-brain bug surfaces when ONE process writes per-instance and
    // ANOTHER reads legacy. With both pinned to the same instance via env,
    // resolveInstanceDbPath returns a single path and a write from process
    // P1 is observable by process P2 (which reopens the same file).
    //
    // Single-process surrogate: closeDb() + initializeDb() simulates a
    // fresh process — state lives on disk at the resolved path, not in
    // process memory, so any other process resolving the same path sees
    // the same rows.
    const id = generateInstanceId();
    createInstance(id, "2.4.5");
    process.env.RELAY_INSTANCE_ID = id;

    dbMod.closeDb();
    await dbMod.initializeDb();
    dbMod.registerAgent("parity-alice", "r", []);
    dbMod.registerAgent("parity-bob", "r", []);
    dbMod.sendMessage("parity-alice", "parity-bob", "ping", "normal");
    const dbPath1 = dbMod.getDbPath();

    // "Second process": close + reinit. Same instance_id ⇒ same path.
    dbMod.closeDb();
    await dbMod.initializeDb();
    const dbPath2 = dbMod.getDbPath();
    expect(dbPath2).toBe(dbPath1);
    const inbox = dbMod.getMessages("parity-bob", "pending", 100, true);
    expect(inbox.length).toBe(1);
    expect(inbox[0].content).toBe("ping");

    dbMod.closeDb();
  });
});
