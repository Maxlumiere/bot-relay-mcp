// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// LLM adapter contract tests. The load-bearing one is the Codex wake SEQUENCE:
// type the word WITHOUT a trailing newline, WAIT for the paste block to close,
// then submit with a SEPARATE event. Codex's TUI swallows both an embedded
// newline AND a submit key sent before the paste settles (confirmed live
// 2026-06-26). Asserting the exact ordered op log pins that contract, not a
// proxy.

import { describe, it, expect } from "vitest";
import {
  claudeAdapter,
  codexAdapter,
  makeCodexAdapter,
  adapterFor,
  DEFAULT_CODEX_WAKE_TEXT,
  type WakeContext,
  type WakeTerminal,
} from "./llm-adapter.js";

/** Records an ordered log of every side effect so the wake sequence (incl. the
 *  delay BETWEEN word and submit) can be asserted exactly. */
function fakeCtx(): { ctx: WakeContext; ops: string[] } {
  const ops: string[] = [];
  const terminal: WakeTerminal = {
    sendText: (text, addNewLine) => ops.push(`sendText:${JSON.stringify(text)}:${addNewLine}`),
    show: (preserveFocus) => ops.push(`show:${preserveFocus}`),
  };
  const ctx: WakeContext = {
    terminal,
    delay: async (ms) => {
      ops.push(`delay:${ms}`);
    },
    sendSequenceToTerminal: async (text) => {
      ops.push(`seq:${JSON.stringify(text)}`);
    },
  };
  return { ctx, ops };
}

describe("LLM adapters", () => {
  it("claude: single sendText(word, true) types AND submits", async () => {
    const { ctx, ops } = fakeCtx();
    await claudeAdapter.wake(ctx);
    expect(claudeAdapter.id).toBe("claude");
    expect(claudeAdapter.wakeWord).toBe("inbox");
    expect(ops).toEqual([`sendText:"inbox":true`]);
  });

  it("codex default: word (no newline) → delay → SEPARATE sendText(CR)", async () => {
    const { ctx, ops } = fakeCtx();
    await codexAdapter.wake(ctx);
    expect(codexAdapter.id).toBe("codex");
    expect(codexAdapter.wakeWord).toBe("ping-off");
    // Exact ordered contract (DEFAULT = sendSequence): type the INSTRUCTION with
    // addNewLine=false, wait 150ms for the paste block to close, THEN submit via
    // a focused standalone CR (sendSequence) — the twin of a real keyboard Enter.
    expect(ops).toEqual([
      `sendText:${JSON.stringify(DEFAULT_CODEX_WAKE_TEXT)}:false`,
      `delay:150`,
      `seq:"\\r"`,
    ]);
  });

  it("codex: the submit is a DISTINCT event AFTER the delay (not embedded)", async () => {
    const { ctx, ops } = fakeCtx();
    await codexAdapter.wake(ctx);
    expect(ops[0]).toBe(`sendText:${JSON.stringify(DEFAULT_CODEX_WAKE_TEXT)}:false`); // instruction, never with a newline
    expect(ops[1].startsWith("delay:")).toBe(true); // delay BEFORE submit
    expect(ops[2]).toBe(`seq:"\\r"`); // submit is its own (focused) event
    expect(ops).toHaveLength(3);
  });

  it("codex sendSequence method: focus-then-sequence submit after the delay", async () => {
    const { ctx, ops } = fakeCtx();
    await makeCodexAdapter({ submitMethod: "sendSequence", wakeText: "ping-off" }).wake(ctx);
    expect(ops).toEqual([
      `sendText:"ping-off":false`,
      `delay:150`,
      `seq:"\\r"`,
    ]);
  });

  it("codex: LF submit key + custom delay are honored", async () => {
    const { ctx, ops } = fakeCtx();
    await makeCodexAdapter({ submitKey: "\n", submitDelayMs: 200, wakeText: "ping-off", submitMethod: "sendText" }).wake(ctx);
    expect(ops).toEqual([
      `sendText:"ping-off":false`,
      `delay:200`,
      `sendText:"\\n":false`,
    ]);
  });

  it("codex: submitDelayMs=0 skips the delay", async () => {
    const { ctx, ops } = fakeCtx();
    await makeCodexAdapter({ submitDelayMs: 0, wakeText: "ping-off", submitMethod: "sendText" }).wake(ctx);
    expect(ops).toEqual([`sendText:"ping-off":false`, `sendText:"\\r":false`]);
  });

  it("codex: wakeText is injected verbatim (the templated INSTRUCTION)", async () => {
    const { ctx, ops } = fakeCtx();
    const instruction = 'Relay mail arrived — call get_messages(agent_name="codex-agent", status="pending"), act, then continue.';
    await makeCodexAdapter({ wakeText: instruction, submitDelayMs: 0 }).wake(ctx);
    expect(ops[0]).toBe(`sendText:${JSON.stringify(instruction)}:false`);
  });

  it("adapterFor: codex id → codex adapter with options threaded", async () => {
    const { ctx, ops } = fakeCtx();
    const a = adapterFor("codex", {
      codex: { submitMethod: "sendSequence", submitKey: "\n", wakeText: "ping-off" },
    });
    expect(a.id).toBe("codex");
    await a.wake(ctx);
    expect(ops).toEqual([`sendText:"ping-off":false`, `delay:150`, `seq:"\\n"`]);
  });

  it("adapterFor: claude id and unknown/undefined ids → claude adapter (safe default)", () => {
    expect(adapterFor("claude").id).toBe("claude");
    expect(adapterFor("gpt-something").id).toBe("claude");
    expect(adapterFor(undefined).id).toBe("claude");
  });
});
