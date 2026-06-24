// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.2 — formatExecutorStatusBar contract tests.
 * Tests assert the exact contract, not a proxy: exact string
 * matches on the user-visible status bar text. Drift surfaces here.
 */
import { describe, it, expect } from "vitest";
import {
  formatExecutorStatusBar,
  mapExecutorStatus,
  type AgentLifecycleStatus,
} from "./format.js";

describe("v0.2 — formatExecutorStatusBar", () => {
  const baseArgs = {
    agentName: "build-agent",
    pendingCount: 0,
    status: "connected" as AgentLifecycleStatus,
  };

  it("(S1) connected + 0 pending — exact format", () => {
    expect(formatExecutorStatusBar(baseArgs)).toBe(
      "Tether: build-agent | 0 pending | connected",
    );
  });

  it("(S2) pendingCount is interpolated verbatim", () => {
    expect(
      formatExecutorStatusBar({ ...baseArgs, pendingCount: 7 }),
    ).toBe("Tether: build-agent | 7 pending | connected");
  });

  it("(S3) all five executor statuses render", () => {
    const cases: { lifecycle: AgentLifecycleStatus; status: string }[] = [
      { lifecycle: "idle", status: "disconnected" },
      { lifecycle: "spawning", status: "connecting" },
      { lifecycle: "connected", status: "connected" },
      { lifecycle: "crashed", status: "restarting" },
      { lifecycle: "restarting", status: "restarting" },
      { lifecycle: "error", status: "error" },
    ];
    for (const c of cases) {
      expect(
        formatExecutorStatusBar({ ...baseArgs, status: c.lifecycle }),
      ).toBe(`Tether: build-agent | 0 pending | ${c.status}`);
    }
  });

  it("(S4) different agent names route through unchanged", () => {
    expect(
      formatExecutorStatusBar({
        agentName: "codex",
        pendingCount: 3,
        status: "connected",
      }),
    ).toBe("Tether: codex | 3 pending | connected");
  });

  it("(S5) mapExecutorStatus mapping is exhaustive over the lifecycle enum", () => {
    expect(mapExecutorStatus("idle")).toBe("disconnected");
    expect(mapExecutorStatus("spawning")).toBe("connecting");
    expect(mapExecutorStatus("connected")).toBe("connected");
    expect(mapExecutorStatus("crashed")).toBe("restarting");
    expect(mapExecutorStatus("restarting")).toBe("restarting");
    expect(mapExecutorStatus("error")).toBe("error");
  });
});
