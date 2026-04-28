// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.5 — stdio + every hook + every CLI read the same per-instance DB the
 * HTTP daemon writes to.
 *
 * Closes the split-brain bug Codex 5.5 caught during the v2.4.4 R2 audit:
 * agent registered via HTTP daemon (per-instance DB), but the operator's
 * stdio session's mailbox check ran a bash hook that hardcoded the legacy
 * ~/.bot-relay/relay.db. Two state stores, agents/messages don't cross,
 * auth fails silently.
 *
 * R1 hardening (after dual-5.5 audit):
 *   - Q1–Q5 parameterized over ALL THREE hooks (check-relay, post-tool-use,
 *     stop). The R0 cut only tested check-relay; the Stop hook had the
 *     same bug and would have shipped uncaught (HIGH 1 in the R1 patch).
 *   - Q-identity asserts byte-identical resolve_relay_db_path across all
 *     three hooks (zero-drift invariant).
 *   - Q-malformed asserts stderr + exit 1 on bad instance_id (R0 silently
 *     fell back to legacy — MED 2 in the R1 patch).
 *   - Q6 spawns the REAL `relay doctor` CLI as a subprocess and asserts
 *     its DB-path output (R0 only unit-tested the resolver helper).
 *   - Q7 spawns a SEPARATE Node process that reads the DB written by the
 *     parent (R0 used closeDb+initializeDb in-process — proxy, not contract).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");

// All three bash hooks ship the same resolve_relay_db_path() function.
// The identity test pins them byte-identical so a future PR can't fix
// one and forget the other two.
const HOOK_PATHS = [
  path.join(PROJECT_ROOT, "hooks", "check-relay.sh"),
  path.join(PROJECT_ROOT, "hooks", "post-tool-use-check.sh"),
  path.join(PROJECT_ROOT, "hooks", "stop-check.sh"),
];
const HOOK_LABELS = ["check-relay", "post-tool-use-check", "stop-check"] as const;

// Pin RELAY_HOME at module load (instance.ts reads it lazily, but FILE_HOME
// is a single fixed root for the whole file — per-test we override below).
const FILE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-v245-stdio-"));
process.env.RELAY_HOME = FILE_HOME;

delete process.env.RELAY_INSTANCE_ID;
delete process.env.RELAY_DB_PATH;

const {
  generateInstanceId,
  createInstance,
  resolveInstanceDbPath,
} = await import("../src/instance.js");
const dbMod = await import("../src/db.js");

function extractResolver(hookPath: string): string {
  const src = fs.readFileSync(hookPath, "utf8");
  const m = src.match(/^resolve_relay_db_path\(\)\s*\{[\s\S]*?\n\}/m);
  if (!m) throw new Error(`could not extract resolve_relay_db_path() from ${hookPath}`);
  return m[0];
}

interface ResolverResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

/**
 * Invoke a hook's resolve_relay_db_path() under a controlled environment.
 * Sets RELAY_HOME explicitly when provided so the bash mirror's RELAY_HOME
 * branch is exercised — matches the way the hooks ship to operators (one
 * function, three call sites).
 */
function runHookResolver(
  hookPath: string,
  env: Record<string, string | undefined>,
): ResolverResult {
  const fnSrc = extractResolver(hookPath);
  const exports = Object.entries(env)
    .map(([k, v]) => (v === undefined ? `unset ${k};` : `export ${k}=${JSON.stringify(v)};`))
    .join(" ");
  const cmd = `${exports} ${fnSrc}\n resolve_relay_db_path`;
  const r = spawnSync("bash", ["-c", cmd], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: process.env.PATH ?? "" },
  });
  return { stdout: r.stdout.trim(), stderr: r.stderr ?? "", status: r.status };
}

function freshHome(subdir = ".bot-relay"): { HOME: string; root: string } {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-v245-home-"));
  const root = path.join(HOME, subdir);
  fs.mkdirSync(root, { recursive: true });
  return { HOME, root };
}

describe("v2.4.5 — bash hook resolvers mirror src/instance.ts (parameterized over all 3 hooks)", () => {
  it("(Q-identity) resolve_relay_db_path() is byte-identical across all three hooks", () => {
    // Drift is the failure mode that produced HIGH 1: R0 fixed two hooks
    // and missed Stop. Lock the function bodies together so the next PR
    // physically cannot fix one without the others.
    const hashes = HOOK_PATHS.map((p) => createHash("sha256").update(extractResolver(p)).digest("hex"));
    expect(new Set(hashes).size).toBe(1);
  });

  for (let i = 0; i < HOOK_PATHS.length; i++) {
    const hookPath = HOOK_PATHS[i];
    const label = HOOK_LABELS[i];

    describe(`hook: ${label}`, () => {
      let HOME: string;
      let root: string;
      beforeEach(() => {
        const fresh = freshHome();
        HOME = fresh.HOME;
        root = fresh.root;
      });
      afterEach(() => {
        fs.rmSync(HOME, { recursive: true, force: true });
      });

      it(`(Q1) ${label}: falls back to legacy when no env + no symlink`, () => {
        const r = runHookResolver(hookPath, { HOME });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe(path.join(root, "relay.db"));
      });

      it(`(Q2) ${label}: follows the active-instance symlink to the per-instance DB`, () => {
        const id = "test-instance-q2";
        fs.mkdirSync(path.join(root, "instances", id), { recursive: true });
        fs.symlinkSync(id, path.join(root, "active-instance"));
        const r = runHookResolver(hookPath, { HOME });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe(path.join(root, "instances", id, "relay.db"));
      });

      it(`(Q3) ${label}: honours RELAY_INSTANCE_ID env override`, () => {
        const id = "test-instance-q3";
        const r = runHookResolver(hookPath, { HOME, RELAY_INSTANCE_ID: id });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe(path.join(root, "instances", id, "relay.db"));
      });

      it(`(Q4) ${label}: RELAY_DB_PATH explicit override beats every other knob`, () => {
        const explicit = path.join(HOME, "custom", "relay.db");
        const r = runHookResolver(hookPath, {
          HOME,
          RELAY_DB_PATH: explicit,
          RELAY_INSTANCE_ID: "should-be-ignored",
        });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe(explicit);
      });

      it(`(Q5) ${label}: rejects malformed active-instance content with stderr + exit 1`, () => {
        // R1 MED 2: pre-R1 bash hooks silently fell back to legacy on
        // malformed instance_id. The TS resolver throws (instance.ts:152).
        // Bash mirror now emits stderr + returns 1 so attacker-controlled
        // active-instance content can't mask the operator's setup.
        fs.writeFileSync(path.join(root, "active-instance"), "../escape\n");
        const r = runHookResolver(hookPath, { HOME });
        expect(r.status).not.toBe(0);
        expect(r.stderr).toMatch(/invalid instance_id/i);
      });

      it(`(Q5b) ${label}: RELAY_HOME override redirects the bot-relay root (TS test seam parity)`, () => {
        // R1 MED 2: TS's botRelayRoot() reads RELAY_HOME first
        // (instance.ts:75). Bash mirror must do the same so test harnesses
        // can drive the resolver against a tmp dir without touching $HOME.
        const altHome = fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-v245-altroot-"));
        try {
          const r = runHookResolver(hookPath, { HOME, RELAY_HOME: altHome });
          expect(r.status).toBe(0);
          expect(r.stdout).toBe(path.join(altHome, "relay.db"));
          expect(r.stdout).not.toContain(HOME);
        } finally {
          fs.rmSync(altHome, { recursive: true, force: true });
        }
      });
    });
  }
});

describe("v2.4.5 — TS-side per-instance resolution (real subprocess contract)", () => {
  beforeEach(() => {
    delete process.env.RELAY_INSTANCE_ID;
    delete process.env.RELAY_DB_PATH;
    process.env.RELAY_HOME = FILE_HOME;
    if (fs.existsSync(FILE_HOME)) fs.rmSync(FILE_HOME, { recursive: true, force: true });
    fs.mkdirSync(FILE_HOME, { recursive: true });
  });
  afterEach(() => {
    delete process.env.RELAY_INSTANCE_ID;
    delete process.env.RELAY_DB_PATH;
  });

  it("(Q6) `relay doctor` CLI subprocess reports the per-instance DB path under multi-instance mode", () => {
    // R1 MED 3: replaces the R0 unit-test surrogate. Spawn the REAL
    // `node bin/relay doctor` and grep the rendered output for the per-
    // instance path. Pre-v2.4.5 doctor hardcoded legacy and printed
    // "WARN dir perms (~/.bot-relay)" against the wrong directory; this
    // test asserts the live CLI now prints the per-instance path.
    const id = generateInstanceId();
    createInstance(id, "2.4.5");
    const expectedDbPath = path.join(FILE_HOME, "instances", id, "relay.db");
    // Pre-create the DB so doctor can probe schema_info; without it the
    // line we want ("WARN ... not present") still includes the path.
    fs.mkdirSync(path.dirname(expectedDbPath), { recursive: true });

    const r = spawnSync(
      process.execPath,
      [path.join(PROJECT_ROOT, "bin", "relay"), "doctor"],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: os.homedir(),
          RELAY_HOME: FILE_HOME,
          RELAY_INSTANCE_ID: id,
          // Don't probe a real daemon — keep the run hermetic.
          RELAY_HTTP_HOST: "127.0.0.1",
          RELAY_HTTP_PORT: "1", // refused-immediately port
        },
      },
    );
    const combined = `${r.stdout}\n${r.stderr}`;
    // The doctor output references getDbPath() in several check labels
    // ("dir perms (<path>)", "db perms (<path>)", "relay.db: not present
    // at <path>", etc.). Any one of them carrying the per-instance path
    // is the contract.
    expect(combined).toContain(expectedDbPath);
    // Negative assertion: doctor MUST NOT mention the legacy path (would
    // mean it's still hardcoding os.homedir()/.bot-relay/relay.db).
    expect(combined).not.toContain(path.join(os.homedir(), ".bot-relay", "relay.db"));
  });

  it("(Q7) a separate Node process reading the same RELAY_INSTANCE_ID sees the DB rows the parent wrote", async () => {
    // R1 MED 3: replaces the R0 closeDb+initializeDb proxy. The split-
    // brain bug surfaces ACROSS PROCESSES — one daemon writes per-instance,
    // a separate stdio MCP process reads legacy. The contract this test
    // pins: two real Node processes, both with the same RELAY_INSTANCE_ID,
    // both go through resolveInstanceDbPath, see the same SQLite file.
    const id = generateInstanceId();
    createInstance(id, "2.4.5");
    process.env.RELAY_INSTANCE_ID = id;

    // Parent process: open per-instance DB + write a sentinel agent.
    dbMod.closeDb();
    await dbMod.initializeDb();
    dbMod.registerAgent("parity-alice", "r", []);
    dbMod.registerAgent("parity-bob", "r", []);
    dbMod.sendMessage("parity-alice", "parity-bob", "ping-from-parent", "normal");
    const parentDbPath = dbMod.getDbPath();
    dbMod.closeDb();

    // Child process: spawn a fresh Node, import the SAME db module, run
    // an inline read script. Same RELAY_INSTANCE_ID + RELAY_HOME, no
    // shared in-memory state.
    const reader = `
      import('${path.resolve(PROJECT_ROOT, "dist", "db.js").replace(/\\/g, "\\\\")}').then(async (m) => {
        await m.initializeDb();
        const childPath = m.getDbPath();
        const inbox = m.getMessages('parity-bob', 'pending', 100, true);
        process.stdout.write(JSON.stringify({ childPath, count: inbox.length, content: inbox[0]?.content ?? null }));
        m.closeDb();
      }).catch((e) => { process.stderr.write(String(e)); process.exit(1); });
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", reader], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: os.homedir(),
        RELAY_HOME: FILE_HOME,
        RELAY_INSTANCE_ID: id,
      },
    });
    if (r.status !== 0) {
      throw new Error(`child reader failed: status=${r.status} stderr=${r.stderr} stdout=${r.stdout}`);
    }
    const out = JSON.parse(r.stdout) as { childPath: string; count: number; content: string | null };
    expect(out.childPath).toBe(parentDbPath);
    expect(out.count).toBe(1);
    expect(out.content).toBe("ping-from-parent");
  });
});
