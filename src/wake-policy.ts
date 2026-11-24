// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * WHO MAY WAKE WHOM (doorbell PR 7 ruling 7224605e (4); PR 8a, gate brief §5, ruling e0217654): the ONE shared
 * policy the --until-wake trigger (src/watch-wake.ts) evaluates per pending id. It decides only whether mail WAKES its
 * recipient; refused mail stays pending and visible on the recipient's own drain.
 *   - STANDING, DEFAULT-DENY, AS DATA: <instance dir>/doorbell-policy.json, a closed schema
 *       {"version": 1, "optIn": [names], "wake": [{"from": name | "*", "to": name}], "pairWakesPerHour": 1..60}.
 *     A recipient wakes only when it is opted in AND (an exact {from: sender, to: it} pair exists, OR the ONE
 *     wildcard {from: "*", to: it} exists and the sender is a REGISTERED agent). A null sender matches nothing.
 *   - A MISSING, UNREADABLE OR MALFORMED FILE: NO wakes, and loud (the arm-check refuses, `relay doorbell status`
 *     shows policy_invalid, held mail is counted with that reason). There is NO allow-all policy in src/: the
 *     streaming `relay watch --json` (the stopgap) simply takes no policy; tests hold their own allow-all.
 *   - THE PER-PAIR RATE: at most pairWakesPerHour wakes per (sender → recipient) pair per trailing hour.
 * Metadata only, never content: the relay-authenticated sender (from_agent) and the lane.
 */
import fs from "fs";
import path from "path";
import { AGENT_NAME_PATTERN } from "./types.js";

/** One id's METADATA for the policy (never content): the relay-authenticated sender and its lane. */
export interface WakeMeta {
  from: string | null;
  lane: "direct" | "capability";
}
export type StandingRefusal = "no_standing" | "not_opted_in" | "policy_invalid";
export type StandingCheck = (x: { sender: string | null; recipient: string; kind: "direct" | "capability"; id: string }) => "allowed" | { refused: string };
/** The rate when no valid file names one (it never matters then: an invalid policy wakes nobody). */
export const DEFAULT_PAIR_WAKES_PER_HOUR = 4;
export const PAIR_WINDOW_MS = 3_600_000;
export const pairKey = (sender: string | null, recipient: string): string => `${sender ?? "\u0001unknown"}\u0000${recipient}`;

export const POLICY_FILENAME = "doorbell-policy.json";
export const POLICY_MAX_BYTES = 64 * 1024;
const MIN_RATE = 1;
const MAX_RATE = 60;

/** The policy file, validated. */
export interface WakePolicyFile {
  version: 1;
  optIn: string[];
  wake: Array<{ from: string; to: string }>;
  pairWakesPerHour: number;
}
/** A read of the file: the file, or WHY not (a ROLE, never the file's content: it may land in a hook line). */
export type PolicyRead = { ok: true; file: WakePolicyFile } | { ok: false; why: string };

const FIELDS = ["version", "optIn", "wake", "pairWakesPerHour"] as const;
const isName = (v: unknown): v is string => typeof v === "string" && AGENT_NAME_PATTERN.test(v);

/** Validate a parsed value against the CLOSED schema. Every reason names a field or an index, never a value. */
export function validatePolicy(v: unknown): PolicyRead {
  const bad = (why: string): PolicyRead => ({ ok: false, why: `schema: ${why}` });
  if (typeof v !== "object" || v === null || Array.isArray(v)) return bad("not an object");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(FIELDS as readonly string[]).includes(k)) return bad("unexpected field");
  for (const k of FIELDS) if (!Object.prototype.hasOwnProperty.call(o, k)) return bad(`missing ${k}`);
  if (o.version !== 1) return bad("version must be 1");
  if (!Array.isArray(o.optIn)) return bad("optIn is not a list");
  for (let i = 0; i < o.optIn.length; i++) if (!isName(o.optIn[i])) return bad(`optIn[${i}] is not an agent name`);
  const optIn = o.optIn as string[];
  if (!Array.isArray(o.wake)) return bad("wake is not a list");
  const wake: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < o.wake.length; i++) {
    const w = o.wake[i] as unknown;
    if (typeof w !== "object" || w === null || Array.isArray(w)) return bad(`wake[${i}] must have exactly from and to`);
    const keys = Object.keys(w).sort();
    if (keys.length !== 2 || keys[0] !== "from" || keys[1] !== "to") return bad(`wake[${i}] must have exactly from and to`);
    const { from, to } = w as { from: unknown; to: unknown };
    if (from !== "*" && !isName(from)) return bad(`wake[${i}].from is not an agent name or *`);
    if (!isName(to)) return bad(`wake[${i}].to is not an agent name`);
    if (!optIn.includes(to)) return bad(`wake[${i}].to is not opted in`); // a pair that can never fire is a typo
    wake.push({ from: from as string, to });
  }
  const rate = o.pairWakesPerHour;
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate < MIN_RATE || rate > MAX_RATE) return bad(`pairWakesPerHour must be an integer from ${MIN_RATE} to ${MAX_RATE}`);
  return { ok: true, file: { version: 1, optIn: [...optIn], wake, pairWakesPerHour: rate } };
}

/**
 * Read <instanceDir>/doorbell-policy.json: opened with O_NOFOLLOW (a link is refused, its target never read), a
 * REGULAR file, mode & 0o077 == 0 and owned by the running user (POSIX), at most POLICY_MAX_BYTES, strict UTF-8, JSON,
 * then the closed schema. Never writes. `expectedUid` is a test seam (default: the running user).
 */
export function readWakePolicy(instanceDir: string, opts: { expectedUid?: number } = {}): PolicyRead {
  const p = path.join(instanceDir, POLICY_FILENAME);
  const posix = process.platform !== "win32";
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | (posix ? fs.constants.O_NOFOLLOW : 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, why: "missing" };
    if (code === "ELOOP" || code === "EMLINK") return { ok: false, why: "a link" };
    if (code === "EISDIR") return { ok: false, why: "not a regular file" };
    return { ok: false, why: "unreadable" };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, why: "not a regular file" };
    if (posix) {
      if ((st.mode & 0o077) !== 0) return { ok: false, why: "mode too open (must be 0600)" };
      const uid = opts.expectedUid ?? process.getuid?.();
      if (uid !== undefined && st.uid !== uid) return { ok: false, why: "not owned by this user" };
    }
    if (st.size > POLICY_MAX_BYTES) return { ok: false, why: "too large" };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, off));
    } catch {
      return { ok: false, why: "not UTF-8" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, why: "not JSON" };
    }
    return validatePolicy(parsed);
  } catch {
    return { ok: false, why: "unreadable" };
  } finally {
    fs.closeSync(fd);
  }
}

/** The standing a VALID file grants. `isRegistered` is consulted ONLY for the wildcard (an exact pair needs none). */
export function policyStanding(file: WakePolicyFile, isRegistered: (name: string) => boolean): StandingCheck {
  const opted = new Set(file.optIn);
  const pairs = new Set(file.wake.filter((w) => w.from !== "*").map((w) => pairKey(w.from, w.to)));
  const wildcard = new Set(file.wake.filter((w) => w.from === "*").map((w) => w.to));
  return ({ sender, recipient }) => {
    if (!opted.has(recipient)) return { refused: "not_opted_in" };
    if (sender === null) return { refused: "no_standing" };
    if (pairs.has(pairKey(sender, recipient))) return "allowed";
    if (wildcard.has(recipient) && isRegistered(sender)) return "allowed";
    return { refused: "no_standing" };
  };
}

/** The standing of an invalid or missing file: every id refused, by that reason. */
const DENY_INVALID: StandingCheck = () => ({ refused: "policy_invalid" });

/** The policy in force for the relay DB at `dbPath`: read from its instance directory at every call. */
export function currentWakePolicy(dbPath: string, isRegistered: (name: string) => boolean): { standing: StandingCheck; pairWakesPerHour: number; read: PolicyRead } {
  const read = readWakePolicy(path.dirname(dbPath));
  if (!read.ok) return { standing: DENY_INVALID, pairWakesPerHour: DEFAULT_PAIR_WAKES_PER_HOUR, read };
  return { standing: policyStanding(read.file, isRegistered), pairWakesPerHour: read.file.pairWakesPerHour, read };
}
