// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import crypto from "crypto";
import { getAgents, getHumanPendingObligations } from "./db.js";
import { validateWebhookUrl } from "./url-safety.js";
import { deliverPinnedPost } from "./webhook-delivery.js";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { VERSION } from "./version.js";

/**
 * v1 Kanban board snapshot — a READ-ONLY projection of relay state for the
 * external (Vercel) dashboard. Every v1 section comes from an UNCAPPED
 * primitive, so the board needs no `tasks` capability and no profile change:
 *  - `agents`: per-agent column headers (name, role, coarse status, terminal,
 *    cli) — all automatic on the `agents` row.
 *  - `pending_on_human`: the "pending on me" lane — obligations/asks owed by a
 *    human (a recipient with no agent row). `send_message(disposition)` fills
 *    it; it clears on `resolve_messages`.
 *  - task_detail: NOT in v1. Per-task "doing" bullets need the `tasks`
 *    capability; `task_detail_available:false` tells the page to SAY SO rather
 *    than render an empty column that reads as "nothing happening".
 */
export interface KanbanSnapshot {
  schema: "kanban.v1";
  generated_at: string;
  agents: Array<{
    name: string;
    role: string;
    status: string;
    agent_status: string;
    cli_profile: string | null;
    terminal_title_ref: string | null;
    class: string;
  }>;
  pending_on_human: ReturnType<typeof getHumanPendingObligations>;
  task_detail_available: false;
  note: string;
}

export function buildKanbanSnapshot(nowIso: string): KanbanSnapshot {
  const agents = getAgents().map((a) => ({
    name: a.name,
    role: a.role,
    status: a.status,
    agent_status: a.agent_status,
    cli_profile: a.cli_profile ?? null,
    terminal_title_ref: a.terminal_title_ref ?? null,
    class: a.class,
  }));
  return {
    schema: "kanban.v1",
    generated_at: nowIso,
    agents,
    pending_on_human: getHumanPendingObligations(nowIso),
    task_detail_available: false,
    note:
      "v1: the columns above (agents + pending-on-human) are LIVE. Per-task 'doing' " +
      "detail is not yet shown — it arrives once the fleet adopts the `tasks` capability. " +
      "An empty 'doing' column here means 'not yet wired', not 'nothing happening'.",
  };
}

function sign(body: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Push ONE snapshot OUTBOUND to the configured Vercel URL. No-op (and off by
 * default) when `dashboard_push_url` is unset. OUTBOUND ONLY — the relay never
 * opens an inbound port for this; the laptop initiates the connection, so there
 * is no inbound hole. SSRF-safe: the URL is re-validated + DNS-pinned at push
 * time (the same TOCTOU-closed path the webhook deliverer uses). Best-effort:
 * never throws into the caller's tick — a missed push just means the page keeps
 * showing its last-good snapshot (with the stale timestamp visible) until the
 * next tick lands. Returns a small result for logging/testing, never rejects.
 */
export async function pushKanbanSnapshotOnce(opts?: {
  nowIso?: string;
}): Promise<{ pushed: boolean; reason?: string }> {
  const cfg = loadConfig() as unknown as {
    dashboard_push_url?: string | null;
    dashboard_push_secret?: string | null;
  };
  const url = cfg.dashboard_push_url ?? null;
  if (!url) return { pushed: false, reason: "dashboard_push_url not configured" };

  const nowIso = opts?.nowIso ?? new Date().toISOString();
  let body: string;
  try {
    body = JSON.stringify(buildKanbanSnapshot(nowIso));
  } catch (err) {
    log.warn(`[dashboard-push] snapshot build failed: ${(err as Error).message}`);
    return { pushed: false, reason: "snapshot build failed" };
  }

  // Re-validate + pin at push time (DNS can flip between config-set and push).
  const safety = await validateWebhookUrl(url);
  if (!safety.ok) {
    log.warn(`[dashboard-push] refusing push — URL failed SSRF validation (${safety.reason})`);
    return { pushed: false, reason: `ssrf refusal: ${safety.reason}` };
  }
  const validatedIps = safety.resolvedIps ?? [];
  if (validatedIps.length === 0) return { pushed: false, reason: "no validated IP to pin" };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": `bot-relay-mcp/${VERSION}`,
    "X-Relay-Dashboard": "kanban.v1",
    Date: new Date().toUTCString(),
  };
  const secret = cfg.dashboard_push_secret ?? null;
  if (secret) headers["X-Relay-Signature"] = sign(body, secret);

  try {
    const res = await deliverPinnedPost({
      url,
      pinnedIp: validatedIps[0],
      pinnedIps: validatedIps,
      headers,
      body,
      timeoutMs: 5000,
    });
    if (res.error) {
      log.warn(`[dashboard-push] delivery error: ${res.error}`);
      return { pushed: false, reason: res.error };
    }
    return { pushed: true };
  } catch (err) {
    log.warn(`[dashboard-push] push threw: ${(err as Error).message}`);
    return { pushed: false, reason: "push threw" };
  }
}
