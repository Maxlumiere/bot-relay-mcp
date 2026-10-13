// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * killRecordedPid (tests/_helpers/recorded-pid.ts): a test signals only the pid it RECORDED, never 0 (its own process
 * group) or 1, whatever the file holds. The kill is INJECTED here, so nothing is ever signalled for real.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { killRecordedPid } from "./_helpers/recorded-pid.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recorded-pid-"));
const fileWith = (content: string) => {
  const f = path.join(dir, `pid-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(f, content);
  return f;
};
const spy = () => {
  const calls: Array<[number, string]> = [];
  return { calls, kill: (pid: number, sig: NodeJS.Signals) => void calls.push([pid, sig]) };
};

describe("killRecordedPid: a test signals only the pid it recorded, never 0 (the process group) or 1", () => {
  it("a recorded pid is signalled, exactly once, with the asked signal", () => {
    const s = spy();
    expect(killRecordedPid(fileWith("12345\n"), "SIGKILL", s.kill)).toBe(12345);
    expect(s.calls).toEqual([[12345, "SIGKILL"]]);
  });
  it("an EMPTY read (the truncate-then-write instant) signals nothing: Number('') would be 0, the whole group", () => {
    const s = spy();
    expect(killRecordedPid(fileWith(""), "SIGKILL", s.kill)).toBeNull();
    expect(killRecordedPid(fileWith("  \n"), "SIGKILL", s.kill)).toBeNull();
    expect(s.calls).toEqual([]);
  });
  it("0, 1, a negative pid (a group), and anything that is not all digits signal nothing", () => {
    const s = spy();
    for (const c of ["0", "1", "-1", "-4242", "12a", "4.2", "0x10", "1e3"]) expect(killRecordedPid(fileWith(c), "SIGKILL", s.kill), c).toBeNull();
    expect(s.calls).toEqual([]);
  });
  it("no file is not an error and signals nothing; a pid already gone is not an error", () => {
    const s = spy();
    expect(killRecordedPid(path.join(dir, "absent"), "SIGKILL", s.kill)).toBeNull();
    expect(s.calls).toEqual([]);
    const gone = () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };
    expect(killRecordedPid(fileWith("54321"), "SIGKILL", gone)).toBeNull();
  });
});
