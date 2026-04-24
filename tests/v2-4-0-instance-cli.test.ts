// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.0 Part E.4 — extra per-instance coverage + CLI subcommands.
 *
 * E.4.1  relay init --instance-id writes per-instance config path.
 * E.4.2  relay init --multi-instance auto-generates a UUID.
 * E.4.3  relay list-instances lists every instance, marks the active one.
 * E.4.4  relay list-instances --json emits valid JSON.
 * E.4.5  relay use-instance flips the active pointer.
 * E.4.6  relay use-instance refuses unknown instance_id.
 * E.4.7  Legacy flat layout + an `instances/` subdir coexist safely.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-v240-cli-"));
process.env.RELAY_HOME = TEST_HOME;
// init.ts uses defaultConfigPath() which reads RELAY_CONFIG_PATH, else
// joins os.homedir()+.bot-relay. Override that too so init writes into
// our test home.
process.env.RELAY_CONFIG_PATH = path.join(TEST_HOME, "config.json");
// init.ts ALSO uses os.homedir() directly for defaultBotRelayDir() —
// we hijack that via HOME override. Not every platform respects HOME
// for os.homedir(), but on posix (macOS/Linux) it does.
const ORIGINAL_HOME = process.env.HOME;
process.env.HOME = TEST_HOME;

delete process.env.RELAY_INSTANCE_ID;
delete process.env.RELAY_DB_PATH;
delete process.env.RELAY_HTTP_SECRET;

const { run: runInit } = await import("../src/cli/init.js");
const { run: runListInstances } = await import("../src/cli/list-instances.js");
const { run: runUseInstance } = await import("../src/cli/use-instance.js");
const { listInstances, resolveActiveInstanceId, createInstance, generateInstanceId } =
  await import("../src/instance.js");

function freshHome(): void {
  if (fs.existsSync(TEST_HOME)) fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.mkdirSync(TEST_HOME, { recursive: true });
  process.env.RELAY_CONFIG_PATH = path.join(TEST_HOME, "config.json");
}

beforeEach(() => {
  delete process.env.RELAY_INSTANCE_ID;
  delete process.env.RELAY_DB_PATH;
  freshHome();
});
afterEach(() => {
  if (ORIGINAL_HOME) process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;
  delete process.env.RELAY_INSTANCE_ID;
  delete process.env.RELAY_DB_PATH;
});

// Utility: capture stdout across a CLI run. The CLIs write to
// process.stdout directly — we swap in a buffer temporarily.
async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: any) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const result = await fn();
    return { result, out: chunks.join("") };
  } finally {
    (process.stdout as any).write = orig;
  }
}

describe("v2.4.0 E.4 — relay init --instance-id / --multi-instance", () => {
  it("(E.4.1) --instance-id writes per-instance config path + metadata", async () => {
    const id = "work";
    const { result } = await captureStdout(() =>
      runInit(["--yes", "--profile=team", "--instance-id", id]),
    );
    expect(result).toBe(0);
    const expectedCfg = path.join(TEST_HOME, "instances", id, "config.json");
    expect(fs.existsSync(expectedCfg)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(expectedCfg, "utf-8"));
    expect(cfg.instance_id).toBe(id);
    expect(cfg.profile).toBe("team");
    // instance.json metadata present.
    const metaPath = path.join(TEST_HOME, "instances", id, "instance.json");
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(meta.instance_id).toBe(id);
    // Flat <root>/config.json should NOT exist — multi-instance
    // writes only to the per-instance dir.
    const legacyCfg = path.join(TEST_HOME, "config.json");
    expect(fs.existsSync(legacyCfg)).toBe(false);
  });

  it("(E.4.2) --multi-instance auto-generates a UUID", async () => {
    const { result, out } = await captureStdout(() =>
      runInit(["--yes", "--profile=team", "--multi-instance"]),
    );
    expect(result).toBe(0);
    // Output includes the generated id; grep a UUID shape.
    const match = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(match).toBeTruthy();
    const id = match![0];
    const cfg = path.join(TEST_HOME, "instances", id, "config.json");
    expect(fs.existsSync(cfg)).toBe(true);
  });
});

describe("v2.4.0 E.4 — relay list-instances", () => {
  it("(E.4.3) lists every instance + marks the active one with *", async () => {
    createInstance("alpha", "2.4.0", "work");
    createInstance("beta", "2.4.0", "personal");
    process.env.RELAY_INSTANCE_ID = "alpha";
    const { result, out } = await captureStdout(() => runListInstances([]));
    expect(result).toBe(0);
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain(" * alpha");
  });

  it("(E.4.4) --json emits valid JSON with active_instance_id field", async () => {
    createInstance("alpha", "2.4.0");
    createInstance("beta", "2.4.0");
    process.env.RELAY_INSTANCE_ID = "beta";
    const { result, out } = await captureStdout(() => runListInstances(["--json"]));
    expect(result).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.active_instance_id).toBe("beta");
    expect(Array.isArray(parsed.instances)).toBe(true);
    expect(parsed.instances.length).toBe(2);
    const betaEntry = parsed.instances.find((x: any) => x.instance_id === "beta");
    expect(betaEntry?.active).toBe(true);
  });

  it("(E.4.3b) empty-instances message in legacy mode", async () => {
    const { result, out } = await captureStdout(() => runListInstances([]));
    expect(result).toBe(0);
    expect(out).toMatch(/legacy mode is active/);
  });
});

describe("v2.4.0 E.4 — relay use-instance", () => {
  it("(E.4.5) flips the active pointer + persists across resolves", async () => {
    const id = generateInstanceId();
    createInstance(id, "2.4.0", "target");
    delete process.env.RELAY_INSTANCE_ID;
    const { result } = await captureStdout(() => runUseInstance([id]));
    expect(result).toBe(0);
    expect(resolveActiveInstanceId()).toBe(id);
  });

  it("(E.4.6) refuses unknown instance_id with non-zero exit", async () => {
    const { result, out } = await captureStdout(async () => {
      const origStderr = process.stderr.write.bind(process.stderr);
      (process.stderr as any).write = () => true;
      try {
        return await runUseInstance(["does-not-exist"]);
      } finally {
        (process.stderr as any).write = origStderr;
      }
    });
    expect(result).not.toBe(0);
    expect(out).not.toContain("Active instance set to");
  });
});

describe("v2.4.0 E.4 — backward compatibility", () => {
  it("(E.4.7) legacy flat layout + an instances/ subdir coexist", async () => {
    // Pre-create a legacy <root>/relay.db the way a pre-v2.4
    // operator would have had it (RELAY_HOME IS the bot-relay root).
    fs.mkdirSync(TEST_HOME, { recursive: true });
    fs.writeFileSync(path.join(TEST_HOME, "relay.db"), "");
    // Add a multi-instance dir alongside.
    createInstance("alpha", "2.4.0", "work");
    const list = listInstances();
    expect(list.length).toBe(1);
    expect(list[0].instance_id).toBe("alpha");
    // Legacy file is untouched.
    expect(fs.existsSync(path.join(TEST_HOME, "relay.db"))).toBe(true);
  });
});
