// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay doctor` — MCP spawn-path detector (silent-failure class, onboarding
 * launch gate).
 *
 * A stdio bot-relay entry in ~/.claude.json whose spawn path is percent-encoded
 * (the `%20` fossil) or missing makes node fail to spawn — the session comes up
 * with ZERO relay tools and NO signal. `relay init` catches it at write-time; a
 * PRE-EXISTING fossil is never re-examined until now.
 *
 * A DETECTOR's target is absent by definition, so it is tested against FIXTURES,
 * never the real ~/.claude.json. The NEGATIVE CONTROL is load-bearing: a clean,
 * existing path must PASS, or a doctor that flags healthy configs gets ignored.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { checkMcpServerPath } = await import("../src/cli/doctor.js");

let dir: string;
function writeClaude(obj: unknown): string {
  const p = path.join(dir, ".claude.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-mcp-path-"));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

describe("relay doctor — MCP spawn-path detector", () => {
  it("FAILs on a %20-encoded spawn path and names the decoded fix", () => {
    const p = writeClaude({
      mcpServers: { "bot-relay": { type: "stdio", command: "node", args: ["/Users/x/Claude%20AI/bot-relay-mcp/dist/index.js"] } },
    });
    const r = checkMcpServerPath(p);
    expect(r.status).toBe("FAIL");
    expect(r.detail).toMatch(/percent-encoded/i);
    expect(r.detail).toMatch(/ZERO relay tools/);
    // must NAME the fix — the decoded path, not just the fault.
    expect(r.detail).toContain("/Users/x/Claude AI/bot-relay-mcp/dist/index.js");
    expect(r.detail).toMatch(/relay init|args/);
  });

  it("FAILs when the spawn path does not exist", () => {
    const p = writeClaude({
      mcpServers: { "bot-relay": { type: "stdio", command: "node", args: [path.join(dir, "nope", "dist", "index.js")] } },
    });
    const r = checkMcpServerPath(p);
    expect(r.status).toBe("FAIL");
    expect(r.detail).toMatch(/does not exist/i);
  });

  // ⭐ NEGATIVE CONTROL — the one that matters most. A clean, existing path is
  // healthy and MUST NOT warn or fail, or the detector cries wolf and is muted.
  it("PASSes a clean, existing spawn path — no false alarm", () => {
    const real = path.join(dir, "dist", "index.js");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "// present");
    const p = writeClaude({ mcpServers: { "bot-relay": { type: "stdio", command: "node", args: [real] } } });
    const r = checkMcpServerPath(p);
    expect(r.status).toBe("PASS");
    expect(r.detail).not.toMatch(/percent|does not exist/i);
  });

  it("PASSes an HTTP bot-relay entry (no local path to check)", () => {
    const p = writeClaude({ mcpServers: { "bot-relay": { type: "http", url: "http://127.0.0.1:3777/mcp" } } });
    expect(checkMcpServerPath(p).status).toBe("PASS");
  });

  it("PASSes when there is no bot-relay entry", () => {
    const p = writeClaude({ mcpServers: { other: { type: "http", url: "http://x" } } });
    expect(checkMcpServerPath(p).status).toBe("PASS");
  });

  it("PASSes (nothing to check) when ~/.claude.json is absent", () => {
    const r = checkMcpServerPath(path.join(dir, "does-not-exist.json"));
    expect(r.status).toBe("PASS");
  });
});
