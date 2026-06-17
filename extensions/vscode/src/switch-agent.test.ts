// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.2.3 (B) — Switch Agent candidate parsing. Tolerant of either
// discover_agents shape + junk entries so a relay tweak can't crash the picker.

import { describe, it, expect } from "vitest";
import {
  parseAgentNames,
  decideSwitchScope,
  applyAgentSwitch,
  type AgentSwitchPort,
  type InspectedSetting,
} from "./switch-agent.js";

describe("parseAgentNames — discover_agents → QuickPick candidates", () => {
  it("extracts names from the { agents: [...] } shape", () => {
    const raw = { agents: [{ name: "victra-build" }, { name: "codex" }] };
    expect(parseAgentNames(raw)).toEqual(["victra-build", "codex"]);
  });

  it("extracts names from a bare array shape", () => {
    const raw = [{ name: "victra-build" }, { name: "codex" }];
    expect(parseAgentNames(raw)).toEqual(["victra-build", "codex"]);
  });

  it("accepts an array of plain strings", () => {
    expect(parseAgentNames(["alice", "bob"])).toEqual(["alice", "bob"]);
  });

  it("excludes the currently-subscribed agent", () => {
    const raw = { agents: [{ name: "victra-build" }, { name: "codex" }] };
    expect(parseAgentNames(raw, "victra-build")).toEqual(["codex"]);
  });

  it("de-duplicates repeated names", () => {
    const raw = { agents: [{ name: "codex" }, { name: "codex" }] };
    expect(parseAgentNames(raw)).toEqual(["codex"]);
  });

  it("drops null / numeric / empty / whitespace entries without throwing", () => {
    const raw = { agents: [{ name: "codex" }, { name: "" }, { name: "   " }, null, 42, {}] };
    expect(parseAgentNames(raw)).toEqual(["codex"]);
  });

  it("returns [] for an unexpected shape (no agents array, not an array)", () => {
    expect(parseAgentNames({ foo: "bar" })).toEqual([]);
    expect(parseAgentNames(null)).toEqual([]);
    expect(parseAgentNames("nope")).toEqual([]);
  });
});

describe("decideSwitchScope — global/workspace only (R2)", () => {
  it("global when nothing is set anywhere", () => {
    expect(decideSwitchScope(undefined)).toEqual({ kind: "write", target: "global" });
    expect(decideSwitchScope({})).toEqual({ kind: "write", target: "global" });
  });

  it("workspace when a workspace override exists (a Global write wouldn't take effect)", () => {
    expect(decideSwitchScope({ workspaceValue: "victra-build" })).toEqual({
      kind: "write",
      target: "workspace",
    });
  });

  it("folder-override (no write) when a folder-level value is set — even alongside a workspace value", () => {
    expect(decideSwitchScope({ workspaceFolderValue: "codex", workspaceValue: "victra-build" })).toEqual({
      kind: "folder-override",
    });
  });

  it("an empty-string workspace value still counts as set → workspace", () => {
    expect(decideSwitchScope({ workspaceValue: "" })).toEqual({ kind: "write", target: "workspace" });
  });
});

// Fake WorkspaceConfiguration+UI port — records the write target/value and the
// toasts, so applyAgentSwitch's REAL obtain→write→readback→toast flow is tested
// (codex R2: prove the write+readback path, not just the scope decision).
// `effective: "echo"` makes readEffective return the just-written value (write
// took effect); a literal makes it return that (e.g. a shadow that didn't move).
function makePort(inspected: InspectedSetting | undefined, effective: string | undefined | "echo") {
  const updates: Array<{ target: "workspace" | "global"; value: string }> = [];
  const infos: string[] = [];
  const warns: string[] = [];
  let written: string | undefined;
  const port: AgentSwitchPort = {
    inspect: () => inspected,
    update: async (target, value) => {
      updates.push({ target, value });
      written = value;
    },
    readEffective: () => (effective === "echo" ? written : effective),
    info: (m) => infos.push(m),
    warn: (m) => warns.push(m),
  };
  return { port, updates, infos, warns };
}

describe("applyAgentSwitch — honest write+readback (R2)", () => {
  it("workspace path: writes to WORKSPACE, reads back, toasts success", async () => {
    const { port, updates, infos, warns } = makePort({ workspaceValue: "old" }, "echo");
    const outcome = await applyAgentSwitch("new-agent", port);
    expect(outcome).toBe("switched");
    expect(updates).toEqual([{ target: "workspace", value: "new-agent" }]);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain("new-agent");
    expect(warns).toHaveLength(0);
  });

  it("global path: writes to GLOBAL when nothing is set, reads back, toasts success", async () => {
    const { port, updates, infos } = makePort(undefined, "echo");
    const outcome = await applyAgentSwitch("new-agent", port);
    expect(outcome).toBe("switched");
    expect(updates).toEqual([{ target: "global", value: "new-agent" }]);
    expect(infos).toHaveLength(1);
  });

  it("folder override: does NOT write, warns honestly (never a silent shadow)", async () => {
    const { port, updates, infos, warns } = makePort({ workspaceFolderValue: "folder-agent" }, "echo");
    const outcome = await applyAgentSwitch("new-agent", port);
    expect(outcome).toBe("folder-override");
    expect(updates).toEqual([]);
    expect(infos).toHaveLength(0);
    expect(warns[0]).toMatch(/folder-level/i);
  });

  it("NO lying toast: when the effective value didn't move, warns instead of claiming success", async () => {
    // Wrote, but a higher-precedence setting still shadows it → effective != picked.
    const { port, updates, infos, warns } = makePort(undefined, "some-other-agent");
    const outcome = await applyAgentSwitch("new-agent", port);
    expect(outcome).toBe("shadowed");
    expect(updates).toEqual([{ target: "global", value: "new-agent" }]); // it DID attempt the write
    expect(infos).toHaveLength(0); // but did NOT claim success
    expect(warns[0]).toMatch(/could not switch/i);
  });
});
