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
  resolveAgentBinding,
  resolveAndWake,
  type PidNamedTerminal,
  type AgentPidBinding,
} from "./pid-binding.js";

const t = (name: string, processId: number | undefined): PidNamedTerminal => ({ name, processId });

// Agent build-agent's registered ancestry chain + host.
const BINDING = { hostShellPids: [55566, 55479, 55465], hostId: "HOST-A" };

describe("resolveWakeTargetByPid — PID-primary, host-scoped", () => {
  it("★ binds the alias-launch terminal by PID even though it's named 'zsh' (NOT the agent name)", () => {
    const zsh = t("zsh", 55479); // controlling shell PID is in the chain
    const d = resolveWakeTargetByPid("build-agent", BINDING, "HOST-A", [zsh, t("codex", 12345)]);
    expect(d.kind).toBe("inject");
    if (d.kind === "inject") expect(d.terminal).toBe(zsh);
  });

  it("★ host-scoping: an equal PID on a DIFFERENT host does NOT match (falls back to name → no-match)", () => {
    // Same PID 55479, but the agent registered host_id HOST-B while this instance
    // is HOST-A → PID layer abstains; the terminal "zsh" doesn't name-match either.
    const d = resolveWakeTargetByPid(
      "build-agent",
      { hostShellPids: [55479], hostId: "HOST-B" },
      "HOST-A",
      [t("zsh", 55479)],
    );
    expect(d.kind).toBe("no-match");
  });

  it("abstains (→ name fallback) when this instance's host_id is unknown", () => {
    const d = resolveWakeTargetByPid("build-agent", BINDING, null, [t("zsh", 55479)]);
    expect(d.kind).toBe("no-match"); // can't host-scope → no PID match → name doesn't match
  });

  it(">1 terminals match the chain → ambiguous, never guess", () => {
    const d = resolveWakeTargetByPid("build-agent", BINDING, "HOST-A", [
      t("a", 55479),
      t("b", 55465),
    ]);
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") expect(d.matches).toHaveLength(2);
  });

  it("0 PID matches (terminal closed) → falls back to the name matcher", () => {
    // No terminal carries a chain PID, but one is named for the agent → name wins.
    const named = t("build-agent", 999);
    const d = resolveWakeTargetByPid("build-agent", BINDING, "HOST-A", [t("zsh", 111), named]);
    expect(d.kind).toBe("inject");
    if (d.kind === "inject") expect(d.terminal).toBe(named);
  });
});

describe("resolveWakeTargetByPid — name fallback (pre-handshake compatibility)", () => {
  const NO_BINDING = { hostShellPids: null, hostId: null };

  it("no registered PID chain → pure v0.2.2 name matcher (bare name)", () => {
    const term = t("build-agent", 777);
    const d = resolveWakeTargetByPid("build-agent", NO_BINDING, "HOST-A", [term, t("codex", 888)]);
    expect(d.kind).toBe("inject");
    if (d.kind === "inject") expect(d.terminal).toBe(term);
  });

  it("no registered PID chain + `Tether: <name>` convention still matches", () => {
    const term = t("Tether: build-agent", 777);
    const d = resolveWakeTargetByPid("build-agent", NO_BINDING, "HOST-A", [term]);
    expect(d.kind).toBe("inject");
    if (d.kind === "inject") expect(d.terminal).toBe(term);
  });

  it("empty PID chain ([]) is treated as no binding → name fallback", () => {
    const d = resolveWakeTargetByPid(
      "build-agent",
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
      { name: "build-agent", host_shell_pids: [55566, 55479], host_id: "HOST-A" },
      { name: "codex", host_shell_pids: null, host_id: null },
    ],
  };
  it("extracts the named agent's chain + host_id", () => {
    expect(parseAgentBinding(roster, "build-agent")).toEqual({
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

// --- v0.3.1 regressions. Matching is EXACT-pid only (the experimental
// ancestor/descendant tree-match was removed): the agent's chain includes the
// SHARED IDE ancestors every terminal in the window has (the editor + its
// terminal host), so a tree-walk would cross-wake a sibling terminal. Exact
// matching never touches those shared nodes. Models a real host:
//   Code(55447) → ptyHost(55465) → zsh(62903) → claude(63006) → hook(63025)
const HOST_CHAIN: AgentPidBinding = { hostShellPids: [63025, 63006, 62903, 55465, 55447], hostId: "HOST-A" };

describe("no cross-wake on shared IDE ancestors (exact-pid match)", () => {
  it("★ a SIBLING terminal (own shell ∉ chain, shares only ptyHost/Code) is NOT matched", () => {
    // own's shell 62903 ∈ chain; sibling's shell 80000 ∉ chain — it only shares
    // the high IDE ancestors 55465/55447, which exact matching never inspects.
    const own = t("zsh", 62903);
    const sibling = t("zsh", 80000);
    const d = resolveWakeTargetByPid("tacc", HOST_CHAIN, "HOST-A", [own, sibling]);
    expect(d.kind).toBe("inject");
    if (d.kind === "inject") expect(d.terminal).toBe(own);
  });

  it("★ two sibling terminals + no owner → no PID match, no false ambiguity", () => {
    // Neither 80000 nor 90000 is in the chain (they only share IDE ancestors).
    // Exact matching selects nothing → name fallback → no-match (NOT ambiguous).
    const d = resolveWakeTargetByPid("tacc", HOST_CHAIN, "HOST-A", [t("zsh", 80000), t("zsh", 90000)]);
    expect(d.kind).toBe("no-match");
  });

  it("★ cached sibling (pid ∉ fresh chain) is NOT woken — re-resolves to the exact owner", async () => {
    const sibling: FT = { name: "zsh", pid: 80000 }; // shares IDE ancestors only
    const own: FT = { name: "zsh", pid: 62903 }; // ∈ chain
    const h = harness({
      binding: HOST_CHAIN,
      localHostId: "HOST-A",
      open: [sibling, own],
      cached: sibling, // a stale/wrong cache pointing at the sibling
    });
    await resolveAndWake(AGENT, h.deps);
    expect(h.woken).toEqual([own]); // cache re-validation fails for the sibling → exact owner wins
    expect(h.cache.get(AGENT)).toBe(own);
  });
});

describe("parseAgentBinding tolerates the /api/snapshot shape (token-free fallback)", () => {
  it("reads host_shell_pids/host_id from a snapshot payload (extra per-agent fields ignored)", () => {
    // GET /api/snapshot returns the same {agents:[…]} roster with extra fields
    // (pending_count, status, …). parseAgentBinding must read the binding
    // identically so the auth-free fallback populates it when token-gated
    // discover_agents returns nothing.
    const snapshot = {
      agents: [
        {
          name: "tacc",
          role: "user",
          status: "online",
          pending_count: 2,
          unread_count: 1,
          host_shell_pids: [63025, 63006, 62903],
          host_id: "HOST-A",
        },
      ],
      messages: [],
      active_tasks: [],
    };
    expect(parseAgentBinding(snapshot, "tacc")).toEqual({
      hostShellPids: [63025, 63006, 62903],
      hostId: "HOST-A",
    });
  });
});

// --- v0.3.2 the discover → /api/snapshot fallback SEAM (codex re-audit). The
// static parse above isn't enough: assert the WIRING — discover fails (token-free
// Tether → AUTH_FAILED) → snapshot populates the binding → that binding drives a
// real wake to the EXACT owner. Must FAIL if the snapshot fallback is removed.
describe("resolveAgentBinding — discover → /api/snapshot fallback SEAM (v0.3.2)", () => {
  // The live /api/snapshot payload shape: roster + extra per-agent/global fields.
  const SNAPSHOT = {
    agents: [
      {
        name: "tacc",
        role: "user",
        status: "online",
        pending_count: 1,
        host_shell_pids: [63025, 63006, 62903],
        host_id: "HOST-A",
      },
    ],
    messages: [],
    active_tasks: [],
  };
  const OWNER: FT = { name: "zsh", pid: 62903 }; // shell ∈ chain; name never matches "tacc"

  it("★ FULL SEAM: token-free/FAILED discover → snapshot populates binding → EXACT owner wakes", async () => {
    const binding = await resolveAgentBinding("tacc", {
      // discover_agents returns AUTH_FAILED (no `agents` array) — the token-free
      // Tether case — so resolution MUST fall through to the snapshot.
      discover: async () => ({ success: false, error_code: "AUTH_FAILED" }),
      snapshot: async () => SNAPSHOT,
    });
    // (a) the seam produced the binding from the snapshot …
    expect(binding).toEqual({ hostShellPids: [63025, 63006, 62903], hostId: "HOST-A" });
    // (b) … and that binding drives a real wake to the EXACT owner terminal.
    const h = harness({ binding, localHostId: "HOST-A", open: [OWNER, { name: "codex", pid: 40000 }] });
    await resolveAndWake(AGENT, h.deps);
    // Delete the snapshot fallback → empty binding → name miss → woken=[] → this FAILS.
    expect(h.woken).toEqual([OWNER]);
  });

  it("discover succeeds → binding from the roster; the snapshot is NOT consulted", async () => {
    let snapshotCalls = 0;
    const binding = await resolveAgentBinding("tacc", {
      discover: async () => SNAPSHOT, // roster shape parses for discover too
      snapshot: async () => {
        snapshotCalls += 1;
        return null;
      },
    });
    expect(binding.hostShellPids).toEqual([63025, 63006, 62903]);
    expect(snapshotCalls).toBe(0); // primary path settled it — no wasted fetch
  });

  it("non-200 snapshot (fetcher → null) → empty binding → name fallback, no crash, no wrong-wake", async () => {
    const binding = await resolveAgentBinding("tacc", {
      discover: async () => null, // discover unavailable / failed
      snapshot: async () => null, // /api/snapshot non-200 → fetcher returns null
    });
    expect(binding).toEqual({ hostShellPids: null, hostId: null });
    const h = harness({ binding, localHostId: "HOST-A", open: [OWNER] });
    await resolveAndWake(AGENT, h.deps);
    expect(h.woken).toEqual([]); // no PID binding + name "zsh" ≠ agent → no wake (not a wrong wake)
  });
});
