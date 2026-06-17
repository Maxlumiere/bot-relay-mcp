// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.3.0 PID-handshake — Tether wake resolution contract. The load-bearing case:
// a terminal named "zsh" (the alias-launch case that v0.2.2 could NOT wake) binds
// by PID with no rename. And the host-scoping invariant: an equal PID on a
// DIFFERENT host must never match (federation safety).

import { describe, it, expect } from "vitest";
import { resolveWakeTargetByPid, type PidNamedTerminal } from "./pid-binding.js";

const t = (name: string, processId: number | undefined): PidNamedTerminal => ({ name, processId });

// Agent victra-build's registered ancestry chain + host.
const BINDING = { hostShellPids: [55566, 55479, 55465], hostId: "HOST-A" };

describe("resolveWakeTargetByPid — PID-primary, host-scoped", () => {
  it("★ binds the alias-launch terminal by PID even though it's named 'zsh' (NOT the agent name)", () => {
    const zsh = t("zsh", 55479); // controlling shell PID is in the chain
    const d = resolveWakeTargetByPid("victra-build", BINDING, "HOST-A", [zsh, t("codex", 12345)]);
    expect(d.kind).toBe("inject");
    if (d.kind === "inject") expect(d.terminal).toBe(zsh);
  });

  it("★ host-scoping: an equal PID on a DIFFERENT host does NOT match (falls back to name → no-match)", () => {
    // Same PID 55479, but the agent registered host_id HOST-B while this instance
    // is HOST-A → PID layer abstains; the terminal "zsh" doesn't name-match either.
    const d = resolveWakeTargetByPid(
      "victra-build",
      { hostShellPids: [55479], hostId: "HOST-B" },
      "HOST-A",
      [t("zsh", 55479)],
    );
    expect(d.kind).toBe("no-match");
  });

  it("abstains (→ name fallback) when this instance's host_id is unknown", () => {
    const d = resolveWakeTargetByPid("victra-build", BINDING, null, [t("zsh", 55479)]);
    expect(d.kind).toBe("no-match"); // can't host-scope → no PID match → name doesn't match
  });

  it(">1 terminals match the chain → ambiguous, never guess", () => {
    const d = resolveWakeTargetByPid("victra-build", BINDING, "HOST-A", [
      t("a", 55479),
      t("b", 55465),
    ]);
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") expect(d.matches).toHaveLength(2);
  });

  it("0 PID matches (terminal closed) → falls back to the name matcher", () => {
    // No terminal carries a chain PID, but one is named for the agent → name wins.
    const named = t("victra-build", 999);
    const d = resolveWakeTargetByPid("victra-build", BINDING, "HOST-A", [t("zsh", 111), named]);
    expect(d.kind).toBe("inject");
    if (d.kind === "inject") expect(d.terminal).toBe(named);
  });
});

describe("resolveWakeTargetByPid — name fallback (pre-handshake compatibility)", () => {
  const NO_BINDING = { hostShellPids: null, hostId: null };

  it("no registered PID chain → pure v0.2.2 name matcher (bare name)", () => {
    const term = t("victra-build", 777);
    const d = resolveWakeTargetByPid("victra-build", NO_BINDING, "HOST-A", [term, t("codex", 888)]);
    expect(d.kind).toBe("inject");
    if (d.kind === "inject") expect(d.terminal).toBe(term);
  });

  it("no registered PID chain + `Tether: <name>` convention still matches", () => {
    const term = t("Tether: victra-build", 777);
    const d = resolveWakeTargetByPid("victra-build", NO_BINDING, "HOST-A", [term]);
    expect(d.kind).toBe("inject");
    if (d.kind === "inject") expect(d.terminal).toBe(term);
  });

  it("empty PID chain ([]) is treated as no binding → name fallback", () => {
    const d = resolveWakeTargetByPid(
      "victra-build",
      { hostShellPids: [], hostId: "HOST-A" },
      "HOST-A",
      [t("zsh", 55479)],
    );
    expect(d.kind).toBe("no-match"); // no PID binding, no name match
  });
});
