// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PHASE A — per-agent relay VERSION + CLI PROFILE visibility (schema v22).
 *
 * WHY. Every stdio MCP server is spawned per client session from `dist/` at the
 * moment that session starts and runs that build for its whole life; rebuilding
 * does nothing for it. Measured on the development machine: TWELVE relay servers
 * alive at once running SEVEN distinct versions (2.9.1 … 2.21.0) against ONE
 * database.
 *
 * The dangerous part was that it was INVISIBLE. A stdio server has no port and
 * no endpoint, and `health_check` answers with the version of WHICHEVER SERVER
 * HANDLED THE CALL — so an agent on a stale build asks, is told its own stale
 * version, and has no way to know. Silence-as-failure with a confident voice.
 *
 * `cli_profile` rides the same row and the same migration because it is the
 * enabling half of the server-side verdict-absence check: only a profile that
 * actually installs a hook can OWE a session-start verdict. Deriving that from
 * the profile registry keeps the recording side and the expectation side from
 * drifting apart.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const TEST_DIR = path.join(os.tmpdir(), "bot-relay-phasea-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DIR, "relay.db");

const {
  closeDb, getDb, registerAgent, getAgents,
  profileOwesVerdict, normalizeCliProfile, CURRENT_SCHEMA_VERSION,
} = await import("../src/db.js");
const { VERSION } = await import("../src/version.js");
const { AGENT_CLI_PROFILES } = await import("../src/agent-cli-profiles.js");

function rowFor(name: string): { server_version: string | null; cli_profile: string | null } {
  return getDb()
    .prepare("SELECT server_version, cli_profile FROM agents WHERE name = ?")
    .get(name) as { server_version: string | null; cli_profile: string | null };
}

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(process.env.RELAY_DB_PATH!, { force: true }); } catch { /* ignore */ }
  getDb();
});

afterEach(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("schema v22 carries both columns", () => {
  it("agents has server_version and cli_profile", () => {
    const cols = (getDb().prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain("server_version");
    expect(cols).toContain("cli_profile");
    // v22 added these columns; ADR-0005 (#119) renumbered its own migration to
    // v23 on rebase, so CURRENT is now past 22.
    expect(CURRENT_SCHEMA_VERSION).toBe(23);
  });
});

describe("register_agent records the SERVING build", () => {
  it("stamps the current relay VERSION on first register", () => {
    registerAgent("pa-first", "role", []);
    expect(rowFor("pa-first").server_version).toBe(VERSION);
  });

  it("RE-STAMPS on re-register — the row reflects the build serving NOW", () => {
    // The point of the feature: a row created by an old build and re-registered
    // by a new one must report the NEW one, otherwise the column records
    // archaeology instead of the live answer.
    registerAgent("pa-restamp", "role", []);
    getDb().prepare("UPDATE agents SET server_version = ? WHERE name = ?").run("2.9.1", "pa-restamp");
    expect(rowFor("pa-restamp").server_version).toBe("2.9.1");

    registerAgent("pa-restamp", "role", [], { force: true });
    expect(rowFor("pa-restamp").server_version).toBe(VERSION);
  });

  it("surfaces server_version + cli_profile through discover_agents", () => {
    registerAgent("pa-visible", "role", [], { cli_profile: "claude" });
    const found = getAgents().find((a) => a.name === "pa-visible");
    expect(found?.server_version).toBe(VERSION);
    expect(found?.cli_profile).toBe("claude");
  });
});

describe("cli_profile is validated against the registry — never a default", () => {
  it("accepts every id the registry actually defines", () => {
    for (const profile of AGENT_CLI_PROFILES) {
      expect(normalizeCliProfile(profile.id)).toBe(profile.id);
    }
  });

  it("maps an UNKNOWN profile to null rather than guessing", () => {
    // A wrong default is how a guard starts crying wolf. Under-cover instead.
    expect(normalizeCliProfile("not-a-real-cli")).toBeNull();
    expect(normalizeCliProfile("")).toBeNull();
    expect(normalizeCliProfile(undefined)).toBeNull();
    registerAgent("pa-bogus", "role", [], { cli_profile: "not-a-real-cli" });
    expect(rowFor("pa-bogus").cli_profile).toBeNull();
  });

  it("a re-register that does not know its profile does NOT erase a known one", () => {
    registerAgent("pa-keep", "role", [], { cli_profile: "codex" });
    expect(rowFor("pa-keep").cli_profile).toBe("codex");
    registerAgent("pa-keep", "role", [], { force: true }); // no cli_profile
    expect(rowFor("pa-keep").cli_profile).toBe("codex");
  });
});

describe("who OWES a verdict is derived from the registry, not written down", () => {
  it("every registry profile that installs a hook owes a verdict", () => {
    // Derived, so the recording side and the expectation side cannot drift.
    for (const profile of AGENT_CLI_PROFILES) {
      expect(profileOwesVerdict(profile.id)).toBe(Boolean(profile.hookInstall));
    }
    // Guards the guard: if NO profile installed a hook this would pass vacuously.
    expect(AGENT_CLI_PROFILES.some((p) => p.hookInstall)).toBe(true);
  });

  it("UNKNOWN / absent profiles are never asked for a verdict", () => {
    // This is what stops the server-side absence check firing on an HTTP client
    // or any future CLI that legitimately installs no hook.
    expect(profileOwesVerdict(null)).toBe(false);
    expect(profileOwesVerdict(undefined)).toBe(false);
    expect(profileOwesVerdict("not-a-real-cli")).toBe(false);
  });
});
