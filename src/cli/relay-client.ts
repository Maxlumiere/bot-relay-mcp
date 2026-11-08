// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE CLI's ONE way to make a credential-bearing call to a relay (PR 4, as ruled after #433 R1). Every verb that
 * carries a token or a secret (send, resolve, doctor, test, pair) goes through here; a scan row
 * (tests/cli-door-clients.test.ts) refuses any other HTTP client call site in src/cli, bin and tools.
 * - routeFor(host): the relay host CHECK (src/host-class.ts): LOOPBACK (any spelling) → "local"; an explicit
 *   non-loopback host → "remote", carrying its CHECKED address; neither → "unresolved" (nothing is sent; named).
 * - LOCAL: localTool() → a SEALED exchange with the local instance's daemon through its owner door
 *   (/owner/v1/tool: an allowlist of exactly the tools these verbs call; the handler's own auth, the token and the
 *   registration secret inside the ciphertext). No valid owner record = a named failure ("restart the relay daemon").
 * - REMOTE: remotePost() → node:http / node:https (never fetch): to the CHECKED address (Host and TLS SNI keep the
 *   name), no redirect followed (a 3xx is a named failure), no proxy from the environment (a fresh agent per request,
 *   NODE_USE_ENV_PROXY cannot apply), a deadline. Credentials are PER-REMOTE only: remoteToken() reads
 *   RELAY_AGENT_TOKEN or that remote's own vault scope (agents/remote-<host>-<port>/), never the local vault; the
 *   transport secrets come only from the environment, never the local config.
 */
import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import crypto from "crypto";
import { classifyHost } from "../host-class.js";
import { remoteScope } from "./remote.js";

export class RelayClientError extends Error {}

export type RelayRoute =
  | { kind: "local" }
  | { kind: "remote"; host: string; port: number; ip: string; secure: boolean }
  | { kind: "unresolved"; host: string; why: string; secs: number };

export async function routeFor(host: string, port: number, secure = false, timeoutMs = 2000): Promise<RelayRoute> {
  const c = await classifyHost(host, { timeoutMs });
  if (c.kind === "loopback") return { kind: "local" };
  if (c.kind === "remote") return { kind: "remote", host, port, ip: c.ip, secure };
  return { kind: "unresolved", host, why: c.kind === "unresolved" ? c.why : "unknown", secs: Math.round(timeoutMs / 1000) };
}
/** The named refusal for an unresolved host (the hooks' wording). */
export const unresolvedMessage = (r: { host: string; why: string; secs: number }) =>
  `the remote host ${r.host} did not resolve within ${r.secs}s (${r.why}); nothing is sent`;

/**
 * One allowlisted tool on the LOCAL instance's daemon, sealed through its owner door. Returns the tool's MCP result
 * ({content, isError?}); a door failure throws RelayClientError with the named reason.
 */
export async function localTool(
  name: string,
  args: Record<string, unknown>,
  creds: { agentToken?: string; mintSecret?: string },
  opts: { timeoutMs?: number; dbPath?: string; agentName?: string } = {},
): Promise<{ content?: Array<{ type?: string; text?: string }>; isError?: boolean }> {
  const { resolveInstance } = await import("../instance.js");
  const { ownerEndpointVerdict, OWNER_DOOR_TOOL } = await import("../owner-endpoint.js");
  const { doorExchange } = await import("./owner.js");
  const r = resolveInstance(opts.dbPath ? { dbPath: opts.dbPath } : {});
  if (r.kind === "error") throw new RelayClientError(`no local relay instance (${r.reason})`);
  const instanceId = r.kind === "instance" ? r.id : "";
  const v = ownerEndpointVerdict(r.dbPath, instanceId);
  if (!v.ok) throw new RelayClientError(`no trusted owner door for ${r.dbPath} (${v.reason}): restart the relay daemon if it is running`);
  const binding = { instance_id: instanceId, db_path: fs.realpathSync.native(r.dbPath) };
  const caller = opts.agentName ?? (typeof args.from === "string" ? args.from : typeof args.agent_name === "string" ? args.agent_name : typeof args.name === "string" ? args.name : "cli");
  let reply: { status: number; payload: Record<string, unknown> };
  try {
    reply = await doorExchange(
      v.port,
      v.key,
      binding,
      OWNER_DOOR_TOOL,
      {
        agent_name: /^[A-Za-z0-9_.-]{1,64}$/.test(caller) ? caller : "cli",
        args: {
          rpc: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
          ...(creds.agentToken ? { agent_token: creds.agentToken } : {}),
          ...(creds.mintSecret ? { mint_secret: creds.mintSecret } : {}),
        },
      },
      Date.now() + (opts.timeoutMs ?? 10_000),
    );
  } catch (err) {
    throw new RelayClientError((err as Error).message);
  }
  const p = reply.payload;
  if (reply.status !== 200 || p.ok !== true) throw new RelayClientError(`the owner refused (${reply.status}): ${typeof p.error === "string" ? p.error : "no reason given"}`);
  return (p.result ?? {}) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
}
/** A tool result's text parsed as JSON (null when it is not). */
export function toolJson(result: { content?: Array<{ text?: string }> }): Record<string, unknown> | null {
  try {
    const t = JSON.parse(String(result.content?.[0]?.text ?? "")) as unknown;
    return t !== null && typeof t === "object" && !Array.isArray(t) ? (t as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A hardened POST to a REMOTE relay: the checked address, no redirect, no proxy, a deadline. */
export function remotePost(r: { host: string; port: number; ip: string; secure: boolean }, reqPath: string, headers: Record<string, string>, body: string, timeoutMs = 10_000): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const opts: https.RequestOptions = {
      host: r.ip,
      port: r.port,
      path: reqPath,
      method: "POST",
      agent: false, // a fresh agent: no keep-alive pool, and no proxy from the environment
      headers: { ...headers, Host: `${r.host}:${r.port}`, "Content-Length": Buffer.byteLength(body) },
      ...(r.secure ? { servername: r.host } : {}),
    };
    const onRes = (res: http.IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        reject(new RelayClientError(`the relay answered with a redirect (${status}${res.headers.location ? ` to ${String(res.headers.location).slice(0, 120)}` : ""}): not followed`));
        return;
      }
      const chunks: Buffer[] = [];
      let n = 0;
      res.on("data", (c: Buffer) => {
        n += c.length;
        if (n > 8 * 1024 * 1024) {
          req.destroy();
          reject(new RelayClientError("the relay's reply is too large"));
        } else chunks.push(c);
      });
      res.on("end", () => resolve({ status, text: Buffer.concat(chunks).toString("utf-8") }));
      res.on("error", (e) => reject(new RelayClientError(e.message)));
    };
    const req = r.secure ? https.request(opts, onRes) : http.request(opts, onRes);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new RelayClientError(`the relay did not answer within ${Math.round(timeoutMs / 1000)}s`));
    });
    req.on("error", (e) => reject(new RelayClientError(`the relay could not be reached (${(e as NodeJS.ErrnoException).code ?? e.message})`)));
    req.end(body);
  });
}
/** The MCP tool result out of a /mcp reply (plain JSON or one SSE `data:` line), or null. */
export function mcpResultOf(text: string): { content?: Array<{ text?: string }>; isError?: boolean } | null {
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  try {
    const j = JSON.parse(line ? line.slice(5) : text) as { result?: unknown };
    return (j.result ?? null) as { content?: Array<{ text?: string }>; isError?: boolean } | null;
  } catch {
    return null;
  }
}

/** One line from a file in a remote's own scope (agents/remote-<host>-<port>/<name>), or null. */
async function scopedLine(host: string, port: number, name: string): Promise<string | null> {
  try {
    const { resolveInstance } = await import("../instance.js");
    const r = resolveInstance({});
    if (r.kind === "error") return null;
    const file = path.join(path.dirname(r.dbPath), "agents", remoteScope(host, String(port)), name);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return fs.readFileSync(file, "utf-8").split("\n")[0]!.trim();
  } catch {
    return null;
  }
}
/**
 * The agent token for a REMOTE (as ruled on #434): RELAY_AGENT_TOKEN ONLY when the SAME environment selected that
 * remote (RELAY_HTTP_HOST names it: `envSelected`), because a launcher-set token usually belongs to the LOCAL relay;
 * otherwise that remote's OWN vault entry (agents/remote-<host>-<port>/<agent>.token). Never the local vault.
 */
export async function remoteToken(host: string, port: number, agent: string, opts: { envSelected: boolean }): Promise<string | null> {
  const env = process.env.RELAY_AGENT_TOKEN;
  if (opts.envSelected && typeof env === "string" && /^[A-Za-z0-9_=.-]{8,128}$/.test(env)) return env;
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(agent)) return null;
  const t = await scopedLine(host, port, `${agent}.token`);
  return t !== null && /^[A-Za-z0-9_=.-]{8,128}$/.test(t) ? t : null;
}
/** Did the ENVIRONMENT select this remote (RELAY_HTTP_HOST names this host)? */
export const envSelects = (host: string): boolean => (process.env.RELAY_HTTP_HOST ?? "") === host;
/**
 * A REMOTE's transport secret (as ruled): its own provisioned file (`relay remote set-http-secret` /
 * `set-dashboard-secret`: agents/remote-<host>-<port>/<kind>.secret), else the environment (RELAY_HTTP_SECRET /
 * RELAY_DASHBOARD_SECRET). NEVER this machine's config.
 */
export async function remoteSecret(host: string, port: number, kind: "http" | "dashboard"): Promise<string | null> {
  const f = await scopedLine(host, port, `${kind}.secret`);
  if (f !== null && f.length >= 16 && /^[!-~]+$/.test(f)) return f;
  const env = kind === "http" ? process.env.RELAY_HTTP_SECRET : process.env.RELAY_DASHBOARD_SECRET;
  return env ? env : null;
}
export const randomId = () => crypto.randomBytes(8).toString("hex");
