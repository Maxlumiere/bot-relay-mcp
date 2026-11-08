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
import { sameFileIdentity } from "../file-identity.js";

export class RelayClientError extends Error {
  /** The socket error code when the relay could not be reached (e.g. ECONNREFUSED), for callers that branch on it. */
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

/** A pinned destination: the name (Host, TLS SNI) and the CHECKED address every byte goes to. */
export interface PinnedTarget {
  host: string;
  port: number;
  ip: string;
  secure: boolean;
}

export type RelayRoute =
  | { kind: "local"; ip: string }
  | { kind: "remote"; host: string; port: number; ip: string; secure: boolean }
  | { kind: "unresolved"; host: string; why: string; secs: number };

export async function routeFor(host: string, port: number, secure = false, timeoutMs = 2000): Promise<RelayRoute> {
  const c = await classifyHost(host, { timeoutMs });
  // #434 R1 P1: the CHECKED loopback address is kept, so a tunnel route pins every request to it (never re-resolved).
  if (c.kind === "loopback") return { kind: "local", ip: c.ip };
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

/** Host header for a pinned target: an IPv6 literal is bracketed (RFC 7230 §5.4). */
const hostHeader = (r: PinnedTarget): string => `${r.host.includes(":") ? `[${r.host}]` : r.host}:${r.port}`;
/**
 * ONE pinned request (#434 R1 P1, P2-2): to the CHECKED address (Host and TLS SNI keep the name), no redirect followed
 * (`followRedirect` false = a 3xx is a named failure), no proxy from the environment (a fresh agent), and an ABSOLUTE
 * deadline: the timer starts before the request and destroys it (and its response) on expiry, however the bytes
 * trickle; an AbortSignal cancels it the same way. Every path clears the timer.
 */
function pinnedRequest(
  r: PinnedTarget,
  method: "GET" | "POST",
  reqPath: string,
  headers: Record<string, string>,
  body: string | null,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  refuseRedirect: boolean,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let done = false;
    let req: http.ClientRequest | null = null;
    let res: http.IncomingMessage | null = null;
    const finish = (err: Error | null, value?: { status: number; text: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) {
        res?.destroy();
        req?.destroy();
        reject(err);
      } else resolve(value!);
    };
    const timer = setTimeout(() => finish(new RelayClientError(`the relay did not answer within ${timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`}`)), timeoutMs);
    const onAbort = () => finish(new RelayClientError("the request was cancelled (its caller's deadline)"));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const opts: https.RequestOptions = {
      host: r.ip,
      port: r.port,
      path: reqPath,
      method,
      agent: false, // a fresh agent: no keep-alive pool, and no proxy from the environment
      headers: { ...headers, Host: hostHeader(r), ...(body !== null ? { "Content-Length": Buffer.byteLength(body) } : {}) },
      ...(r.secure ? { servername: r.host.includes(":") ? undefined : r.host } : {}),
    };
    const onRes = (m: http.IncomingMessage) => {
      res = m;
      const status = m.statusCode ?? 0;
      if (refuseRedirect && status >= 300 && status < 400) {
        finish(new RelayClientError(`the relay answered with a redirect (${status}${m.headers.location ? ` to ${String(m.headers.location).slice(0, 120)}` : ""}): not followed`));
        return;
      }
      const chunks: Buffer[] = [];
      let n = 0;
      m.on("data", (c: Buffer) => {
        n += c.length;
        if (n > 8 * 1024 * 1024) finish(new RelayClientError("the relay's reply is too large"));
        else chunks.push(c);
      });
      m.on("end", () => finish(null, { status, text: Buffer.concat(chunks).toString("utf-8") }));
      m.on("error", (e) => finish(new RelayClientError(e.message)));
    };
    try {
      req = r.secure ? https.request(opts, onRes) : http.request(opts, onRes);
    } catch (e) {
      finish(new RelayClientError(`the relay could not be reached (${(e as Error).message})`));
      return;
    }
    req.on("error", (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      finish(new RelayClientError(`the relay could not be reached (${code ?? e.message})`, code));
    });
    req.end(body ?? undefined);
  });
}
/** A hardened POST to a REMOTE relay (or a trusted tunnel): pinned, no redirect, no proxy, an absolute deadline. */
export function remotePost(r: PinnedTarget, reqPath: string, headers: Record<string, string>, body: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  return pinnedRequest(r, "POST", reqPath, headers, body, timeoutMs, signal, true);
}
/**
 * EVERY CLI health probe (#434 R1 P2-5): GET /health, pinned like remotePost. It takes NO headers parameter, so it
 * cannot carry a credential (a recording row proves the bytes). A 3xx is returned as its status (never followed).
 */
export function healthGet(r: PinnedTarget, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  return pinnedRequest(r, "GET", "/health", {}, null, timeoutMs, signal, false);
}
/** healthGet by NAME: the host CHECKED first (src/host-class.ts), then pinned; an unresolved host is a named failure. */
export async function healthGetHost(host: string, port: number, timeoutMs: number, signal?: AbortSignal, secure = false): Promise<{ status: number; text: string }> {
  const bare = host.replace(/^\[|\]$/g, "");
  const c = await classifyHost(bare, { timeoutMs: Math.min(timeoutMs, 2000) });
  if (c.kind === "unresolved") throw new RelayClientError(`the host ${bare} did not resolve (${c.why})`);
  return healthGet({ host: bare, port, ip: c.ip, secure }, timeoutMs, signal);
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

let scopeReadHookForTests: (() => void) | null = null;
/** TEST ONLY: called after the chain is checked and before the file is opened (to replace the scope in between). */
export function _setScopeReadHookForTests(fn: (() => void) | null): void {
  scopeReadHookForTests = fn;
}
const euidNow = () => (typeof process.geteuid === "function" ? process.geteuid() : null);
/** A chain element's POSIX fault: a real directory / regular file, owned by this user, and private where it must be. */
function posixFault(p: string, st: fs.BigIntStats, kind: "agents" | "scope" | "file"): string | null {
  if (kind === "file" ? !st.isFile() : !st.isDirectory()) return `${p} is not a ${kind === "file" ? "regular file" : "real directory"}`;
  const euid = euidNow();
  if (euid !== null && st.uid !== BigInt(euid)) return `${p} is not owned by you`;
  // agents/ may be 0755 (the hooks' mkdir -p), but nobody else may WRITE it (no swapping a scope in); the scope and the
  // file are private (0700 / 0600: what both writers make them).
  const mask = kind === "agents" ? 0o022n : 0o077n;
  if ((st.mode & mask) !== 0n) return `${p} has mode 0${(Number(st.mode) & 0o777).toString(8)}: it is not private to you`;
  return null;
}
/**
 * One line from a file in a remote's OWN scope (agents/remote-<host>-<port>/<name>), or null when it does not exist.
 * #434 R1 P2-4: read through a TRUSTED chain: agents/ and the scope are real directories (a link, or a junction, is
 * refused: a scope linked to the local vault or to another remote's scope yields nothing); the file is opened without
 * following a link and must be the file its name names (one link); POSIX: each owned by this user, the scope and the
 * file private; after the read, the scope and agents/ must still be the directories that were checked (a replacement
 * in between is refused). Windows: the same link and identity checks (its ACLs are set by the writers, not re-read).
 * A refusal is NAMED on stderr and yields null (no credential is sent).
 */
async function scopedLine(host: string, port: number, name: string): Promise<string | null> {
  let agents: string;
  try {
    const { resolveInstance } = await import("../instance.js");
    const r = resolveInstance({});
    if (r.kind === "error") return null;
    agents = path.join(path.dirname(r.dbPath), "agents");
  } catch {
    return null;
  }
  const scope = path.join(agents, remoteScope(host, String(port)));
  const file = path.join(scope, name);
  const refuse = (why: string): null => {
    process.stderr.write(`relay: refusing the remote credential ${file}: ${why}\n`);
    return null;
  };
  const lst = (p: string): fs.BigIntStats | null => {
    try {
      return fs.lstatSync(p, { bigint: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  };
  let fd: number | null = null;
  try {
    const a0 = lst(agents);
    const s0 = lst(scope);
    const f0 = lst(file);
    if (a0 === null || s0 === null || f0 === null) return null;
    for (const [p, st] of [[agents, a0], [scope, s0], [file, f0]] as const) if (st.isSymbolicLink()) return refuse(`${p} is a link (or a junction): refused`);
    if (process.platform !== "win32") {
      const fault = posixFault(agents, a0, "agents") ?? posixFault(scope, s0, "scope");
      if (fault) return refuse(fault);
    } else if (!a0.isDirectory() || !s0.isDirectory()) return refuse(`${scope} is not a real directory`);
    if (!f0.isFile()) return refuse("not a regular file");
    scopeReadHookForTests?.();
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "EMLINK") return refuse("a link: refused");
      if (code === "ENOENT") return refuse("it was replaced while it was being read");
      throw err;
    }
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n) return refuse("not a regular file with one name");
    if (!sameFileIdentity(st, f0)) return refuse("it changed (was replaced) while it was being opened");
    if (process.platform !== "win32") {
      const fault = posixFault(file, st, "file");
      if (fault) return refuse(fault);
    }
    const text = fs.readFileSync(fd, "utf-8");
    // the chain is still the one that was checked (a directory swapped in between the check and the open is refused)
    const a1 = lst(agents);
    const s1 = lst(scope);
    if (a1 === null || s1 === null || !sameFileIdentity(a1, a0) || !sameFileIdentity(s1, s0)) return refuse("its directory was replaced while it was being read");
    return text.split("\n")[0]!.trim();
  } catch (err) {
    return refuse((err as Error).message);
  } finally {
    if (fd !== null) fs.closeSync(fd);
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
