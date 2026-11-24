// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The owner endpoint record's LOGGING caller (src/transport/http.ts, once the HTTP server listens): when the shared
 * replace exhausts its Windows retries, the daemon logs its NAMED warning and keeps serving (a record failure is never
 * fatal), and no record or temp file is left. The platform and the rename are injected (src/fs-replace.ts seam), so
 * this runs on every OS.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Server as HttpServer } from "http";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fs-replace-http-"));
process.env.RELAY_HOME = TEST_DIR;
process.env.RELAY_DB_PATH = path.join(TEST_DIR, "relay.db");
process.env.RELAY_CONFIG_PATH = path.join(TEST_DIR, "config.json");
process.env.RELAY_ALLOW_LEGACY = "1";
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;
delete process.env.RELAY_AGENT_TOKEN;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, getDb } = await import("../src/db.js");
const { log } = await import("../src/logger.js");
const { _setReplaceDepsForTests, WINDOWS_REPLACE_WAITS_MS } = await import("../src/fs-replace.js");
const { ownerEndpointPath } = await import("../src/owner-endpoint.js");

let server: HttpServer | null = null;
afterAll(() => {
  _setReplaceDepsForTests(null);
  server?.close();
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("the owner endpoint record's logging caller (the HTTP daemon)", () => {
  it("Windows: the record's rename refused past the bounded retries → the NAMED warning, the daemon still serves, no record and no temp file", async () => {
    getDb();
    let calls = 0;
    _setReplaceDepsForTests({
      platform: "win32",
      rename: () => {
        calls++;
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      },
      sleep: () => {},
    });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    server = startHttpServer(0, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 300));
    const lines = warn.mock.calls.flat().map(String).filter((l) => l.includes("[owner-endpoint]"));
    warn.mockRestore();
    expect(calls, "every attempt was made, and no more").toBe(WINDOWS_REPLACE_WAITS_MS.length + 1);
    expect(lines.some((l) => /could not write the owner endpoint record \(EPERM[^)]*\): the hooks read no mail from this owner\./.test(l)), lines.join("\n")).toBe(true);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status, "the daemon still serves").toBe(200);
    expect(fs.existsSync(ownerEndpointPath(process.env.RELAY_DB_PATH!))).toBe(false);
    expect(fs.readdirSync(TEST_DIR).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
