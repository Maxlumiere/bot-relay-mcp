// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.2.3 (B) — Switch Agent candidate parsing. Tolerant of either
// discover_agents shape + junk entries so a relay tweak can't crash the picker.

import { describe, it, expect } from "vitest";
import { parseAgentNames, effectiveScope } from "./switch-agent.js";

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

describe("effectiveScope — Switch Agent writes where the value actually lives (R1)", () => {
  it("global when nothing is set anywhere", () => {
    expect(effectiveScope(undefined)).toBe("global");
    expect(effectiveScope({})).toBe("global");
    expect(effectiveScope({ workspaceValue: undefined, workspaceFolderValue: undefined })).toBe("global");
  });

  it("workspace when a workspace override exists (so a Global write wouldn't take effect)", () => {
    expect(effectiveScope({ workspaceValue: "victra-build" })).toBe("workspace");
  });

  it("workspaceFolder takes precedence over workspace", () => {
    expect(
      effectiveScope({ workspaceFolderValue: "codex", workspaceValue: "victra-build" }),
    ).toBe("workspaceFolder");
  });

  it("treats an empty-string override as a present value (still shadows Global)", () => {
    expect(effectiveScope({ workspaceValue: "" })).toBe("workspace");
  });
});
