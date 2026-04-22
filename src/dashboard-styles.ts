// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.1 P3 — dashboard CSS extracted from `src/dashboard.ts`.
 *
 * Served inline via the same HTML response — NOT a separate route — so the
 * dashboard stays a single-file-served artifact (no browser caching
 * concern, no 2nd-GET round-trip on load, no cross-origin surface to
 * widen). The extraction is purely a source-file split for readability:
 * v2.2.1 adds themes + inline-action UI on top of this base sheet, and
 * keeping the CSS + HTML + JS all inline in dashboard.ts pushed the file
 * toward 1000 LOC before this split.
 *
 * Future theme palettes (v2.2.1 P1) live in this same file as additional
 * exported strings — `:root[data-theme="dark"] { ... }` etc. — so every
 * color surface stays in one place.
 */

/** The base stylesheet. Always present; defines the catppuccin default palette via :root. */
export const DASHBOARD_BASE_STYLES = `
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
  .agent-card { position: relative; }
  .agent-card .card-resize {
    position: absolute; right: 2px; bottom: 2px;
    width: 14px; height: 14px;
    cursor: nwse-resize;
    color: var(--muted);
    font-size: 11px; line-height: 14px; text-align: center;
    user-select: none;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .agent-card:hover .card-resize { opacity: 0.7; }
  .agent-card .card-resize:hover { opacity: 1; color: var(--accent); }
  .agent-card .card-reset {
    position: absolute; right: 2px; top: 2px;
    width: 16px; height: 16px;
    background: transparent;
    border: none;
    color: var(--muted);
    font-size: 12px; line-height: 16px;
    cursor: pointer;
    padding: 0;
    border-radius: 3px;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .agent-card[data-resized="1"] .card-reset { opacity: 0.7; }
  .agent-card .card-reset:hover { opacity: 1; background: var(--panel); color: var(--critical); }
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
  .badge-closed { background: rgba(107,114,128,0.12); color: var(--offline); text-decoration: line-through; }
  .badge-abandoned { background: rgba(107,114,128,0.1); color: var(--muted); font-style: italic; }
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
  .focused-form { display: flex; gap: 6px; margin-top: 10px; }
  .focused-form input[type="text"], .focused-form textarea {
    flex: 1;
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 12px;
    font-family: inherit;
  }
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
`;

/**
 * v2.2.1 P1 — theme palettes.
 *
 * Each theme overrides the `:root` CSS custom properties under a
 * `[data-theme="<name>"]` attribute selector. The catppuccin Mocha palette
 * is the default (declared in DASHBOARD_BASE_STYLES :root, no
 * data-theme attribute needed). dark/light are tool-neutral contrasts.
 * `custom` is defined at runtime from the operator's pasted JSON +
 * applied via inline style on the `<html>` element.
 *
 * Token contract (any new theme MUST set all of):
 *   --bg --panel --panel-2 --border --text --muted --accent
 *   --online --stale --offline --critical --high --normal --low
 *
 * Adding a theme = add a block here + add an option to the dropdown in
 * dashboard.ts. No new bundler/build step.
 */
export const DASHBOARD_THEMES = `
  /* catppuccin = default; lives in :root above. data-theme="catppuccin" is a no-op. */

  :root[data-theme="dark"] {
    --bg: #121212;
    --panel: #1c1c1c;
    --panel-2: #262626;
    --border: #363636;
    --text: #e6e6e6;
    --muted: #8a8a8a;
    --accent: #5b8cff;
    --online: #3ecf8e;
    --stale: #ffb454;
    --offline: #606060;
    --critical: #ff5c5c;
    --high: #ff914d;
    --normal: #5b8cff;
    --low: #999999;
  }

  :root[data-theme="light"] {
    --bg: #fafafa;
    --panel: #ffffff;
    --panel-2: #f1f3f5;
    --border: #d8dce1;
    --text: #1d2433;
    --muted: #6b7280;
    --accent: #2563eb;
    --online: #059669;
    --stale: #d97706;
    --offline: #9ca3af;
    --critical: #dc2626;
    --high: #ea580c;
    --normal: #2563eb;
    --low: #6b7280;
  }

  /* custom theme: CSS custom properties are set at runtime by the client
     script via element.style.setProperty('--bg', ...) on <html>. No static
     selector needed — the inline styles on <html> beat :root tokens. */
`;
