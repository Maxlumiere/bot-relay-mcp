// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * REFUSE-TO-RUN-MUTE assertion (src/instance.ts).
 *
 * Context: a process on a multi-instance machine that resolves NO instance
 * silently falls back to the flat legacy `~/.bot-relay/relay.db`. It then starts
 * cleanly, registers, reports healthy, and reads an empty mailbox forever. That
 * is indistinguishable from "quiet inbox" and cost this project nine days of
 * invisible message loss.
 *
 * These tests assert the CONTRACT — that the ambiguous case is refused and the
 * unambiguous cases are not — and they exercise the real exported functions
 * against real temp HOMEs rather than mocking resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { assertInstanceResolution, describeInstanceResolution } from "../src/instance.js";

let tmpHome: string;
let savedHome: string | undefined;
let savedInstanceId: string | undefined;
let savedDbPath: string | undefined;
let savedAllow: string | undefined;

function makeHome(opts: { instances?: string[]; activeLink?: string }): void {
  const root = path.join(tmpHome, ".bot-relay");
  fs.mkdirSync(root, { recursive: true });
  for (const id of opts.instances ?? []) {
    fs.mkdirSync(path.join(root, "instances", id), { recursive: true });
  }
  if (opts.activeLink) {
    fs.symlinkSync(opts.activeLink, path.join(root, "active-instance"));
  }
}

/** Collect emitted announcements so we can assert on them. */
function capture(): { lines: string[]; emit: (m: string) => void } {
  const lines: string[] = [];
  return { lines, emit: (m: string) => lines.push(m) };
}

beforeEach(() => {
  savedHome = process.env.HOME;
  savedInstanceId = process.env.RELAY_INSTANCE_ID;
  savedDbPath = process.env.RELAY_DB_PATH;
  savedAllow = process.env.RELAY_ALLOW_LEGACY_FALLBACK;
  delete process.env.RELAY_INSTANCE_ID;
  delete process.env.RELAY_DB_PATH;
  delete process.env.RELAY_ALLOW_LEGACY_FALLBACK;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-instance-assert-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedInstanceId === undefined) delete process.env.RELAY_INSTANCE_ID; else process.env.RELAY_INSTANCE_ID = savedInstanceId;
  if (savedDbPath === undefined) delete process.env.RELAY_DB_PATH; else process.env.RELAY_DB_PATH = savedDbPath;
  if (savedAllow === undefined) delete process.env.RELAY_ALLOW_LEGACY_FALLBACK; else process.env.RELAY_ALLOW_LEGACY_FALLBACK = savedAllow;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("assertInstanceResolution — refuses the silent legacy fallback", () => {
  it("THROWS when instances exist but no instance resolves (the nine-day bug)", () => {
    makeHome({ instances: ["inst-a"] }); // instances present, NO active link, NO env
    const { emit } = capture();

    expect(() => assertInstanceResolution(emit)).toThrow(/REFUSING TO START/);
  });

  it("names the DB it would have used and both remedies, so the error is actionable", () => {
    makeHome({ instances: ["inst-a", "inst-b"] });
    const { emit } = capture();

    let msg = "";
    try { assertInstanceResolution(emit); } catch (e) { msg = (e as Error).message; }

    // The whole point is that the operator can act without reading source.
    expect(msg).toContain(path.join(tmpHome, ".bot-relay", "relay.db"));
    expect(msg).toContain("inst-a");
    expect(msg).toContain("inst-b");
    expect(msg).toContain("RELAY_INSTANCE_ID");
    expect(msg).toContain("relay use-instance");
    // It must say WHY, not just that it refused.
    expect(msg).toMatch(/EMPTY mailbox|silent message loss/i);
  });

  it("does NOT throw for a legitimate single-instance install (no instances dir)", () => {
    makeHome({}); // clean legacy machine
    const { lines, emit } = capture();

    expect(() => assertInstanceResolution(emit)).not.toThrow();
    // ...and it still announces, so the DB is never unidentified.
    expect(lines.join("\n")).toContain("legacy single-instance");
  });

  it("does NOT throw when the active-instance symlink resolves it (env absent)", () => {
    // This is Maxime's actual machine shape: no RELAY_INSTANCE_ID in the
    // process env, but ~/.bot-relay/active-instance covers it.
    makeHome({ instances: ["inst-a"], activeLink: "inst-a" });
    const { lines, emit } = capture();

    expect(() => assertInstanceResolution(emit)).not.toThrow();
    expect(lines.join("\n")).toContain("instance=inst-a");
  });

  it("does NOT throw when RELAY_INSTANCE_ID is set explicitly", () => {
    makeHome({ instances: ["inst-a"] });
    process.env.RELAY_INSTANCE_ID = "inst-a";
    const { lines, emit } = capture();

    expect(() => assertInstanceResolution(emit)).not.toThrow();
    expect(lines.join("\n")).toContain("instance=inst-a");
  });

  it("treats an explicit RELAY_DB_PATH as a deliberate override, never a fault", () => {
    makeHome({ instances: ["inst-a"] }); // would otherwise be the ambiguous case
    process.env.RELAY_DB_PATH = path.join(tmpHome, "explicit.db");
    const { lines, emit } = capture();

    expect(() => assertInstanceResolution(emit)).not.toThrow();
    expect(lines.join("\n")).toContain("RELAY_DB_PATH override");
    expect(describeInstanceResolution().legacyFallback).toBe(false);
  });

  it("RELAY_ALLOW_LEGACY_FALLBACK=1 downgrades refusal to a WARNING — but never to silence", () => {
    makeHome({ instances: ["inst-a"] });
    process.env.RELAY_ALLOW_LEGACY_FALLBACK = "1";
    const { lines, emit } = capture();

    expect(() => assertInstanceResolution(emit)).not.toThrow();
    const out = lines.join("\n");
    expect(out).toContain("WARNING (override active)");
    // Silence is the defect being fixed; the override must still be loud.
    expect(out).toContain("instances");
  });
});

describe("negative control — the assertion is load-bearing, not decorative", () => {
  it("the ambiguous shape really does resolve to the legacy flat DB (what we are refusing)", () => {
    makeHome({ instances: ["inst-a"] });

    const res = describeInstanceResolution();

    // Prove the danger is real: multi-instance machine, no instance resolved,
    // and the DB path silently points at the flat legacy file. If this ever
    // stops being true, the assertion above is guarding nothing and these
    // tests would otherwise still pass.
    expect(res.multiInstance).toBe(true);
    expect(res.instanceId).toBeNull();
    expect(res.dbPath).toBe(path.join(tmpHome, ".bot-relay", "relay.db"));
    expect(res.legacyFallback).toBe(true);
  });

  it("removing the contradiction removes the refusal (guard keys on the right condition)", () => {
    makeHome({ instances: ["inst-a"] });
    const { emit } = capture();
    expect(() => assertInstanceResolution(emit)).toThrow();

    // Same machine, one thing changed: the instance now resolves.
    fs.symlinkSync("inst-a", path.join(tmpHome, ".bot-relay", "active-instance"));
    expect(() => assertInstanceResolution(emit)).not.toThrow();
  });
});
