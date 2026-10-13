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
import { killRecordedPid, parentPidOf, parsePid, signalParsedPid } from "./_helpers/recorded-pid.js";

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

describe("parsePid, the ONE parser for a pid read as text: digits AND > 1, from one captured string", () => {
  it("accepts an all-digits pid > 1 (surrounding whitespace allowed: ps pads, echo appends a newline)", () => {
    expect(parsePid("12345")).toBe(12345);
    expect(parsePid("  4242\n")).toBe(4242);
  });
  it("refuses the empty read (Number('') is 0: the group), 0, 1, a negative (a group), and anything not all digits", () => {
    for (const c of ["", "  \n", "0", "1", "-1", "-4242", "12a", "4.2", "0x10", "1e3", "12 34", "99999999999999999999"]) expect(parsePid(c), JSON.stringify(c)).toBeNull();
    expect(parsePid(null)).toBeNull();
    expect(parsePid(undefined)).toBeNull();
  });
});

describe("parentPidOf + signalParsedPid: `ps -o ppid=` printing nothing (the process is gone) never becomes a signal to 0", () => {
  it("an EMPTY ps output is null, and signalling it sends nothing (the injected kill is never called)", () => {
    const s = spy();
    expect(parentPidOf(4242, () => "")).toBeNull();
    expect(parentPidOf(4242, () => "    \n")).toBeNull();
    expect(parentPidOf(4242, () => "    1\n"), "reparented to init").toBeNull();
    expect(signalParsedPid("", "SIGKILL", s.kill)).toBeNull();
    expect(s.calls).toEqual([]);
  });
  it("a readable parent is its pid, asked with the exact ps arguments, and a parsed pid is signalled once", () => {
    let asked: string[] = [];
    expect(parentPidOf(4242, (args) => ((asked = args), "  777\n"))).toBe(777);
    expect(asked).toEqual(["-o", "ppid=", "-p", "4242"]);
    const s = spy();
    expect(signalParsedPid("777\n", "SIGTERM", s.kill)).toBe(777);
    expect(s.calls).toEqual([[777, "SIGTERM"]]);
  });
});

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
