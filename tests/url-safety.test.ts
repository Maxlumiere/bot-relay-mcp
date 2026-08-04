// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateWebhookUrl } from "../src/url-safety.js";

beforeEach(() => {
  delete process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS;
});

afterEach(() => {
  delete process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS;
});

describe("URL safety — scheme + format checks", () => {
  it("rejects malformed URL", async () => {
    const r = await validateWebhookUrl("not-a-url");
    expect(r.ok).toBe(false);
  });

  it("rejects file:// scheme", async () => {
    const r = await validateWebhookUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("scheme");
  });

  it("rejects ftp:// scheme", async () => {
    const r = await validateWebhookUrl("ftp://example.com/x");
    expect(r.ok).toBe(false);
  });

  it("rejects gopher:// scheme", async () => {
    const r = await validateWebhookUrl("gopher://example.com/x");
    expect(r.ok).toBe(false);
  });
});

describe("URL safety — IP literal blocking", () => {
  it("rejects 127.0.0.1 (loopback)", async () => {
    const r = await validateWebhookUrl("http://127.0.0.1:8080/hook");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("loopback");
  });

  it("rejects 10.x (private)", async () => {
    const r = await validateWebhookUrl("http://10.0.0.1/hook");
    expect(r.ok).toBe(false);
  });

  it("rejects 192.168.x (private)", async () => {
    const r = await validateWebhookUrl("http://192.168.1.1/hook");
    expect(r.ok).toBe(false);
  });

  it("rejects 172.16.x (private)", async () => {
    const r = await validateWebhookUrl("http://172.20.0.5/hook");
    expect(r.ok).toBe(false);
  });

  it("rejects 169.254.169.254 (cloud metadata)", async () => {
    const r = await validateWebhookUrl("http://169.254.169.254/latest/meta-data/");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("link-local");
  });

  it("rejects ::1 (IPv6 loopback)", async () => {
    const r = await validateWebhookUrl("http://[::1]/hook");
    expect(r.ok).toBe(false);
  });

  it("rejects fe80::/10 (IPv6 link-local)", async () => {
    const r = await validateWebhookUrl("http://[fe80::1]/hook");
    expect(r.ok).toBe(false);
  });
});

describe("URL safety — opt-in for local targets", () => {
  it("allows 127.0.0.1 when RELAY_ALLOW_PRIVATE_WEBHOOKS=1", async () => {
    process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS = "1";
    const r = await validateWebhookUrl("http://127.0.0.1:5678/webhook/n8n");
    expect(r.ok).toBe(true);
  });

  it("allows 192.168.x when RELAY_ALLOW_PRIVATE_WEBHOOKS=1", async () => {
    process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS = "1";
    const r = await validateWebhookUrl("http://192.168.1.50/hook");
    expect(r.ok).toBe(true);
  });

  it("still rejects file:// even when private allowed", async () => {
    process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS = "1";
    const r = await validateWebhookUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
  });
});

describe("URL safety — public destinations", () => {
  it("accepts a public domain that resolves to a public IP", async () => {
    // example.com is IANA reserved and resolves to public IPs
    const r = await validateWebhookUrl("http://example.com/hook");
    expect(r.ok).toBe(true);
    expect(r.resolvedIps).toBeDefined();
    expect(r.resolvedIps!.length).toBeGreaterThan(0);
  });
});

describe("URL safety — alternate-spelling SSRF vectors (regression, codex 2026-08-04)", () => {
  // Leading-zero / hex / decimal-integer / IPv4-mapped-IPv6 / NAT64 spellings that a naive
  // string-match SSRF check would miss. url-safety.ts canonicalizes via WHATWG URL before
  // classification (verified: 012.0.0.1 → 10.0.0.1, 0x7f.0.0.1 → 127.0.0.1, etc.), so each
  // must still fail closed. Locks that behaviour so a future refactor cannot silently regress it.
  const blocked: Array<[string, string]> = [
    ["http://012.0.0.1/hook", "octal leading-zero → 10.0.0.1 (private)"],
    ["http://127.1/hook", "short-form loopback"],
    ["http://0x7f.0.0.1/hook", "hex loopback"],
    ["http://2130706433/hook", "decimal-integer loopback"],
    ["http://[::ffff:127.0.0.1]/hook", "IPv4-mapped IPv6 loopback"],
    ["http://[::ffff:10.0.0.1]/hook", "IPv4-mapped IPv6 private"],
    ["http://[64:ff9b::7f00:1]/hook", "NAT64 well-known prefix embedding 127.0.0.1"],
  ];
  for (const [url, why] of blocked) {
    it(`rejects ${url} (${why})`, async () => {
      const r = await validateWebhookUrl(url);
      expect(r.ok, `${url} should fail closed: ${why}`).toBe(false);
    });
  }
});
