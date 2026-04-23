// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.0 Part E — per-instance local isolation.
 *
 * Pre-v2.4.0 the relay was implicitly single-instance: one
 * `~/.bot-relay/` directory per machine. v2.4.0 adds a per-instance
 * model so an operator can run several coexisting daemons on the
 * SAME machine (personal, work, family) without collisions.
 *
 * Per Codex federation design memo (2026-04-19): isolation unit is
 * `instance_id` (NOT per-user). One OS user may want multiple relay
 * instances; isolation is an operator-level choice, not an OS-level
 * one. File layout in multi-instance mode:
 *
 *   ~/.bot-relay/
 *     instances/
 *       <instance_id>/
 *         instance.json      metadata
 *         relay.db           per-instance DB
 *         config.json        per-instance config
 *         backups/           per-instance backups
 *         instance.pid       lock + running-daemon PID
 *
 * Single-instance mode (backward-compat default): existing operators
 * with `~/.bot-relay/relay.db` keep using the flat layout. No data
 * migration, no config change. Multi-instance mode is strictly
 * opt-in via `RELAY_INSTANCE_ID` env var OR `relay init --instance-id`.
 *
 * v2.4.0 supports COEXISTENCE only, not cross-instance messaging.
 * Cross-instance routing is v2.5+ federation territory.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { log } from "./logger.js";

export interface InstanceMetadata {
  instance_id: string;
  created_at: string;
  hostname: string;
  daemon_version_first_seen: string;
  label: string | null;
}

function botRelayRoot(): string {
  // RELAY_HOME env var is a test-friendly override that lets a suite
  // point the whole per-instance namespace at a tmp dir without
  // touching the operator's real $HOME. Production operators leave
  // it unset and get ~/.bot-relay/.
  if (process.env.RELAY_HOME) return process.env.RELAY_HOME;
  return path.join(os.homedir(), ".bot-relay");
}

function instancesRoot(): string {
  return path.join(botRelayRoot(), "instances");
}

/**
 * Returns true when the caller has explicitly opted into multi-instance
 * mode. Any of:
 *   - `RELAY_INSTANCE_ID` env var set
 *   - `~/.bot-relay/active-instance` symlink exists (set by `relay use-instance`)
 *   - `~/.bot-relay/instances/` has ≥ 1 subdir
 *
 * Absent all three, we default to single-instance legacy mode.
 */
export function isMultiInstanceMode(): boolean {
  if (process.env.RELAY_INSTANCE_ID) return true;
  try {
    const activeLink = path.join(botRelayRoot(), "active-instance");
    // lstatSync doesn't follow symlinks — handles dangling-link case
    // where the symlink target is a bare instance_id (not a real path).
    try {
      fs.lstatSync(activeLink);
      return true;
    } catch { /* ENOENT — link not present */ }
  } catch { /* ignore */ }
  try {
    if (fs.existsSync(instancesRoot())) {
      const ents = fs.readdirSync(instancesRoot(), { withFileTypes: true });
      if (ents.some((e) => e.isDirectory())) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Resolve the active instance id. Priority:
 *   1. `RELAY_INSTANCE_ID` env var (explicit per-invocation override)
 *   2. `~/.bot-relay/active-instance` symlink target (set by `relay use-instance`)
 *   3. null (single-instance legacy mode)
 */
export function resolveActiveInstanceId(): string | null {
  const env = process.env.RELAY_INSTANCE_ID;
  if (env && env.length > 0) return env;
  try {
    const activeLink = path.join(botRelayRoot(), "active-instance");
    // Use lstatSync (doesn't follow symlinks) so a symlink whose
    // target is a bare instance_id string still registers as "exists".
    let kind: "symlink" | "file" | null = null;
    try {
      const st = fs.lstatSync(activeLink);
      if (st.isSymbolicLink()) kind = "symlink";
      else if (st.isFile()) kind = "file";
    } catch {
      return null;
    }
    if (kind === "symlink") {
      const target = fs.readlinkSync(activeLink);
      return path.basename(target);
    }
    if (kind === "file") {
      const body = fs.readFileSync(activeLink, "utf-8").trim();
      if (body.length > 0) return body;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Compute the per-instance directory. Returns null in single-instance
 * mode so callers can short-circuit to the legacy flat layout.
 */
export function instanceDir(instanceId: string | null): string | null {
  if (!instanceId) return null;
  // instance_id is operator-supplied; sanitize to prevent traversal.
  if (!/^[A-Za-z0-9._-]+$/.test(instanceId)) {
    throw new Error(
      `invalid instance_id "${instanceId}" — must match /^[A-Za-z0-9._-]+$/`,
    );
  }
  return path.join(instancesRoot(), instanceId);
}

/**
 * Generate a fresh instance_id. UUID, not $USER. Caller persists it
 * via `createInstance`.
 */
export function generateInstanceId(): string {
  return randomUUID();
}

/**
 * Create a per-instance directory + write instance.json metadata.
 * Idempotent: re-creating an existing instance refreshes the
 * `daemon_version_first_seen` but leaves `created_at` intact.
 */
export function createInstance(
  instanceId: string,
  version: string,
  label?: string | null,
): InstanceMetadata {
  const dir = instanceDir(instanceId);
  if (!dir) throw new Error("createInstance requires non-null instance_id");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const metaPath = path.join(dir, "instance.json");
  let existing: InstanceMetadata | null = null;
  try {
    if (fs.existsSync(metaPath)) {
      existing = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as InstanceMetadata;
    }
  } catch { /* treat corrupt as absent */ }
  const now = new Date().toISOString();
  const meta: InstanceMetadata = {
    instance_id: instanceId,
    created_at: existing?.created_at ?? now,
    hostname: existing?.hostname ?? os.hostname(),
    daemon_version_first_seen: existing?.daemon_version_first_seen ?? version,
    label: label ?? existing?.label ?? null,
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });
  return meta;
}

/** Read an instance's metadata. Returns null on missing / corrupt. */
export function readInstance(instanceId: string): InstanceMetadata | null {
  const dir = instanceDir(instanceId);
  if (!dir) return null;
  try {
    const metaPath = path.join(dir, "instance.json");
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(fs.readFileSync(metaPath, "utf-8")) as InstanceMetadata;
  } catch {
    return null;
  }
}

/** List all instances. Empty array in single-instance mode. */
export function listInstances(): InstanceMetadata[] {
  const root = instancesRoot();
  try {
    if (!fs.existsSync(root)) return [];
    const ents = fs.readdirSync(root, { withFileTypes: true });
    const out: InstanceMetadata[] = [];
    for (const ent of ents) {
      if (!ent.isDirectory()) continue;
      const meta = readInstance(ent.name);
      if (meta) out.push(meta);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolve the effective DB path for the active instance. Falls back
 * to the legacy `~/.bot-relay/relay.db` in single-instance mode.
 * `RELAY_DB_PATH` always wins if set (explicit operator override).
 */
export function resolveInstanceDbPath(): string {
  if (process.env.RELAY_DB_PATH) return process.env.RELAY_DB_PATH;
  const id = resolveActiveInstanceId();
  if (!id) return path.join(botRelayRoot(), "relay.db");
  const dir = instanceDir(id);
  if (!dir) return path.join(botRelayRoot(), "relay.db");
  return path.join(dir, "relay.db");
}

/**
 * Acquire the per-instance lock. Writes a PID file at
 * `<instance_dir>/instance.pid`. Returns a handle with a `release()`
 * callable; fail-closed when another daemon holds the lock for the
 * same instance_id.
 *
 * Lock semantics: if the PID file exists + the listed PID is alive
 * (via `kill -0`), acquire fails. Stale PID files (process dead)
 * are reclaimed.
 */
export function acquireInstanceLock(
  instanceId: string,
): { release: () => void; pidFile: string } {
  const dir = instanceDir(instanceId);
  if (!dir) throw new Error("acquireInstanceLock requires non-null instance_id");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pidFile = path.join(dir, "instance.pid");
  if (fs.existsSync(pidFile)) {
    try {
      const raw = fs.readFileSync(pidFile, "utf-8").trim();
      const pid = parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        // Check if the process is alive.
        try {
          process.kill(pid, 0);
          throw new Error(
            `instance "${instanceId}" is already running (PID ${pid}). ` +
            `Stop that daemon first, or use a distinct --instance-id.`,
          );
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") {
            // Stale PID file — reclaim.
            log.warn(
              `[instance] reclaiming stale PID file for ${instanceId} (PID ${pid} dead)`,
            );
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      if ((err as Error).message?.includes("is already running")) throw err;
      // Parse error or other read failure → treat as reclaimable.
    }
  }
  fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
  const release = () => {
    try {
      const raw = fs.readFileSync(pidFile, "utf-8").trim();
      if (parseInt(raw, 10) === process.pid) fs.unlinkSync(pidFile);
    } catch { /* best-effort */ }
  };
  return { release, pidFile };
}

/**
 * Set `~/.bot-relay/active-instance` to point at `instanceId`. Used by
 * `relay use-instance <id>` for kubectl-style context switching.
 * Overwrites any existing symlink. Validates that the instance
 * actually exists first.
 */
export function setActiveInstance(instanceId: string): void {
  if (!readInstance(instanceId)) {
    throw new Error(
      `instance "${instanceId}" not found. Run \`relay init --instance-id=${instanceId}\` first.`,
    );
  }
  const linkPath = path.join(botRelayRoot(), "active-instance");
  try {
    if (fs.existsSync(linkPath) || fs.lstatSync(linkPath)) fs.unlinkSync(linkPath);
  } catch { /* lstatSync throws on ENOENT — ignore */ }
  // Use a regular file with the id as content on platforms where
  // symlink creation is restricted (Windows non-admin). Keeps
  // resolveActiveInstanceId portable — it reads via readlinkSync first
  // and falls back to readFileSync.
  try {
    fs.symlinkSync(instanceId, linkPath);
  } catch {
    fs.writeFileSync(linkPath, instanceId, { mode: 0o600 });
  }
}
