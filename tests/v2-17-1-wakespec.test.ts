// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.17.1 — the registry `wake` values, reconciled from P3 placeholders to the
 * Tether extension's PROVEN wake behavior. The codex wakeText is kept
 * byte-identical to the extension's DEFAULT_CODEX_WAKE_TEXT by the drift guard
 * below (the P3 mirror pattern — read the extension source, compare). The
 * data-driven Tether 0.6.0 reads these directly, so a silent drift here would
 * break the proven wake.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAgentCliProfile } from "../src/agent-cli-profiles.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("v2.17.1 — WakeSpec reconciled to the extension's proven behavior", () => {
  it("DRIFT GUARD: codex wakeText byte-matches the extension's DEFAULT_CODEX_WAKE_TEXT", () => {
    const src = fs.readFileSync(
      path.join(REPO, "extensions", "vscode", "src", "llm-adapter.ts"),
      "utf-8",
    );
    // The constant is a single-quoted literal (its body contains double-quotes:
    // …status="pending"…). Capture between the single quotes.
    const m = src.match(/DEFAULT_CODEX_WAKE_TEXT\s*=\s*'([^']*)'/);
    expect(m, "could not find DEFAULT_CODEX_WAKE_TEXT in extensions/vscode/src/llm-adapter.ts").toBeTruthy();
    const extText = m![1];
    const codex = getAgentCliProfile("codex")!;
    expect(codex.wake.wakeText).toBe(extText);
  });

  it("codex wake = the proven codexAdapter params (CR / sendSequence / 150ms)", () => {
    const codex = getAgentCliProfile("codex")!;
    expect(codex.wake.submitKey).toBe("\r");
    expect(codex.wake.submitMethod).toBe("sendSequence");
    expect(codex.wake.submitDelayMs).toBe(150);
    expect(codex.wake.nativeSelfWake).toBe(false);
  });

  it("claude wake = types 'inbox' inline (sendText, no delay)", () => {
    const claude = getAgentCliProfile("claude")!;
    expect(claude.wake.wakeText).toBe("inbox");
    expect(claude.wake.submitMethod).toBe("sendText");
    expect(claude.wake.submitDelayMs).toBe(0);
    expect(claude.wake.nativeSelfWake).toBe(false);
  });

  it("submitDelayMs is present + numeric on EVERY profile", () => {
    for (const id of ["claude", "codex"]) {
      const p = getAgentCliProfile(id)!;
      expect(typeof p.wake.submitDelayMs, `${id}.wake.submitDelayMs`).toBe("number");
      expect(p.wake.submitDelayMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("the interim-placeholder marker has been removed (values are now real)", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "agent-cli-profiles.ts"), "utf-8");
    expect(src).not.toMatch(/INTERIM PLACEHOLDER/i);
  });
});
