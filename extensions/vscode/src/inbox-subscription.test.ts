// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.2.3 R1 — WakeGate + subscribeInbox unit contract (VSCode-free, fake MCP
// client). The real-daemon round-trip lives in tests/tether-reliable-wake.test.ts;
// this pins the seam's logic fast: catch-up fires once, no double-wake, the live
// notification handler routes through the gate, foreign URIs are ignored.

import { describe, it, expect, vi } from "vitest";
import { WakeGate, subscribeInbox, subscribeInboxes } from "./inbox-subscription.js";

type Notification = { params: { uri: string } };

/** Minimal stand-in for the MCP Client surface subscribeInbox uses. */
function makeFakeClient() {
  let handler: ((n: Notification) => Promise<void>) | undefined;
  const subscribed: string[] = [];
  return {
    setNotificationHandler: (_schema: unknown, h: (n: Notification) => Promise<void>) => {
      handler = h;
    },
    subscribeResource: async (arg: { uri: string }) => {
      subscribed.push(arg.uri);
    },
    /** Test helper — deliver a notification as the daemon would. */
    fire: async (uri: string) => {
      if (handler) await handler({ params: { uri } });
    },
    subscribed,
  };
}

const uri = (a: string) => `relay://inbox/${a}`;
const baseDeps = { applySnapshot: () => {}, showToast: () => {}, isInErrorState: () => false, log: () => {} };

describe("WakeGate", () => {
  it("wakes once for pending mail, then NOT again for the same newest message (no double-wake)", () => {
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    const snap = { pending_count: 2, last_message_at: "T1" };
    expect(gate.consider(snap, "x", true)).toBe(true);
    expect(gate.consider(snap, "x", true)).toBe(false);
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake).toHaveBeenCalledWith("x");
  });

  it("wakes again for newer mail only AFTER the injection LANDED and idle-evidence flushed it", () => {
    // Pre-ADR-0010 this test asserted a second wake while the first was still
    // unconsumed — the exact stacking defect. The contract now: an agent
    // OBSERVED IDLE cannot still hold our injection (the host submits queued
    // input at the turn boundary), so idleness re-arms — but ONLY once the
    // injection actually LANDED (codex #126 round 2: an idle snapshot during
    // the in-flight window is a stale read, not flush evidence).
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    expect(gate.consider({ pending_count: 1, last_message_at: "T1" }, "x", true)).toBe(true);
    expect(gate.consider({ pending_count: 2, last_message_at: "T2" }, "x", true)).toBe(false); // outstanding
    gate.markInjectionLanded(); // adapter.wake resolved — inject #1 actually submitted
    // Newer mail + IDLE observation on a LANDED injection → flush → re-wake.
    expect(
      gate.consider({ pending_count: 1, last_message_at: "T3" }, "x", true, {
        state: "idle",
        busyCoveredByHook: true,
      }),
    ).toBe(true);
    expect(onWake).toHaveBeenCalledTimes(2);
  });

  it("never wakes when autoInjectInbox is false", () => {
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    expect(gate.consider({ pending_count: 5, last_message_at: "T1" }, "x", false)).toBe(false);
    expect(onWake).not.toHaveBeenCalled();
  });
});

describe("WakeGate ADR-0010 state-routed wakes (the 14-stacked-wakes fix)", () => {
  const snap = (pending: number, at: string) => ({ pending_count: pending, last_message_at: at });
  const busyCovered = { state: "busy" as const, busyCoveredByHook: true };
  const busyUncovered = { state: "busy" as const, busyCoveredByHook: false };
  const idle = { state: "idle" as const, busyCoveredByHook: true };

  it("a BUSY hook-covered agent gets ZERO injections across a 14-message burst (the screenshot, made executable)", () => {
    // 2026-07-23: fourteen verbatim wake prompts stacked in the operator's
    // input box during a 1h10m turn. The old gate deduped per-message; the
    // route now is: busy + PostToolUse-covered → the hook owns delivery,
    // Tether has nothing to add. Not one, ZERO.
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    for (let i = 1; i <= 14; i++) {
      gate.consider(
        snap(i, `2026-07-23T16:${String(i).padStart(2, "0")}:00Z`),
        "victra-build",
        true,
        busyCovered,
      );
    }
    expect(onWake).not.toHaveBeenCalled();
  });

  it("…and the suppressed mail is NOT stranded: the poll-tick re-route wakes it on the first IDLE observation", () => {
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    gate.consider(snap(3, "T3"), "x", true, busyCovered); // busy turn — suppressed
    // Turn ends; hook never drained the last batch. Tick re-routes with idle.
    expect(gate.consider(snap(3, "T3"), "x", true, idle)).toBe(true);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("a BUSY agent WITHOUT hook coverage (codex-shaped) still gets exactly ONE injection, not fourteen", () => {
    // No PostToolUse driver covers it, so Tether must inject — but the
    // outstanding flag holds it to one queued wake that drains everything.
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    for (let i = 1; i <= 14; i++) {
      gate.consider(snap(i, `T${i}`), "cdx", true, busyUncovered);
    }
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("UNKNOWN state routes as inject-with-idempotency — never suppress behind a signal that may not resolve", () => {
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    for (let i = 1; i <= 5; i++) gate.consider(snap(i, `T${i}`), "x", true); // observed omitted = unknown
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("drain does NOT re-arm — pending==0 is not consumption (the falsified first design)", () => {
    // A busy agent's PostToolUse drain empties the inbox WITHOUT consuming the
    // queued injection. Re-arming on drain re-creates the fourteen-stack: one
    // injection per drain cycle.
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    expect(gate.consider(snap(1, "T1"), "x", true)).toBe(true); // inject #1 (unknown state)
    expect(gate.consider(snap(0, "T1"), "x", true)).toBe(false); // hook drained it
    expect(gate.consider(snap(1, "T2"), "x", true)).toBe(false); // STILL outstanding — no stack
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("suppression does NOT advance the watermark — busy-era mail still counts as new once idle", () => {
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    gate.consider(snap(1, "T1"), "x", true, idle); // wake, mark=T1
    gate.markInjectionLanded(); // inject #1 landed
    gate.consider(snap(2, "T2"), "x", true, busyCovered); // suppressed — mark must STAY T1
    // Idle again with T2 still the newest: never woken for → must wake now.
    expect(gate.consider(snap(2, "T2"), "x", true, idle)).toBe(true);
    expect(onWake).toHaveBeenCalledTimes(2);
  });

  it("clearOutstanding() — loss evidence (closed terminal / failed injection) re-arms immediately, no TTL wait", () => {
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    expect(gate.consider(snap(1, "T1"), "x", true)).toBe(true);
    expect(gate.consider(snap(2, "T2"), "x", true)).toBe(false); // outstanding
    gate.clearOutstanding(); // the injected-into terminal closed
    expect(gate.consider(snap(3, "T3"), "x", true)).toBe(true);
    expect(onWake).toHaveBeenCalledTimes(2);
  });

  it("failed delivery of the SAME still-pending mail recovers on the next poll tick — not silence-until-newer-mail (codex #126)", () => {
    // The bug: clearOutstanding cleared the flag but NOT the watermark, so on
    // every re-route of the same still-pending T1, decideWake saw
    // T1 === lastWokenAt and returned false — the mail stayed silent
    // INDEFINITELY, not "one tick". codex's compiled repro: first=true, then
    // clearOutstanding(), same still-pending T1 retry=false. Loss evidence must
    // roll the mark back so the retry wakes.
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    expect(gate.consider(snap(1, "T1"), "a", true)).toBe(true); // wake for T1
    gate.clearOutstanding(); // injection did NOT land (no target / adapter reject)
    // SAME T1, still pending, next route tick → must re-wake (was false pre-fix).
    expect(gate.consider(snap(1, "T1"), "a", true)).toBe(true);
    expect(onWake).toHaveBeenCalledTimes(2);
  });

  it("a LANDED wake (idle flush) does NOT roll the mark back — the same mail is not re-woken", () => {
    // The other half of the contract: flush evidence (idle on a LANDED wake)
    // means the injection WAS submitted, so the mark must STAY — otherwise every
    // idle observation would re-wake already-delivered mail. Distinguishing
    // landed from lost is the whole fix; this pins the "landed" side so a future
    // rollback change can't over-reach into successful deliveries.
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    expect(gate.consider(snap(1, "T1"), "a", true)).toBe(true); // wake for T1 (in-flight)
    gate.markInjectionLanded(); // adapter.wake resolved — submitted
    // Agent observed idle on a LANDED injection → flushed + consumed; same
    // still-pending T1 must NOT re-wake.
    expect(gate.consider(snap(1, "T1"), "a", true, idle)).toBe(false);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("a premature idle does NOT flush an IN-FLIGHT (not-yet-landed) injection — no re-stacking (codex #126 round 2)", () => {
    // onWake only SCHEDULES the async inject (binding fetch + terminal resolve +
    // adapter submit run after). An idle snapshot in that window is a stale read
    // from before our keystroke — flushing it would let a second inject fire and
    // rebuild the stack. codex's compiled probe: two consecutive idle snapshots
    // with newer mail produced {first:true, second:true} while wake #1 was still
    // in flight. Idle is flush evidence ONLY after the delivery ack.
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    expect(gate.consider(snap(1, "T1"), "a", true, idle)).toBe(true); // inject #1 scheduled (in-flight)
    // #1 has NOT landed; a burst / poll re-observes idle → must NOT re-inject.
    expect(gate.consider(snap(2, "T2"), "a", true, idle)).toBe(false);
    expect(gate.consider(snap(3, "T3"), "a", true, idle)).toBe(false);
    expect(onWake).toHaveBeenCalledTimes(1);
    // Once #1 actually lands, the next idle IS valid flush evidence → re-wake.
    gate.markInjectionLanded();
    expect(gate.consider(snap(3, "T3"), "a", true, idle)).toBe(true);
    expect(onWake).toHaveBeenCalledTimes(2);
  });

  it("TTL backstop — an outstanding older than the TTL re-wakes (unobservable loss), a fresh one suppresses", () => {
    let nowMs = 1_000_000;
    const onWake = vi.fn();
    const gate = new WakeGate(onWake, { outstandingTtlMs: 10_000, now: () => nowMs });
    expect(gate.consider(snap(1, "T1"), "x", true)).toBe(true);
    nowMs += 9_999; // inside the TTL — still suppressed
    expect(gate.consider(snap(2, "T2"), "x", true)).toBe(false);
    nowMs += 2; // past the TTL — backstop re-arms
    expect(gate.consider(snap(3, "T3"), "x", true)).toBe(true);
    expect(onWake).toHaveBeenCalledTimes(2);
  });

  it("window reload (fresh gate) re-wakes still-pending mail — A1 preserved", () => {
    const onWake = vi.fn();
    const first = new WakeGate(onWake);
    first.consider(snap(1, "T1"), "x", true);
    // reload: module state is recreated → a brand-new gate, mail still pending
    const second = new WakeGate(onWake);
    expect(second.consider(snap(1, "T1"), "x", true)).toBe(true);
    expect(onWake).toHaveBeenCalledTimes(2);
  });
});

describe("subscribeInbox", () => {
  it("subscribes to the agent's inbox URI and fires a catch-up wake when mail is already pending", async () => {
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    const client = makeFakeClient();
    await subscribeInbox({
      client: client as never,
      agentName: "alice",
      autoInjectInbox: true,
      buildInboxUri: uri,
      readSnapshot: async () => ({ pending_count: 1, last_message_at: "T1" }),
      wakeGate: gate,
      ...baseDeps,
    });
    expect(client.subscribed).toEqual([uri("alice")]);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("routes a LIVE notification for the subscribed URI through the gate; ignores other URIs", async () => {
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    const client = makeFakeClient();
    let snap = { pending_count: 0, last_message_at: null as string | null };
    await subscribeInbox({
      client: client as never,
      agentName: "bob",
      autoInjectInbox: true,
      buildInboxUri: uri,
      readSnapshot: async () => snap,
      wakeGate: gate,
      ...baseDeps,
    });
    expect(onWake).not.toHaveBeenCalled(); // nothing pending at subscribe

    snap = { pending_count: 1, last_message_at: "T1" };
    await client.fire(uri("bob")); // real message arrives
    expect(onWake).toHaveBeenCalledTimes(1);

    await client.fire(uri("someone-else")); // foreign inbox → ignored
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("does not wake on the catch-up path when the error state is set", async () => {
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    const client = makeFakeClient();
    await subscribeInbox({
      client: client as never,
      agentName: "carol",
      autoInjectInbox: true,
      buildInboxUri: uri,
      readSnapshot: async () => ({ pending_count: 3, last_message_at: "T1" }),
      wakeGate: gate,
      applySnapshot: () => {},
      showToast: () => {},
      isInErrorState: () => true, // state-lock
      log: () => {},
    });
    expect(onWake).not.toHaveBeenCalled();
  });
});

describe("subscribeInboxes (multi-agent watch-all)", () => {
  const agent = (name: string, gate: WakeGate, primary = false) => ({
    agentName: name,
    autoInjectInbox: true,
    wakeGate: gate,
    primary,
  });

  it("subscribes to EACH agent's inbox and catch-up-wakes each via its OWN gate", async () => {
    const wakeA = vi.fn();
    const wakeB = vi.fn();
    const client = makeFakeClient();
    await subscribeInboxes({
      client: client as never,
      agents: [agent("alice", new WakeGate(wakeA), true), agent("bob", new WakeGate(wakeB))],
      buildInboxUri: uri,
      readSnapshot: async () => ({ pending_count: 1, last_message_at: "T1" }),
      ...baseDeps,
    });
    expect([...client.subscribed].sort()).toEqual([uri("alice"), uri("bob")].sort());
    expect(wakeA).toHaveBeenCalledTimes(1);
    expect(wakeB).toHaveBeenCalledTimes(1); // each agent woken independently
  });

  it("a live notification wakes ONLY the matching agent (dispatch by URI)", async () => {
    const wakeA = vi.fn();
    const wakeB = vi.fn();
    const client = makeFakeClient();
    let snap = { pending_count: 0, last_message_at: null as string | null };
    await subscribeInboxes({
      client: client as never,
      agents: [agent("alice", new WakeGate(wakeA), true), agent("bob", new WakeGate(wakeB))],
      buildInboxUri: uri,
      readSnapshot: async () => snap,
      ...baseDeps,
    });
    snap = { pending_count: 1, last_message_at: "T1" };
    await client.fire(uri("bob")); // only bob's inbox changed
    expect(wakeB).toHaveBeenCalledTimes(1);
    expect(wakeA).not.toHaveBeenCalled(); // alice's terminal NOT woken — no cross-wake
  });

  it("only the PRIMARY agent's snapshot drives the shared status bar", async () => {
    const applied: number[] = [];
    const client = makeFakeClient();
    let snap = { pending_count: 0, last_message_at: null as string | null };
    await subscribeInboxes({
      client: client as never,
      agents: [agent("alice", new WakeGate(() => {}), true), agent("bob", new WakeGate(() => {}))],
      buildInboxUri: uri,
      readSnapshot: async () => snap,
      applySnapshot: (s) => applied.push(s.pending_count),
      showToast: () => {},
      isInErrorState: () => false,
      log: () => {},
    });
    applied.length = 0; // ignore the prime
    snap = { pending_count: 5, last_message_at: "T1" };
    await client.fire(uri("bob")); // non-primary → no status-bar paint
    expect(applied).toEqual([]);
    await client.fire(uri("alice")); // primary → paints
    expect(applied).toEqual([5]);
  });
});
