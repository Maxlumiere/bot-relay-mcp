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
 *  without a real `vscode.Terminal`). Mirrors `vscode.Terminal.sendText`. */
export interface WakeTerminal {
  sendText(text: string, addNewLine?: boolean): void;
}

/** The submit keystroke sent as a SEPARATE event after the wake word. CR ("\r")
 *  matches a real Enter; LF ("\n") is the documented fallback for TUIs that need
 *  it. */
export type SubmitKey = "\r" | "\n";

export interface LlmAdapter {
  /** Stable id used in config + logs (e.g. "claude", "codex"). */
  readonly id: string;
  /** The wake word injected to make the agent drain its inbox + act. */
  readonly wakeWord: string;
  /** Inject the wake word and submit it, handling this LLM's TUI quirks. */
  wake(terminal: WakeTerminal): void;
}

/**
 * Claude Code's TUI accepts a wake word with an appended newline cleanly, so a
 * single `sendText(word, true)` both types AND submits it. This is the original
 * (proven) Tether behaviour, now behind the adapter seam.
 */
export const claudeAdapter: LlmAdapter = {
  id: "claude",
  wakeWord: "inbox",
  wake: (t) => t.sendText("inbox", true),
};

/**
 * Codex's TUI swallows a newline embedded in the SAME paste block as the wake
 * word: `sendText(word, true)` arrives as one bracketed paste and the trailing
 * CR is absorbed, leaving the word typed-but-unsent. Empirically confirmed
 * (2026-06-26): injecting the word WITHOUT a trailing newline and then sending
 * the submit key as a SEPARATE terminal write (its own event, not part of the
 * word's paste block) makes Codex submit + act. CR is the default (matches a
 * real Enter); LF is the fallback.
 */
export function makeCodexAdapter(submitKey: SubmitKey = "\r"): LlmAdapter {
  return {
    id: "codex",
    wakeWord: "ping-off",
    wake: (t) => {
      // 1) type the word, no auto-newline (avoid the embedded-CR swallow)
      t.sendText("ping-off", false);
      // 2) submit with a SEPARATE Enter keystroke — distinct write, distinct
      //    paste block, so the CR is delivered as input rather than absorbed.
      t.sendText(submitKey, false);
    },
  };
}

/** Default Codex adapter (CR submit). Use `makeCodexAdapter("\n")` for the LF
 *  fallback. */
export const codexAdapter: LlmAdapter = makeCodexAdapter();

/**
 * Resolve the adapter for a configured LLM id. Unknown ids fall back to Claude
 * (the default, safest behaviour — single newline-appended wake).
 */
export function adapterFor(
  id: string | undefined,
  opts?: { codexSubmitKey?: SubmitKey },
): LlmAdapter {
  if (id === "codex") return makeCodexAdapter(opts?.codexSubmitKey ?? "\r");
  return claudeAdapter;
}
