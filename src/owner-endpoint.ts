// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Hook PR 1, as designed and ruled: THE OWNER ENDPOINT RECORD. A wasm DB has ONE opener, its owner; the hooks reach
 * its mail through that owner over HTTP instead of opening the file.
 * - Every LISTENING wasm owner writes `realpath(parent)/.<canonical basename>.relay-owner.json` (0600; Windows: the
 *   owner-only ACL), by an exclusive temp file and a rename, AFTER it is listening:
 *   `{v: 1, host: "127.0.0.1", port, pid, pid_start, key, transport}`.
 * - It is NEVER deleted (not even on a clean exit); a new owner overwrites it.
 * - The `key` is a per-owner secret (128 bits, fresh per process), NEVER served. GET /owner-id?c=<challenge> answers
 *   HMAC-SHA256(key, challenge ‖ port): a hook verifies that with the key from the 0600 record RIGHT before it sends a
 *   credential, so a process that took the port after the owner died cannot replay an answer (cross-user, SEC-04).
 * - A record is VALID only when the DB's owner lock is HELD (the non-creating probe), and its pid is alive with the
 *   same start token.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { probeOwnerLock } from "./db-owner-lock.js";
import { processStartedAt, startOrNull } from "./liveness.js";
import { restrictToOwnerWindows } from "./fs-perms.js";

export const OWNER_ENDPOINT_VERSION = 1;
const KEY = crypto.randomBytes(16).toString("hex"); // this process's owner key: fresh per process, never served

export interface OwnerEndpointRecord {
  v: number;
  host: "127.0.0.1";
  port: number;
  pid: number;
  pid_start: string | null;
  key: string;
  transport: "http" | "stdio";
}

/** The record's path for the DB at `dbPath`: beside its CANONICAL file, a dotfile named after it. */
export function ownerEndpointPath(dbPath: string): string {
  const real = fs.realpathSync.native(dbPath);
  return path.join(path.dirname(real), `.${path.basename(real)}.relay-owner.json`);
}

/**
 * A BOUND address (server.address().address, never the requested host) that a client reaches as 127.0.0.1: the IPv4
 * loopback, or every IPv4 address. "::" is NOT counted (a v6-only socket does not take 127.0.0.1), nor ::1.
 */
export function addressReachesLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "0.0.0.0" || address === "::ffff:127.0.0.1";
}

/** Hook PR 1 (as ruled, Q9): the owner-peek listener's only host, a constant. */
export const OWNER_PEEK_HOST = "127.0.0.1";
export const OWNER_PEEK_REFUSAL =
  "this listener serves only the hooks (GET /owner-id, get_messages with peek: true, and report_liveness)";

/** The owner-peek gate, before any parse: GET /owner-id, or POST /mcp without a session. */
export function ownerPeekRouteAllowed(method: string, reqPath: string, hasSession: boolean): boolean {
  if (method === "GET" && reqPath === "/owner-id") return true;
  return method === "POST" && reqPath === "/mcp" && !hasSession;
}

/** The ONLY argument keys the hooks' peek sends (as ruled: any other key, `ack` included, is refused). Sorted. */
const PEEK_KEYS = ["agent_name", "agent_token", "limit", "peek", "since", "status"];

/** Hook PR 2 (as ruled, Q8): report_liveness's ONLY keys (agent_pid_start optional). */
const LIVENESS_KEYS = new Set(["agent_name", "agent_pid", "agent_pid_start", "agent_token"]);

/**
 * The owner-peek gate, after the parse: exactly ONE JSON-RPC object, `tools/call` of either
 * - `get_messages` whose arguments carry exactly the peek's keys, with `peek: true` and `status: "pending"`; or
 * - `report_liveness` (hook PR 2, Q8: the wasm liveness self-heal) whose arguments carry only its keys: a string
 *   agent_name and agent_token, an INTEGER agent_pid, and optionally a string agent_pid_start.
 */
export function ownerPeekBodyAllowed(body: unknown): boolean {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as { jsonrpc?: unknown; method?: unknown; params?: unknown };
  if (b.jsonrpc !== "2.0" || b.method !== "tools/call") return false;
  if (b.params === null || typeof b.params !== "object" || Array.isArray(b.params)) return false;
  const p = b.params as { name?: unknown; arguments?: unknown };
  if (p.arguments === null || typeof p.arguments !== "object" || Array.isArray(p.arguments)) return false;
  const a = p.arguments as Record<string, unknown>;
  if (p.name === "report_liveness") {
    if (Object.keys(a).some((k) => !LIVENESS_KEYS.has(k))) return false;
    if (typeof a.agent_name !== "string" || typeof a.agent_token !== "string" || !Number.isInteger(a.agent_pid)) return false;
    return a.agent_pid_start === undefined || typeof a.agent_pid_start === "string";
  }
  if (p.name !== "get_messages") return false;
  const keys = Object.keys(a).sort();
  if (keys.length !== PEEK_KEYS.length || keys.some((k, i) => k !== PEEK_KEYS[i])) return false;
  return a.peek === true && a.status === "pending";
}

/**
 * Write this owner's record for the DB at `dbPath`, listening on `port` (called only once listening). An exclusive
 * temp file beside it, 0600, then a rename onto the record (atomic: a reader sees the old record or the new one).
 */
export function writeOwnerEndpoint(dbPath: string, port: number, transport: OwnerEndpointRecord["transport"]): string {
  const file = ownerEndpointPath(dbPath);
  const record: OwnerEndpointRecord = {
    v: OWNER_ENDPOINT_VERSION,
    host: "127.0.0.1",
    port,
    pid: process.pid,
    pid_start: startOrNull(processStartedAt(process.pid)),
    key: KEY,
    transport,
  };
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
  try {
    if (process.platform === "win32") restrictToOwnerWindows(tmp, false);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true }); // this owner's own temp file, never the record
    throw err;
  }
  return file;
}

/** The owner's answer to a challenge: HMAC-SHA256(key, challenge ‖ port), hex. Only this process's own key. */
export function ownerIdAnswer(challenge: string, port: number): string {
  return crypto.createHmac("sha256", Buffer.from(KEY, "hex")).update(`${challenge}${port}`).digest("hex");
}

/** A challenge the hooks may send: 16..128 hex characters (anything else is refused, 400). */
export function isChallenge(c: unknown): c is string {
  return typeof c === "string" && /^[0-9a-f]{16,128}$/.test(c);
}

/**
 * The VALID record of the DB at `dbPath`, or null: it parses (v 1, host 127.0.0.1, a port, a 32-hex key, a pid), the
 * DB's owner lock is HELD by another process (an undecidable probe is not valid), and its pid is alive with the SAME
 * start token. Validity is not proof of identity: the hook's challenge-response is (right before a credential).
 */
export function validOwnerEndpoint(dbPath: string): { url: string; key: string } | null {
  let rec: Partial<OwnerEndpointRecord>;
  try {
    rec = JSON.parse(fs.readFileSync(ownerEndpointPath(dbPath), "utf-8")) as Partial<OwnerEndpointRecord>;
  } catch {
    return null;
  }
  if (rec.v !== OWNER_ENDPOINT_VERSION || rec.host !== "127.0.0.1") return null;
  if (!Number.isInteger(rec.port) || (rec.port as number) < 1 || (rec.port as number) > 65535) return null;
  if (typeof rec.key !== "string" || !/^[0-9a-f]{32}$/.test(rec.key)) return null;
  if (!Number.isInteger(rec.pid) || (rec.pid as number) <= 0 || typeof rec.pid_start !== "string" || rec.pid_start.length === 0) return null;
  if (probeOwnerLock(dbPath).state !== "held") return null;
  const now = processStartedAt(rec.pid as number);
  if (now.kind !== "start" || now.start !== rec.pid_start) return null;
  return { url: `http://127.0.0.1:${rec.port}`, key: rec.key };
}
