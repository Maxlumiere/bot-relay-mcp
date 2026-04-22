// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import type { Request, Response } from "express";
import { getAgents, listWebhooks, getDb, getDashboardPrefs } from "./db.js";
import { getKeyringInfo, decryptContent } from "./encryption.js";
import type { MessageRecord, TaskRecord } from "./types.js";
import { DASHBOARD_BASE_STYLES, DASHBOARD_THEMES } from "./dashboard-styles.js";

/**
 * v2.2.0 Phase 3: decrypt + truncate a content field for dashboard display.
 * 100-char cap matches get_messages_summary (v2.1.6). Narrow expansion of
 * the v2.1 Phase 4d encryption-policy comment: the dashboard is behind
 * dashboardAuthCheck + originCheck + httpHostCheck, so this preview is
 * only reachable by someone who could already call get_messages. Full
 * ciphertext stays untouched in the `content` / `description` / `result`
 * fields for clients that want the raw on-disk form.
 */
const PREVIEW_CAP = 100;
function previewField(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const decrypted = decryptContent(raw) ?? raw;
  if (decrypted.length <= PREVIEW_CAP) return decrypted;
  return decrypted.slice(0, PREVIEW_CAP);
}

/**
 * v2.2.0 reactive dashboard — WebSocket push + /api/snapshot refetch.
 * Vanilla JS, no build step, no dependencies. Mounted at GET / + /dashboard.
 *
 * Info-disclosure policy for `snapshotApi` (v2.2.0, supersedes the v2.1
 * Phase 4d note that used to live here):
 *   - agents: `AgentWithStatus` (`toAgentWithStatus` in db.ts) strips
 *     `token_hash` and exposes `has_token: boolean`. NEVER surfaces the
 *     bcrypt hash or any raw token.
 *   - webhooks: raw `WebhookRecord.secret` is replaced with
 *     `has_secret: boolean` by the dashboard mapper below. NEVER surfaces
 *     the raw HMAC secret.
 *   - messages / tasks: raw `content` / `description` / `result` columns
 *     remain at-rest-encrypted ciphertext (`enc1:…` / `enc:<kid>:…`)
 *     in the response, unchanged from v2.1. v2.2.0 ADDS sibling
 *     `content_preview` / `description_preview` / `result_preview`
 *     fields — 100-char decrypted previews for the reactive dashboard.
 *     Narrow Phase 4d policy expansion: the dashboard is gated by
 *     `dashboardAuthCheck` + `originCheck` + `httpHostCheck` + CSRF on
 *     state-changing endpoints, so any caller reaching the preview could
 *     already call `get_messages` for the same decrypted content. See
 *     CHANGELOG v2.2.0 "Policy change for operators" callout for the
 *     operator-facing guidance.
 *   - webhook_delivery_log with its `error_text` is NOT returned by
 *     snapshotApi. If a future change adds it, redact internal-looking
 *     paths + IPs before surfacing.
 */
export function renderDashboard(_req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(DASHBOARD_HTML);
}

/**
 * v2.1 Phase 4b.3: keyring info API.
 *
 * Returns { current, known_key_ids, legacy_key_id, legacy_row_counts }.
 * NEVER returns the raw key material. Counts are across all 5 encrypted
 * columns and only include rows that still carry a legacy (enc1:) prefix
 * — the signal operators need to see rotation progress without exposing
 * the actual keys.
 */
export function keyringApi(_req: Request, res: Response): void {
  try {
    const info = getKeyringInfo();
    const db = getDb();
    const legacyCounts = {
      messages_content: (db
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE content LIKE 'enc1:%'")
        .get() as { c: number }).c,
      tasks_description: (db
        .prepare("SELECT COUNT(*) AS c FROM tasks WHERE description LIKE 'enc1:%'")
        .get() as { c: number }).c,
      tasks_result: (db
        .prepare("SELECT COUNT(*) AS c FROM tasks WHERE result LIKE 'enc1:%'")
        .get() as { c: number }).c,
      audit_log_params_json: (db
        .prepare("SELECT COUNT(*) AS c FROM audit_log WHERE params_json LIKE 'enc1:%'")
        .get() as { c: number }).c,
      webhook_subscriptions_secret: (db
        .prepare("SELECT COUNT(*) AS c FROM webhook_subscriptions WHERE secret LIKE 'enc1:%'")
        .get() as { c: number }).c,
    };
    res.json({
      current: info.current,
      known_key_ids: info.known_key_ids,
      legacy_key_id: info.legacy_key_id,
      legacy_row_counts: legacyCounts,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * JSON API for the dashboard — returns a snapshot of relay state.
 * GET /api/snapshot
 */
export function snapshotApi(_req: Request, res: Response): void {
  try {
    const db = getDb();
    const agents = getAgents();
    const webhooks = listWebhooks().map((w) => ({
      id: w.id,
      url: w.url,
      event: w.event,
      filter: w.filter,
      has_secret: !!w.secret,
      created_at: w.created_at,
    }));

    const messages = db
      .prepare("SELECT * FROM messages ORDER BY created_at DESC LIMIT 20")
      .all() as MessageRecord[];

    const activeTasks = db
      .prepare("SELECT * FROM tasks WHERE status IN ('posted', 'accepted') ORDER BY created_at DESC LIMIT 20")
      .all() as TaskRecord[];

    const recentCompletions = db
      .prepare("SELECT * FROM tasks WHERE status IN ('completed', 'rejected') ORDER BY updated_at DESC LIMIT 10")
      .all() as TaskRecord[];

    // v2.2.0 Phase 3: attach 100-char decrypted previews alongside the
    // raw (encrypted) content/description/result fields. Frontend renders
    // the preview; raw stays available for clients that want it.
    const messagesWithPreview = messages.map((m) => ({
      ...m,
      content_preview: previewField(m.content),
    }));
    const tasksWithPreview = activeTasks.map((t) => ({
      ...t,
      description_preview: previewField(t.description),
    }));
    const completionsWithPreview = recentCompletions.map((t) => ({
      ...t,
      description_preview: previewField(t.description),
      result_preview: previewField(t.result),
    }));

    // v2.2.1 P1: surface the server-side default theme alongside the rest
    // of the snapshot. The dashboard client reads it on first connect when
    // localStorage has no theme selection yet; localStorage beats default
    // for repeat visits.
    let dashboardPrefs;
    try {
      dashboardPrefs = getDashboardPrefs();
    } catch {
      dashboardPrefs = { theme: "catppuccin", custom_json: null, updated_at: null };
    }

    res.json({
      timestamp: new Date().toISOString(),
      agents,
      webhooks,
      messages: messagesWithPreview,
      active_tasks: tasksWithPreview,
      recent_completions: completionsWithPreview,
      dashboard_prefs: dashboardPrefs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>bot-relay dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<!--
  v2.2.0 Phase 3 — reactive dashboard.

  Data flow:
    1. On load: fetch /api/snapshot once to populate initial state.
    2. Open WebSocket to /dashboard/ws (same-origin); on every push event
       we re-fetch /api/snapshot (server is the source of truth; the push
       is a "something changed, refresh" signal — simpler than reconciling
       diffs client-side, same effective latency).
    3. On WebSocket close: exponential backoff reconnect (1s → 30s max)
       + poll /api/snapshot every 10s as safety net.

  Layout:
    - CSS grid with --cards-per-row custom property (default 3, toggle 2/3/4)
    - localStorage persists the toggle + filter state across reloads
    - Focused-agent panel shows bottom when an agent card is clicked

  Accessibility:
    - Message rows are <button>s in a <ul> for keyboard nav
    - aria-expanded on each message row toggles with the body
    - Filter bar is a proper form with label-associated inputs
-->
<!-- v2.2.1 P3: CSS extracted to src/dashboard-styles.ts so themes (P1) + inline-action UI slot in without pushing this file past 1000 LOC. Both strings are interpolated into the <style> block below at response-build time. -->
<style>
${DASHBOARD_BASE_STYLES}${DASHBOARD_THEMES}
</style>
</head>
<body>
<header>
  <h1>bot-relay dashboard</h1>
  <div class="controls">
    <span id="conn-pill" class="conn-pill" title="WebSocket connection to /dashboard/ws"><span class="conn-dot"></span><span id="conn-label">connecting…</span></span>
    <label>
      <span>theme</span>
      <select id="theme-toggle" aria-label="Dashboard theme">
        <option value="catppuccin" selected>catppuccin</option>
        <option value="dark">dark</option>
        <option value="light">light</option>
        <option value="custom">custom</option>
      </select>
    </label>
    <label>
      <span>cards/row</span>
      <select id="cards-per-row-toggle" aria-label="Cards per row">
        <option value="2">2</option>
        <option value="3" selected>3</option>
        <option value="4">4</option>
      </select>
    </label>
    <label>
      <span>role</span>
      <input id="filter-role" type="text" placeholder="all" size="8" aria-label="Filter by role">
    </label>
    <label>
      <span>status</span>
      <select id="filter-status" aria-label="Filter by agent status">
        <option value="all">all</option>
        <option value="idle">idle</option>
        <option value="working">working</option>
        <option value="blocked">blocked</option>
        <option value="waiting_user">waiting_user</option>
        <option value="stale">stale</option>
        <option value="offline">offline</option>
        <option value="closed">closed</option>
        <option value="abandoned">abandoned</option>
      </select>
    </label>
    <label>
      <span>since</span>
      <select id="filter-since" aria-label="Time window for messages">
        <option value="all">all</option>
        <option value="1h">1h</option>
        <option value="24h" selected>24h</option>
        <option value="7d">7d</option>
      </select>
    </label>
    <label title="When checked, agent_status=abandoned rows (offline > RELAY_AGENT_ABANDON_DAYS, default 7) appear in the grid.">
      <input id="filter-show-abandoned" type="checkbox" aria-label="Show abandoned agents">
      <span>show abandoned</span>
    </label>
    <label>
      <span>sort</span>
      <select id="filter-sort" aria-label="Sort agents">
        <option value="status" selected>status</option>
        <option value="role">role</option>
        <option value="last-seen">last seen</option>
        <option value="name">name</option>
      </select>
    </label>
    <label title="Per-human operator identity for audit-log attribution. Stored in the relay_operator_identity cookie (SameSite=Lax, 90-day). Beats RELAY_DASHBOARD_OPERATOR env.">
      <span>operator</span>
      <button id="operator-identity-btn" type="button" style="background:var(--panel);color:var(--fg);border:1px solid var(--border);padding:4px 8px;border-radius:4px;cursor:pointer;font-size:12px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" aria-label="Set operator identity"><span id="operator-identity-value">…</span></button>
    </label>
    <span class="meta"><span id="updated" style="color:var(--muted);font-size:12px">no data yet</span></span>
  </div>
</header>
<main>
  <section class="panel">
    <h2>Agents (<span id="agents-count">0</span>)</h2>
    <div class="panel-body" id="agents" style="max-height:none;padding:0"><div class="agents-grid" id="agents-grid"></div></div>
  </section>
  <section class="panel">
    <h2>Active tasks (<span id="tasks-count">0</span>)</h2>
    <div class="panel-body" id="tasks"></div>
  </section>
  <section class="panel" style="grid-column:1/-1">
    <h2>Recent messages · click row to expand (<span id="messages-count">0</span>)</h2>
    <div style="padding:0 16px 8px 16px">
      <input id="filter-messages-search" type="search" placeholder="Search messages (content, from, to)…" aria-label="Search messages" style="width:100%;padding:6px 10px;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:12px">
    </div>
    <div class="panel-body" style="max-height:none"><ul class="msg-list" id="messages" role="list"></ul></div>
  </section>
  <section class="panel" style="grid-column:1/-1">
    <h2>Webhooks &amp; completed</h2>
    <div class="panel-body" id="meta"></div>
  </section>
</main>
<!--
  v2.2.2 B1 — rich custom-theme dialog. Operator triggers via the
  theme dropdown 'custom' option. Native <dialog> for Escape + click-
  outside dismissal. Color pickers for each of the 14 tokens + a
  paste-JSON fallback + live-preview-on-change.
-->
<dialog id="custom-theme-dialog" aria-labelledby="custom-theme-title" style="border:1px solid var(--border);border-radius:8px;padding:0;background:var(--panel);color:var(--text);max-width:640px;width:90vw">
  <form id="custom-theme-form" method="dialog" style="display:flex;flex-direction:column;gap:0">
    <header style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
      <h3 id="custom-theme-title" style="margin:0;font-size:16px">Custom theme</h3>
      <button type="button" id="custom-theme-close" aria-label="Close" style="background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:18px;line-height:1">✕</button>
    </header>
    <div style="padding:16px 16px 8px 16px;display:grid;grid-template-columns:repeat(2,1fr);gap:8px 16px">
      <label style="display:flex;align-items:center;gap:8px;font-size:12px"><span style="min-width:72px;color:var(--muted)">bg</span><input data-token="bg" type="color" style="flex:1;height:28px;padding:0;border:1px solid var(--border);border-radius:4px;background:transparent"></label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px"><span style="min-width:72px;color:var(--muted)">panel</span><input data-token="panel" type="color" style="flex:1;height:28px;padding:0;border:1px solid var(--border);border-radius:4px;background:transparent"></label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px"><span style="min-width:72px;color:var(--muted)">panel-2</span><input data-token="panel-2" type="color" style="flex:1;height:28px;padding:0;border:1px solid var(--border);border-radius:4px;background:transparent"></label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px"><span style="min-width:72px;color:var(--muted)">border</span><input data-token="border" type="color" style="flex:1;height:28px;padding:0;border:1px solid var(--border);border-radius:4px;background:transparent"></label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px"><span style="min-width:72px;color:var(--muted)">text</span><input data-token="text" type="color" style="flex:1;height:28px;padding:0;border:1px solid var(--border);border-radius:4px;background:transparent"></label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px"><span style="min-width:72px;color:var(--muted)">muted</span><input data-token="muted" type="color" style="flex:1;height:28px;padding:0;border:1px solid var(--border);border-radius:4px;background:transparent"></label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px"><span style="min-width:72px;color:var(--muted)">accent</span><input data-token="accent" type="color" style="flex:1;height:28px;padding:0;border:1px solid var(--border);border-radius:4px;background:transparent"></label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px"><span style="min-width:72px;color:var(--muted)">online</span><input data-token="online" type="color" style="flex:1;height:28px;padding:0;border:1px solid var(--border);border-radius:4px;background:transparent"></label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px"><span style="min-width:72px;color:var(--muted)">stale</span><input data-token="stale" type="color" style="flex:1;height:28px;padding:0;border:1px solid var(--border);border-radius:4px;background:transparent"></label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px"><span style="min-width:72px;color:var(--muted)">offline</span><input data-token="offline" type="color" style="flex:1;height:28px;padding:0;border:1px solid var(--border);border-radius:4px;background:transparent"></label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px"><span style="min-width:72px;color:var(--muted)">critical</span><input data-token="critical" type="color" style="flex:1;height:28px;padding:0;border:1px solid var(--border);border-radius:4px;background:transparent"></label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px"><span style="min-width:72px;color:var(--muted)">high</span><input data-token="high" type="color" style="flex:1;height:28px;padding:0;border:1px solid var(--border);border-radius:4px;background:transparent"></label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px"><span style="min-width:72px;color:var(--muted)">normal</span><input data-token="normal" type="color" style="flex:1;height:28px;padding:0;border:1px solid var(--border);border-radius:4px;background:transparent"></label>
      <label style="display:flex;align-items:center;gap:8px;font-size:12px"><span style="min-width:72px;color:var(--muted)">low</span><input data-token="low" type="color" style="flex:1;height:28px;padding:0;border:1px solid var(--border);border-radius:4px;background:transparent"></label>
    </div>
    <div id="custom-theme-preview" style="margin:0 16px 12px 16px;padding:12px;border:1px solid var(--border);border-radius:6px;font-size:12px">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><strong style="color:var(--accent)">Live preview</strong><span style="color:var(--muted)">changes apply as you pick</span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <span style="background:var(--online);color:#000;padding:2px 6px;border-radius:3px">online</span>
        <span style="background:var(--stale);color:#000;padding:2px 6px;border-radius:3px">stale</span>
        <span style="background:var(--offline);color:#fff;padding:2px 6px;border-radius:3px">offline</span>
        <span style="background:var(--critical);color:#fff;padding:2px 6px;border-radius:3px">critical</span>
        <span style="background:var(--high);color:#fff;padding:2px 6px;border-radius:3px">high</span>
        <span style="background:var(--normal);color:#fff;padding:2px 6px;border-radius:3px">normal</span>
        <span style="background:var(--low);color:#fff;padding:2px 6px;border-radius:3px">low</span>
      </div>
    </div>
    <details style="margin:0 16px 12px 16px;font-size:12px">
      <summary style="cursor:pointer;color:var(--muted)">Paste JSON (advanced)</summary>
      <textarea id="custom-theme-json" rows="5" spellcheck="false" style="width:100%;margin-top:6px;font-family:ui-monospace,monospace;font-size:11px;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:6px"></textarea>
      <button type="button" id="custom-theme-json-apply" style="margin-top:6px;background:var(--panel-2);color:var(--text);border:1px solid var(--border);padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px">Apply JSON to pickers</button>
      <div id="custom-theme-json-err" style="color:var(--critical);font-size:11px;margin-top:4px;display:none"></div>
    </details>
    <footer style="padding:12px 16px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
      <button type="button" id="custom-theme-cancel" style="background:var(--panel-2);color:var(--text);border:1px solid var(--border);padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px">Cancel</button>
      <button type="button" id="custom-theme-save" style="background:var(--accent);color:#fff;border:1px solid var(--accent);padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px">Save</button>
    </footer>
  </form>
</dialog>
<section id="focused-agent" class="focused-agent" aria-live="polite">
  <h3 id="focused-title">Focused agent</h3>
  <div id="focused-body"></div>
  <div class="focused-actions">
    <button id="btn-focus-terminal" type="button" title="Raise the agent's OS terminal window">📱 Raise terminal</button>
    <button id="btn-wake-agent" type="button" title="Touch the filesystem marker for this agent (ambient wake)">🔔 Wake agent</button>
    <button id="btn-close-focused" type="button">Close</button>
  </div>
</section>
<script>
/**
 * v2.2.0 Phase 3 — dashboard reactive app (vanilla JS, no framework).
 *
 * Kept below ~200 lines total; ships inline to preserve the single-HTML-
 * response model. No bundler, no build step, no external deps.
 */
(function () {
  const STORAGE_KEY = 'bot-relay-dashboard-prefs-v1';
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch (_e) { return {}; }
  }
  function savePrefs(p) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch (_e) {}
  }
  // v2.2.1 P1: theme field added. Default 'catppuccin' unless the server-
  // side /api/snapshot.dashboard_prefs override lands first (fetchSnapshot
  // applies it when our prefs.theme is still the initial default). Once
  // the operator flips the dropdown, localStorage beats the server default.
  const prefs = Object.assign(
    { cardsPerRow: 3, role: '', status: 'all', since: '24h', theme: 'catppuccin', customJson: null, themeSetByOperator: false, showAbandoned: false, sort: 'status', messagesQuery: '' },
    loadPrefs()
  );

  // Apply persisted prefs immediately so the first render uses them.
  document.documentElement.style.setProperty('--cards-per-row', String(prefs.cardsPerRow));
  document.getElementById('cards-per-row-toggle').value = String(prefs.cardsPerRow);
  document.getElementById('filter-role').value = prefs.role;
  document.getElementById('filter-status').value = prefs.status;
  document.getElementById('filter-since').value = prefs.since;
  document.getElementById('theme-toggle').value = prefs.theme;

  // v2.2.1 P1: apply the selected theme to <html> via data-theme (for
  // named themes) or inline --* custom properties (for pasted custom).
  function applyTheme(theme, customJson) {
    const root = document.documentElement;
    if (theme === 'custom' && customJson) {
      root.setAttribute('data-theme', 'custom');
      // Clear any prior inline tokens, then set the custom ones.
      const TOKENS = ['bg','panel','panel-2','border','text','muted','accent','online','stale','offline','critical','high','normal','low'];
      for (const t of TOKENS) root.style.removeProperty('--' + t);
      try {
        const obj = typeof customJson === 'string' ? JSON.parse(customJson) : customJson;
        for (const t of TOKENS) {
          if (obj && typeof obj[t] === 'string') root.style.setProperty('--' + t, obj[t]);
        }
      } catch (_e) { /* silently fall back to catppuccin */ }
    } else {
      root.setAttribute('data-theme', theme);
      const TOKENS = ['bg','panel','panel-2','border','text','muted','accent','online','stale','offline','critical','high','normal','low'];
      for (const t of TOKENS) root.style.removeProperty('--' + t);
    }
  }
  applyTheme(prefs.theme, prefs.customJson);

  // ---------- helpers ----------
  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return Math.floor(diff) + 's ago';
    if (diff < 3600) return Math.floor(diff/60) + 'm ago';
    if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
    return Math.floor(diff/86400) + 'd ago';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function sinceBoundMs() {
    if (prefs.since === 'all') return 0;
    const m = /^(\\d+)([hd])$/.exec(prefs.since);
    if (!m) return 0;
    const n = parseInt(m[1], 10);
    const unit = m[2] === 'd' ? 86_400_000 : 3_600_000;
    return Date.now() - n * unit;
  }

  // ---------- state ----------
  let snapshot = null;
  let focusedAgent = null;

  // ---------- rendering ----------
  // v2.2.2 B4 — status ordering used by the 'status' sort option. Active
  // states first (operator attention), then observation-states, then
  // terminal rows. Keeps the grid visually stable as agents transition.
  const STATUS_ORDER = {
    working: 0, blocked: 1, waiting_user: 2, idle: 3,
    stale: 4, offline: 5, closed: 6, abandoned: 7,
  };
  function applyFilters(agents) {
    const filtered = agents.filter((a) => {
      if (prefs.role && a.role !== prefs.role) return false;
      if (prefs.status !== 'all' && a.agent_status !== prefs.status) return false;
      // v2.2.2 B3: abandoned agents are hidden unless the operator
      // opts in OR the explicit status filter targets 'abandoned'.
      if (a.agent_status === 'abandoned' && !prefs.showAbandoned && prefs.status !== 'abandoned') return false;
      return true;
    });
    const sort = prefs.sort || 'status';
    filtered.sort((a, b) => {
      if (sort === 'name') return String(a.name).localeCompare(String(b.name));
      if (sort === 'role') {
        const r = String(a.role || '').localeCompare(String(b.role || ''));
        return r !== 0 ? r : String(a.name).localeCompare(String(b.name));
      }
      if (sort === 'last-seen') {
        // Most recently active first.
        return new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime();
      }
      // default: status
      const sa = STATUS_ORDER[a.agent_status] != null ? STATUS_ORDER[a.agent_status] : 99;
      const sb = STATUS_ORDER[b.agent_status] != null ? STATUS_ORDER[b.agent_status] : 99;
      if (sa !== sb) return sa - sb;
      return String(a.name).localeCompare(String(b.name));
    });
    return filtered;
  }

  // v2.2.2 B2 — per-agent card resize state.
  //
  // Stored as localStorage key bot-relay-card-sizes-v1, object map
  // { agentName: { col: 1-4, row: 1-3, t: epochMs } }. LRU-capped at 50
  // entries; when we cross that, the oldest t is evicted so stale
  // retired-agent sizes don't accumulate forever.
  const CARD_SIZES_KEY = 'bot-relay-card-sizes-v1';
  const CARD_SIZES_CAP = 50;
  function loadCardSizes() {
    try { return JSON.parse(localStorage.getItem(CARD_SIZES_KEY) || '{}'); }
    catch (_e) { return {}; }
  }
  function saveCardSizes(map) {
    try {
      const entries = Object.entries(map);
      if (entries.length > CARD_SIZES_CAP) {
        entries.sort((a, b) => (a[1] && a[1].t ? a[1].t : 0) - (b[1] && b[1].t ? b[1].t : 0));
        const trimmed = {};
        for (let i = entries.length - CARD_SIZES_CAP; i < entries.length; i++) {
          trimmed[entries[i][0]] = entries[i][1];
        }
        localStorage.setItem(CARD_SIZES_KEY, JSON.stringify(trimmed));
        return trimmed;
      }
      localStorage.setItem(CARD_SIZES_KEY, JSON.stringify(map));
    } catch (_e) { /* quota or disabled — skip */ }
    return map;
  }
  let cardSizes = loadCardSizes();

  function renderAgents() {
    if (!snapshot) return;
    const filtered = applyFilters(snapshot.agents);
    document.getElementById('agents-count').textContent = filtered.length;
    const el = document.getElementById('agents-grid');
    if (!filtered.length) { el.innerHTML = '<div class="empty">No agents match filters</div>'; return; }
    el.innerHTML = filtered.map((a) => {
      const s = a.agent_status || 'idle';
      const isFocused = focusedAgent === a.name ? ' focused' : '';
      const sz = cardSizes[a.name];
      const col = sz && sz.col ? Math.max(1, Math.min(4, sz.col | 0)) : 1;
      const row = sz && sz.row ? Math.max(1, Math.min(3, sz.row | 0)) : 1;
      const style = (col > 1 || row > 1)
        ? ' style="grid-column:span ' + col + ';grid-row:span ' + row + '"'
        : '';
      const resized = (col > 1 || row > 1) ? ' data-resized="1"' : '';
      return '<div class="agent-card' + isFocused + '" role="button" tabindex="0" data-agent="' + esc(a.name) + '"' + style + resized + '>' +
        '<button class="card-reset" type="button" aria-label="Reset card size" data-action="reset-size" data-agent-name="' + esc(a.name) + '" title="Reset size">×</button>' +
        '<div class="name">' + esc(a.name) + '</div>' +
        '<div class="role">' + esc(a.role) + '</div>' +
        '<div class="state"><span class="badge badge-' + esc(s) + '">' + esc(s) + '</span></div>' +
        '<div class="seen">last seen ' + fmtTime(a.last_seen) + '</div>' +
        '<span class="card-resize" data-action="resize-handle" data-agent-name="' + esc(a.name) + '" title="Drag to resize (snaps to grid)">↘</span>' +
      '</div>';
    }).join('');
  }

  function renderTasks() {
    if (!snapshot) return;
    const tasks = snapshot.active_tasks || [];
    document.getElementById('tasks-count').textContent = tasks.length;
    const el = document.getElementById('tasks');
    if (!tasks.length) { el.innerHTML = '<div class="empty">No active tasks</div>'; return; }
    el.innerHTML = tasks.map((t) =>
      '<div class="row"><div class="row-head">' +
      '<span class="row-title"><span class="tag tag-' + esc(t.priority) + '">' + esc(t.priority) + '</span>' +
      '<span class="tag tag-' + esc(t.status) + '">' + esc(t.status) + '</span>' + esc(t.title) + '</span>' +
      '<span class="row-meta">' + fmtTime(t.created_at) + '</span></div>' +
      '<div class="row-body">' + esc(t.from_agent) + ' → ' + esc(t.to_agent || '(unassigned)') + '</div>' +
      '</div>'
    ).join('');
  }

  function renderMessages() {
    if (!snapshot) return;
    const bound = sinceBoundMs();
    // v2.2.2 B5: search string matches against from/to/content_preview,
    // case-insensitive substring. Empty string = no filter.
    const q = (prefs.messagesQuery || '').toLowerCase();
    const msgs = (snapshot.messages || []).filter((m) => {
      if (bound && new Date(m.created_at).getTime() < bound) return false;
      if (q) {
        const haystack = (
          (m.content_preview || '') + ' ' +
          (m.from_agent || '') + ' ' +
          (m.to_agent || '')
        ).toLowerCase();
        if (haystack.indexOf(q) === -1) return false;
      }
      return true;
    });
    document.getElementById('messages-count').textContent = msgs.length;
    const el = document.getElementById('messages');
    if (!msgs.length) { el.innerHTML = '<li class="empty">' + (q ? 'No messages match "' + esc(prefs.messagesQuery) + '"' : 'No messages in window') + '</li>'; return; }
    el.innerHTML = msgs.map((m, i) => {
      const preview = m.content_preview || '(encrypted)';
      const body = m.content_preview || '(content encrypted at rest — decrypted preview unavailable)';
      return '<li>' +
        '<button class="msg-row" type="button" aria-expanded="false" data-msg-idx="' + i + '">' +
        '<div class="row-head"><span><span class="tag tag-' + esc(m.status) + '">' + esc(m.status) + '</span>' +
        esc(m.from_agent) + ' → ' + esc(m.to_agent) + '</span>' +
        '<span class="row-meta">' + fmtTime(m.created_at) + '</span></div>' +
        '<div class="row-body" style="color:var(--muted);font-size:12px;margin-top:4px">' + esc(preview) + '</div>' +
        '<div class="msg-full">' + esc(body) + '</div>' +
        '</button></li>';
    }).join('');
  }

  function renderMeta() {
    if (!snapshot) return;
    const el = document.getElementById('meta');
    const hooks = snapshot.webhooks || [];
    const completions = snapshot.recent_completions || [];
    let html = '';
    hooks.forEach((w) => {
      html += '<div class="row"><div class="row-head">' +
        '<span class="row-title">🪝 ' + esc(w.event) + (w.filter ? ' (filter: ' + esc(w.filter) + ')' : '') + '</span>' +
        '<span class="row-meta">' + fmtTime(w.created_at) + '</span></div>' +
        '<div class="row-body"><code>' + esc(w.url) + '</code>' + (w.has_secret ? ' · signed' : '') + '</div></div>';
    });
    completions.forEach((t) => {
      const preview = t.result_preview || t.description_preview || '';
      html += '<div class="row"><div class="row-head">' +
        '<span class="row-title"><span class="tag tag-' + esc(t.status) + '">' + esc(t.status) + '</span>' + esc(t.title) + '</span>' +
        '<span class="row-meta">' + fmtTime(t.updated_at) + '</span></div>' +
        (preview ? '<div class="row-body">' + esc(preview) + '</div>' : '') +
        '</div>';
    });
    el.innerHTML = html || '<div class="empty">No webhooks or completed tasks</div>';
  }

  function renderFocused() {
    const panel = document.getElementById('focused-agent');
    if (!focusedAgent || !snapshot) { panel.classList.remove('visible'); return; }
    const agent = (snapshot.agents || []).find((a) => a.name === focusedAgent);
    if (!agent) { panel.classList.remove('visible'); return; }
    panel.classList.add('visible');
    document.getElementById('focused-title').textContent = 'Focused agent: ' + agent.name;
    const mine = (snapshot.messages || []).filter((m) => m.from_agent === agent.name || m.to_agent === agent.name);
    const body = document.getElementById('focused-body');
    body.innerHTML = '<div style="font-size:12px;color:var(--muted);margin-bottom:6px">' +
      'role: ' + esc(agent.role) + ' · status: ' + esc(agent.agent_status || 'idle') +
      ' · title_ref: ' + (agent.terminal_title_ref ? esc(agent.terminal_title_ref) : '<em>(none — focus disabled)</em>') +
      ' · ' + mine.length + ' recent messages' +
      '</div>';
    document.getElementById('btn-focus-terminal').disabled = !agent.terminal_title_ref;
  }

  function renderAll() {
    renderAgents();
    renderTasks();
    renderMessages();
    renderMeta();
    renderFocused();
    document.getElementById('updated').textContent = 'updated ' + fmtTime(snapshot && snapshot.timestamp);
  }

  // ---------- data fetch ----------
  async function fetchSnapshot() {
    try {
      const res = await fetch('/api/snapshot', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('snapshot ' + res.status);
      snapshot = await res.json();
      // v2.2.1 P1: if the operator hasn't picked a theme yet this session
      // (localStorage has no operator-set flag), adopt the server default.
      if (!prefs.themeSetByOperator && snapshot.dashboard_prefs && snapshot.dashboard_prefs.theme) {
        const serverTheme = snapshot.dashboard_prefs.theme;
        const serverCustom = snapshot.dashboard_prefs.custom_json;
        let customParsed = null;
        if (serverCustom) {
          try { customParsed = JSON.parse(serverCustom); } catch (_e) { /* ignore */ }
        }
        prefs.theme = serverTheme;
        prefs.customJson = customParsed;
        document.getElementById('theme-toggle').value = serverTheme;
        applyTheme(serverTheme, customParsed);
      }
      renderAll();
    } catch (e) {
      document.getElementById('updated').textContent = 'relay offline';
    }
  }

  // ---------- WebSocket ----------
  let ws = null;
  let wsBackoffMs = 1000;
  function setConnStatus(live) {
    const pill = document.getElementById('conn-pill');
    pill.classList.toggle('live', !!live);
    document.getElementById('conn-label').textContent = live ? 'live' : 'reconnecting…';
  }
  function openWs() {
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/dashboard/ws');
      ws.addEventListener('open', () => {
        wsBackoffMs = 1000;
        setConnStatus(true);
        // Immediate snapshot refresh to close any gap from reconnect.
        fetchSnapshot();
      });
      ws.addEventListener('message', () => {
        // Any push means "something changed" — re-fetch the canonical snapshot.
        fetchSnapshot();
      });
      ws.addEventListener('close', () => {
        setConnStatus(false);
        ws = null;
        setTimeout(openWs, wsBackoffMs);
        wsBackoffMs = Math.min(wsBackoffMs * 2, 30_000);
      });
      ws.addEventListener('error', () => {
        // close handler will fire next; nothing to do here.
      });
    } catch (_e) {
      setTimeout(openWs, wsBackoffMs);
      wsBackoffMs = Math.min(wsBackoffMs * 2, 30_000);
    }
  }

  // ---------- wiring ----------
  document.getElementById('cards-per-row-toggle').addEventListener('change', (e) => {
    prefs.cardsPerRow = parseInt(e.target.value, 10) || 3;
    document.documentElement.style.setProperty('--cards-per-row', String(prefs.cardsPerRow));
    savePrefs(prefs);
  });

  // v2.2.1 P1: theme dropdown. Operator selection beats server-default
  // from here on — mark themeSetByOperator so fetchSnapshot doesn't
  // overwrite with the server value on next poll.
  // v2.2.2 B1 — rich custom-theme dialog (replaces prompt()).
  //
  // Token list must match CustomThemeSchema in src/types.ts AND the CSS
  // variables declared in src/dashboard-styles.ts. Drift breaks the
  // server-side POST validator silently.
  const THEME_TOKENS = ['bg','panel','panel-2','border','text','muted','accent','online','stale','offline','critical','high','normal','low'];
  // color pickers only accept #rrggbb. Normalize any rgb()/hsl() values
  // by reading them from a temp element into computed style. Keeps the
  // color picker functional while the JSON paste fallback accepts any
  // CSS color string.
  function normalizeToHex(val) {
    if (!val) return '#000000';
    if (/^#[0-9a-fA-F]{6}$/.test(val)) return val.toLowerCase();
    // Minimal-effort conversion via a canvas ctx. Invalid values fall
    // back to black so the picker doesn't silently glitch.
    try {
      const s = document.createElement('span');
      s.style.color = val;
      document.body.appendChild(s);
      const computed = getComputedStyle(s).color;
      document.body.removeChild(s);
      const m = computed.match(/rgba?\\(([^)]+)\\)/);
      if (!m) return '#000000';
      const parts = m[1].split(',').map(x => parseFloat(x.trim()));
      const [r,g,b] = parts;
      const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
      return '#' + toHex(r) + toHex(g) + toHex(b);
    } catch (_e) { return '#000000'; }
  }
  function seedDialogFromCurrent(startingJson) {
    const root = document.documentElement;
    const computed = getComputedStyle(root);
    for (const t of THEME_TOKENS) {
      const picker = document.querySelector('input[data-token="' + t + '"]');
      if (!picker) continue;
      let initial;
      if (startingJson && typeof startingJson === 'object' && startingJson[t]) {
        initial = startingJson[t];
      } else {
        initial = (computed.getPropertyValue('--' + t) || '').trim() || '#000000';
      }
      picker.value = normalizeToHex(initial);
    }
    const jsonArea = document.getElementById('custom-theme-json');
    jsonArea.value = startingJson ? JSON.stringify(startingJson, null, 2) : '';
    document.getElementById('custom-theme-json-err').style.display = 'none';
  }
  function collectDialogValues() {
    const obj = {};
    for (const t of THEME_TOKENS) {
      const picker = document.querySelector('input[data-token="' + t + '"]');
      obj[t] = picker ? picker.value : '#000000';
    }
    return obj;
  }
  function openCustomThemeDialog() {
    const dlg = document.getElementById('custom-theme-dialog');
    if (!dlg || typeof dlg.showModal !== 'function') return false;
    seedDialogFromCurrent(prefs.customJson);
    // Snapshot current applied theme so Cancel reverts cleanly.
    openCustomThemeDialog._revert = {
      theme: prefs.theme,
      customJson: prefs.customJson ? JSON.parse(JSON.stringify(prefs.customJson)) : null,
    };
    dlg.showModal();
    return true;
  }
  function closeCustomThemeDialog(save) {
    const dlg = document.getElementById('custom-theme-dialog');
    if (!dlg) return;
    if (save) {
      const obj = collectDialogValues();
      prefs.customJson = obj;
      prefs.theme = 'custom';
      prefs.themeSetByOperator = true;
      applyTheme('custom', obj);
      savePrefs(prefs);
      document.getElementById('theme-toggle').value = 'custom';
      // Best-effort server persist. Dashboard's first-visit read will
      // reflect it; currently-open tabs keep their localStorage.
      fetch('/api/dashboard-theme', {
        method: 'POST',
        credentials: 'same-origin',
        headers: Object.assign({ 'Content-Type': 'application/json' }, csrfHeader()),
        body: JSON.stringify({ mode: 'custom', custom_json: obj }),
      }).catch(() => { /* non-fatal; local state already applied */ });
    } else {
      const rv = openCustomThemeDialog._revert;
      if (rv) {
        prefs.theme = rv.theme;
        prefs.customJson = rv.customJson;
        applyTheme(rv.theme, rv.customJson);
        document.getElementById('theme-toggle').value = rv.theme;
      }
    }
    dlg.close();
  }
  // Live preview: every picker change applies immediately so the preview
  // pane + the page under the dialog (dialog is non-opaque) both react.
  document.querySelectorAll('#custom-theme-dialog input[data-token]').forEach((input) => {
    input.addEventListener('input', () => {
      const obj = collectDialogValues();
      applyTheme('custom', obj);
    });
  });
  document.getElementById('custom-theme-save').addEventListener('click', () => closeCustomThemeDialog(true));
  document.getElementById('custom-theme-cancel').addEventListener('click', () => closeCustomThemeDialog(false));
  document.getElementById('custom-theme-close').addEventListener('click', () => closeCustomThemeDialog(false));
  // Click-outside-to-cancel: native <dialog> fires a 'click' whose target
  // is the dialog itself when the backdrop is hit.
  document.getElementById('custom-theme-dialog').addEventListener('click', (e) => {
    if (e.target && e.target.id === 'custom-theme-dialog') closeCustomThemeDialog(false);
  });
  // Escape-to-cancel: native <dialog> fires a 'cancel' event on Esc.
  document.getElementById('custom-theme-dialog').addEventListener('cancel', (e) => {
    e.preventDefault();
    closeCustomThemeDialog(false);
  });
  document.getElementById('custom-theme-json-apply').addEventListener('click', () => {
    const raw = document.getElementById('custom-theme-json').value;
    const errEl = document.getElementById('custom-theme-json-err');
    errEl.style.display = 'none';
    if (!raw || !raw.trim()) return;
    try {
      const parsed = JSON.parse(raw);
      const missing = THEME_TOKENS.filter((t) => !parsed[t]);
      if (missing.length > 0) throw new Error('missing tokens: ' + missing.join(', '));
      for (const t of THEME_TOKENS) {
        const picker = document.querySelector('input[data-token="' + t + '"]');
        if (picker) picker.value = normalizeToHex(parsed[t]);
      }
      applyTheme('custom', collectDialogValues());
    } catch (err) {
      errEl.textContent = 'Invalid JSON: ' + (err && err.message ? err.message : String(err));
      errEl.style.display = 'block';
    }
  });

  // v2.2.1 P1: theme dropdown. Operator selection beats server-default.
  document.getElementById('theme-toggle').addEventListener('change', (e) => {
    const mode = e.target.value;
    prefs.theme = mode;
    prefs.themeSetByOperator = true;
    if (mode === 'custom') {
      const ok = openCustomThemeDialog();
      if (!ok) {
        // <dialog> not supported — fall back to prompt().
        const raw = prompt('Paste a custom theme JSON with 14 color tokens (bg, panel, panel-2, border, text, muted, accent, online, stale, offline, critical, high, normal, low):', prefs.customJson ? JSON.stringify(prefs.customJson) : '');
        if (raw !== null && raw.trim().length > 0) {
          try {
            const parsed = JSON.parse(raw);
            prefs.customJson = parsed;
            applyTheme('custom', parsed);
            savePrefs(prefs);
          } catch (_err) {
            alert('Invalid JSON — keeping previous theme.');
            e.target.value = prefs.theme === 'custom' ? 'custom' : 'catppuccin';
          }
        } else {
          e.target.value = prefs.theme === 'custom' ? 'custom' : 'catppuccin';
        }
      }
      return;
    }
    applyTheme(mode, null);
    savePrefs(prefs);
    // Persist server-side (best-effort).
    fetch('/api/dashboard-theme', {
      method: 'POST',
      credentials: 'same-origin',
      headers: Object.assign({ 'Content-Type': 'application/json' }, csrfHeader()),
      body: JSON.stringify({ mode }),
    }).catch(() => { /* non-fatal */ });
  });
  document.getElementById('filter-role').addEventListener('input', (e) => {
    prefs.role = e.target.value.trim();
    savePrefs(prefs);
    renderAgents();
  });
  document.getElementById('filter-status').addEventListener('change', (e) => {
    prefs.status = e.target.value;
    savePrefs(prefs);
    renderAgents();
  });
  document.getElementById('filter-since').addEventListener('change', (e) => {
    prefs.since = e.target.value;
    savePrefs(prefs);
    renderMessages();
  });
  // v2.2.2 B3 — show abandoned toggle.
  document.getElementById('filter-show-abandoned').checked = !!prefs.showAbandoned;
  document.getElementById('filter-show-abandoned').addEventListener('change', (e) => {
    prefs.showAbandoned = !!e.target.checked;
    savePrefs(prefs);
    renderAgents();
  });
  // v2.2.2 B4 — sort toggle.
  document.getElementById('filter-sort').value = prefs.sort || 'status';
  document.getElementById('filter-sort').addEventListener('change', (e) => {
    prefs.sort = e.target.value;
    savePrefs(prefs);
    renderAgents();
  });
  // v2.2.2 B5 — messages search (200ms debounce).
  const messagesSearch = document.getElementById('filter-messages-search');
  messagesSearch.value = prefs.messagesQuery || '';
  let messagesSearchTimer = null;
  messagesSearch.addEventListener('input', (e) => {
    if (messagesSearchTimer) clearTimeout(messagesSearchTimer);
    messagesSearchTimer = setTimeout(() => {
      prefs.messagesQuery = String(e.target.value || '').trim();
      savePrefs(prefs);
      renderMessages();
    }, 200);
  });

  // Agent card click → open focused panel. v2.2.2 B2: reset-size button
  // and resize-handle lives inside the card; suppress focus-open when
  // either was the click origin.
  document.getElementById('agents-grid').addEventListener('click', (e) => {
    const action = e.target && e.target.getAttribute && e.target.getAttribute('data-action');
    if (action === 'reset-size') {
      const name = e.target.getAttribute('data-agent-name');
      if (name && cardSizes[name]) {
        delete cardSizes[name];
        cardSizes = saveCardSizes(cardSizes);
        renderAgents();
      }
      e.stopPropagation();
      return;
    }
    if (action === 'resize-handle') {
      // Handled via pointerdown below; swallow the trailing click so it
      // doesn't also open focus.
      e.stopPropagation();
      return;
    }
    const card = e.target.closest('[data-agent]');
    if (!card) return;
    focusedAgent = card.getAttribute('data-agent');
    renderAll();
  });

  // v2.2.2 B2: pointer-drag resize. Handle is bottom-right ↘. Delta in
  // pixels → integer col/row spans via the parent grid's computed
  // column width + a fixed row-height snap (120px — empirical; cards
  // hover ~100-130px at current density).
  const RESIZE_ROW_SNAP_PX = 120;
  const RESIZE_MAX_COL = 4;
  const RESIZE_MAX_ROW = 3;
  let activeResize = null;
  document.getElementById('agents-grid').addEventListener('pointerdown', (e) => {
    if (!e.target || e.target.getAttribute('data-action') !== 'resize-handle') return;
    const card = e.target.closest('[data-agent]');
    if (!card) return;
    const name = card.getAttribute('data-agent');
    const grid = document.getElementById('agents-grid');
    const gridStyle = getComputedStyle(grid);
    const gridCols = gridStyle.gridTemplateColumns.split(' ').filter(Boolean);
    const colPx = gridCols.length > 0 ? parseFloat(gridCols[0]) : 200;
    const gapPx = parseFloat(gridStyle.columnGap || gridStyle.gap || '12');
    const startRect = card.getBoundingClientRect();
    activeResize = {
      name,
      card,
      colPx,
      gapPx,
      startX: e.clientX,
      startY: e.clientY,
      startW: startRect.width,
      startH: startRect.height,
    };
    try { e.target.setPointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    e.preventDefault();
  });
  document.getElementById('agents-grid').addEventListener('pointermove', (e) => {
    if (!activeResize) return;
    const dx = e.clientX - activeResize.startX;
    const dy = e.clientY - activeResize.startY;
    const targetW = activeResize.startW + dx;
    const targetH = activeResize.startH + dy;
    const colUnit = activeResize.colPx + activeResize.gapPx;
    let col = Math.round((targetW + activeResize.gapPx) / colUnit);
    let row = Math.round(targetH / RESIZE_ROW_SNAP_PX);
    col = Math.max(1, Math.min(RESIZE_MAX_COL, col));
    row = Math.max(1, Math.min(RESIZE_MAX_ROW, row));
    activeResize.card.style.gridColumn = col > 1 ? 'span ' + col : '';
    activeResize.card.style.gridRow = row > 1 ? 'span ' + row : '';
    activeResize.pendingCol = col;
    activeResize.pendingRow = row;
  });
  function endResize() {
    if (!activeResize) return;
    const { name, pendingCol, pendingRow } = activeResize;
    activeResize = null;
    if (!name) return;
    const col = pendingCol || 1;
    const row = pendingRow || 1;
    if (col <= 1 && row <= 1) {
      delete cardSizes[name];
    } else {
      cardSizes[name] = { col, row, t: Date.now() };
    }
    cardSizes = saveCardSizes(cardSizes);
    renderAgents();
  }
  document.getElementById('agents-grid').addEventListener('pointerup', endResize);
  document.getElementById('agents-grid').addEventListener('pointercancel', endResize);
  // Keyboard: Enter / Space on a focused card triggers the same.
  document.getElementById('agents-grid').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('[data-agent]');
    if (!card) return;
    e.preventDefault();
    focusedAgent = card.getAttribute('data-agent');
    renderAll();
  });

  // Message row click → ARIA-accordion toggle.
  document.getElementById('messages').addEventListener('click', (e) => {
    const btn = e.target.closest('.msg-row');
    if (!btn) return;
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
  });

  // Focused-agent actions.
  document.getElementById('btn-close-focused').addEventListener('click', () => {
    focusedAgent = null;
    renderAll();
  });
  /**
   * v2.2.0 Codex audit H2: read the relay_csrf cookie and forward as the
   * X-Relay-CSRF header on every state-changing fetch to /api/*. v2.1.7
   * csrfCheck middleware requires cookie + header to match under constant-
   * time compare; without this, the dashboard can't reach POST /api/* at
   * all when RELAY_DASHBOARD_SECRET is set. Pattern reused by v2.2.1's
   * inline-action endpoints (kill-agent / set-status / send-message).
   */
  function csrfHeader() {
    const m = document.cookie.match(/(?:^|;\\s*)relay_csrf=([^;]+)/);
    return m ? { 'X-Relay-CSRF': decodeURIComponent(m[1]) } : {};
  }

  document.getElementById('btn-focus-terminal').addEventListener('click', async () => {
    if (!focusedAgent) return;
    try {
      const res = await fetch('/api/focus-terminal', {
        method: 'POST',
        credentials: 'same-origin',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          csrfHeader()
        ),
        body: JSON.stringify({ agent_name: focusedAgent }),
      });
      const data = await res.json().catch(() => ({}));
      const pill = document.getElementById('conn-pill');
      const label = document.getElementById('conn-label');
      const prev = label.textContent;
      label.textContent = data.raised ? 'raised ' + (data.platform || '') : 'raise failed';
      pill.classList.add('live');
      setTimeout(() => { label.textContent = prev || 'live'; }, 1600);
    } catch (_e) { /* swallow; status pill remains */ }
  });

  // v2.3.0 Part C.5 — wake-agent button. Touches the filesystem marker
  // so ambient-wake clients watching the marker path get a low-latency
  // nudge. No-op when RELAY_FILESYSTEM_MARKERS is off on the daemon —
  // the server returns markers_enabled:false + an informative note.
  document.getElementById('btn-wake-agent').addEventListener('click', async () => {
    if (!focusedAgent) return;
    try {
      const res = await fetch('/api/wake-agent', {
        method: 'POST',
        credentials: 'same-origin',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          csrfHeader(),
        ),
        body: JSON.stringify({ agent_name: focusedAgent }),
      });
      const data = await res.json().catch(() => ({}));
      const btn = document.getElementById('btn-wake-agent');
      const origLabel = btn.textContent;
      if (data.markers_enabled) {
        btn.textContent = '🔔 Woke ' + focusedAgent;
      } else {
        btn.textContent = '🔔 Markers disabled';
        btn.title = data.note || 'Set RELAY_FILESYSTEM_MARKERS=1 on the daemon to enable wake.';
      }
      setTimeout(() => { btn.textContent = origLabel; }, 1800);
    } catch (_e) { /* swallow */ }
  });

  // v2.2.2 A2: operator-identity indicator + setter. Reads the current
  // identity (cookie > env > default), shows it in the header, and lets the
  // operator edit it via prompt(). Stored in the relay_operator_identity
  // cookie (SameSite=Lax, 90-day, NOT HttpOnly so this JS can read it).
  async function refreshOperatorIdentity() {
    try {
      const r = await fetch('/api/operator-identity', { credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      const btn = document.getElementById('operator-identity-btn');
      const span = document.getElementById('operator-identity-value');
      if (!btn || !span) return;
      span.textContent = data.identity || 'dashboard-user';
      btn.title =
        'Operator identity (source: ' + data.source + ').' +
        (data.env_set ? ' RELAY_DASHBOARD_OPERATOR is set.' : '') +
        ' Click to change. Empty clears the cookie.';
    } catch (_e) { /* ignore; header stays "…" */ }
  }
  document.getElementById('operator-identity-btn').addEventListener('click', async () => {
    const current = document.getElementById('operator-identity-value').textContent || '';
    const next = window.prompt(
      'Operator identity for audit-log attribution.\\nLeave blank to clear (falls back to env var / default).',
      current === 'dashboard-user' ? '' : current,
    );
    if (next === null) return; // cancelled
    try {
      const r = await fetch('/api/operator-identity', {
        method: 'POST',
        credentials: 'same-origin',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          csrfHeader()
        ),
        body: JSON.stringify({ identity: next }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        window.alert('Set failed: ' + (data.error || r.status));
        return;
      }
      await refreshOperatorIdentity();
    } catch (err) {
      window.alert('Set failed: ' + (err && err.message ? err.message : String(err)));
    }
  });
  refreshOperatorIdentity();

  // Safety-net poll: every 10s even if the WebSocket is alive — covers
  // edge cases where a push got dropped during reconnect backoff.
  setInterval(fetchSnapshot, 10_000);

  // Kick things off.
  fetchSnapshot();
  openWs();
})();
</script>
</body>
</html>`;
