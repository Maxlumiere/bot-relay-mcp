// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.16.0 (gate 9) — D2 precedence for the SessionStart hook's config
 * `default_agent_name` fallback.
 *
 * The fallback lets `relay init --agent NAME` give a zero-shell-edit identity,
 * BUT an explicit RELAY_AGENT_NAME (and a spawn manifest) must WIN — otherwise
 * multiple terminals that each set their own name would collapse into one
 * identity (the failure gate-9 guards against). This drives the SHIPPED hook.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const HOOK = path.join(REPO_ROOT, "hooks", "check-relay.sh");

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "v2160-hook-d2-"));
  fs.mkdirSync(path.join(root, "agents"), { recursive: true, mode: 0o700 });
  // Empty DB file (identity resolution + the config message happen BEFORE any
  // DB read; a running daemon is NOT needed for this test).
  fs.writeFileSync(path.join(root, "relay.db"), "");
  fs.writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({ transport: "http", http_port: 3777, default_agent_name: "config-agent" }, null, 2),
  );
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function runHook(agentNameEnv: string | undefined): { stderr: string; status: number } {
  const env: Record<string, string> = {
    HOME: root,
    PATH: process.env.PATH || "/usr/bin:/bin",
    RELAY_HOME: root,
    RELAY_DB_PATH: path.join(root, "relay.db"),
    RELAY_CONFIG_PATH: path.join(root, "config.json"),
    RELAY_HTTP_HOST: "127.0.0.1",
    RELAY_HTTP_PORT: "39771", // nothing listening → register is skipped
    RELAY_AGENT_ROLE: "builder",
    RELAY_AGENT_CAPABILITIES: "",
  };
  if (agentNameEnv !== undefined) env.RELAY_AGENT_NAME = agentNameEnv;
  const r = spawnSync("bash", [HOOK], { encoding: "utf-8", timeout: 12_000, env, input: "" });
  return { stderr: r.stderr ?? "", status: r.status ?? -1 };
}

describe("v2.16.0 — hook config default_agent_name (D2 precedence)", () => {
  it("uses config default_agent_name when RELAY_AGENT_NAME is unset", () => {
    const { stderr } = runHook(undefined);
    expect(stderr).toMatch(/using default agent name from config: config-agent/);
  });

  it("uses config default_agent_name when RELAY_AGENT_NAME is the literal 'default'", () => {
    const { stderr } = runHook("default");
    expect(stderr).toMatch(/using default agent name from config: config-agent/);
  });

  it("an explicit RELAY_AGENT_NAME WINS over the config default (no collapse)", () => {
    const { stderr } = runHook("explicit-agent");
    expect(stderr, "explicit env must not be overridden by the config default").not.toMatch(
      /using default agent name from config/,
    );
  });

  it("no config message when config.json has no default_agent_name", () => {
    fs.writeFileSync(
      path.join(root, "config.json"),
      JSON.stringify({ transport: "http", http_port: 3777 }, null, 2),
    );
    const { stderr } = runHook(undefined);
    expect(stderr).not.toMatch(/using default agent name from config/);
  });
});
