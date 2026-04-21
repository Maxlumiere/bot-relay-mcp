// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import type { Request, Response } from "express";
import { getAgents, listWebhooks, getDb } from "./db.js";
import { getKeyringInfo, decryptContent } from "./encryption.js";
import type { MessageRecord, TaskRecord } from "./types.js";

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

    res.json({
      timestamp: new Date().toISOString(),
      agents,
      webhooks,
      messages: messagesWithPreview,
      active_tasks: tasksWithPreview,
      recent_completions: completionsWithPreview,
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
<style>
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --panel-2: #1d212a;
    --border: #2a2f3b;
    --text: #e4e6eb;
    --muted: #8a92a3;
    --accent: #2D6A4F;
    --online: #4ade80;
    --stale: #fbbf24;
    --offline: #6b7280;
    --critical: #ef4444;
    --high: #f97316;
    --normal: #60a5fa;
    --low: #9ca3af;
    --cards-per-row: 3;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.4;
  }
  header {
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
  header .meta { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  main { padding: 24px; display: grid; gap: 24px; grid-template-columns: 2fr 1fr; max-width: 1400px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  .controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .controls select, .controls input {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 12px;
  }
  .controls label { color: var(--muted); font-size: 12px; display: inline-flex; gap: 6px; align-items: center; }
  .agents-grid {
    display: grid;
    grid-template-columns: repeat(var(--cards-per-row), minmax(0, 1fr));
    gap: 12px;
    padding: 16px;
  }
  .agent-card {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    cursor: pointer;
    transition: transform 0.1s, border-color 0.1s;
  }
  .agent-card:hover { border-color: var(--accent); transform: translateY(-1px); }
  .agent-card.focused { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .agent-card .name { font-weight: 600; font-size: 14px; margin-bottom: 4px; }
  .agent-card .role { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
  .agent-card .state { margin-top: 8px; font-size: 12px; }
  .agent-card .seen { color: var(--muted); font-size: 11px; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 10px;
    text-transform: lowercase;
  }
  .badge-idle { background: rgba(74,222,128,0.15); color: var(--online); }
  .badge-working { background: rgba(96,165,250,0.15); color: var(--normal); }
  .badge-blocked { background: rgba(251,191,36,0.15); color: var(--stale); }
  .badge-waiting_user { background: rgba(251,191,36,0.15); color: var(--stale); }
  .badge-stale { background: rgba(251,191,36,0.15); color: var(--stale); }
  .badge-offline { background: rgba(107,114,128,0.15); color: var(--offline); }
  .msg-list { list-style: none; padding: 0; margin: 0; }
  .msg-row {
    display: block;
    width: 100%;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    text-align: left;
    padding: 10px 16px;
    font-size: 13px;
    cursor: pointer;
    font-family: inherit;
  }
  .msg-row:hover { background: var(--panel-2); }
  .msg-row:last-child { border-bottom: none; }
  .msg-row[aria-expanded="true"] .msg-full { display: block; }
  .msg-full { display: none; margin-top: 6px; color: var(--muted); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .focused-agent {
    margin: 0 24px 24px;
    padding: 16px;
    background: var(--panel);
    border: 1px solid var(--accent);
    border-radius: 10px;
    display: none;
  }
  .focused-agent.visible { display: block; }
  .focused-agent h3 { margin: 0 0 12px 0; font-size: 14px; }
  .focused-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .focused-actions button {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
  }
  .focused-actions button:hover:not(:disabled) { border-color: var(--accent); }
  .focused-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
  .conn-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    background: var(--panel-2);
    color: var(--muted);
  }
  .conn-pill .conn-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--offline); }
  .conn-pill.live .conn-dot { background: var(--online); }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .panel h2 {
    margin: 0;
    padding: 12px 16px;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    background: var(--panel-2);
  }
  .panel-body { padding: 8px 0; max-height: 420px; overflow-y: auto; }
  .row {
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .row:last-child { border-bottom: none; }
  .row-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .row-title { font-weight: 500; }
  .row-meta { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .row-body { color: var(--muted); font-size: 12px; margin-top: 4px; word-break: break-word; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .status-online { background: var(--online); }
  .status-stale { background: var(--stale); }
  .status-offline { background: var(--offline); }
  .tag {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    margin-right: 6px;
  }
  .tag-critical { background: rgba(239,68,68,0.15); color: var(--critical); }
  .tag-high { background: rgba(249,115,22,0.15); color: var(--high); }
  .tag-normal { background: rgba(96,165,250,0.15); color: var(--normal); }
  .tag-low { background: rgba(156,163,175,0.15); color: var(--low); }
  .tag-posted { background: rgba(96,165,250,0.15); color: var(--normal); }
  .tag-accepted { background: rgba(251,191,36,0.15); color: var(--stale); }
  .tag-completed { background: rgba(74,222,128,0.15); color: var(--online); }
  .tag-rejected { background: rgba(239,68,68,0.15); color: var(--critical); }
  .tag-pending { background: rgba(96,165,250,0.15); color: var(--normal); }
  .tag-read { background: rgba(156,163,175,0.15); color: var(--low); }
  .empty { padding: 24px 16px; text-align: center; color: var(--muted); font-size: 13px; }
  code { font-family: "SF Mono", Monaco, Menlo, monospace; font-size: 11px; }
</style>
</head>
<body>
<header>
  <h1>bot-relay dashboard</h1>
  <div class="controls">
    <span id="conn-pill" class="conn-pill" title="WebSocket connection to /dashboard/ws"><span class="conn-dot"></span><span id="conn-label">connecting…</span></span>
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
    <div class="panel-body" style="max-height:none"><ul class="msg-list" id="messages" role="list"></ul></div>
  </section>
  <section class="panel" style="grid-column:1/-1">
    <h2>Webhooks &amp; completed</h2>
    <div class="panel-body" id="meta"></div>
  </section>
</main>
<section id="focused-agent" class="focused-agent" aria-live="polite">
  <h3 id="focused-title">Focused agent</h3>
  <div id="focused-body"></div>
  <div class="focused-actions">
    <button id="btn-focus-terminal" type="button" title="Raise the agent's OS terminal window">📱 Raise terminal</button>
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
  const prefs = Object.assign({ cardsPerRow: 3, role: '', status: 'all', since: '24h' }, loadPrefs());

  // Apply persisted prefs immediately so the first render uses them.
  document.documentElement.style.setProperty('--cards-per-row', String(prefs.cardsPerRow));
  document.getElementById('cards-per-row-toggle').value = String(prefs.cardsPerRow);
  document.getElementById('filter-role').value = prefs.role;
  document.getElementById('filter-status').value = prefs.status;
  document.getElementById('filter-since').value = prefs.since;

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
  function applyFilters(agents) {
    return agents.filter((a) => {
      if (prefs.role && a.role !== prefs.role) return false;
      if (prefs.status !== 'all' && a.agent_status !== prefs.status) return false;
      return true;
    });
  }

  function renderAgents() {
    if (!snapshot) return;
    const filtered = applyFilters(snapshot.agents);
    document.getElementById('agents-count').textContent = filtered.length;
    const el = document.getElementById('agents-grid');
    if (!filtered.length) { el.innerHTML = '<div class="empty">No agents match filters</div>'; return; }
    el.innerHTML = filtered.map((a) => {
      const s = a.agent_status || 'idle';
      const isFocused = focusedAgent === a.name ? ' focused' : '';
      return '<div class="agent-card' + isFocused + '" role="button" tabindex="0" data-agent="' + esc(a.name) + '">' +
        '<div class="name">' + esc(a.name) + '</div>' +
        '<div class="role">' + esc(a.role) + '</div>' +
        '<div class="state"><span class="badge badge-' + esc(s) + '">' + esc(s) + '</span></div>' +
        '<div class="seen">last seen ' + fmtTime(a.last_seen) + '</div>' +
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
    const msgs = (snapshot.messages || []).filter((m) => {
      if (bound && new Date(m.created_at).getTime() < bound) return false;
      return true;
    });
    document.getElementById('messages-count').textContent = msgs.length;
    const el = document.getElementById('messages');
    if (!msgs.length) { el.innerHTML = '<li class="empty">No messages in window</li>'; return; }
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

  // Agent card click → open focused panel.
  document.getElementById('agents-grid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-agent]');
    if (!card) return;
    focusedAgent = card.getAttribute('data-agent');
    renderAll();
  });
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
