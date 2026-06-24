// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.7 Tether Phase 5 — fast unit tests for setupSseKeepalive helper.
 *
 * Context: Phase 4a fixed the server-side cull (reaper closing
 * sessions with active SSE GETs). The post-Phase-4 smoke revealed
 * a SECOND disconnect class at ~2.5 min — daemon log was silent
 * during the entire window (no reap, no close, no error) but the
 * extension reported `SSE stream disconnected: TypeError: terminated`.
 * Root cause: VS Code's Electron-based fetch has its own idle
 * `response.body` timeout. Standard SSE pattern is for the server
 * to emit periodic `:keepalive\n\n` comment frames — comment lines
 * are spec-mandated to be ignored by clients, but they count as
 * recent byte activity to the fetch runtime.
 *
 * This file exercises the pure timer logic with a fake response
 * object. The cross-process integration test in
 * tests/v2-7-tether-reaper-idle-sse.test.ts (extended in Phase 5)
 * proves the keepalive actually flows over a real HTTP socket.
 */
import { describe, it, expect } from "vitest";
import { setupSseKeepalive } from "../src/transport/http.js";

interface FakeRes {
  write: (chunk: string) => boolean;
  once: (event: "close", listener: () => void) => unknown;
  writableEnded: boolean;
  // Test instrumentation:
  _writes: string[];
  _closeListeners: Array<() => void>;
  _triggerClose: () => void;
}

function fakeResponse(): FakeRes {
  const writes: string[] = [];
  const closeListeners: Array<() => void> = [];
  const res: FakeRes = {
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    once: (event, listener) => {
      if (event === "close") closeListeners.push(listener);
      return undefined;
    },
    writableEnded: false,
    _writes: writes,
    _closeListeners: closeListeners,
    _triggerClose: () => {
      for (const l of closeListeners) l();
    },
  };
  return res;
}

describe("v2.7 Tether Phase 5 — setupSseKeepalive (pure helper)", () => {
  it("intervalMs=0 → no timer, returns no-op cleanup, no writes ever fire", async () => {
    const res = fakeResponse();
    const cleanup = setupSseKeepalive(res, 0);
    await new Promise((r) => setTimeout(r, 60));
    expect(res._writes).toEqual([]);
    expect(res._closeListeners).toEqual([]); // helper didn't register any
    cleanup(); // safe to call
  });

  it("intervalMs<0 → treated as disabled (no timer, no writes)", async () => {
    const res = fakeResponse();
    setupSseKeepalive(res, -100);
    await new Promise((r) => setTimeout(r, 60));
    expect(res._writes).toEqual([]);
  });

  it("intervalMs=30 → write fires repeatedly with ': keepalive\\n\\n' content", async () => {
    const res = fakeResponse();
    const cleanup = setupSseKeepalive(res, 30);
    // Wait ~120 ms; expect at least 2 writes (timing is forgiving to CI).
    await new Promise((r) => setTimeout(r, 120));
    expect(res._writes.length).toBeGreaterThanOrEqual(2);
    expect(res._writes[0]).toBe(": keepalive\n\n");
    expect(res._writes.every((w) => w === ": keepalive\n\n")).toBe(true);
    cleanup();
  });

  it("res.close → cleanup fires automatically, no further writes after", async () => {
    const res = fakeResponse();
    setupSseKeepalive(res, 25);
    await new Promise((r) => setTimeout(r, 70)); // ~2-3 writes
    const writesBefore = res._writes.length;
    expect(writesBefore).toBeGreaterThanOrEqual(1);
    res._triggerClose();
    await new Promise((r) => setTimeout(r, 100));
    const writesAfter = res._writes.length;
    expect(writesAfter).toBe(writesBefore);
  });

  it("explicit cleanup() → idempotent: second invocation is a no-op", async () => {
    const res = fakeResponse();
    const cleanup = setupSseKeepalive(res, 25);
    await new Promise((r) => setTimeout(r, 70));
    const writesBefore = res._writes.length;
    cleanup();
    cleanup(); // calling twice MUST be safe (matches the close-handler-also-fires path)
    await new Promise((r) => setTimeout(r, 100));
    expect(res._writes.length).toBe(writesBefore);
  });

  it("writableEnded becomes true mid-tick → keepalive self-cancels without throwing", async () => {
    const res = fakeResponse();
    setupSseKeepalive(res, 25);
    await new Promise((r) => setTimeout(r, 35));
    expect(res._writes.length).toBeGreaterThanOrEqual(1);
    res.writableEnded = true;
    await new Promise((r) => setTimeout(r, 100));
    // After writableEnded flips, no further writes should accumulate.
    // The first tick after the flip may detect writableEnded and self-
    // cancel — we accept any non-growth.
    const writesAfter = res._writes.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(res._writes.length).toBe(writesAfter);
  });

  it("res.write that throws → keepalive self-cancels gracefully", async () => {
    const res = fakeResponse();
    let throwOnNext = false;
    res.write = (chunk: string) => {
      if (throwOnNext) throw new Error("simulated stream-torn-down");
      res._writes.push(chunk);
      return true;
    };
    setupSseKeepalive(res, 25);
    await new Promise((r) => setTimeout(r, 35));
    expect(res._writes.length).toBeGreaterThanOrEqual(1);
    throwOnNext = true;
    await new Promise((r) => setTimeout(r, 100));
    // Subsequent writes are blocked by the throw — and the helper
    // should have stopped the interval entirely. Re-arm without
    // throwing to prove the timer is truly gone.
    throwOnNext = false;
    const before = res._writes.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(res._writes.length).toBe(before);
  });
});

describe("v2.7 Tether Phase 5 — drift guard (RELAY_SSE_KEEPALIVE_MS env consumption)", () => {
  it("src/transport/http.ts reads RELAY_SSE_KEEPALIVE_MS and calls setupSseKeepalive", async () => {
    // Static guard: a future refactor that drops the env-read or the
    // wiring site would silently regress to "no keepalive" — same
    // observable symptom hit pre-Phase-5. An audit explicitly called
    // out this drift class.
    const fs = await import("fs");
    const path = await import("path");
    const { fileURLToPath } = await import("url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const httpTs = path.resolve(here, "..", "src", "transport", "http.ts");
    const body = fs.readFileSync(httpTs, "utf-8");
    expect(
      body,
      "src/transport/http.ts must read RELAY_SSE_KEEPALIVE_MS env — without it the keepalive interval can't be tuned or disabled.",
    ).toMatch(/RELAY_SSE_KEEPALIVE_MS/);
    expect(
      body,
      "src/transport/http.ts must invoke setupSseKeepalive(...) in the GET /mcp handler. Drift here is the bug class.",
    ).toMatch(/setupSseKeepalive\s*\(\s*res\s*,/);
  });
});
