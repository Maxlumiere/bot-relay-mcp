// bot-relay-mcp Kanban board (Vercel) — server-side HTML render.
// SPDX-License-Identifier: MIT
//
// Renders the last-good kanban.v1 snapshot. ALL relay-sourced strings (agent
// names, obligation previews) are HTML-escaped — the snapshot is fleet-authored
// content rendered in Maxime's browser, so it is untrusted for markup purposes.

import { computeBanner, fmtAge } from "./board-state.js";

export function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const BANNER_STYLE = {
  ok: "background:#0b3d1e;color:#b7f7c9;border-color:#1f7a43",
  stale: "background:#4d3a00;color:#ffe39a;border-color:#a5820f",
  rejected: "background:#4d0b0b;color:#ffc2c2;border-color:#b22222",
  waiting: "background:#20304d;color:#bcd4ff;border-color:#3a5a9a",
};

function bannerHtml(banner) {
  const style = BANNER_STYLE[banner.level] || BANNER_STYLE.waiting;
  const detail = banner.detail ? `<div class="banner-detail">${escapeHtml(banner.detail)}</div>` : "";
  return `<section class="banner" style="${style}" data-level="${escapeHtml(banner.level)}">
    <strong>${escapeHtml(banner.title)}</strong>${detail}
  </section>`;
}

function agentCardHtml(a) {
  const term = a.terminal_title_ref ? `<span class="meta">🖥 ${escapeHtml(a.terminal_title_ref)}</span>` : "";
  const cli = a.cli_profile ? `<span class="meta">⌨ ${escapeHtml(a.cli_profile)}</span>` : "";
  const role = a.role ? `<span class="meta">${escapeHtml(a.role)}</span>` : "";
  const status = escapeHtml(a.agent_status || a.status || "unknown");
  return `<div class="card">
    <div class="card-name">${escapeHtml(a.name)}</div>
    <div class="card-meta">${role}${term}${cli}</div>
    <div class="card-status status-${escapeHtml((a.agent_status || a.status || "unknown").replace(/[^a-z0-9_-]/gi, ""))}">${status}</div>
  </div>`;
}

function pendingItemHtml(p) {
  const overdue = p.overdue ? ' <span class="overdue">OVERDUE</span>' : "";
  const deadline = p.deadline ? `<span class="meta">due ${escapeHtml(p.deadline)}</span>` : "";
  return `<li class="pending-item${p.overdue ? " is-overdue" : ""}">
    <div class="pending-head"><strong>${escapeHtml(p.to_agent)}</strong>${overdue} <span class="meta">← ${escapeHtml(p.from_agent)}</span></div>
    <div class="pending-body">${escapeHtml(p.content_preview)}</div>
    <div class="pending-foot"><span class="meta">${escapeHtml(p.disposition)} · ${escapeHtml(p.created_at)}</span>${deadline}</div>
  </li>`;
}

/**
 * @param {{latest: {snapshot: object, received_at: string}|null, lastRejection: object|null, nowMs: number}} args
 * @returns {string} full HTML document
 */
export function renderBoard({ latest, lastRejection, nowMs }) {
  const banner = computeBanner({ latest, lastRejection, nowMs });
  const snap = latest && latest.snapshot ? latest.snapshot : null;

  const agents = snap && Array.isArray(snap.agents) ? snap.agents : [];
  const pending = snap && Array.isArray(snap.pending_on_human) ? snap.pending_on_human : [];

  const agentsHtml = agents.length
    ? agents.map(agentCardHtml).join("\n")
    : snap
      ? `<div class="empty">No agents registered right now.</div>`
      : `<div class="empty">No snapshot yet.</div>`;

  const pendingHtml = pending.length
    ? `<ul class="pending-list">${pending.map(pendingItemHtml).join("\n")}</ul>`
    : `<div class="empty">Nothing is blocked on a human right now.</div>`;

  const note = snap && snap.note ? `<section class="note">${escapeHtml(snap.note)}</section>` : "";

  const footer = latest
    ? `snapshot generated ${escapeHtml(snap?.generated_at || "?")} · received ${escapeHtml(latest.received_at)}` +
      (banner.ageMs != null ? ` · ${fmtAge(banner.ageMs)} ago` : "")
    : "awaiting first snapshot";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Fleet board — bot-relay-mcp</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#0e1116; color:#e6edf3; padding:20px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:#8b949e; font-size:12px; margin-bottom:14px; }
  .banner { border:1px solid; border-radius:8px; padding:10px 14px; margin-bottom:18px; }
  .banner-detail { font-size:12px; margin-top:6px; opacity:.9; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:#8b949e; margin:22px 0 10px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:12px; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:12px; }
  .card-name { font-weight:600; font-size:15px; margin-bottom:6px; word-break:break-word; }
  .card-meta { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px; }
  .meta { color:#8b949e; font-size:12px; }
  .card-status { display:inline-block; font-size:12px; padding:2px 8px; border-radius:999px;
                 background:#21262d; border:1px solid #30363d; }
  .status-active, .status-busy { background:#0b3d1e; border-color:#1f7a43; color:#b7f7c9; }
  .status-idle { background:#20304d; border-color:#3a5a9a; color:#bcd4ff; }
  .status-offline, .status-parked { background:#3a2020; border-color:#7a3a3a; color:#ffc2c2; }
  .pending-list { list-style:none; margin:0; padding:0; display:grid; gap:10px; }
  .pending-item { background:#161b22; border:1px solid #30363d; border-left:4px solid #3a5a9a; border-radius:8px; padding:10px 12px; }
  .pending-item.is-overdue { border-left-color:#b22222; }
  .pending-head { margin-bottom:4px; }
  .pending-body { font-size:13px; margin:4px 0; white-space:pre-wrap; word-break:break-word; }
  .pending-foot { display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; }
  .overdue { color:#ffc2c2; font-size:11px; font-weight:700; border:1px solid #b22222; border-radius:4px; padding:0 4px; }
  .note { background:#161b22; border:1px dashed #30363d; border-radius:8px; padding:10px 14px; margin-top:18px;
          color:#c9d1d9; font-size:12px; }
  .empty { color:#8b949e; font-style:italic; padding:8px 0; }
  footer { margin-top:22px; color:#6e7681; font-size:11px; border-top:1px solid #21262d; padding-top:10px; }
</style></head>
<body>
  <h1>Fleet board</h1>
  <div class="sub">bot-relay-mcp · read-only projection · auto-refreshes every 30s</div>
  ${bannerHtml(banner)}
  <h2>Agents</h2>
  <div class="grid">${agentsHtml}</div>
  <h2>Pending on a human</h2>
  ${pendingHtml}
  ${note}
  <footer>${footer}</footer>
</body></html>`;
}
