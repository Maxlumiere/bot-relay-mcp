// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.3.0 PID-handshake — Tether wake resolution contract. The load-bearing case:
// a terminal named "zsh" (the alias-launch case that v0.2.2 could NOT wake) binds
// by PID with no rename. And the host-scoping invariant: an equal PID on a
// DIFFERENT host must never match (federation safety).

import { describe, it, expect } from "vitest";
import {
  resolveWakeTargetByPid,
  isHostScopedMember,
  parseAgentBinding,
  resolveAndWake,
  type PidNamedTerminal,
  type AgentPidBinding,
} from "./pid-binding.js";

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

describe("isHostScopedMember — single-pid primitive (cache fast-path re-validation)", () => {
  it("true when pid ∈ chain AND host ids match", () => {
    expect(isHostScopedMember(BINDING, "HOST-A", 55479)).toBe(true);
  });
  it("false on host mismatch (different-host equal PID)", () => {
    expect(isHostScopedMember({ hostShellPids: [55479], hostId: "HOST-B" }, "HOST-A", 55479)).toBe(false);
  });
  it("false when local host id is unknown", () => {
    expect(isHostScopedMember(BINDING, null, 55479)).toBe(false);
  });
  it("false for an undefined pid, an unbound pid, or an empty/absent chain", () => {
    expect(isHostScopedMember(BINDING, "HOST-A", undefined)).toBe(false);
    expect(isHostScopedMember(BINDING, "HOST-A", 99999)).toBe(false);
    expect(isHostScopedMember({ hostShellPids: [], hostId: "HOST-A" }, "HOST-A", 1)).toBe(false);
    expect(isHostScopedMember({ hostShellPids: null, hostId: "HOST-A" }, "HOST-A", 1)).toBe(false);
  });
});

describe("parseAgentBinding — discover_agents → AgentPidBinding", () => {
  const roster = {
    agents: [
      { name: "victra-build", host_shell_pids: [55566, 55479], host_id: "HOST-A" },
      { name: "codex", host_shell_pids: null, host_id: null },
    ],
  };
  it("extracts the named agent's chain + host_id", () => {
    expect(parseAgentBinding(roster, "victra-build")).toEqual({
      hostShellPids: [55566, 55479],
      hostId: "HOST-A",
    });
  });
  it("returns null fields for an agent that reported none", () => {
    expect(parseAgentBinding(roster, "codex")).toEqual({ hostShellPids: null, hostId: null });
  });
  it("returns null when the agent is not in the roster", () => {
    expect(parseAgentBinding(roster, "ghost")).toBeNull();
  });
  it("tolerates junk shapes (→ null fields / null), never throws", () => {
    expect(parseAgentBinding({ agents: [{ name: "x", host_shell_pids: "nope", host_id: 5 }] }, "x")).toEqual({
      hostShellPids: null,
      hostId: null,
    });
    expect(parseAgentBinding({ nope: true }, "x")).toBeNull();
    expect(parseAgentBinding(null, "x")).toBeNull();
  });
});

// --- resolveAndWake: the live-wake orchestration (codex R1 contract) ---

type FT = { name: string; pid: number | undefined };
const AGENT = "agent";

function harness(opts: {
  binding: AgentPidBinding;
  localHostId: string | null;
  open: FT[];
  cached?: FT;
}) {
  const woken: FT[] = [];
  const hints: string[] = [];
  const cache = new Map<string, FT>();
  if (opts.cached) cache.set(AGENT, opts.cached);
  let fetchCount = 0;
  const deps = {
    fetchBinding: async (): Promise<AgentPidBinding> => {
      fetchCount += 1;
      return opts.binding;
    },
    localHostId: opts.localHostId,
    openTerminals: (): readonly FT[] => opts.open,
    nameOf: (t: FT) => t.name,
    processIdOf: async (t: FT) => t.pid,
    cacheGet: (n: string) => cache.get(n),
    cacheSet: (n: string, t: FT) => {
      cache.set(n, t);
    },
    cacheClear: (n: string) => {
      cache.delete(n);
    },
    wake: (t: FT) => {
      woken.push(t);
    },
    hint: (m: string) => {
      hints.push(m);
    },
    log: () => {},
  };
  return { deps, woken, hints, cache, fetchCount: () => fetchCount };
}

describe("resolveAndWake — fresh binding, self-invalidating bound cache (R1)", () => {
  it("★ STALE-CACHE REGRESSION: after a same-name re-register, does NOT wake the old cached terminal — picks the new one", async () => {
    // Agent was bound to terminal pid 111; it re-registered with chain [222]
    // (same host). The FRESH binding is [222]; both terminals are still open.
    const oldTerm: FT = { name: "old", pid: 111 };
    const newTerm: FT = { name: "zsh", pid: 222 };
    const h = harness({
      binding: { hostShellPids: [222], hostId: "HOST-A" },
      localHostId: "HOST-A",
      open: [oldTerm, newTerm],
      cached: oldTerm, // the stale binding from before the re-register
    });
    await resolveAndWake(AGENT, h.deps);
    expect(h.woken).toEqual([newTerm]); // NOT the stale oldTerm(111)
    expect(h.cache.get(AGENT)).toBe(newTerm); // cache re-pointed
  });

  it("after re-register, if the new terminal isn't open, does NOT wake the stale one (no-match)", async () => {
    const oldTerm: FT = { name: "old", pid: 111 };
    const h = harness({
      binding: { hostShellPids: [222], hostId: "HOST-A" },
      localHostId: "HOST-A",
      open: [oldTerm], // only the stale terminal is open; 222 is gone
      cached: oldTerm,
    });
    await resolveAndWake(AGENT, h.deps);
    expect(h.woken).toEqual([]); // never wakes the stale terminal
    expect(h.cache.has(AGENT)).toBe(false); // cleared
    expect(h.hints).toHaveLength(1);
  });

  it("fast path: an unchanged binding + still-bound terminal wakes it directly", async () => {
    const term: FT = { name: "zsh", pid: 111 };
    const h = harness({
      binding: { hostShellPids: [111], hostId: "HOST-A" },
      localHostId: "HOST-A",
      open: [term, { name: "other", pid: 999 }],
      cached: term,
    });
    await resolveAndWake(AGENT, h.deps);
    expect(h.woken).toEqual([term]);
  });

  it("fetches the binding FRESH on EVERY wake (no stale-cache window)", async () => {
    const term: FT = { name: "zsh", pid: 111 };
    const h = harness({
      binding: { hostShellPids: [111], hostId: "HOST-A" },
      localHostId: "HOST-A",
      open: [term],
    });
    await resolveAndWake(AGENT, h.deps);
    await resolveAndWake(AGENT, h.deps);
    expect(h.fetchCount()).toBe(2);
  });

  it("no binding → name fallback wakes the agent-named terminal", async () => {
    const named: FT = { name: AGENT, pid: 777 };
    const h = harness({
      binding: { hostShellPids: null, hostId: null },
      localHostId: "HOST-A",
      open: [{ name: "zsh", pid: 111 }, named],
    });
    await resolveAndWake(AGENT, h.deps);
    expect(h.woken).toEqual([named]);
  });

  it(">1 host-scoped matches → ambiguous: nothing woken, a hint shown", async () => {
    const h = harness({
      binding: { hostShellPids: [111, 222], hostId: "HOST-A" },
      localHostId: "HOST-A",
      open: [{ name: "a", pid: 111 }, { name: "b", pid: 222 }],
    });
    await resolveAndWake(AGENT, h.deps);
    expect(h.woken).toEqual([]);
    expect(h.hints).toHaveLength(1);
  });
});
