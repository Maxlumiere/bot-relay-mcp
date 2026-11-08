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

/** A bind address that a client reaches as 127.0.0.1 (the record's host is always 127.0.0.1). */
export function bindCoversLoopback(host: string): boolean {
  return ["127.0.0.1", "localhost", "0.0.0.0", "::", "::ffff:127.0.0.1"].includes(host);
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
export const PROBE_KEY = (): string => KEY;
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
