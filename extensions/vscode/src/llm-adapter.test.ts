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

/**
 * REGRESSION — a claude agent must get the CLAUDE wake, not Codex's.
 *
 * The existing coverage called adapterFor("claude") with NO overrides, so it
 * could never see this: the REAL call site (resolveWakeAdapter) always passes a
 * populated `codex` block, because it cannot know the llm before calling. Those
 * overrides were then applied unconditionally, so every claude-configured agent
 * received the Codex instruction with its name templated in. Testing the
 * convenient shape instead of the shape production uses is why it survived.
 */
describe("profile isolation — codex options must not reshape the claude profile", () => {
  it("adapterFor('claude', {codex:…}) still types the bare `inbox` and submits inline", () => {
    const adapter = adapterFor("claude", {
      codex: {
        wakeText: 'Relay mail arrived — call get_messages(agent_name="victra-build", …)',
        submitKey: "\r",
        submitDelayMs: 150,
        submitMethod: "sendSequence",
      },
    });
    const sent: Array<[string, boolean | undefined]> = [];
    const ctx = {
      terminal: { sendText: (t: string, nl?: boolean) => sent.push([t, nl]) },
      sendSequenceToTerminal: async () => { throw new Error("claude must not use sendSequence"); },
      delay: async () => { throw new Error("claude must not delay — it submits inline"); },
    };
    return adapter.wake(ctx as never).then(() => {
      expect(sent).toEqual([["inbox", true]]);
      expect(adapter.wakeWord).toBe("inbox");
    });
  });

  it("adapterFor('codex', {codex:…}) DOES still honour its own tuning (positive control)", () => {
    // Without this, gating could be 'fixed' by ignoring the options entirely,
    // which would silently un-tune every Codex agent.
    const adapter = adapterFor("codex", { codex: { wakeText: "CUSTOM-CODEX-TEXT" } });
    const sent: string[] = [];
    const ctx = {
      terminal: { sendText: (t: string) => sent.push(t) },
      sendSequenceToTerminal: async () => { sent.push("<CR-sequence>"); },
      delay: async () => {},
    };
    return adapter.wake(ctx as never).then(() => {
      expect(sent[0]).toBe("CUSTOM-CODEX-TEXT");
      expect(sent).toContain("<CR-sequence>");
    });
  });
});
