// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_CONFIG_DIR = path.join(os.tmpdir(), "bot-relay-config-test-" + process.pid);
const TEST_CONFIG_PATH = path.join(TEST_CONFIG_DIR, "config.json");

function cleanup() {
  delete process.env.RELAY_TRANSPORT;
  delete process.env.RELAY_HTTP_PORT;
  delete process.env.RELAY_HTTP_HOST;
  if (fs.existsSync(TEST_CONFIG_DIR)) {
    fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => {
  cleanup();
  fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  process.env.RELAY_CONFIG_PATH = TEST_CONFIG_PATH;
});

afterEach(() => cleanup());

describe("config loader", () => {
  it("returns defaults when no config file exists", async () => {
    fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
    // Re-import to get a fresh instance
    const { loadConfig, DEFAULT_CONFIG } = await import("../src/config.js?defaults=" + Date.now());
    const config = loadConfig();
    expect(config.transport).toBe(DEFAULT_CONFIG.transport);
    expect(config.http_port).toBe(DEFAULT_CONFIG.http_port);
  });

  it("reads values from config file", async () => {
    fs.writeFileSync(
      TEST_CONFIG_PATH,
      JSON.stringify({ transport: "http", http_port: 9999 })
    );
    const { loadConfig } = await import("../src/config.js?file=" + Date.now());
    const config = loadConfig();
    expect(config.transport).toBe("http");
    expect(config.http_port).toBe(9999);
  });

  it("environment variables override file config", async () => {
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ transport: "stdio" }));
    process.env.RELAY_TRANSPORT = "both";
    process.env.RELAY_HTTP_PORT = "4444";
    const { loadConfig } = await import("../src/config.js?env=" + Date.now());
    const config = loadConfig();
    expect(config.transport).toBe("both");
    expect(config.http_port).toBe(4444);
  });

  it("ignores invalid env transport values", async () => {
    process.env.RELAY_TRANSPORT = "garbage";
    const { loadConfig } = await import("../src/config.js?bad=" + Date.now());
    const config = loadConfig();
    expect(config.transport).toBe("stdio");
  });

  it("handles malformed config file gracefully", async () => {
    fs.writeFileSync(TEST_CONFIG_PATH, "{ not valid json");
    const { loadConfig } = await import("../src/config.js?malformed=" + Date.now());
    const config = loadConfig();
    expect(config.transport).toBe("stdio"); // fallback to default
  });
});
