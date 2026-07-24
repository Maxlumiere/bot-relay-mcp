// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.23.0 — direct unit coverage for relay_binding_live_elsewhere, the
 * sanctioned shared helper (hooks/_vault-helpers.sh) that the SessionStart LIVE
 * gate uses to tell a genuine RELAUNCH (stored chain's leaf pids are dead; only
 * shared VS Code ancestors survive, and those are in this hook's chain too) from
 * a still-live binding held by a CONCURRENT terminal (a live foreign pid outside
 * this hook's tree). The whole-chain intersection this replaced could not make
 * that distinction — the shared ancestors made every resummon look "still live".
 *
 * Contract: exit 0 = some stored pid is ALIVE and NOT in the caller's chain
 * (concurrent terminal → SKIP); exit 1 = otherwise (relaunch / nothing to
 * protect → re-register, the safe direction).
 *
 * End-to-end behavior is proven by the shipped-hook integration tests
 * (v2-11-0-hook-liveness-register R1/R2/R3); this file pins the set + liveness
 * edge cases. Test path matches the shipped path: the actual helper is sourced.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const HELPER = path.join(REPO_ROOT, "hooks", "_vault-helpers.sh");

/** Source the shipped helper and return the discriminator's exit status (0/1). */
function liveElsewhere(stored: string, mine: string): number {
  const script = `set -u; . '${HELPER}'; relay_binding_live_elsewhere "$1" "$2"`;
  const r = spawnSync("bash", ["-c", script, "bash", stored, mine], {
    encoding: "utf-8",
    timeout: 5000,
  });
  return r.status ?? -1;
}

describe("v2.23.0 — relay_binding_live_elsewhere (shipped helper)", () => {
  let live: ReturnType<typeof spawn>;
  let livePid = 0;

  beforeAll(() => {
    // A real, live process that is NOT an ancestor of the bash subprocess the
    // helper runs in — it stands in for a concurrent terminal's live shell.
    live = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    live.unref();
    livePid = live.pid ?? 0;
    expect(livePid).toBeGreaterThan(0);
  });

  afterAll(() => {
    try {
      if (livePid > 0) process.kill(livePid);
    } catch {
      /* already gone */
    }
  });

  it("(1) a live foreign pid (not in my chain) → 0 (skip: a concurrent terminal holds the binding)", () => {
    expect(liveElsewhere(`[${livePid}]`, `[${process.pid},1]`)).toBe(0);
  });

  it("(2) only dead sentinel pids → 1 (re-register: nothing live to protect)", () => {
    expect(liveElsewhere(`[999999]`, `[${process.pid},1]`)).toBe(1);
  });

  it("(3) dead leaves + a shared LIVE ancestor that IS in my chain → 1 (the resummon / shared-ancestor case)", () => {
    // process.pid models the persistent VS Code ancestor: passed as 'mine' it is
    // excluded, so only the dead leaves remain → nothing live-elsewhere.
    expect(liveElsewhere(`[999997,999998,${process.pid}]`, `[${process.pid},1]`)).toBe(1);
  });

  it("(4) a live foreign pid alongside shared ancestors → 0 (skip: still a concurrent terminal)", () => {
    expect(liveElsewhere(`[${livePid},${process.pid}]`, `[${process.pid},1]`)).toBe(0);
  });

  it("(5) exact-token compare — a stored pid that is only a SUBSTRING of a mine pid is still foreign", () => {
    // livePid is a prefix of `${livePid}0` in `mine`; a substring match would
    // wrongly exclude it. Exact compare keeps it foreign+live → 0.
    expect(liveElsewhere(`[${livePid}]`, `[${livePid}0,1]`)).toBe(0);
  });

  it("(6) empty / malformed stored → 1 (safe: re-register)", () => {
    expect(liveElsewhere("", `[${process.pid}]`)).toBe(1);
    expect(liveElsewhere("[]", `[${process.pid}]`)).toBe(1);
    expect(liveElsewhere("garbage", `[${process.pid}]`)).toBe(1);
  });

  it("(7) tolerant of loose formatting (bare ints / spaces)", () => {
    expect(liveElsewhere(`${livePid}`, `${process.pid} 1`)).toBe(0);
    expect(liveElsewhere(`999999 999998`, `${process.pid}`)).toBe(1);
  });
});
