// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0040 item 1 — the context meter: a PURE reader over one transcript.
 *
 * Architect (ADR-0040 Q1/Q3): model = the NEWEST assistant entry (a mid-session
 * /model must show); context = input + cache_read + cache_creation of that entry;
 * compaction count; thresholds as a FRACTION of the model's window (defaults 40%
 * amber, 70% red — victra). Transcript reading is ALLOWLISTED: extract the usage
 * numbers and the model, never copy any transcript content anywhere.
 *
 * Victra (24 Sep): a Codex SUB-AGENT rollout (source.subagent / parent_thread_id)
 * is NOT resumable; the meter points at the parent. The same holds for a Claude
 * sub-agent transcript (isSidechain + agentId), whose sessionId is the parent's.
 *
 * FIXTURE SHAPES ARE MEASURED, not invented (Claude Code 2.1.272 and Codex
 * rollouts on this machine, 24 Sep; keys only, no content read):
 *   Claude  assistant  {type, isSidechain, sessionId, message:{model, usage:{input_tokens,
 *                       cache_read_input_tokens, cache_creation_input_tokens, output_tokens}}}
 *           compaction {type:"system", subtype:"compact_boundary", compactMetadata:{preTokens, ...}}
 *           the model string carries NO window marker: a 1M session records "claude-opus-5-5"
 *           (MEASURED: this very session, and a compacted one with preTokens 969632).
 *   Codex   session_meta {payload:{id, source:"cli" | {subagent:{...}}, parent_thread_id}}
 *           turn_context {payload:{model}}
 *           token_count  {payload:{type:"token_count", info:{model_context_window,
 *                          last_token_usage:{input_tokens, cached_input_tokens, ...}}}}
 *           cached_input_tokens is a SUBSET of input_tokens (MEASURED 226313 vs 225920),
 *           so context = input_tokens, not the sum.
 *           compaction {type:"compacted", payload:{...}}
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const SECRET = "SECRET-TRANSCRIPT-CONTENT-must-never-leave-7f3a";
const SID = "32e92508-b5ce-4bc3-b3c7-f96944f90d93";
const PARENT = "01a0a96c-6b52-7c11-9e6a-59da5d914e48";
const CHILD = "01a0d26f-26bb-7fc1-b3bb-4077cb2a840c";

function jsonl(...rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function claudeAssistant(model: string, tokens: { input: number; read: number; create: number }, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    isSidechain: false,
    sessionId: SID,
    message: {
      model,
      content: [{ type: "text", text: SECRET }],
      usage: {
        input_tokens: tokens.input,
        cache_read_input_tokens: tokens.read,
        cache_creation_input_tokens: tokens.create,
        output_tokens: 99,
      },
    },
    ...extra,
  };
}

const claudeUser = { type: "user", isSidechain: false, sessionId: SID, message: { role: "user", content: SECRET } };
const claudeTitle = { type: "custom-title", customTitle: SECRET };
const compactBoundary = (pre: number) => ({
  type: "system",
  subtype: "compact_boundary",
  sessionId: SID,
  content: SECRET,
  compactMetadata: { trigger: "auto", preTokens: pre, postTokens: 14105 },
});

const codexMeta = (id: string, source: unknown, parent: string | null) => ({
  type: "session_meta",
  payload: { id, source, parent_thread_id: parent, base_instructions: SECRET, cwd: "/x" },
});
const codexTurn = (model: string) => ({ type: "turn_context", payload: { model, user_instructions: SECRET } });
const codexTokens = (input: number, cached: number, window: number) => ({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      model_context_window: window,
      last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: 35, total_tokens: input + 35 },
      total_token_usage: { input_tokens: 9_999_999 },
    },
  },
});
const codexMessage = { type: "response_item", payload: { type: "message", content: [{ text: SECRET }] } };

async function meter() {
  return import("../src/fleet-meter.js");
}

describe("ADR-0040 meter — Claude transcripts", () => {
  it("model and context come from the NEWEST main-context assistant entry (a mid-session /model shows)", async () => {
    const { meterFromTranscript } = await meter();
    const r = meterFromTranscript(
      jsonl(
        claudeUser,
        claudeAssistant("claude-sonnet-5", { input: 10, read: 1000, create: 5 }),
        claudeAssistant("claude-opus-5-5", { input: 2, read: 220185, create: 2688 }),
      ),
    );
    expect(r.format).toBe("claude-jsonl");
    expect(r.model).toBe("claude-opus-5-5");
    expect(r.contextTokens).toBe(2 + 220185 + 2688);
    expect(r.resumable).toBe(true);
    expect(r.resumeTarget).toBe(SID);
  });

  it("a sidechain entry inside a main transcript does not stand in for the main context", async () => {
    const { meterFromTranscript } = await meter();
    const r = meterFromTranscript(
      jsonl(
        claudeAssistant("claude-opus-5-5", { input: 1, read: 50_000, create: 0 }),
        claudeAssistant("claude-haiku-4-5-20251001", { input: 1, read: 3_000, create: 0 }, { isSidechain: true }),
      ),
    );
    expect(r.model).toBe("claude-opus-5-5");
    expect(r.contextTokens).toBe(50_001);
  });

  it("the WINDOW is not in the model string: with no evidence and no declaration it is UNKNOWN, never a guessed 200k or 1M", async () => {
    const { meterFromTranscript } = await meter();
    const r = meterFromTranscript(jsonl(claudeAssistant("claude-opus-5-5", { input: 1, read: 150_000, create: 0 })));
    expect(r.window).toBeNull();
    expect(r.windowSource).toBe("unknown");
    expect(r.fraction).toBeNull();
    expect(r.level, "an unknown window is not an all-clear").toBe("unknown");
  });

  it("observed context above 200k PROVES the 1M window (inferred), and the level is computed against it", async () => {
    const { meterFromTranscript } = await meter();
    const r = meterFromTranscript(jsonl(claudeAssistant("claude-opus-5-5", { input: 2, read: 420_000, create: 0 })));
    expect(r.window).toBe(1_000_000);
    expect(r.windowSource).toBe("inferred");
    expect(r.level).toBe("amber");
  });

  it("a compaction's preTokens is evidence too: a session compacted at 969k had a 1M window even if it is small now", async () => {
    const { meterFromTranscript } = await meter();
    const r = meterFromTranscript(
      jsonl(compactBoundary(969_632), claudeAssistant("claude-opus-5-5", { input: 1, read: 14_000, create: 0 })),
    );
    expect(r.window).toBe(1_000_000);
    expect(r.windowSource).toBe("inferred");
    expect(r.compactions).toBe(1);
    expect(r.level).toBe("ok");
  });

  it("a DECLARED window is used when the evidence does not contradict it", async () => {
    const { meterFromTranscript } = await meter();
    const r = meterFromTranscript(jsonl(claudeAssistant("claude-sonnet-5", { input: 1, read: 150_000, create: 0 })), {
      declaredWindow: 200_000,
    });
    expect(r.window).toBe(200_000);
    expect(r.windowSource).toBe("declared");
    expect(r.level).toBe("red"); // 150001 / 200000 = 0.75
  });

  it("a declaration the evidence DISPROVES loses to the evidence (a 200k declaration cannot hold 420k)", async () => {
    const { meterFromTranscript } = await meter();
    const r = meterFromTranscript(jsonl(claudeAssistant("claude-opus-5-5", { input: 0, read: 420_000, create: 0 })), {
      declaredWindow: 200_000,
    });
    expect(r.window).toBe(1_000_000);
    expect(r.windowSource).toBe("inferred");
  });

  it("counts every compaction boundary", async () => {
    const { meterFromTranscript } = await meter();
    const r = meterFromTranscript(
      jsonl(
        compactBoundary(950_000),
        claudeAssistant("claude-opus-5-5", { input: 1, read: 1, create: 1 }),
        compactBoundary(960_000),
        claudeAssistant("claude-opus-5-5", { input: 1, read: 1, create: 1 }),
      ),
    );
    expect(r.compactions).toBe(2);
  });

  it("a Claude SUB-AGENT transcript is not resumable and points at the parent session", async () => {
    const { meterFromTranscript } = await meter();
    const r = meterFromTranscript(
      jsonl(
        claudeAssistant("claude-haiku-4-5-20251001", { input: 1, read: 30_000, create: 0 }, {
          isSidechain: true,
          agentId: "a7fd6783b23434a9f",
        }),
      ),
    );
    expect(r.subagent).toBe(true);
    expect(r.resumable).toBe(false);
    expect(r.resumeTarget, "resume the parent, never the sub-agent").toBe(SID);
    expect(r.contextTokens).toBe(30_001);
  });
});

describe("ADR-0040 meter — Codex rollouts", () => {
  it("window is RECORDED; context is input_tokens (cached is a subset, not an addend)", async () => {
    const { meterFromTranscript } = await meter();
    const r = meterFromTranscript(
      jsonl(codexMeta(PARENT, "cli", null), codexTurn("gpt-6-sol"), codexMessage, codexTokens(226_313, 225_920, 258_400)),
    );
    expect(r.format).toBe("codex-rollout");
    expect(r.model).toBe("gpt-6-sol");
    expect(r.contextTokens).toBe(226_313);
    expect(r.window).toBe(258_400);
    expect(r.windowSource).toBe("recorded");
    expect(r.level).toBe("red");
    expect(r.resumable).toBe(true);
    expect(r.resumeTarget).toBe(PARENT);
  });

  it("a SUB-AGENT rollout (source.subagent + parent_thread_id) is NOT resumable and points at the parent (victra, 01a0aa04 case)", async () => {
    const { meterFromTranscript } = await meter();
    const r = meterFromTranscript(
      jsonl(codexMeta(CHILD, { subagent: { other: "guardian" } }, PARENT), codexTurn("codex-auto-review"), codexTokens(18_387, 17_152, 258_400)),
    );
    expect(r.subagent).toBe(true);
    expect(r.resumable).toBe(false);
    expect(r.resumeTarget).toBe(PARENT);
  });

  it("parent_thread_id alone marks a sub-agent even when source is a plain string", async () => {
    const { meterFromTranscript } = await meter();
    const r = meterFromTranscript(jsonl(codexMeta(CHILD, "cli", PARENT), codexTokens(1, 0, 258_400)));
    expect(r.resumable).toBe(false);
    expect(r.resumeTarget).toBe(PARENT);
  });

  it("counts compacted entries", async () => {
    const { meterFromTranscript } = await meter();
    const r = meterFromTranscript(
      jsonl(codexMeta(PARENT, "cli", null), { type: "compacted", payload: { message: SECRET } }, { type: "compacted", payload: {} }, codexTokens(1, 0, 258_400)),
    );
    expect(r.compactions).toBe(2);
  });
});

describe("ADR-0040 meter — allowlist, thresholds, robustness", () => {
  it("NEVER copies transcript content: the result holds only allowlisted fields and no content string", async () => {
    const { meterFromTranscript } = await meter();
    for (const text of [
      jsonl(claudeTitle, claudeUser, compactBoundary(900_000), claudeAssistant("claude-opus-5-5", { input: 1, read: 2, create: 3 })),
      jsonl(codexMeta(PARENT, "cli", null), codexTurn("gpt-6-sol"), codexMessage, codexTokens(5, 1, 258_400)),
    ]) {
      const r = meterFromTranscript(text);
      expect(JSON.stringify(r)).not.toContain(SECRET);
      expect(Object.keys(r).sort()).toEqual(
        [
          "compactions",
          "contextTokens",
          "fraction",
          "format",
          "level",
          "model",
          "resumable",
          "resumeTarget",
          "subagent",
          "unparseableLines",
          "window",
          "windowSource",
        ].sort(),
      );
    }
  });

  it("a hostile MODEL string is not echoed: only a model-shaped value survives", async () => {
    const { meterFromTranscript } = await meter();
    const r = meterFromTranscript(jsonl(claudeAssistant(`x\n${SECRET}; rm -rf ~`, { input: 1, read: 1, create: 1 })));
    expect(r.model).toBeNull();
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("thresholds default to 40% amber / 70% red, boundaries inclusive", async () => {
    const { meterFromTranscript } = await meter();
    const at = (n: number) =>
      meterFromTranscript(jsonl(claudeAssistant("claude-sonnet-5", { input: 0, read: n, create: 0 })), { declaredWindow: 200_000 }).level;
    expect(at(79_999)).toBe("ok");
    expect(at(80_000)).toBe("amber");
    expect(at(139_999)).toBe("amber");
    expect(at(140_000)).toBe("red");
  });

  it("thresholds are configurable, and nonsense thresholds are refused loudly", async () => {
    const { meterFromTranscript } = await meter();
    const t = jsonl(claudeAssistant("claude-sonnet-5", { input: 0, read: 100_000, create: 0 }));
    expect(meterFromTranscript(t, { declaredWindow: 200_000, thresholds: { amber: 0.6, red: 0.9 } }).level).toBe("ok");
    expect(() => meterFromTranscript(t, { thresholds: { amber: 0.8, red: 0.5 } })).toThrow(/threshold/i);
    expect(() => meterFromTranscript(t, { thresholds: { amber: 0, red: 0.5 } })).toThrow(/threshold/i);
    expect(() => meterFromTranscript(t, { thresholds: { amber: 0.5, red: 1.5 } })).toThrow(/threshold/i);
  });

  it("unparseable lines are skipped AND counted, so a torn file is visible rather than silently smaller", async () => {
    const { meterFromTranscript } = await meter();
    const r = meterFromTranscript(
      "{not json\n" + jsonl(claudeAssistant("claude-opus-5-5", { input: 1, read: 1, create: 1 })) + '{"type":"assistant"',
    );
    expect(r.unparseableLines).toBe(2);
    expect(r.contextTokens).toBe(3);
  });

  it("an empty or usage-free transcript yields unknowns, not zeros that read as an empty context", async () => {
    const { meterFromTranscript } = await meter();
    const r = meterFromTranscript(jsonl(claudeUser, claudeTitle));
    expect(r.contextTokens).toBeNull();
    expect(r.model).toBeNull();
    expect(r.level).toBe("unknown");
  });

  it("readTranscriptMeter reads a file through the same pure function", async () => {
    const { readTranscriptMeter, meterFromTranscript } = await meter();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adr0040-meter-"));
    const f = path.join(dir, "t.jsonl");
    const text = jsonl(claudeAssistant("claude-opus-5-5", { input: 3, read: 4, create: 5 }));
    fs.writeFileSync(f, text);
    try {
      expect(readTranscriptMeter(f)).toEqual(meterFromTranscript(text));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
