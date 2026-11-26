// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE shared atomic replace (src/fs-replace.ts): on Windows a rename over a file another process holds open (a reader,
 * an antivirus or indexer) fails with EPERM, EACCES or EBUSY. Those, and ONLY on Windows, are retried briefly and
 * bounded; then the last error is rethrown, tagged `windowsOpenFile`, so each caller keeps its own named refusal.
 * POSIX never retries (EACCES there is a real permission fault). The platform and the rename are injected, so every
 * row runs on every OS; one row drives a REAL record writer (the owner endpoint) through the test seam.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { renameReplacingWithWindowsRetry, WINDOWS_REPLACE_WAITS_MS, __testSetReplaceDeps, type ReplaceError } from "../src/fs-replace.js";

/** A rename that fails `failures` times with `code`, then performs the real rename. */
function flakyRename(failures: number, code: string) {
  const calls: Array<[string, string]> = [];
  const rename = (from: string, to: string) => {
    calls.push([from, to]);
    if (calls.length <= failures) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
    fs.renameSync(from, to);
  };
  return { rename, calls };
}

let dir: string;
const fresh = () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fs-replace-"));
  fs.writeFileSync(path.join(dir, "src"), "new");
  fs.writeFileSync(path.join(dir, "dst"), "old");
};
afterEach(() => {
  __testSetReplaceDeps(null);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("renameReplacingWithWindowsRetry", () => {
  it("Windows: EPERM three times (a reader holding the target), then the rename succeeds: the target is replaced, after 25, 50 and 100 ms waits", () => {
    fresh();
    const f = flakyRename(3, "EPERM");
    const waits: number[] = [];
    renameReplacingWithWindowsRetry(path.join(dir, "src"), path.join(dir, "dst"), { platform: "win32", rename: f.rename, sleep: (ms) => waits.push(ms) });
    expect(fs.readFileSync(path.join(dir, "dst"), "utf-8")).toBe("new");
    expect(f.calls.length).toBe(4);
    expect(waits).toEqual([25, 50, 100]);
  });
  it("Windows: EPERM five times → the LAST error, tagged windowsOpenFile (the caller's named refusal), after exactly the bounded waits; the target untouched", () => {
    fresh();
    const f = flakyRename(5, "EPERM");
    const waits: number[] = [];
    let err: ReplaceError | null = null;
    try {
      renameReplacingWithWindowsRetry(path.join(dir, "src"), path.join(dir, "dst"), { platform: "win32", rename: f.rename, sleep: (ms) => waits.push(ms) });
    } catch (e) {
      err = e as ReplaceError;
    }
    expect(err?.code).toBe("EPERM");
    expect(err?.windowsOpenFile).toBe(true);
    expect(waits).toEqual([...WINDOWS_REPLACE_WAITS_MS]);
    expect(f.calls.length).toBe(WINDOWS_REPLACE_WAITS_MS.length + 1);
    expect(fs.readFileSync(path.join(dir, "dst"), "utf-8")).toBe("old");
  });
  it("Windows: EACCES and EBUSY are retried too", () => {
    for (const code of ["EACCES", "EBUSY"]) {
      fresh();
      const f = flakyRename(1, code);
      renameReplacingWithWindowsRetry(path.join(dir, "src"), path.join(dir, "dst"), { platform: "win32", rename: f.rename, sleep: () => {} });
      expect(fs.readFileSync(path.join(dir, "dst"), "utf-8"), code).toBe("new");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("POSIX: EACCES is NEVER retried (a real permission fault): thrown at once, windowsOpenFile false", () => {
    fresh();
    const f = flakyRename(1, "EACCES");
    const waits: number[] = [];
    let err: ReplaceError | null = null;
    try {
      renameReplacingWithWindowsRetry(path.join(dir, "src"), path.join(dir, "dst"), { platform: "linux", rename: f.rename, sleep: (ms) => waits.push(ms) });
    } catch (e) {
      err = e as ReplaceError;
    }
    expect(err?.code).toBe("EACCES");
    expect(err?.windowsOpenFile).toBe(false);
    expect(waits).toEqual([]);
    expect(f.calls.length).toBe(1);
  });
  it("Windows: another error code (ENOENT) is not retried, and not tagged as an open file", () => {
    fresh();
    const f = flakyRename(1, "ENOENT");
    let err: ReplaceError | null = null;
    try {
      renameReplacingWithWindowsRetry(path.join(dir, "src"), path.join(dir, "dst"), { platform: "win32", rename: f.rename, sleep: () => {} });
    } catch (e) {
      err = e as ReplaceError;
    }
    expect(err?.code).toBe("ENOENT");
    expect(err?.windowsOpenFile).toBe(false);
    expect(f.calls.length).toBe(1);
  });
});

describe("the REAL owner endpoint writer through the seam: success after retries, exhaustion, POSIX (Codex #452 R1 P2)", () => {
  const setup = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fs-replace-owner-"));
    const db = path.join(dir, "relay.db");
    fs.writeFileSync(db, "");
    return db;
  };
  const temps = () => fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));
  it("Windows: EPERM THREE times, then the rename succeeds → the record is written; no temp file left", async () => {
    const db = setup();
    const f = flakyRename(3, "EPERM");
    __testSetReplaceDeps({ platform: "win32", rename: f.rename, sleep: () => {} });
    const { writeOwnerEndpoint } = await import("../src/owner-endpoint.js");
    const file = writeOwnerEndpoint(db, 4343, "http", "inst-y");
    expect(f.calls.length).toBe(4);
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toMatchObject({ port: 4343, instance_id: "inst-y" });
    expect(temps()).toEqual([]);
  });
  it("Windows: EPERM FIVE times → the writer throws the last error (tagged), the PREVIOUS record is preserved, and no temp file is left", async () => {
    const db = setup();
    const { writeOwnerEndpoint, ownerEndpointPath } = await import("../src/owner-endpoint.js");
    writeOwnerEndpoint(db, 1111, "http", "inst-old"); // the previous record, written normally
    const before = fs.readFileSync(ownerEndpointPath(db), "utf-8");
    const f = flakyRename(5, "EPERM");
    __testSetReplaceDeps({ platform: "win32", rename: f.rename, sleep: () => {} });
    let err: ReplaceError | null = null;
    try {
      writeOwnerEndpoint(db, 2222, "http", "inst-new");
    } catch (e) {
      err = e as ReplaceError;
    }
    expect(err?.code).toBe("EPERM");
    expect(err?.windowsOpenFile).toBe(true);
    expect(f.calls.length).toBe(WINDOWS_REPLACE_WAITS_MS.length + 1);
    expect(fs.readFileSync(ownerEndpointPath(db), "utf-8"), "the destination is untouched").toBe(before);
    expect(temps(), "the writer removed its temp file").toEqual([]);
  });
  it("POSIX: EACCES → thrown at ONCE (never retried), the previous record preserved, no temp file left", async () => {
    const db = setup();
    const { writeOwnerEndpoint, ownerEndpointPath } = await import("../src/owner-endpoint.js");
    writeOwnerEndpoint(db, 1111, "http", "inst-old");
    const before = fs.readFileSync(ownerEndpointPath(db), "utf-8");
    const f = flakyRename(1, "EACCES");
    __testSetReplaceDeps({ platform: "linux", rename: f.rename, sleep: () => { throw new Error("POSIX never waits"); } });
    let err: ReplaceError | null = null;
    try {
      writeOwnerEndpoint(db, 2222, "http", "inst-new");
    } catch (e) {
      err = e as ReplaceError;
    }
    expect(err?.code).toBe("EACCES");
    expect(err?.windowsOpenFile).toBe(false);
    expect(f.calls.length).toBe(1);
    expect(fs.readFileSync(ownerEndpointPath(db), "utf-8")).toBe(before);
    expect(temps()).toEqual([]);
  });
});

describe("a REAL record writer through the seam: the owner endpoint record", () => {
  it("Windows-shaped EPERM twice on the record's rename → the record is written all the same, and no temp file is left", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fs-replace-owner-"));
    const db = path.join(dir, "relay.db");
    fs.writeFileSync(db, "");
    const f = flakyRename(2, "EPERM");
    __testSetReplaceDeps({ platform: "win32", rename: f.rename, sleep: () => {} });
    const { writeOwnerEndpoint } = await import("../src/owner-endpoint.js");
    const file = writeOwnerEndpoint(db, 4242, "http", "inst-x");
    expect(f.calls.length, "two refused renames, then the real one").toBe(3);
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toMatchObject({ port: 4242, instance_id: "inst-x" });
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
