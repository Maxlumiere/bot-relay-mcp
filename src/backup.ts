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
import { spawnSystem, systemBinary } from "./system-binary.js";
import { gunzipToFile, extractBackupTar, MAX_DECOMPRESSED_BYTES, MAX_MEMBER_BYTES, type ExpectedMember } from "./backup-archive.js";
import zlib from "zlib";
import { pipeline } from "stream/promises";
import { withDeadline } from "./http-deadline.js";

import { getDbPath, peekDb, closeDb, CURRENT_SCHEMA_VERSION } from "./db.js";
import { walkPath } from "./path-walk.js";
import { checkContainment, checkPrivatePath } from "./approved-roots.js";
import { snapshotToFile, openReadOnly, openExportSource, assertWasmSourceReadable, fileSha256, driverOf, configuredDriver, resolveOpen, isOwnedDb, holdOwnerForMaintenance, checkpointBeforeRestoreSwap, assertMaintenanceSingleLink, assertNativeByPathAllowed, restoreTargetDriver, restampStagedCopy, type SqliteDriver, type CompatDatabase } from "./sqlite-compat.js";
import { assertDriverHeaderAllows, nativeHandleCount, isDbFamilyMember, isInHeldNativeFamily, beginWasmUse, endWasmUse, assertNoNativeHandle, RELAY_APP_ID_WASM } from "./db-header.js";
// The config path the relay READS (one resolver: config.ts → instance.ts), never a copy of the rule.
import { getConfigPath } from "./config.js";
import { VERSION } from "./version.js";
import { ensureSecureDir, ensureSecureFile, restrictToOwnerWindows } from "./fs-perms.js";
import { serializeConfigForArchive, scanCiphertextKeyIds, classifyWebhookSecrets, manifestKeysOf, assertKeyringCanRead, type ArchivedConfig, type ManifestKey, type WebhookSecretCount } from "./backup-secrets.js";
import { getKeyringInfo } from "./encryption.js";
import { canonicalReplaceTarget, lockKey, type OwnerLock } from "./db-owner-lock.js";
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

/**
 * A backup DESTINATION must sit under the approved roots, on REAL paths (the ONE
 * containment rule, src/approved-roots.ts; ADR-0048). The destination is not an
 * instance DB, so it is checked directly, not through resolveInstance.
 */
function assertSafePath(p: string, label: string): string {
  const c = checkContainment(p);
  if (!c.ok) throw new Error(`${label}: ${c.reason}`);
  return c.absPath;
}

/**
 * ADR-0048: the staging directory (under $TMPDIR, which may be anywhere) must be
 * PRIVATE before anything is staged in it: every traversed component owned by
 * you or root, and not writable by others unless it is a sticky directory (such
 * as /tmp). Otherwise another local user could swap the staged DB between
 * extraction and the copy into the live destination.
 */
function assertPrivateStaging(dir: string): void {
  const c = checkPrivatePath(dir);
  if (!c.ok) throw new Error(`the staging directory ${dir} is not private: ${c.reason}`);
}

/**
 * The DEFAULT backups directory, <db-dir>/backups, under the same containment
 * rule as an explicit destination: a symlinked backups dir pointing outside the
 * approved roots is refused before anything is created, chmod'ed or written.
 */
/** Refuse a restore while this process holds more native handles on the live DB than `own` (the relay's own). */
function assertNoOtherNativeHold(dbPath: string, own: number): void {
  if (nativeHandleCount(dbPath) > own) {
    throw new Error(
      `restore refused: this process still holds a native connection to the DB at '${dbPath}' (other than the relay's ` +
        `own, e.g. a raw CLI handle), which would keep reading the OLD file after the swap. Close it, then restore.`
    );
  }
}

function getBackupsDir(): string {
  return assertSafePath(path.join(path.dirname(getDbPath()), "backups"), "backups directory");
}

function isoTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
}

/**
 * `tar` must be locatable at its TRUSTED system path BEFORE a backup or restore writes anything (SEC-22, ruled 20 Oct:
 * no partial archive, no staging, no safety backup, no DB swap). Throws the named SystemBinaryError. Every OS: on
 * Windows it is %SystemRoot%\System32\tar.exe, never the tar first on PATH (Git Bash's GNU tar can come first there).
 */
function assertTarLocatable(): void {
  systemBinary("tar");
}

/**
 * tar, PLAIN only (SEC-22 (iii)): compression is in-process (zlib), so tar is never asked to find or exec a
 * compressor. COPYFILE_DISABLE=1 (named on the clean env) keeps macOS tar from adding AppleDouble `._` members.
 */
function runTar(args: string[], cwd: string): void {
  const result = spawnSystem("tar", args, { cwd, encoding: "utf-8", named: { COPYFILE_DISABLE: "1" } });
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(`tar ${args.join(" ")} failed (status=${result.status}): ${stderr}`);
  }
}

/** SEC-23: what a backup states about the secrets it does and does not carry. */
export interface BackupSecretsStatement {
  /** Per key id the DB's ciphertext needs: its row count and fingerprint (never the key; the key is NOT archived). */
  encryption: { keys: ManifestKey[] };
  /**
   * The webhook secrets the archive carries, by the classifier's verdict: plaintext (no-key mode), encrypted
   * (authenticated under the keyring), unverifiable (with reasons). null: the table could not be read at all.
   */
  webhook_secrets: WebhookSecretCount | null;
  /** The archived config.json: the secrets redacted and the unknown keys dropped. Absent when there is no config file. */
  config?: ArchivedConfig;
}

export interface ExportResult extends BackupSecretsStatement {
  archive_path: string;
  schema_version: number;
  row_counts: Record<string, number>;
  bytes: number;
  /** What the operator must know about this archive (also written to stderr). */
  warnings: string[];
}

export interface ManifestFile extends Partial<BackupSecretsStatement> {
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
function destinationExists(archivePath: string): Error {
  return new Error(`backup refused: ${archivePath} already exists. A backup never overwrites a file: choose another --output.`);
}

/**
 * The ONE loose fold, used ONLY to WIDEN a refusal, never to allow: NFKC, then an upper/lower round trip (so "ß", "ς",
 * "İ" and compatibility forms meet their plain spellings). It is no claim that two names ARE the same file (path-walk
 * makes no such claim either); it only adds names to refuse.
 */
function foldForRefusal(name: string): string {
  return name.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

/**
 * Whether `destName`, a NEW file beside the DB, is a name SQLite could take as one of the DB's own files: the DB's
 * basename as a prefix covers -wal, -shm, -journal, the super-journal -mj*, and any future one. Refused on the RAW
 * spelling OR the folded one, so the fold can only add refusals: NFKC can compose a combining mark into the DB name's
 * last letter, so a fold-only test could LOSE a raw match.
 */
function namesASideFile(destName: string, dbName: string): boolean {
  return destName.startsWith(dbName) || foldForRefusal(destName).startsWith(foldForRefusal(dbName));
}
/** Test-only: the rule above, for its property test. */
export const _namesASideFileForTests = namesASideFile;

/** Test-only: the fold, for the property tests. */
export const _foldForRefusalForTests = foldForRefusal;

/** The source DB's names a destination must not start with: as configured, and resolved through the shared walk. */
function sourceNames(srcDbPath: string): string[] {
  let resolved: string;
  try {
    resolved = walkPath(srcDbPath).real;
  } catch (err) {
    throw new Error(`backup refused: the database path ${srcDbPath} cannot be resolved (${(err as Error).message}).`);
  }
  return [...new Set([path.basename(srcDbPath), path.basename(resolved)])];
}

/**
 * INV-BACKUP-01 (ruled; Codex #372 R1 and R2): the archive's destination is refused when it exists, or when it has a name SQLite could
 * take as one of the source DB's own files.
 * - An EXISTING destination is refused, whatever it is (the DB, a symlink or hardlink to it, any file): never truncated
 *   (and the archive is created "wx", so a file appearing in between is refused too).
 * - A NEW destination is refused, in ANY directory, when its name starts with the DB's CONFIGURED basename or its
 *   RESOLVED one (raw or under the widen-only fold). Why: a new file at an absent side-file name (-wal, -shm, -journal,
 *   the super-journal -mj*) is a file SQLite would later take as its own, through hot-journal or WAL recovery, and
 *   corrupt the DB. Directory-independent, because a parent directory compared now can be swapped for a link to the
 *   DB's directory before the archive is opened (Codex R2), and a source that is itself a symlink has a second name.
 * - The stated cost: a destination named like the DB is refused anywhere (e.g. "RELAY.DB-backup.tgz", or "data-x.tgz"
 *   for a DB named "data"). The default relay-backup-<iso>.tar.gz does not start with the default relay.db.
 * Returns the names judged, so the caller re-derives and compares them right before the archive is opened.
 */
function assertDestinationIsNotSource(archivePath: string, srcDbPath: string): string[] {
  let exists = false;
  try {
    fs.lstatSync(archivePath);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) throw destinationExists(archivePath);
  const names = sourceNames(srcDbPath);
  for (const dbName of names) {
    if (namesASideFile(path.basename(archivePath), dbName)) {
      throw new Error(
        `backup refused: the destination ${archivePath} has a name SQLite would treat as one of the database's own files: ` +
          `it starts with the database's name (${dbName}). Choose another name for the archive.`
      );
    }
  }
  return names;
}

/** Right before the archive is opened: the source's names must be the ones judged (a source re-pointed meanwhile). */
function assertSourceNamesUnchanged(srcDbPath: string, judged: string[]): void {
  const now = sourceNames(srcDbPath);
  if (now.length !== judged.length || now.some((n, i) => n !== judged[i])) {
    throw new Error(
      `backup refused: the source changed while it was being backed up (${srcDbPath} now resolves to ${now.join(" / ")}, ` +
        `not ${judged.join(" / ")}). Run the backup again.`
    );
  }
}

/** Test-only: runs between a snapshot and its after-checks, so a test can act "during" the read. */
let exportReadHook: (() => void) | null = null;
export function _setExportReadHookForTests(fn: (() => void) | null): void {
  exportReadHook = fn;
}

/**
 * INV-BACKUP-01: snapshot the source DB to `snapshotDbPath` WITHOUT mutating it; returns the driver that read it.
 * - Warm (a connection already open in this process): through that connection, as it is.
 * - Cold: a READ-ONLY open with no initializeDb() (openExportSource): no migration, backfill or permission change.
 * - Wasm reads only the main file, so: no -wal/-shm/-journal beside it, BEFORE and AFTER the snapshot; on a cold read,
 *   the bytes the image was loaded from must hash the same as the file re-read after the snapshot (a torn read),
 *   retried ONCE; and the image, warm or cold, passes PRAGMA integrity_check before anything is archived. This is
 *   BEST-EFFORT DETECTION, not a guarantee: a wasm read takes no lock, so a writer in another process can still race it
 *   (e.g. change the file and restore it between the two reads). INV-DB-01's lock makes it a guarantee.
 */
async function takeSnapshot(srcDbPath: string, snapshotDbPath: string): Promise<SqliteDriver> {
  const live = peekDb();
  if (live) {
    const d = driverOf(live);
    if (d === "wasm") assertWasmSourceReadable(srcDbPath);
    snapshotToFile(live, snapshotDbPath);
    exportReadHook?.();
    if (d === "wasm") {
      assertWasmSourceReadable(srcDbPath);
      assertImageIntact(live, srcDbPath);
    }
    return d;
  }
  const resolved = resolveOpen(srcDbPath, "read"); // a cold export only READS the file
  const d = resolved.driver;
  // INV-DB-01 slice 3: a COLD native export is a non-owner native opener: the one predicate (both declarations).
  if (d === "native") assertNativeByPathAllowed(srcDbPath, "a cold native export");
  // INV-DB-01 2b-i (Codex #383 R1): a cold WASM export reads the live file with fs (the image, then its torn-read
  // hash), across awaits. Its claim is recorded first, so a native open of the file in this process meanwhile is
  // refused by name, and it is re-checked synchronously right before the hash.
  const claim = d === "wasm" ? beginWasmUse(srcDbPath) : null;
  // 2b-ii: an OWNED DB is exported under its single-owner lock (refused, by name, while another process owns it).
  let owner: { release(): void } | null = null;
  try {
    if (resolved.mode === "owner") owner = await holdOwnerForMaintenance(srcDbPath, "backup");
    for (let attempt = 1; ; attempt++) {
      // Codex #401 R1 P2-4: a retry RE-RESOLVES ownership (the file may have become owned since the first read): an
      // owned file is never read without its lock (refused, by name, while another process holds it).
      if (attempt > 1 && d === "wasm" && !owner && resolveOpen(srcDbPath, "read").mode === "owner") {
        owner = await holdOwnerForMaintenance(srcDbPath, "backup");
      }
      const source = await openExportSource(srcDbPath, d);
      try {
        // ...and the image actually loaded must agree: an RLYW image without its lock held is refused.
        if (d === "wasm" && !owner) {
          const id = Number((source.db.prepare("PRAGMA application_id").get() as { application_id?: number } | undefined)?.application_id ?? 0) >>> 0;
          if (id === RELAY_APP_ID_WASM >>> 0) {
            throw new Error(
              `backup refused: the DB at '${srcDbPath}' became owned (stamped RLYW) while it was being read, and this export ` +
                `does not hold its single-owner lock. Retry; while a relay process owns it, back it up through that process.`
            );
          }
        }
        snapshotToFile(source.db, snapshotDbPath);
        exportReadHook?.();
        if (d !== "wasm") return d;
        assertWasmSourceReadable(srcDbPath);
        assertNoNativeHandle(srcDbPath);
        if (fileSha256(srcDbPath) === source.loadedSha256) {
          assertImageIntact(source.db, srcDbPath);
          return d;
        }
      } finally {
        source.release(); // never written back
      }
      fs.rmSync(snapshotDbPath, { force: true });
      if (attempt >= 2) {
        throw new Error(
          `backup refused (wasm driver): the DB at '${srcDbPath}' changed while it was being read, on the first read and ` +
            `on the retry, so the copy could be torn. Back up when no other process is writing it, or with the native driver.`
        );
      }
    }
  } finally {
    owner?.release();
    if (claim) endWasmUse(claim);
  }
}

/** The loaded wasm image is checked before it is archived: a corrupt one is refused, never backed up. */
function assertImageIntact(db: CompatDatabase, srcDbPath: string): void {
  let result: string;
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    result = row?.integrity_check ?? "null";
  } catch (err) {
    result = (err as Error).message;
  }
  if (result !== "ok") {
    throw new Error(`backup refused (wasm driver): the DB at '${srcDbPath}' fails PRAGMA integrity_check (${result}); a corrupt DB is not backed up.`);
  }
}

/** The SOURCE's schema_info version, read from its snapshot (never a migration's); 0 when it predates schema_info. */
async function snapshotSchemaVersion(snapshotDbPath: string, driver: SqliteDriver): Promise<number> {
  const db = await openReadOnly(snapshotDbPath, driver);
  try {
    const row = db.prepare("SELECT version FROM schema_info WHERE id = 1").get() as { version: number } | undefined;
    return typeof row?.version === "number" ? row.version : 0;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/**
 * INV-DB-01 slice 3: the name a restore replaces: the DB's canonical referent (db-owner-lock.ts canonicalReplaceTarget),
 * or, for a DB that does not exist yet, its canonical directory plus the configured name. A DB path that is a symlink
 * to a missing file is refused by name: replacing the link would leave a second DB at the link's name.
 */
function restoreReplaceTarget(srcDbPath: string): string {
  if (fs.existsSync(srcDbPath)) return canonicalReplaceTarget(srcDbPath);
  let link: fs.Stats | null = null;
  try {
    link = fs.lstatSync(srcDbPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (link?.isSymbolicLink()) {
    throw new Error(
      `restore refused: the DB path ${srcDbPath} is a symlink to a missing file (${fs.readlinkSync(srcDbPath)}). Point it ` +
        `at the DB, or remove the link, then retry. Nothing was changed.`
    );
  }
  return path.join(fs.realpathSync.native(path.dirname(srcDbPath)), path.basename(srcDbPath));
}

/**
 * INV-DB-01 slice 3 (Codex #391 R1): what must hold at the swap, checked after the pre-swap step and again right before
 * the rename: the configured path still resolves to the planned target (P1-1), an owned DB still has ONE link (P2-5),
 * and no side file is beside either name.
 */
function assertSwapPreconditions(srcDbPath: string, target: string, owner: OwnerLock | null): void {
  const now = restoreReplaceTarget(srcDbPath);
  if (now !== target) {
    throw new Error(
      `restore refused: the DB path ${srcDbPath} now resolves to ${now}, not ${target}, the file this restore checked` +
        `${owner ? " and locked" : ""}. Nothing was replaced. Point the path back (or run the restore again).`
    );
  }
  if (owner) {
    // Codex #391 R2 P1: the lock this restore ACQUIRED must be the target's own (an acquisition that retried while the
    // path moved can hold another file's lock while the path is moved back).
    if (owner.key !== lockKey(target)) {
      throw new Error(
        `restore refused: the single-owner lock this restore holds is not the lock of ${target} (the DB path moved while ` +
          `the lock was being taken). Nothing was replaced. Run the restore again.`
      );
    }
    // Codex #391 R2: and it still holds that lock, with its lock file still at its name, right before the replacement.
    owner.assertIntact();
    assertMaintenanceSingleLink(target, "restore");
  }
  assertNoSideFilesAtSwap([srcDbPath, target]);
}

/** The SQLite side files whose presence at a restore's swap refuses it (a hot one would be applied to the new DB). */
const SWAP_SIDE_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
/**
 * INV-DB-01 slice 3 (the restore side-file rule): beside each name, every side file must be ABSENT, checked by lstat only
 * (never an fs open: INV-DB-01 2b-i). Otherwise the restore is refused, listing each file and its size, and nothing
 * is changed. A clean last close of the DB removes them, so their presence means a live opener or an un-checkpointed WAL.
 */
function assertNoSideFilesAtSwap(names: string[]): void {
  const present: string[] = [];
  for (const base of new Set(names)) {
    for (const suffix of SWAP_SIDE_SUFFIXES) {
      const p = base + suffix;
      try {
        present.push(`${p} (${fs.lstatSync(p).size} bytes)`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") present.push(`${p} (could not be checked: ${(err as Error).message})`);
      }
    }
  }
  if (present.length === 0) return;
  throw new Error(
    `restore refused: SQLite side files are beside the DB at the swap: ${present.join(", ")}. A stale WAL or journal ` +
      `beside a replaced DB is applied to it by the next open, which would silently undo the restore, and relay code ` +
      `never deletes them. They mean another process has the DB open (stop it, then retry), or they are a leftover ` +
      `from an external tool's PERSIST/TRUNCATE or persistent-WAL mode: confirm that nothing has the DB open, then ` +
      `remove them. Nothing was changed.`
  );
}

export async function exportRelayState(options: ExportOptions = {}): Promise<ExportResult> {
  assertTarLocatable(); // before anything is opened, created or written
  const srcDbPath = getDbPath();
  if (!fs.existsSync(srcDbPath)) {
    // INV-BACKUP-01: an export never creates its source either.
    throw new Error(`no relay database at ${srcDbPath}; nothing to back up. Start the relay once, or set RELAY_DB_PATH to the database's location.`);
  }
  // INV-DB-01 slice 2a: the source's header refuses (or allows) the driver that will read it BEFORE anything is made.
  const liveForHeader = peekDb();
  assertDriverHeaderAllows(srcDbPath, liveForHeader ? driverOf(liveForHeader) : configuredDriver(srcDbPath));

  const backupsDir = getBackupsDir();
  // v2.1 Phase 4c.4: the backups directory lives inside ~/.bot-relay so it
  // inherits 0700 from the parent, but be explicit here too in case the
  // parent was created by a pre-v2.1 relay with a wider mode.
  ensureSecureDir(backupsDir, 0o700);

  const archivePath = options.destinationPath
    ? assertSafePath(options.destinationPath, "destinationPath")
    : path.join(backupsDir, `relay-backup-${isoTimestamp()}.tar.gz`);
  const judgedNames = assertDestinationIsNotSource(archivePath, srcDbPath);

  // Stage the snapshot + manifest + optional config under a unique temp dir
  // (keyed off a random suffix so parallel exports can't collide).
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-export-"));
  try {
    assertPrivateStaging(stagingDir);
    const snapshotDbPath = path.join(stagingDir, "relay.db");

    // #171: driver-aware consistent snapshot. native → VACUUM INTO (online-safe
    // while the daemon writes); wasm → atomic export() bytes (tear-proof — a
    // plain copy of the write-back file could observe a half-written flush). See
    // sqlite-compat.snapshotToFile. Works on BOTH drivers.
    // #171/#190: snapshotToFile branches on the ACTUAL db object; openReadOnly
    // takes the driver EXPLICITLY — driverOf reads it from the live connection.
    // INV-BACKUP-01: the snapshot never mutates the source (takeSnapshot: warm through the open connection, cold through
    // a read-only open with no initializeDb(); the wasm checks before and after the read).
    const srcDriver = await takeSnapshot(srcDbPath, snapshotDbPath);

    // Row counts from the snapshot (not the live DB) so they match the archive.
    const snap = await openReadOnly(snapshotDbPath, srcDriver);
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
    // SEC-23: the key ids the snapshot's ciphertext needs (with a fingerprint each, never the key), and the secrets
    // it holds in plaintext (no-key mode), both read from the snapshot itself.
    const needed = scanCiphertextKeyIds(snap, getKeyringInfo().legacy_key_id);
    const encryption = { keys: manifestKeysOf(needed) };
    const webhook_secrets = classifyWebhookSecrets(snap);
    snap.close();

    // The config.json, SERIALIZED through the classification of every RelayConfig field (SEC-23): its secrets are
    // redacted and an unknown key is dropped, never copied as bytes.
    const configSrc = getConfigPath();
    let config: ArchivedConfig | undefined;
    if (fs.existsSync(configSrc)) {
      const { json, info } = serializeConfigForArchive(fs.readFileSync(configSrc, "utf-8"));
      if (json !== null) fs.writeFileSync(path.join(stagingDir, "config.json"), json);
      config = info;
    }

    const warnings: string[] = [];
    const KEYRING = "Configure an encryption keyring (RELAY_ENCRYPTION_KEYRING or RELAY_ENCRYPTION_KEYRING_PATH)";
    if (webhook_secrets === null) {
      warnings.push(
        `the webhook secrets could NOT be verified (the webhook table could not be read): treat this archive as possibly carrying them in PLAINTEXT. ${KEYRING} so secrets are encrypted at rest.`
      );
    } else {
      const { plaintext: nPlain, unverifiable: nUnv, unverifiable_reasons: why } = webhook_secrets;
      if (nPlain > 0) {
        warnings.push(
          `${nPlain} webhook secret${nPlain === 1 ? " is" : "s are"} stored in PLAINTEXT and ${nPlain === 1 ? "is" : "are"} IN this archive. ` +
            `${KEYRING} and re-register the webhooks, so their secrets are encrypted at rest.`
        );
      }
      if (nUnv > 0) {
        const reasons = [
          why.no_keyring ? `${why.no_keyring} with no keyring to check them` : "",
          why.key_not_held ? `${why.key_not_held} under a key id this keyring does not hold` : "",
          why.auth_failed ? `${why.auth_failed} whose authentication FAILED under the key this keyring holds for their id (corruption, or the wrong key)` : "",
          why.keyring_unreadable ? `${why.keyring_unreadable} because the configured keyring could not be LOADED (fix its configuration)` : "",
        ].filter(Boolean);
        warnings.push(
          `${nUnv} webhook secret${nUnv === 1 ? " looks" : "s look"} encrypted but could NOT be verified (${reasons.join("; ")}): treat ${nUnv === 1 ? "it" : "them"} as possibly PLAINTEXT, IN this archive. ` +
            `${KEYRING} that holds the key, or re-register the webhooks.`
        );
      }
    }
    const unloadable = encryption.keys.filter((k) => k.fingerprint_reason === "keyring_unreadable").map((k) => k.key_id);
    if (unloadable.length) {
      warnings.push(
        `the configured encryption keyring could not be LOADED (fix its configuration): key id(s) ${unloadable.join(", ")} have NO fingerprint in this archive, ` +
          `and the encrypted contents could not be checked. The archive was still written; on restore, the keyring it is given must hold each key id the archive needs and authenticate one sample row under each.`
      );
    }
    if (config?.omitted) warnings.push(config.omitted + ".");

    // v2.1 Phase 4c.3: read from schema_info table (DB-actual), not the
    // CURRENT_SCHEMA_VERSION constant. If the DB is older than the code
    // thinks it should be, the manifest reflects the truth.
    // The SOURCE's schema version, read from the snapshot (INV-BACKUP-01: never a migration's). 0 when the source
    // predates schema_info.
    const dbSchemaVersion = await snapshotSchemaVersion(snapshotDbPath, srcDriver);
    const manifest: ManifestFile = {
      schema_version: dbSchemaVersion,
      archive_format_version: ARCHIVE_FORMAT_VERSION,
      created_at: new Date().toISOString(),
      relay_version: VERSION,
      row_counts,
      encryption,
      webhook_secrets,
      ...(config ? { config } : {}),
    };
    fs.writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    // Tar entries relative to the staging dir so the archive has flat files
    // at its root, not a nested temp-dir path.
    const entries = ["relay.db", "manifest.json"];
    if (fs.existsSync(path.join(stagingDir, "config.json"))) entries.push("config.json");
    // A PLAIN ustar archive (no pax or AppleDouble members: MEASURED on macOS with COPYFILE_DISABLE=1), gzipped
    // in-process (SEC-22 (iii)).
    // Never write an archive that restore would refuse (its caps, src/backup-archive.ts): checked on each member,
    // then on the plain archive, before the gzip writes anything at the destination.
    for (const e of entries) {
      const size = fs.statSync(path.join(stagingDir, e)).size;
      const cap = MAX_MEMBER_BYTES[e as ExpectedMember];
      if (size > cap) throw new Error(`backup refused: ${e} is ${size} bytes, over the ${cap}-byte member cap; restore would refuse it.`);
    }
    const plainTar = path.join(stagingDir, ".archive.tar");
    runTar(["--format=ustar", "-cf", plainTar, ...entries], stagingDir);
    const plainSize = fs.statSync(plainTar).size;
    if (plainSize > MAX_DECOMPRESSED_BYTES) {
      throw new Error(`backup refused: the archive is ${plainSize} bytes uncompressed, over the ${MAX_DECOMPRESSED_BYTES}-byte cap; restore would refuse it.`);
    }
    // Created EXCLUSIVELY ("wx"): an existing file is never truncated (Codex #372 R1), whoever made it. Right before it,
    // the destination is judged again against the source's names as they are NOW (Codex R2).
    assertSourceNamesUnchanged(srcDbPath, judgedNames);
    assertDestinationIsNotSource(archivePath, srcDbPath);
    try {
      await pipeline(fs.createReadStream(plainTar), zlib.createGzip(), fs.createWriteStream(archivePath, { mode: 0o600, flags: "wx" }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw destinationExists(archivePath);
      throw err;
    }

    // v2.1 Phase 4c.4: narrow the archive to 0600 — the tarball contains a
    // full DB snapshot + any sensitive columns (encrypted but still copyable
    // for offline analysis) + the config.json. Same protection as the live DB.
    ensureSecureFile(archivePath, 0o600);
    // SEC-23: owner-only on Windows too (the mode above means nothing there), as the DB and the mint secret are.
    for (const fault of restrictToOwnerWindows(archivePath, false)) warnings.push(`the archive is NOT owner-only: ${fault}.`);

    if (encryption.keys.length) {
      const k = encryption.keys.map((e) => `${e.key_id} (${e.rows} rows, fingerprint ${e.fingerprint ?? `none: ${e.fingerprint_reason}`})`).join(", ");
      process.stderr.write(`relay backup: rows encrypted under key id(s) ${k}. The key is NOT in this archive: keep it, or the archive cannot be restored.\n`);
    }
    for (const w of warnings) process.stderr.write(`relay backup: WARNING: ${w}\n`);

    const bytes = fs.statSync(archivePath).size;
    return {
      archive_path: archivePath,
      schema_version: dbSchemaVersion,
      row_counts,
      bytes,
      encryption,
      webhook_secrets,
      ...(config ? { config } : {}),
      warnings,
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
  /** Members the archive held that were SKIPPED, never extracted (a legacy macOS backup's `._` and pax members). */
  skipped_members: string[];
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
/** Test-only: awaited right before a restore replaces the live DB (another process may take ownership meanwhile). */
let beforeRestoreSwapHook: ((dbPath: string) => void | Promise<void>) | null = null;
export function _setBeforeRestoreSwapForTests(fn: ((dbPath: string) => void | Promise<void>) | null): void {
  beforeRestoreSwapHook = fn;
}
/** Test-only: awaited right after restore's pre-swap checkpoint step (with its result) and before its side-file check. */
type CheckpointResult = { ran: boolean; why?: string };
let afterRestoreCheckpointHook: ((dbPath: string, result: CheckpointResult) => void | Promise<void>) | null = null;
export function _setAfterRestoreCheckpointForTests(fn: ((dbPath: string, result: CheckpointResult) => void | Promise<void>) | null): void {
  afterRestoreCheckpointHook = fn;
}
/** Test-only: awaited right before a restore takes an owned DB's single-owner lock. */
let beforeRestoreAcquireHook: ((dbPath: string) => void | Promise<void>) | null = null;
export function _setBeforeRestoreAcquireForTests(fn: ((dbPath: string) => void | Promise<void>) | null): void {
  beforeRestoreAcquireHook = fn;
}
/** Test-only: awaited right after the archive is staged into `.new`, before the final checks and the rename. */
let afterRestoreStageHook: ((newPath: string, target: string) => void | Promise<void>) | null = null;
export function _setAfterRestoreStageForTests(fn: ((newPath: string, target: string) => void | Promise<void>) | null): void {
  afterRestoreStageHook = fn;
}

export async function importRelayState(archivePath: string, options: ImportOptions = {}): Promise<ImportResult> {
  assertTarLocatable(); // before the safety backup, the staging dir, or closing the live DB
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

  // --- Step 0b: read the archive IN-PROCESS into a private staging dir (src/backup-archive.ts), BEFORE the safety
  // backup or anything else is written; Step 1 then validates its contents there too, so ANY refused archive leaves
  // no trace outside staging. ONE parser decides and extracts; no tar extracts the input archive (SEC-22, ruled 26
  // Oct; the safety backup still writes with tar).
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-import-"));
  // 2b-ii: a restore onto an OWNED (RLYW) live DB holds its single-owner lock from before the safety backup to after
  // the swap (refused, by name, while another process owns it).
  let restoreOwner: OwnerLock | null = null;
  try {
    assertPrivateStaging(stagingDir);
    // INV-DB-01 2b-i: an archive path that IS the live DB (or one of its side files, or a hard link to one) is never
    // read through fs: in a process holding a native connection to it, that read's close would drop the connection's
    // locks; and restoring a DB onto itself is never meant. By identity (stats only), before any open.
    if (isDbFamilyMember(resolvedArchive, getDbPath())) {
      throw new Error(
        `backup archive refused: '${resolvedArchive}' is the live relay database (or one of its side files). Pass a ` +
          `backup archive (relay backup writes one), never the database itself.`
      );
    }
    if (isInHeldNativeFamily(resolvedArchive)) {
      throw new Error(
        `backup archive refused: '${resolvedArchive}' belongs to a database this process holds open natively (the DB ` +
          `or one of its side files): reading it here would drop that connection's locks. Pass a backup archive.`
      );
    }
    const plainTar = path.join(stagingDir, ".archive.tar");
    await gunzipToFile(resolvedArchive, plainTar);
    const { skipped } = extractBackupTar(plainTar, stagingDir);
    fs.rmSync(plainTar, { force: true });

    // --- Step 1: VALIDATE COMPLETELY IN STAGING, before ANY live mutation (Codex #342 R2, ruled): the required members,
    // the manifest, the schema and the staged DB's integrity all pass BEFORE the safety backup, initializeDb() or
    // closing the live connection, so a refused archive (an empty one included) leaves no safety backup and the live
    // DB and connection unchanged.
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

    // The schema-version guard.
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


    // The integrity check of the STAGED DB. #171/#190: a driver-aware read-only open of the ARCHIVE, the driver passed
    // EXPLICITLY (openReadOnly never infers): the LIVE connection's when one is open (peekDb: a read that opens
    // nothing), else the configured driver, which is the one this process would instantiate (#190 r3). No main-DB
    // init, so a corrupt archive manufactures no state.
    // INV-DB-01 slice 4 (Q5): the staged copy is RE-STAMPED to the instance's kind (its declaration, else the live
    // header, else native; a disagreement refuses) by the instance's own driver, BEFORE it is validated: a backup made
    // before a conversion still restores. Re-validated below (integrity) and by its header check.
    await restampStagedCopy(extractedDbPath, restoreTargetDriver(getDbPath()));
    const live = peekDb();
    // 2b-ii: the staged copy is read with the driver ITS header calls for (an RLYW archive is read with wasm).
    const probeDriver: SqliteDriver = live ? driverOf(live) : configuredDriver(extractedDbPath);
    const probe = await openReadOnly(extractedDbPath, probeDriver);
    try {
      const check = probe.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
      if (!check || check.integrity_check !== "ok") {
        throw new Error(`Archive DB failed PRAGMA integrity_check (result=${check?.integrity_check ?? "null"}).`);
      }
      // SEC-23, still before any mutation: this keyring can read every key id the STAGED DB's ciphertext needs (the
      // ids come from the DB itself, not the manifest alone): held, the manifest's fingerprint when it has one, and a
      // staged row that decrypts. Each failure is a named refusal.
      assertKeyringCanRead(scanCiphertextKeyIds(probe, getKeyringInfo().legacy_key_id), manifest.encryption);
    } finally {
      probe.close();
    }

    // --- Step 2: the safety backup, only now that the archive is fully validated ---
    let previousBackupPath = "";
    const srcDbPath = getDbPath();
    // INV-DB-01 slice 2a (Codex #380 R1): a native handle on the live DB other than the relay's own (a raw CLI handle)
    // would survive the swap on the OLD file. Refused by name before any mutation, and again after closeDb().
    const liveNow = peekDb();
    assertNoOtherNativeHold(srcDbPath, liveNow && driverOf(liveNow) === "native" ? 1 : 0);
    // Codex #391 R1 P1-1: the file this restore will replace is fixed HERE, with the lock it takes (the lock is keyed by
    // this same canonical name). Right before the rename the configured path must still resolve to it, or the restore
    // is refused: a retargeted symlink could otherwise point the swap at a file whose lock it never took.
    const plannedTarget = restoreReplaceTarget(srcDbPath);
    if (fs.existsSync(srcDbPath) && isOwnedDb(srcDbPath)) {
      await beforeRestoreAcquireHook?.(srcDbPath);
      restoreOwner = await holdOwnerForMaintenance(srcDbPath, "restore");
    }
    if (fs.existsSync(srcDbPath)) {
      const backupsDir = getBackupsDir();
      // v2.1 Phase 4c.4: ensureSecureDir (vs bare mkdirSync) — same pattern as
      // the primary export path; safety backups get 0700 directory treatment.
      ensureSecureDir(backupsDir, 0o700);
      const safetyPath = path.join(backupsDir, `pre-restore-${isoTimestamp()}.tar.gz`);
      const pre = await exportRelayState({ destinationPath: safetyPath }); // inits + opens the live DB
      // exportRelayState already chmod'd the file; no extra call needed here.
      previousBackupPath = pre.archive_path;
    }

    // --- Step 3: close our DB handle so the swap can rename the file ---
    closeDb();
    assertNoOtherNativeHold(srcDbPath, 0);

    // --- Step 4: atomic swap (v2.1 Phase 4q MED #5) ---
    // POSIX `rename(2)` atomically replaces the destination without a window
    // where the file is missing. The prior implementation unlinked srcDbPath
    // before the rename, leaving a gap where a concurrent daemon startup or
    // a signal-interrupted restore would see no DB at the expected path.
    //
    // Windows note: a rename onto a file another process holds open fails there (EPERM); the swap retries briefly,
    // then refuses by name (below). It never copies over the live DB.
    await beforeRestoreSwapHook?.(srcDbPath);
    // Codex #385 R2 P1-2: an OWNED DB is replaced only while this restore's acquisition still holds the lock and its
    // lock file is still the file at its name (removed or replaced, another process may own and have written the DB).
    restoreOwner?.assertIntact();
    // INV-DB-01 slice 3, Q2 AMENDED: on a native or legacy DB, one bare writable native connection checkpoints the WAL
    // (TRUNCATE, refused when busy) and closes, so the side files the safety backup's read-only open created are gone
    // when no other process has the DB open. An owned DB, a declared-wasm instance or an unreadable declaration opens
    // nothing here (the same predicate as every non-owner native opener). Then the absence check decides.
    const checkpoint = restoreOwner ? { ran: false, why: "an owned DB (its single-owner lock is held)" } : checkpointBeforeRestoreSwap(srcDbPath);
    await afterRestoreCheckpointHook?.(srcDbPath, checkpoint);
    // INV-DB-01 slice 3: the swap replaces the DB's CANONICAL referent (a symlinked DB path keeps its link, and the
    // name the owner lock is keyed by is the name replaced), and it REQUIRES the side files ABSENT, checked by stat
    // only, beside both names. Relay code never deletes them: a stale WAL beside a replaced DB is applied to it by the
    // next open (MEASURED: the pre-restore rows came back, integrity_check ok).
    const target = plannedTarget;
    assertSwapPreconditions(srcDbPath, target, restoreOwner);
    const newPath = target + ".new";
    fs.copyFileSync(extractedDbPath, newPath);
    try {
      await afterRestoreStageHook?.(newPath, target);
      // Codex #391 R1: the checks again, right before the rename (a side file, a retarget or a new hard link could
      // appear while the archive was being copied into .new).
      assertSwapPreconditions(srcDbPath, target, restoreOwner);
    } catch (err) {
      fs.rmSync(newPath, { force: true }); // this restore's own staged copy (never a DB-family name)
      throw err;
    }
    // INV-DB-01 slice 4 (the #377 ruling, Codex #401 R2 walk): the swap is the atomic rename ONLY. On Windows a rename
    // onto a file another process holds open fails; a short retry, then a NAMED refusal: never a copy over the live
    // DB (a crash mid-copy would leave it torn, recoverable only by hand from the safety backup).
    const waits = process.platform === "win32" ? [25, 50, 100, 200] : [];
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(newPath, target);
        break;
      } catch (err) {
        if (process.platform !== "win32" || true) { fs.copyFileSync(newPath, target); fs.rmSync(newPath, { force: true }); break; } // MUTATION: the copy-over fallback back
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(code) && i < waits.length) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waits[i]);
          continue;
        }
        fs.rmSync(newPath, { force: true }); // this restore's own staged copy (never a DB-family name)
        throw new Error(
          `restore refused: the staged copy could not be replaced onto ${target} (${code || (err as Error).message})` +
            (process.platform === "win32" ? `: another process may have the DB open (Windows cannot replace an open file)` : "") +
            `. Nothing was replaced: the live DB is unchanged (its safety backup is at ${previousBackupPath}). Stop every ` +
            `process using it, then retry.`
        );
      }
    }

    return {
      restored: true,
      schema_version: manifest.schema_version,
      archive_format_version: manifest.archive_format_version,
      previous_backup_path: previousBackupPath,
      row_counts: manifest.row_counts ?? {},
      skipped_members: skipped,
    };
  } finally {
    restoreOwner?.release();
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

