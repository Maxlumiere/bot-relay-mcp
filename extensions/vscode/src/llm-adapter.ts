// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// LLM adapters — the ONLY per-LLM differences in how Tether wakes an agent's
// terminal. The rest of Tether is LLM-agnostic: the relay watcher (zero-cost
// MCP-resource subscription, no polling) and the terminal matcher decide WHEN
// and WHICH terminal to wake; the adapter decides WHAT to inject and HOW to
// submit it for a given CLI agent.
//
// v0.6.0 (P4 — data-driven Tether): the per-CLI WAKE VALUES (wakeText, submit
// key/method, submit delay) mirror the relay's agent-CLI profile registry
// (src/agent-cli-profiles.ts). The extension source can't import that registry
// directly (it lives outside the extension's tsconfig rootDir), so TETHER_LLM
// below is a MIRROR kept byte-in-sync by a drift-guard test that DOES import the
// registry (llm-adapter-registry-parity.test.ts). Adding an injectable CLI = one
// registry entry + one mirror row (with its TUI wake `style`); adapterFor()
// resolves it data-drivenly — no per-CLI branch.
//
// What is NOT registry-driven, by design: the wake `style` (how the TUI accepts
// a submit — a single newline-appended sendText vs a typed instruction followed
// by a SEPARATE submit event after a paste-settle delay). That is terminal-UX
// knowledge specific to Tether's injection layer, not a relay data concern, and
// (crucially) it is NOT derivable from the WakeSpec fields — a codex-style
// adapter can carry submitMethod "sendText"/delay 0 and STILL require the
// separate submit. So `style` lives in the mirror, the drift guard checks only
// the registry-owned VALUES.

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

/** How a CLI's TUI accepts a wake. Extension-side (injection) knowledge, NOT a
 *  registry field:
 *   - "inline-newline": one `sendText(wakeText, true)` types AND submits (Claude);
 *   - "type-then-submit": type wakeText WITHOUT a newline, WAIT `submitDelayMs`
 *     for the paste block to close, then submit via a SEPARATE event (Codex). */
export type WakeStyle = "inline-newline" | "type-then-submit";

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

/** The registry-owned wake VALUES (mirror of src/agent-cli-profiles.ts WakeSpec).
 *  These are what the drift guard checks byte-for-byte against the registry. */
export interface WakeValues {
  wakeText: string;
  submitKey: SubmitKey;
  submitMethod: SubmitMethod;
  submitDelayMs: number;
  nativeSelfWake: boolean;
}

/** One mirror row: the registry wake VALUES + the extension-side TUI `style` +
 *  a short human `wakeWord` label for logs. */
interface TetherLlmEntry {
  id: string;
  wakeWord: string;
  style: WakeStyle;
  wake: WakeValues;
}

/** Default Codex wake INSTRUCTION. Codex has no `inbox`-style convention, so a
 *  bare wake token just makes it reply ("pong") rather than drain its inbox — it
 *  must be told what to do. The extension templates the agent name into the
 *  configured prompt; this generic fallback is used when none is supplied.
 *
 *  This literal is the source the relay registry's codex `wakeText` is kept
 *  byte-identical to (tests/v2-17-1-wakespec.test.ts reads it). Keep it a plain
 *  string literal so that reader keeps working. */
export const DEFAULT_CODEX_WAKE_TEXT =
  'Relay mail arrived — call get_messages(status="pending"), act on every message, then continue.';

/**
 * The mirror of the relay agent-CLI profile registry's wake data. The `wake`
 * VALUES here are kept byte-in-sync with src/agent-cli-profiles.ts by
 * llm-adapter-registry-parity.test.ts (which imports the real registry). `style`
 * + `wakeWord` are extension-side.
 */
export const TETHER_LLM: readonly TetherLlmEntry[] = [
  {
    id: "claude",
    wakeWord: "inbox",
    style: "inline-newline",
    wake: {
      wakeText: "inbox",
      submitKey: "\r",
      submitMethod: "sendText",
      submitDelayMs: 0,
      nativeSelfWake: false,
    },
  },
  {
    id: "codex",
    wakeWord: "ping-off",
    style: "type-then-submit",
    wake: {
      wakeText: DEFAULT_CODEX_WAKE_TEXT,
      submitKey: "\r",
      submitMethod: "sendSequence",
      submitDelayMs: 150,
      nativeSelfWake: false,
    },
  },
];

function entryFor(id: string | undefined): TetherLlmEntry {
  const found = id ? TETHER_LLM.find((e) => e.id === id) : undefined;
  // Unknown / undefined id → Claude (the safest default: a single newline-
  // appended wake, no separate submit to mis-fire).
  return found ?? TETHER_LLM[0];
}

/** Build the wake function for a `style` + resolved wake values. Data-driven —
 *  the ordered op sequence is determined by `style`, never by the CLI id. */
function buildWake(style: WakeStyle, v: WakeValues): (ctx: WakeContext) => Promise<void> {
  if (style === "inline-newline") {
    // Claude Code's TUI accepts a wake word with an appended newline cleanly, so
    // a single sendText(word, true) both types AND submits.
    return async (ctx) => {
      ctx.terminal.sendText(v.wakeText, true);
    };
  }
  // "type-then-submit" (Codex): the TUI swallows a newline embedded in the same
  // paste block AND a submit key sent before the paste settles. So: type the
  // instruction (no newline) → WAIT for the paste block to close → submit as a
  // SEPARATE event (a focused standalone CR via sendSequence, the twin of a real
  // keyboard Enter, is the only thing proven to make Codex submit).
  return async (ctx) => {
    ctx.terminal.sendText(v.wakeText, false);
    if (v.submitDelayMs > 0) await ctx.delay(v.submitDelayMs);
    if (v.submitMethod === "sendSequence") {
      await ctx.sendSequenceToTerminal(v.submitKey);
    } else {
      ctx.terminal.sendText(v.submitKey, false);
    }
  };
}

/** Per-call overrides the extension threads from config (Codex tuning). */
export interface CodexAdapterOptions {
  /** The full text injected into the Codex terminal — an INSTRUCTION, not a bare
   *  token. The extension templates the agent name in; defaults to
   *  DEFAULT_CODEX_WAKE_TEXT. */
  wakeText?: string;
  /** Separate submit key (default CR). */
  submitKey?: SubmitKey;
  /** Delay between typing the word and sending the submit key, so the paste
   *  block closes first (default 150ms). */
  submitDelayMs?: number;
  /** How to deliver the submit key (default "sendSequence"). */
  submitMethod?: SubmitMethod;
}

function applyOpts(v: WakeValues, opts?: CodexAdapterOptions): WakeValues {
  if (!opts) return v;
  return {
    wakeText: opts.wakeText ?? v.wakeText,
    submitKey: opts.submitKey ?? v.submitKey,
    submitMethod: opts.submitMethod ?? v.submitMethod,
    submitDelayMs: opts.submitDelayMs ?? v.submitDelayMs,
    nativeSelfWake: v.nativeSelfWake,
  };
}

/**
 * Resolve the adapter for a configured LLM id, data-drivenly from TETHER_LLM.
 * Unknown / undefined ids fall back to Claude (the safest default). `opts.codex`
 * threads per-call tuning onto the resolved entry's wake values (used for any
 * type-then-submit CLI, historically named for Codex).
 */
export function adapterFor(
  id: string | undefined,
  opts?: { codex?: CodexAdapterOptions },
): LlmAdapter {
  const entry = entryFor(id);
  const values = applyOpts(entry.wake, opts?.codex);
  return {
    id: entry.id,
    wakeWord: entry.wakeWord,
    wake: buildWake(entry.style, values),
  };
}

/** Default Claude adapter (single newline-appended `inbox`). */
export const claudeAdapter: LlmAdapter = adapterFor("claude");

/** Build a Codex adapter with optional tuning (CR/150ms/sendSequence defaults). */
export function makeCodexAdapter(opts?: CodexAdapterOptions): LlmAdapter {
  return adapterFor("codex", { codex: opts });
}

/** Default Codex adapter (CR, 150ms, sendSequence). */
export const codexAdapter: LlmAdapter = makeCodexAdapter();
