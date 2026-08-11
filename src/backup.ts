// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 2c — backup/restore.
 *
 * Two exports:
 *   - exportRelayState(destinationPath?) → tarball of a consistent DB snapshot
 *     (via VACUUM INTO), the optional config.json, and a manifest.json.
 *   - importRelayState(archivePath, { force }) → safety-backup-then-atomic-swap
 *     replacement of the current DB. Refuses schema mismatches and running
 *     daemon unless force=true.
 *
 * Design notes:
 *   - The snapshot + the read-only probes are DRIVER-AWARE (#171): native uses
 *     VACUUM INTO + better-sqlite3; wasm serializes the in-memory image
 *     atomically (sql.js .export()) and opens probe files via sql.js. Both route
 *     through sqlite-compat.snapshotToFile + openReadOnly, so this module holds
 *     NO native dependency of its own. Backup/restore work on BOTH drivers.
 *   - Schema version is a hardcoded constant here; Phase 4c will retrofit it
 *     to a schema_info table.
 *   - Tar is invoked via child_process (no shell, arg-array) — avoids a new
 *     dependency for what is fundamentally a tar operation.
 *   - Safety-backup-before-touch on import is mandatory. If the pre-restore
 *     snapshot fails, the import fails and the current DB is never touched.
 *   - Daemon-running detection is a /health probe with 1s timeout. Best-effort
 *     (won't catch stdio-mode or non-default-port daemons) — documented.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { withDeadline } from "./http-deadline.js";

import { getDbPath, getDb, closeDb, initializeDb, CURRENT_SCHEMA_VERSION, getSchemaVersion } from "./db.js";
import { snapshotToFile, openReadOnly, driverOf, configuredDriver, type SqliteDriver } from "./sqlite-compat.js";
import { VERSION } from "./version.js";
import { ensureSecureDir, ensureSecureFile } from "./fs-perms.js";
import { ERROR_CODES } from "./error-codes.js";

/**
 * v2.1 Phase 4g: Error with a stable machine-readable code attached. The
 * CLI layer can switch on `err.code` for exit-code mapping; non-CLI callers
 * can use it for programmatic branching.
 */
class BackupError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

/**
 * v2.1 Phase 4c.3: re-export the DB-layer constant under the historical
 * `SCHEMA_VERSION` name so existing callers (tests/backup.test.ts, docs)
 * keep working. New code should import `CURRENT_SCHEMA_VERSION` directly
 * from src/db.ts.
 */
export const SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

/** Bump on any breaking change to the tar layout (files, manifest structure). */
export const ARCHIVE_FORMAT_VERSION = 1;

const APPROVED_ROOTS = [
  os.homedir(),
  "/tmp",
  "/private/tmp",
  "/var/folders",
];

function isPathUnderApprovedRoot(resolved: string): boolean {
  return APPROVED_ROOTS.some((root) => {
    const rootResolved = path.resolve(root);
    return resolved === rootResolved || resolved.startsWith(rootResolved + path.sep);
  });
}

function assertSafePath(p: string, label: string): string {
  const resolved = path.resolve(p);
  if (!isPathUnderApprovedRoot(resolved)) {
    throw new Error(
      `${label} resolves to '${resolved}', which is outside approved roots (${APPROVED_ROOTS.join(", ")}).`
    );
  }
  return resolved;
}

function getConfigPath(): string {
  return process.env.RELAY_CONFIG_PATH || path.join(os.homedir(), ".bot-relay", "config.json");
}

function getBackupsDir(): string {
  return path.join(path.dirname(getDbPath()), "backups");
}

function isoTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
}

function runTar(args: string[], cwd: string): void {
  const result = spawnSync("tar", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(`tar ${args.join(" ")} failed (status=${result.status}): ${stderr}`);
  }
}

export interface ExportResult {
  archive_path: string;
  schema_version: number;
  row_counts: Record<string, number>;
  bytes: number;
}

export interface ManifestFile {
  schema_version: number;
  archive_format_version: number;
  created_at: string;
  relay_version: string;
  row_counts: Record<string, number>;
}

interface ExportOptions {
  /** Override the destination path. Defaults to ~/.bot-relay/backups/relay-backup-<iso>.tar.gz */
  destinationPath?: string;
}

/**
 * Produce a consistent snapshot of the current relay DB and config at
 * `destinationPath` (tar.gz). Opens its own read-only connection to the source
 * DB so it is safe to call while the relay daemon is running.
 */
export async function exportRelayState(options: ExportOptions = {}): Promise<ExportResult> {
  await initializeDb();
  const srcDbPath = getDbPath();
  if (!fs.existsSync(srcDbPath)) {
    throw new Error(`Source DB not found at '${srcDbPath}'. Nothing to back up.`);
  }

  const backupsDir = getBackupsDir();
  // v2.1 Phase 4c.4: the backups directory lives inside ~/.bot-relay so it
  // inherits 0700 from the parent, but be explicit here too in case the
  // parent was created by a pre-v2.1 relay with a wider mode.
  ensureSecureDir(backupsDir, 0o700);

  const archivePath = options.destinationPath
    ? assertSafePath(options.destinationPath, "destinationPath")
    : path.join(backupsDir, `relay-backup-${isoTimestamp()}.tar.gz`);

  // Stage the snapshot + manifest + optional config under a unique temp dir
  // (keyed off a random suffix so parallel exports can't collide).
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-export-"));
  try {
    const snapshotDbPath = path.join(stagingDir, "relay.db");

    // #171: driver-aware consistent snapshot. native → VACUUM INTO (online-safe
    // while the daemon writes); wasm → atomic export() bytes (tear-proof — a
    // plain copy of the write-back file could observe a half-written flush). See
    // sqlite-compat.snapshotToFile. Works on BOTH drivers.
    // #171/#190: snapshotToFile branches on the ACTUAL db object; openReadOnly
    // takes the driver EXPLICITLY — driverOf reads it from the live connection.
    snapshotToFile(getDb(), snapshotDbPath);

    // Row counts from the snapshot (not the live DB) so they match the archive.
    const snap = await openReadOnly(snapshotDbPath, driverOf(getDb()));
    const row_counts: Record<string, number> = {};
    const tables = ["agents", "messages", "tasks", "channels", "channel_members", "channel_messages", "webhook_subscriptions", "webhook_delivery_log", "agent_capabilities", "audit_log"];
    for (const t of tables) {
      try {
        const r = snap.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number } | undefined;
        if (r) row_counts[t] = r.c;
      } catch {
        // Table may not exist on older schemas — skip silently.
      }
    }
    snap.close();

    // Optional config.json copy
    const configSrc = getConfigPath();
    if (fs.existsSync(configSrc)) {
      fs.copyFileSync(configSrc, path.join(stagingDir, "config.json"));
    }

    // v2.1 Phase 4c.3: read from schema_info table (DB-actual), not the
    // CURRENT_SCHEMA_VERSION constant. If the DB is older than the code
    // thinks it should be, the manifest reflects the truth.
    const dbSchemaVersion = getSchemaVersion();
    const manifest: ManifestFile = {
      schema_version: dbSchemaVersion,
      archive_format_version: ARCHIVE_FORMAT_VERSION,
      created_at: new Date().toISOString(),
      relay_version: VERSION,
      row_counts,
    };
    fs.writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    // Tar entries relative to the staging dir so the archive has flat files
    // at its root, not a nested temp-dir path.
    const entries = ["relay.db", "manifest.json"];
    if (fs.existsSync(path.join(stagingDir, "config.json"))) entries.push("config.json");
    runTar(["-czf", archivePath, ...entries], stagingDir);

    // v2.1 Phase 4c.4: narrow the archive to 0600 — the tarball contains a
    // full DB snapshot + any sensitive columns (encrypted but still copyable
    // for offline analysis) + the config.json. Same protection as the live DB.
    ensureSecureFile(archivePath, 0o600);

    const bytes = fs.statSync(archivePath).size;
    return {
      archive_path: archivePath,
      schema_version: dbSchemaVersion,
      row_counts,
      bytes,
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

export interface ImportResult {
  restored: true;
  schema_version: number;
  archive_format_version: number;
  previous_backup_path: string;
  row_counts: Record<string, number>;
}

interface ImportOptions {
  /** Bypass schema-version-lower and daemon-running refusals. */
  force?: boolean;
}

/**
 * Probe the configured HTTP port for a running daemon. Returns true if
 * /health responds within 1s. Best-effort — doesn't detect stdio-mode
 * daemons or non-default-port bindings.
 */
async function probeDaemonRunning(): Promise<boolean> {
  const port = parseInt(process.env.RELAY_HTTP_PORT || "3777", 10);
  const host = process.env.RELAY_HTTP_HOST || "127.0.0.1";
  try {
    // NOT A BUG FIX — this never read a body, so the cleared timer had nothing
    // left to bound and it could not hang. Converted for one predicate, one
    // shape: every bounded network call in the CLI now goes through the same
    // owned deadline, so the next person copying this site copies the safe form.
    return await withDeadline(1000, `daemon /health at ${host}:${port}`, async (signal) => {
      const res = await fetch(`http://${host}:${port}/health`, { signal });
      return res.ok;
    });
  } catch {
    return false;
  }
}

/**
 * Restore relay state from an archive. Always safety-backs-up the current
 * DB first; if that safety-backup fails the import aborts and the current
 * DB is left untouched.
 */
export async function importRelayState(archivePath: string, options: ImportOptions = {}): Promise<ImportResult> {
  const resolvedArchive = path.resolve(archivePath);
  if (!fs.existsSync(resolvedArchive)) {
    throw new Error(`Archive not found at '${resolvedArchive}'.`);
  }

  // --- Step 0: daemon check ---
  if (!options.force) {
    if (await probeDaemonRunning()) {
      throw new BackupError(
        ERROR_CODES.DAEMON_RUNNING,
        `Relay daemon appears to be running on http://${process.env.RELAY_HTTP_HOST || "127.0.0.1"}:${process.env.RELAY_HTTP_PORT || "3777"}. Stop it first, or pass { force: true }.`
      );
    }
  }

  // --- Step 1: safety-backup + capture the probe driver WHILE the connection is live ---
  // #190 r3: the Step-5 integrity probe (openReadOnly) takes the driver EXPLICITLY
  // — it cannot infer, because Step 2 closes the live DB before the probe (there is
  // nothing to read then). Capture the driver here from the safety-backup's open
  // handle. A truly-fresh restore has no existing DB (Finding 2: init nothing,
  // manufacture nothing until validation); there the CONFIGURED driver IS the
  // reality the process will instantiate — the one legitimate cold read of the env.
  let previousBackupPath = "";
  let probeDriver: SqliteDriver;
  const srcDbPath = getDbPath();
  if (fs.existsSync(srcDbPath)) {
    const backupsDir = getBackupsDir();
    // v2.1 Phase 4c.4: ensureSecureDir (vs bare mkdirSync) — same pattern as
    // the primary export path; safety backups get 0700 directory treatment.
    ensureSecureDir(backupsDir, 0o700);
    const safetyPath = path.join(backupsDir, `pre-restore-${isoTimestamp()}.tar.gz`);
    const pre = await exportRelayState({ destinationPath: safetyPath }); // inits + opens the live DB
    // exportRelayState already chmod'd the file; no extra call needed here.
    previousBackupPath = pre.archive_path;
    probeDriver = driverOf(getDb()); // read from the LIVE connection, before Step 2 closes it
  } else {
    probeDriver = configuredDriver(); // truly fresh: no connection to read; request == reality
  }

  // --- Step 2: close our DB handle so the swap can rename the file ---
  closeDb();

  // --- Step 3: extract the archive to a staging dir ---
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-import-"));
  try {
    runTar(["-xzf", resolvedArchive, "-C", stagingDir], stagingDir);

    const manifestPath = path.join(stagingDir, "manifest.json");
    const extractedDbPath = path.join(stagingDir, "relay.db");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Archive is missing manifest.json — refusing to import.`);
    }
    if (!fs.existsSync(extractedDbPath) || fs.statSync(extractedDbPath).size === 0) {
      throw new Error(`Archive is missing or empty relay.db — refusing to import.`);
    }

    let manifest: ManifestFile;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch (err) {
      throw new Error(`Archive manifest.json is not valid JSON: ${String(err)}`);
    }
    if (typeof manifest.schema_version !== "number" || typeof manifest.archive_format_version !== "number") {
      throw new Error(`Archive manifest.json is missing required fields (schema_version, archive_format_version).`);
    }

    // --- Step 4: schema-version guard ---
    if (manifest.schema_version > SCHEMA_VERSION) {
      throw new BackupError(
        ERROR_CODES.SCHEMA_MISMATCH,
        `Archive was created at schema_version=${manifest.schema_version} but this relay is at ${SCHEMA_VERSION}. Cannot downgrade schemas. Upgrade this relay before restoring.`
      );
    }
    if (manifest.schema_version < SCHEMA_VERSION && !options.force) {
      throw new BackupError(
        ERROR_CODES.SCHEMA_MISMATCH,
        `Archive was created at schema_version=${manifest.schema_version} but this relay is at ${SCHEMA_VERSION}. Migration on import is out of scope for v2.1; pass { force: true } to restore anyway (data migration is YOUR responsibility).`
      );
    }

    // --- Step 5: integrity check the extracted DB ---
    // #171/#190: driver-aware read-only open of the ARCHIVE, driver passed
    // EXPLICITLY — captured in Step 1 while the connection was live (or the
    // configured driver on a fresh restore). No main-DB init, so a corrupt archive
    // manufactures no state.
    const probe = await openReadOnly(extractedDbPath, probeDriver);
    try {
      const check = probe.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
      if (!check || check.integrity_check !== "ok") {
        throw new Error(`Archive DB failed PRAGMA integrity_check (result=${check?.integrity_check ?? "null"}).`);
      }
    } finally {
      probe.close();
    }

    // --- Step 6: atomic swap (v2.1 Phase 4q MED #5) ---
    // POSIX `rename(2)` atomically replaces the destination without a window
    // where the file is missing. The prior implementation unlinked srcDbPath
    // before the rename, leaving a gap where a concurrent daemon startup or
    // a signal-interrupted restore would see no DB at the expected path.
    //
    // Windows note: Node's `fs.renameSync` on Windows throws EPERM when the
    // destination already exists. Fall back to copy-then-unlink — NOT
    // atomic on Windows, but documented and the best POSIX-API equivalent
    // we can offer without shelling out to MoveFileExW.
    const newPath = srcDbPath + ".new";
    fs.copyFileSync(extractedDbPath, newPath);
    try {
      fs.renameSync(newPath, srcDbPath);
    } catch (err) {
      if (process.platform === "win32") {
        // Windows fallback: non-atomic replace. Documented behavior.
        fs.copyFileSync(newPath, srcDbPath);
        fs.unlinkSync(newPath);
      } else {
        throw err;
      }
    }
    // Remove stale WAL/shm AFTER the rename — they'll be regenerated from
    // the new DB on next open. Running before the rename (the old order)
    // would leave a window where both the old and new WALs could apply to
    // an ambiguous DB file mid-swap.
    for (const suffix of ["-wal", "-shm"]) {
      const p = srcDbPath + suffix;
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    }

    return {
      restored: true,
      schema_version: manifest.schema_version,
      archive_format_version: manifest.archive_format_version,
      previous_backup_path: previousBackupPath,
      row_counts: manifest.row_counts ?? {},
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

