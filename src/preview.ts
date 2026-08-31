// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #inbox-preview-fragment (victra defect #3) — build a message preview whose TEXT ITSELF reveals
 * truncation, so a reader cannot mistake a fragment for the whole message.
 *
 * A preview accompanied ONLY by a separate `truncated` boolean lets any renderer or reader that
 * shows the text without consulting the flag present a fragment as complete. The Tether extension
 * renders `last_message_preview` without checking `last_message_truncated`, so a wake notification
 * silently drops everything past the cap — which cost a real agent three instructions. This is the
 * same shape as the get_messages `has_more` defect: a completeness signal SEPARABLE from the content
 * can be ignored. So the marker goes IN the string. A reader who ignores the boolean STILL sees
 * "…[+N chars truncated…]" at the end and cannot be fooled — the test is exactly that the signal
 * cannot be discarded independently of the content.
 *
 * The `truncated` boolean is kept alongside (belt-and-suspenders for consumers that DO branch on it),
 * but correctness no longer depends on anyone reading it.
 */
export function truncatedPreview(text: string, max: number): { preview: string; truncated: boolean } {
  if (text.length <= max) return { preview: text, truncated: false };
  const omitted = text.length - max;
  return {
    preview: `${text.slice(0, max)} …[+${omitted} chars truncated — drain the message to read it in full]`,
    truncated: true,
  };
}
