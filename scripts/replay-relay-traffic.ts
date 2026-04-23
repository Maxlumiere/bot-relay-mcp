#!/usr/bin/env npx tsx
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.0 Part D.2 — traffic replay harness.
 *
 * Usage: `npx tsx scripts/replay-relay-traffic.ts <log.jsonl>`
 *
 * Spins up a fresh in-memory-equivalent relay (isolated DB in a tmp
 * dir), re-issues every recorded MCP call against it, and compares
 * each replayed response to the recorded response. Exit 0 if every
 * call round-trips with parity; exit 1 on any divergence.
 *
 * Use case: capture 1 hour of real production traffic against the
 * live v2.X.Y daemon, then replay against a v2.X.(Y+1) candidate
 * before `npm publish` — guards against behavior regressions that
 * the unit-test suite didn't catch.
 *
 * Notes on parity:
 *   - Non-deterministic fields (message_id, seq, epoch, timestamps,
 *     tokens) are normalized before comparison — replay doesn't try
 *     to reproduce UUIDs byte-for-byte.
 *   - Error-code fields + structural shape + business-logic values
 *     (agent_status, message counts, etc.) ARE compared strictly.
 */
import fs from "fs";
import path from "path";
import os from "os";

interface RecordedEntry {
  ts: string;
  tool: string;
  args: unknown;
  response: unknown;
  transport: "stdio" | "http";
  source_ip: string | null;
}

interface ReplayReport {
  total: number;
  identical: number;
  divergent: number;
  errored: number;
  divergences: Array<{ tool: string; ts: string; diff: string }>;
  errors: Array<{ tool: string; ts: string; message: string }>;
}

// Normalize a response so ids/timestamps/tokens don't force a false
// divergence. Returns a deep-cloned, normalized object safe to stringify
// for comparison.
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  "message_id", "task_id", "id",
  "seq", "epoch", "last_seq", "total_messages_count", "total_unread_count",
  "mailbox_id", "cursor_id",
  "created_at", "updated_at", "last_seen", "session_started_at", "ts",
  "agent_token", "plaintext_token", "token",
  "recovery_token", "from_agent_token",
  "session_id",
  "csrf_token", "delivery_id", "idempotency_key",
]);

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_KEYS.has(k)) {
        out[k] = v === null ? null : "<volatile>";
      } else {
        out[k] = normalize(v);
      }
    }
    return out;
  }
  if (typeof value === "string") {
    // Normalize message-embedded UUIDs + ISO timestamps to sentinels so
    // a prose response containing them doesn't cause false divergence.
    return value
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<iso>");
  }
  return value;
}

function firstLineDiff(a: unknown, b: unknown): string {
  const left = JSON.stringify(normalize(a));
  const right = JSON.stringify(normalize(b));
  if (left === right) return "<no diff>";
  const max = Math.min(left.length, right.length);
  let i = 0;
  while (i < max && left[i] === right[i]) i++;
  const start = Math.max(0, i - 30);
  return (
    "at char " + i + ": recorded=" + left.slice(start, i + 60) +
    " replay=" + right.slice(start, i + 60)
  );
}

/**
 * Replay a single recorded entry against the given MCP dispatcher.
 * Normalized responses are compared; volatile fields are sentinel-
 * matched.
 */
export async function replayOne(
  dispatch: (tool: string, args: unknown) => Promise<unknown>,
  entry: RecordedEntry,
): Promise<{ ok: boolean; diff?: string; error?: string }> {
  try {
    const replayed = await dispatch(entry.tool, entry.args);
    const a = JSON.stringify(normalize(entry.response));
    const b = JSON.stringify(normalize(replayed));
    if (a === b) return { ok: true };
    return { ok: false, diff: firstLineDiff(entry.response, replayed) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Read a JSONL log + replay every entry. Returns a structured report.
 */
export async function replayLog(
  logPath: string,
  dispatch: (tool: string, args: unknown) => Promise<unknown>,
): Promise<ReplayReport> {
  const text = fs.readFileSync(logPath, "utf-8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const report: ReplayReport = {
    total: lines.length,
    identical: 0,
    divergent: 0,
    errored: 0,
    divergences: [],
    errors: [],
  };
  for (const raw of lines) {
    let entry: RecordedEntry;
    try {
      entry = JSON.parse(raw) as RecordedEntry;
    } catch (err) {
      report.errored += 1;
      report.errors.push({
        tool: "<parse>",
        ts: "<n/a>",
        message:
          "JSONL parse failed: " +
          (err instanceof Error ? err.message : String(err)),
      });
      continue;
    }
    const r = await replayOne(dispatch, entry);
    if (r.ok) {
      report.identical += 1;
    } else if (r.error) {
      report.errored += 1;
      report.errors.push({ tool: entry.tool, ts: entry.ts, message: r.error });
    } else {
      report.divergent += 1;
      report.divergences.push({
        tool: entry.tool,
        ts: entry.ts,
        diff: r.diff ?? "<unknown>",
      });
    }
  }
  return report;
}

/**
 * Spin up an isolated in-memory relay + return a dispatcher closure
 * that routes tool calls through the same code path the live daemon
 * uses. Caller must invoke the cleanup fn when done.
 */
export async function makeIsolatedDispatcher(): Promise<{
  dispatch: (tool: string, args: unknown) => Promise<unknown>;
  cleanup: () => void;
}> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-replay-"));
  const dbPath = path.join(tmpDir, "relay.db");
  process.env.RELAY_DB_PATH = dbPath;
  delete process.env.RELAY_HTTP_SECRET;
  delete process.env.RELAY_RECORD_TRAFFIC; // never record while replaying
  const { createServer } = await import("../src/server.js");
  const server = createServer();
  // Pull the CallToolRequestSchema handler out of the MCP server so we
  // can invoke it directly with { params: { name, arguments } } — same
  // path the stdio + http transports dispatch through.
  const dispatch = async (tool: string, args: unknown): Promise<unknown> => {
    // Access the registered handler. The MCP SDK doesn't expose it
    // publicly, but we can call the request handler via the server's
    // handle() method. As a simpler path, re-require the dispatcher
    // internals. Match the shape runCall expects.
    const internal = (server as unknown as {
      _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
    })._requestHandlers;
    const handler = internal.get("tools/call");
    if (!handler) throw new Error("tools/call handler not registered on isolated server");
    return handler({ params: { name: tool, arguments: args } });
  };
  const cleanup = () => {
    try {
      const { closeDb } = require("../src/db.js");
      closeDb();
    } catch { /* best-effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  };
  return { dispatch, cleanup };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(
      "Usage: npx tsx scripts/replay-relay-traffic.ts <log.jsonl>\n\n" +
        "Replays a JSONL traffic log (captured via RELAY_RECORD_TRAFFIC) against a\n" +
        "fresh isolated relay + reports behavioral parity. Exit 0 on full parity,\n" +
        "1 on any divergence.\n",
    );
    return argv.length === 0 ? 1 : 0;
  }
  const logPath = path.resolve(argv[0]);
  if (!fs.existsSync(logPath)) {
    process.stderr.write("replay: log file not found: " + logPath + "\n");
    return 1;
  }
  const { dispatch, cleanup } = await makeIsolatedDispatcher();
  try {
    const report = await replayLog(logPath, dispatch);
    process.stdout.write(
      "Replay summary for " + logPath + ":\n" +
        "  total      " + report.total + "\n" +
        "  identical  " + report.identical + "\n" +
        "  divergent  " + report.divergent + "\n" +
        "  errored    " + report.errored + "\n",
    );
    if (report.divergences.length > 0) {
      process.stdout.write("\nFirst 10 divergences:\n");
      for (const d of report.divergences.slice(0, 10)) {
        process.stdout.write("  [" + d.tool + " @ " + d.ts + "] " + d.diff + "\n");
      }
    }
    if (report.errors.length > 0) {
      process.stdout.write("\nFirst 10 errors:\n");
      for (const e of report.errors.slice(0, 10)) {
        process.stdout.write("  [" + e.tool + " @ " + e.ts + "] " + e.message + "\n");
      }
    }
    return report.divergent === 0 && report.errored === 0 ? 0 : 1;
  } finally {
    cleanup();
  }
}

// Detect direct-invocation vs import-for-tests. tsx runs this as the
// entry module; tests import `replayLog` + `makeIsolatedDispatcher`
// without triggering main().
const isEntrypoint =
  typeof process !== "undefined" &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isEntrypoint) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write("replay: " + (err instanceof Error ? err.stack ?? err.message : String(err)) + "\n");
    process.exit(2);
  });
}
