// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0012 (Fork B) — ANCHOR-LIVENESS CONFORMANCE.
 *
 * The dead-anchor diagnostic (hooks/check-relay.sh) and the `relay
 * release-binding` gate (src/cli/release-binding.ts) MUST agree on whether a
 * binding's anchor is dead — otherwise the diagnostic tells the operator to run
 * a command that then REFUSES, a deadlock with both sides confident and neither
 * wrong on its own terms. The rule is implemented twice — bash
 * (`relay_anchor_liveness`) for the hook, TS (`anchorLivenessVerdict`) for the
 * CLI — and this file PINS them to the same verdict so a one-sided edit fails
 * the suite.
 *
 * Each fixture asserts THREE things: TS == expected, bash == expected, and TS ==
 * bash (the last catches a drift where both are "wrong" but still disagree).
 *
 * The final fixture is the load-bearing one: a dead anchor with a LIVE process
 * advertising RELAY_AGENT_NAME="<name>" in its argv. The gate must read DEAD
 * (anchor-only). `computeLivenessVerdict` — the PRESENCE verdict, argv-inclusive
 * — reads ALIVE for the same row. That divergence is the whole reason the gate
 * has its own verdict: if anyone swaps the gate back to computeLivenessVerdict
 * (they look like synonyms; one is even called "canonical"), that fixture flips
 * the gate to "alive" and this test fails. Presence asks "is there a process for
 * this agent?"; eligibility asks "is THIS binding's anchor dead?" — conflating
 * them is what produces the deadlock, and this row is the guard against it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import {
  anchorLivenessVerdict,
  processStartedAt,
  agentProcessAdvertised,
  _resetOwnHostIdForTests,
} from "../src/liveness.js";
import { computeLivenessVerdict } from "../src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const HELPER = path.join(REPO_ROOT, "hooks", "_vault-helpers.sh");

// A deterministic, machine-independent own-host GUID (pinned via the test seam),
// so neither side depends on the real machine id. The bash side takes own_host
// as an explicit arg; the TS side reads it from the pinned getOwnHostId().
const OWN = "conformance-own-host-guid-A";
const OTHER = "conformance-other-host-guid-B";

const LIVE_PID = process.pid; // this vitest process — guaranteed alive
const DEAD_PID = 2_147_483_646; // far above any real pid — guaranteed dead, no reuse
const LIVE_START = processStartedAt(LIVE_PID); // the real lstart token (LC_ALL=C pinned)

/**
 * Invoke the bash `relay_anchor_liveness` exactly as the hook does — source the
 * shipped helper and call it with positional args. Sourcing path + args are
 * passed as $1..$5 (never interpolated into the script text) so a repo path with
 * spaces is handled correctly.
 */
function bashAnchorVerdict(pid: string, start: string, rowHost: string, ownHost: string): string {
  const script = '. "$1"; relay_anchor_liveness "$2" "$3" "$4" "$5"';
  const r = spawnSync("bash", ["-c", script, "bash", HELPER, pid, start, rowHost, ownHost], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`bash relay_anchor_liveness failed (status ${r.status}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

interface Fixture {
  label: string;
  pid: number | null;
  start: string | null;
  rowHost: string;
  expected: "alive" | "dead" | "unverifiable";
}

const FIXTURES: Fixture[] = [
  { label: "dead anchor (pid gone) → dead", pid: DEAD_PID, start: null, rowHost: OWN, expected: "dead" },
  {
    label: "live pid + matching start → alive",
    pid: LIVE_PID,
    start: LIVE_START,
    rowHost: OWN,
    expected: "alive",
  },
  {
    label: "live pid + NO start anchor → alive (PID-liveness only; narrow-dead rule)",
    pid: LIVE_PID,
    start: null,
    rowHost: OWN,
    expected: "alive",
  },
  {
    label: "PID reuse: live pid + MISMATCHED start → dead",
    pid: LIVE_PID,
    start: "Mon Jan  1 00:00:00 2020",
    rowHost: OWN,
    expected: "dead",
  },
  {
    label: "cross-host row → unverifiable (never guess across the federation boundary)",
    pid: LIVE_PID,
    start: LIVE_START,
    rowHost: OTHER,
    expected: "unverifiable",
  },
  {
    label: "no anchor (agent_pid absent) → unverifiable",
    pid: null,
    start: null,
    rowHost: OWN,
    expected: "unverifiable",
  },
];

describe("ADR-0012 Fork B — anchor-liveness TS/bash conformance", () => {
  beforeEach(() => {
    _resetOwnHostIdForTests(OWN); // pin getOwnHostId() so TS uses OWN as its own-host
  });
  afterEach(() => {
    _resetOwnHostIdForTests(); // back to the real machine id
  });

  it("sanity: LIVE_START resolved (the ps probe works on this host)", () => {
    expect(LIVE_START, "processStartedAt(process.pid) returned null — ps -o lstart broken?").toBeTruthy();
  });

  for (const f of FIXTURES) {
    it(`${f.label} — TS == bash == expected`, () => {
      const tsVerdict = anchorLivenessVerdict({
        host_id: f.rowHost,
        agent_pid: f.pid,
        agent_pid_start: f.start,
      });
      const bashVerdict = bashAnchorVerdict(
        f.pid === null ? "" : String(f.pid),
        f.start ?? "",
        f.rowHost,
        OWN,
      );
      expect(tsVerdict, "TS anchorLivenessVerdict").toBe(f.expected);
      expect(bashVerdict, "bash relay_anchor_liveness").toBe(f.expected);
      expect(tsVerdict, "TS and bash must agree").toBe(bashVerdict);
    });
  }
});

describe("ADR-0012 Fork B — the gate is anchor-only, NOT presence (computeLivenessVerdict)", () => {
  let marker: ChildProcess | undefined;

  beforeEach(() => {
    _resetOwnHostIdForTests(OWN);
  });
  afterEach(() => {
    _resetOwnHostIdForTests();
    if (marker && !marker.killed) marker.kill("SIGKILL");
    marker = undefined;
  });

  it("dead anchor is NOT masked by an argv-advertised live process (gate must not use computeLivenessVerdict)", async () => {
    const name = "conf-argv-agent";
    // A live process advertising RELAY_AGENT_NAME="conf-argv-agent" in its argv —
    // exactly how bin/codex-relay launches a codex terminal (the fleet half that
    // would be made unrecoverable if the gate used the presence verdict). NOT
    // this test's own process.
    marker = spawn(process.execPath, ["-e", "setInterval(function(){}, 1e9)", `RELAY_AGENT_NAME="${name}"`], {
      stdio: "ignore",
    });
    for (let i = 0; i < 40 && !agentProcessAdvertised(name); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(agentProcessAdvertised(name), "marker process not visible in ps").toBe(true);

    const row = { name, host_id: OWN, agent_pid: DEAD_PID, agent_pid_start: null };

    // The GATE (anchor-only) is NOT fooled — the anchor pid is dead.
    expect(anchorLivenessVerdict(row), "TS gate must read DEAD despite the argv-advertised process").toBe("dead");
    // The bash twin agrees.
    expect(bashAnchorVerdict(String(DEAD_PID), "", OWN, OWN), "bash gate must read dead").toBe("dead");

    // The PRESENCE verdict IS fooled — this is the divergence the gate exists to
    // avoid. If someone reintroduces the argv scan into the gate, the assertion
    // above flips to "alive" and this test fails. This line pins that the two
    // functions genuinely diverge on this row (so the guard is not vacuous).
    expect(computeLivenessVerdict(row), "presence verdict is argv-inclusive → reads alive").toBe("alive");
  });
});
