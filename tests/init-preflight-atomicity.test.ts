// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * codex #139 P1 (rounds 6 & 10) — ATOMICITY of the unquotable-root refusal.
 *
 * quoteForHookCommand refuses a newline/CR-bearing install root (no safe
 * single-line shell command exists). The refusal POLICY is right; the MECHANISM
 * must not leave a PARTIAL COMMIT. v6 moved the refusal before the config writes
 * but `ensureSecureDir($RELAY_HOME)` still ran first — so a refusal created
 * $RELAY_HOME and "nothing was written" was a lie (round 10). runInit now
 * preflights before ANY filesystem-creating action.
 *
 * THE CONTROL IS WRITTEN FROM THE HARM, NOT A PROXY. The v6 control asserted on
 * config.json + ~/.claude.json SPECIFICALLY — which is exactly why it passed while
 * a THIRD artefact ($RELAY_HOME) was created. The harm is "ANYTHING was written",
 * so we snapshot the ENTIRE redirected tree (every path, its bytes, and its mode)
 * before and after, and assert byte-identical. An enumerated file list can only
 * catch artefacts you already imagined.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const { run: runInit } = await import("../src/cli/init.js");

/** The WHOLE tree under `root`: relpath → "dir:<mode>" | "file:<mode>:<sha256>". */
function snapshotTree(root: string): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (p: string): void => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
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

let dir: string; // the temp ROOT; every redirected path lives UNDER it
let relayHome: string; // does NOT exist yet — init would create it (the round-10 artefact)
let claudeHome: string; // does NOT exist yet
let configPath: string;
let errs: string[];
let errSpy: ReturnType<typeof vi.spyOn>;
let outSpy: ReturnType<typeof vi.spyOn>;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-atomicity-"));
  relayHome = path.join(dir, "botrelay"); // NOT created — init's ensureSecureDir would create it
  claudeHome = path.join(dir, "claude"); // NOT created
  configPath = path.join(relayHome, "config.json");
  for (const k of ["RELAY_CONFIG_PATH", "RELAY_HOME", "RELAY_CLAUDE_HOME", "RELAY_SKIP_DAEMON", "RELAY_INSTANCE_ID"]) {
    saved[k] = process.env[k];
  }
  process.env.RELAY_CONFIG_PATH = configPath;
  process.env.RELAY_HOME = relayHome;
  process.env.RELAY_CLAUDE_HOME = claudeHome;
  process.env.RELAY_SKIP_DAEMON = "1";
  delete process.env.RELAY_INSTANCE_ID;
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

const NEWLINE_ROOT = () => path.join(dir, "root\nwith-newline", "bot-relay-mcp");

describe("codex #139 P1 — init preflight atomicity (newline install root)", () => {
  it("HARM: init from a newline root → refuses AND leaves the WHOLE tree byte-identical (nothing created)", async () => {
    const before = snapshotTree(dir);
    const code = await runInit(["--yes", "--skip-daemon"], NEWLINE_ROOT());
    expect(code).toBe(1);
    // The harm is "anything written", not "config.json written" — assert the ENTIRE
    // tree is unchanged: no $RELAY_HOME, no instance dir, no config, no artefact.
    expect(snapshotTree(dir)).toEqual(before);
    const msg = errs.join("");
    expect(msg).toMatch(/refusing/i);
    expect(msg).toMatch(/newline\/CR/);
    expect(msg).toMatch(/nothing was written/i);
  });

  it("re-running from the newline root repeats the refusal and STILL leaves the tree byte-identical", async () => {
    const before = snapshotTree(dir);
    await runInit(["--yes", "--skip-daemon"], NEWLINE_ROOT());
    const code2 = await runInit(["--yes", "--skip-daemon"], NEWLINE_ROOT());
    expect(code2).toBe(1);
    expect(snapshotTree(dir)).toEqual(before); // no accreting half-install across runs
  });

  it("INNOCENT: --config-only from the SAME newline root SUCCEEDS and writes config.json", async () => {
    const code = await runInit(["--yes", "--config-only"], NEWLINE_ROOT());
    expect(code, errs.join("")).toBe(0);
    expect(fs.existsSync(configPath)).toBe(true); // config IS written (no hook involved)
  });

  it("INNOCENT: --skip-hooks from a newline root SUCCEEDS (config written, no hook, no throw)", async () => {
    const code = await runInit(["--yes", "--skip-daemon", "--skip-hooks"], NEWLINE_ROOT());
    expect(code, errs.join("")).toBe(0);
    expect(fs.existsSync(configPath)).toBe(true);
  });
});
