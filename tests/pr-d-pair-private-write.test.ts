// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR-D (Codex R2 #3, #4): `relay pair` writes the client config (it holds the agent's token) PRIVATELY, or not at all.
 *   #3 an owner-only restriction that reports faults (Windows) is a FAILURE: the file is removed, never left readable;
 *   #4 a short write is continued until every byte is written; a write that fails part-way removes the partial file.
 * The OS calls are injected, so both run on every OS.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { writePrivateConfig } = await import("../src/cli/pair.js");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr-d-pair-write-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const out = (n: string) => path.join(ROOT, n);
const TEXT = JSON.stringify({ "bot-relay": { headers: { "X-Agent-Token": "t".repeat(43) } } }, null, 2) + "\n";

describe("relay pair's config write: private, complete, or nothing (Codex R2 #3, #4)", () => {
  it("the known-good path: the whole text, 0600, no faults", () => {
    const f = out("ok.json");
    writePrivateConfig(f, TEXT);
    expect(fs.readFileSync(f, "utf-8")).toBe(TEXT);
    if (process.platform !== "win32") expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it("#3: the owner-only restriction reports a fault → it THROWS and the file is GONE (never left readable by others)", () => {
    const f = out("acl-fault.json");
    expect(() => writePrivateConfig(f, TEXT, { restrict: () => [`${f}: an allow ACE for S-1-5-32-545 is not the owner's`] })).toThrow(/not private.*S-1-5-32-545/);
    expect(fs.existsSync(f)).toBe(false);
  });

  it("#4: a SHORT write is continued until every byte is on disk", () => {
    const f = out("short.json");
    writePrivateConfig(f, TEXT, { writeSync: (fd: number, buf: Buffer, off: number, len: number) => fs.writeSync(fd, buf, off, Math.min(len, 7)) });
    expect(fs.readFileSync(f, "utf-8")).toBe(TEXT);
  });

  it("#4: a write that FAILS part-way → it throws and the partial file is GONE", () => {
    const f = out("partial.json");
    let calls = 0;
    const failing = (fd: number, buf: Buffer, off: number, len: number) => {
      if (++calls > 1) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      return fs.writeSync(fd, buf, off, Math.min(len, 10));
    };
    expect(() => writePrivateConfig(f, TEXT, { writeSync: failing })).toThrow(/ENOSPC/);
    expect(fs.existsSync(f)).toBe(false);
  });

  it("#4: a write that makes NO progress (0 bytes) is a failure, not an endless loop", () => {
    const f = out("stuck.json");
    expect(() => writePrivateConfig(f, TEXT, { writeSync: () => 0 })).toThrow(/no progress/);
    expect(fs.existsSync(f)).toBe(false);
  });
});
