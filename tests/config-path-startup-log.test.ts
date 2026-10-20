// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The relay's startup lines name the config file it ACTUALLY READ. They printed RELAY_CONFIG_PATH or
 * "(default ~/.bot-relay/config.json)", which is false whenever an instance is active, and the transport="http"
 * WARNING told the operator to fix THAT file: the wrong one (MEASURED on main, this file, RED). Now both print
 * getConfigPath(), the one resolver. Driven through the BUILT daemon (dist/index.js) in a private RELAY_HOME.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = path.join(REPO, "dist", "index.js");

/** A private relay home with an ACTIVE instance whose config is `cfg`; returns the env and the instance config path. */
async function instanceHome(cfg: Record<string, unknown>): Promise<{ env: NodeJS.ProcessEnv; instCfg: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-startup-"));
  const relayHome = path.join(home, ".bot-relay");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, RELAY_HOME: relayHome, RELAY_INSTANCE_ID: "probe-inst" };
  for (const k of ["RELAY_CONFIG_PATH", "RELAY_DB_PATH", "RELAY_TRANSPORT", "RELAY_AGENT_TOKEN", "RELAY_AGENT_NAME"]) delete env[k];
  const instDir = path.join(relayHome, "instances", "probe-inst");
  fs.mkdirSync(instDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(instDir, "instance.json"), JSON.stringify({ instance_id: "probe-inst", created_at: new Date().toISOString(), version: "test" }), { mode: 0o600 });
  const instCfg = path.join(instDir, "config.json");
  fs.writeFileSync(instCfg, JSON.stringify(cfg), { mode: 0o600 });
  return { env, instCfg };
}

describe("the startup lines name the config file the relay READ (one resolver)", () => {
  it("HARM the [config] line under an active instance names the INSTANCE config, never the flat default", async () => {
    expect(fs.existsSync(INDEX), "precondition: dist/ is built").toBe(true);
    const { env, instCfg } = await instanceHome({});
    // stdio, stdin closed at once: the process logs its config line and exits.
    const r = spawnSync(process.execPath, [INDEX], { env: { ...env, RELAY_TRANSPORT: "stdio" }, input: "", encoding: "utf-8", timeout: 30_000 });
    const line = r.stderr.split("\n").find((l) => l.includes("[config] transport=")) ?? "";
    expect(line, `no [config] line: ${r.stderr.slice(-800)}`).not.toBe("");
    expect(line).toContain(`config_path=${instCfg}`);
    expect(line).not.toContain("~/.bot-relay/config.json");
  });

  it("HARM the transport=\"http\" WARNING tells the operator to fix the INSTANCE config, the file it was read from", async () => {
    const { env, instCfg } = await instanceHome({ transport: "http", http_port: 0, http_host: "127.0.0.1" });
    // The warning is written before the HTTP server starts; a short timeout ends the process after that.
    const r = spawnSync(process.execPath, [INDEX], { env, input: "", encoding: "utf-8", timeout: 8_000, killSignal: "SIGTERM" });
    const warning = r.stderr.split("\n").find((l) => l.includes('transport="http" was read from the config FILE')) ?? "";
    expect(warning, `no warning: ${r.stderr.slice(-800)}`).not.toBe("");
    expect(warning).toContain(`(${instCfg})`);
  });
});
