// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.4.1 — HealthPoll unit tests.
 *
 * These drive the REAL HealthPoll that ships (extension.ts constructs one and
 * calls `.tick()` from its interval), not a proxy. The fetch is injected, so
 * the load-bearing parts — the `status === "ok"` check, the consecutive-
 * failure counter, the threshold, and the onUnhealthy handoff — are exercised
 * exactly as they run in production.
 *
 * The headline regression is (H4): an HTTP 200 whose body is NOT `status:"ok"`
 * (degraded / malformed) must NOT reset the counter and MUST fire onUnhealthy
 * after N consecutive — the exact hole this fix closes (the pre-fix code
 * trusted HTTP 200 alone, so a degraded/wrong-endpoint 200 read as healthy).
 */
import { describe, it, expect } from "vitest";
import { HealthPoll, type HealthProbe } from "./health-poll.js";

/** A HealthPoll wired to a scripted sequence of probe outcomes. */
function makeHarness(threshold: number, probes: Array<HealthProbe | "throw">) {
  let i = 0;
  const unhealthy: number[] = []; // tick index at which onUnhealthy fired
  let ticks = 0;
  const hp = new HealthPoll({
    threshold,
    fetchHealth: async () => {
      const p = probes[Math.min(i++, probes.length - 1)];
      if (p === "throw") throw new Error("network down");
      return p;
    },
    onUnhealthy: () => unhealthy.push(ticks),
  });
  return {
    hp,
    unhealthy,
    async tick() {
      ticks += 1;
      await hp.tick();
    },
  };
}

const OK: HealthProbe = { ok: true, bodyText: JSON.stringify({ status: "ok", version: "2.15.1" }) };
const DEGRADED: HealthProbe = { ok: true, bodyText: JSON.stringify({ status: "degraded" }) };
const MALFORMED: HealthProbe = { ok: true, bodyText: "<html>200 but not our /health</html>" };
const NON_2XX: HealthProbe = { ok: false, bodyText: null };

describe("HealthPoll.bodyIsOk — health, not mere reachability", () => {
  it("(H1) accepts ONLY a JSON body with status==='ok'", () => {
    expect(HealthPoll.bodyIsOk(JSON.stringify({ status: "ok" }))).toBe(true);
    expect(HealthPoll.bodyIsOk(JSON.stringify({ status: "ok", version: "x" }))).toBe(true);
  });

  it("(H2) rejects non-ok status, malformed JSON, missing status, and null body", () => {
    expect(HealthPoll.bodyIsOk(JSON.stringify({ status: "degraded" }))).toBe(false);
    expect(HealthPoll.bodyIsOk(JSON.stringify({ status: "error" }))).toBe(false);
    expect(HealthPoll.bodyIsOk(JSON.stringify({ notStatus: "ok" }))).toBe(false);
    expect(HealthPoll.bodyIsOk("not json at all")).toBe(false);
    expect(HealthPoll.bodyIsOk("")).toBe(false);
    expect(HealthPoll.bodyIsOk(null)).toBe(false);
    expect(HealthPoll.bodyIsOk(JSON.stringify("ok"))).toBe(false); // a bare string, not {status}
  });
});

describe("HealthPoll.tick — counter + threshold + handoff", () => {
  it("(H3) a healthy tick (2xx + status==='ok') keeps the counter at 0 and never fires onUnhealthy", async () => {
    const h = makeHarness(2, [OK, OK, OK]);
    await h.tick();
    await h.tick();
    await h.tick();
    expect(h.hp.failureCount).toBe(0);
    expect(h.unhealthy).toEqual([]);
  });

  it("(H4) REGRESSION — HTTP 200 with a non-ok/malformed body does NOT reset; fires onUnhealthy after N=2", async () => {
    // This is the exact hole: HTTP 200 read as healthy. Each 200-but-not-ok
    // body must COUNT AS A FAILURE.
    const h = makeHarness(2, [DEGRADED, MALFORMED]);
    await h.tick(); // failure 1 (200 degraded)
    expect(h.hp.failureCount).toBe(1);
    expect(h.unhealthy).toEqual([]);
    await h.tick(); // failure 2 (200 malformed) → threshold → handoff
    expect(h.unhealthy).toEqual([2]);
    // Counter reset after the handoff so the next window starts clean.
    expect(h.hp.failureCount).toBe(0);
  });

  it("(H5) a fetch rejection (network/timeout) and a non-2xx both count as failures", async () => {
    const h = makeHarness(2, ["throw", NON_2XX]);
    await h.tick(); // failure 1 (rejection)
    expect(h.hp.failureCount).toBe(1);
    await h.tick(); // failure 2 (non-2xx) → handoff
    expect(h.unhealthy).toEqual([2]);
  });

  it("(H6) a healthy tick BEFORE the threshold resets the counter (no spurious handoff)", async () => {
    const h = makeHarness(2, [DEGRADED, OK, DEGRADED]);
    await h.tick(); // failure 1
    expect(h.hp.failureCount).toBe(1);
    await h.tick(); // healthy → reset to 0
    expect(h.hp.failureCount).toBe(0);
    await h.tick(); // failure 1 again — NOT the 2nd consecutive
    expect(h.hp.failureCount).toBe(1);
    expect(h.unhealthy).toEqual([]); // never reached threshold consecutively
  });

  it("(H7) onUnhealthy fires exactly ONCE per threshold-run (counter resets, doesn't re-fire every tick)", async () => {
    const h = makeHarness(2, [DEGRADED, DEGRADED, DEGRADED]);
    await h.tick(); // 1
    await h.tick(); // 2 → fire
    await h.tick(); // 3 → counter was reset to 0, now 1 — no second fire yet
    expect(h.unhealthy).toEqual([2]);
    expect(h.hp.failureCount).toBe(1);
  });

  it("(H8) reset() zeroes the counter", async () => {
    const h = makeHarness(3, [DEGRADED, DEGRADED]);
    await h.tick();
    await h.tick();
    expect(h.hp.failureCount).toBe(2);
    h.hp.reset();
    expect(h.hp.failureCount).toBe(0);
  });
});
