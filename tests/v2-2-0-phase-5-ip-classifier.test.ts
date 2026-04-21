// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.0 Phase 5 — IP-classifier consolidation (bundled v2.1.7 Item 9).
 *
 * Asserts:
 *   - Every blocked range the pre-v2.2.0 url-safety.ts classifier rejected
 *     is still rejected after the cutover to src/ip-classifier.ts.
 *   - New unified `classifyIp` routes v4 vs v6 correctly.
 *   - IPv4-mapped IPv6 delegates to the v4 classifier (regression guard
 *     for the dotted-mixed form `::ffff:127.0.0.1` AND the all-hex form).
 *   - Invalid inputs are surfaced as blocked (fail-closed).
 */
import { describe, it, expect } from "vitest";
import {
  classifyIp,
  classifyIPv4,
  classifyIPv6,
  isBlockedForSsrf,
} from "../src/ip-classifier.js";

describe("v2.2.0 Phase 5 — classifyIp dispatch", () => {
  it("(C1) picks IPv4 branch for dotted quad", () => {
    const r = classifyIp("10.0.0.1");
    expect(r.blocked).toBe(true);
    expect(r.rule).toBe("10.0.0.0/8");
  });

  it("(C2) picks IPv6 branch for colon-separated literal", () => {
    const r = classifyIp("fe80::1");
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/link-local/);
  });

  it("(C3) invalid literal → blocked with explanatory rule", () => {
    const r = classifyIp("not-an-ip");
    expect(r.blocked).toBe(true);
    expect(r.rule).toBe("invalid");
  });

  it("(C4) public IPv4 passes", () => {
    expect(classifyIp("8.8.8.8").blocked).toBe(false);
    expect(classifyIp("203.0.113.1").blocked).toBe(false);
  });

  it("(C5) public IPv6 passes (outside 2001::/23 etc.)", () => {
    expect(classifyIp("2606:4700:4700::1111").blocked).toBe(false); // Cloudflare
    expect(classifyIp("2a00:1450:4001::64").blocked).toBe(false); // Google
  });
});

describe("v2.2.0 Phase 5 — IPv4 classifier (full coverage)", () => {
  const cases: Array<[string, string]> = [
    ["127.0.0.1", "127.0.0.0/8"],
    ["127.255.255.255", "127.0.0.0/8"],
    ["10.0.0.1", "10.0.0.0/8"],
    ["10.255.255.255", "10.0.0.0/8"],
    ["192.168.1.1", "192.168.0.0/16"],
    ["172.16.0.1", "172.16.0.0/12"],
    ["172.31.255.255", "172.16.0.0/12"],
    ["169.254.169.254", "169.254.0.0/16"],
    ["0.0.0.1", "0.0.0.0/8"],
    ["100.64.0.1", "100.64.0.0/10"],
    ["100.127.255.255", "100.64.0.0/10"],
    ["224.0.0.1", "224.0.0.0/4"],
    ["239.255.255.255", "224.0.0.0/4"],
    ["240.0.0.1", "240.0.0.0/4"],
  ];
  for (const [ip, cidr] of cases) {
    it(`(V4) ${ip} blocked by ${cidr}`, () => {
      const r = classifyIPv4(ip);
      expect(r.blocked).toBe(true);
      expect(r.rule).toBe(cidr);
    });
  }
  it("(V4) 8.8.8.8 and 1.1.1.1 pass", () => {
    expect(classifyIPv4("8.8.8.8").blocked).toBe(false);
    expect(classifyIPv4("1.1.1.1").blocked).toBe(false);
  });
});

describe("v2.2.0 Phase 5 — IPv6 classifier (full coverage)", () => {
  const cases: Array<[string, string]> = [
    ["::1", "::1/128"],
    ["::", "::/128"],
    ["fe80::1", "fe80::/10"],
    ["fe90::1", "fe80::/10"], // Codex regression
    ["fec0::1", "fec0::/is not in fe80::/10"], // SANITY: should NOT be blocked by fe80
    ["fc00::1", "fc00::/7"],
    ["fd00::1", "fc00::/7"],
    ["ff00::1", "ff00::/8"],
    ["ff7e::1", "ff00::/8"],
    ["64:ff9b::808:808", "64:ff9b::/96"],
    ["2001::1", "2001::/23"],
    ["2001:db8::1", "2001:db8::/32"],
  ];
  for (const [ip, expected] of cases) {
    if (expected.includes("is not in")) {
      it(`(V6) ${ip} is NOT in fe80::/10 (boundary sanity)`, () => {
        const r = classifyIPv6(ip);
        // fec0::/10 is not on the block list; expect either pass OR a
        // different rule matching — but NOT the fe80 match specifically.
        if (r.blocked) expect(r.rule).not.toBe("fe80::/10");
      });
    } else {
      it(`(V6) ${ip} blocked by ${expected}`, () => {
        const r = classifyIPv6(ip);
        expect(r.blocked).toBe(true);
        expect(r.rule).toBe(expected);
      });
    }
  }
  it("(V6) 2606:4700:: is public Cloudflare, NOT blocked", () => {
    expect(classifyIPv6("2606:4700:4700::1111").blocked).toBe(false);
  });
});

describe("v2.2.0 Phase 5 — IPv4-mapped IPv6 delegation", () => {
  it("(M1) ::ffff:127.0.0.1 → blocked as IPv4 loopback", () => {
    const r = classifyIPv6("::ffff:127.0.0.1");
    expect(r.blocked).toBe(true);
    expect(r.rule).toBe("127.0.0.0/8");
  });

  it("(M2) ::ffff:7f00:0001 (all-hex form of 127.0.0.1) → blocked", () => {
    const r = classifyIPv6("::ffff:7f00:1");
    expect(r.blocked).toBe(true);
    expect(r.rule).toBe("127.0.0.0/8");
  });

  it("(M3) ::ffff:8.8.8.8 → passes (public v4)", () => {
    expect(classifyIPv6("::ffff:8.8.8.8").blocked).toBe(false);
  });
});

describe("v2.2.0 Phase 5 — isBlockedForSsrf alias", () => {
  it("(A1) isBlockedForSsrf is the classifyIp entry point", () => {
    expect(isBlockedForSsrf("10.0.0.1").blocked).toBe(true);
    expect(isBlockedForSsrf("1.1.1.1").blocked).toBe(false);
    expect(isBlockedForSsrf("fe90::1").blocked).toBe(true);
  });
});
