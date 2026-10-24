// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import fs from "fs";
import { spawnSync } from "child_process";
import { processStartedAt, type ProcessStart } from "../../src/liveness.js";

/**
 * The pid parser for a pid a test reads as TEXT (a file, `ps` output) before it signals one. Its callers: this file,
 * tests/helpers/watch-window.ts (the run pid files, the supervisor's ack, the ps table's pid field) and
 * tests/watch-window-close.test.ts; it is not a claim about every test in the repo. The ONE captured
 * string must be all digits and its value a safe integer greater than 1; anything else is null. Why: `Number("")` is 0,
 * and `process.kill(0, sig)` signals the caller's whole process GROUP (the test runner). A shell's
 * `echo $pid > file` truncates before it writes, and `ps -o ppid=` prints nothing for a process that is gone, so an
 * empty read is ordinary. A ppid of 1 is a process reparented to init: never one of the test's.
 * PARSING IS NOT OWNERSHIP: a parsed pid is signalled only through signalOwnedPid (below).
 */
export function parsePid(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const pid = Number(t);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

/** A process's start token read now (liveness.processStartedAt, the UTC form): gone, unreadable, or the token. */
export type StartReader = (pid: number) => ProcessStart;
const readStart: StartReader = (pid) => processStartedAt(pid);

/**
 * PARSING IS NOT OWNERSHIP (architect ruling cf8c4b34). A pid the test launched, with its start token read AT LAUNCH:
 * the only proof, later, that the pid still names the process the test started (a pid is reused once its process ends).
 */
export type OwnedPid = { pid: number; launch: ProcessStart };

/** Own a pid the test just launched: read its start token now. Call it at launch, never at cleanup. */
export function ownPid(pid: number, startOf: StartReader = readStart): OwnedPid {
  return { pid, launch: startOf(pid) };
}

/**
 * Own the pid a test's process RECORDED in a file: ONE read, parsed once (parsePid), then its start token. null when the
 * file is absent or holds no pid yet (the truncate-then-write instant): poll until it does, at launch.
 */
export function ownRecordedPid(file: string, startOf: StartReader = readStart): OwnedPid | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  const pid = parsePid(raw);
  return pid === null ? null : ownPid(pid, startOf);
}

/** What signalOwnedPid did: signalled; gone (nothing to signal); refused (not provably ours: NOTHING sent, reported). */
export type SignalOutcome = { kind: "signalled"; pid: number } | { kind: "gone"; pid: number } | { kind: "refused"; pid: number; why: string };

export interface SignalDeps {
  startOf?: StartReader;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Where a refusal is reported (default: stderr). A refusal leaves the process running: the report is the record. */
  report?: (line: string) => void;
}

/**
 * Signal ONE owned pid, only on a CURRENT readable match with its launch token. The pid now:
 *   - gone → no signal;
 *   - unreadable (now, or at launch) → REFUSED and reported, no signal;
 *   - another start (a reused pid) → REFUSED and reported, no signal;
 *   - the same start → signalled.
 * RESIDUAL: the instant between the check and the kill. Node has no pidfd, so a process that ends and whose pid is
 * reused inside that instant can still be signalled; the check makes that window the only one.
 */
export function signalOwnedPid(owned: OwnedPid, signal: NodeJS.Signals, deps: SignalDeps = {}): SignalOutcome {
  const { startOf = readStart, kill = process.kill, report = (l: string) => void process.stderr.write(`${l}\n`) } = deps;
  const { pid, launch } = owned;
  const refuse = (why: string): SignalOutcome => {
    report(`[recorded-pid] REFUSED ${signal} to pid ${pid}: ${why}; nothing is signalled`);
    return { kind: "refused", pid, why };
  };
  if (launch.kind === "gone") return { kind: "gone", pid }; // it ended before it was owned: there is nothing of ours to signal
  if (launch.kind === "unreadable") return refuse(`no start token was read at launch (${launch.why})`);
  if (parsePid(String(pid)) === null) return refuse("not a process id > 1");
  const now = startOf(pid);
  if (now.kind === "gone") return { kind: "gone", pid };
  if (now.kind === "unreadable") return refuse(`its start is unreadable now (${now.why})`);
  if (now.start !== launch.start) return refuse(`it is another process now (start ${JSON.stringify(now.start)}, recorded at launch ${JSON.stringify(launch.start)})`);
  try {
    kill(pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return { kind: "gone", pid };
    return refuse(`kill failed: ${(err as Error).message}`);
  }
  return { kind: "signalled", pid };
}

/**
 * A process's parent, from `ps -o ppid=` (one captured string, parsePid), or null: gone, unreadable, or reparented to
 * init (1). `ps` is injectable so a test can pin the empty-output case without signalling anything.
 */
export function parentPidOf(pid: number, ps: (args: string[]) => string = (args) => spawnSync("ps", args, { encoding: "utf-8" }).stdout ?? ""): number | null {
  return parsePid(ps(["-o", "ppid=", "-p", String(pid)]));
}
