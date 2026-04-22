// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4h — unified `relay` CLI integration tests.
 *
 * Spawns `node bin/relay <sub>` via child_process so we exercise the REAL
 * arg parser + dispatcher (not internal src/cli/* helpers directly).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");

const TEST_HOME = path.join(os.tmpdir(), "bot-relay-cli-test-" + process.pid);
const TEST_DB_DIR = path.join(TEST_HOME, ".bot-relay");
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
const TEST_CONFIG_PATH = path.join(TEST_DB_DIR, "config.json");

function runRelay(args: string[], extraEnv: Record<string, string | undefined> = {}): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RELAY_DB_PATH: TEST_DB_PATH,
    RELAY_CONFIG_PATH: TEST_CONFIG_PATH,
    RELAY_HTTP_PORT: "39988",
    HOME: TEST_HOME,
    // Unset so doctor/init don't see pre-existing state.
    RELAY_HTTP_SECRET: undefined,
    RELAY_ALLOW_LEGACY: undefined,
  };
  // apply overrides
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const r = spawnSync("node", [RELAY_BIN, ...args], { env, encoding: "utf-8", timeout: 15_000 });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function cleanup() {
  if (fs.existsSync(TEST_HOME)) fs.rmSync(TEST_HOME, { recursive: true, force: true });
}

beforeEach(() => {
  cleanup();
  fs.mkdirSync(TEST_HOME, { recursive: true });
});
afterEach(cleanup);

describe("v2.1 Phase 4h — unified relay CLI", () => {
  it("(1) `relay help` prints all subcommands + exits 0", () => {
    const r = runRelay(["help"]);
    expect(r.status).toBe(0);
    for (const sub of ["doctor", "init", "test", "generate-hooks", "backup", "restore", "recover"]) {
      expect(r.stdout).toContain(sub);
    }
  });

  it("(2) `relay` with no args prints help + exits 0", () => {
    const r = runRelay([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: relay/);
  });

  it("(3) unknown subcommand → non-zero exit + help", () => {
    const r = runRelay(["bogus-cmd-xyz"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown subcommand/i);
  });

  it("(4) `relay doctor` runs the diagnostic sweep and exits cleanly on a fresh-but-uninitialized env (WARNs only)", () => {
    const r = runRelay(["doctor"]);
    // Fresh env = no config, no DB → all WARNs, exit 0 because no FAILs.
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/relay doctor/);
    expect(r.stdout).toMatch(/config\.json/);
    expect(r.stdout).toMatch(/relay\.db/);
    expect(r.stdout).toMatch(/Result: healthy/);
  });

  it("(5) `relay init --yes` writes config.json (mode 0600) + parent dir (0700)", () => {
    const r = runRelay(["init", "--yes"]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(TEST_CONFIG_PATH)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(TEST_CONFIG_PATH, "utf-8"));
    // v2.3.0 Part B.1 — `relay init --yes` with no explicit --profile
    // now defaults to the `solo` profile, whose transport is "stdio"
    // (pre-v2.3.0 default was "both"). Operators who want the prior
    // behavior pass --transport=both or --profile=team explicitly.
    expect(cfg.transport).toBe("stdio");
    expect(cfg.profile).toBe("solo");
    expect(cfg.http_port).toBe(3777);
    expect(cfg.http_secret).toBeTruthy();
    expect(cfg.http_secret.length).toBeGreaterThan(20);
    if (process.platform !== "win32") {
      expect(fs.statSync(TEST_CONFIG_PATH).mode & 0o777).toBe(0o600);
      expect(fs.statSync(TEST_DB_DIR).mode & 0o777).toBe(0o700);
    }
  });

  it("(6) `relay init` refuses when config exists; `--force` overwrites", () => {
    // First init seeds the config.
    expect(runRelay(["init", "--yes"]).status).toBe(0);
    // Second init without --force → refuse.
    const refused = runRelay(["init", "--yes"]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/already exists/i);
    // With --force → succeeds; secret rotates.
    const originalSecret = JSON.parse(fs.readFileSync(TEST_CONFIG_PATH, "utf-8")).http_secret;
    const forced = runRelay(["init", "--yes", "--force"]);
    expect(forced.status).toBe(0);
    const newSecret = JSON.parse(fs.readFileSync(TEST_CONFIG_PATH, "utf-8")).http_secret;
    expect(newSecret).not.toBe(originalSecret);
  });

  it("(7) `relay generate-hooks` emits a valid JSON fragment with absolute paths", () => {
    const r = runRelay(["generate-hooks"]);
    expect(r.status).toBe(0);
    const hooks = JSON.parse(r.stdout);
    expect(hooks.SessionStart).toBeDefined();
    expect(hooks.PostToolUse).toBeDefined();
    expect(hooks.Stop).toBeDefined();
    const sessionCmd = hooks.SessionStart[0].hooks[0].command;
    expect(sessionCmd).toContain("hooks/check-relay.sh");
    // Path starts with /
    expect(sessionCmd.replace(/^'|'$/g, "")).toMatch(/^\//);
  });

  it("(8) `relay generate-hooks --full` emits a full settings.json shape", () => {
    const r = runRelay(["generate-hooks", "--full"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hooks).toBeDefined();
    expect(parsed.hooks.Stop).toBeDefined();
  });

  it("(9) `relay backup` writes an archive + exits 0 when DB exists", () => {
    // Seed a DB via init + a test round-trip.
    runRelay(["init", "--yes"]);
    // Force relay test to populate the DB (creates schema_info + an agent).
    // relay test uses a throwaway DB — we need to seed the REAL configured
    // DB_PATH. Run `relay backup` against a freshly-initialized DB.
    // First, create the DB file by invoking any DB-touching subcommand with
    // the same env: doctor will do it.
    runRelay(["doctor"]);
    const archivePath = path.join(TEST_HOME, "backup-output.tar.gz");
    const r = runRelay(["backup", "--output", archivePath]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(archivePath)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(archivePath).mode & 0o777).toBe(0o600);
    }
  });

  it("(10) `relay restore PATH` restores from an archive (force for daemon check)", () => {
    runRelay(["init", "--yes"]);
    runRelay(["doctor"]); // seed schema_info
    const archivePath = path.join(TEST_HOME, "snapshot.tar.gz");
    expect(runRelay(["backup", "--output", archivePath]).status).toBe(0);
    // Restore with --force so the daemon-probe check doesn't reject us.
    const r = runRelay(["restore", archivePath, "--force"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Restore complete/);
  });

  it("(11) `relay test` runs the self-check against a throwaway relay and reports PASS", () => {
    const r = runRelay(["test"]);
    // Should pass — schema-init creates a fresh throwaway DB under /tmp and
    // round-trips a message in under 2 seconds.
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/relay test/);
    expect(r.stdout).toMatch(/Result: PASS/);
  });

  it("(12) `relay <sub> --help` prints subcommand help", () => {
    for (const sub of ["doctor", "init", "test", "generate-hooks", "backup", "restore", "recover"]) {
      const r = runRelay([sub, "--help"]);
      expect(r.status).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(0);
    }
  });
});
