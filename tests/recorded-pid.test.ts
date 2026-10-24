// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * tests/_helpers/recorded-pid.ts: a test signals only a pid it OWNS (its start token, read at launch, still matches),
 * never 0 (its own process group) or 1, whatever a file holds. PARSING IS NOT OWNERSHIP (architect ruling cf8c4b34).
 * The kill and the start reader are INJECTED here, so nothing is ever signalled for real.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ownPid, ownRecordedPid, parentPidOf, parsePid, signalOwnedPid, type OwnedPid, type StartReader } from "./_helpers/recorded-pid.js";
import type { ProcessStart } from "../src/liveness.js";

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

const T0 = "Mon Oct 19 10:00:00 2026 UTC";
const T1 = "Mon Oct 19 10:05:00 2026 UTC";
const start = (t: string): ProcessStart => ({ kind: "start", start: t });
const GONE: ProcessStart = { kind: "gone" };
const UNREADABLE: ProcessStart = { kind: "unreadable", why: "ps timed out" };
/** A start reader that answers from a script, in order (the last answer repeats). */
const reader = (...answers: ProcessStart[]): StartReader => {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)];
};
const harness = (now: StartReader) => {
  const s = spy();
  const reports: string[] = [];
  return { s, reports, deps: { startOf: now, kill: s.kill, report: (l: string) => void reports.push(l) } };
};

describe("parentPidOf: `ps -o ppid=` printing nothing (the process is gone) is null, never a pid of 0", () => {
  it("an EMPTY ps output is null, as is init (1)", () => {
    expect(parentPidOf(4242, () => "")).toBeNull();
    expect(parentPidOf(4242, () => "    \n")).toBeNull();
    expect(parentPidOf(4242, () => "    1\n"), "reparented to init").toBeNull();
  });
  it("a readable parent is its pid, asked with the exact ps arguments", () => {
    let asked: string[] = [];
    expect(parentPidOf(4242, (args) => ((asked = args), "  777\n"))).toBe(777);
    expect(asked).toEqual(["-o", "ppid=", "-p", "4242"]);
  });
});

describe("signalOwnedPid: PARSING IS NOT OWNERSHIP: a pid is signalled only on a CURRENT readable match with its launch token", () => {
  it("the TWIN: a live pid whose start still matches its launch token is signalled, exactly once, with the asked signal", () => {
    const h = harness(reader(start(T0)));
    const owned = ownPid(4242, reader(start(T0)));
    expect(signalOwnedPid(owned, "SIGKILL", h.deps)).toEqual({ kind: "signalled", pid: 4242 });
    expect(h.s.calls).toEqual([[4242, "SIGKILL"]]);
    expect(h.reports).toEqual([]);
  });
  it("a MISMATCHED token (the owned process was killed and its pid REUSED by another) is NOT signalled: refused and reported", () => {
    const owned = ownPid(4242, reader(start(T0))); // launch: our process
    const h = harness(reader(start(T1))); // later: another process holds pid 4242
    const r = signalOwnedPid(owned, "SIGKILL", h.deps);
    expect(r.kind).toBe("refused");
    expect(h.s.calls).toEqual([]); // PRIMARY: the reused pid is never signalled
    expect(h.reports.join("\n")).toMatch(/REFUSED SIGKILL to pid 4242: it is another process now .*nothing is signalled/);
  });
  it("an UNREADABLE token now is NOT signalled: refused and reported (unreadable is not a match, and not gone)", () => {
    const owned = ownPid(4242, reader(start(T0)));
    const h = harness(reader(UNREADABLE));
    expect(signalOwnedPid(owned, "SIGKILL", h.deps).kind).toBe("refused");
    expect(h.s.calls).toEqual([]); // PRIMARY
    expect(h.reports.join("\n")).toMatch(/REFUSED SIGKILL to pid 4242: its start is unreadable now \(ps timed out\)/);
  });
  it("a token UNREADABLE AT LAUNCH can never prove ownership: refused and reported, the start is not even asked again", () => {
    const owned = ownPid(4242, reader(UNREADABLE));
    let asked = 0;
    const h = harness(() => (asked++, start(T0)));
    expect(signalOwnedPid(owned, "SIGKILL", h.deps).kind).toBe("refused");
    expect([h.s.calls, asked]).toEqual([[], 0]);
    expect(h.reports.join("\n")).toMatch(/no start token was read at launch/);
  });
  it("a pid GONE now (or gone at launch) is not signalled and not an error; a kill that races its exit (ESRCH) is gone too", () => {
    const h = harness(reader(GONE));
    expect(signalOwnedPid(ownPid(4242, reader(start(T0))), "SIGKILL", h.deps)).toEqual({ kind: "gone", pid: 4242 });
    expect(signalOwnedPid(ownPid(4242, reader(GONE)), "SIGKILL", h.deps)).toEqual({ kind: "gone", pid: 4242 });
    expect([h.s.calls, h.reports]).toEqual([[], []]);
    const esrch = () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };
    expect(signalOwnedPid(ownPid(4242, reader(start(T0))), "SIGKILL", { startOf: reader(start(T0)), kill: esrch, report: () => {} }).kind).toBe("gone");
  });
  it("0, 1 or a negative pid is never signalled, whatever the tokens say (0 and -n are process GROUPS)", () => {
    for (const pid of [0, 1, -1, -4242]) {
      const h = harness(reader(start(T0)));
      const owned: OwnedPid = { pid, launch: start(T0) };
      expect(signalOwnedPid(owned, "SIGKILL", h.deps).kind, String(pid)).toBe("refused");
      expect(h.s.calls).toEqual([]);
    }
  });
});

describe("ownRecordedPid: a test owns only the pid it RECORDED (one read, parsed once), never 0 (the process group) or 1", () => {
  it("a recorded pid is owned with the start token read when it is owned", () => {
    expect(ownRecordedPid(fileWith("12345\n"), reader(start(T0)))).toEqual({ pid: 12345, launch: start(T0) });
  });
  it("an EMPTY read (the truncate-then-write instant), 0, 1, a negative or non-digits own nothing; no file is not an error", () => {
    let asked = 0;
    const r: StartReader = () => (asked++, start(T0));
    for (const c of ["", "  \n", "0", "1", "-1", "-4242", "12a", "4.2", "0x10", "1e3"]) expect(ownRecordedPid(fileWith(c), r), JSON.stringify(c)).toBeNull();
    expect(ownRecordedPid(path.join(dir, "absent"), r)).toBeNull();
    expect(asked).toBe(0);
  });
});
