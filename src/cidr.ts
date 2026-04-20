// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Minimal CIDR matcher for IPv4 and IPv6.
 *
 * Used by the HTTP transport to decide whether a direct socket peer is a
 * trusted reverse proxy (and therefore whether X-Forwarded-For should be
 * honored). Anything that mis-parses is treated as NOT a match — fail closed.
 */

import net from "net";

/**
 * Parse an IPv4 address into a single 32-bit integer.
 * Returns null on invalid input.
 */
function ipv4ToInt(addr: string): number | null {
  if (net.isIPv4(addr) !== true) return null;
  const parts = addr.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4) return null;
  return (
    ((parts[0] << 24) >>> 0) +
    ((parts[1] << 16) >>> 0) +
    ((parts[2] << 8) >>> 0) +
    (parts[3] >>> 0)
  ) >>> 0;
}

/**
 * Expand an IPv6 address into its 128-bit representation as a BigInt.
 * Returns null on invalid input.
 */
function ipv6ToBigInt(addr: string): bigint | null {
  if (net.isIPv6(addr) !== true) return null;
  // Strip any zone index (%eth0)
  const clean = addr.split("%")[0];

  let left: string[];
  let right: string[];
  if (clean.includes("::")) {
    const [l, r] = clean.split("::");
    left = l.length > 0 ? l.split(":") : [];
    right = r.length > 0 ? r.split(":") : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    left = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    left = clean.split(":");
    if (left.length !== 8) return null;
  }

  let result = 0n;
  for (const group of left) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    result = (result << 16n) | BigInt(parseInt(group, 16));
  }
  return result;
}

/**
 * Check whether an IP address (v4 or v6) falls within a CIDR block.
 * Supports: "192.168.1.0/24", "10.0.0.0/8", "fd00::/8", "::1/128", single-IP allowlist (no slash).
 */
/**
 * If an IPv6 literal is the IPv4-mapped form (::ffff:0:0/96, RFC 4291 §2.5.5.2),
 * return the embedded IPv4 address. Handles all compression forms:
 *   - Textual dotted: ::ffff:1.2.3.4
 *   - Compressed hex: ::ffff:0102:0304
 *   - Fully-expanded: 0:0:0:0:0:ffff:0102:0304
 *   - Any intermediate: 0:0::ffff:0102:0304
 *
 * Returns null for IPv6 forms that are NOT IPv4-mapped, including:
 *   - IPv4-compatible ::1.2.3.4 (deprecated, RFC 4291 §2.5.5.1). Semantically
 *     different — this is a legacy transition mechanism, not the mapped form
 *     the OS returns for dual-stack IPv4 clients. Treating it as mapped would
 *     wrongly grant IPv4 CIDR trust to pure IPv6 callers.
 *   - NAT64 64:ff9b::1.2.3.4 (RFC 6052). Also a transition mechanism with
 *     different semantics; do not treat as IPv4.
 *
 * This is how the OS surfaces IPv4 connections on dual-stack sockets, so
 * matching against IPv4 CIDR rules must account for it.
 */
function ipv4FromMappedIPv6(addr: string): string | null {
  if (!net.isIPv6(addr)) return null;
  const clean = addr.toLowerCase().split("%")[0];

  // Mixed-dotted form path: address contains a dot. Split off the IPv4 tail
  // and verify the IPv6 prefix is exactly the all-zero + ffff structure.
  if (clean.includes(".")) {
    // Find the last colon — everything after it should be the dotted IPv4.
    const lastColon = clean.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4Part = clean.slice(lastColon + 1);
    const ipv6Prefix = clean.slice(0, lastColon); // does NOT include the trailing colon

    if (!net.isIPv4(ipv4Part)) return null;

    // The prefix must end with 'ffff' as the 6th hex group (positions 0..5 are zeros).
    // Accepted forms for the prefix:
    //   "::ffff"                               compressed all-zero prefix + ffff
    //   "0:0:0:0:0:ffff"                       fully expanded
    //   "0:0::ffff"                            partial compression
    //   intermediate zero-padded variants
    if (!isAllZeroPlusFfffPrefix(ipv6Prefix)) return null;
    return ipv4Part;
  }

  // All-hex form: expand fully to 8 groups and check the structural pattern.
  const groups = expandIPv6ToGroups(clean);
  if (!groups) return null;
  // IPv4-mapped pattern: [0, 0, 0, 0, 0, 0xffff, hi, lo]
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
    groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff
  ) {
    const hi = groups[6];
    const lo = groups[7];
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (net.isIPv4(ipv4)) return ipv4;
  }
  return null;
}

/**
 * Verify a hex-only IPv6 prefix string (the part BEFORE the dotted IPv4) is
 * structurally equivalent to "0:0:0:0:0:ffff" — the 96-bit IPv4-mapped prefix.
 * Accepts compression and full-expansion forms.
 */
function isAllZeroPlusFfffPrefix(prefix: string): boolean {
  if (prefix.length === 0) return false; // can't be empty when followed by IPv4

  // Synthesize a fake all-hex IPv6 address by appending ":0:0" so we can reuse
  // the standard 8-group expander, then check that the first 6 groups are
  // [0,0,0,0,0,0xffff] (the trailing two groups are placeholder).
  const padded = prefix + ":0:0";
  const groups = expandIPv6ToGroups(padded);
  if (!groups) return false;
  return (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
    groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff
  );
}

/**
 * Expand an IPv6 address (possibly containing :: compression) to an array of
 * 8 16-bit integers. Returns null if the address is malformed or contains
 * mixed-dotted form (which must be handled separately before this).
 */
function expandIPv6ToGroups(addr: string): number[] | null {
  if (addr.includes(".")) return null; // mixed-dotted handled separately
  let left: string[];
  let right: string[];
  if (addr.includes("::")) {
    const [l, r] = addr.split("::");
    left = l.length > 0 ? l.split(":") : [];
    right = r.length > 0 ? r.split(":") : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    left = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    left = addr.split(":");
    if (left.length !== 8) return null;
  }
  const out: number[] = [];
  for (const g of left) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}


export function ipInCidr(ip: string, cidr: string): boolean {
  // Trim both inputs symmetrically (v1.7 gate fix — previously only CIDR was trimmed,
  // so `ipInCidr("1.2.3.4 ", "1.2.3.0/24")` with a trailing space returned false).
  // Then strip any zone index or brackets from the IP.
  const cleanIp = ip.trim().replace(/^\[|\]$/g, "").split("%")[0];
  const cleanCidr = cidr.trim();
  if (!cleanCidr) return false;

  const slashIdx = cleanCidr.indexOf("/");
  const rangeAddr = slashIdx >= 0 ? cleanCidr.slice(0, slashIdx) : cleanCidr;
  const rangePrefixStr = slashIdx >= 0 ? cleanCidr.slice(slashIdx + 1) : null;

  // --- IPv4-mapped IPv6 normalization (v1.6.3) ---
  // Handle the cross-family cases where an operator wrote a rule in one
  // family and a client connected using the mapped form of the other.
  // Both sides can be in the mapped form, so we normalize symmetrically.
  const mappedIp = ipv4FromMappedIPv6(cleanIp);
  const mappedRange = ipv4FromMappedIPv6(rangeAddr);

  // Client arrived as ::ffff:1.2.3.4, operator wrote an IPv4 rule — compare as IPv4
  if (mappedIp && net.isIPv4(rangeAddr)) {
    return ipInCidr(mappedIp, cleanCidr);
  }
  // Client is IPv4, operator wrote ::ffff:1.2.3.0/120 — extract and compare as IPv4
  // A /120 on the mapped block corresponds to /24 on the embedded IPv4 (128 - 120 = 8 host bits).
  if (net.isIPv4(cleanIp) && mappedRange && rangePrefixStr !== null) {
    const v6Prefix = parseInt(rangePrefixStr, 10);
    if (isNaN(v6Prefix) || v6Prefix < 96 || v6Prefix > 128) return false; // out of mapped range
    const v4Prefix = v6Prefix - 96;
    return ipInCidr(cleanIp, `${mappedRange}/${v4Prefix}`);
  }
  // Both are mapped — normalize both to IPv4 and compare
  if (mappedIp && mappedRange) {
    const v6Prefix = rangePrefixStr === null ? 128 : parseInt(rangePrefixStr, 10);
    if (isNaN(v6Prefix) || v6Prefix < 96 || v6Prefix > 128) return false;
    const v4Prefix = v6Prefix - 96;
    return ipInCidr(mappedIp, `${mappedRange}/${v4Prefix}`);
  }

  // IPv4 path
  if (net.isIPv4(cleanIp) && net.isIPv4(rangeAddr)) {
    const ipInt = ipv4ToInt(cleanIp);
    const rangeInt = ipv4ToInt(rangeAddr);
    if (ipInt === null || rangeInt === null) return false;
    const prefix = rangePrefixStr === null ? 32 : parseInt(rangePrefixStr, 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;
    if (prefix === 0) return true;
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return (ipInt & mask) === (rangeInt & mask);
  }

  // IPv6 path
  if (net.isIPv6(cleanIp) && net.isIPv6(rangeAddr)) {
    const ipBig = ipv6ToBigInt(cleanIp);
    const rangeBig = ipv6ToBigInt(rangeAddr);
    if (ipBig === null || rangeBig === null) return false;
    const prefix = rangePrefixStr === null ? 128 : parseInt(rangePrefixStr, 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 128) return false;
    if (prefix === 0) return true;
    const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
    return (ipBig & mask) === (rangeBig & mask);
  }

  // Cross-family comparisons (excluding the mapped-form cases above) never match
  return false;
}

/**
 * Given an IP and a list of CIDR blocks, return true if the IP is in ANY block.
 * Malformed CIDR entries are skipped silently (logged by the caller if desired).
 */
export function ipInAnyCidr(ip: string, cidrs: string[]): boolean {
  for (const cidr of cidrs) {
    if (ipInCidr(ip, cidr)) return true;
  }
  return false;
}
