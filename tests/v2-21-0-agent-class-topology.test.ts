// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0002 (v2.21.0) — agent coordination-class + view='topology'.
 *
 * Load-bearing checks (Victra/architect gate): class ROUND-TRIPS through the
 * discovery projection (or it's silently dropped like managed/visibility);
 * transient + unclassified + dead are excluded from the topology who's-who;
 * class is immutable on re-register; the default 'list' view is back-compat;
 * the three axes (role/class/capability) are orthogonal; and the drift guard
 * ADVERSARIALLY rejects a taxonomy re-fork.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-adr0002-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_ALLOW_LEGACY;

const db = await import("../src/db.js");
const { closeDb, getDb, registerAgent, getAgents, buildAgentTopology, setAgentLivenessAnchor } = db;
const { _resetOwnHostIdForTests } = await import("../src/liveness.js");
const { RegisterAgentSchema } = await import("../src/types.js");
const { UNCLASSIFIED, normalizeAgentClass } = await import("../src/agent-class.js");
const { findAgentClassViolations } = await import("../scripts/agent-class-guard.mjs");

function reset() {
  closeDb();
  _resetOwnHostIdForTests(undefined);
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(() => {
  reset();
  getDb();
});
afterEach(() => reset());

function reg(name: string, role: string, cls?: string) {
  registerAgent(name, role, [], cls ? { class: cls } : {});
}
function agent(name: string) {
  return getAgents().find((a) => a.name === name);
}

// ─────────────────────────────────────────────────────────────────────────────
describe("ADR-0002 — class round-trips + defaults + immutability", () => {
  it("a declared class ROUND-TRIPS through the discovery projection", () => {
    reg("rt-orch", "coordinator", "orchestrator");
    expect(agent("rt-orch")!.class).toBe("orchestrator");
  });

  it("the INITIAL register_agent response carries the declared class (codex #114 blocker)", () => {
    // The FIRST-registration response is projected from an in-memory row (not
    // re-read from the DB), so a dropped `class` there reads 'unclassified'
    // even though the persisted row + next discover_agents are correct. The
    // round-trip test above goes through getAgents() (re-read) and would NOT
    // catch it — so assert the DIRECT return value of registerAgent().
    const declared = registerAgent("first-auditor", "builder", [], { class: "auditor" });
    expect(declared.agent.class).toBe("auditor");
    // Undeclared still normalizes to unclassified in that same first response.
    const undeclared = registerAgent("first-legacy", "worker", []);
    expect(undeclared.agent.class).toBe(UNCLASSIFIED);
  });

  it("an undeclared class reads as `unclassified` (NULL normalized)", () => {
    reg("rt-legacy", "worker");
    expect(agent("rt-legacy")!.class).toBe(UNCLASSIFIED);
    expect(normalizeAgentClass(null)).toBe(UNCLASSIFIED);
  });

  it("class is IMMUTABLE on re-register (managed/caps precedent)", () => {
    reg("rt-imm", "r", "builder");
    registerAgent("rt-imm", "r", [], { class: "auditor" }); // attempt to change
    expect(agent("rt-imm")!.class).toBe("builder"); // unchanged
  });

  it("Zod rejects an out-of-taxonomy class; unclassified/bridge are NOT self-declarable", () => {
    expect(RegisterAgentSchema.safeParse({ name: "z", role: "r", capabilities: [], class: "bogus" }).success).toBe(false);
    expect(RegisterAgentSchema.safeParse({ name: "z", role: "r", capabilities: [], class: "unclassified" }).success).toBe(false);
    expect(RegisterAgentSchema.safeParse({ name: "z", role: "r", capabilities: [], class: "bridge" }).success).toBe(false);
    expect(RegisterAgentSchema.safeParse({ name: "z", role: "r", capabilities: [], class: "auditor" }).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ADR-0002 — view='topology'", () => {
  it("groups live agents by class, flat within class {name, role, class, status}", () => {
    reg("t-o", "coord", "orchestrator");
    reg("t-b1", "impl", "builder");
    reg("t-b2", "impl", "builder");
    reg("t-a", "arch", "advisory");
    reg("t-au", "review", "auditor");
    const topo = buildAgentTopology();
    expect(topo.view).toBe("topology");
    expect(topo.topology.orchestrator.map((x) => x.name)).toEqual(["t-o"]);
    expect(topo.topology.builder.map((x) => x.name).sort()).toEqual(["t-b1", "t-b2"]);
    expect(topo.topology.auditor[0]).toMatchObject({ name: "t-au", role: "review", class: "auditor" });
    expect(topo.topology.auditor[0]).toHaveProperty("status");
    expect(topo.counts.builder).toBe(2);
  });

  it("transient + unclassified are EXCLUDED from the who's-who (own buckets, counted)", () => {
    reg("ex-b", "impl", "builder");
    reg("ex-t", "tmp", "transient");
    reg("ex-u", "legacy"); // no class → unclassified
    const topo = buildAgentTopology();
    const allShown = Object.values(topo.topology).flat().map((x) => x.name);
    expect(allShown).toContain("ex-b");
    expect(allShown).not.toContain("ex-t");
    expect(allShown).not.toContain("ex-u");
    expect(topo.excluded.transient).toBe(1);
    expect(topo.excluded.unclassified).toBe(1);
    expect(topo.topology).not.toHaveProperty("transient"); // no transient group at all
  });

  it("DEAD/terminal agents are excluded via liveness (separate from class)", () => {
    _resetOwnHostIdForTests("adr2-host");
    reg("dead-b", "impl", "builder");
    reg("live-b", "impl", "builder");
    // Anchor dead-b to a definitely-dead PID on this host → verdict dead → status offline.
    getDb().prepare("UPDATE agents SET host_id = ? WHERE name = ?").run("adr2-host", "dead-b");
    setAgentLivenessAnchor("dead-b", 2147480000, "0");
    expect(agent("dead-b")!.status).toBe("offline");
    const topo = buildAgentTopology();
    const builders = topo.topology.builder.map((x) => x.name);
    expect(builders).toContain("live-b");
    expect(builders).not.toContain("dead-b"); // excluded even though it's a valid builder class
    expect(topo.excluded.offline).toBeGreaterThanOrEqual(1);
  });

  it("THREE-AXIS separation: grouping is by CLASS, not by the free-text role", () => {
    // role says "builder" but class is auditor → must group under auditor.
    reg("axis", "builder", "auditor");
    const topo = buildAgentTopology();
    expect(topo.topology.auditor.map((x) => x.name)).toContain("axis");
    expect(topo.topology.builder.map((x) => x.name)).not.toContain("axis");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ADR-0002 — back-compat", () => {
  it("discover schema defaults view to 'list' (unchanged flat list)", async () => {
    const { DiscoverAgentsSchema } = await import("../src/types.js");
    expect(DiscoverAgentsSchema.parse({}).view).toBe("list");
    expect(DiscoverAgentsSchema.parse({ role: "x" }).view).toBe("list");
  });

  it("register without a class still succeeds (class is optional)", () => {
    expect(RegisterAgentSchema.safeParse({ name: "bc", role: "r", capabilities: [] }).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ADR-0002 — adversarial drift guard (test the guard, not just the code)", () => {
  const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");

  it("real src/ passes — no class taxonomy re-fork outside agent-class.ts", () => {
    // db.ts carries an ALLOWLIST'd role vocab (DISPATCH_RELEVANT_ROLES); everything else must be clean.
    const dbSrc = readFileSync(path.join(srcDir, "db.ts"), "utf-8");
    expect(findAgentClassViolations(dbSrc, "db.ts")).toEqual([]);
    const idSrc = readFileSync(path.join(srcDir, "tools/identity.ts"), "utf-8");
    expect(findAgentClassViolations(idSrc, "identity.ts")).toEqual([]);
  });

  it("NEGATIVE FIXTURE: the guard FLAGS a re-fork (parallel vocab + class-value branch)", () => {
    const bad = `
      const PARALLEL_CLASSES = ["orchestrator", "builder", "auditor"];
      function route(c: string) {
        if (c === "advisory") return "x";
        switch (c) { case "transient": return "y"; }
      }`;
    const v = findAgentClassViolations(bad, "bad.ts").map((x: { kind: string }) => x.kind);
    expect(v).toContain("parallel class vocabulary");
    expect(v).toContain("class-value equality branch");
    expect(v).toContain("class-value switch/case");
  });

  it("does NOT flag prose / single mentions / imported-const branches", () => {
    const ok = `
      import { TRANSIENT } from "./agent-class.js";
      // an orchestrator coordinates; a builder implements — prose, not a branch.
      const desc = "one of orchestrator | builder | advisory";
      function f(c: string) { return c === TRANSIENT; }`;
    expect(findAgentClassViolations(ok, "ok.ts")).toEqual([]);
  });
});
