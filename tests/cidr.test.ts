// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect } from "vitest";
import { ipInCidr, ipInAnyCidr } from "../src/cidr.js";

describe("IPv4 CIDR matching", () => {
  it("matches exact IP with no prefix", () => {
    expect(ipInCidr("192.168.1.1", "192.168.1.1")).toBe(true);
    expect(ipInCidr("192.168.1.2", "192.168.1.1")).toBe(false);
  });

  it("matches /24 block", () => {
    expect(ipInCidr("192.168.1.1", "192.168.1.0/24")).toBe(true);
    expect(ipInCidr("192.168.1.255", "192.168.1.0/24")).toBe(true);
    expect(ipInCidr("192.168.2.1", "192.168.1.0/24")).toBe(false);
  });

  it("matches /8 block (private class A)", () => {
    expect(ipInCidr("10.0.0.1", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("10.255.255.255", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("11.0.0.1", "10.0.0.0/8")).toBe(false);
  });

  it("/0 matches everything", () => {
    expect(ipInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(ipInCidr("255.255.255.255", "0.0.0.0/0")).toBe(true);
  });

  it("/32 only matches exact IP", () => {
    expect(ipInCidr("192.168.1.1", "192.168.1.1/32")).toBe(true);
    expect(ipInCidr("192.168.1.2", "192.168.1.1/32")).toBe(false);
  });

  it("rejects invalid input", () => {
    expect(ipInCidr("not-an-ip", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("10.0.0.1", "not-a-cidr")).toBe(false);
    expect(ipInCidr("10.0.0.1", "10.0.0.0/99")).toBe(false);
    expect(ipInCidr("10.0.0.1", "10.0.0.0/-1")).toBe(false);
    expect(ipInCidr("10.0.0.1", "")).toBe(false);
  });
});

describe("IPv6 CIDR matching", () => {
  it("matches loopback ::1/128", () => {
    expect(ipInCidr("::1", "::1/128")).toBe(true);
    expect(ipInCidr("::1", "::1")).toBe(true);
    expect(ipInCidr("::2", "::1/128")).toBe(false);
  });

  it("matches fd00::/8 unique-local block", () => {
    expect(ipInCidr("fd12:3456:789a::1", "fd00::/8")).toBe(true);
    expect(ipInCidr("fc00::1", "fd00::/8")).toBe(false);
  });

  it("matches fe80::/10 link-local", () => {
    expect(ipInCidr("fe80::1", "fe80::/10")).toBe(true);
    expect(ipInCidr("fe80::abcd:1234", "fe80::/10")).toBe(true);
    expect(ipInCidr("fec0::1", "fe80::/10")).toBe(false);
  });

  it("/0 matches everything IPv6", () => {
    expect(ipInCidr("2001:db8::1", "::/0")).toBe(true);
    expect(ipInCidr("::", "::/0")).toBe(true);
  });

  it("strips zone index", () => {
    expect(ipInCidr("fe80::1%eth0", "fe80::/10")).toBe(true);
  });
});

describe("cross-family never matches (except IPv4-mapped IPv6)", () => {
  it("IPv4 in IPv6 CIDR returns false", () => {
    expect(ipInCidr("192.168.1.1", "fd00::/8")).toBe(false);
  });

  it("regular IPv6 in IPv4 CIDR returns false", () => {
    expect(ipInCidr("::1", "127.0.0.0/8")).toBe(false);
  });

  it("regular IPv6 does NOT match an IPv4 rule (v1.6.3 guard)", () => {
    // Explicit guard that non-mapped IPv6 stays non-matching
    expect(ipInCidr("2001:db8::1", "1.2.3.0/24")).toBe(false);
  });
});

describe("IPv4-mapped IPv6 normalization (v1.6.3, RFC 7239 §7.4)", () => {
  it("::ffff:1.2.3.4 matches 1.2.3.0/24", () => {
    expect(ipInCidr("::ffff:1.2.3.4", "1.2.3.0/24")).toBe(true);
  });

  it("1.2.3.4 matches ::ffff:1.2.3.0/120", () => {
    // /120 on the ::ffff:0:0/96 mapped block corresponds to /24 on embedded IPv4
    expect(ipInCidr("1.2.3.4", "::ffff:1.2.3.0/120")).toBe(true);
  });

  it("::ffff:1.2.3.4 does NOT match 5.6.7.0/24", () => {
    expect(ipInCidr("::ffff:1.2.3.4", "5.6.7.0/24")).toBe(false);
  });

  it("::ffff:1.2.3.4 matches ::ffff:1.2.3.0/120 (both mapped)", () => {
    expect(ipInCidr("::ffff:1.2.3.4", "::ffff:1.2.3.0/120")).toBe(true);
  });

  it("::ffff:1.2.3.4 matches exact ::ffff:1.2.3.4 (mapped both sides)", () => {
    expect(ipInCidr("::ffff:1.2.3.4", "::ffff:1.2.3.4")).toBe(true);
  });

  it("::ffff:1.2.3.4 matches 10.0.0.0/8 when embedded IP is 10.x", () => {
    expect(ipInCidr("::ffff:10.5.5.5", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("::ffff:11.5.5.5", "10.0.0.0/8")).toBe(false);
  });

  it("hex form ::ffff:0102:0304 (= 1.2.3.4) matches IPv4 rule", () => {
    // 0x0102 = 1.2, 0x0304 = 3.4
    expect(ipInCidr("::ffff:0102:0304", "1.2.3.0/24")).toBe(true);
  });

  it("ipInAnyCidr works with mapped IPv6 against IPv4 list", () => {
    const list = ["10.0.0.0/8", "192.168.0.0/16"];
    expect(ipInAnyCidr("::ffff:10.5.5.5", list)).toBe(true);
    expect(ipInAnyCidr("::ffff:8.8.8.8", list)).toBe(false);
  });

  // v1.6.4: fully-expanded and intermediate-compression forms
  it("fully-expanded 0:0:0:0:0:ffff:0102:0304 matches 1.2.3.0/24", () => {
    expect(ipInCidr("0:0:0:0:0:ffff:0102:0304", "1.2.3.0/24")).toBe(true);
  });

  it("fully-expanded form behaves identically to compressed ::ffff: form", () => {
    const rules = ["1.2.3.0/24", "10.0.0.0/8", "5.6.7.0/24"];
    for (const rule of rules) {
      const full = ipInCidr("0:0:0:0:0:ffff:0102:0304", rule);
      const compressed = ipInCidr("::ffff:0102:0304", rule);
      expect(full).toBe(compressed);
    }
  });
});

describe("input whitespace handling (v1.7 gate fix)", () => {
  it("trims whitespace from both IP and CIDR symmetrically", () => {
    // Before v1.7, only the CIDR was trimmed. Trailing space on the IP caused false negatives.
    expect(ipInCidr("192.168.1.1 ", "192.168.1.0/24")).toBe(true);
    expect(ipInCidr(" 192.168.1.1", "192.168.1.0/24")).toBe(true);
    expect(ipInCidr("192.168.1.1", " 192.168.1.0/24 ")).toBe(true);
    expect(ipInCidr("::ffff:1.2.3.4 ", "1.2.3.0/24")).toBe(true);
  });
});

describe("adversarial IPv6 forms — intentionally NOT treated as IPv4-mapped (v1.6.4)", () => {
  it("IPv4-compatible ::1.2.3.4 does NOT match 1.2.3.0/24 (RFC 4291 §2.5.5.1 deprecated)", () => {
    // IPv4-compatible IPv6 has a DIFFERENT semantic meaning from IPv4-mapped
    // (deprecated transition mechanism vs dual-stack surfacing). Treating it
    // as mapped would incorrectly grant IPv4 CIDR trust to pure IPv6 callers.
    expect(ipInCidr("::1.2.3.4", "1.2.3.0/24")).toBe(false);
  });

  it("NAT64 prefix 64:ff9b::1.2.3.4 does NOT match 1.2.3.0/24 (RFC 6052)", () => {
    // NAT64 is a transition mechanism with its own semantics. A 64:ff9b::x.x.x.x
    // address is an IPv6 representation of a translated IPv4 destination; it is
    // NOT the mapped form the OS returns for an incoming IPv4 client.
    expect(ipInCidr("64:ff9b::1.2.3.4", "1.2.3.0/24")).toBe(false);
  });
});

describe("ipInAnyCidr", () => {
  it("returns true if any CIDR matches", () => {
    const list = ["10.0.0.0/8", "192.168.0.0/16", "::1/128"];
    expect(ipInAnyCidr("10.1.2.3", list)).toBe(true);
    expect(ipInAnyCidr("192.168.5.5", list)).toBe(true);
    expect(ipInAnyCidr("::1", list)).toBe(true);
  });

  it("returns false if no CIDR matches", () => {
    expect(ipInAnyCidr("8.8.8.8", ["10.0.0.0/8", "192.168.0.0/16"])).toBe(false);
  });

  it("empty list returns false", () => {
    expect(ipInAnyCidr("10.0.0.1", [])).toBe(false);
  });

  it("malformed entries are silently skipped", () => {
    expect(ipInAnyCidr("10.0.0.1", ["not-a-cidr", "10.0.0.0/8"])).toBe(true);
    expect(ipInAnyCidr("10.0.0.1", ["not-a-cidr", "also-garbage"])).toBe(false);
  });
});
