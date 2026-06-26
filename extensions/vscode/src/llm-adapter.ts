// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// LLM adapters — the ONLY per-LLM differences in how Tether wakes an agent's
// terminal. The rest of Tether is LLM-agnostic: the relay watcher (zero-cost
// MCP-resource subscription, no polling) and the terminal matcher decide WHEN
// and WHICH terminal to wake; the adapter decides WHAT to inject and HOW to
// submit it for a given CLI agent.
//
// Adding support for another injectable CLI agent = one more adapter here; the
// generic core does not change.

/** Minimal VSCode-free terminal surface a wake needs (so adapters unit-test
 *  without a real `vscode.Terminal`). Mirrors the `vscode.Terminal` members
 *  Tether uses. */
export interface WakeTerminal {
  sendText(text: string, addNewLine?: boolean): void;
  /** Bring the terminal to the front / make it the active terminal. */
  show(preserveFocus?: boolean): void;
}

/** The submit keystroke sent as a SEPARATE event after the wake word. CR ("\r")
 *  matches a real Enter; LF ("\n") is the documented fallback for TUIs that need
 *  it. */
export type SubmitKey = "\r" | "\n";

/** How the submit keystroke is delivered to the bound terminal. "sendText" is
 *  the default (per-terminal write — targets the right terminal directly).
 *  "sendSequence" focuses the terminal then sends a raw sequence (VSCode's
 *  sendSequence only hits the ACTIVE terminal) — the fallback for TUIs that
 *  ignore a sendText'd CR. */
export type SubmitMethod = "sendText" | "sendSequence";

/** Side-effecting context the extension supplies; injectable so adapters
 *  unit-test without VSCode or real timers. */
export interface WakeContext {
  terminal: WakeTerminal;
  /** Sleep `ms` milliseconds. */
  delay(ms: number): Promise<void>;
  /** Focus `terminal`, then send `text` as a raw sequence to the now-active
   *  terminal (via VSCode's terminal sendSequence command). */
  sendSequenceToTerminal(text: string): Promise<void>;
}

export interface LlmAdapter {
  /** Stable id used in config + logs (e.g. "claude", "codex"). */
  readonly id: string;
  /** The wake word injected to make the agent drain its inbox + act. */
  readonly wakeWord: string;
  /** Inject the wake word and submit it, handling this LLM's TUI quirks. */
  wake(ctx: WakeContext): Promise<void>;
}

/**
 * Claude Code's TUI accepts a wake word with an appended newline cleanly, so a
 * single `sendText(word, true)` both types AND submits it. Original (proven)
 * Tether behaviour, now behind the adapter seam.
 */
export const claudeAdapter: LlmAdapter = {
  id: "claude",
  wakeWord: "inbox",
  wake: async (ctx) => {
    ctx.terminal.sendText("inbox", true);
  },
};

export interface CodexAdapterOptions {
  /** Separate submit key (default CR). */
  submitKey?: SubmitKey;
  /** Delay between typing the word and sending the submit key, so the paste
   *  block closes first (default 150ms). */
  submitDelayMs?: number;
  /** How to deliver the submit key (default "sendText"). */
  submitMethod?: SubmitMethod;
}

/**
 * Codex's TUI does not submit a wake word the way Claude's does:
 *   1. A newline embedded in the SAME paste block as the word is swallowed
 *      (`sendText(word, true)` → the word is typed but not sent).
 *   2. A submit key sent IMMEDIATELY after the word is also absorbed — the
 *      paste block is still open. Empirically (2026-06-26) a real Enter pressed
 *      AFTER the paste settles DOES submit ("pong").
 *
 * So the wake = type the word (no newline) → WAIT for the paste block to close →
 * send the submit key as a SEPARATE event. Two delivery methods, both tunable
 * via settings without a rebuild:
 *   - "sendText" (default): per-terminal `sendText(submitKey, false)` — targets
 *     the bound terminal directly.
 *   - "sendSequence": focus the terminal, then VSCode's sendSequence to the now-
 *     active terminal — for TUIs that ignore a sendText'd CR.
 */
export function makeCodexAdapter(opts?: CodexAdapterOptions): LlmAdapter {
  const submitKey: SubmitKey = opts?.submitKey ?? "\r";
  const submitDelayMs = opts?.submitDelayMs ?? 150;
  const submitMethod: SubmitMethod = opts?.submitMethod ?? "sendText";
  return {
    id: "codex",
    wakeWord: "ping-off",
    wake: async (ctx) => {
      // 1) type the word, no auto-newline (avoid the embedded-CR swallow)
      ctx.terminal.sendText("ping-off", false);
      // 2) let the paste block close before submitting
      if (submitDelayMs > 0) await ctx.delay(submitDelayMs);
      // 3) submit as a SEPARATE event
      if (submitMethod === "sendSequence") {
        await ctx.sendSequenceToTerminal(submitKey);
      } else {
        ctx.terminal.sendText(submitKey, false);
      }
    },
  };
}

/** Default Codex adapter (CR, 150ms, sendText). */
export const codexAdapter: LlmAdapter = makeCodexAdapter();

/**
 * Resolve the adapter for a configured LLM id. Unknown ids fall back to Claude
 * (the safest default — single newline-appended wake).
 */
export function adapterFor(
  id: string | undefined,
  opts?: { codex?: CodexAdapterOptions },
): LlmAdapter {
  if (id === "codex") return makeCodexAdapter(opts?.codex);
  return claudeAdapter;
}
