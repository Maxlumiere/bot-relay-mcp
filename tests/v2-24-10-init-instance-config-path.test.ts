// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.24.10 (P1) — `relay init` must write the config to the path the DAEMON
 * resolves, not a CLI-flag-derived flat path.
 *
 * The bug (found on Maxime's live machine): an active-instance symlink pointed at
 * `~/.bot-relay/instances/<id>/`, the daemon resolved its config there, but a
 * plain `relay init` (no --instance-id) defaulted to the FLAT `~/.bot-relay/
 * config.json`. So the dashboard_secret init generated was written to a path the
 * daemon never read — operator endpoints 401'd — and init printed SUCCESS. The
 * fix routes init's no-flag path through the shared getConfigPath(), the same
 * resolver the daemon uses (ADR-0015 L4: one predicate for both sides).
 *
 * Verified by RUNNING runInit against the EXACT shape that bit us (symlink
 * present, no instance config, no RELAY_INSTANCE_ID in this shell). BOTH legs:
 * the harm case writes the INSTANCE config; the innocent twin (a flat install
 * with no instances/) still writes flat and still works. The harm assertions FAIL
 * against the pre-fix code (which wrote flat), which is the whole contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { run: runInit } = await import("../src/cli/init.js");

let dir: string;
let relayHome: string;
let claudeHome: string;
let errs: string[];
let errSpy: ReturnType<typeof vi.spyOn>;
let outSpy: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};
const CLEAN_ROOT = () => path.join(dir, "cleanroot", "bot-relay-mcp");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-instpath-"));
  relayHome = path.join(dir, "botrelay");
  claudeHome = path.join(dir, "claude");
  fs.mkdirSync(relayHome, { recursive: true });
  for (const k of ["RELAY_CONFIG_PATH", "RELAY_HOME", "RELAY_CLAUDE_HOME", "RELAY_SKIP_DAEMON", "RELAY_INSTANCE_ID", "RELAY_DASHBOARD_SECRET", "RELAY_HTTP_SECRET"]) {
    saved[k] = process.env[k];
  }
  // Critically: NO RELAY_CONFIG_PATH and NO RELAY_INSTANCE_ID — the daemon's
  // instance must be resolved from the on-disk active-instance symlink alone,
  // exactly as a fresh interactive `relay init` shell sees it.
  delete process.env.RELAY_CONFIG_PATH;
  delete process.env.RELAY_INSTANCE_ID;
  delete process.env.RELAY_DASHBOARD_SECRET;
  delete process.env.RELAY_HTTP_SECRET;
  process.env.RELAY_HOME = relayHome;
  process.env.RELAY_CLAUDE_HOME = claudeHome;
  process.env.RELAY_SKIP_DAEMON = "1";
  errs = [];
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => (errs.push(String(s)), true));
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  errSpy.mockRestore();
  outSpy.mockRestore();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("v2.24.10 init writes to the daemon's resolved config path (P1)", () => {
  it("HARM: active-instance symlink present, no instance config, no env → writes the INSTANCE config, NOT flat", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const instDir = path.join(relayHome, "instances", id);
    fs.mkdirSync(instDir, { recursive: true });
    // The symlink `use-instance` sets: `<home>/active-instance` -> "<id>".
    fs.symlinkSync(id, path.join(relayHome, "active-instance"));

    const code = await runInit(["--yes", "--config-only", "--transport", "http"], CLEAN_ROOT());
    expect(code, errs.join("")).toBe(0);

    const instConfig = path.join(instDir, "config.json");
    const flatConfig = path.join(relayHome, "config.json");
    // Wrote the INSTANCE config the daemon actually reads, with a real secret...
    expect(fs.existsSync(instConfig), "instance config should exist").toBe(true);
    const cfg = JSON.parse(fs.readFileSync(instConfig, "utf8"));
    expect(typeof cfg.dashboard_secret).toBe("string");
    expect(cfg.dashboard_secret.length).toBeGreaterThanOrEqual(32);
    // ...and did NOT write the flat config (the pre-fix behaviour = the bug).
    expect(fs.existsSync(flatConfig), "flat config must NOT be written when an instance is active").toBe(false);
  });

  it("INNOCENT TWIN: flat install (no instances/, no symlink) → writes the FLAT config and still works", async () => {
    const code = await runInit(["--yes", "--config-only", "--transport", "http"], CLEAN_ROOT());
    expect(code, errs.join("")).toBe(0);

    const flatConfig = path.join(relayHome, "config.json");
    expect(fs.existsSync(flatConfig), "flat config should exist for a non-instance install").toBe(true);
    const cfg = JSON.parse(fs.readFileSync(flatConfig, "utf8"));
    expect(typeof cfg.dashboard_secret).toBe("string");
    expect(cfg.dashboard_secret.length).toBeGreaterThanOrEqual(32);
  });
});
