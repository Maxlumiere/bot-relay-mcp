// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0048 PR B (Codex #288 R2 #3, #4) — `relay watch` is every agent's wake
 * path, so EVERY failure after startup is said in the DEGRADED vocabulary the
 * watch Monitors grep for, never swallowed:
 *   #3 a mailbox READ that fails after a successful init: --once exits non-zero
 *      with a DEGRADED line; continuous mode announces the first failure of a
 *      streak, keeps announcing while it lasts, and says when reads recover;
 *   #4 an asynchronous FSWatcher 'error' (EIO) after marker-mode startup: a
 *      DEGRADED line and a fall back to polling, never an uncaught exception.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(path.join(REPO_ROOT, "node_modules", ".cache"), { recursive: true });
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(REPO_ROOT, "node_modules", ".cache", "adr0048w-")));

const ENV = ["HOME", "RELAY_DB_PATH", "RELAY_INSTANCE_ID", "RELAY_FILESYSTEM_MARKERS", "RELAY_WAKE_COVERAGE_STATUS_PATH"] as const;
let saved: Record<string, string | undefined>;
let err = "";
let out = "";
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  delete process.env.RELAY_INSTANCE_ID;
  delete process.env.RELAY_FILESYSTEM_MARKERS;
  process.env.HOME = HOME;
  process.env.RELAY_DB_PATH = path.join(HOME, "relay.db");
  process.env.RELAY_WAKE_COVERAGE_STATUS_PATH = path.join(HOME, "wc.json");
  err = "";
  out = "";
  vi.spyOn(process.stderr, "write").mockImplementation(((c: string | Uint8Array) => {
    err += String(c);
    return true;
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation(((c: string | Uint8Array) => {
    out += String(c);
    return true;
  }) as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock("../src/db.js");
  vi.resetModules();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("Codex #288 R2 #3 — a mailbox read failure after a successful init is DEGRADED, never swallowed", () => {
  it("--once: the read throws SQLITE_IOERR → DEGRADED + exit 1 (was: exit 0, no output)", async () => {
    vi.resetModules();
    vi.doMock("../src/db.js", async (orig) => ({
      ...(await orig<typeof import("../src/db.js")>()),
      peekMailboxVersion: () => {
        throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
      },
    }));
    const watch = await import("../src/cli/watch.js");
    const code = await watch.run(["a", "--once"]);
    expect(code, err).toBe(1);
    expect(err).toMatch(/\[sentinel\] DEGRADED — .*a.*: .*disk I\/O error/);
  });
  it("TWIN: --once with a healthy read → exit 0, no DEGRADED", async () => {
    vi.resetModules();
    const watch = await import("../src/cli/watch.js");
    const code = await watch.run(["a", "--once"]);
    expect(code, err).toBe(0);
    expect(err).not.toMatch(/DEGRADED/);
  });
});

describe("Codex #288 R2 #3 — continuous mode: a failure streak stays OBSERVABLE (makeMailboxCheck, the real closure)", () => {
  it("baseline ok, then 3 failed reads → DEGRADED on the first; repeats every READ_FAILURE_REPEAT_EVERY; recovery is said", async () => {
    const { makeMailboxCheck, READ_FAILURE_REPEAT_EVERY } = await import("../src/cli/watch.js");
    const lines: string[] = [];
    let fail = false;
    const m = makeMailboxCheck({
      agent: "a",
      read: () => {
        if (fail) throw new Error("SQLITE_IOERR: disk I/O error");
        return { total_unread_count: 0, epoch: "e", last_seq: 0 };
      },
      wake: () => {},
      write: (l) => lines.push(l),
    });
    expect(m.check()).toBe(true);
    fail = true;
    expect([m.check(), m.check(), m.check()]).toEqual([false, false, false]);
    expect(lines.filter((l) => /DEGRADED/.test(l))).toHaveLength(1);
    for (let i = 3; i < READ_FAILURE_REPEAT_EVERY; i++) m.check();
    expect(lines.filter((l) => /DEGRADED/.test(l)), "the streak is announced again").toHaveLength(2);
    expect(lines[1]).toMatch(new RegExp(`${READ_FAILURE_REPEAT_EVERY} consecutive failures`));
    fail = false;
    expect(m.check()).toBe(true);
    expect(lines.at(-1)).toMatch(/recovered/);
  });
  it("TWIN: healthy reads print nothing but wakes", async () => {
    const { makeMailboxCheck } = await import("../src/cli/watch.js");
    const lines: string[] = [];
    let unread = 0;
    const wakes: number[] = [];
    const m = makeMailboxCheck({ agent: "a", read: () => ({ total_unread_count: unread, epoch: "e", last_seq: 0 }), wake: (s) => wakes.push(s.total_unread_count), write: (l) => lines.push(l) });
    m.check();
    unread = 2;
    m.check();
    expect(lines).toEqual([]);
    expect(wakes).toEqual([2]);
  });
});

describe("Codex #288 R2 #4 — an async FSWatcher 'error' is DEGRADED + a fall back to polling, never uncaught (watchMarkerDir)", () => {
  it("an EIO error event after startup → DEGRADED line, the watcher closed, onFallback called, nothing thrown", async () => {
    const fake = Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as fs.FSWatcher;
    vi.spyOn(fs, "watch").mockImplementation((() => fake) as never);
    const { watchMarkerDir } = await import("../src/cli/watch.js");
    const lines: string[] = [];
    const onFallback = vi.fn();
    const w = watchMarkerDir({ agent: "a", dir: HOME, onEvent: () => {}, onFallback, write: (l) => lines.push(l) });
    expect(w).toBe(fake);
    expect(() => (fake as unknown as EventEmitter).emit("error", Object.assign(new Error("EIO: i/o error"), { code: "EIO" }))).not.toThrow();
    expect(lines.join("")).toMatch(/\[sentinel\] DEGRADED — the marker watcher for a failed \(EIO\): falling back to polling/);
    expect((fake as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledTimes(1);
  });
});
