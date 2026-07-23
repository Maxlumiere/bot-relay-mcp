// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * NEGATIVE CONTROLS for the Sentinel marker-evidence guard.
 *
 * Codex on #121: the focused suites passed 83/83 and still missed two ways the
 * guard lied, because every test asserted that it says YES when the path works.
 * None asserted that it says NO when the path is dead. A guard that cannot be
 * shown to refuse is not a guard — it is a constant.
 *
 * Both defects re-created the exact silent degradation this file exists to end:
 * new mail found by the 30s fallback poll while the watcher reported healthy.
 *
 *   (1) `!filename` counted as proof. fs.watch may fire with no filename; that
 *       is an unrelated directory change, or another agent's marker, or ours —
 *       indistinguishable. One anonymous event suppressed the announcement.
 *
 *   (2) The proof LATCHED for the process lifetime. One legitimate marker made
 *       it true forever, so if the marker writer later died, every later
 *       message was found by the poll and the degraded branch never fired.
 *       "A marker worked once" is not proof it worked for THIS message.
 *
 * These tests are written to FAIL against the pre-fix implementation.
 */
import { describe, it, expect } from "vitest";
import { createMarkerEvidence } from "../src/cli/watch.js";

const BASE = "victra-build.touch";

describe("proof requires a POSITIVELY IDENTIFIED marker", () => {
  it("an exact filename match IS proof (positive control — the guard must still say yes)", () => {
    // Without this, every other test here would pass on a guard hardwired to
    // false, which would be just as broken in the opposite direction.
    const e = createMarkerEvidence();
    expect(e.record(BASE, BASE)).toBe(true);
    expect(e.consume()).toBe(true);
  });

  it("DEFECT 1 — a null filename is NOT proof", () => {
    const e = createMarkerEvidence();
    expect(e.record(null, BASE)).toBe(false);
    expect(e.consume()).toBe(false);
  });

  it("an undefined filename is NOT proof", () => {
    const e = createMarkerEvidence();
    expect(e.record(undefined, BASE)).toBe(false);
    expect(e.consume()).toBe(false);
  });

  it("ANOTHER AGENT's marker is NOT proof for this agent", () => {
    // The watched directory holds every agent's marker, so this fires often.
    const e = createMarkerEvidence();
    expect(e.record("some-other-agent.touch", BASE)).toBe(false);
    expect(e.consume()).toBe(false);
  });

  it("an unrelated file in the marker directory is NOT proof", () => {
    const e = createMarkerEvidence();
    expect(e.record(".DS_Store", BASE)).toBe(false);
    expect(e.record("relay.db-wal", BASE)).toBe(false);
    expect(e.consume()).toBe(false);
  });

  it("a Buffer filename is NOT proof (fs.watch may hand back a Buffer)", () => {
    // Guards a subtle one: Buffer.toString() would equal BASE, so a loose
    // comparison could accept it. We require an actual string identity — an
    // encoding we did not ask for is a case we have not reasoned about, and
    // UNPROVEN is the safe answer.
    const e = createMarkerEvidence();
    expect(e.record(Buffer.from(BASE), BASE)).toBe(false);
    expect(e.consume()).toBe(false);
  });

  it("one anonymous event cannot suppress a later real degradation", () => {
    // THE DEFECT 1 SCENARIO END TO END. Anonymous event arrives, then the
    // marker path dies. The window must still report UNPROVEN so the caller
    // announces degraded.
    const e = createMarkerEvidence();
    e.record(null, BASE);
    e.record(undefined, BASE);
    expect(e.consume()).toBe(false);
  });
});

describe("proof is PER-WINDOW, not a process-lifetime latch", () => {
  it("DEFECT 2 — proof does not survive into the next window", () => {
    const e = createMarkerEvidence();
    e.record(BASE, BASE);
    expect(e.consume()).toBe(true); // window 1: marker worked
    expect(e.consume()).toBe(false); // window 2: nothing new — must NOT still claim proof
  });

  it("THE REGRESSION SCENARIO — a marker that worked once then died is caught", () => {
    // Window 1: healthy. The marker writer then dies. Every later window must
    // report UNPROVEN, which is what drives announceDegraded(). Before the fix
    // this returned true forever and the degraded branch was unreachable.
    const e = createMarkerEvidence();
    e.record(BASE, BASE);
    expect(e.consume()).toBe(true);

    for (let window = 2; window <= 5; window++) {
      expect(e.consume(), `window ${window} still claimed proof from a dead marker`).toBe(false);
    }
  });

  it("recovery — proof returns if the marker path comes back", () => {
    // The flag must be able to go both ways, or "degraded" would be terminal
    // and a recovered daemon would still read as broken.
    const e = createMarkerEvidence();
    expect(e.consume()).toBe(false);
    e.record(BASE, BASE);
    expect(e.consume()).toBe(true);
  });

  it("multiple markers in one window collapse to a single proof, then reset", () => {
    const e = createMarkerEvidence();
    e.record(BASE, BASE);
    e.record(BASE, BASE);
    e.record(BASE, BASE);
    expect(e.consume()).toBe(true);
    expect(e.consume()).toBe(false);
  });

  it("independent watchers do not share evidence", () => {
    // Guards against the state being hoisted back to module scope, which is
    // what made it a process-wide latch in the first place.
    const a = createMarkerEvidence();
    const b = createMarkerEvidence();
    a.record(BASE, BASE);
    expect(b.consume()).toBe(false);
    expect(a.consume()).toBe(true);
  });
});
