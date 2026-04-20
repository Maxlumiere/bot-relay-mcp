// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4n — open-bind hardening (F-3a.9 MEDIUM).
 *
 * Verifies startHttpServer refuses to bind to non-loopback hosts without
 * RELAY_HTTP_SECRET, unless RELAY_ALLOW_OPEN_PUBLIC=1 explicitly acknowledges
 * the risk. Uses the exported assertBindSafety() for direct unit-level
 * coverage plus one end-to-end check that startHttpServer throws.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-open-bind-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
// Start with a clean slate for every test — the env vars we're exercising
// interact with each other in ways tests need to control precisely.
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_ALLOW_OPEN_PUBLIC;
delete process.env.RELAY_ALLOW_LEGACY;

const { startHttpServer, assertBindSafety } = await import("../src/transport/http.js");
const { closeDb } = await import("../src/db.js");

let openServers: HttpServer[] = [];

beforeEach(() => {
  delete process.env.RELAY_HTTP_SECRET;
  delete process.env.RELAY_ALLOW_OPEN_PUBLIC;
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
});

afterEach(() => {
  for (const s of openServers) {
    try {
      s.close();
    } catch {
      // ignore
    }
  }
  openServers = [];
  delete process.env.RELAY_HTTP_SECRET;
  delete process.env.RELAY_ALLOW_OPEN_PUBLIC;
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("v2.1 Phase 4n — assertBindSafety", () => {
  it("(1) loopback host (127.0.0.1) + no secret → allowed, no throw", () => {
    expect(() => assertBindSafety("127.0.0.1", null)).not.toThrow();
    // Real start also works — we just need to confirm no throw; the socket
    // may take a tick to transition to listening, which isn't what we're
    // testing here.
    let server: HttpServer | undefined;
    expect(() => {
      server = startHttpServer(0, "127.0.0.1");
    }).not.toThrow();
    if (server) openServers.push(server);
  });

  it("(2) 0.0.0.0 + no secret + no RELAY_ALLOW_OPEN_PUBLIC → throws with all three resolutions named", () => {
    expect(() => assertBindSafety("0.0.0.0", null)).toThrow(/RELAY_HTTP_SECRET/i);
    expect(() => assertBindSafety("0.0.0.0", null)).toThrow(/127\.0\.0\.1/);
    expect(() => assertBindSafety("0.0.0.0", null)).toThrow(/RELAY_ALLOW_OPEN_PUBLIC/i);
    // And startHttpServer surfaces the same refusal.
    expect(() => startHttpServer(0, "0.0.0.0")).toThrow(/non-loopback/i);
  });

  it("(3) 0.0.0.0 + RELAY_HTTP_SECRET set → allowed, no throw", () => {
    expect(() => assertBindSafety("0.0.0.0", "a-strong-secret")).not.toThrow();
    process.env.RELAY_HTTP_SECRET = "a-strong-secret";
    let server: HttpServer | undefined;
    expect(() => {
      server = startHttpServer(0, "0.0.0.0");
    }).not.toThrow();
    if (server) openServers.push(server);
  });

  it("(4) 0.0.0.0 + no secret + RELAY_ALLOW_OPEN_PUBLIC=1 → allowed with log.warn", () => {
    process.env.RELAY_ALLOW_OPEN_PUBLIC = "1";
    const warnings: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as any) = (s: string) => {
      warnings.push(String(s));
      return true;
    };
    try {
      expect(() => assertBindSafety("0.0.0.0", null)).not.toThrow();
    } finally {
      (process.stderr.write as any) = origWrite;
    }
    const joined = warnings.join("");
    expect(joined).toMatch(/DANGER/);
    expect(joined).toMatch(/0\.0\.0\.0/);
    expect(joined).toMatch(/RELAY_HTTP_SECRET/);
  });

  it("(5) IPv6 loopback (::1) + no secret → treated as loopback, allowed", () => {
    expect(() => assertBindSafety("::1", null)).not.toThrow();
    expect(() => assertBindSafety("0:0:0:0:0:0:0:1", null)).not.toThrow();
    expect(() => assertBindSafety("[::1]", null)).not.toThrow();
    expect(() => assertBindSafety("LOCALHOST", null)).not.toThrow(); // case-insensitive
  });
});
