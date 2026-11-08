// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE RELAY HOST CHECK (#433 Codex R1 P1-1): is a configured relay host this machine's loopback, a remote, or
 * unresolved? The hooks route credentials by the answer (a loopback port gets no bearer unless it is an opted-in
 * tunnel), so every spelling of loopback must be caught:
 * - literals are NORMALIZED by the WHATWG URL host parser (the same one a client uses): every numeric IPv4 form
 *   (2130706433, 0x7f.1, 127.1, 0177.0.0.1) and every IPv6 spelling (::ffff:127.0.0.1, ::ffff:7f00:1, 0:0:0:0:0:0:0:1);
 *   IPv4-mapped IPv6 is classified by its IPv4 part; a trailing dot and case are ignored; "localhost" and
 *   "*.localhost" are loopback by name (RFC 6761);
 * - a NAME is resolved (every address) under a deadline: ANY loopback address makes it loopback (a client could
 *   connect to it); no address, an error or the deadline = unresolved (fail closed: no credential);
 * - a remote carries the CHECKED address, so the caller can pin its client to it (curl --resolve) and a second
 *   resolution cannot send the credential elsewhere.
 */
import dns from "dns";
import net from "net";

export type HostClass = { kind: "loopback" | "remote"; ip: string } | { kind: "unresolved"; why: string };

function v4Loopback(ip: string): boolean {
  return ip.startsWith("127.") || ip === "0.0.0.0";
}
/** The 8 groups of a canonical IPv6 address (the URL parser's output), or null. */
function v6Groups(ip: string): number[] | null {
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, null];
  const part = (s: string | null | undefined) => (s ? s.split(":").filter((x) => x.length > 0) : []);
  const h = part(head);
  const t = tail === null ? [] : part(tail);
  const fill = tail === null ? 0 : 8 - h.length - t.length;
  const all = [...h, ...Array(Math.max(0, fill)).fill("0"), ...t];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}
export function isLoopbackIp(ip: string): boolean {
  if (net.isIPv4(ip)) return v4Loopback(ip);
  if (!net.isIPv6(ip)) return false;
  const g = v6Groups(canonicalV6(ip) ?? ip.toLowerCase());
  if (!g) return false;
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 1 || g[7] === 0)) return true; // ::1, ::
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return v4Loopback(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`); // IPv4-mapped
  }
  return false;
}
function canonicalV6(ip: string): string | null {
  try {
    const h = new URL(`http://[${ip}]/`).hostname;
    return h.startsWith("[") ? h.slice(1, -1) : h;
  } catch {
    return null;
  }
}
/** A literal address, normalized (IPv4 dotted quad, or canonical IPv6), or null for a name. */
export function normalizeLiteral(host: string): string | null {
  let h = host.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (net.isIPv6(h)) return canonicalV6(h) ?? h;
  try {
    const n = new URL(`http://${h}/`).hostname;
    if (net.isIPv4(n)) return n;
  } catch {
    return null;
  }
  return null;
}

export interface ClassifyOptions {
  /** Every address a name resolves to (default: dns.lookup, all families). */
  lookup?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
}
const defaultLookup = (host: string): Promise<string[]> =>
  new Promise((resolve, reject) => dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs.map((a) => a.address)))));

export async function classifyHost(host: string, o: ClassifyOptions = {}): Promise<HostClass> {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) return { kind: "loopback", ip: "127.0.0.1" };
  const lit = normalizeLiteral(host);
  if (lit !== null) return { kind: isLoopbackIp(lit) ? "loopback" : "remote", ip: lit };
  if (!/^[a-z0-9._-]{1,253}$/.test(name)) return { kind: "unresolved", why: "not a host name" };
  const timeoutMs = o.timeoutMs ?? 2000;
  let timer: NodeJS.Timeout | undefined;
  try {
    const addrs = await Promise.race([
      (o.lookup ?? defaultLookup)(name),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    const norm = addrs.map((a) => normalizeLiteral(a) ?? a);
    if (norm.length === 0) return { kind: "unresolved", why: "the name has no address" };
    const loop = norm.find((a) => isLoopbackIp(a));
    if (loop !== undefined) return { kind: "loopback", ip: loop };
    return { kind: "remote", ip: norm[0]! };
  } catch (err) {
    return { kind: "unresolved", why: (err as Error).message.slice(0, 120) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
