// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import type { Request, Response } from "express";
import { getAgents, listWebhooks, getDb } from "./db.js";
import { getKeyringInfo } from "./encryption.js";
import type { MessageRecord, TaskRecord } from "./types.js";

/**
 * Minimal HTML/JS dashboard for visibility into the relay state.
 * Vanilla JS, no build step, no dependencies. Auto-refreshes every 3 seconds.
 * Mounted at GET / and GET /dashboard on the HTTP server.
 *
 * v2.1 Phase 4d — info-disclosure policy for snapshotApi:
 *   - agents: use AgentWithStatus (toAgentWithStatus in db.ts) which strips
 *     `token_hash` and exposes only `has_token: boolean`. NEVER return the
 *     bcrypt hash or any raw token.
 *   - webhooks: the raw WebhookRecord has `secret`, but the dashboard mapper
 *     replaces it with `has_secret: boolean`. NEVER surface the raw secret.
 *   - messages / tasks: `SELECT *` returns at-rest-encrypted columns
 *     (`content`, `description`, `result`) as `enc1:...` ciphertext. The
 *     dashboard intentionally does NOT decrypt — a dashboard-auth failure
 *     would otherwise leak plaintext from a JSON response. If encryption is
 *     disabled (no RELAY_ENCRYPTION_KEY), rows are plaintext and the operator
 *     has already opted into that visibility.
 *   - webhook_delivery_log with its `error_text` (F-3a.5 concern) is NOT
 *     returned by snapshotApi. If a future change adds it, redact
 *     internal-looking paths + IPs before surfacing.
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

    res.json({
      timestamp: new Date().toISOString(),
      agents,
      webhooks,
      messages,
      active_tasks: activeTasks,
      recent_completions: recentCompletions,
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
  main { padding: 24px; display: grid; gap: 24px; grid-template-columns: 1fr 1fr; max-width: 1400px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
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
  <div class="meta"><span id="updated">connecting…</span></div>
</header>
<main>
  <section class="panel">
    <h2>Agents (<span id="agents-count">0</span>)</h2>
    <div class="panel-body" id="agents"></div>
  </section>
  <section class="panel">
    <h2>Active tasks (<span id="tasks-count">0</span>)</h2>
    <div class="panel-body" id="tasks"></div>
  </section>
  <section class="panel">
    <h2>Recent messages (<span id="messages-count">0</span>)</h2>
    <div class="panel-body" id="messages"></div>
  </section>
  <section class="panel">
    <h2>Webhooks &amp; completed</h2>
    <div class="panel-body" id="meta"></div>
  </section>
</main>
<script>
function fmtTime(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return Math.floor(diff) + 's ago';
  if (diff < 3600) return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  return Math.floor(diff/86400) + 'd ago';
}
function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
async function refresh() {
  try {
    const res = await fetch('/api/snapshot');
    const data = await res.json();
    document.getElementById('updated').textContent = 'updated ' + fmtTime(data.timestamp);
    renderAgents(data.agents);
    renderTasks(data.active_tasks);
    renderMessages(data.messages);
    renderMeta(data.webhooks, data.recent_completions);
  } catch (e) {
    document.getElementById('updated').textContent = 'relay offline';
  }
}
function renderAgents(agents) {
  document.getElementById('agents-count').textContent = agents.length;
  const el = document.getElementById('agents');
  if (!agents.length) { el.innerHTML = '<div class="empty">No agents registered</div>'; return; }
  el.innerHTML = agents.map(a => \`
    <div class="row">
      <div class="row-head">
        <span class="row-title"><span class="dot status-\${a.status}"></span>\${escape(a.name)} <span style="color:var(--muted);font-weight:400">· \${escape(a.role)}</span></span>
        <span class="row-meta">\${fmtTime(a.last_seen)}</span>
      </div>
      \${a.capabilities.length ? \`<div class="row-body">\${a.capabilities.map(c => '<code>' + escape(c) + '</code>').join(' ')}</div>\` : ''}
    </div>
  \`).join('');
}
function renderTasks(tasks) {
  document.getElementById('tasks-count').textContent = tasks.length;
  const el = document.getElementById('tasks');
  if (!tasks.length) { el.innerHTML = '<div class="empty">No active tasks</div>'; return; }
  el.innerHTML = tasks.map(t => \`
    <div class="row">
      <div class="row-head">
        <span class="row-title"><span class="tag tag-\${t.priority}">\${t.priority}</span><span class="tag tag-\${t.status}">\${t.status}</span>\${escape(t.title)}</span>
        <span class="row-meta">\${fmtTime(t.created_at)}</span>
      </div>
      <div class="row-body">\${escape(t.from_agent)} → \${escape(t.to_agent ?? "(unassigned)")}</div>
    </div>
  \`).join('');
}
function renderMessages(messages) {
  document.getElementById('messages-count').textContent = messages.length;
  const el = document.getElementById('messages');
  if (!messages.length) { el.innerHTML = '<div class="empty">No messages</div>'; return; }
  el.innerHTML = messages.map(m => \`
    <div class="row">
      <div class="row-head">
        <span class="row-title"><span class="tag tag-\${m.status}">\${m.status}</span>\${escape(m.from_agent)} → \${escape(m.to_agent)}</span>
        <span class="row-meta">\${fmtTime(m.created_at)}</span>
      </div>
      <div class="row-body">\${escape(m.content)}</div>
    </div>
  \`).join('');
}
function renderMeta(webhooks, completions) {
  const el = document.getElementById('meta');
  let html = '';
  if (webhooks.length) {
    html += webhooks.map(w => \`
      <div class="row">
        <div class="row-head">
          <span class="row-title">🪝 \${escape(w.event)}\${w.filter ? ' (filter: ' + escape(w.filter) + ')' : ''}</span>
          <span class="row-meta">\${fmtTime(w.created_at)}</span>
        </div>
        <div class="row-body"><code>\${escape(w.url)}</code>\${w.has_secret ? ' · signed' : ''}</div>
      </div>
    \`).join('');
  }
  if (completions.length) {
    html += completions.map(t => \`
      <div class="row">
        <div class="row-head">
          <span class="row-title"><span class="tag tag-\${t.status}">\${t.status}</span>\${escape(t.title)}</span>
          <span class="row-meta">\${fmtTime(t.updated_at)}</span>
        </div>
        \${t.result ? '<div class="row-body">' + escape(t.result).slice(0, 160) + (t.result.length > 160 ? '…' : '') + '</div>' : ''}
      </div>
    \`).join('');
  }
  if (!html) html = '<div class="empty">No webhooks or completed tasks</div>';
  el.innerHTML = html;
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
