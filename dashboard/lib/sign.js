// bot-relay-mcp Kanban board (Vercel) — HMAC verification.
// SPDX-License-Identifier: MIT
//
// The board is a DECISION SURFACE — Maxime reads it to decide what is real.
// An endpoint that accepts unsigned POSTs is one leaked URL away from writing
// false agent status / false pending items onto a board he trusts, and "the URL
// is a secret" is not authentication (a URL travels in config, logs and errors).
// So every push MUST carry a valid HMAC over the exact bytes, verified here with
// a constant-time compare. The relay side enforces the mirror of this: it refuses
// to push unsigned (see src/dashboard-push.ts). Unsigned / bad-signature pushes
// are rejected AND surfaced on the page — a silent 401 would make a misconfigured
// push look identical to an idle fleet.

import crypto from "node:crypto";

/** Canonical signature of `body` (Buffer|string) under `secret`: "sha256=<hex>". */
export function sign(body, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Verify an incoming push signature in constant time.
 * @param {Buffer|string} rawBody  the EXACT bytes received (pre-JSON-parse)
 * @param {string|undefined} headerValue  the X-Relay-Signature header
 * @param {string|undefined} secret  DASHBOARD_PUSH_SECRET on the receiver
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function verifySignature(rawBody, headerValue, secret) {
  if (!secret) {
    // Fail CLOSED: a receiver with no secret cannot authenticate anything, so it
    // must reject, not wave pushes through. (Mirror of the relay refusing to push.)
    return { ok: false, reason: "receiver has no DASHBOARD_PUSH_SECRET configured" };
  }
  if (!headerValue) {
    return { ok: false, reason: "missing X-Relay-Signature (unsigned push)" };
  }
  const expected = sign(rawBody, secret);
  const got = Buffer.from(String(headerValue));
  const want = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so gate on length first (the
  // length itself is not secret — the hex digest is a fixed width).
  if (got.length !== want.length) {
    return { ok: false, reason: "signature format/length mismatch" };
  }
  if (!crypto.timingSafeEqual(got, want)) {
    return { ok: false, reason: "signature mismatch (wrong secret or tampered body)" };
  }
  return { ok: true };
}

/** Constant-time string equality for the view token (not secret-length-revealing beyond width). */
export function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
