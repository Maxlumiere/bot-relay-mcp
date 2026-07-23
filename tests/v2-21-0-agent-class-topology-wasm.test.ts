// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0002 (v2.21.0) parity on the sql.js (wasm) driver — the schema v21 `class`
 * column round-trips through the projection and the topology grouping/exclusion
 * behave identically to the native driver.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-adr0002-wasm-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
process.env.RELAY_SQLITE_DRIVER = "wasm";

const { initializeDb, closeDb, getDb, registerAgent, getAgents, buildAgentTopology } = await import("../src/db.js");
const { UNCLASSIFIED } = await import("../src/agent-class.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(async () => {
  cleanup();
  await initializeDb();
});
afterEach(() => cleanup());

describe("wasm driver — ADR-0002 parity", () => {
  it("schema v21 `class` column exists + round-trips through discovery", () => {
    const cols = (getDb().prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("class");
    registerAgent("w-orch", "coord", [], { class: "orchestrator" });
    registerAgent("w-legacy", "worker", []);
    expect(getAgents().find((a) => a.name === "w-orch")!.class).toBe("orchestrator");
    expect(getAgents().find((a) => a.name === "w-legacy")!.class).toBe(UNCLASSIFIED);
  });

  it("topology groups by class + excludes transient/unclassified", () => {
    registerAgent("w-b", "impl", [], { class: "builder" });
    registerAgent("w-t", "tmp", [], { class: "transient" });
    registerAgent("w-u", "legacy", []);
    const topo = buildAgentTopology();
    expect(topo.topology.builder.map((x) => x.name)).toEqual(["w-b"]);
    const shown = Object.values(topo.topology).flat().map((x) => x.name);
    expect(shown).not.toContain("w-t");
    expect(shown).not.toContain("w-u");
    expect(topo.excluded.transient).toBe(1);
    expect(topo.excluded.unclassified).toBe(1);
  });
});
