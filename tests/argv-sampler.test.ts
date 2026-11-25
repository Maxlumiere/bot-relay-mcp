// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The argv sampler's own guarantees (tests/_helpers/argv-sampler.ts), driven with a substitute observer command:
 * a FAILED observation is never a sample; a hold that misses its deadline resolves false and no sample completing
 * after the release counts; every wait, including stop(), is bounded.
 */
import { describe, it, expect } from "vitest";
import { startArgvSampler } from "./_helpers/argv-sampler.js";

const WIN = process.platform === "win32";
const sh = (script: string): [string, string[]] => ["sh", ["-c", script]];

describe.skipIf(WIN)("the argv sampler", () => {
  it("a FAILING observer (non-zero exit) is never counted: no samples, no held samples, failures recorded, the hold resolves FALSE", async () => {
    const s = startArgvSampler("SECRET", { gapMs: 10, ps: sh("exit 3") });
    const ok = await s.waitForSamples(2, 600);
    await s.stop();
    expect(ok, "the handshake failed").toBe(false);
    expect(s.sampled).toBe(0);
    expect(s.heldSamples).toBe(0);
    expect(s.failures.length).toBeGreaterThan(0);
    expect(s.failures[0]).toMatch(/exited 3/);
  }, 10_000);

  it("an observer that cannot SPAWN is a failure, never a sample", async () => {
    const s = startArgvSampler("SECRET", { gapMs: 10, ps: ["/no/such/observer-binary", []] });
    const ok = await s.waitForSamples(1, 500);
    await s.stop();
    expect(ok).toBe(false);
    expect(s.sampled).toBe(0);
    expect(s.failures[0]).toMatch(/could not spawn/);
  }, 10_000);

  it("a hold that misses its deadline resolves FALSE, and a sample that STARTED inside it but COMPLETED after the release never counts", async () => {
    // Each observation takes ~700 ms. The hold opens during sample 1 (t≈100 ms, so sample 1 started outside it) with a
    // 1 s deadline; sample 2 STARTS inside the hold (t≈710 ms) and COMPLETES after the release (t≈1410 > 1100 ms).
    const s = startArgvSampler("SECRET", { gapMs: 10, ps: sh("sleep 0.7; echo line") });
    await new Promise((r) => setTimeout(r, 100));
    const ok = await s.waitForSamples(1, 1_000);
    await new Promise((r) => setTimeout(r, 700)); // sample 2 completes after the release
    await s.stop();
    expect(ok).toBe(false);
    expect(s.sampled, "both samples did complete").toBeGreaterThanOrEqual(2);
    expect(s.heldSamples, "sample 2 completed after the release: not held").toBe(0);
  }, 10_000);

  it("a hold is satisfied only by samples that STARTED inside it and completed while it was held", async () => {
    const s = startArgvSampler("SECRET", { gapMs: 10, ps: sh("echo plain; echo has-SECRET-inside") });
    const ok = await s.waitForSamples(3, 5_000);
    await s.stop();
    expect(ok).toBe(true);
    expect(s.heldSamples).toBeGreaterThanOrEqual(3);
    expect(s.leaked).toBe("has-SECRET-inside");
    expect(s.failures).toEqual([]);
  }, 10_000);

  it("a STUCK observer is killed at its sample timeout, recorded as a failure, and stop() settles (bounded)", async () => {
    const s = startArgvSampler("SECRET", { gapMs: 10, sampleTimeoutMs: 200, ps: sh("sleep 30") });
    await new Promise((r) => setTimeout(r, 400));
    const t0 = Date.now();
    await s.stop();
    expect(Date.now() - t0, "stop() is bounded").toBeLessThan(3_000);
    expect(s.failures.some((f) => /timed out/.test(f)), JSON.stringify(s.failures)).toBe(true);
    expect(s.sampled).toBe(0);
  }, 10_000);

  it("stop() during a hold settles that hold FALSE (exactly once)", async () => {
    const s = startArgvSampler("SECRET", { gapMs: 10, ps: sh("sleep 0.3; echo x") });
    const pending = s.waitForSamples(100, 20_000);
    await new Promise((r) => setTimeout(r, 100));
    await s.stop();
    expect(await pending).toBe(false);
  }, 10_000);
});
