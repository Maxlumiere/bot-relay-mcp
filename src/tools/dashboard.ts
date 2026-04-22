// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.1 P1 — dashboard-theme MCP tool handler.
 *
 * `set_dashboard_theme({mode, custom_json?})` writes to the `dashboard_prefs`
 * single-row table. Newly-connecting clients read the server-side default
 * on first visit when they have no localStorage selection yet. Local
 * operator preference (the top-right dropdown in the dashboard UI) beats
 * the server default — "path 1 client-only" per the v2.2.1 brief.
 *
 * Scope: THIS tool only writes the server-side default. It does NOT push
 * the new theme live over WebSocket to already-connected clients (that
 * would be path 2, deferred to v2.2.2 if demand surfaces). A theme change
 * shows up on the next /api/dashboard-prefs read or on full reload.
 */
import type { SetDashboardThemeInput } from "../types.js";
import { setDashboardPrefs, logAudit } from "../db.js";
import { currentContext } from "../request-context.js";

export function handleSetDashboardTheme(input: SetDashboardThemeInput) {
  const customJson =
    input.mode === "custom" && input.custom_json
      ? JSON.stringify(input.custom_json)
      : null;
  const prefs = setDashboardPrefs(input.mode, customJson);
  const ctx = currentContext();
  try {
    logAudit(
      null,
      "set_dashboard_theme",
      `mode=${input.mode}${input.mode === "custom" ? " (custom_json set)" : ""}`,
      true,
      null,
      ctx.transport,
      { mode: input.mode, has_custom: input.mode === "custom" }
    );
  } catch {
    // Audit is best-effort; never block the tool response on it.
  }
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            theme: prefs.theme,
            updated_at: prefs.updated_at,
            note:
              "Server-side default updated. Clients read this on first visit " +
              "only — each client's localStorage preference beats the default " +
              "locally (v2.2.1 'path 1 client-only' design). Full reload to " +
              "surface on connected dashboards.",
          },
          null,
          2
        ),
      },
    ],
  };
}
