// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR-E: addresses and trust blocks are CANONICAL at the boundary (architect ruling 5dbd435b). The class
 * is GHSA-jqcg-44mw-7w3h (proxy-addr < 2.0.8): an IPv4 address matched an IPv6 trust block that does not
 * cover the IPv4-mapped range. MEASURED here before PR-E: `::ffff:102:304` (1.2.3.4 spelled in hex) was
 * inside ::/0, ::/1 and ::/80 while the dotted spelling was not: the verdict depended on the SPELLING.
 *
 * The guard is a SPELLING-INVARIANCE property: the verdict for an address and a block is identical for
 * every spelling of either, plus the measured matrix in both trusted-proxy directions, the rejections
 * (each failing closed in its consumer's direction), and extractSourceIp end to end.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { Request } from "express";
import { canonicalCidr, canonicalIp, formatIp, ipInAnyCidr, ipInCidr, isLoopbackPeer } from "../src/cidr.js";
import { classifyIp, classifyIPv6 } from "../src/ip-classifier.js";
import { extractSourceIp } from "../src/transport/http.js";

const hex = (n: number) => n.toString(16);
/** Every spelling of an IPv4 address: dotted, mapped (dotted, hex, uppercase, expanded, bracketed). */
function v4Spellings(o: number[]): string[] {
  const [a, b, c, d] = o;
  const dotted = o.join(".");
  const hi = hex((a << 8) | b);
  const lo = hex((c << 8) | d);
  return [
    dotted,
    `::ffff:${dotted}`,
    `::FFFF:${dotted}`,
    `::ffff:${hi}:${lo}`,
    `::FFFF:${hi.toUpperCase()}:${lo.toUpperCase()}`,
    `0:0:0:0:0:ffff:${hi}:${lo}`,
    `0000:0000:0000:0000:0000:ffff:${dotted}`,
    `[::ffff:${dotted}]`,
  ];
}
/** Every spelling of an IPv6 address given as 8 groups: compressed, expanded, padded, uppercase, bracketed. */
function v6Spellings(g: number[]): string[] {
  const full = g.map(hex).join(":");
  const padded = g.map((x) => hex(x).padStart(4, "0")).join(":");
  const compressed = formatIp({ family: 6, bytes: Uint8Array.from(g.flatMap((x) => [x >> 8, x & 0xff])) });
  return [full, padded, compressed, compressed.toUpperCase(), `[${compressed}]`];
}

const BLOCKS = [
  "::/0", "::/1", "::/80", "::ffff:10.0.0.0/8", "::ffff:10.0.0.0/104", "::ffff:0:0/96",
  "::ffff:a00:0/104", "2001:db8::/32", "10.0.0.0/8", "0.0.0.0/0", "fe80::/10", "1.2.3.0/24",
];

describe("the measured matrix: an IPv4 address matches an IPv6 block ONLY when it is a genuine mapped block (/96 or longer)", () => {
  const cases: Array<[string, string, boolean]> = [
    // the spoof direction: NEVER trusted
    ["1.2.3.4", "::ffff:10.0.0.0/8", false],
    ["1.2.3.4", "::/0", false],
    ["1.2.3.4", "::/1", false],
    ["::ffff:1.2.3.4", "::/80", false],
    ["::ffff:102:304", "::/0", false], // was TRUE before PR-E (the hex spelling)
    ["::ffff:102:304", "::/1", false], // was TRUE
    ["::ffff:102:304", "::/80", false], // was TRUE
    ["0:0:0:0:0:ffff:102:304", "::/0", false], // was TRUE
    ["::ffff:1.2.3.4", "2001:db8::/32", false],
    // the trusted-proxy direction: STILL trusted, whatever the spelling
    ["::ffff:10.1.2.3", "10.0.0.0/8", true],
    ["::ffff:a01:203", "10.0.0.0/8", true],
    ["10.1.2.3", "::ffff:10.0.0.0/104", true],
    ["::ffff:10.1.2.3", "::ffff:10.0.0.0/104", true],
    ["10.1.2.3", "::ffff:0:0/96", true],
    ["::ffff:11.0.0.1", "10.0.0.0/8", false],
    // plain IPv6 is unchanged
    ["2001:db8::1", "2001:db8::/32", true],
    ["2001:db8::1", "::/0", true],
  ];
  for (const [ip, block, want] of cases) {
    it(`${ip} in ${block} → ${want}`, () => expect(ipInCidr(ip, block)).toBe(want));
  }
});

describe("SPELLING INVARIANCE (property): one verdict for every spelling of the address and of the block", () => {
  it("IPv4 addresses, every spelling, against every block (and every spelling of the mapped blocks)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 4, maxLength: 4 }), fc.constantFrom(...BLOCKS), (o, block) => {
        const verdicts = new Set(v4Spellings(o).map((s) => ipInCidr(s, block)));
        expect(verdicts.size, `${o.join(".")} vs ${block}: ${[...verdicts]}`).toBe(1);
      }),
      { numRuns: 400 },
    );
  });
  it("IPv6 addresses (non-mapped), every spelling, against every block", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 8, maxLength: 8 }).filter((g) => !(g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0))),
        fc.constantFrom(...BLOCKS),
        (g, block) => {
          const verdicts = new Set(v6Spellings(g).map((s) => ipInCidr(s, block)));
          expect(verdicts.size, `${g.map(hex).join(":")} vs ${block}`).toBe(1);
        },
      ),
      { numRuns: 400 },
    );
  });
  it("a BLOCK spelled every way gives one verdict (10.0.0.0/8 ≡ ::ffff:10.0.0.0/104 ≡ ::ffff:a00:0/104)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 4, maxLength: 4 }), (o) => {
        const verdicts = new Set(["10.0.0.0/8", "::ffff:10.0.0.0/104", "::ffff:a00:0/104", "0:0:0:0:0:ffff:a00:0/104"].map((b) => ipInCidr(o.join("."), b)));
        expect(verdicts.size).toBe(1);
      }),
      { numRuns: 300 },
    );
  });
});

describe("REJECTED, never guessed: matches nothing; each consumer fails CLOSED in its own direction", () => {
  const rejected = ["fe80::1%eth0", "::1.2.3.4", "::102:304", "1.2.3", "1.2.3.4.5", "1.2.3.4x", "", "::ffff:1.2.3", "garbage"];
  it("canonicalIp rejects every ambiguous or partial form", () => {
    for (const r of rejected) expect(canonicalIp(r), r).toBeNull();
    expect(canonicalCidr("::1.2.3.0/120")).toBeNull(); // an IPv4-compatible block
    expect(canonicalCidr("10.0.0.0/33")).toBeNull();
    expect(canonicalCidr("::/129")).toBeNull();
    expect(canonicalCidr("10.0.0.0/8x")).toBeNull();
  });
  it("a TRUST list never trusts one: no block contains a rejected address", () => {
    for (const r of rejected) for (const b of [...BLOCKS, "fe80::1/128"]) expect(ipInCidr(r, b), `${r} in ${b}`).toBe(false);
  });
  it("the SSRF classifier BLOCKS one (fail closed), even when Node calls it a valid IP", () => {
    for (const r of ["fe80::1%eth0", "::127.0.0.1", "::7f00:1"]) {
      expect(classifyIp(r).blocked, r).toBe(true);
      expect(classifyIPv6(r).blocked, `classifyIPv6 ${r}`).toBe(true); // exported on its own: guarded there
    }
    // ...and still blocks the mapped spellings of private addresses, allows a public one
    for (const s of v4Spellings([169, 254, 169, 254]).filter((x) => !x.startsWith("["))) expect(classifyIp(s).blocked, s).toBe(true);
    expect(classifyIp("8.8.8.8").blocked).toBe(false);
    expect(classifyIp("::ffff:808:808").blocked).toBe(false);
  });
});

describe("canonicalIp parses EXACTLY one literal (Codex PR307 P3): the credential-less loopback gate takes nothing else", () => {
  // MEASURED before: canonicalIp(" 127.0.0.1 ") and canonicalIp("[127.0.0.1]") were 127.0.0.1, so the
  // "anything not fully consumed is rejected" guarantee did not hold. No bypass was found (the gates read the
  // kernel's socket address, which is never padded or bracketed), so this pins the CONTRACT the gates rely on.
  const loose = [" 127.0.0.1", "127.0.0.1 ", "127.0.0.1\n", "\t::1", "[127.0.0.1]", "[::1]", "[::ffff:127.0.0.1]", " 127.0.0.1"];
  it("HARM refused: padded or bracketed text is not an address, and is not loopback", () => {
    for (const s of loose) {
      expect(canonicalIp(s), JSON.stringify(s)).toBeNull();
      expect(isLoopbackPeer(s), JSON.stringify(s)).toBe(false);
    }
  });
  it("TWIN: every exact spelling of loopback still is loopback", () => {
    for (const s of ["127.0.0.1", "127.255.0.9", "::1", "::ffff:127.0.0.1", "::FFFF:7f00:1", "0:0:0:0:0:0:0:1"]) {
      expect(isLoopbackPeer(s), s).toBe(true);
    }
  });
  it("the list helpers keep their documented operator tolerance (trim, one bracket pair): unchanged", () => {
    expect(ipInCidr(" 192.168.1.1", "192.168.1.0/24")).toBe(true);
    expect(ipInCidr("[::1]", "::1/128")).toBe(true);
    expect(ipInAnyCidr(" 10.0.0.1 ", ["10.0.0.0/8"])).toBe(true);
    expect(canonicalCidr(" 10.0.0.0/8 ")).not.toBeNull();
    expect(canonicalCidr("[::1]/128")).not.toBeNull();
  });
  it("a padded or bracketed SOCKET peer is never trusted as a proxy, and is returned as received", () => {
    const r = (peer: string) => ({ socket: { remoteAddress: peer }, headers: { "x-forwarded-for": "6.6.6.6" } }) as unknown as Request;
    for (const peer of [" 10.1.2.3", "[10.1.2.3]"]) expect(extractSourceIp(r(peer), ["10.0.0.0/8"]), peer).toBe(peer);
  });
});

describe("extractSourceIp: canonical at the boundary, both trusted-proxy directions", () => {
  const req = (peer: string, xff?: string) => ({ socket: { remoteAddress: peer }, headers: xff ? { "x-forwarded-for": xff } : {} }) as unknown as Request;
  it("one client, one spelling: the returned source is canonical", () => {
    expect(extractSourceIp(req("::ffff:127.0.0.1"), [])).toBe("127.0.0.1");
    expect(extractSourceIp(req("::FFFF:7f00:1"), [])).toBe("127.0.0.1");
    expect(extractSourceIp(req("2001:DB8:0:0:0:0:0:1"), [])).toBe("2001:db8::1");
  });
  it("TRUSTED direction: a proxy in 10.0.0.0/8, whatever its socket spelling, has its X-Forwarded-For honoured", () => {
    for (const peer of v4Spellings([10, 1, 2, 3]).filter((x) => !x.startsWith("["))) {
      expect(extractSourceIp(req(peer, "203.0.113.9"), ["10.0.0.0/8"]), peer).toBe("203.0.113.9");
    }
    expect(extractSourceIp(req("::ffff:10.1.2.3", "203.0.113.9"), ["::ffff:10.0.0.0/104"])).toBe("203.0.113.9");
  });
  it("SPOOF direction: a broad or short IPv6 trust block does NOT make an IPv4 client a proxy (its X-Forwarded-For is ignored)", () => {
    for (const block of ["::/0", "::/1", "::/80", "::ffff:10.0.0.0/8"]) {
      for (const peer of ["1.2.3.4", "::ffff:1.2.3.4", "::ffff:102:304"]) {
        expect(extractSourceIp(req(peer, "6.6.6.6"), [block]), `${peer} with ${block}`).toBe("1.2.3.4");
      }
    }
  });
  it("a hex-spelled trusted hop cannot be skipped past by a broad IPv6 block (the walk stops at it)", () => {
    expect(extractSourceIp(req("10.0.0.5", "6.6.6.6, ::ffff:102:304"), ["10.0.0.0/8", "::/0"])).toBe("1.2.3.4");
  });
});

describe("formatIp (RFC 5952)", () => {
  it("compresses the longest zero run, lowercase, never a single zero group", () => {
    const f = (s: string) => formatIp(canonicalIp(s)!);
    expect(f("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(f("2001:db8:0:1:1:1:1:1")).toBe("2001:db8:0:1:1:1:1:1");
    expect(f("::1")).toBe("::1");
    expect(f("::")).toBe("::");
  });
});
