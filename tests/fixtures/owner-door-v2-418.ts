// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A FROZEN copy of the owner door's v2 protocol as hook PR 1 (#418, 5ae03d8) shipped it: the record shape, the
 * client's record gate, the HMAC request/reply texts, the server's request check and reply MAC, and the client's
 * exchange. The ONLY edits from src/owner-endpoint.ts and src/cli/owner.ts at 5ae03d8: the process-global key and
 * binding are parameters, and the replay cache is per server. Used for the version-skew rows (#433 Codex R1 P2-5): a
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

/** A #418 daemon's door (POST /owner/v1/peek): its request check and MAC'd reply. Counts every request it receives. */
export function startDoorServer418(key: string, b: DoorBinding418, reply: Record<string, unknown>): Promise<{ server: http.Server; port: number; requests: () => number }> {
  let n = 0;
  const seen = new Set<string>();
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
      let body: { ts?: unknown; client_nonce?: unknown } = {};
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        send(400, { ok: false, error: "the body is not JSON" });
        return;
      }
      const nonce = typeof body.client_nonce === "string" && /^[0-9a-f]{32}$/.test(body.client_nonce) ? body.client_nonce : undefined;
      if (!nonce || !Number.isInteger(body.ts)) {
        send(400, { ok: false, error: "client_nonce / ts" });
        return;
      }
      const mac = req.headers["x-owner-mac"];
      if (typeof mac !== "string" || !macEqual(mac, doorMac(key, doorRequestText(b, req.url ?? "", body.ts as number, nonce, raw)))) {
        send(401, { ok: false, error: "the request MAC does not verify" }, nonce);
        return;
      }
      if (seen.has(nonce)) {
        send(401, { ok: false, error: "replayed" }, nonce);
        return;
      }
      seen.add(nonce);
      send(200, reply, nonce);
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
