// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.17.1 — transient-send retro quick wins:
 *   1. `relay send` — one-line send; resolves the sender token and never sends
 *      unauthenticated (refuses when no token can be resolved).
 *   2. `mint-token --json` — pure JSON on stdout (advisory/logs → stderr).
 *   3. /api/send-message — `message` accepted as an alias for `content`, with
 *      no silent precedence when both are sent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { ApiSendMessageSchema } from "../src/types.js";

describe("v2.17.1 — /api/send-message message↔content alias", () => {
  const base = { from: "a", to: "b", from_agent_token: "12345678" };

  it("accepts `content` alone", () => {
    const r = ApiSendMessageSchema.safeParse({ ...base, content: "hi" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.content).toBe("hi");
    expect(r.success && "message" in r.data).toBe(false); // normalized away
  });

  it("accepts `message` alone (aliased to content)", () => {
    const r = ApiSendMessageSchema.safeParse({ ...base, message: "hi" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.content).toBe("hi");
  });

  it("accepts both when EQUAL", () => {
    const r = ApiSendMessageSchema.safeParse({ ...base, content: "hi", message: "hi" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.content).toBe("hi");
  });

  it("REJECTS both when they DIFFER (no silent precedence)", () => {
    const r = ApiSendMessageSchema.safeParse({ ...base, content: "hi", message: "bye" });
    expect(r.success).toBe(false);
  });

  it("REJECTS neither", () => {
    const r = ApiSendMessageSchema.safeParse({ ...base });
    expect(r.success).toBe(false);
  });
});

describe("v2.17.1 — relay send (auth-respecting one-line send)", () => {
  let sendRun: (argv: string[]) => Promise<number>;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const savedName = process.env.RELAY_AGENT_NAME;
  const savedToken = process.env.RELAY_AGENT_TOKEN;

  beforeEach(async () => {
    ({ run: sendRun } = await import("../src/cli/send.js"));
    // Neutralize ambient identity so tests are deterministic + never actually send.
    delete process.env.RELAY_AGENT_NAME;
    delete process.env.RELAY_AGENT_TOKEN;
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    if (savedName !== undefined) process.env.RELAY_AGENT_NAME = savedName;
    if (savedToken !== undefined) process.env.RELAY_AGENT_TOKEN = savedToken;
  });

  it("--help returns 0 without sending", async () => {
    expect(await sendRun(["--help"])).toBe(0);
  });

  it("refuses with no sender (no --from, no RELAY_AGENT_NAME) → exit 1", async () => {
    expect(await sendRun(["_to", "body"])).toBe(1);
  });

  it("refuses missing recipient → exit 1", async () => {
    expect(await sendRun(["--from", "someone"])).toBe(1);
  });

  it("refuses missing content → exit 1", async () => {
    expect(await sendRun(["_to", "--from", "someone"])).toBe(1);
  });

  it("AUTH GATE: no resolvable token + no --mint-if-missing → exit 2 (never sends unauthenticated)", async () => {
    // A vault-miss name with no env token: refuses BEFORE any POST.
    const missName = `_p2_no_such_${process.pid}_${Date.now() % 100000}`;
    expect(await sendRun(["_to", "body", "--from", missName])).toBe(2);
  });
});

describe("v2.17.1 — mint-token --json emits pure JSON on stdout", () => {
  it("stdout is a single valid JSON object; the advisory/logs go to stderr", async () => {
    const { run: mintRun } = await import("../src/cli/mint-token.js");
    const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mt-json-")), "relay.db");
    const chunks: string[] = [];
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((c: any) => {
      chunks.push(typeof c === "string" ? c : c.toString());
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await mintRun([`_mtjson_${process.pid}`, "--json", "--db-path", tmpDb]);
      expect(code).toBe(0);
      const stdout = chunks.join("");
      // Exactly one JSON object + a trailing newline — nothing else.
      const trimmed = stdout.trim();
      const parsed = JSON.parse(trimmed); // throws if not pure JSON
      expect(parsed.success).toBe(true);
      expect(typeof parsed.token).toBe("string");
      expect(trimmed.split("\n").length).toBe(1);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
      try {
        fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});
