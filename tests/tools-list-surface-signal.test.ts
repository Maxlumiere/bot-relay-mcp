// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

// #tools-list-visibility (victra delivery review, 2026-08-31) — tools/list is a bare MCP protocol
// array we cannot extend, so a profile-hidden tool leaves NO signal there: an agent cannot tell
// "hidden by my profile" from "does not exist" from "not connected", and a missing CAPABILITY is
// never noticed because nobody looks for a tool they do not know exists. The signal goes into the
// always-visible health_check response (`surface`), which names the hidden tools so the three states
// are distinguishable. HONEST BOUND: an agent that reads only tools/list and never calls health_check
// can still be fooled — inseparability is unreachable through the protocol; a breadcrumb in
// health_check's DESCRIPTION (asserted in the tool-description tests) is the pointer inside tools/list.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_TMP = path.join(os.tmpdir(), "bot-relay-surface-" + process.pid);
const CONFIG_PATH = path.join(TEST_TMP, "config.json");
process.env.RELAY_CONFIG_PATH = CONFIG_PATH;
process.env.RELAY_CLAUDE_HOME = TEST_TMP;
process.env.RELAY_DB_PATH = path.join(TEST_TMP, "db", "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const { resolveSurfaceSummary, TOOL_BUNDLES } = await import("../src/surface-shape.js");
const { handleHealthCheck } = await import("../src/tools/status.js");
const { closeDb } = await import("../src/db.js");

function writeConfig(cfg: object): void {
  fs.mkdirSync(TEST_TMP, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
}
beforeEach(() => {
  if (fs.existsSync(TEST_TMP)) fs.rmSync(TEST_TMP, { recursive: true, force: true });
  fs.mkdirSync(TEST_TMP, { recursive: true });
});
afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_TMP)) fs.rmSync(TEST_TMP, { recursive: true, force: true });
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function surfaceFromHealth(): any {
  const res = handleHealthCheck({} as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return JSON.parse((res.content[0] as any).text).surface;
}

describe("#tools-list-visibility — the hidden tool surface is observable via health_check", () => {
  it("a core-only profile reports the hidden tools BY NAME (so hidden != nonexistent != disconnected)", () => {
    writeConfig({ profile: "solo", feature_bundles: ["core"] });
    const s = surfaceFromHealth();
    expect(s.profile).toBe("solo");
    expect(s.feature_bundles).toEqual(["core"]);
    expect(s.tools_hidden).toBeGreaterThan(0);
    // the NAMES are the load-bearing part — counts alone cannot separate hidden from nonexistent
    for (const t of ["register_webhook", "create_channel", "rotate_token", "get_standup"]) {
      expect(s.hidden_tools, `${t} should be reported as hidden by the core-only profile`).toContain(t);
    }
    // health_check + discover_agents are ALWAYS visible → never in hidden_tools
    expect(s.hidden_tools).not.toContain("health_check");
    expect(s.hidden_tools).not.toContain("discover_agents");
    // counts are internally consistent AND the total is the full inventory (no drift)
    expect(s.tools_visible + s.tools_hidden).toBe(s.tools_total);
    expect(s.tools_total).toBe(Object.keys(TOOL_BUNDLES).length);
  });

  it("all bundles visible: nothing hidden", () => {
    writeConfig({ profile: "team", feature_bundles: ["core", "webhooks", "channels", "admin", "managed-agents"] });
    const s = surfaceFromHealth();
    expect(s.tools_hidden).toBe(0);
    expect(s.hidden_tools).toEqual([]);
    expect(s.tools_visible).toBe(s.tools_total);
  });

  it("resolveSurfaceSummary computes over the full TOOL_BUNDLES inventory (>=30 tools)", () => {
    writeConfig({ feature_bundles: ["core"] });
    const s = resolveSurfaceSummary();
    expect(s.tools_total).toBe(Object.keys(TOOL_BUNDLES).length);
    expect(s.tools_total).toBeGreaterThanOrEqual(30);
  });
});
