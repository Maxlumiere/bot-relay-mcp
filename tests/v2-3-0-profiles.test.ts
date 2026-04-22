// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.3.0 Part B — profiles + surface shaping.
 *
 * B.1.1  `relay init --profile=solo` writes solo defaults.
 * B.1.2  `relay init --profile=team` writes team defaults (http, all bundles).
 * B.1.3  `relay init --profile=ci` writes ci defaults (warn logs, no dashboard).
 * B.1.4  invalid `--profile=xyz` exits non-zero.
 * B.2.1  isToolVisible filters by bundle.
 * B.2.2  health_check + discover_agents are always visible.
 * B.2.3  hidden tools in tool_visibility.hidden return false.
 * B.2.4  every registered tool name has a TOOL_BUNDLES entry (drift guard).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_TMP = path.join(os.tmpdir(), "bot-relay-v230-profiles-" + process.pid);
const CONFIG_PATH = path.join(TEST_TMP, "config.json");

beforeEach(() => {
  if (fs.existsSync(TEST_TMP)) fs.rmSync(TEST_TMP, { recursive: true, force: true });
  fs.mkdirSync(TEST_TMP, { recursive: true });
  process.env.RELAY_CONFIG_PATH = CONFIG_PATH;
});
afterEach(() => {
  delete process.env.RELAY_CONFIG_PATH;
  if (fs.existsSync(TEST_TMP)) fs.rmSync(TEST_TMP, { recursive: true, force: true });
});

const { run: runInit, applyProfileDefaults } = await import("../src/cli/init.js");
const { isToolVisible, TOOL_BUNDLES } = await import("../src/server.js");

describe("v2.3.0 B.1 — relay init --profile", () => {
  it("(B.1.1) --profile=solo writes minimal core-only config", async () => {
    const code = await runInit(["--yes", "--profile=solo"]);
    expect(code).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    expect(cfg.profile).toBe("solo");
    expect(cfg.transport).toBe("stdio");
    expect(cfg.feature_bundles).toEqual(["core"]);
    expect(cfg.logging_level).toBe("info");
    expect(cfg.agent_abandon_days).toBe(30);
    expect(cfg.dashboard_enabled).toBe(true);
  });

  it("(B.1.2) --profile=team writes http + all bundles", async () => {
    const code = await runInit(["--yes", "--profile=team"]);
    expect(code).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    expect(cfg.profile).toBe("team");
    expect(cfg.transport).toBe("http");
    expect(cfg.feature_bundles).toContain("core");
    expect(cfg.feature_bundles).toContain("channels");
    expect(cfg.feature_bundles).toContain("webhooks");
    expect(cfg.feature_bundles).toContain("admin");
    expect(cfg.agent_abandon_days).toBe(7);
  });

  it("(B.1.3) --profile=ci writes warn logs + no dashboard", async () => {
    const code = await runInit(["--yes", "--profile=ci"]);
    expect(code).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    expect(cfg.profile).toBe("ci");
    expect(cfg.transport).toBe("stdio");
    expect(cfg.feature_bundles).toEqual(["core"]);
    expect(cfg.logging_level).toBe("warn");
    expect(cfg.dashboard_enabled).toBe(false);
    expect(cfg.agent_abandon_days).toBe(1);
  });

  it("(B.1.4) invalid --profile=xyz returns non-zero", async () => {
    const code = await runInit(["--yes", "--profile=xyz"]);
    expect(code).not.toBe(0);
  });

  it("(B.1.5) applyProfileDefaults('solo') defaults are stable", () => {
    const d = applyProfileDefaults("solo");
    expect(d.transport).toBe("stdio");
    expect(d.feature_bundles).toEqual(["core"]);
  });

  it("(B.1.6) explicit --transport overrides profile default", async () => {
    const code = await runInit(["--yes", "--profile=solo", "--transport", "http"]);
    expect(code).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    expect(cfg.profile).toBe("solo");
    // profile defaulted to stdio, but --transport http overrode it
    expect(cfg.transport).toBe("http");
  });
});

describe("v2.3.0 B.2 — surface shaping", () => {
  it("(B.2.1) isToolVisible filters by bundle membership", () => {
    expect(isToolVisible("send_message", ["core"], [])).toBe(true);
    expect(isToolVisible("register_webhook", ["core"], [])).toBe(false);
    expect(isToolVisible("register_webhook", ["core", "webhooks"], [])).toBe(true);
    expect(isToolVisible("rotate_token", ["core", "admin"], [])).toBe(true);
    expect(isToolVisible("rotate_token", ["core"], [])).toBe(false);
    expect(isToolVisible("create_channel", ["core", "channels"], [])).toBe(true);
    expect(isToolVisible("create_channel", ["core"], [])).toBe(false);
  });

  it("(B.2.2) health_check + discover_agents always visible", () => {
    expect(isToolVisible("health_check", [], [])).toBe(true);
    expect(isToolVisible("discover_agents", [], [])).toBe(true);
    expect(isToolVisible("health_check", ["core"], [])).toBe(true);
  });

  it("(B.2.3) tool_visibility.hidden overrides bundle membership", () => {
    // send_message is in core, so normally visible under solo.
    expect(isToolVisible("send_message", ["core"], ["send_message"])).toBe(false);
  });

  it("(B.2.4) every registered tool in server.ts has a TOOL_BUNDLES entry", () => {
    // Source-of-truth grep: every `name: "foo"` line inside
    // ALL_TOOLS_DEFINITION must have a bundle mapping. Drift guard —
    // otherwise a new tool silently falls to the "core" fallback + ships
    // without explicit bundle discipline.
    const src = fs.readFileSync(path.join(process.cwd(), "src", "server.ts"), "utf-8");
    const listStart = src.indexOf("const ALL_TOOLS_DEFINITION");
    const listEnd = src.indexOf("];", listStart);
    expect(listStart).toBeGreaterThan(0);
    expect(listEnd).toBeGreaterThan(listStart);
    const slice = src.slice(listStart, listEnd);
    const names = Array.from(slice.matchAll(/\bname:\s*"([a-z_]+)"/g)).map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(27);
    for (const n of names) {
      expect(TOOL_BUNDLES[n], `tool "${n}" missing from TOOL_BUNDLES`).toBeTruthy();
    }
  });
});
