// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

// #inbox-preview-fragment (victra defect #3, 2026-08-31) — the notification/inbox PREVIEW must not
// be a fragment a reader can mistake for the whole. buildInboxSnapshot (the relay://inbox/<agent>
// resource the Tether wake-notification subscribes to), get_messages_summary, and get_outstanding
// each used to emit a bare truncated slice plus a SEPARATE `*_truncated` boolean. A renderer/reader
// that shows the text without consulting the boolean (extension.ts:1216 does) presented the fragment
// as complete — how gaming-build missed three instructions past the cap. The fix embeds the marker IN
// the preview TEXT (shared truncatedPreview helper), so a reader who ignores the boolean still sees it.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-preview-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const { registerAgent, sendMessage, closeDb } = await import("../src/db.js");
const { readResource } = await import("../src/mcp-resources.js");
const { truncatedPreview } = await import("../src/preview.js");

function cleanup(): void {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(cleanup);
afterEach(cleanup);

function inboxSnapshot(agent: string): Record<string, unknown> {
  return JSON.parse(readResource(`relay://inbox/${agent}`).text);
}
// A marker a reader could see IN THE TEXT (ellipsis or an explicit truncation word).
const HAS_IN_TEXT_MARKER = (s: string): boolean => /…|\.\.\.|truncat|\[\+|read in full|more\b/i.test(s);

describe("#inbox-preview-fragment — the preview reveals truncation IN THE TEXT", () => {
  it("FIX: a long message's last_message_preview carries an in-text marker — a reader who ignores the boolean cannot be fooled", () => {
    registerAgent("sender", "s", []);
    registerAgent("recip", "r", []);
    const body = "INSTRUCTION 1: ship X.\n" + "y".repeat(400) + "\nINSTRUCTION 2: also ship Z.";
    sendMessage("sender", "recip", body, "high");

    const snap = inboxSnapshot("recip");
    const preview = snap.last_message_preview as string;
    expect(snap.last_message_truncated, "the boolean still agrees").toBe(true);
    // The marker is IN the text — testing the CLAIM (cannot be fooled), not the boolean.
    expect(HAS_IN_TEXT_MARKER(preview), "the preview text itself reveals it is a fragment").toBe(true);
    expect(preview, "names how much was omitted").toMatch(/\[\+\d+ chars truncated/);
    // the leading content is still present (not sacrificed to the marker)
    expect(preview.startsWith("INSTRUCTION 1: ship X.")).toBe(true);
  });

  it("CONTROL: a short message's preview is the full body, no marker, not truncated", () => {
    registerAgent("sender", "s", []);
    registerAgent("recip2", "r", []);
    sendMessage("sender", "recip2", "short and complete", "normal");

    const snap = inboxSnapshot("recip2");
    expect(snap.last_message_truncated).toBe(false);
    expect(snap.last_message_preview).toBe("short and complete");
    expect(HAS_IN_TEXT_MARKER(snap.last_message_preview as string)).toBe(false);
  });

  it("SSOT helper truncatedPreview: over the cap → in-text marker + boolean; at/under → full text, no marker", () => {
    const long = "a".repeat(50);
    const r = truncatedPreview(long, 10);
    expect(r.truncated).toBe(true);
    expect(r.preview.startsWith("aaaaaaaaaa")).toBe(true);
    expect(r.preview).toMatch(/\[\+40 chars truncated/);
    expect(HAS_IN_TEXT_MARKER(r.preview)).toBe(true);

    const short = truncatedPreview("hi", 10);
    expect(short.truncated).toBe(false);
    expect(short.preview).toBe("hi");
    // exact-cap boundary is NOT truncated (length === max)
    expect(truncatedPreview("0123456789", 10).truncated).toBe(false);
  });
});
