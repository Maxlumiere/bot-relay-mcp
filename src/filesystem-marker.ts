// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.3.0 Part C.4 — filesystem marker fallback for ambient-wake.
 *
 * When `RELAY_FILESYSTEM_MARKERS=1` is set, the daemon touches
 * `~/.bot-relay/marker/<agent_name>.touch` every time a message is
 * delivered to that agent. Clients can `fs.watch()` the marker path
 * to get low-latency "peek" notification without polling.
 *
 * HINT ONLY. The marker is non-authoritative — a missed event is safe
 * because SQLite holds the ground truth. The Phase 4s locked design
 * (memory/project_phase_4s_ambient_wake.md) treats the marker as a
 * wake signal, not a message queue.
 *
 * Cross-platform — macOS / Linux / Windows all support mtime updates
 * + fs.watch on the marker path. NFS / SMB / cloud-sync folders are
 * NOT supported (watch semantics vary wildly); operators on those
 * deployments should fall back to explicit peek polling.
 *
 * Disabled by default for two reasons:
 *   1. Zero-cost when operators don't need the low-latency path.
 *   2. Avoid spamming OS-level watchers that might be counted against
 *      process limits on Linux (default inotify watcher cap ~8192).
 */
import fs from "fs";
import path from "path";
import os from "os";
import { log } from "./logger.js";

function markerDir(): string {
  const base = process.env.RELAY_MARKER_DIR;
  if (base && base.length > 0) return base;
  return path.join(os.homedir(), ".bot-relay", "marker");
}

function isEnabled(): boolean {
  return process.env.RELAY_FILESYSTEM_MARKERS === "1";
}

/**
 * Validate an agent name for use as a marker filename. Mirrors the
 * conservative charset accepted by RegisterAgentSchema + disallows
 * path traversal attempts. Never throws — returns null on invalid so
 * callers skip the write silently.
 */
function sanitizeAgentName(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) return null;
  // Refuse any character that could affect path resolution. Same charset
  // the MCP RegisterAgentSchema validates on the way in — defense-in-depth.
  if (!/^[A-Za-z0-9._-]+$/.test(raw)) return null;
  return raw;
}

/**
 * Touch the marker for `agentName`. Called from `sendMessage`. Cheap:
 * just updates mtime on an existing file or creates an empty one. On
 * any error the function swallows and returns — the marker path is a
 * hint, not a correctness invariant.
 */
export function touchMarker(agentName: string): void {
  if (!isEnabled()) return;
  const safe = sanitizeAgentName(agentName);
  if (!safe) return;
  try {
    const dir = markerDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const file = path.join(dir, safe + ".touch");
    const nowMs = Date.now();
    // Use utimesSync on existing files (cheapest), fall back to open/close
    // for first creation.
    if (fs.existsSync(file)) {
      fs.utimesSync(file, new Date(nowMs), new Date(nowMs));
    } else {
      const fd = fs.openSync(file, "w");
      fs.closeSync(fd);
      // Tighten mode — marker paths don't carry data but still live in
      // the per-agent namespace.
      try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
    }
  } catch (err) {
    log.debug(
      "[marker] touch failed for " + agentName + ": " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Resolve the absolute path a client would watch for a given agent. Exposed
 * for docs + the `/api/wake-agent` dashboard endpoint's audit-log payload.
 */
export function markerPath(agentName: string): string | null {
  const safe = sanitizeAgentName(agentName);
  if (!safe) return null;
  return path.join(markerDir(), safe + ".touch");
}

/** Introspection for tests + operator tooling. */
export function markersEnabled(): boolean {
  return isEnabled();
}
