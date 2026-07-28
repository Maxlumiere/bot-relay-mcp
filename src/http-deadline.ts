// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * One owned deadline for a whole network exchange — CONNECT **and** BODY.
 *
 * ── THE DEFECT THIS REPLACES ─────────────────────────────────────────────────
 * The CLI's bounded-network calls were written as:
 *
 *     const t = setTimeout(() => ctrl.abort(), 5000);
 *     const res = await fetch(url, { signal: ctrl.signal });
 *     clearTimeout(t);              // <- fires when HEADERS arrive
 *     const body = await res.json(); // <- now completely unbounded
 *
 * `fetch()` resolves on RESPONSE HEADERS, not on a finished body. Clearing the
 * timer there leaves body consumption with no deadline at all, so a peer that
 * sends headers and then stalls hangs the command forever. MEASURED against a
 * real local HTTP server (not a stub): `relay pair` was still pending at 7003ms
 * against its own advertised 5000ms bound.
 *
 * The harm class is silence-as-failure in the operator's own tooling: `relay
 * pair` and `relay doctor` are exactly what someone runs when something is
 * already wrong, and a command that PROMISES a timeout and then hangs is worse
 * than one that never promised.
 *
 * ── WHY A RACE OWNS THE DEADLINE, AND ABORT IS ONLY THE POLITE HALF ──────────
 * A live `AbortSignal` does bound a stalled body read — MEASURED on Node
 * v24.13.0: AbortError at 1005ms against a 1000ms bound. So keeping the timer
 * alive across the body would be enough THERE.
 *
 * It is not enough as a GUARANTEE. `engines` allows `>=20.0.0` and CI exercises
 * Node 20, and that behaviour is a property of the bundled undici, which was not
 * verified on every supported version. Making correctness depend on it would be
 * an unverified runtime dependency dressed as a fix.
 *
 * So the `Promise.race` DECIDES the outcome and settles at `timeoutMs` whether
 * or not abort works; `controller.abort()` is the polite half that stops the
 * socket and body from leaking. Same principle as preferring a defect the
 * language refuses over one you police: do not rest a guarantee on behaviour you
 * cannot verify everywhere it must hold.
 *
 * ── DIRECTION OF FAILURE ─────────────────────────────────────────────────────
 * Erring EARLY (rejecting a slow-but-healthy peer) is a visible, retryable
 * error message. Erring LATE (hanging past the promise) is indistinguishable
 * from a wedged machine and is the failure this exists to remove. When in doubt
 * this errs early.
 * @fixture tests/v2-24-10-bounded-deadlines.test.ts "settles at the bound"
 */

/** Thrown when the owned deadline elapses. Distinguishable from a peer error. */
export class DeadlineExceededError extends Error {
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`${label} exceeded its ${timeoutMs}ms deadline`);
    this.name = "DeadlineExceededError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Run `fn` under a deadline that covers everything `fn` awaits — including body
 * consumption. Pass the supplied signal to `fetch`; read the body INSIDE `fn`.
 *
 * ```ts
 * const body = await withDeadline(5000, "hub health", async (signal) => {
 *   const res = await fetch(url, { signal });
 *   if (!res.ok) return { status: res.status, body: null };
 *   return { status: res.status, body: await res.json() };  // inside the bound
 * });
 * ```
 *
 * Reading a body AFTER this returns puts it back outside the deadline, which is
 * the original defect. Keep the consumption inside `fn`.
 */
export async function withDeadline<T>(
  timeoutMs: number,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Polite half: stop the socket/body leaking. The race below is what
      // actually settles the caller, so this failing is not a hang.
      try {
        controller.abort();
      } catch {
        /* abort must never mask the deadline rejection */
      }
      reject(new DeadlineExceededError(label, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    // Abort on every exit path, not just the timeout one: if `fn` threw for its
    // own reasons the request may still be in flight.
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  }
}
