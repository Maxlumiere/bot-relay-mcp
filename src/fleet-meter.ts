// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0040 — the context meter. One PURE function over one transcript's text
 * (Claude Code JSONL or a Codex rollout), plus a thin file reader.
 *
 * ALLOWLIST, never denylist (ADR-0040 Q3): each line is parsed and only the
 * fields named below are read out of it — model, usage numbers, compaction
 * markers, the session / parent ids. Nothing else is retained, and the result
 * type has no field that could carry transcript content. Derived at render time,
 * never stored (R5).
 *
 * THE WINDOW IS NOT IN A CLAUDE TRANSCRIPT (MEASURED 24 Sep): a 1M-context
 * session records `claude-opus-5-5` with no `[1m]` marker. So a Claude window
 * comes from, in order: a caller's DECLARATION the evidence does not disprove;
 * INFERENCE from evidence (observed context, or a compaction's preTokens, above
 * the smaller known window proves the larger one); otherwise UNKNOWN. Never a
 * guessed default: a guessed 1M under-alarms a 200k session, and `unknown` is not
 * an all-clear. Codex records `model_context_window` itself.
 *
 * SUB-AGENTS ARE NOT RESUMABLE (victra, 24 Sep): a Codex rollout with
 * source.subagent or parent_thread_id, or a Claude transcript whose entries are
 * sidechain entries with an agentId, points at its PARENT.
 */
import fs from "fs";

export interface MeterThresholds {
  /** Fraction of the window at which the meter turns amber. Default 0.40. */
  amber: number;
  /** Fraction of the window at which the meter turns red. Default 0.70. */
  red: number;
}

export interface MeterOptions {
  /** The window the caller knows this session has (e.g. from its launch intent). */
  declaredWindow?: number;
  thresholds?: MeterThresholds;
}

export type MeterLevel = "ok" | "amber" | "red" | "unknown";

export interface MeterResult {
  /**
   * The transcript FORMAT, detected from content — not a CLI identity. Same
   * precedent as HookInstall.format in agent-cli-profiles.ts.
   */
  format: "claude-jsonl" | "codex-rollout" | "unknown";
  model: string | null;
  contextTokens: number | null;
  window: number | null;
  windowSource: "recorded" | "declared" | "inferred" | "unknown";
  fraction: number | null;
  level: MeterLevel;
  compactions: number;
  subagent: boolean;
  resumable: boolean;
  /** The conversation to resume: this one, or the parent of a sub-agent. */
  resumeTarget: string | null;
  unparseableLines: number;
}

export const DEFAULT_METER_THRESHOLDS: MeterThresholds = { amber: 0.4, red: 0.7 };

/** Claude context windows, ascending. The transcript does not say which applies. */
export const KNOWN_CLAUDE_WINDOWS = [200_000, 1_000_000] as const;

const MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,79}$/;
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function model(v: unknown): string | null {
  return typeof v === "string" && MODEL_SHAPE.test(v) ? v : null;
}

function id(v: unknown): string | null {
  return typeof v === "string" && ID_SHAPE.test(v) ? v : null;
}

function checkThresholds(t: MeterThresholds): void {
  const ok =
    Number.isFinite(t.amber) && Number.isFinite(t.red) && t.amber > 0 && t.amber < t.red && t.red <= 1;
  if (!ok) {
    throw new Error(`meter thresholds must satisfy 0 < amber < red <= 1 (got amber=${t.amber}, red=${t.red})`);
  }
}

function levelFor(fraction: number | null, t: MeterThresholds): MeterLevel {
  if (fraction === null) return "unknown";
  if (fraction >= t.red) return "red";
  if (fraction >= t.amber) return "amber";
  return "ok";
}

interface ClaudeAssistant {
  model: string | null;
  tokens: number | null;
  sidechain: boolean;
}

export function meterFromTranscript(text: string, opts: MeterOptions = {}): MeterResult {
  const thresholds = opts.thresholds ?? DEFAULT_METER_THRESHOLDS;
  checkThresholds(thresholds);

  let unparseableLines = 0;
  let format: MeterResult["format"] = "unknown";

  // Claude facts
  const assistants: ClaudeAssistant[] = [];
  const preTokens: number[] = [];
  let claudeCompactions = 0;
  let claudeSession: string | null = null;
  let claudeSubagent = false;

  // Codex facts
  let codexId: string | null = null;
  let codexParent: string | null = null;
  let codexSubagent = false;
  let codexModel: string | null = null;
  let codexTokens: number | null = null;
  let codexWindow: number | null = null;
  let codexCompactions = 0;

  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      unparseableLines++;
      continue;
    }
    const e = obj(parsed);
    if (!e) {
      unparseableLines++;
      continue;
    }
    const type = e.type;
    const payload = obj(e.payload);

    // ── Codex ──
    if (type === "session_meta" && payload) {
      format = "codex-rollout";
      codexId = id(payload.id);
      codexParent = id(payload.parent_thread_id);
      const src = obj(payload.source);
      codexSubagent = (src !== null && "subagent" in src) || typeof payload.parent_thread_id === "string";
      continue;
    }
    if (type === "turn_context" && payload) {
      format = "codex-rollout";
      codexModel = model(payload.model) ?? codexModel;
      continue;
    }
    if (type === "event_msg" && payload?.type === "token_count") {
      format = "codex-rollout";
      const info = obj(payload.info);
      const last = obj(info?.last_token_usage);
      // cached_input_tokens is a SUBSET of input_tokens (MEASURED), not an addend.
      const t = count(last?.input_tokens);
      if (t !== null) codexTokens = t;
      const w = count(info?.model_context_window);
      if (w !== null && w > 0) codexWindow = w;
      continue;
    }
    if (type === "compacted") {
      format = "codex-rollout";
      codexCompactions++;
      continue;
    }

    // ── Claude ──
    if (type === "system" && e.subtype === "compact_boundary") {
      claudeCompactions++;
      const pre = count(obj(e.compactMetadata)?.preTokens);
      if (pre !== null) preTokens.push(pre);
      claudeSession = id(e.sessionId) ?? claudeSession;
      continue;
    }
    if (type === "assistant") {
      const msg = obj(e.message);
      if (!msg) continue;
      if (format === "unknown") format = "claude-jsonl";
      const sidechain = e.isSidechain === true;
      if (sidechain && typeof e.agentId === "string") claudeSubagent = true;
      const u = obj(msg.usage);
      const parts = u ? [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].map(count) : [];
      const tokens = parts.length === 3 && parts.every((p) => p !== null) ? (parts as number[]).reduce((a, b) => a + b, 0) : null;
      assistants.push({ model: model(msg.model), tokens, sidechain });
      claudeSession = id(e.sessionId) ?? claudeSession;
    }
  }

  const base = { compactions: 0, unparseableLines };

  if (format === "codex-rollout") {
    const fraction = codexTokens !== null && codexWindow !== null ? codexTokens / codexWindow : null;
    const resumeTarget = codexSubagent ? codexParent : codexId;
    return {
      ...base,
      format,
      model: codexModel,
      contextTokens: codexTokens,
      window: codexWindow,
      windowSource: codexWindow !== null ? "recorded" : "unknown",
      fraction,
      level: levelFor(fraction, thresholds),
      compactions: codexCompactions,
      subagent: codexSubagent,
      resumable: !codexSubagent && codexId !== null,
      resumeTarget,
    };
  }

  // A sub-agent transcript's own entries ARE its context. In a main transcript a
  // sidechain entry belongs to some other context and must not stand in for it.
  const relevant = claudeSubagent ? assistants : assistants.filter((a) => !a.sidechain);
  const newestModel = [...relevant].reverse().find((a) => a.model !== null)?.model ?? null;
  const contextTokens = [...relevant].reverse().find((a) => a.tokens !== null)?.tokens ?? null;

  const evidence = Math.max(0, ...relevant.map((a) => a.tokens ?? 0), ...preTokens);
  let window: number | null = null;
  let windowSource: MeterResult["windowSource"] = "unknown";
  const declared = opts.declaredWindow;
  if (declared !== undefined && Number.isInteger(declared) && declared > 0 && declared >= evidence) {
    window = declared;
    windowSource = "declared";
  } else if (evidence > KNOWN_CLAUDE_WINDOWS[0]) {
    const w = KNOWN_CLAUDE_WINDOWS.find((k) => k >= evidence);
    if (w !== undefined) {
      window = w;
      windowSource = "inferred";
    }
  }

  const fraction = contextTokens !== null && window !== null ? contextTokens / window : null;
  return {
    ...base,
    format,
    model: newestModel,
    contextTokens,
    window,
    windowSource,
    fraction,
    level: levelFor(fraction, thresholds),
    compactions: claudeCompactions,
    subagent: claudeSubagent,
    resumable: !claudeSubagent && claudeSession !== null,
    resumeTarget: claudeSession,
  };
}

/** Read one transcript file and meter it. Throws if the file cannot be read. */
export function readTranscriptMeter(path: string, opts: MeterOptions = {}): MeterResult {
  return meterFromTranscript(fs.readFileSync(path, "utf-8"), opts);
}
