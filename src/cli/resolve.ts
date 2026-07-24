// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay resolve <message-id> [<message-id>...]` subcommand.
 *
 * Closes the mute-session gap: an agent whose MCP transport is down can READ its
 * inbox (direct DB) and SEND (`relay send`), but resolving mail was MCP-only — so
 * a mute agent's inbox filled with already-handled messages that kept
 * re-surfacing as pending (and someone had to resolve on its behalf). This calls
 * the SAME resolve_messages path over the local daemon's /mcp endpoint,
 * authenticating as the env agent (RELAY_AGENT_NAME + its token) exactly as an
 * MCP resolve_messages would — no impersonation bypass.
 *
 * STREAM DISCIPLINE (matches `relay send`): the clean parseable result — the
 * resolved message ids, one per line — is the ONLY thing on stdout; the human
 * confirmation, usage, and every error go to STDERR; a failed resolve (nothing
 * resolved, bad ids, auth/transport failure) exits NON-ZERO so `$(relay resolve …)`
 * fails loudly instead of capturing an empty/garbage value.
 */
import { isValidTokenShape } from "../spawn/validation.js";

interface Args {
  messageIds: string[];
  agent: string | null;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { messageIds: [], agent: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--agent") {
      const v = argv[++i];
      if (!v) throw new Error("--agent requires an agent name");
      out.agent = v;
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      out.messageIds.push(a);
    }
  }
  return out;
}

function usage(requested = false): void {
  // STREAM DISCIPLINE: usage is diagnostic on the ERROR path → STDERR; only an
  // explicit --help makes the text the requested data (→ STDOUT).
  (requested ? process.stdout : process.stderr).write(
    "Usage: relay resolve <message-id> [<message-id>...] [--agent NAME] [--json]\n\n" +
      "Permanently resolve (ack) your OWN inbox messages so they stop re-surfacing\n" +
      "as pending — the CLI path for MCP-mute sessions (resolve is otherwise MCP-only).\n" +
      "Calls the local daemon's resolve_messages, authenticating as the env agent.\n\n" +
      "  <message-id>   One or more message ids to resolve (only ids addressed to\n" +
      "                 you are affected; unknown/foreign ids are skipped).\n" +
      "  --agent NAME   Recipient agent (default: $RELAY_AGENT_NAME).\n" +
      "  --json         Emit the JSON response on stdout.\n" +
      "  --help         Show this message.\n\n" +
      "Token resolution: $RELAY_AGENT_TOKEN → per-instance vault. Sent as the agent\n" +
      "token — the relay authenticates you exactly as it would for MCP. STDOUT carries\n" +
      "ONLY the resolved ids (one per line); exits non-zero if none resolved so a\n" +
      "capture fails loudly.\n"
  );
}

export async function run(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`relay resolve: ${err instanceof Error ? err.message : String(err)}\n\n`);
    usage();
    return 1;
  }
  if (args.help) {
    usage(true);
    return 0;
  }

  const agent = args.agent || process.env.RELAY_AGENT_NAME || null;
  if (!agent) {
    process.stderr.write("relay resolve: no agent — pass --agent NAME or set RELAY_AGENT_NAME\n");
    return 1;
  }
  if (args.messageIds.length === 0) {
    process.stderr.write("relay resolve: missing <message-id> (at least one)\n");
    return 1;
  }

  // --- Resolve + LOCALLY VALIDATE the agent's token (never send a bad cred) ---
  // Precedence: $RELAY_AGENT_TOKEN (operator-explicit — trusted as-provided, may
  // target a remote hub) → the per-instance vault, which MUST authenticate against
  // the local DB BEFORE we POST. No mint path — resolve requires an already-
  // registered identity. A stale/missing/mismatched vault token is a LOCAL refusal
  // (exit 2, NO POST) — same discipline as `relay send`.
  let token: string | null = null;
  const envToken = process.env.RELAY_AGENT_TOKEN;
  if (isValidTokenShape(envToken)) {
    token = envToken;
  } else {
    try {
      const { resolveInstanceDbPath } = await import("../instance.js");
      if (!process.env.RELAY_DB_PATH) process.env.RELAY_DB_PATH = resolveInstanceDbPath();
    } catch {
      /* fall back to db default */
    }
    let dbOpen = false;
    try {
      const { initializeDb, getAgentAuthData } = await import("../db.js");
      await initializeDb();
      dbOpen = true;
      const { defaultTokenStore } = await import("../token-store.js");
      const vaultToken = await defaultTokenStore().read(agent);
      const authData = getAgentAuthData(agent);
      if (authData && authData.token_hash) {
        const bcrypt = (await import("bcryptjs")).default;
        if (vaultToken && bcrypt.compareSync(vaultToken, authData.token_hash)) {
          token = vaultToken;
        } else {
          process.stderr.write(
            `relay resolve: the vault token for "${agent}" does not authenticate against the DB ` +
              "(missing / stale / mismatched). NOT sending a mismatched credential.\n" +
              `  • Rotate deliberately (invalidates the old token): relay mint-token ${agent} --force\n` +
              `  • Or reset the identity: relay recover ${agent}\n`
          );
          return 2;
        }
      } else {
        process.stderr.write(
          `relay resolve: no usable token for "${agent}" — not registered locally and ` +
            "env RELAY_AGENT_TOKEN is unset/invalid. Export RELAY_AGENT_TOKEN or register first.\n"
        );
        return 2;
      }
    } catch (err) {
      process.stderr.write(
        `relay resolve: could not resolve a token: ${err instanceof Error ? err.message : String(err)}\n`
      );
      return 2;
    } finally {
      if (dbOpen) {
        try {
          const { closeDb } = await import("../db.js");
          closeDb();
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (!token) {
    // Defensive: every branch above set token or returned; never POST tokenless.
    process.stderr.write(`relay resolve: could not resolve a token for "${agent}".\n`);
    return 2;
  }

  // --- Resolve host/port + optional dashboard/http secret ---
  let host = "127.0.0.1";
  let port = 3777;
  let secret: string | null = process.env.RELAY_DASHBOARD_SECRET || process.env.RELAY_HTTP_SECRET || null;
  try {
    const { loadConfig } = await import("../config.js");
    const cfg = loadConfig();
    host = cfg.http_host || host;
    port = cfg.http_port || port;
    if (!secret) secret = cfg.http_secret || null;
  } catch {
    host = process.env.RELAY_HTTP_HOST || host;
    port = process.env.RELAY_HTTP_PORT ? parseInt(process.env.RELAY_HTTP_PORT, 10) : port;
  }

  const url = `http://${host}:${port}/mcp`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "X-Agent-Token": token, // agent auth (same as an MCP client)
  };
  if (secret) headers["Authorization"] = `Bearer ${secret}`; // transport secret, when configured
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "resolve_messages", arguments: { agent_name: agent, message_ids: args.messageIds } },
  });

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body });
  } catch (err) {
    process.stderr.write(
      `relay resolve: could not reach the daemon at ${url} — is it running? (${err instanceof Error ? err.message : String(err)})\n`
    );
    return 2;
  }

  // Parse the MCP response — SSE-wrapped (`data: {...}`) or plain JSON. The tool
  // result envelope is nested at result.content[0].text.
  const text = await res.text();
  let envelope: { success?: boolean; error?: string; resolved_ids?: unknown; resolved_count?: unknown; note?: string } | null =
    null;
  try {
    const dataLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
    const rpc = JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
    if (rpc?.error) {
      process.stderr.write(
        `relay resolve: daemon error — ${rpc.error.message ?? JSON.stringify(rpc.error)}\n`
      );
      return 1;
    }
    envelope = JSON.parse(rpc.result.content[0].text);
  } catch {
    process.stderr.write(
      `relay resolve: daemon returned an unparseable response (${res.status}) — ${text.slice(0, 300)}\n`
    );
    return 1;
  }

  if (!res.ok || envelope?.success === false) {
    process.stderr.write(`relay resolve: ${envelope?.error ?? `daemon returned ${res.status}`}\n`);
    return 1;
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(envelope) + "\n");
    return 0;
  }

  // STDOUT carries ONLY the resolved ids, so the SUCCESS/output decision is
  // derived SOLELY from resolved_ids — NEVER from resolved_count independently.
  // FAIL CLOSED: a success envelope MUST carry a NON-EMPTY, ALL-STRING
  // resolved_ids array. An empty/absent list — or one with ANY non-string element
  // — is malformed and must NOT reach stdout. This is ENFORCED, not filtered:
  // filtering a mixed `[123, "m-1"]` would silently accept a PARTIAL list and
  // emit an unverifiable capture at exit 0 (the exact silent-empty/partial-capture
  // class this CLI exists to prevent; same family as #130's send.ts blocker).
  const rawIds: unknown = envelope?.resolved_ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0 || !rawIds.every((x) => typeof x === "string")) {
    // Loud + NON-ZERO so a `$(relay resolve …)` capture fails visibly instead of
    // binding "" / "\n" / a partial list at exit 0. No ✓.
    process.stderr.write(
      `relay resolve: no messages resolved for "${agent}" — the ${args.messageIds.length} id(s) were ` +
        "unknown, not addressed to you, already resolved, or the daemon returned a malformed resolved_ids " +
        "list (empty or non-string). Nothing changed.\n"
    );
    return 1;
  }
  const resolvedIds = rawIds as string[];

  const claimedCount = envelope?.resolved_count;
  if (typeof claimedCount === "number" && claimedCount !== resolvedIds.length) {
    // Inconsistent envelope (e.g. resolved_count=2 but 1 usable id): refuse to
    // emit a partial capture rather than trust a count that disagrees with the ids.
    process.stderr.write(
      `relay resolve: daemon returned an inconsistent response (resolved_count=${claimedCount} but ` +
        `${resolvedIds.length} usable id(s)) — refusing to emit a partial/empty capture.\n`
    );
    return 1;
  }

  // STDOUT: ONLY the resolved ids, one per line — a clean, parseable capture.
  process.stderr.write(
    `✓ resolved ${resolvedIds.length} of ${args.messageIds.length} message(s) for "${agent}"; they will not re-surface as pending.\n`
  );
  process.stdout.write(resolvedIds.join("\n") + "\n");
  return 0;
}
