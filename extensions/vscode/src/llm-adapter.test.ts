// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// LLM adapter contract tests. The load-bearing one is the Codex wake SEQUENCE:
// the word must be injected WITHOUT a trailing newline, then the submit key sent
// as a SEPARATE write — the empirically-proven fix for Codex's TUI swallowing a
// newline embedded in the same paste block (2026-06-26). Asserting the exact
// sendText call sequence pins that contract, not a proxy.

import { describe, it, expect } from "vitest";
import {
  claudeAdapter,
  codexAdapter,
  makeCodexAdapter,
  adapterFor,
  type WakeTerminal,
} from "./llm-adapter.js";

/** Records every sendText call so the wake sequence can be asserted exactly. */
function fakeTerminal(): WakeTerminal & { calls: { text: string; addNewLine?: boolean }[] } {
  const calls: { text: string; addNewLine?: boolean }[] = [];
  return {
    calls,
    sendText(text: string, addNewLine?: boolean) {
      calls.push({ text, addNewLine });
    },
  };
}

describe("LLM adapters", () => {
  it("claude: single sendText(word, true) types AND submits", () => {
    const t = fakeTerminal();
    claudeAdapter.wake(t);
    expect(claudeAdapter.id).toBe("claude");
    expect(claudeAdapter.wakeWord).toBe("inbox");
    // One call, word with appended newline (Claude's TUI submits it).
    expect(t.calls).toEqual([{ text: "inbox", addNewLine: true }]);
  });

  it("codex: inject word (NO newline) THEN a SEPARATE Enter — the submit fix", () => {
    const t = fakeTerminal();
    codexAdapter.wake(t);
    expect(codexAdapter.id).toBe("codex");
    expect(codexAdapter.wakeWord).toBe("ping-off");
    // Exactly two writes: the word with addNewLine=false (so no embedded CR is
    // swallowed), then "\r" as its own write (the decoupled Enter).
    expect(t.calls).toEqual([
      { text: "ping-off", addNewLine: false },
      { text: "\r", addNewLine: false },
    ]);
  });

  it("codex: never appends a newline to the word (the swallow bug)", () => {
    const t = fakeTerminal();
    codexAdapter.wake(t);
    const wordCall = t.calls[0];
    expect(wordCall.text).toBe("ping-off");
    expect(wordCall.addNewLine).toBe(false);
    // The submit is a distinct second call, not folded into the word call.
    expect(t.calls.length).toBe(2);
    expect(t.calls[1].text).not.toContain("ping-off");
  });

  it("codex: LF fallback submit key", () => {
    const t = fakeTerminal();
    makeCodexAdapter("\n").wake(t);
    expect(t.calls).toEqual([
      { text: "ping-off", addNewLine: false },
      { text: "\n", addNewLine: false },
    ]);
  });

  it("adapterFor: codex id → codex adapter, with submit-key override", () => {
    const t = fakeTerminal();
    const a = adapterFor("codex", { codexSubmitKey: "\n" });
    expect(a.id).toBe("codex");
    a.wake(t);
    expect(t.calls[1]).toEqual({ text: "\n", addNewLine: false });
  });

  it("adapterFor: claude id and unknown/undefined ids → claude adapter (safe default)", () => {
    expect(adapterFor("claude").id).toBe("claude");
    expect(adapterFor("gpt-something").id).toBe("claude");
    expect(adapterFor(undefined).id).toBe("claude");
  });
});
