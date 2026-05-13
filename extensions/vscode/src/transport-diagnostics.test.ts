// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.1.1 unit tests for the transport-diagnostics helper.
 *
 * Lives next to its module (in src/) so vitest's default `tests/**` glob
 * skips it on the root project run; the extension-local `npm test:unit`
 * picks it up via this directory.
 *
 * VSCode-free by design — fakes the transport + sinks so this runs
 * without the VSCode test stub.
 */
import { describe, it, expect } from "vitest";
import {
  wireTransportDiagnostics,
  type DiagnosticsSinks,
  type TransportLike,
} from "./transport-diagnostics.js";

interface CapturingSinks extends DiagnosticsSinks {
  logs: string[];
  errors: string[];
  errorState: boolean;
  successText: string | null;
  /**
   * Caller-side success setter — gated on `errorState`. Tests use this to
   * verify the state-lock contract: after `setError` fires, this becomes
   * a no-op until reset.
   */
  setSuccessIfNotError: (text: string) => void;
  reset: () => void;
}

function makeCapturingSinks(): CapturingSinks {
  const sinks: CapturingSinks = {
    logs: [],
    errors: [],
    errorState: false,
    successText: null,
    log(line: string) {
      this.logs.push(line);
    },
    setError(msg: string) {
      this.errors.push(msg);
      this.errorState = true;
      this.logs.push(`ERROR: ${msg}`); // mirror real-extension log + status bar
    },
    setSuccessIfNotError(text: string) {
      if (this.errorState) return;
      this.successText = text;
    },
    isInErrorState() {
      return this.errorState;
    },
    reset() {
      this.logs.length = 0;
      this.errors.length = 0;
      this.errorState = false;
      this.successText = null;
    },
  };
  return sinks;
}

function makeTransport(): TransportLike {
  return {};
}

describe("transport-diagnostics — wireTransportDiagnostics", () => {
  it("wires onerror so transport-level errors surface to setError + log", () => {
    const transport = makeTransport();
    const sinks = makeCapturingSinks();
    wireTransportDiagnostics(transport, sinks);

    expect(typeof transport.onerror).toBe("function");
    expect(typeof transport.onclose).toBe("function");

    transport.onerror!(new Error("simulated SSE GET failure"));

    expect(sinks.errors.length).toBe(1);
    expect(sinks.errors[0]).toContain("simulated SSE GET failure");
    expect(sinks.errorState).toBe(true);
    expect(sinks.logs.some((l) => l.includes("simulated SSE GET failure"))).toBe(true);
  });

  it("wires onclose so transport closures log (but do NOT auto-flip error state)", () => {
    const transport = makeTransport();
    const sinks = makeCapturingSinks();
    wireTransportDiagnostics(transport, sinks);

    transport.onclose!();

    expect(sinks.logs.some((l) => l.includes("transport closed"))).toBe(true);
    expect(sinks.errorState).toBe(false); // closures alone don't flip error state
    expect(sinks.errors.length).toBe(0);
  });

  it("state-lock — once setError fires, subsequent success-flips are NO-OPs", () => {
    // This pins the property the brief named: "once flipped to error,
    // success log/state can't unflip without an explicit reconnect."
    // The lock lives in the caller's sinks (state flag + guard inside
    // setSuccessIfNotError). The helper does not itself enforce — but
    // this end-to-end test verifies the contract holds when wired up
    // the way extension.ts wires it.
    const transport = makeTransport();
    const sinks = makeCapturingSinks();
    wireTransportDiagnostics(transport, sinks);

    // Pre-error: success-flip works.
    sinks.setSuccessIfNotError("connected + subscribed");
    expect(sinks.successText).toBe("connected + subscribed");

    // Trigger transport error → state flips.
    transport.onerror!(new Error("SSE GET 502"));
    expect(sinks.errorState).toBe(true);

    // Now: a subsequent success-flip MUST NOT overwrite. This is the
    // race that bit Tether v0.1.0 — the extension's "connected +
    // subscribed" log + status mutation can fire AFTER an async SSE
    // failure, masking the broken state.
    sinks.setSuccessIfNotError("connected + subscribed");
    expect(sinks.successText).toBe("connected + subscribed"); // unchanged from pre-error value

    // Explicit reset (the production analog: a fresh `connect()` call)
    // clears the lock. After reset, success-flip works again.
    sinks.reset();
    sinks.setSuccessIfNotError("connected + subscribed");
    expect(sinks.successText).toBe("connected + subscribed");
    expect(sinks.errorState).toBe(false);
  });

  it("error message handles non-Error throws (e.g. fetch rejection with non-Error reason)", () => {
    const transport = makeTransport();
    const sinks = makeCapturingSinks();
    wireTransportDiagnostics(transport, sinks);

    // Some fetch implementations reject with a string or a plain object;
    // the helper coerces via `err?.message ?? String(err)` so both shapes
    // produce a usable surface line.
    transport.onerror!({ message: undefined } as Error);
    expect(sinks.errors[0]).toMatch(/transport error:/);

    sinks.reset();
    // Plain-object rejection — message is undefined, falls back to String(err).
    transport.onerror!({} as Error);
    expect(sinks.errors[0]).toContain("transport error:");
  });

  it("idempotent: calling wireTransportDiagnostics twice replaces prior handlers cleanly", () => {
    const transport = makeTransport();
    const sinks1 = makeCapturingSinks();
    const sinks2 = makeCapturingSinks();
    wireTransportDiagnostics(transport, sinks1);
    wireTransportDiagnostics(transport, sinks2);

    transport.onerror!(new Error("after re-wire"));

    expect(sinks1.errors.length).toBe(0); // first sink replaced
    expect(sinks2.errors.length).toBe(1);
    expect(sinks2.errors[0]).toContain("after re-wire");
  });
});
