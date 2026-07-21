// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.18.0 — Sentinel `relay watch`. Covers arg-parse, the total_unread_count
 * wake contract (--once), and the INSTANCE-DB TRAP: watch must read the ACTIVE
 * per-instance DB (resolveInstanceDbPath), NOT the legacy ~/.bot-relay/relay.db.
 * The DB-path assertion is enforced by DELIVERING mail to the throwaway
 * (RELAY_DB_PATH-resolved) DB and proving watch sees it — if watch read legacy,
 * the count would be 0 and these tests would fail.
 *
 * Continuous mode (fs.watch + interval) is exercised via --once here (it shares
 * the same check()/peekMailboxVersion path); the never-resolving watch loop is
 * not started in-process (it would hang the runner).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

describe("v2.18.0 — Sentinel `relay watch`", () => {
  let watchRun: (argv: string[]) => Promise<number>;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let tmpRoot: string;
  const savedDb = process.env.RELAY_DB_PATH;

  beforeEach(async () => {
    ({ run: watchRun } = await import("../src/cli/watch.js"));
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-"));
    process.env.RELAY_DB_PATH = path.join(tmpRoot, "relay.db"); // throwaway instance DB
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    if (savedDb === undefined) delete process.env.RELAY_DB_PATH;
    else process.env.RELAY_DB_PATH = savedDb;
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function wakeLines(): Array<Record<string, unknown>> {
    const text = outSpy.mock.calls.map((c) => String(c[0])).join("");
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((o): o is Record<string, unknown> => !!o && o.event === "wake");
  }

  it("--help → 0; missing agent → 1; bad --interval → 1", async () => {
    expect(await watchRun(["--help"])).toBe(0);
    expect(await watchRun([])).toBe(1);
    expect(await watchRun(["some-agent", "--interval", "0"])).toBe(1);
  });

  it("--once: existing unread mail → a wake line with the count (JSON)", async () => {
    const { initializeDb, registerAgent, sendMessage, closeDb } = await import("../src/db.js");
    await initializeDb();
    registerAgent("sentinel-sender", "agent", []);
    sendMessage("sentinel-sender", "sentinel-target", "hello", "normal");
    closeDb();

    const code = await watchRun(["sentinel-target", "--once", "--json"]);
    expect(code).toBe(0);
    const wakes = wakeLines();
    expect(wakes.length, "expected exactly one wake line").toBe(1);
    expect(wakes[0].agent).toBe("sentinel-target");
    expect(wakes[0].total_unread_count).toBe(1);
  });

  it("--once: no mail → no wake, exit 0", async () => {
    const { initializeDb, closeDb } = await import("../src/db.js");
    await initializeDb();
    closeDb();
    const code = await watchRun(["quiet-agent", "--once", "--json"]);
    expect(code).toBe(0);
    expect(wakeLines().length).toBe(0);
  });

  it("INSTANCE-DB TRAP: resolveInstanceDbPath honors RELAY_DB_PATH, never the legacy flat path", async () => {
    const { resolveInstanceDbPath } = await import("../src/instance.js");
    const resolved = resolveInstanceDbPath();
    expect(resolved).toBe(process.env.RELAY_DB_PATH);
    expect(resolved).not.toBe(path.join(os.homedir(), ".bot-relay", "relay.db"));
  });

  it("INSTANCE-DB TRAP: watch reads the resolved instance DB (mail delivered THERE is seen)", async () => {
    // If watch read the legacy ~/.bot-relay/relay.db instead of the resolved
    // path, these two messages would be invisible (count 0) and this fails.
    const { initializeDb, registerAgent, sendMessage, closeDb } = await import("../src/db.js");
    await initializeDb();
    registerAgent("s2", "agent", []);
    sendMessage("s2", "target2", "x", "normal");
    sendMessage("s2", "target2", "y", "normal");
    closeDb();

    await watchRun(["target2", "--once", "--json"]);
    const wakes = wakeLines();
    expect(wakes.length).toBe(1);
    expect(wakes[0].total_unread_count).toBe(2);
  });
});
