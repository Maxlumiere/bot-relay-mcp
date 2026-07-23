// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * MARKER OWNERSHIP — the daemon's outbox tail is the SOLE writer of wake markers.
 *
 * Why this file exists at all: before the ownership change, `sendMessage` touched
 * the marker IN-PROCESS, and `touchMarker` gates on RELAY_FILESYSTEM_MARKERS read
 * from whichever process executes the write. The daemon sets it; a stdio MCP
 * server does not. One call site, two behaviours, and the failure was invisible —
 * MCP-peer sends silently woke nobody while daemon sends worked, so watchers
 * merely looked "slow" (measured: 12ms event path vs a 3s poll fingerprint).
 *
 * Crucially, the ENTIRE root-cause behaviour was untested: the full suite passed
 * both before and after the marker call was removed from db.ts. These tests close
 * that hole, so a future refactor that relocates or drops the marker write fails
 * loudly instead of degrading quietly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-marker-own-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
const TEST_MARKER_DIR = path.join(os.tmpdir(), "bot-relay-marker-own-marker-" + process.pid);
process.env.RELAY_DB_PATH = TEST_DB_PATH;
process.env.RELAY_MARKER_DIR = TEST_MARKER_DIR;
process.env.RELAY_OUTBOX_POLL_MS = "20"; // tighten the tail so tests stay fast
delete process.env.RELAY_FILESYSTEM_MARKERS;

const { closeDb, getDb, registerAgent, sendMessage } = await import("../src/db.js");
const { markerPath } = await import("../src/filesystem-marker.js");
const { startOutboxTail, stopOutboxTail, _resetOutboxTailForTests } =
  await import("../src/outbox-tail.js");

/** Wait until `fn()` is true or the budget expires. Keeps tests non-flaky. */
async function until(fn: () => boolean, ms = 1500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return fn();
}

function markerExists(agent: string): boolean {
  const p = markerPath(agent);
  return p ? fs.existsSync(p) : false;
}

beforeEach(() => {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  fs.rmSync(TEST_MARKER_DIR, { recursive: true, force: true });
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TEST_DB_PATH, { force: true }); } catch { /* ignore */ }
  getDb(); // fresh schema
  _resetOutboxTailForTests();
});

afterEach(() => {
  stopOutboxTail();
  _resetOutboxTailForTests();
  delete process.env.RELAY_FILESYSTEM_MARKERS;
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TEST_MARKER_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("outbox tail owns marker writes", () => {
  it("writes the recipient's marker for a delivered message", async () => {
    process.env.RELAY_FILESYSTEM_MARKERS = "1";
    registerAgent("own-from", "role", []);
    registerAgent("own-to", "role", []);
    startOutboxTail();

    expect(markerExists("own-to")).toBe(false);
    sendMessage("own-from", "own-to", "hello", "normal");

    expect(await until(() => markerExists("own-to"))).toBe(true);
  });

  it("writes the marker for a from='system' message — the branch that never had one", async () => {
    // db.ts's system-sender branch never called touchMarker at all, so
    // infrastructure-originated mail woke nobody even in a marker-enabled
    // process. Tail ownership fixes that BY CONSTRUCTION: the system branch
    // writes inbox_events like every other producer, so it needs no special
    // case. This test is the proof of "by construction".
    process.env.RELAY_FILESYSTEM_MARKERS = "1";
    registerAgent("sys-to", "role", []);
    startOutboxTail();

    sendMessage("system", "sys-to", "infrastructure notice", "high");

    expect(await until(() => markerExists("sys-to"))).toBe(true);
  });

  it("does NOT write a marker when markers are disabled", async () => {
    delete process.env.RELAY_FILESYSTEM_MARKERS;
    registerAgent("off-from", "role", []);
    registerAgent("off-to", "role", []);
    startOutboxTail();

    sendMessage("off-from", "off-to", "quiet", "normal");

    // Give the tail real time to have done the wrong thing.
    await new Promise((r) => setTimeout(r, 250));
    expect(markerExists("off-to")).toBe(false);
  });

  it("marks only the RECIPIENT, never the sender (a sender wake is a self-wake)", async () => {
    process.env.RELAY_FILESYSTEM_MARKERS = "1";
    registerAgent("solo-from", "role", []);
    registerAgent("solo-to", "role", []);
    startOutboxTail();

    sendMessage("solo-from", "solo-to", "one way", "normal");

    expect(await until(() => markerExists("solo-to"))).toBe(true);
    expect(markerExists("solo-from")).toBe(false);
  });

  it("refreshes the marker on each new message so a watcher sees every arrival", async () => {
    process.env.RELAY_FILESYSTEM_MARKERS = "1";
    registerAgent("rep-from", "role", []);
    registerAgent("rep-to", "role", []);
    startOutboxTail();

    sendMessage("rep-from", "rep-to", "first", "normal");
    expect(await until(() => markerExists("rep-to"))).toBe(true);
    const first = fs.statSync(markerPath("rep-to")!).mtimeMs;

    await new Promise((r) => setTimeout(r, 30));
    sendMessage("rep-from", "rep-to", "second", "normal");

    expect(
      await until(() => fs.statSync(markerPath("rep-to")!).mtimeMs > first),
    ).toBe(true);
  });
});

describe("negative control — sendMessage must NOT write the marker itself", () => {
  it("with the tail STOPPED, a delivered message leaves no marker", async () => {
    // This is the load-bearing control. If someone reintroduces a touchMarker
    // call inside sendMessage, the marker appears here and this test fails —
    // which is the only way to catch the regression that started all of this.
    // Two writers is the bug; the count of writers is what we are protecting.
    process.env.RELAY_FILESYSTEM_MARKERS = "1";
    registerAgent("noTail-from", "role", []);
    registerAgent("noTail-to", "role", []);
    // deliberately NOT starting the outbox tail

    sendMessage("noTail-from", "noTail-to", "no writer running", "normal");

    await new Promise((r) => setTimeout(r, 250));
    expect(markerExists("noTail-to")).toBe(false);
  });

  it("...and the same message DOES get a marker once the tail runs (guard is live)", async () => {
    // Pairs with the control above: proves the previous test's `false` comes
    // from "no writer", not from a broken fixture that could never write.
    process.env.RELAY_FILESYSTEM_MARKERS = "1";
    registerAgent("late-from", "role", []);
    registerAgent("late-to", "role", []);

    sendMessage("late-from", "late-to", "queued before the writer started", "normal");
    await new Promise((r) => setTimeout(r, 150));
    expect(markerExists("late-to")).toBe(false);

    // The tail initialises its cursor to MAX(id) on start (it does not replay
    // history), so drive a fresh message to prove the live path writes.
    startOutboxTail();
    sendMessage("late-from", "late-to", "after the writer started", "normal");

    expect(await until(() => markerExists("late-to"))).toBe(true);
  });
});
