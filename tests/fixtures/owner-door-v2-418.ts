// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A FROZEN copy of the owner door's v2 protocol as hook PR 1 (#418, 5ae03d8) shipped it: the record shape, the
 * client's record gate, the HMAC request/reply texts, the server's request check and reply MAC, and the client's
 * exchange. The ONLY edits from src/owner-endpoint.ts and src/cli/owner.ts at 5ae03d8: the process-global key,
 * binding and replay map are parameters (one replay map per server); the verifier is otherwise verbatim (its shape
 * checks, its 30 s window, its 2 s skew, its bounded replay cache). Used for the version-skew rows (#433 Codex R1 P2-5): a
 * v2 daemon with the new client, and a v3 record with the v2 client.
 */
import crypto from "crypto";
import http from "http";

export interface DoorBinding418 {
  instance_id: string;
  db_path: string;
}
export const OWNER_ENDPOINT_VERSION_418 = 2;

/** The v2 record a #418 daemon wrote (src/owner-endpoint.ts writeOwnerEndpoint at 5ae03d8). */
export function record418(port: number, key: string, b: DoorBinding418, pid = process.pid): Record<string, unknown> {
  return { v: OWNER_ENDPOINT_VERSION_418, host: "127.0.0.1", port, pid, pid_start: null, key, transport: "http", instance_id: b.instance_id, db_path: b.db_path };
}

/** The #418 CLIENT's gate on a parsed record (ownerEndpointVerdict at 5ae03d8, the shape checks, verbatim order). */
export function gate418(rec: Record<string, unknown>): "ok" | "old-record" | "bad-record" {
  if (rec.v === 1) return "old-record";
  if (rec.v !== OWNER_ENDPOINT_VERSION_418 || rec.host !== "127.0.0.1") return "bad-record";
  if (!Number.isInteger(rec.port) || (rec.port as number) < 1 || (rec.port as number) > 65535) return "bad-record";
  if (typeof rec.key !== "string" || !/^[0-9a-f]{32}$/.test(rec.key)) return "bad-record";
  if (typeof rec.instance_id !== "string" || typeof rec.db_path !== "string") return "bad-record";
  return "ok";
}

export function doorMac(keyHex: string, text: string): string {
  return crypto.createHmac("sha256", Buffer.from(keyHex, "hex")).update(text).digest("hex");
}
export const doorRequestText = (b: DoorBinding418, p: string, ts: number, nonce: string, body: string) =>
  `req\n${b.instance_id}\n${b.db_path}\n${p}\n${ts}\n${nonce}\n${body}`;
export const doorResponseText = (b: DoorBinding418, nonce: string, status: number, body: string) =>
  `resp\n${b.instance_id}\n${b.db_path}\n${nonce}\n${status}\n${body}`;
export function macEqual(a: string, b: string): boolean {
  const x = Buffer.from(/^[0-9a-f]{64}$/.test(a) ? a : "", "hex");
  const y = Buffer.from(/^[0-9a-f]{64}$/.test(b) ? b : "", "hex");
  return x.length === 32 && y.length === 32 && crypto.timingSafeEqual(x, y);
}

// --- #418's request VERIFIER, verbatim (src/owner-endpoint.ts verifyDoorRequest at 5ae03d8). Substitutions only:
// KEY -> key, ownBinding -> b, the module's seenNonces map -> `seen` (one per server), sweepDoorNonces -> sweep(seen).
export const DOOR_WINDOW_SECS_418 = 30;
const DOOR_SKEW_SECS = 2;
export const DOOR_NONCE_CAPACITY_418 = 4096;
const NONCE_RE = /^[0-9a-f]{32}$/;
const AGENT_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function sweep(seen: Map<string, number>, nowMs: number): void {
  for (const [n, exp] of seen) if (exp <= nowMs) seen.delete(n);
}
export function verifyDoorRequest418(
  key: string,
  b: DoorBinding418,
  seen: Map<string, number>,
  p: string,
  rawBody: unknown,
  macHeader: unknown,
  nowMs = Date.now(),
): { ok: true; req: { agent_name: string; args: Record<string, unknown>; ts: number; nonce: string } } | { ok: false; status: number; error: string; nonce?: string } {
  if (typeof rawBody !== "string" || rawBody.length === 0) return { ok: false, status: 400, error: "the door takes a text/plain JSON body" };
  let body: { agent_name?: unknown; args?: unknown; ts?: unknown; client_nonce?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return { ok: false, status: 400, error: "the body is not JSON" };
  }
  if (body === null || typeof body !== "object") return { ok: false, status: 400, error: "the body is not an object" };
  const nonce = typeof body.client_nonce === "string" && NONCE_RE.test(body.client_nonce) ? body.client_nonce : undefined;
  if (!nonce) return { ok: false, status: 400, error: "client_nonce must be 32 hex characters" };
  if (!Number.isInteger(body.ts)) return { ok: false, status: 400, error: "ts must be an integer (unix seconds)", nonce };
  if (typeof body.agent_name !== "string" || !AGENT_RE.test(body.agent_name)) return { ok: false, status: 400, error: "agent_name is not a valid agent name", nonce };
  if (body.args === null || typeof body.args !== "object" || Array.isArray(body.args)) return { ok: false, status: 400, error: "args must be an object", nonce };
  const ts = body.ts as number;
  if (typeof macHeader !== "string" || !macEqual(macHeader, doorMac(key, doorRequestText(b, p, ts, nonce, rawBody)))) {
    return { ok: false, status: 401, error: "the request MAC does not verify (a wrong key, or a request bound to another instance)", nonce };
  }
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > DOOR_WINDOW_SECS_418) return { ok: false, status: 401, error: "the request is outside the time window", nonce };
  if (seen.has(nonce)) return { ok: false, status: 401, error: "the request was replayed (its nonce was seen)", nonce };
  if (seen.size >= DOOR_NONCE_CAPACITY_418) {
    sweep(seen, nowMs);
    if (seen.size >= DOOR_NONCE_CAPACITY_418) return { ok: false, status: 503, error: "the door's replay cache is full: try again shortly", nonce };
  }
  seen.set(nonce, (ts + DOOR_WINDOW_SECS_418 + DOOR_SKEW_SECS) * 1000);
  return { ok: true, req: { agent_name: body.agent_name, args: body.args as Record<string, unknown>, ts, nonce } };
}

/** A #418 daemon's door (POST /owner/v1/peek): the verbatim verifier above, then its MAC'd reply. Counts requests. */
export function startDoorServer418(key: string, b: DoorBinding418, reply: Record<string, unknown>): Promise<{ server: http.Server; port: number; requests: () => number }> {
  let n = 0;
  const seen = new Map<string, number>();
  const server = http.createServer((req, res) => {
    n++;
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      const send = (status: number, payload: unknown, nonce?: string) => {
        const text = JSON.stringify(payload);
        if (nonce) res.setHeader("X-Owner-MAC", doorMac(key, doorResponseText(b, nonce, status, text)));
        res.statusCode = status;
        res.setHeader("Content-Type", "text/plain");
        res.end(text);
      };
      const v = verifyDoorRequest418(key, b, seen, req.url ?? "", raw, req.headers["x-owner-mac"]);
      if (!v.ok) {
        send(v.status, { ok: false, error: v.error }, v.nonce);
        return;
      }
      send(200, reply, v.req.nonce);
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: (server.address() as { port: number }).port, requests: () => n })));
}

/** The #418 CLIENT's exchange (src/cli/owner.ts exchange at 5ae03d8): a MAC'd request, the reply MAC verified first. */
export function exchange418(port: number, key: string, b: DoorBinding418, doorPath: string, bodyObj: Record<string, unknown>, nonce: string): Promise<{ status: number; payload: Record<string, unknown> }> {
  const body = JSON.stringify(bodyObj);
  const mac = doorMac(key, doorRequestText(b, doorPath, bodyObj.ts as number, nonce, body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: doorPath, method: "POST", agent: false, headers: { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body), "X-Owner-MAC": mac } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;
          const got = res.headers["x-owner-mac"];
          if (typeof got !== "string" || !macEqual(got, doorMac(key, doorResponseText(b, nonce, status, text)))) {
            reject(new Error("the owner's reply failed its MAC (a forged or altered reply): nothing from it is shown"));
            return;
          }
          try {
            resolve({ status, payload: JSON.parse(text) as Record<string, unknown> });
          } catch {
            reject(new Error("the owner's reply is not JSON"));
          }
        });
        res.on("error", (e) => reject(e));
      },
    );
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("the owner did not answer in time (timed out)"));
    });
    req.on("error", (e) => reject(new Error(`the owner door could not be reached (${(e as NodeJS.ErrnoException).code ?? e.message})`)));
    req.end(body);
  });
}
