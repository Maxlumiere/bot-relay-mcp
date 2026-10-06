// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR-D (ruling Q4/Q8): `relay init` mints the registration secret idempotently, beside the DB it guards:
 * created once (0600), kept on a re-run, seeded from a legacy http_secret, and never printed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { run: runInit } = await import("../src/cli/init.js");
const { readMintSecret, mintSecretPath } = await import("../src/mint-secret.js");

let dir: string;
let relayHome: string;
let out: string[];
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
const KEYS = ["RELAY_CONFIG_PATH", "RELAY_HOME", "RELAY_CLAUDE_HOME", "RELAY_SKIP_DAEMON", "RELAY_INSTANCE_ID", "RELAY_DB_PATH", "RELAY_HTTP_SECRET"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr-d-init-")));
  relayHome = path.join(dir, "botrelay");
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.RELAY_CONFIG_PATH = path.join(relayHome, "config.json");
  process.env.RELAY_HOME = relayHome;
  process.env.RELAY_CLAUDE_HOME = path.join(dir, "claude");
  process.env.RELAY_SKIP_DAEMON = "1";
  delete process.env.RELAY_INSTANCE_ID;
  delete process.env.RELAY_DB_PATH;
  delete process.env.RELAY_HTTP_SECRET;
  out = [];
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => (out.push(String(s)), true));
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => (out.push(String(s)), true));
});
afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("relay init mints the registration secret", () => {
  it("creates it once beside the DB (0600), keeps it on a re-run, and never prints it", async () => {
    expect(await runInit(["--yes", "--skip-daemon"], process.cwd())).toBe(0);
    const secret = readMintSecret(relayHome);
    expect(secret).not.toBeNull();
    if (process.platform !== "win32") expect(fs.statSync(mintSecretPath(relayHome)).mode & 0o777).toBe(0o600);
    expect(out.join("")).toMatch(/registration secret: .*\(created\)/);
    expect(out.join("")).not.toContain(secret!);
    out.length = 0;
    expect(await runInit(["--yes", "--skip-daemon"], process.cwd())).toBe(0);
    expect(readMintSecret(relayHome)).toBe(secret);
    expect(out.join("")).toMatch(/registration secret: .*\(kept\)/);
  });

  it("Q8: a legacy http_secret in the config SEEDS it", async () => {
    const legacy = "L".repeat(40);
    fs.mkdirSync(relayHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(relayHome, "config.json"), JSON.stringify({ http_secret: legacy }), { mode: 0o600 });
    expect(await runInit(["--yes", "--skip-daemon"], process.cwd())).toBe(0);
    expect(readMintSecret(relayHome)).toBe(legacy);
    expect(out.join("")).toMatch(/seeded from http_secret/);
  });
});
