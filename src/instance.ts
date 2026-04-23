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

/**
 * v2.4.0 Codex R3 MED — POSIX-safe shell single-quote escape for
 * printed-remediation strings. The lock function embeds the pidfile
 * path into an operator-facing `rm …` command in its error text.
 * Under `RELAY_HOME=/tmp/bad"$(touch OOPS)"`, a naive `rm "${pidFile}"`
 * would let a shell expand the command substitution if the operator
 * copy-pasted it. Escape strategy:
 *   - Wrap the value in single quotes.
 *   - Inside: replace every `'` with `'\''` (close quote, escaped
 *     literal quote, reopen quote). This is the canonical POSIX-safe
 *     approach and handles $(), backticks, $VAR, newlines, spaces.
 *
 * Exported for tests that pin this behavior (H1.3 hostile-path
 * regression). Keep in sync with any future error-message
 * remediation helpers.
 */
export function shellSingleQuoteEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
 * v2.4.0 Codex HIGH #2 patch — resolve the effective config path for
 * the active instance. Mirrors `resolveInstanceDbPath` exactly so DB
 * + config always live together (no split-brain where DB nests but
 * config stays flat). `RELAY_CONFIG_PATH` wins if set.
 */
export function resolveInstanceConfigPath(): string {
  if (process.env.RELAY_CONFIG_PATH) return process.env.RELAY_CONFIG_PATH;
  const id = resolveActiveInstanceId();
  if (!id) return path.join(botRelayRoot(), "config.json");
  const dir = instanceDir(id);
  if (!dir) return path.join(botRelayRoot(), "config.json");
  return path.join(dir, "config.json");
}

/**
 * Acquire the per-instance lock. Writes a PID file at
 * `<instance_dir>/instance.pid`. Returns a handle with a `release()`
 * callable; fail-closed when another daemon holds the lock for the
 * same instance_id.
 *
 * v2.4.0 Codex HIGH #1 patch (initial): atomic create-or-fail via
 * `openSync(..., 'wx')`. Closed the original "both daemons write"
 * race.
 *
 * v2.4.0 Codex HIGH #1 patch R2 (fail-closed, SECURITY hardening):
 * Codex re-audit reproduced a NEW TOCTOU in the R1 stale-PID reclaim
 * path:
 *   1. Initial pidfile contains PID 999999 (stale / dead).
 *   2. Process A: wx → EEXIST → read pid=999999 → probe ESRCH → about to unlink.
 *   3. Process A pauses (scheduler preemption) just before unlink.
 *   4. Process B: wx → EEXIST → read pid=999999 → probe ESRCH → unlink → wx succeeds → writes its live PID.
 *   5. Process A resumes → unlinks B's LIVE pidfile → wx succeeds → writes its own PID.
 *   6. Both A and B believe they hold the lock. Invariant violated.
 *
 * The auto-reclaim path cannot be made safe without an atomic "test
 * AND replace a specific prior content" primitive, which POSIX fs
 * doesn't provide. Deferred to v2.5+ with a proper primitive (fcntl
 * lock on the open fd, or a directory-based lock) + a regression
 * mirroring the exact Codex schedule.
 *
 * For v2.4.0: **fail-closed on every EEXIST**, regardless of PID
 * liveness. Operator manually removes the stale pidfile after
 * confirming no daemon is alive. "Slow UX, fast ship, provably safe."
 * Cross-platform.
 */
export function acquireInstanceLock(
  instanceId: string,
): { release: () => void; pidFile: string } {
  const dir = instanceDir(instanceId);
  if (!dir) throw new Error("acquireInstanceLock requires non-null instance_id");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pidFile = path.join(dir, "instance.pid");
  const myPid = String(process.pid);

  try {
    const fd = fs.openSync(pidFile, "wx", 0o600);
    try {
      fs.writeSync(fd, myPid);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err; // some other filesystem error — surface it
    }
    // EEXIST — a pidfile is already in place. Read the holder + probe
    // liveness for a BETTER error message, but NEVER auto-reclaim.
    // The R1 unlink-on-stale path has a TOCTOU race Codex reproduced:
    // a concurrent acquirer can slip in between our probe + our
    // unlink, and we'd delete THEIR live pidfile. Fail-closed.
    let holderDesc = "unknown holder";
    let holderAlive: boolean | "unknown" = "unknown";
    try {
      const raw = fs.readFileSync(pidFile, "utf-8").trim();
      const pid = parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0) {
        holderDesc = `PID ${pid}`;
        try {
          process.kill(pid, 0);
          holderAlive = true;
        } catch (probeErr) {
          const code = (probeErr as NodeJS.ErrnoException).code;
          if (code === "ESRCH") holderAlive = false;
          else if (code === "EPERM") holderAlive = "unknown"; // cross-user
        }
      }
    } catch {
      /* unreadable file — leave holderDesc/holderAlive at defaults */
    }
    if (holderAlive === true) {
      throw new Error(
        `instance "${instanceId}" is already running (${holderDesc}). ` +
        `Stop that daemon first, or use a distinct --instance-id.`,
      );
    }
    if (holderAlive === false) {
      const rmCmd = `rm -- ${shellSingleQuoteEscape(pidFile)}`;
      log.warn(
        `[instance] stale pidfile detected for ${instanceId} (${holderDesc} not running). ` +
        `Auto-reclaim is DISABLED in v2.4.0 (security hardening). ` +
        `Run: ${rmCmd} after confirming no daemon is alive, then retry.`,
      );
      throw new Error(
        `instance "${instanceId}" has a stale pidfile (${holderDesc}, not alive). ` +
        `Run \`${rmCmd}\` after confirming no daemon is alive, then retry. ` +
        `Auto-reclaim was removed in v2.4.0 because the unlink step had a TOCTOU ` +
        `race under concurrent acquisition (see docs/multi-instance.md).`,
      );
    }
    // holderAlive === "unknown" — cross-user EPERM or unreadable file.
    // Fail-closed.
    throw new Error(
      `instance "${instanceId}" has a pidfile whose holder liveness cannot be determined ` +
      `(${holderDesc}; cross-user EPERM or unreadable). Refusing to acquire. ` +
      `Investigate + manually clean up.`,
    );
  }

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
