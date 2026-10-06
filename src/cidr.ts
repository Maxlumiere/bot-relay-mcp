// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * IP addresses and CIDR blocks, CANONICAL at the boundary (PR-E; architect ruling 5dbd435b).
 *
 * The defect class (GHSA-jqcg-44mw-7w3h, proxy-addr < 2.0.8): an IPv4 address matched an IPv6 subnet
 * that does not genuinely cover the IPv4-mapped range, so a trust list could trust every client.
 * MEASURED here before this change: `::ffff:102:304` (1.2.3.4, the HEX spelling of a mapped address)
 * was inside `::/0`, `::/1` and `::/80`, while the dotted spelling was not: the verdict depended on how
 * the address was WRITTEN.
 *
 * So every address and every block is parsed ONCE into bytes and a family, and only bytes are compared:
 *   - ANY spelling of an IPv4-mapped address (dotted, hex, compressed, expanded, any case) IS that IPv4
 *     address, family 4.
 *   - An IPv4 address is inside an IPv6 block ONLY when that block is a genuine mapped block,
 *     ::ffff:0:0/96 or longer (it then IS an IPv4 block: prefix − 96). A shorter "mapped-looking" block
 *     (::ffff:10.0.0.0/8) is an IPv6 block and never contains an IPv4 address.
 *   - REJECTED, never guessed (null): a zone id (fe80::1%en0), the deprecated IPv4-COMPATIBLE range
 *     ::/96 other than :: and ::1 (::a.b.c.d), and anything not fully consumed by the parse.
 * A rejected input matches nothing. Each CONSUMER fails closed in its own direction: a trust list
 * does not trust it; the SSRF classifier (ip-classifier.ts) blocks it.
 *
 * Node's net.BlockList is NOT used: MEASURED (node v24.13.0), it puts 1.2.3.4 inside
 * ::ffff:10.0.0.0/8 (and ::/0, ::/1, ::/80), the exact class proxy-addr 2.0.8 fixed.
 */
import net from "net";

export interface CanonicalIp {
  family: 4 | 6;
  /** 4 bytes (family 4) or 16 bytes (family 6). */
  bytes: Uint8Array;
}
export interface CanonicalCidr extends CanonicalIp {
  /** 0–32 (family 4) or 0–128 (family 6). */
  prefix: number;
}

/** 16 bytes of an IPv6 literal Node accepts (with or without an embedded dotted IPv4 tail), or null. */
function ipv6Bytes(s: string): Uint8Array | null {
  let text = s.toLowerCase();
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    const v4 = text.slice(lastColon + 1);
    if (!net.isIPv4(v4)) return null;
    tail = v4.split(".").map(Number);
    text = text.slice(0, lastColon + 1) + "0:0"; // two placeholder groups, replaced below
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill("0"), ...rest];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const out = new Uint8Array(16);
  all.forEach((g, i) => {
    const v = parseInt(g, 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  });
  if (tail.length) out.set(tail, 12);
  return out;
}

const isMapped = (b: Uint8Array) => b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
/** ::/96 other than :: and ::1: the deprecated IPv4-compatible form. Ambiguous, so rejected. */
const isCompatible = (b: Uint8Array) =>
  b.slice(0, 12).every((x) => x === 0) && !(b[12] === 0 && b[13] === 0 && b[14] === 0 && (b[15] === 0 || b[15] === 1));

/** The 4 or 16 raw bytes an address literal spells (no mapping applied), or null. */
function rawBytes(input: string): { v4: boolean; bytes: Uint8Array } | null {
  let s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s.includes("%")) return null; // a zone id: never guessed
  if (net.isIPv4(s)) return { v4: true, bytes: Uint8Array.from(s.split(".").map(Number)) };
  if (!net.isIPv6(s)) return null;
  const b = ipv6Bytes(s);
  return b ? { v4: false, bytes: b } : null;
}

/** Parse ONE address, any spelling, to its canonical bytes and family; null when rejected. */
export function canonicalIp(input: string): CanonicalIp | null {
  const r = rawBytes(input);
  if (!r) return null;
  if (r.v4) return { family: 4, bytes: r.bytes };
  if (isMapped(r.bytes)) return { family: 4, bytes: r.bytes.slice(12) };
  if (isCompatible(r.bytes)) return null;
  return { family: 6, bytes: r.bytes };
}

/** Parse ONE block ("addr" or "addr/prefix"), any spelling; null when rejected. */
export function canonicalCidr(input: string): CanonicalCidr | null {
  const s = input.trim();
  if (!s) return null;
  const slash = s.indexOf("/");
  const addr = slash >= 0 ? s.slice(0, slash) : s;
  const pre = slash >= 0 ? s.slice(slash + 1) : null;
  if (pre !== null && !/^\d{1,3}$/.test(pre)) return null;
  const r = rawBytes(addr);
  if (!r) return null;
  if (r.v4) {
    const prefix = pre === null ? 32 : Number(pre);
    return prefix > 32 ? null : { family: 4, bytes: r.bytes, prefix };
  }
  const prefix = pre === null ? 128 : Number(pre);
  if (prefix > 128) return null;
  // A GENUINE mapped block (it covers the ::ffff marker) IS an IPv4 block.
  if (isMapped(r.bytes) && prefix >= 96) return { family: 4, bytes: r.bytes.slice(12), prefix: prefix - 96 };
  if (isCompatible(r.bytes)) return null;
  return { family: 6, bytes: r.bytes, prefix };
}

/** Is `ip` inside `block`? Bytes only; the families must be equal. */
export function cidrContains(block: CanonicalCidr, ip: CanonicalIp): boolean {
  if (block.family !== ip.family) return false;
  let bits = block.prefix;
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((block.bytes[i] & mask) !== (ip.bytes[i] & mask)) return false;
  }
  return true;
}

/** The ONE text form of a canonical address: dotted IPv4, or RFC 5952 compressed lowercase IPv6. */
export function formatIp(ip: CanonicalIp): string {
  if (ip.family === 4) return Array.from(ip.bytes).join(".");
  const g = Array.from({ length: 8 }, (_, i) => (ip.bytes[i * 2] << 8) | ip.bytes[i * 2 + 1]);
  let best = -1;
  let bestLen = 1; // RFC 5952: never compress a single zero group
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (best < 0) return hex.join(":");
  return `${hex.slice(0, best).join(":")}::${hex.slice(best + bestLen).join(":")}`;
}

/** Is `ip` inside `cidr`? false when either is rejected (a consumer that must fail CLOSED checks canonicalIp itself). */
export function ipInCidr(ip: string, cidr: string): boolean {
  const a = canonicalIp(ip);
  const b = canonicalCidr(cidr);
  return !!a && !!b && cidrContains(b, a);
}

const LOOPBACK_BLOCKS: readonly CanonicalCidr[] = [canonicalCidr("127.0.0.0/8")!, canonicalCidr("::1/128")!];

/**
 * Is a SOCKET PEER address loopback (127.0.0.0/8 or ::1), however it is written? The ONE predicate for
 * every surface that lets a loopback peer in without a credential: the HTTP dashboard gate and the
 * dashboard WebSocket gate (ADR-0015 L4). Canonical first, so ::ffff:127.0.0.1 and its hex spelling
 * ::ffff:7f00:1 are 127.0.0.1. Anything the parser rejects, and anything that is not an address (a
 * hostname such as "localhost", an absent peer), is NOT loopback: the gate fails closed.
 */
export function isLoopbackPeer(raw: string | null | undefined): boolean {
  const ip = typeof raw === "string" ? canonicalIp(raw) : null;
  return !!ip && LOOPBACK_BLOCKS.some((b) => cidrContains(b, ip));
}

/** Is `ip` inside ANY of `cidrs`? Rejected blocks are skipped. */
export function ipInAnyCidr(ip: string, cidrs: string[]): boolean {
  const a = canonicalIp(ip);
  if (!a) return false;
  for (const c of cidrs) {
    const b = canonicalCidr(c);
    if (b && cidrContains(b, a)) return true;
  }
  return false;
}
