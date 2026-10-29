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
import { snapshotToFile, openReadOnly, openExportSource, assertWasmSourceReadable, fileSha256, driverOf, configuredDriver, type SqliteDriver, type CompatDatabase } from "./sqlite-compat.js";
// The config path the relay READS (one resolver: config.ts → instance.ts), never a copy of the rule.
import { getConfigPath } from "./config.js";
import { VERSION } from "./version.js";
import { ensureSecureDir, ensureSecureFile, restrictToOwnerWindows } from "./fs-perms.js";
import { serializeConfigForArchive, scanCiphertextKeyIds, classifyWebhookSecrets, manifestKeysOf, assertKeyringCanRead, type ArchivedConfig, type ManifestKey, type WebhookSecretCount } from "./backup-secrets.js";
import { getKeyringInfo } from "./encryption.js";
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
  const d = configuredDriver();
  for (let attempt = 1; ; attempt++) {
    const source = await openExportSource(srcDbPath, d);
    try {
      snapshotToFile(source.db, snapshotDbPath);
      exportReadHook?.();
      if (d !== "wasm") return d;
      assertWasmSourceReadable(srcDbPath);
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

export async function exportRelayState(options: ExportOptions = {}): Promise<ExportResult> {
  assertTarLocatable(); // before anything is opened, created or written
  const srcDbPath = getDbPath();
  if (!fs.existsSync(srcDbPath)) {
    // INV-BACKUP-01: an export never creates its source either.
    throw new Error(`no relay database at ${srcDbPath}; nothing to back up. Start the relay once, or set RELAY_DB_PATH to the database's location.`);
  }

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
  try {
    assertPrivateStaging(stagingDir);
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
    const live = peekDb();
    const probeDriver: SqliteDriver = live ? driverOf(live) : configuredDriver();
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

    // --- Step 4: atomic swap (v2.1 Phase 4q MED #5) ---
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
      skipped_members: skipped,
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

