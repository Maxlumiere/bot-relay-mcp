// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.3.0 Part C.3 — `peek_inbox_version` MCP tool handler.
 *
 * Pure observation. Returns the current mailbox shape for an agent:
 * `{mailbox_id, epoch, last_seq, total_messages_count, total_unread_count}`.
 * Callers use this to detect "anything new arrived since my last
 * observation" WITHOUT consuming messages (distinct from
 * `get_messages`'s default consume-once semantic). Intended for the
 * Phase 4s ambient-wake pattern — wake on a cheap peek, drain via
 * `get_messages` only when `total_unread_count > 0` or `epoch`
 * differs from the cached one.
 *
 * The wake signal is `total_unread_count`, NOT `last_seq` (v2.3.0
 * Codex HIGH #2 contract at src/db.ts:3014-3021). `seq` is assigned
 * on FIRST OBSERVATION — i.e., the recipient's get_messages drain
 * path at src/db.ts:3181-3199 runs UPDATE messages SET seq = ...
 * WHERE seq IS NULL — so `last_seq` doesn't advance on delivery
 * and won't reflect pre-first-observation new mail. Watching
 * `last_seq` alone will miss every fresh arrival.
 *
 * Auth model: same as `get_messages`. The dispatcher's enforceAuth
 * step handles token verification before we're called; this handler
 * trusts that gate.
 *
 * Epoch semantics (per Codex Q9 2026-04-19): a client's cached
 * `last_seen_seq` is only comparable if its cached epoch matches the
 * server's current epoch. Mismatch = DB was backed-up/restored; the
 * client MUST reset its local last_seen to 0 and drain from scratch.
 */
import type { PeekInboxVersionInput } from "../types.js";
import { peekMailboxVersion } from "../db.js";

export function handlePeekInboxVersion(input: PeekInboxVersionInput) {
  const snapshot = peekMailboxVersion(input.agent_name);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            ...snapshot,
          },
          null,
          2,
        ),
      },
    ],
  };
}
