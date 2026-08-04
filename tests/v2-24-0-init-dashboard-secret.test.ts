// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR B / ADR-0006 (a) — secret-by-default at init.
 *
 * `relay init` generates a dedicated `dashboard_secret` for HTTP installs so the
 * always-authed operator endpoints (ADR-0006 b) are satisfiable. Verified by
 * RUNNING `runInit` (not reading the code — the ordering has diverged from the
 * plan twice before), including the atomicity leg: a refused init writes NOTHING,
 * dashboard_secret included, because generation is AFTER the preflight refusal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const { run: runInit } = await import("../src/cli/init.js");

/** relpath → "dir:<mode>" | "file:<mode>:<sha256>" over the WHOLE tree. */
function snapshotTree(root: string): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (p: string): void => {
    let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch { return; }
    const rel = path.relative(root, p) || ".";
    const mode = (st.mode & 0o777).toString(8);
    if (st.isDirectory()) {
      m.set(rel, `dir:${mode}`);
      for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e));
    } else if (st.isFile()) {
      m.set(rel, `file:${mode}:${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
    } else {
      m.set(rel, `other:${mode}`);
    }
  };
  walk(root);
  return m;
}

let dir: string;
let relayHome: string;
let claudeHome: string;
let configPath: string;
let errs: string[];
let errSpy: ReturnType<typeof vi.spyOn>;
let outSpy: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};

function readConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}
const CLEAN_ROOT = () => path.join(dir, "cleanroot", "bot-relay-mcp");
const NEWLINE_ROOT = () => path.join(dir, "root\nwith-newline", "bot-relay-mcp");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-dashsecret-"));
  relayHome = path.join(dir, "botrelay");
  claudeHome = path.join(dir, "claude");
  configPath = path.join(relayHome, "config.json");
  for (const k of ["RELAY_CONFIG_PATH", "RELAY_HOME", "RELAY_CLAUDE_HOME", "RELAY_SKIP_DAEMON", "RELAY_INSTANCE_ID", "RELAY_DASHBOARD_SECRET", "RELAY_HTTP_SECRET"]) {
    saved[k] = process.env[k];
  }
  process.env.RELAY_CONFIG_PATH = configPath;
  process.env.RELAY_HOME = relayHome;
  process.env.RELAY_CLAUDE_HOME = claudeHome;
  process.env.RELAY_SKIP_DAEMON = "1";
  delete process.env.RELAY_INSTANCE_ID;
  delete process.env.RELAY_DASHBOARD_SECRET;
  delete process.env.RELAY_HTTP_SECRET;
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

describe("ADR-0006 (a) — secret-by-default at init", () => {
  it("a fresh HTTP install generates a dashboard_secret (>= 32 chars)", async () => {
    const code = await runInit(["--yes", "--config-only", "--transport", "http"], CLEAN_ROOT());
    expect(code, errs.join("")).toBe(0);
    const cfg = readConfig();
    expect(typeof cfg.dashboard_secret).toBe("string");
    expect(cfg.dashboard_secret.length).toBeGreaterThanOrEqual(32);
    // It is NOT the same field as http_secret (different principal). A loopback
    // http install writes no http_secret, so it must be absent, not equal.
    expect(cfg.http_secret ?? null).toBeNull();
  });

  it("a fresh stdio install does NOT generate a dashboard_secret (no HTTP surface)", async () => {
    const code = await runInit(["--yes", "--config-only", "--transport", "stdio"], CLEAN_ROOT());
    expect(code, errs.join("")).toBe(0);
    const cfg = readConfig();
    expect(cfg.dashboard_secret ?? null).toBeNull();
  });

  it("a re-run PRESERVES the existing dashboard_secret (never rotates it)", async () => {
    await runInit(["--yes", "--config-only", "--transport", "http"], CLEAN_ROOT());
    const first = readConfig().dashboard_secret;
    expect(typeof first).toBe("string");
    await runInit(["--yes", "--config-only", "--transport", "http"], CLEAN_ROOT());
    const second = readConfig().dashboard_secret;
    expect(second).toBe(first); // reconcile preserved it — a re-run must not rotate the operator secret
  });

  it("a legacy HTTP config WITHOUT dashboard_secret gets one added on the next init (migration)", async () => {
    // Simulate a pre-ADR-0006 install: an http config with no dashboard_secret.
    fs.mkdirSync(relayHome, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ transport: "http", http_port: 3777, http_host: "127.0.0.1" }), { mode: 0o600 });
    const code = await runInit(["--yes", "--config-only", "--transport", "http"], CLEAN_ROOT());
    expect(code, errs.join("")).toBe(0);
    const cfg = readConfig();
    expect(typeof cfg.dashboard_secret).toBe("string");
    expect(cfg.dashboard_secret.length).toBeGreaterThanOrEqual(32);
  });

  // The "run, don't read" preflight-ordering leg for THIS change: dashboard_secret
  // generation lives in the config-write step, which runs AFTER the preflight
  // refusal. So a refused HTTP init must still leave the tree byte-identical —
  // no secret generated, no config, no $RELAY_HOME. Proven by execution.
  it("ATOMICITY: a refused HTTP init (newline root) writes NOTHING — dashboard_secret included", async () => {
    const before = snapshotTree(dir);
    const code = await runInit(["--yes", "--skip-daemon", "--transport", "http"], NEWLINE_ROOT());
    expect(code).toBe(1);
    expect(snapshotTree(dir)).toEqual(before); // no config, no secret, no $RELAY_HOME
    expect(errs.join("")).toMatch(/refusing/i);
  });
});
