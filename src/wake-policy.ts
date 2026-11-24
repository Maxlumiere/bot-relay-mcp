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
 * The identity of a relay DB file (device + inode, as exact bigints), or null when it cannot be read. A watch records
 * it for the DB it OPENED, and every policy read is bound to it (Codex #447 R1 P1).
 */
export function dbIdentity(dbPath: string): string | null {
  try {
    const st = fs.statSync(dbPath, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/**
 * TRUE when the JSON text has an object with a DUPLICATE key (JSON.parse keeps the last one silently: an empty
 * `wake` followed by a permissive one would win). `text` is already known to be valid JSON.
 */
export function hasDuplicateKey(text: string): boolean {
  const stack: Array<Set<string> | null> = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (c === "[") {
      stack.push(null);
      expectKey = false;
    } else if (c === "}" || c === "]") {
      stack.pop();
      expectKey = false;
    } else if (c === ",") {
      expectKey = stack[stack.length - 1] instanceof Set;
    } else if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        const keys = stack[stack.length - 1] as Set<string>;
        if (keys.has(key)) return true;
        keys.add(key);
        expectKey = false;
      }
      i = j;
    }
  }
  return false;
}

/**
 * Read <instanceDir>/doorbell-policy.json: opened with O_NOFOLLOW (a link is refused, its target never read), a
 * REGULAR file, mode & 0o077 == 0 and owned by the running user (POSIX), read to EOF under a hard cap of
 * POLICY_MAX_BYTES and refused if it changed while read, strict UTF-8, JSON with no duplicate key, then the closed
 * schema. Never writes. `expectedUid` is a test seam (default: the running user).
 *
 * `bound` (Codex #447 R1 P1): the open relay DB (its path and the identity recorded when it was opened). The DB
 * path's file must still have that identity both BEFORE and AFTER the policy file is opened, so a policy is never
 * read from another instance (a linked instance dir retargeted under a live watch). Residual, stated: a retarget
 * away and back between those two checks; Node has no openat to close it fully.
 */
export function readWakePolicy(instanceDir: string, opts: { expectedUid?: number; bound?: { dbPath: string; identity: string | null }; afterStat?: () => void } = {}): PolicyRead {
  const p = path.join(instanceDir, POLICY_FILENAME);
  const posix = process.platform !== "win32";
  const sameInstance = (): boolean => !opts.bound || (opts.bound.identity !== null && dbIdentity(opts.bound.dbPath) === opts.bound.identity);
  if (!sameInstance()) return { ok: false, why: "not the open relay's instance" };
  let fd: number;
  try {
    // O_NONBLOCK (security review, #447): a FIFO at this name would otherwise block the open before the isFile check
    // below refuses it (the arm-check, doorbell status --hook and policy --check would hang).
    fd = fs.openSync(p, fs.constants.O_RDONLY | (posix ? fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK : 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, why: "missing" };
    if (code === "ELOOP" || code === "EMLINK") return { ok: false, why: "a link" };
    if (code === "EISDIR") return { ok: false, why: "not a regular file" };
    return { ok: false, why: "unreadable" };
  }
  try {
    if (!sameInstance()) return { ok: false, why: "not the open relay's instance" };
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, why: "not a regular file" };
    if (posix) {
      if ((st.mode & 0o077) !== 0) return { ok: false, why: "mode too open (must be 0600)" };
      const uid = opts.expectedUid ?? process.getuid?.();
      if (uid !== undefined && st.uid !== uid) return { ok: false, why: "not owned by this user" };
    }
    if (st.size > POLICY_MAX_BYTES) return { ok: false, why: "too large" };
    opts.afterStat?.(); // a TEST seam: a write between the stat and the read (the race the re-stat below catches)
    // To EOF, under a hard cap (one byte past it proves "too large"), then re-stat: a file that grew, shrank or was
    // rewritten while read is refused, never trusted as its prefix (Codex #447 R1 P2).
    const buf = Buffer.alloc(POLICY_MAX_BYTES + 1);
    let off = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
      if (off > POLICY_MAX_BYTES) return { ok: false, why: "too large" };
    }
    const after = fs.fstatSync(fd);
    if (off !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) return { ok: false, why: "changed while being read" };
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
    if (hasDuplicateKey(text)) return { ok: false, why: "schema: a duplicate key" };
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
export function currentWakePolicy(dbPath: string, isRegistered: (name: string) => boolean, boundIdentity?: string | null): { standing: StandingCheck; pairWakesPerHour: number; read: PolicyRead } {
  const read = readWakePolicy(path.dirname(dbPath), boundIdentity === undefined ? {} : { bound: { dbPath, identity: boundIdentity } });
  if (!read.ok) return { standing: DENY_INVALID, pairWakesPerHour: DEFAULT_PAIR_WAKES_PER_HOUR, read };
  return { standing: policyStanding(read.file, isRegistered), pairWakesPerHour: read.file.pairWakesPerHour, read };
}
