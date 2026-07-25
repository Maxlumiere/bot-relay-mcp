// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * codex #139 v6 P1 — ATOMICITY of the unquotable-root refusal.
 *
 * quoteForHookCommand refuses a newline/CR-bearing install root (no safe
 * single-line shell command exists for it). The refusal POLICY is right; the old
 * MECHANISM — a throw INSIDE installHook, after config.json + ~/.claude.json were
 * already written — was a PARTIAL COMMIT: mcp pointed at the relay with no
 * registration hook, and re-running just repeated the half-install.
 *
 * `runInit` now PREFLIGHTS (validate before any write). Controls written FROM the
 * harm:
 *   HARM   — init from a newline root → refuse, exit 1, write NOTHING (neither
 *            config.json nor ~/.claude.json).
 *   INNOCENT — --config-only from the same newline root SUCCEEDS (we are not
 *            writing a hook, so an unquotable root must not block the run).
 * The `rootOverride` param is a test seam (a real module URL can never contain a
 * newline).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { run: runInit } = await import("../src/cli/init.js");

let dir: string;
let claudeHome: string;
let configPath: string;
let claudeJson: string;
let errs: string[];
let outs: string[];
let errSpy: ReturnType<typeof vi.spyOn>;
let outSpy: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-preflight-"));
  claudeHome = path.join(dir, "home");
  fs.mkdirSync(claudeHome, { recursive: true });
  configPath = path.join(dir, "config.json");
  claudeJson = path.join(claudeHome, ".claude.json");
  for (const k of ["RELAY_CONFIG_PATH", "RELAY_HOME", "RELAY_CLAUDE_HOME", "RELAY_SKIP_DAEMON", "RELAY_INSTANCE_ID"]) {
    saved[k] = process.env[k];
  }
  process.env.RELAY_CONFIG_PATH = configPath; // config.json → sandbox
  process.env.RELAY_HOME = dir;
  process.env.RELAY_CLAUDE_HOME = claudeHome; // ~/.claude.json + settings.json → sandbox
  process.env.RELAY_SKIP_DAEMON = "1";
  delete process.env.RELAY_INSTANCE_ID;
  errs = [];
  outs = [];
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => (errs.push(String(s)), true));
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => (outs.push(String(s)), true));
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

const NEWLINE_ROOT = () => path.join(dir, "root\nwith-newline", "bot-relay-mcp");

describe("codex #139 v6 P1 — init preflight atomicity (newline install root)", () => {
  it("HARM: init from a newline root → refuses, exit 1, and writes NOTHING", async () => {
    const code = await runInit(["--yes", "--skip-daemon"], NEWLINE_ROOT());
    expect(code).toBe(1);
    // NOT a partial commit — neither file exists:
    expect(fs.existsSync(configPath), "config.json must NOT be written").toBe(false);
    expect(fs.existsSync(claudeJson), "~/.claude.json must NOT be written").toBe(false);
    // clean one-line refusal naming the cause + that nothing was written:
    const msg = errs.join("");
    expect(msg).toMatch(/refusing/i);
    expect(msg).toMatch(/newline\/CR/);
    expect(msg).toMatch(/nothing was written/i);
  });

  it("re-running from the newline root repeats the refusal and STILL writes nothing (no accreting half-install)", async () => {
    await runInit(["--yes", "--skip-daemon"], NEWLINE_ROOT());
    const code2 = await runInit(["--yes", "--skip-daemon"], NEWLINE_ROOT());
    expect(code2).toBe(1);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(claudeJson)).toBe(false);
  });

  it("INNOCENT: --config-only from the SAME newline root SUCCEEDS and writes config.json", async () => {
    const code = await runInit(["--yes", "--config-only"], NEWLINE_ROOT());
    expect(code, errs.join("")).toBe(0);
    expect(fs.existsSync(configPath), "config.json IS written for --config-only").toBe(true);
    expect(fs.existsSync(claudeJson), "no hook/mcp for --config-only").toBe(false);
  });

  it("INNOCENT: --skip-hooks from a newline root SUCCEEDS (mcp written, no hook, no throw)", async () => {
    const code = await runInit(["--yes", "--skip-daemon", "--skip-hooks"], NEWLINE_ROOT());
    expect(code, errs.join("")).toBe(0);
    expect(fs.existsSync(configPath)).toBe(true);
  });
});
