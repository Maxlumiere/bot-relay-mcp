// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import os from "os";
import type {
  AgentRecord,
  AgentWithStatus,
  MessageRecord,
  TaskRecord,
  TaskStatus,
  TaskAction,
  WebhookRecord,
  WebhookDeliveryRecord,
} from "./types.js";
import { VALID_TRANSITIONS, ACTION_TO_STATUS } from "./types.js";
import { generateToken, hashToken } from "./auth.js";
import type { AuthStateInput } from "./auth.js";
import { encryptContent, decryptContent } from "./encryption.js";
import {
  type CompatDatabase,
  initializeDb as initDriver,
  getInitializedDb,
  closeInitializedDb,
} from "./sqlite-compat.js";
import { log } from "./logger.js";
import { ensureSecureDir, ensureSecureFile } from "./fs-perms.js";

const DEFAULT_DB_DIR = path.join(os.homedir(), ".bot-relay");
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, "relay.db");

// Path traversal protection (v1.6.1): RELAY_DB_PATH must resolve under an
// approved root. Mirrors the check-relay.sh hook logic.
const APPROVED_ROOTS = [
  os.homedir(),
  "/tmp",
  "/private/tmp", // macOS real path for /tmp
  "/var/folders", // macOS test tmpdirs
];

function isPathUnderApprovedRoot(resolved: string): boolean {
  return APPROVED_ROOTS.some((root) => {
    const rootResolved = path.resolve(root);
    return resolved === rootResolved || resolved.startsWith(rootResolved + path.sep);
  });
}

export function getDbPath(): string {
  const raw = process.env.RELAY_DB_PATH || DEFAULT_DB_PATH;
  const resolved = path.resolve(raw);
  if (!isPathUnderApprovedRoot(resolved)) {
    throw new Error(
      `RELAY_DB_PATH resolves to '${resolved}', which is outside approved roots (${APPROVED_ROOTS.join(", ")}). ` +
      `Set a path under your home directory or a temp directory.`
    );
  }
  return resolved;
}

function now(): string {
  return new Date().toISOString();
}

function computeStatus(lastSeen: string): "online" | "stale" | "offline" {
  const diff = Date.now() - new Date(lastSeen).getTime();
  const minutes = diff / 60_000;
  if (minutes < 10) return "online";
  if (minutes < 60) return "stale";
  return "offline";
}

/**
 * v2.1.3 (I6) — agent_status auto-transition thresholds. Kept in sync with
 * docs/agent-status-lifecycle.md. Relay overrides a stored active-state
 * (idle/working/blocked/waiting_user) based on last_seen age.
 */
const AGENT_STATUS_STALE_MINUTES = 5;
const AGENT_STATUS_OFFLINE_MINUTES = 30;

const LEGACY_STATUS_MAP: Record<string, string> = {
  online: "idle",
  busy: "working",
  away: "blocked",
};

function normalizeStoredAgentStatus(raw: string | null | undefined): string {
  const lower = (raw ?? "idle").toLowerCase();
  return LEGACY_STATUS_MAP[lower] ?? lower;
}

/**
 * v2.1.3 (I6) — derive the observed agent_status from the stored declared
 * state + last_seen age. Active declared states (idle/working/blocked/
 * waiting_user) get overridden to 'stale' after 5 min and 'offline' after
 * 30 min of silence. Declared 'offline' is always offline. 'stale' (rare —
 * only via direct DB write) upgrades to 'offline' at the 30-min threshold.
 */
function deriveAgentStatus(
  storedRaw: string | null | undefined,
  lastSeen: string
): AgentWithStatus["agent_status"] {
  const stored = normalizeStoredAgentStatus(storedRaw);
  const minutes = (Date.now() - new Date(lastSeen).getTime()) / 60_000;

  if (stored === "offline") return "offline";
  if (minutes >= AGENT_STATUS_OFFLINE_MINUTES) return "offline";
  if (stored === "stale") return minutes >= AGENT_STATUS_OFFLINE_MINUTES ? "offline" : "stale";
  if (minutes >= AGENT_STATUS_STALE_MINUTES) return "stale";

  // Active declared state. Validate against the known set; fall back to
  // 'idle' for unrecognized legacy or drift values.
  if (
    stored === "idle" ||
    stored === "working" ||
    stored === "blocked" ||
    stored === "waiting_user"
  ) {
    return stored;
  }
  return "idle";
}

function toAgentWithStatus(row: AgentRecord): AgentWithStatus {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    capabilities: JSON.parse(row.capabilities) as string[],
    last_seen: row.last_seen,
    created_at: row.created_at,
    status: computeStatus(row.last_seen),
    has_token: !!row.token_hash,
    agent_status: deriveAgentStatus(row.agent_status, row.last_seen),
    description: row.description ?? null,
    session_id: row.session_id ?? null,
    terminal_title_ref: row.terminal_title_ref ?? null,
  };
}

let _db: CompatDatabase | null = null;

/**
 * Initialize the database. Call once at process startup. For native driver
 * (default): sync under the hood. For wasm driver: loads the wasm binary
 * async then returns a better-sqlite3-compatible adapter.
 *
 * v1.11: replaces the lazy-init that was in getDb(). Now eager-init so the
 * wasm path can load asynchronously before any tool call happens.
 */
export async function initializeDb(): Promise<void> {
  if (_db) return;

  const dbPath = getDbPath();
  // v2.1 Phase 4c.4: tighten directory perms BEFORE the driver opens the
  // file so there is no window where the DB lives under a 0755 parent.
  ensureSecureDir(path.dirname(dbPath), 0o700);
  _db = await initDriver(dbPath);
  // And narrow the DB file itself to 0600 right after create.
  ensureSecureFile(dbPath, 0o600);

  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("busy_timeout = 5000");

  initSchema(_db);
  migrateSchemaToV1_7(_db);
  migrateSchemaToV2_0(_db);
  migrateSchemaToV2_1(_db);
  migrateSchemaToV2_2(_db);
  migrateSchemaToV2_3(_db);
  migrateSchemaToV2_4(_db);
  migrateSchemaToV2_5(_db);
  migrateSchemaToV2_6(_db);
  migrateSchemaToV2_7(_db);
  migrateSchemaToV2_8(_db);
  purgeOldRecords(_db);
}

export function getDb(): CompatDatabase {
  if (_db) return _db;

  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  // v2.1 Phase 4c.4: same dir + file perm narrowing as the eager init path.
  ensureSecureDir(dir, 0o700);

  const { createRequire } = require("module");
  const req = createRequire(import.meta.url);
  const Database = req("better-sqlite3");
  _db = new Database(dbPath) as unknown as CompatDatabase;
  ensureSecureFile(dbPath, 0o600);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("busy_timeout = 5000");

  initSchema(_db);
  migrateSchemaToV1_7(_db);
  migrateSchemaToV2_0(_db);
  migrateSchemaToV2_1(_db);
  migrateSchemaToV2_2(_db);
  migrateSchemaToV2_3(_db);
  migrateSchemaToV2_4(_db);
  migrateSchemaToV2_5(_db);
  migrateSchemaToV2_6(_db);
  migrateSchemaToV2_7(_db);
  migrateSchemaToV2_8(_db);
  purgeOldRecords(_db);

  return _db;
}

/**
 * Additive-only schema migrations for existing DBs upgrading from v1.6.x.
 * Each migration is idempotent — checks if the column already exists before
 * adding it. No destructive changes, no renames.
 */
function migrateSchemaToV1_7(db: CompatDatabase): void {
  const agentCols = db
    .prepare("PRAGMA table_info(agents)")
    .all() as Array<{ name: string }>;
  if (!agentCols.some((c) => c.name === "token_hash")) {
    db.exec("ALTER TABLE agents ADD COLUMN token_hash TEXT");
  }

  const auditCols = db
    .prepare("PRAGMA table_info(audit_log)")
    .all() as Array<{ name: string }>;
  if (auditCols.length > 0 && !auditCols.some((c) => c.name === "params_json")) {
    db.exec("ALTER TABLE audit_log ADD COLUMN params_json TEXT");
  }
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
  closeInitializedDb();
}

function initSchema(db: CompatDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      last_seen TEXT NOT NULL,
      created_at TEXT NOT NULL,
      token_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
    CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      content TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_to_status ON messages(to_agent, status);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'posted',
      result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_to_status ON tasks(to_agent, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_from ON tasks(from_agent);

    CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      event TEXT NOT NULL,
      filter TEXT,
      secret TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webhooks_event ON webhook_subscriptions(event);

    CREATE TABLE IF NOT EXISTS webhook_delivery_log (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      status_code INTEGER,
      error TEXT,
      attempted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_webhook ON webhook_delivery_log(webhook_id);
    CREATE INDEX IF NOT EXISTS idx_delivery_attempted ON webhook_delivery_log(attempted_at);

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      agent_name TEXT,
      tool TEXT NOT NULL,
      params_summary TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      source TEXT NOT NULL DEFAULT 'stdio',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_name);
    CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_log(tool);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

    CREATE TABLE IF NOT EXISTS rate_limit_state (
      agent_name TEXT NOT NULL,
      bucket TEXT NOT NULL,
      window_start TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_name, bucket)
    );

    -- v2.1 Phase 4c.3: schema_info is the authoritative record of what
    -- schema version this DB is at. Single-row (CHECK id = 1). Populated by
    -- an INSERT OR IGNORE at initSchema time; initialized_at is set once on
    -- the very first init and never changes thereafter.
    CREATE TABLE IF NOT EXISTS schema_info (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      initialized_at TEXT NOT NULL,
      last_migrated_at TEXT NOT NULL
    );

    -- v2.1 Phase 4b.3: reencryption_progress tracks long-running
    -- "relay re-encrypt" invocations so they survive process interruption.
    -- Columns:
    --   run_id          UUID generated per "relay re-encrypt" invocation.
    --                   Ties all per-table rows for one run together.
    --   from_key_id     Source key_id being migrated away from.
    --   to_key_id       Destination key_id (typically keyring.current).
    --   table_name      One of the encrypted-column tables:
    --                   messages | tasks_description | tasks_result |
    --                   audit_log | webhook_subscriptions. Note the
    --                   per-column split for tasks — the tool tracks each
    --                   encrypted column independently so a mid-run abort
    --                   can resume column-by-column, not row-by-row across
    --                   columns of the same table.
    --   last_row_id     Cursor — the row PK of the last successfully
    --                   processed batch. Resume seeks past this.
    --   rows_processed  Cumulative counter across resumes. Diagnostic.
    --   started_at      First start (wall clock).
    --   completed_at    Set when status=completed. NULL otherwise.
    --   status          running | completed | aborted.
    -- Enforced invariant: only one running row per (from, to, table)
    -- triple — unique partial index below.
    CREATE TABLE IF NOT EXISTS reencryption_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      from_key_id TEXT NOT NULL,
      to_key_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      last_row_id TEXT,
      rows_processed INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running','completed','aborted'))
    );
    CREATE INDEX IF NOT EXISTS idx_reencryption_run ON reencryption_progress(run_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reencryption_active
      ON reencryption_progress(from_key_id, to_key_id, table_name)
      WHERE status = 'running';
  `);
  // Populate the schema_info single-row. INSERT OR IGNORE covers:
  //   - fresh DB: insert with version = CURRENT_SCHEMA_VERSION, both timestamps = NOW
  //   - existing DB without schema_info (pre-v2.1 upgrade): insert same shape;
  //     initialized_at gets NOW since we don't know the real first-init time.
  // UPDATE bumps last_migrated_at on every startup as a heartbeat.
  const initNow = now();
  db.prepare(
    "INSERT OR IGNORE INTO schema_info (id, version, initialized_at, last_migrated_at) VALUES (1, ?, ?, ?)"
  ).run(CURRENT_SCHEMA_VERSION, initNow, initNow);
  db.prepare(
    "UPDATE schema_info SET last_migrated_at = ? WHERE id = 1"
  ).run(initNow);
}

/**
 * v2.1 Phase 4c.3: authoritative schema-version constant. Bump this AND
 * register an entry in `applyMigration` whenever a schema change ships.
 * v2.1 Phase 4b.1 v2 bumped 1 → 2 alongside migrateSchemaToV2_1
 * (auth_state + revoked_at + recovery_token_hash columns on agents).
 * v2.1 Phase 4p bumped 2 → 3 alongside migrateSchemaToV2_2 (one-shot
 * encryption of existing plaintext webhook_subscriptions.secret rows).
 * v2.1 Phase 4b.2 bumped 3 → 4 alongside migrateSchemaToV2_3 (managed
 * column + rotation_grace state + previous_token_hash + CHECK rewrite).
 * v2.1 Phase 4b.3 bumped 4 → 5 alongside the reencryption_progress table
 * (new table only, no column changes; version bump is a semantic marker
 * so backup/restore flag the post-rotation shape explicitly).
 * v2.1.3 (I6) bumped 6 → 7 alongside migrateSchemaToV2_5 (agent_status enum
 *   widened + legacy value remap: online→idle, busy→working, away→blocked).
 *
 * v2.1.6 bumped 7 → 8 alongside migrateSchemaToV2_6 (agents.session_started_at
 * nullable column, anchors the `session_start` sentinel in the `since` filter
 * on get_messages / get_messages_summary).
 *
 * v2.2.0 bumped 8 → 9 alongside migrateSchemaToV2_7 (agents.terminal_title_ref
 * nullable column, used by the dashboard's click-to-focus driver to find the
 * agent's live terminal window across iTerm2 / wmctrl / AppActivate).
 *
 * v2.2.1 bumped 9 → 10 alongside migrateSchemaToV2_8 (dashboard_prefs
 * single-row table holding the server-side default theme for the v2.2.1
 * set_dashboard_theme MCP tool).
 *
 * v2.1 Phase 7q bumped 5 → 6 alongside migrateSchemaToV2_4 (agents.visibility
 * column reserved for v2.3 hub federation, mailbox + agent_cursor tables
 * reserved for Phase 4s v2.2 delivery-seq protocol). All additions empty /
 * unused in v2.1.0 — pure namespace reservation so downstream phases don't
 * require a breaking migration.
 * Migrations are idempotent and run unconditionally at init; the version
 * bump is the semantic marker visible to backup/restore.
 */
export const CURRENT_SCHEMA_VERSION = 10;

/**
 * Read the live DB's recorded schema version. Throws if the table is
 * missing (shouldn't happen post-initSchema; fail-loud over silent-zero).
 */
export function getSchemaVersion(): number {
  const db = getDb();
  const row = db.prepare("SELECT version FROM schema_info WHERE id = 1").get() as
    | { version: number }
    | undefined;
  if (!row) {
    throw new Error("schema_info row missing — DB not initialized? Call initializeDb() first.");
  }
  return row.version;
}

/**
 * Hook point for future schema migrations. Currently a stub: CURRENT_SCHEMA_VERSION
 * is 1 and there are no registered migrations. A future bump to v2 must:
 *   1. Add a case here that applies the migration SQL.
 *   2. UPDATE schema_info SET version = 2, last_migrated_at = NOW WHERE id = 1.
 *   3. Bump CURRENT_SCHEMA_VERSION to 2.
 * Throws for unregistered pairs so callers see a clear actionable error
 * rather than silent no-op.
 */
export function applyMigration(from: number, to: number): void {
  // v2.1 Phase 4b.1 v2 + Phase 4p: schema_version migrations 1→2 and 2→3
  // are applied via migrateSchemaToV2_1 / migrateSchemaToV2_2 which run
  // unconditionally at init under the same idempotent-guard pattern as
  // migrateSchemaToV1_7 / migrateSchemaToV2_0. The mutation already
  // happened at init; this hook is a no-op semantic acknowledgement so
  // backup/restore's version-bump dispatcher doesn't throw.
  if (from === 1 && to === 2) return;
  if (from === 2 && to === 3) return;
  if (from === 3 && to === 4) return;
  if (from === 4 && to === 5) return;
  if (from === 5 && to === 6) return;
  if (from === 6 && to === 7) return;
  if (from === 7 && to === 8) return;
  if (from === 8 && to === 9) return;
  if (from === 9 && to === 10) return;
  throw new Error(
    `no migration registered for schema_version ${from}→${to}. ` +
    `Register a handler in src/db.ts applyMigration and update CURRENT_SCHEMA_VERSION.`
  );
}

/**
 * v2.0 schema migrations. Additive-only, idempotent.
 *
 * New tables: channels, channel_members, channel_messages, agent_capabilities.
 * New columns: tasks.lease_renewed_at, webhook_delivery_log.retry_count/next_retry_at/terminal_status.
 * New indexes: priority composite indexes, agent_capabilities index.
 *
 * Populates agent_capabilities from existing agents.capabilities JSON (one-time migration).
 */
function migrateSchemaToV2_0(db: CompatDatabase): void {
  // --- New tables ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channels_name ON channels(name);

    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, agent_name),
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS channel_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      content TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      created_at TEXT NOT NULL,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_channel_msgs_channel ON channel_messages(channel_id, created_at);

    CREATE TABLE IF NOT EXISTS agent_capabilities (
      agent_name TEXT NOT NULL,
      capability TEXT NOT NULL,
      PRIMARY KEY (agent_name, capability)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_caps ON agent_capabilities(capability, agent_name);
  `);

  // --- New columns on existing tables (idempotent) ---

  // tasks.lease_renewed_at — task-level heartbeat for health monitor (HIGH 2)
  const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string; notnull: number }>;
  if (!taskCols.some((c) => c.name === "lease_renewed_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN lease_renewed_at TEXT");
  }
  // tasks.required_capabilities — JSON array for auto-routing from the queue (v2.0 beta)
  if (!taskCols.some((c) => c.name === "required_capabilities")) {
    db.exec("ALTER TABLE tasks ADD COLUMN required_capabilities TEXT");
  }
  // v2.0 final: agents.session_id (#6 session-aware reads), agents.agent_status
  // (#26 busy/DND), agents.description (#29), messages.read_by_session (#6).
  // Additive, idempotent. Backfills: session_id defaults to a fresh UUID per
  // existing agent so first get_messages on a new session works correctly.
  const agentColsV2f = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (!agentColsV2f.some((c) => c.name === "session_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN session_id TEXT");
    // Backfill each existing agent with a unique fresh session_id so pre-v2f
    // messages behave consistently for the next get_messages call.
    const agents = db.prepare("SELECT name FROM agents").all() as Array<{ name: string }>;
    const update = db.prepare("UPDATE agents SET session_id = ? WHERE name = ?");
    for (const a of agents) update.run(uuidv4(), a.name);
  }
  if (!agentColsV2f.some((c) => c.name === "agent_status")) {
    db.exec("ALTER TABLE agents ADD COLUMN agent_status TEXT NOT NULL DEFAULT 'online'");
  }
  if (!agentColsV2f.some((c) => c.name === "description")) {
    db.exec("ALTER TABLE agents ADD COLUMN description TEXT");
  }
  const msgColsV2f = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  if (!msgColsV2f.some((c) => c.name === "read_by_session")) {
    db.exec("ALTER TABLE messages ADD COLUMN read_by_session TEXT");
  }

  // v2.0.1 (Codex HIGH 2): busy/away TTL. Without this, a crashed agent that
  // last set busy is shielded from health reassignment forever (until the
  // 30-day dead-agent purge). busy_expires_at holds the absolute time at
  // which the shield lifts. NULL = no TTL (interpreted as unbounded for
  // backward compat with any pre-v2.0.1 set_status calls, which shouldn't
  // exist because the column is new, but defensive).
  const agentColsV201 = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (!agentColsV201.some((c) => c.name === "busy_expires_at")) {
    db.exec("ALTER TABLE agents ADD COLUMN busy_expires_at TEXT");
  }
  // v2.0.1 (Codex HIGH 3): webhook retry claim lease. Crash-safe: if a
  // process claims a row and dies, the lease expires after 60s and the row
  // is re-claimable. Replaces the earlier "next_retry_at = NULL" claim
  // marker that stranded rows on crash.
  const whColsV201 = db.prepare("PRAGMA table_info(webhook_delivery_log)").all() as Array<{ name: string }>;
  if (!whColsV201.some((c) => c.name === "claimed_at")) {
    db.exec("ALTER TABLE webhook_delivery_log ADD COLUMN claimed_at TEXT");
  }
  if (!whColsV201.some((c) => c.name === "claim_expires_at")) {
    db.exec("ALTER TABLE webhook_delivery_log ADD COLUMN claim_expires_at TEXT");
  }

  // v2.0 beta: drop NOT NULL from tasks.to_agent so queued tasks (pre-routing)
  // can exist without an assignee. SQLite doesn't support ALTER COLUMN drop
  // constraint, so rebuild the table. Detect by inspecting the column meta.
  const toAgentCol = taskCols.find((c) => c.name === "to_agent");
  if (toAgentCol && toAgentCol.notnull === 1) {
    // Refresh the column list after the ALTER ADDs above so the rebuild SELECT
    // includes the new columns too.
    const currentCols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const colList = currentCols.map((c) => c.name).join(", ");
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE tasks_new (
          id TEXT PRIMARY KEY,
          from_agent TEXT NOT NULL,
          to_agent TEXT,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          priority TEXT NOT NULL DEFAULT 'normal',
          status TEXT NOT NULL DEFAULT 'posted',
          result TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          lease_renewed_at TEXT,
          required_capabilities TEXT
        );
      `);
      db.exec(`INSERT INTO tasks_new (${colList}) SELECT ${colList} FROM tasks;`);
      db.exec(`DROP TABLE tasks;`);
      db.exec(`ALTER TABLE tasks_new RENAME TO tasks;`);
      // Re-create indexes (initSchema + this migration's priority index).
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_to_status ON tasks(to_agent, status);
        CREATE INDEX IF NOT EXISTS idx_tasks_from ON tasks(from_agent);
        CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(to_agent, status, priority, created_at);
      `);
    });
    rebuild();
  }

  // webhook_delivery_log retry columns (MEDIUM 11-12)
  const whCols = db.prepare("PRAGMA table_info(webhook_delivery_log)").all() as Array<{ name: string }>;
  if (!whCols.some((c) => c.name === "retry_count")) {
    db.exec("ALTER TABLE webhook_delivery_log ADD COLUMN retry_count INTEGER DEFAULT 0");
  }
  if (!whCols.some((c) => c.name === "next_retry_at")) {
    db.exec("ALTER TABLE webhook_delivery_log ADD COLUMN next_retry_at TEXT");
  }
  if (!whCols.some((c) => c.name === "terminal_status")) {
    db.exec("ALTER TABLE webhook_delivery_log ADD COLUMN terminal_status TEXT");
  }

  // --- Priority composite indexes (MEDIUM 7) ---
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_priority
      ON messages(to_agent, status, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority
      ON tasks(to_agent, status, priority, created_at);
  `);

  // --- Populate agent_capabilities from existing agents (one-time migration) ---
  // Only runs if the table is empty and agents exist.
  const capCount = db.prepare("SELECT COUNT(*) AS c FROM agent_capabilities").get() as { c: number };
  if (capCount.c === 0) {
    const agents = db.prepare("SELECT name, capabilities FROM agents").all() as Array<{ name: string; capabilities: string }>;
    const insert = db.prepare("INSERT OR IGNORE INTO agent_capabilities (agent_name, capability) VALUES (?, ?)");
    for (const agent of agents) {
      try {
        const caps = JSON.parse(agent.capabilities) as string[];
        for (const cap of caps) {
          if (cap) insert.run(agent.name, cap);
        }
      } catch {
        // Malformed JSON — skip
      }
    }
  }
}

/**
 * v2.1 Phase 4b.1 v2 schema migration. Additive + idempotent. Adds the
 * auth_state machine to the agents table + marks existing pre-v1.7 legacy
 * rows explicitly instead of relying on the `token_hash IS NULL` overload.
 *
 * Columns added:
 *   - auth_state          active | legacy_bootstrap | revoked | recovery_pending (DEFAULT 'active')
 *   - revoked_at          ISO timestamp of most recent revoke_token call
 *   - recovery_token_hash bcrypt hash of admin-issued recovery secret
 *
 * One-shot UPDATE marks existing rows with null token_hash as
 * `legacy_bootstrap`. Self-idempotent: rows already marked won't re-match.
 *
 * This is paired with CURRENT_SCHEMA_VERSION = 2. applyMigration(1,2)
 * registers as a no-op since the mutation already lands at init.
 */
function migrateSchemaToV2_1(db: CompatDatabase): void {
  const agentCols = db
    .prepare("PRAGMA table_info(agents)")
    .all() as Array<{ name: string }>;

  // SQLite does NOT allow DEFAULT with a CHECK expression that references the
  // column in an ADD COLUMN statement unless the default is a literal. The
  // literal 'active' works; the CHECK stays on the table-level as a guard.
  if (!agentCols.some((c) => c.name === "auth_state")) {
    db.exec(
      "ALTER TABLE agents ADD COLUMN auth_state TEXT NOT NULL DEFAULT 'active' " +
      "CHECK (auth_state IN ('active','legacy_bootstrap','revoked','recovery_pending'))"
    );
  }
  if (!agentCols.some((c) => c.name === "revoked_at")) {
    db.exec("ALTER TABLE agents ADD COLUMN revoked_at TEXT");
  }
  if (!agentCols.some((c) => c.name === "recovery_token_hash")) {
    db.exec("ALTER TABLE agents ADD COLUMN recovery_token_hash TEXT");
  }

  db.exec("CREATE INDEX IF NOT EXISTS idx_agents_auth_state ON agents(auth_state)");

  // One-shot: mark pre-v1.7 legacy rows explicitly. Idempotent because the
  // WHERE clause filters rows already marked.
  db.prepare(
    "UPDATE agents SET auth_state = 'legacy_bootstrap' " +
    "WHERE token_hash IS NULL AND auth_state = 'active'"
  ).run();
}

/**
 * v2.1 Phase 4p — encrypt existing plaintext webhook_subscriptions.secret
 * values at rest (Codex R1 HIGH #2). One-shot, idempotent, self-skipping.
 *
 * Detection: `encryptContent` emits ciphertext prefixed with "enc1:" when
 * RELAY_ENCRYPTION_KEY is set; plaintext pass-through otherwise. This
 * migration walks every non-null secret and re-encrypts any row that does
 * NOT already carry the enc1: prefix. Already-encrypted rows skip.
 *
 * When RELAY_ENCRYPTION_KEY is UNSET, `encryptContent` returns plaintext
 * unchanged — the migration becomes a no-op (rows stay as-is, schema
 * version still bumps to 3). This matches the existing behavior of
 * messages.content / tasks.description / tasks.result / audit_log.
 *
 * Operators who ADD a key after this migration has run will see new writes
 * encrypted but old rows stay plaintext — same contract as every other
 * encrypted-at-rest column in the DB. Rotation is deferred to Phase 4b.3.
 */
function migrateSchemaToV2_2(db: CompatDatabase): void {
  // v2.1 Phase 4p + 4b.3: encrypt plaintext webhook secrets in place.
  // Skip rows already carrying either encryption prefix — "enc1:" (legacy
  // Phase 4p) or "enc:<key_id>:" (Phase 4b.3 versioned). Matching both
  // prevents double-encryption when the migration runs on an already-
  // rotated DB.
  const rows = db.prepare(
    "SELECT id, secret FROM webhook_subscriptions " +
    "WHERE secret IS NOT NULL AND secret != '' " +
    "AND secret NOT LIKE 'enc1:%' AND secret NOT LIKE 'enc:%'"
  ).all() as Array<{ id: string; secret: string }>;
  if (rows.length === 0) return;

  const update = db.prepare("UPDATE webhook_subscriptions SET secret = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const r of rows) {
      update.run(encryptContent(r.secret), r.id);
    }
  });
  tx();
}

/**
 * v2.1 Phase 4b.2 schema migration — Managed Agent class + rotation grace.
 *
 * Three additive columns on agents:
 *   - managed                    BOOLEAN (0/1). Immutable post-first-register.
 *                                1 = Managed Agent wrapper (can parse push-tokens
 *                                + self-update env). 0 = Claude Code terminal
 *                                or equivalent (restart-required on rotate).
 *   - rotation_grace_expires_at  TIMESTAMP. Populated during rotation_grace;
 *                                cleared by auto-expiry piggyback or by the
 *                                next state transition (active/revoked).
 *   - previous_token_hash        bcrypt hash of the PRE-rotation token. Held
 *                                only during rotation_grace for dual-token
 *                                auth. Cleared on cleanup.
 *
 * CHECK-clause rewrite: adds 'rotation_grace' to the auth_state enum. SQLite
 * doesn't support in-place CHECK modification — we rebuild the table via
 * CREATE agents_new / INSERT / DROP / RENAME wrapped in a transaction.
 * Idempotency: we only rebuild if sqlite_master.sql for agents does NOT
 * already contain 'rotation_grace' (i.e. migration hasn't run yet).
 *
 * Precedent: migrateSchemaToV2_0 uses the same rebuild pattern to drop
 * NOT NULL from tasks.to_agent.
 */
function migrateSchemaToV2_3(db: CompatDatabase): void {
  const agentCols = db
    .prepare("PRAGMA table_info(agents)")
    .all() as Array<{ name: string }>;

  if (!agentCols.some((c) => c.name === "managed")) {
    db.exec("ALTER TABLE agents ADD COLUMN managed INTEGER NOT NULL DEFAULT 0");
  }
  if (!agentCols.some((c) => c.name === "rotation_grace_expires_at")) {
    db.exec("ALTER TABLE agents ADD COLUMN rotation_grace_expires_at TEXT");
  }
  if (!agentCols.some((c) => c.name === "previous_token_hash")) {
    db.exec("ALTER TABLE agents ADD COLUMN previous_token_hash TEXT");
  }

  // CHECK-clause rewrite. Skip if the enum already includes 'rotation_grace'.
  const tableDef = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agents'")
    .get() as { sql: string } | undefined;
  if (!tableDef || tableDef.sql.includes("'rotation_grace'")) return;

  // Rebuild in a transaction. All existing columns (including the three we
  // just added) are carried over by SELECT *, preserving row contents.
  const currentCols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  const colList = currentCols.map((c) => c.name).join(", ");

  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE agents_new (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '[]',
        last_seen TEXT NOT NULL,
        created_at TEXT NOT NULL,
        token_hash TEXT,
        session_id TEXT,
        agent_status TEXT NOT NULL DEFAULT 'online',
        description TEXT,
        busy_expires_at TEXT,
        auth_state TEXT NOT NULL DEFAULT 'active'
          CHECK (auth_state IN ('active','legacy_bootstrap','revoked','recovery_pending','rotation_grace')),
        revoked_at TEXT,
        recovery_token_hash TEXT,
        managed INTEGER NOT NULL DEFAULT 0,
        rotation_grace_expires_at TEXT,
        previous_token_hash TEXT
      );
    `);
    db.exec(`INSERT INTO agents_new (${colList}) SELECT ${colList} FROM agents;`);
    db.exec("DROP TABLE agents;");
    db.exec("ALTER TABLE agents_new RENAME TO agents;");
    // Re-create every index that was on the old table.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
      CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);
      CREATE INDEX IF NOT EXISTS idx_agents_auth_state ON agents(auth_state);
    `);
  });
  rebuild();
}

/**
 * v2.1 Phase 7q — design-freeze migration. Three additions, all
 * reserved-namespace with ZERO behavior change in v2.1.0:
 *
 *   1. `mailbox` table — keyed by mailbox_id (== agent_name in v2.1.0),
 *      carries an epoch (UUID, rotates on backup/restore in v2.2) + a
 *      monotonic next_seq counter. Phase 4s in v2.2 will assign seq at
 *      delivery time and surface it via `peek_inbox_version`. Table is
 *      empty in v2.1.0.
 *
 *   2. `agent_cursor` table — composite-keyed on (mailbox_id, epoch),
 *      records the last_seen_seq per consumer cursor. Empty in v2.1.0.
 *      Reserved for Phase 4s v2.2.
 *
 *   3. `agents.visibility` column — 'local' | 'federated', default 'local'.
 *      Reserved for v2.3 hub federation. No v2.1.0 code reads or writes
 *      it; every agent stays 'local'.
 *
 * All three are idempotent — CREATE TABLE IF NOT EXISTS + conditional ADD
 * COLUMN. Schema version bumps 5 → 6 as a semantic marker.
 *
 * The visibility column uses ALTER TABLE ADD COLUMN with a CHECK clause at
 * the column level. Modern SQLite supports this; the Phase 4b.2 table-
 * rebuild precedent (migrateSchemaToV2_3) is for CHECK-clause REWRITES on
 * existing enum columns, not new ones.
 */
function migrateSchemaToV2_4(db: CompatDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mailbox (
      mailbox_id TEXT PRIMARY KEY,
      epoch TEXT NOT NULL,
      next_seq INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS agent_cursor (
      mailbox_id TEXT NOT NULL,
      epoch TEXT NOT NULL,
      last_seen_seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (mailbox_id, epoch)
    );
  `);

  const agentCols = db
    .prepare("PRAGMA table_info(agents)")
    .all() as Array<{ name: string }>;
  if (!agentCols.some((c) => c.name === "visibility")) {
    db.exec(
      "ALTER TABLE agents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'local' " +
      "CHECK (visibility IN ('local','federated'))"
    );
  }
}

/**
 * v2.1.3 (I6) — agent_status enum widening.
 *
 * The column has no CHECK constraint (the v2_0 ALTER just set a DEFAULT), so
 * no table rebuild is required. This migration is a pure data remap:
 *   online  → idle
 *   busy    → working
 *   away    → blocked
 *   offline → offline (unchanged)
 *   any other value (waiting_user, stale, idle, working, blocked) → unchanged
 *
 * Idempotent: the WHERE clauses match zero rows on a DB that's already been
 * migrated. Schema version bumps 6 → 7.
 *
 * Read-side auto-transition (idle/working/blocked/waiting_user → stale at
 * 5 min → offline at 30 min of last_seen silence) is a DERIVED value in
 * toAgentWithStatus / deriveAgentStatus, not a stored mutation. No
 * background sweep needed; no writes on read.
 *
 * The `stale` and `waiting_user` values are permitted in the stored column
 * (agents can self-declare waiting_user via set_status; stale is reserved
 * for relay but the schema doesn't police it). No CHECK constraint means
 * no table rebuild needed for the widening.
 */
function migrateSchemaToV2_5(db: CompatDatabase): void {
  db.prepare("UPDATE agents SET agent_status = 'idle' WHERE agent_status = 'online'").run();
  db.prepare("UPDATE agents SET agent_status = 'working' WHERE agent_status = 'busy'").run();
  db.prepare("UPDATE agents SET agent_status = 'blocked' WHERE agent_status = 'away'").run();
}

/**
 * v2.1.6 — add `agents.session_started_at` as the anchor for the
 * `session_start` sentinel in the new `since` filter on get_messages /
 * get_messages_summary. Nullable so pre-v2.1.6 rows that were registered
 * before this column existed fall through to an unfiltered read (cannot
 * invent a plausible anchor). Set by registerAgent alongside session_id.
 *
 * Additive + idempotent. No data backfill — the tool handler treats NULL as
 * "no anchor known; skip the filter" (documented behavior, prevents surprise
 * empty inboxes for agents that haven't re-registered since the upgrade).
 */
function migrateSchemaToV2_6(db: CompatDatabase): void {
  const agentCols = db
    .prepare("PRAGMA table_info(agents)")
    .all() as Array<{ name: string }>;
  if (!agentCols.some((c) => c.name === "session_started_at")) {
    db.exec("ALTER TABLE agents ADD COLUMN session_started_at TEXT");
  }
}

/**
 * v2.2.0 — add `agents.terminal_title_ref` for the dashboard's click-to-focus
 * driver. Captured at register_agent time from `RELAY_TERMINAL_TITLE` (set
 * by the spawn chain). Nullable — legacy rows + agents that register without
 * the env var fall through to a disabled focus button in the UI per the
 * spec's graceful-degrade contract.
 *
 * Additive + idempotent. No data backfill.
 */
function migrateSchemaToV2_7(db: CompatDatabase): void {
  const agentCols = db
    .prepare("PRAGMA table_info(agents)")
    .all() as Array<{ name: string }>;
  if (!agentCols.some((c) => c.name === "terminal_title_ref")) {
    db.exec("ALTER TABLE agents ADD COLUMN terminal_title_ref TEXT");
  }
}

/**
 * v2.2.1 P1 — `dashboard_prefs` single-row table storing the server-side
 * default theme for the dashboard. Each client reads this on first
 * connect if localStorage has no theme selection yet. Mutations via the
 * new `set_dashboard_theme` MCP tool.
 *
 * Shape: same single-row CHECK(id=1) pattern as `schema_info`.
 *   - theme: one of "catppuccin" | "dark" | "light" | "custom"
 *   - custom_json: JSON string of custom-theme tokens (populated only
 *     when theme="custom"). Shape validated by the Zod schema at the
 *     tool layer; DB stores the pre-validated JSON string.
 *   - updated_at: ISO timestamp of the last write.
 *
 * Additive + idempotent. No data backfill — the table is seeded with
 * {theme:"catppuccin", custom_json:null} on first migration run.
 */
function migrateSchemaToV2_8(db: CompatDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_prefs (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      theme TEXT NOT NULL DEFAULT 'catppuccin'
        CHECK (theme IN ('catppuccin', 'dark', 'light', 'custom')),
      custom_json TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  const nowIso = now();
  db.prepare(
    "INSERT OR IGNORE INTO dashboard_prefs (id, theme, custom_json, updated_at) VALUES (1, 'catppuccin', NULL, ?)"
  ).run(nowIso);
}

export interface DashboardPrefs {
  theme: "catppuccin" | "dark" | "light" | "custom";
  custom_json: string | null;
  updated_at: string;
}

/** v2.2.1: read the server-side default dashboard theme. */
export function getDashboardPrefs(): DashboardPrefs {
  const db = getDb();
  const row = db
    .prepare("SELECT theme, custom_json, updated_at FROM dashboard_prefs WHERE id = 1")
    .get() as DashboardPrefs | undefined;
  // Defensive: if the row is somehow missing (shouldn't happen post-migration),
  // fall back to the hard default.
  return row ?? { theme: "catppuccin", custom_json: null, updated_at: now() };
}

/**
 * v2.2.1: write the server-side default dashboard theme. `custom_json` must
 * be a pre-serialized JSON string when theme='custom'; null otherwise. The
 * tool-layer Zod schema validates the JSON shape before this is called.
 */
export function setDashboardPrefs(
  theme: DashboardPrefs["theme"],
  custom_json: string | null
): DashboardPrefs {
  const db = getDb();
  const nowIso = now();
  db.prepare(
    "UPDATE dashboard_prefs SET theme = ?, custom_json = ?, updated_at = ? WHERE id = 1"
  ).run(theme, custom_json, nowIso);
  return { theme, custom_json, updated_at: nowIso };
}

function purgeOldRecords(db: CompatDatabase): void {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare("DELETE FROM messages WHERE created_at < ?").run(sevenDaysAgo);
  db.prepare("DELETE FROM tasks WHERE status IN ('completed', 'rejected', 'cancelled') AND updated_at < ?").run(thirtyDaysAgo);
  db.prepare("DELETE FROM webhook_delivery_log WHERE attempted_at < ?").run(sevenDaysAgo);
  // v2.1 Phase 4c.2: audit log retention is now env-driven (default 90 days,
  // configurable via RELAY_AUDIT_LOG_RETENTION_DAYS, 0 = disabled).
  purgeOldAuditLog(getAuditLogRetentionDays());
  // v2.0: purge old channel messages (same 7-day window as direct messages)
  db.prepare("DELETE FROM channel_messages WHERE created_at < ?").run(sevenDaysAgo);
  // v2.0 final (#2): purge dead agents (offline >30 days) and their
  // normalized capability rows. Hard kill + never re-registered = dead.
  const staleAgents = db.prepare(
    "SELECT name FROM agents WHERE last_seen < ?"
  ).all(thirtyDaysAgo) as Array<{ name: string }>;
  for (const a of staleAgents) {
    // v2.1 Phase 7q: sanctioned teardown helper.
    teardownAgent(a.name, "stale_purge");
  }
}

/**
 * v2.1 Phase 4c.2: configurable audit-log retention. Returns the number of
 * rows removed. `retentionDays <= 0` is a no-op — explicit opt-out for
 * operators who want indefinite retention.
 */
export function purgeOldAuditLog(retentionDays: number): { purged: number } {
  if (retentionDays <= 0) return { purged: 0 };
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const r = db.prepare("DELETE FROM audit_log WHERE created_at < ?").run(cutoff);
  return { purged: r.changes };
}

/** Env-driven retention days for audit_log. Validated in config.ts at startup. */
function getAuditLogRetentionDays(): number {
  const raw = process.env.RELAY_AUDIT_LOG_RETENTION_DAYS;
  if (raw === undefined || raw === "") return 90;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0) return 90;
  return n;
}

/** Env-driven piggyback interval. Default 1000 inserts per purge. */
function getAuditLogPurgeInterval(): number {
  const raw = process.env.RELAY_AUDIT_LOG_PURGE_INTERVAL;
  if (raw === undefined || raw === "") return 1000;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) return 1000;
  return n;
}

/**
 * v2.1 Phase 4c.2: counter-based piggyback purge. Every Nth `logAudit` call,
 * opportunistically purge aged rows so long-running daemons don't grow
 * unboundedly between restarts. In-memory counter, reset on restart.
 */
let auditInsertCounter = 0;
function maybePiggybackPurge(): void {
  auditInsertCounter += 1;
  const interval = getAuditLogPurgeInterval();
  if (auditInsertCounter >= interval) {
    auditInsertCounter = 0;
    try {
      purgeOldAuditLog(getAuditLogRetentionDays());
    } catch (err) {
      // Purge is best-effort — an insert must never fail because the
      // piggyback purge hit an unexpected error.
      log.warn("[audit] piggyback purge failed:", err);
    }
  }
}

/** v2.1 Phase 4c.2: test-only reset for the piggyback counter. */
export function _resetAuditPurgeCounterForTests(): void {
  auditInsertCounter = 0;
}

// --- Audit log operations ---

/**
 * v1.7: structured params_json alongside the legacy params_summary column.
 * New writes populate both: params_summary for back-compat readers, and
 * params_json as a JSON-stringified structured object. Old rows predate
 * params_json (NULL) — readers should fall back to params_summary.
 *
 * The params_json field is encrypted at rest when RELAY_ENCRYPTION_KEY is set
 * (it may contain sensitive parameters like message content fragments).
 */
export function logAudit(
  agentName: string | null,
  tool: string,
  paramsSummary: string | null,
  success: boolean,
  error: string | null,
  source: string = "stdio",
  structured?: Record<string, unknown>
): void {
  const db = getDb();
  const paramsJson = structured
    ? encryptContent(JSON.stringify(structured))
    : paramsSummary
      ? encryptContent(JSON.stringify({ legacy_summary: paramsSummary }))
      : null;
  db.prepare(
    "INSERT INTO audit_log (id, agent_name, tool, params_summary, params_json, success, error, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(uuidv4(), agentName, tool, paramsSummary, paramsJson, success ? 1 : 0, error, source, now());
  // v2.1 Phase 4c.2: piggyback retention purge on every Nth insert.
  maybePiggybackPurge();
}

export interface AuditLogRecord {
  id: string;
  agent_name: string | null;
  tool: string;
  params_summary: string | null;
  /** v1.7: structured JSON (decrypted on read) of the tool-call params. */
  params_json: Record<string, unknown> | null;
  success: number;
  error: string | null;
  source: string;
  created_at: string;
}

export function getAuditLog(
  agentName?: string,
  tool?: string,
  limit: number = 50
): AuditLogRecord[] {
  const db = getDb();
  const clauses: string[] = [];
  const args: any[] = [];
  if (agentName) { clauses.push("agent_name = ?"); args.push(agentName); }
  if (tool) { clauses.push("tool = ?"); args.push(tool); }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  args.push(limit);
  const rows = db
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...args) as Array<Omit<AuditLogRecord, "params_json"> & { params_json: string | null }>;

  return rows.map((r) => {
    let parsed: Record<string, unknown> | null = null;
    if (r.params_json) {
      try {
        const decrypted = decryptContent(r.params_json);
        parsed = decrypted ? JSON.parse(decrypted) : null;
      } catch {
        parsed = { _parse_error: true };
      }
    }
    return { ...r, params_json: parsed };
  });
}

// --- Rate limiting (sliding window per agent per bucket) ---

/**
 * Record a hit and return the current count in the current window.
 * Returns { count, limit, allowed } — callers check .allowed.
 */
export function checkAndRecordRateLimit(
  agentName: string,
  bucket: string,
  limitPerHour: number
): { count: number; limit: number; allowed: boolean } {
  const db = getDb();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const nowIso = now();

  const row = db.prepare(
    "SELECT window_start, count FROM rate_limit_state WHERE agent_name = ? AND bucket = ?"
  ).get(agentName, bucket) as { window_start: string; count: number } | undefined;

  let newCount: number;
  let windowStart: string;

  if (!row || row.window_start < oneHourAgo) {
    // New window
    newCount = 1;
    windowStart = nowIso;
    db.prepare(
      "INSERT INTO rate_limit_state (agent_name, bucket, window_start, count) VALUES (?, ?, ?, ?) ON CONFLICT(agent_name, bucket) DO UPDATE SET window_start = excluded.window_start, count = excluded.count"
    ).run(agentName, bucket, windowStart, newCount);
  } else {
    // Same window, increment
    newCount = row.count + 1;
    db.prepare(
      "UPDATE rate_limit_state SET count = ? WHERE agent_name = ? AND bucket = ?"
    ).run(newCount, agentName, bucket);
  }

  return { count: newCount, limit: limitPerHour, allowed: newCount <= limitPerHour };
}

// --- Agent operations ---

// ---------------------------------------------------------------------------
// v2.1 Phase 7q (+ v2.1.3 addition) — sanctioned internal mutation helpers
// for the agents table.
//
// Every non-lifecycle caller that needs to DELETE / UPDATE the agents table
// (or its sidecar `agent_capabilities`) MUST go through one of these four
// helpers. The pre-publish drift-grep guard in scripts/pre-publish-check.sh
// rejects any raw `UPDATE agents` / `DELETE FROM agents` / `UPDATE|DELETE
// agent_capabilities` token outside src/db.ts (or a line carrying an explicit
// `// ALLOWLIST: <reason>` annotation for genuine one-offs).
//
// Rationale: the v2.1 Phase 7p HIGH #3 (SessionStart hook writing impossible
// active+null-hash rows) is exactly the class of bug that surfaces when the
// agents table has >1 mutation path. Consolidating the surface makes the
// next drift visible as a code-review artifact instead of a runtime incident.
//
// NOT replaced by these helpers (intentional):
//   - `registerAgent`      — owns its quadrifurcated state-aware UPDATE/INSERT
//                            with the Phase 7p recovery_token_hash CAS.
//   - `rotateAgentToken`   — owns its managed vs unmanaged branch + CAS on
//                            token_hash / previous_token_hash.
//   - `revokeAgentToken`   — owns its multi-source-state CAS (active +
//                            legacy_bootstrap + recovery_pending + rotation_grace).
//   - `unregisterAgent`    — owns the session_id-scoped CAS DELETE (v2.0.1
//                            Codex HIGH 1) and companion agent_capabilities
//                            delete. Forward-adoption of teardownAgent by
//                            unregisterAgent is v2.2+ if ever worth it.
//   - `migrateSchemaTo*`   — raw mutations during migrations are legitimate;
//                            the grep guard allow-lists the whole file.
// ---------------------------------------------------------------------------

/**
 * v2.1 Phase 7q — sanctioned teardown of an agent row.
 *
 * Owns the DELETE paths that are NOT session_id-scoped: `relay recover`
 * (operator-initiated forensic wipe of a stuck registration) and the
 * 30-day dead-agent purge inside `purgeOldRecords`. Each runs a single
 * transaction that removes the `agents` row AND its `agent_capabilities`
 * sidecar — consistent with the existing two-DELETE idiom those sites
 * already used inline.
 *
 * NO CAS. DELETE is idempotent by design: a missing row returns
 * changes=0, which is not an error in any caller's contract. The
 * session_id-scoped CAS DELETE is deliberately NOT folded here — that
 * path (`unregisterAgent`) protects against stale-SIGINT races which
 * teardownAgent callers by definition are not subject to (recover CLI
 * is operator-invoked; purge runs over rows that have been offline
 * >30 days, so there is no live session to race with).
 *
 * `reason` is telemetry-only in v2.1.0 — future cascade side-effects
 * (e.g. audit-log entry per teardown, fire `agent.torn_down` webhook)
 * can land inside this function keyed off `reason` without touching
 * every caller.
 */
export function teardownAgent(
  name: string,
  reason: "unregister" | "recover" | "stale_purge"
): void {
  const db = getDb();
  // Keep `reason` referenced so TS doesn't strip it — future cascade ops land here.
  void reason;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM agents WHERE name = ?").run(name);
    db.prepare("DELETE FROM agent_capabilities WHERE agent_name = ?").run(name);
  });
  tx();
}

/**
 * v2.1 Phase 7q — sanctioned auth-state transition.
 *
 * Per-row CAS UPDATE: predicate pins `auth_state = expectedFromState` and
 * optionally `token_hash IS expectedTokenHash` (NULL-safe match). Returns
 * `{ changed: true }` when the UPDATE hit exactly one row, `{ changed:
 * false }` when the source state drifted between the caller's pre-read
 * and this write (concurrent rotate/revoke/reissue lost the race).
 *
 * `updates` covers the auth-control fields the state machine can mutate
 * around a transition: token_hash, previous_token_hash,
 * rotation_grace_expires_at, recovery_token_hash, revoked_at. Metadata
 * fields (last_seen, agent_status, etc.) belong to `updateAgentMetadata`,
 * and `auth_state` itself is controlled via `toState` — there is a single
 * source of truth for each field.
 *
 * In v2.1.0 the only caller is `sweepExpiredRotationGrace` (rotation_grace
 * → active, clearing previous_token_hash + rotation_grace_expires_at).
 * rotateAgentToken + revokeAgentToken retain their existing multi-branch
 * CAS shapes per spec §2.2 — folding them now has cost + risk with no
 * invariant gain. Forward-adoption is v2.2+ if ever worth it.
 */
export function applyAuthStateTransition(
  name: string,
  expectedFromState: AuthStateInput,
  toState: AuthStateInput,
  updates: {
    token_hash?: string | null;
    previous_token_hash?: string | null;
    rotation_grace_expires_at?: string | null;
    recovery_token_hash?: string | null;
    revoked_at?: string | null;
  },
  expectedTokenHash?: string | null
): { changed: boolean } {
  const db = getDb();
  const setCols: string[] = ["auth_state = ?"];
  const setVals: unknown[] = [toState];
  for (const [col, val] of Object.entries(updates)) {
    if (val !== undefined) {
      setCols.push(`${col} = ?`);
      setVals.push(val);
    }
  }
  let whereClause = "name = ? AND auth_state = ?";
  const whereVals: unknown[] = [name, expectedFromState];
  if (expectedTokenHash !== undefined) {
    whereClause += " AND token_hash IS ?";
    whereVals.push(expectedTokenHash);
  }
  const sql = `UPDATE agents SET ${setCols.join(", ")} WHERE ${whereClause}`;
  const r = db.prepare(sql).run(...setVals, ...whereVals);
  return { changed: r.changes === 1 };
}

/**
 * v2.1 Phase 7q — sanctioned metadata-only update on an agent row.
 *
 * Handles last_seen touches, agent_status transitions (online/busy/away/
 * offline), and busy_expires_at TTL writes. These are non-auth-state
 * fields — they do not participate in the auth state machine, so there
 * is no CAS predicate. An empty-fields call is a safe no-op (does not
 * throw, does not run a degenerate SQL statement).
 *
 * Callers: `touchAgent` (last_seen bump on successful auth), `setAgentStatus`
 * (busy/away/online/offline), and forward-looking heartbeat paths that
 * want a single-site metadata writer.
 *
 * Returns true if any row was actually updated, false if the agent name
 * did not exist (so callers can surface a not-found signal if they care).
 * Empty-fields calls return true without running SQL.
 */
export function updateAgentMetadata(
  name: string,
  fields: {
    last_seen?: string;
    agent_status?: string;
    busy_expires_at?: string | null;
  }
): boolean {
  const db = getDb();
  const setCols: string[] = [];
  const vals: unknown[] = [];
  for (const [col, val] of Object.entries(fields)) {
    if (val !== undefined) {
      setCols.push(`${col} = ?`);
      vals.push(val);
    }
  }
  if (setCols.length === 0) return true;
  const r = db.prepare(
    `UPDATE agents SET ${setCols.join(", ")} WHERE name = ?`
  ).run(...vals, name);
  return r.changes > 0;
}

/**
 * v2.1.3 — sanctioned offline transition for a stdio terminal that is
 * exiting (SIGINT / SIGTERM).
 *
 * Replaces the v2.0.1 Codex HIGH 1 DELETE-on-SIGINT path. Preserves the
 * agent row + token_hash + capabilities + description + auth_state so a
 * subsequent Claude Code terminal with the same RELAY_AGENT_NAME can
 * re-register through the existing active-state path with its existing
 * token — no operator ceremony, no lost identity, no webhook noise.
 *
 * CAS predicate: `name = ? AND session_id = ?`. A concurrent terminal
 * that rotated session_id between our SIGINT capture and this call wins
 * the race — CAS returns `{ changed: false }` and we no-op. This is the
 * exact concurrent-instance-wipe protection the v2.0.1 HIGH 1 fix
 * shipped; it remains intact because the new semantic is "clear MY
 * session identity, not someone else's."
 *
 * Mutations on CAS hit:
 *   - session_id = NULL           (bootstrap-ready for next terminal)
 *   - agent_status = 'offline'    (declared lifecycle state)
 *   - busy_expires_at = NULL      (offline overrides busy shield)
 *
 * Deliberately preserved:
 *   - token_hash / auth_state / capabilities / agent_capabilities
 *   - description / role / created_at / managed / visibility
 *   - last_seen (carries the "when was the agent truly active" signal;
 *     the offline marker lives on agent_status now)
 *
 * Callers: `performAutoUnregister` in src/transport/stdio.ts. No other
 * callers expected. Explicit `unregister_agent` MCP tool + `relay recover`
 * CLI continue to route through `unregisterAgent` / `teardownAgent` (they
 * are deliberate operator actions with delete semantics).
 */
export function markAgentOffline(
  name: string,
  expectedSessionId: string
): { changed: boolean } {
  const db = getDb();
  const r = db.prepare(
    "UPDATE agents SET session_id = NULL, agent_status = 'offline', busy_expires_at = NULL " +
    "WHERE name = ? AND session_id = ?"
  ).run(name, expectedSessionId);
  return { changed: r.changes === 1 };
}

/**
 * v2.1.4 (I11) — sanctioned additive cap expansion.
 *
 * Rules enforced here (belt + handler-layer suspenders):
 *   1. Agent row must exist. Missing → throws "NOT_FOUND" (handler maps).
 *   2. `newCapabilities` must be a SUPERSET of the current caps. Any cap in
 *      the current set missing from the request is a reduction attempt →
 *      throws "REDUCTION_NOT_ALLOWED".
 *   3. If the diff (new \ current) is empty → throws "NO_OP_EXPANSION".
 *   4. Otherwise: single transaction writes the union to agents.capabilities
 *      (JSON column) AND inserts the missing caps into agent_capabilities.
 *
 * Why both columns: `agents.capabilities` is the legacy JSON surface read by
 * the registerAgent + discover paths. `agent_capabilities` is the v2.0-normalized
 * sidecar used by post_task_auto routing. Both must stay consistent — same
 * two-column discipline registerAgent uses at bootstrap.
 *
 * No CAS on the JSON column. Concurrent expand_capabilities on the same row
 * is vanishingly rare (the caller must hold the agent's own token) and the
 * worst-case outcome of a race is "one of the two concurrent expansions gets
 * re-applied"; the result is still a superset of the starting set.
 *
 * Throws typed string errors (matching ERROR_CODES) so the handler can map
 * them to structured responses.
 */
export function expandAgentCapabilities(
  name: string,
  newCapabilities: string[]
): { added: string[]; current: string[] } {
  const db = getDb();
  const row = db.prepare("SELECT capabilities FROM agents WHERE name = ?").get(name) as
    | { capabilities: string }
    | undefined;
  if (!row) {
    throw new Error("NOT_FOUND");
  }
  let currentCaps: string[];
  try {
    currentCaps = JSON.parse(row.capabilities) as string[];
  } catch {
    currentCaps = [];
  }
  const currentSet = new Set(currentCaps);
  const requestedSet = new Set(newCapabilities);
  // Reduction check: every current cap must appear in the request.
  for (const c of currentSet) {
    if (!requestedSet.has(c)) {
      throw new Error("REDUCTION_NOT_ALLOWED");
    }
  }
  const added = newCapabilities.filter((c) => !currentSet.has(c));
  if (added.length === 0) {
    throw new Error("NO_OP_EXPANSION");
  }
  const unionCaps = Array.from(new Set([...currentCaps, ...newCapabilities]));
  const unionJson = JSON.stringify(unionCaps);
  const tx = db.transaction(() => {
    db.prepare("UPDATE agents SET capabilities = ? WHERE name = ?").run(unionJson, name);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO agent_capabilities (agent_name, capability) VALUES (?, ?)"
    );
    for (const cap of added) {
      insert.run(name, cap);
    }
  });
  tx();
  return { added, current: unionCaps };
}

/**
 * Register (or re-register) an agent.
 *
 * v1.7 behavior:
 * - First registration: generate a new token, store its hash, return the raw
 *   token in `.plaintext_token` (shown ONCE to the caller, never again).
 * - Re-registration of an existing agent: role is updated, but capabilities
 *   and the existing token_hash are PRESERVED. This lets the SessionStart
 *   hook safely upsert on every terminal open without rotating tokens.
 *
 * v1.7.1 change: capabilities are IMMUTABLE after first registration. The
 *   `capabilities` argument is IGNORED on re-register — the returned agent
 *   reflects the preserved (existing) caps. To change caps, unregister then
 *   re-register. Auth of the re-register caller is enforced at the dispatcher;
 *   this function preserves caps as defense-in-depth regardless.
 *
 * - Legacy agents (registered pre-v1.7, token_hash = NULL): re-registration
 *   generates a token for them (one-time migration path). Returns the token.
 */
export function registerAgent(
  name: string,
  role: string,
  capabilities: string[],
  options: {
    description?: string;
    managed?: boolean;
    /** v2.2.0: window title for the dashboard click-to-focus driver. Mutable on re-register. */
    terminal_title_ref?: string | null;
    /**
     * v2.2.1 B2: `force` flag IS exposed on the MCP surface (see
     * RegisterAgentSchema in src/types.ts). Collision enforcement policy
     * lives at the HANDLER layer (handleRegisterAgent), not the DB
     * layer — direct db.registerAgent callers (tests, relay recover
     * internals, migrations) bypass the collision check by design.
     * Default false → handler rejects active-row re-registers with
     * NAME_COLLISION_ACTIVE unless caller explicitly opts in.
     */
    force?: boolean;
    /**
     * v2.1 Phase 7p HIGH #2: when set, pins the CAS predicate to exactly this
     * recovery_token_hash value (on the recovery_pending → active transition).
     * The dispatcher stores its verified hash here so a concurrent admin
     * reissue that lands between verify and UPDATE fails the CAS — the old
     * ticket cannot win the race. `undefined` means "not a recovery flow,
     * anchor on the fresh SELECT value" (preserves behavior for active /
     * legacy_bootstrap branches).
     */
    expectedRecoveryHash?: string | null;
  } = {}
): { agent: AgentWithStatus; plaintext_token: string | null; auto_assigned: QueuedAssignment[] } {
  const db = getDb();
  const timestamp = now();
  const capsJson = JSON.stringify(capabilities);
  // v2.0 final (#6): rotate session_id on EVERY register_agent call. A new
  // terminal = a new session = previously-read messages reappear. This is
  // the fix for the bug Victra hit when the prior session's terminal had
  // already marked her Codex audit message as read.
  const session_id = uuidv4();

  const existing = db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as AgentRecord | undefined;

  let agentWithStatus: AgentWithStatus;
  let plaintext_token: string | null = null;

  if (existing) {
    // v2.0.1 (Codex MEDIUM 5): warn when we're about to overwrite an ONLINE
    // session. Two concurrent terminals with the same RELAY_AGENT_NAME
    // silently race — pre-v2.2.1 this rotated session_id + dropped mail
    // on the losing terminal. v2.2.1 B2 adds a hard-reject at the HANDLER
    // layer (handleRegisterAgent → isActiveCollision) so MCP-dispatched
    // callers get NAME_COLLISION_ACTIVE; direct db.registerAgent callers
    // (tests, internal helpers, relay recover) bypass. The warn below
    // preserves observability on the legacy path + is harmless on the
    // enforced path (won't fire because the handler rejects first).
    const ageMinutes = (Date.now() - new Date(existing.last_seen).getTime()) / 60_000;
    if (ageMinutes < 10 && existing.session_id && !options.force) {
      log.warn(
        `[register] agent "${name}" had an online session (${existing.session_id}) ` +
        `within the last 10 minutes. Its session is being rotated to a new UUID by this register call. ` +
        `If you intended to run two concurrent terminals as "${name}", give them distinct RELAY_AGENT_NAME values — ` +
        `session state cannot be shared across concurrent instances with the same name.`
      );
    }
    // v2.1 Phase 4b.1 v2: state-branched re-register. Source state dictates
    // whether we mint a new token (legacy_bootstrap, recovery_pending) or
    // preserve the existing one (active). Revoked rows never reach here —
    // the dispatcher rejects them before the handler runs.
    const existingState = (existing.auth_state ?? "active") as
      | "active"
      | "legacy_bootstrap"
      | "revoked"
      | "recovery_pending";
    let newHash = existing.token_hash;
    let newAuthState = existingState;
    let newRecoveryHash: string | null = existing.recovery_token_hash ?? null;
    let newRevokedAt: string | null = existing.revoked_at ?? null;

    if (existingState === "legacy_bootstrap" || existingState === "recovery_pending") {
      plaintext_token = generateToken();
      newHash = hashToken(plaintext_token);
      newAuthState = "active";
      newRecoveryHash = null;
      newRevokedAt = null;
    }
    // Defensive: if somehow an active row arrives with null token_hash (pre-
    // migration bug), mint one. Cannot happen in the post-migration model.
    if (existingState === "active" && !newHash) {
      plaintext_token = generateToken();
      newHash = hashToken(plaintext_token);
    }

    // v2.0 final (#29): description is mutable on re-register. If caller
    // provided one, update it; otherwise preserve.
    const newDescription = options.description !== undefined ? options.description : existing.description ?? null;

    // v2.1 Phase 4b.1 v2 CAS (extends spec §3.3 with token_hash-IS predicate).
    // Closes MED E: a concurrent rotate_token landing between the dispatcher's
    // auth check and this UPDATE would flip token_hash; without token_hash in
    // the CAS, this UPDATE would silently write the old hash back, undoing the
    // rotate. SQLite's `IS` operator matches NULL-to-NULL so the
    // legacy_bootstrap branch (existing.token_hash = NULL) also matches.
    //
    // v2.1 Phase 7p HIGH #2: anchor recovery_token_hash in the CAS too. For
    // the recovery_pending → active transition, prefer the dispatcher-verified
    // hash (options.expectedRecoveryHash) over our own fresh SELECT — this is
    // what closes the verify-then-reissue race: if admin reissued between
    // dispatcher verify and this UPDATE, the stored recovery_token_hash no
    // longer matches the hash the ticket was verified against, and CAS fails.
    // For other transitions, anchor on existing.recovery_token_hash (our
    // SELECT) — active and legacy_bootstrap branches have no recovery hash
    // to race on, so this is belt-and-suspenders.
    const casRecoveryHash =
      options.expectedRecoveryHash !== undefined
        ? options.expectedRecoveryHash
        : existing.recovery_token_hash ?? null;
    // v2.1.6: session_started_at is rotated in lockstep with session_id. The
    // new timestamp anchors the `session_start` sentinel on subsequent
    // get_messages / get_messages_summary calls from this session.
    // v2.2.0: terminal_title_ref is mutable on re-register — if caller passes
    // an explicit value it replaces the stored one; if omitted (undefined)
    // the prior value is preserved. Passing explicit null clears it.
    const newTitleRef =
      options.terminal_title_ref !== undefined
        ? options.terminal_title_ref
        : existing.terminal_title_ref ?? null;
    const r = db.prepare(
      "UPDATE agents SET role = ?, last_seen = ?, token_hash = ?, session_id = ?, session_started_at = ?, description = ?, " +
      "terminal_title_ref = ?, " +
      "auth_state = ?, recovery_token_hash = ?, revoked_at = ? " +
      "WHERE name = ? AND auth_state = ? AND token_hash IS ? AND recovery_token_hash IS ?"
    ).run(
      role, timestamp, newHash, session_id, timestamp, newDescription,
      newTitleRef,
      newAuthState, newRecoveryHash, newRevokedAt,
      name, existingState, existing.token_hash, casRecoveryHash
    );
    if (r.changes !== 1) {
      throw new ConcurrentUpdateError(
        `register_agent failed for "${name}": auth_state / token_hash / recovery_token_hash changed since we read it (concurrent rotate_token / revoke_token / unregister_agent / recovery reissue). Re-auth and retry.`
      );
    }

    agentWithStatus = toAgentWithStatus({
      ...existing,
      role,
      last_seen: timestamp,
      token_hash: newHash,
      session_id,
      description: newDescription,
      terminal_title_ref: newTitleRef,
      auth_state: newAuthState,
      recovery_token_hash: newRecoveryHash,
      revoked_at: newRevokedAt,
    });
  } else {
    // First registration — always generate a token.
    plaintext_token = generateToken();
    const token_hash = hashToken(plaintext_token);
    const id = uuidv4();
    const description = options.description ?? null;
    // v2.1 Phase 4b.2: managed flag captured at first registration + immutable
    // thereafter (same rule as capabilities per v1.7.1). Default 0.
    const managed = options.managed ? 1 : 0;
    const titleRef = options.terminal_title_ref ?? null;
    db.prepare(
      // v2.1.3 (I6): default agent_status is now 'idle' (was 'online').
      // v2.1.6: session_started_at = timestamp for first-register anchor.
      // v2.2.0: terminal_title_ref captured on first register (may be null).
      "INSERT INTO agents (id, name, role, capabilities, last_seen, created_at, token_hash, session_id, session_started_at, description, agent_status, managed, terminal_title_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)"
    ).run(id, name, role, capsJson, timestamp, timestamp, token_hash, session_id, timestamp, description, managed, titleRef);

    // v2.0: populate normalized agent_capabilities table.
    const insertCap = db.prepare("INSERT OR IGNORE INTO agent_capabilities (agent_name, capability) VALUES (?, ?)");
    for (const cap of capabilities) {
      if (cap) insertCap.run(name, cap);
    }

    agentWithStatus = toAgentWithStatus({
      id,
      name,
      role,
      capabilities: capsJson,
      last_seen: timestamp,
      created_at: timestamp,
      token_hash,
      session_id,
      description,
      agent_status: "idle", // v2.1.3 (I6)
      managed,
      terminal_title_ref: titleRef,
    });
  }

  // v2.0 beta.1 (Codex HIGH 4): auto-assign queued tasks at the DB layer so
  // every caller of registerAgent (tool handler, future hooks, direct scripts)
  // gets the sweep. Handler layer remains responsible for firing webhooks off
  // the returned list — circular-import-safe.
  const auto_assigned = tryAssignQueuedTasksTo(agentWithStatus.name, agentWithStatus.capabilities);

  return { agent: agentWithStatus, plaintext_token, auto_assigned };
}

/** Fetch an agent's auth record (includes token_hash) by name. */
/**
 * v2.1 Phase 4b.1 — rotate an agent's token under CAS. The caller-proven
 * current hash goes into the WHERE clause; two concurrent rotations AND a
 * rotate-racing-revoke scenario all collapse to one winner + one
 * ConcurrentUpdateError. Returns the fresh plaintext token (shown ONCE).
 */
/**
 * v2.1 Phase 4b.2 — outcome signal for rotate callers. `agentClass` tells
 * the handler how to shape its response: managed → grace window + push
 * message; unmanaged → new token + restart_required advice.
 */
export interface RotationOutcome {
  newPlaintextToken: string;
  newHash: string;
  agentClass: "managed" | "unmanaged";
  graceExpiresAt: string | null;
}

/**
 * v2.1 Phase 4b.2 — default grace window in seconds (15 minutes).
 * Overridable per-call via the `graceSeconds` option.
 */
function getDefaultGraceSeconds(): number {
  const raw = parseInt(process.env.RELAY_ROTATION_GRACE_SECONDS || "900", 10);
  if (!Number.isFinite(raw) || raw < 0) return 900;
  return Math.max(0, Math.min(3600, raw));
}

export function rotateAgentToken(
  name: string,
  expectedOldHash: string,
  options: { graceSeconds?: number } = {}
): RotationOutcome {
  const db = getDb();
  const newPlaintextToken = generateToken();
  const newHash = hashToken(newPlaintextToken);

  // Look up the agent's `managed` flag to decide which CAS path applies.
  const row = db
    .prepare("SELECT managed FROM agents WHERE name = ? AND auth_state = 'active'")
    .get(name) as { managed: number } | undefined;
  if (!row) {
    throw new ConcurrentUpdateError(
      `rotate_token failed for "${name}": no active row (concurrent revoke_token / unregister_agent, or recovery_pending target). Re-auth and retry.`
    );
  }

  const isManaged = row.managed === 1;
  if (isManaged) {
    // Managed path — swap hashes + enter rotation_grace. Old hash preserved
    // in previous_token_hash; both valid until rotation_grace_expires_at.
    const graceSec = options.graceSeconds !== undefined
      ? Math.max(0, Math.min(3600, options.graceSeconds))
      : getDefaultGraceSeconds();
    const graceExpiresAt = new Date(Date.now() + graceSec * 1000).toISOString();

    if (graceSec === 0) {
      // Hard-cut — no grace column, skip straight to active with new hash.
      const r = db
        .prepare(
          "UPDATE agents SET token_hash = ? WHERE name = ? AND token_hash = ? AND auth_state = 'active' AND managed = 1"
        )
        .run(newHash, name, expectedOldHash);
      if (r.changes !== 1) {
        throw new ConcurrentUpdateError(
          `rotate_token failed for "${name}": state or hash changed mid-flight. Re-auth and retry.`
        );
      }
      return { newPlaintextToken, newHash, agentClass: "managed", graceExpiresAt: null };
    }

    const r = db
      .prepare(
        `UPDATE agents SET
           token_hash = ?,
           previous_token_hash = token_hash,
           auth_state = 'rotation_grace',
           rotation_grace_expires_at = ?
         WHERE name = ?
           AND auth_state = 'active'
           AND token_hash = ?
           AND managed = 1`
      )
      .run(newHash, graceExpiresAt, name, expectedOldHash);
    if (r.changes !== 1) {
      throw new ConcurrentUpdateError(
        `rotate_token failed for "${name}": state or hash changed mid-flight (concurrent rotate / revoke / unregister). Re-auth and retry.`
      );
    }
    return { newPlaintextToken, newHash, agentClass: "managed", graceExpiresAt };
  }

  // Unmanaged path — straight swap, no grace, no push.
  const r = db
    .prepare(
      "UPDATE agents SET token_hash = ? WHERE name = ? AND token_hash = ? AND auth_state = 'active' AND managed = 0"
    )
    .run(newHash, name, expectedOldHash);
  if (r.changes !== 1) {
    throw new ConcurrentUpdateError(
      `rotate_token failed for "${name}": token_hash or auth_state changed since we read it (concurrent rotate_token / revoke_token / unregister_agent). Re-auth and retry.`
    );
  }
  return { newPlaintextToken, newHash, agentClass: "unmanaged", graceExpiresAt: null };
}

/**
 * v2.1 Phase 4b.2 — admin-initiated rotation across agents. Authorization
 * (rotate_others capability) is enforced upstream by the dispatcher; this
 * function trusts the rotator was cap-checked. Behavior mirrors
 * self-rotation but omits the `token_hash = ?` predicate (admin doesn't
 * know the target's old token).
 */
export function rotateAgentTokenAdmin(
  targetName: string,
  options: { graceSeconds?: number } = {}
): RotationOutcome {
  const db = getDb();
  const row = db
    .prepare("SELECT managed FROM agents WHERE name = ? AND auth_state = 'active'")
    .get(targetName) as { managed: number } | undefined;
  if (!row) {
    throw new ConcurrentUpdateError(
      `rotate_token_admin failed for "${targetName}": target is not in auth_state='active' (nonexistent, revoked, recovery_pending, or mid-rotation).`
    );
  }

  const newPlaintextToken = generateToken();
  const newHash = hashToken(newPlaintextToken);
  const isManaged = row.managed === 1;

  if (isManaged) {
    const graceSec = options.graceSeconds !== undefined
      ? Math.max(0, Math.min(3600, options.graceSeconds))
      : getDefaultGraceSeconds();
    const graceExpiresAt = new Date(Date.now() + graceSec * 1000).toISOString();

    if (graceSec === 0) {
      const r = db
        .prepare(
          "UPDATE agents SET token_hash = ? WHERE name = ? AND auth_state = 'active' AND managed = 1"
        )
        .run(newHash, targetName);
      if (r.changes !== 1) {
        throw new ConcurrentUpdateError(
          `rotate_token_admin failed for "${targetName}": target state changed mid-flight.`
        );
      }
      return { newPlaintextToken, newHash, agentClass: "managed", graceExpiresAt: null };
    }

    const r = db
      .prepare(
        `UPDATE agents SET
           token_hash = ?,
           previous_token_hash = token_hash,
           auth_state = 'rotation_grace',
           rotation_grace_expires_at = ?
         WHERE name = ?
           AND auth_state = 'active'
           AND managed = 1`
      )
      .run(newHash, graceExpiresAt, targetName);
    if (r.changes !== 1) {
      throw new ConcurrentUpdateError(
        `rotate_token_admin failed for "${targetName}": target state changed mid-flight.`
      );
    }
    return { newPlaintextToken, newHash, agentClass: "managed", graceExpiresAt };
  }

  const r = db
    .prepare(
      "UPDATE agents SET token_hash = ? WHERE name = ? AND auth_state = 'active' AND managed = 0"
    )
    .run(newHash, targetName);
  if (r.changes !== 1) {
    throw new ConcurrentUpdateError(
      `rotate_token_admin failed for "${targetName}": target state changed mid-flight.`
    );
  }
  return { newPlaintextToken, newHash, agentClass: "unmanaged", graceExpiresAt: null };
}

/**
 * v2.1 Phase 4b.2 — grace-window cleanup. Called via the shared piggyback
 * tick in server.ts. Transitions every expired `rotation_grace` row back to
 * `active`, clearing `previous_token_hash` + `rotation_grace_expires_at`.
 * Idempotent: rows already cleaned up match no WHERE clause.
 */
export function sweepExpiredRotationGrace(): number {
  const db = getDb();
  const now = new Date().toISOString();
  // v2.1 Phase 7q: route through the sanctioned applyAuthStateTransition
  // helper to preserve the invariant-surface discipline (no raw UPDATE
  // agents outside sanctioned helpers). Per-row CAS catches the edge case
  // where an admin rotates or revokes a row mid-sweep — that row's CAS
  // silently returns changed=false and the sweep moves on. N is tiny in
  // practice (agents in grace at any moment), so the loop cost is fine.
  const expired = db.prepare(
    `SELECT name FROM agents
     WHERE auth_state = 'rotation_grace'
       AND rotation_grace_expires_at IS NOT NULL
       AND rotation_grace_expires_at <= ?`
  ).all(now) as Array<{ name: string }>;
  let swept = 0;
  for (const row of expired) {
    const r = applyAuthStateTransition(
      row.name,
      "rotation_grace",
      "active",
      {
        previous_token_hash: null,
        rotation_grace_expires_at: null,
      }
    );
    if (r.changed) swept++;
  }
  return swept;
}

/**
 * v2.1 Phase 4b.1 v2 — transition the target's auth_state to `revoked` or
 * `recovery_pending`. NEVER nulls token_hash (preserved for forensics + CAS
 * integrity). With `issueRecovery: true`, mints a one-time recovery_token
 * (bcrypt-hashed into recovery_token_hash) that the operator can present via
 * `register_agent(recovery_token=...)` to transition back to `active`.
 *
 * CAS: source state must be in {active, legacy_bootstrap, recovery_pending}.
 * Repeat calls against a `revoked` row return `{ revoked: false }` silently.
 * Re-calls against a `recovery_pending` row with issueRecovery=true rotate
 * the recovery_token_hash (operational support for "operator lost the first
 * ticket" — `wasReissue: true` lets the audit log distinguish "first revoke"
 * from "lost-ticket reissue").
 */
export function revokeAgentToken(
  targetName: string,
  options: { issueRecovery: boolean } = { issueRecovery: false }
): { revoked: boolean; recoveryToken: string | null; wasReissue: boolean } {
  const db = getDb();
  const revokedAt = now();
  let recoveryToken: string | null = null;
  let recoveryHash: string | null = null;
  let newState: "revoked" | "recovery_pending" = "revoked";

  if (options.issueRecovery) {
    recoveryToken = generateToken();
    recoveryHash = hashToken(recoveryToken);
    newState = "recovery_pending";
  }

  // Read the pre-write state so we can report `wasReissue` accurately.
  const preRow = db
    .prepare("SELECT auth_state FROM agents WHERE name = ?")
    .get(targetName) as { auth_state: string } | undefined;
  const wasReissue = preRow?.auth_state === "recovery_pending" && options.issueRecovery;

  // CAS: v2.1 Phase 4b.2 — `rotation_grace` joins the allowed source set.
  // Spec §4.4 test 3: revoke during rotation_grace invalidates both the old
  // AND new token atomically → state flips, previous_token_hash cleared,
  // rotation_grace_expires_at cleared. Revoked rows remain terminal
  // (idempotent no-op on repeat calls).
  const r = db.prepare(
    "UPDATE agents " +
    "SET auth_state = ?, revoked_at = ?, recovery_token_hash = ?, " +
    "    previous_token_hash = NULL, rotation_grace_expires_at = NULL " +
    "WHERE name = ? AND auth_state IN ('active','legacy_bootstrap','recovery_pending','rotation_grace')"
  ).run(newState, revokedAt, recoveryHash, targetName);

  return {
    revoked: r.changes > 0,
    recoveryToken: r.changes > 0 ? recoveryToken : null,
    wasReissue,
  };
}

export function getAgentAuthData(name: string): AgentRecord | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as AgentRecord | undefined;
  return row ?? null;
}

/**
 * v2.0.1 (Codex HIGH 1): optional `expectedSessionId` scopes the delete so a
 * stale stdio process cannot wipe a fresh session of the same agent name.
 * When supplied and the stored session_id doesn't match, no row is deleted
 * and the function returns `false` silently — the old process exits cleanly
 * without touching the new session's registration.
 *
 * Manual `unregister_agent` MCP calls pass no session_id — they are explicit
 * operator actions and still wipe by name. The auto-unregister SIGINT handler
 * passes its captured session_id.
 */
export function unregisterAgent(name: string, expectedSessionId?: string): boolean {
  const db = getDb();
  let result: { changes: number };
  if (expectedSessionId) {
    result = db.prepare(
      "DELETE FROM agents WHERE name = ? AND session_id = ?"
    ).run(name, expectedSessionId);
  } else {
    result = db.prepare("DELETE FROM agents WHERE name = ?").run(name);
  }
  // Only clean up normalized capabilities when the agent row actually went
  // away — important for the session_id-scoped case where we might not have
  // deleted anything.
  if (result.changes > 0) {
    db.prepare("DELETE FROM agent_capabilities WHERE agent_name = ?").run(name);
  }
  return result.changes > 0;
}

/** Look up the current session_id for an agent. Returns null if the agent doesn't exist. */
export function getAgentSessionId(name: string): string | null {
  const db = getDb();
  const row = db.prepare("SELECT session_id FROM agents WHERE name = ?").get(name) as { session_id: string | null } | undefined;
  return row?.session_id ?? null;
}

/**
 * v2.0 final (#26) + v2.1.3 (I6): set the agent's operational status.
 *  - idle (default): normal active state, eligible for health-monitor reassignment
 *  - working: actively executing — health monitor skips reassignment
 *  - blocked: cannot proceed (missing input / dependency) — health monitor skips
 *  - waiting_user: paused pending operator input — health monitor skips
 *  - offline: graceful shutdown signal
 *
 * `stale` is NOT a valid set_status value — it is a relay-computed observation
 * (deriveAgentStatus flips idle/working/blocked/waiting_user → stale after 5 min
 * of last_seen silence, → offline after 30 min). Callers may pass it directly
 * at the db layer for testing; production code should avoid it.
 *
 * Returns true if the agent existed and the status was updated.
 */
/** Accepted by setAgentStatus — new v2.1.3 enum plus legacy aliases. */
type SetStatusValue =
  | "idle"
  | "working"
  | "blocked"
  | "waiting_user"
  | "stale"
  | "offline"
  // legacy aliases — normalized internally to idle/working/blocked
  | "online"
  | "busy"
  | "away";

const LEGACY_SET_STATUS_NORMALIZE: Record<string, "idle" | "working" | "blocked" | "waiting_user" | "stale" | "offline"> = {
  online: "idle",
  busy: "working",
  away: "blocked",
  idle: "idle",
  working: "working",
  blocked: "blocked",
  waiting_user: "waiting_user",
  stale: "stale",
  offline: "offline",
};

export function setAgentStatus(name: string, status: SetStatusValue): boolean {
  // v2.1.3 (I6): normalize legacy aliases. Callers at the db layer (tests,
  // scripts, handlers that bypass the tool-handler normalization) can pass
  // either enum.
  const normalized = LEGACY_SET_STATUS_NORMALIZE[status] ?? "idle";
  // v2.0.1 (Codex HIGH 2) + v2.1.3: the busy_expires_at TTL applies to states
  // that exempt the agent from health-monitor reassignment (working / blocked /
  // waiting_user). Without a TTL a crashed agent's shield would persist until
  // the 30-day dead-agent purge. Offline / idle / stale clear the expiry.
  let expiresAt: string | null = null;
  if (normalized === "working" || normalized === "blocked" || normalized === "waiting_user") {
    const ttlMinutes = parseInt(process.env.RELAY_BUSY_TTL_MINUTES || "240", 10);
    const ttlMs = (Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : 240) * 60 * 1000;
    expiresAt = new Date(Date.now() + ttlMs).toISOString();
  }
  // v2.1 Phase 7q: route through the sanctioned updateAgentMetadata helper
  // so every non-auth-state field write lands in one place.
  return updateAgentMetadata(name, {
    agent_status: normalized,
    busy_expires_at: expiresAt,
  });
}

export interface HealthSnapshot {
  status: "ok";
  agent_count: number;
  message_count_pending: number;
  task_count_active: number;
  task_count_queued: number;
  channel_count: number;
}

/**
 * v2.0 final (#20): counts for the health_check tool. Cheap — one SELECT
 * COUNT each, runs on every caller's request.
 */
export function getHealthSnapshot(): HealthSnapshot {
  const db = getDb();
  const agentCount = (db.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }).c;
  const messageCountPending = (db.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE read_by_session IS NULL"
  ).get() as { c: number }).c;
  const taskCountActive = (db.prepare(
    "SELECT COUNT(*) AS c FROM tasks WHERE status IN ('posted','accepted')"
  ).get() as { c: number }).c;
  const taskCountQueued = (db.prepare(
    "SELECT COUNT(*) AS c FROM tasks WHERE status = 'queued'"
  ).get() as { c: number }).c;
  const channelCount = (db.prepare("SELECT COUNT(*) AS c FROM channels").get() as { c: number }).c;
  return {
    status: "ok",
    agent_count: agentCount,
    message_count_pending: messageCountPending,
    task_count_active: taskCountActive,
    task_count_queued: taskCountQueued,
    channel_count: channelCount,
  };
}

export function touchAgent(name: string): void {
  // v2.1 Phase 7q: route through the sanctioned updateAgentMetadata helper.
  updateAgentMetadata(name, { last_seen: now() });
  // NOTE (v2.0 beta.1, Codex HIGH 3): this function bumps only agents.last_seen.
  // Task leases (tasks.lease_renewed_at) are renewed ONLY by task-specific
  // actions on that task (accept, heartbeat, complete/reject/cancel on the
  // same row). An agent cannot keep an abandoned task alive by doing unrelated
  // work — the lease is a per-task liveness signal, not a per-agent one.
}

/**
 * v2.1.4 (I12): read-only query for `get_standup`. Returns all messages whose
 * `created_at >= sinceIso`, newest first, decrypted. Unlike `getMessages` this
 * does NOT touch the read_by_session column — standup is observation, not
 * consumption.
 */
export function getMessagesInWindow(sinceIso: string, limit: number = 1000): MessageRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM messages WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(sinceIso, limit) as MessageRecord[];
  return rows.map((r) => ({ ...r, content: decryptContent(r.content) ?? r.content }));
}

/**
 * v2.1.4 (I12): read-only query for `get_standup`. Returns all tasks whose
 * `updated_at >= sinceIso` OR whose status is still active (queued / posted /
 * accepted). The standup reports completed_in_window separately from
 * queued/blocked, so we pull a superset and let the caller partition.
 * Descriptions + results decrypted at read.
 */
export function getTasksInWindow(sinceIso: string, limit: number = 1000): TaskRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM tasks WHERE updated_at >= ? OR status IN ('queued', 'posted', 'accepted') " +
        "ORDER BY updated_at DESC LIMIT ?"
    )
    .all(sinceIso, limit) as TaskRecord[];
  return rows.map((r) => ({
    ...r,
    description: decryptContent(r.description) ?? r.description,
    result: r.result ? decryptContent(r.result) ?? r.result : null,
  }));
}

export function getAgents(role?: string): AgentWithStatus[] {
  const db = getDb();
  let rows: AgentRecord[];

  if (role) {
    rows = db.prepare("SELECT * FROM agents WHERE role = ? ORDER BY last_seen DESC").all(role) as AgentRecord[];
  } else {
    rows = db.prepare("SELECT * FROM agents ORDER BY last_seen DESC").all() as AgentRecord[];
  }

  return rows.map(toAgentWithStatus);
}

// --- Message operations ---

export function sendMessage(
  from: string,
  to: string,
  content: string,
  priority: string
): MessageRecord {
  const db = getDb();

  // v2.1.3 (I9 bonus): verify the sender row exists BEFORE inserting. Pre-
  // v2.1.3 this call relied on `touchAgent(from)` silently no-op'ing when
  // the row was missing + INSERTing the message anyway. That path masked
  // the curl-wedge symptom during the 2026-04-20 multi-agent session: a
  // curl-fallback sender whose row had been deleted mid-session got
  // successful-looking responses with last_seen frozen. Now we surface a
  // typed error the dispatcher classifies as SENDER_NOT_REGISTERED.
  //
  // The dispatcher already verifies the from-agent exists at auth time,
  // but this defense-in-depth check catches the narrow race where a
  // sibling process (SIGINT / recover CLI / unregister tool) deletes the
  // sender row between dispatcher auth and handler write.
  //
  // Exception: "system" is the well-known sentinel for relay-authored
  // messages (spawn initial_message, future system push notifications).
  // It is intentionally not a registered agent — the sentinel just marks
  // "this message came from the infrastructure, not an agent." No
  // touchAgent + no sender check for system.
  if (from === "system") {
    const id = uuidv4();
    const timestamp = now();
    const encContent = encryptContent(content);
    db.prepare(
      "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
    ).run(id, from, to, encContent, priority, timestamp);
    return { id, from_agent: from, to_agent: to, content, priority, status: "pending", created_at: timestamp };
  }

  const senderExists = db
    .prepare("SELECT 1 FROM agents WHERE name = ?")
    .get(from) as { 1: number } | undefined;
  if (!senderExists) {
    throw new SenderNotRegisteredError(from);
  }

  touchAgent(from);

  const id = uuidv4();
  const timestamp = now();
  const encContent = encryptContent(content); // v1.7: encrypt at rest if RELAY_ENCRYPTION_KEY set

  db.prepare(
    "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
  ).run(id, from, to, encContent, priority, timestamp);

  return { id, from_agent: from, to_agent: to, content, priority, status: "pending", created_at: timestamp };
}

export function getMessages(
  agentName: string,
  status: string,
  limit: number
): MessageRecord[] {
  const db = getDb();
  // No touchAgent here — observation is not liveness (v1.3 presence fix)

  // v2.0 final (#6): session-aware read receipts. Look up the caller's
  // current session_id so we can filter + mark per-session.
  const agentRow = db.prepare("SELECT session_id FROM agents WHERE name = ?").get(agentName) as { session_id: string | null } | undefined;
  const currentSession = agentRow?.session_id ?? null;

  let rows: MessageRecord[];

  const priorityOrder = `ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END, created_at DESC LIMIT ?`;

  if (status === "all") {
    rows = db.prepare(
      `SELECT * FROM messages WHERE to_agent = ? ${priorityOrder}`
    ).all(agentName, limit) as MessageRecord[];
  } else if (status === "read") {
    // "read" = this session has already observed these messages.
    rows = db.prepare(
      `SELECT * FROM messages WHERE to_agent = ?
         AND read_by_session IS NOT NULL
         AND read_by_session = ?
         ${priorityOrder}`
    ).all(agentName, currentSession ?? "", limit) as MessageRecord[];
  } else {
    // "pending" = never read, OR read by a different session. This is the
    // core of the fix: a fresh terminal session (new session_id) sees
    // previously-read messages again, so handovers do not drop mail.
    rows = db.prepare(
      `SELECT * FROM messages WHERE to_agent = ?
         AND (read_by_session IS NULL OR read_by_session != ?)
         ${priorityOrder}`
    ).all(agentName, currentSession ?? "", limit) as MessageRecord[];
  }

  // Mark messages as read by THIS session. The old binary `status` column
  // remains populated for back-compat readers but is no longer authoritative.
  if (rows.length > 0 && currentSession && status !== "read") {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE messages SET status = 'read', read_by_session = ? WHERE id IN (${placeholders})`
    ).run(currentSession, ...ids);
  }

  // v1.7: decrypt content field on read (safe-no-op for plaintext rows)
  return rows.map((r) => ({ ...r, content: decryptContent(r.content) ?? r.content }));
}

/**
 * v2.1.6 — inbox-summary helper. Mirrors the priority + status ordering of
 * getMessages but:
 *   1. does NOT mutate read_by_session (pure observation),
 *   2. accepts an optional `sinceIso` lower bound so SQL can pre-filter by
 *      created_at — cheaper than the handler-layer filter when the caller
 *      cares only about recent mail,
 *   3. decrypts content so the handler can slice a preview at the boundary.
 *
 * Intended for get_messages_summary. Keeps the handler thin + keeps the
 * read-path-purity contract that getMessagesInWindow established in v2.1.4.
 */
export function getMessagesSummary(
  agentName: string,
  status: string,
  limit: number,
  sinceIso: string | null
): MessageRecord[] {
  const db = getDb();

  const agentRow = db
    .prepare("SELECT session_id FROM agents WHERE name = ?")
    .get(agentName) as { session_id: string | null } | undefined;
  const currentSession = agentRow?.session_id ?? null;

  const priorityOrder =
    `ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END, created_at DESC LIMIT ?`;

  const sinceClause = sinceIso ? "AND created_at >= ?" : "";
  const params: unknown[] = [agentName];

  let sql: string;
  if (status === "all") {
    sql = `SELECT * FROM messages WHERE to_agent = ? ${sinceClause} ${priorityOrder}`;
    if (sinceIso) params.push(sinceIso);
  } else if (status === "read") {
    sql = `SELECT * FROM messages WHERE to_agent = ?
       AND read_by_session IS NOT NULL
       AND read_by_session = ?
       ${sinceClause}
       ${priorityOrder}`;
    params.push(currentSession ?? "");
    if (sinceIso) params.push(sinceIso);
  } else {
    // "pending" — never read OR read by a different session
    sql = `SELECT * FROM messages WHERE to_agent = ?
       AND (read_by_session IS NULL OR read_by_session != ?)
       ${sinceClause}
       ${priorityOrder}`;
    params.push(currentSession ?? "");
    if (sinceIso) params.push(sinceIso);
  }
  params.push(limit);

  const rows = db.prepare(sql).all(...(params as any[])) as MessageRecord[];
  return rows.map((r) => ({ ...r, content: decryptContent(r.content) ?? r.content }));
}

/**
 * v2.1.6 — return the ISO timestamp at which the agent's current session
 * started (last register_agent call). NULL for unknown agents OR for rows
 * registered before v2.1.6 added the column — handler treats NULL as
 * "no anchor; skip the filter" so we never invent a bound.
 */
export function getAgentSessionStart(agentName: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT session_started_at FROM agents WHERE name = ?")
    .get(agentName) as { session_started_at: string | null } | undefined;
  return row?.session_started_at ?? null;
}

/**
 * v2.1.6 — operator-driven clean slate for reused agent names. Deletes every
 * message + task where the agent is sender OR recipient. Preserves the agent
 * row itself (use `relay recover` for that). Does NOT touch audit_log
 * entries (forensic record) or channel membership.
 *
 * Idempotent: running against an agent with no history returns zero counts.
 * Wrapped in a single transaction so partial failures don't leave half-purged
 * state.
 */
export function purgeAgentHistory(agentName: string): {
  messages_deleted: number;
  tasks_deleted: number;
} {
  const db = getDb();
  let messagesDeleted = 0;
  let tasksDeleted = 0;
  const tx = db.transaction(() => {
    const m = db
      .prepare("DELETE FROM messages WHERE from_agent = ? OR to_agent = ?")
      .run(agentName, agentName);
    messagesDeleted = m.changes;
    const t = db
      .prepare("DELETE FROM tasks WHERE from_agent = ? OR to_agent = ?")
      .run(agentName, agentName);
    tasksDeleted = t.changes;
  });
  tx();
  return { messages_deleted: messagesDeleted, tasks_deleted: tasksDeleted };
}

export function broadcastMessage(
  from: string,
  content: string,
  role?: string
): { sent_to: string[]; message_ids: string[] } {
  const db = getDb();
  touchAgent(from);

  const agents = getAgents(role);
  const recipients = agents.filter((a) => a.name !== from);

  const sentTo: string[] = [];
  const messageIds: string[] = [];
  const timestamp = now();

  const insert = db.prepare(
    "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, ?, 'normal', 'pending', ?)"
  );

  // v1.7: encrypt once, reuse for all recipients (each gets their own row but
  // the IV is regenerated per encryptContent call so... actually re-encrypt
  // per-row so each row has its own IV. Slightly slower, no IV reuse risk.)
  const tx = db.transaction(() => {
    for (const agent of recipients) {
      const id = uuidv4();
      insert.run(id, from, agent.name, encryptContent(content), timestamp);
      sentTo.push(agent.name);
      messageIds.push(id);
    }
  });

  tx();

  return { sent_to: sentTo, message_ids: messageIds };
}

// --- Task operations ---

export function postTask(
  from: string,
  to: string,
  title: string,
  description: string,
  priority: string
): TaskRecord {
  const db = getDb();
  touchAgent(from);

  const id = uuidv4();
  const timestamp = now();
  const encDescription = encryptContent(description); // v1.7: encrypt at rest

  db.prepare(
    "INSERT INTO tasks (id, from_agent, to_agent, title, description, priority, status, result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'posted', NULL, ?, ?)"
  ).run(id, from, to, title, encDescription, priority, timestamp, timestamp);

  return {
    id,
    from_agent: from,
    to_agent: to,
    title,
    description, // return plaintext — caller gave it to us
    priority,
    status: "posted",
    result: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function getTasks(
  agentName: string,
  role: string,
  status: string,
  limit: number
): TaskRecord[] {
  const db = getDb();
  // No touchAgent here — observation is not liveness (v1.3 presence fix)

  const column = role === "posted" ? "from_agent" : "to_agent";

  // v2.0: priority ordering (high > normal > low, then by updated_at)
  const priorityOrder = `ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END, updated_at DESC LIMIT ?`;
  let rows: TaskRecord[];
  if (status === "all") {
    rows = db.prepare(
      `SELECT * FROM tasks WHERE ${column} = ? ${priorityOrder}`
    ).all(agentName, limit) as TaskRecord[];
  } else {
    rows = db.prepare(
      `SELECT * FROM tasks WHERE ${column} = ? AND status = ? ${priorityOrder}`
    ).all(agentName, status, limit) as TaskRecord[];
  }
  // v1.7: decrypt description + result on read (safe-no-op for plaintext rows)
  return rows.map((r) => ({
    ...r,
    description: decryptContent(r.description) ?? r.description,
    result: r.result != null ? (decryptContent(r.result) ?? r.result) : null,
  }));
}

export function getTask(taskId: string): TaskRecord | null {
  const db = getDb();
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRecord | undefined;
  if (!task) return null;
  // v1.7: decrypt on read
  return {
    ...task,
    description: decryptContent(task.description) ?? task.description,
    result: task.result != null ? (decryptContent(task.result) ?? task.result) : null,
  };
}

/**
 * Thrown when a CAS-protected mutation finds the row in an unexpected state.
 * The caller sees a specific message distinguishing this from not-found or
 * authz errors — under realistic concurrency, the right response is to
 * re-read the task and decide what to do.
 */
export class ConcurrentUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentUpdateError";
  }
}

/**
 * v2.1.3 — thrown by sendMessage (and any future sender-originating write)
 * when the named sender row does not exist at write time. Surfaces the
 * silent-UPDATE path the predecessor session hit during the post-recover
 * curl wedge: auth had previously passed, but the row was deleted between
 * dispatcher verify and handler INSERT — the old code path INSERTed the
 * message anyway and the sender's last_seen silently stayed frozen.
 *
 * Classified as `SENDER_NOT_REGISTERED` by handleSendMessage; caller should
 * re-register the sender name and retry.
 */
export class SenderNotRegisteredError extends Error {
  constructor(name: string) {
    super(
      `Sender "${name}" is not a registered agent. Call register_agent before sending messages. ` +
      `(This error surfaces the silent-UPDATE path fixed in v2.1.3 — pre-v2.1.3 sendMessage would ` +
      `silently insert with last_seen never bumping when the sender row was missing.)`
    );
    this.name = "SenderNotRegisteredError";
  }
}

/**
 * v2.2.1 B2: raised by `handleRegisterAgent` (NOT `registerAgent` — the
 * collision check lives at the handler layer, not the DB layer) when a
 * second session tries to claim a name that's still actively held by a
 * different online session. Pre-v2.2.1 this was a silent warn + session_id
 * rotation — whichever terminal polled `get_messages` first drained the
 * mailbox; the other got zero and no error. Caught in the wild
 * 2026-04-21 during the v2.2.0 ship ceremony (see
 * `memory/feedback_scoped_victra_names.md`).
 *
 * The class is kept in db.ts for shared visibility + type-safe catch
 * blocks, but is thrown ONLY from the handler. Direct db.registerAgent
 * callers (tests, relay recover internals, migrations) never encounter
 * it because they bypass the collision check by design.
 *
 * The handler maps this to `NAME_COLLISION_ACTIVE` (same error code used
 * by the v2.1.3 I5 token-mismatch-on-active-row path — "this name is
 * actively held" is the same concept; only the trigger differs).
 *
 * Escape hatches (MCP surface):
 *   - `force: true` field on register_agent — exposed in
 *     RegisterAgentSchema, documented in src/types.ts as the
 *     operator-opt-in override.
 *   - `relay recover <name>` CLI — force-releases the row at the DB
 *     layer so the next register is a clean bootstrap.
 */
export class NameCollisionActiveError extends Error {
  public readonly existingSessionId: string;
  public readonly lastSeen: string;
  constructor(name: string, existingSessionId: string, lastSeen: string) {
    super(
      `Agent "${name}" is already registered and online on another session (session_id=${existingSessionId}, last_seen=${lastSeen}). ` +
      `Two terminals running under the same name will race on get_messages and silently drop mail. Resolution paths: ` +
      `(a) scope your name (e.g. "${name}-mcp", "${name}-outreach", "${name}-build") so each terminal has a distinct identity; ` +
      `(b) close the holding terminal and let it mark the row offline on exit (v2.1.3+ markAgentOffline); or ` +
      `(c) run "bin/relay recover ${name} --yes" to force-release the row + re-register fresh.`
    );
    this.name = "NameCollisionActiveError";
    this.existingSessionId = existingSessionId;
    this.lastSeen = lastSeen;
  }
}

export function updateTask(
  taskId: string,
  agentName: string,
  action: TaskAction,
  result?: string
): TaskRecord {
  const db = getDb();

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRecord | undefined;

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // Authorization — role per action.
  //   - cancel: requester only (from_agent must be caller).
  //   - accept/complete/heartbeat: assignee only (to_agent must be caller).
  //   - reject: assignee OR requester (legacy behavior preserved).
  const isAssignee = task.to_agent === agentName;
  const isRequester = task.from_agent === agentName;
  let authorized = false;
  if (action === "cancel") authorized = isRequester;
  else if (action === "reject") authorized = isAssignee || isRequester;
  else authorized = isAssignee; // accept, complete, heartbeat

  if (!authorized) {
    const role = action === "cancel" ? "requester" : "assignee";
    throw new Error(
      `Agent "${agentName}" is not authorized to ${action} this task. Only the ${role} can perform that action.`
    );
  }

  // Validate state transition (fail fast on the pre-read; CAS below is the
  // authoritative enforcement point under concurrent mutation).
  const allowedFromStatuses = VALID_TRANSITIONS[action];
  if (!allowedFromStatuses.includes(task.status as TaskStatus)) {
    throw new Error(
      `Cannot ${action} a task with status "${task.status}". Allowed from: ${allowedFromStatuses.join(", ")}`
    );
  }

  const timestamp = now();

  // Heartbeat: no status change, just renew the lease. CAS on status+assignee.
  if (action === "heartbeat") {
    const r = db.prepare(
      "UPDATE tasks SET lease_renewed_at = ?, updated_at = ? WHERE id = ? AND status = 'accepted' AND to_agent = ?"
    ).run(timestamp, timestamp, taskId, agentName);
    if (r.changes !== 1) {
      throw new ConcurrentUpdateError(
        `Task ${taskId} heartbeat failed: task is no longer 'accepted' by "${agentName}". Re-read and retry.`
      );
    }
    touchAgent(agentName);
    return {
      ...task,
      description: decryptContent(task.description) ?? task.description,
      result: task.result != null ? (decryptContent(task.result) ?? task.result) : null,
      lease_renewed_at: timestamp,
      updated_at: timestamp,
    };
  }

  const newStatus = ACTION_TO_STATUS[action];
  if (!newStatus) {
    throw new Error(`Internal: no status mapping for action "${action}"`);
  }
  const encResult = result != null ? encryptContent(result) : null;

  // v2.0 beta.1 (Codex HIGH 2): CAS on every mutation. The WHERE clause is
  // the authoritative enforcement point — if it matches 0 rows, a concurrent
  // caller mutated the row between our pre-read and our write.
  let r: { changes: number };
  if (action === "accept") {
    // posted → accepted, assignee only, stamp lease.
    r = db.prepare(
      "UPDATE tasks SET status = ?, result = ?, updated_at = ?, lease_renewed_at = ? WHERE id = ? AND status = 'posted' AND to_agent = ?"
    ).run(newStatus, encResult, timestamp, timestamp, taskId, agentName);
  } else if (action === "complete") {
    // accepted → completed, assignee only.
    r = db.prepare(
      "UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ? AND status = 'accepted' AND to_agent = ?"
    ).run(newStatus, encResult, timestamp, taskId, agentName);
  } else if (action === "reject") {
    // {posted, accepted} → rejected, assignee OR requester.
    r = db.prepare(
      "UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ? AND status IN ('posted','accepted') AND (to_agent = ? OR from_agent = ?)"
    ).run(newStatus, encResult, timestamp, taskId, agentName, agentName);
  } else if (action === "cancel") {
    // {queued, posted, accepted} → cancelled, requester only.
    r = db.prepare(
      "UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ? AND status IN ('queued','posted','accepted') AND from_agent = ?"
    ).run(newStatus, encResult, timestamp, taskId, agentName);
  } else {
    // TypeScript should prevent this via the action enum, but belt-and-suspenders.
    throw new Error(`Internal: unhandled action "${action}" in updateTask`);
  }

  if (r.changes !== 1) {
    throw new ConcurrentUpdateError(
      `Task ${taskId} ${action} failed: row state changed since pre-read. Re-read and retry.`
    );
  }

  touchAgent(agentName);

  return {
    ...task,
    description: decryptContent(task.description) ?? task.description,
    status: newStatus,
    result: result ?? null,
    updated_at: timestamp,
    lease_renewed_at: action === "accept" ? timestamp : task.lease_renewed_at ?? null,
  };
}

// --- v2.0 beta: smart routing, lease heartbeat, lazy health monitor ---

export interface AutoRoutingResult {
  task: TaskRecord;
  routed: boolean;
  assigned_to: string | null;
  candidate_count: number;
}

/**
 * Capability-based task routing (v2.0 beta).
 *
 * Inserts a task and picks the least-loaded agent whose capability set is a
 * superset of `requiredCapabilities`. Tie-break: freshest `last_seen`.
 * If no agent matches, the task is stored with `status='queued'` and
 * `to_agent=NULL`; it will be picked up on the next `register_agent` of an
 * agent whose caps match (see `tryAssignQueuedTasksTo`).
 *
 * Routing race is benign on insert — two concurrent calls each insert their
 * own distinct task row. CAS is only required on mutations of existing rows
 * (health requeue, queued→posted at register time).
 */
export function postTaskAuto(
  from: string,
  title: string,
  description: string,
  requiredCapabilities: string[],
  priority: string,
  options: { allowSelfAssign?: boolean } = {}
): AutoRoutingResult {
  // v2.0 beta.1 (Codex LOW 7): defense-in-depth against direct db.ts callers.
  // The MCP zod schema requires min 1, but tests and future scripts can hit
  // this helper directly. An empty array would produce `IN ()` — a SQL error.
  if (requiredCapabilities.length === 0) {
    throw new Error(
      "postTaskAuto requires at least one required capability. Use post_task for unrestricted assignment."
    );
  }

  const db = getDb();
  touchAgent(from);

  const timestamp = now();
  const id = uuidv4();
  const encDescription = encryptContent(description);
  const capsJson = JSON.stringify(requiredCapabilities);
  const allowSelfAssign = options.allowSelfAssign === true;

  // v2.0 beta.1 (Codex MEDIUM 5): wrap SELECT candidates + INSERT in a single
  // BEGIN IMMEDIATE transaction. better-sqlite3's db.transaction() defaults to
  // IMMEDIATE, which takes the write lock at BEGIN — two concurrent callers
  // are serialized, so the "least-loaded" pick is accurate at the moment of
  // the insert, not the moment of the read.
  //
  // v2.1 Phase 4k (F-3a.1): default-exclude the sender from candidates. The
  // touchAgent(from) above otherwise makes the sender win the last_seen
  // tie-break on every auto-route, so "route this to someone capable" routes
  // right back to the agent that just asked. Callers who want self-routing
  // opt in via allow_self_assign.
  const tx = db.transaction((): AutoRoutingResult => {
    const placeholders = requiredCapabilities.map(() => "?").join(",");
    const excludeSenderClause = allowSelfAssign ? "" : " AND a.name != ?";
    const bindArgs: (string | number)[] = [...requiredCapabilities];
    if (!allowSelfAssign) bindArgs.push(from);
    bindArgs.push(requiredCapabilities.length);
    const candidates = db.prepare(
      `SELECT a.name, a.last_seen,
              (SELECT COUNT(*) FROM tasks t
                 WHERE t.to_agent = a.name AND t.status IN ('posted','accepted')) AS load
         FROM agents a
         JOIN agent_capabilities ac ON ac.agent_name = a.name
        WHERE ac.capability IN (${placeholders})${excludeSenderClause}
        GROUP BY a.name
       HAVING COUNT(DISTINCT ac.capability) = ?
        ORDER BY load ASC, a.last_seen DESC
        LIMIT 10`
    ).all(...bindArgs) as Array<{ name: string; last_seen: string; load: number }>;

    if (candidates.length === 0) {
      log.debug(`[route] post_task_auto from=${from} caps=[${requiredCapabilities.join(",")}] candidates=0 → queued`);
      db.prepare(
        "INSERT INTO tasks (id, from_agent, to_agent, title, description, priority, status, result, created_at, updated_at, required_capabilities) VALUES (?, ?, NULL, ?, ?, ?, 'queued', NULL, ?, ?, ?)"
      ).run(id, from, title, encDescription, priority, timestamp, timestamp, capsJson);
      return {
        task: {
          id, from_agent: from, to_agent: null, title, description, priority,
          status: "queued", result: null, created_at: timestamp, updated_at: timestamp,
          lease_renewed_at: null, required_capabilities: capsJson,
        },
        routed: false,
        assigned_to: null,
        candidate_count: 0,
      };
    }

    const pick = candidates[0];
    log.debug(`[route] post_task_auto from=${from} caps=[${requiredCapabilities.join(",")}] candidates=${candidates.length} picked=${pick.name} (load=${pick.load})`);
    db.prepare(
      "INSERT INTO tasks (id, from_agent, to_agent, title, description, priority, status, result, created_at, updated_at, required_capabilities) VALUES (?, ?, ?, ?, ?, ?, 'posted', NULL, ?, ?, ?)"
    ).run(id, from, pick.name, title, encDescription, priority, timestamp, timestamp, capsJson);

    return {
      task: {
        id, from_agent: from, to_agent: pick.name, title, description, priority,
        status: "posted", result: null, created_at: timestamp, updated_at: timestamp,
        lease_renewed_at: null, required_capabilities: capsJson,
      },
      routed: true,
      assigned_to: pick.name,
      candidate_count: candidates.length,
    };
  });

  return tx();
}

export interface QueuedAssignment {
  task_id: string;
  from_agent: string;
  title: string;
  priority: string;
  required_capabilities: string[];
}

/**
 * Attempt to assign queued tasks to a newly-registered (or re-registered)
 * agent. CAS-protected per row: concurrent registers cannot double-assign.
 * Returns the list of tasks successfully assigned so the caller can fire
 * webhooks. Bounded by RELAY_AUTO_ASSIGN_LIMIT (default 20) per call.
 */
export function tryAssignQueuedTasksTo(
  agentName: string,
  agentCapabilities: string[]
): QueuedAssignment[] {
  if (agentCapabilities.length === 0) return [];
  const db = getDb();
  const limit = parseInt(process.env.RELAY_AUTO_ASSIGN_LIMIT || "20", 10);
  const capSet = new Set(agentCapabilities);

  const queued = db.prepare(
    `SELECT id, from_agent, title, priority, required_capabilities
       FROM tasks
      WHERE status = 'queued'
        AND to_agent IS NULL
        AND required_capabilities IS NOT NULL
      ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
               created_at ASC
      LIMIT ?`
  ).all(Math.max(1, Math.min(200, limit))) as Array<{
    id: string; from_agent: string; title: string; priority: string; required_capabilities: string;
  }>;

  const assigned: QueuedAssignment[] = [];
  const casUpdate = db.prepare(
    "UPDATE tasks SET to_agent = ?, status = 'posted', updated_at = ? WHERE id = ? AND status = 'queued' AND to_agent IS NULL"
  );

  for (const row of queued) {
    let reqCaps: string[];
    try {
      reqCaps = JSON.parse(row.required_capabilities) as string[];
    } catch {
      continue;
    }
    if (!reqCaps.every((c) => capSet.has(c))) continue;

    const result = casUpdate.run(agentName, now(), row.id);
    if (result.changes === 1) {
      assigned.push({
        task_id: row.id,
        from_agent: row.from_agent,
        title: row.title,
        priority: row.priority,
        required_capabilities: reqCaps,
      });
    }
    // changes===0 means another caller won the race for this row — skip.
  }

  return assigned;
}

export interface HealthReassignment {
  task_id: string;
  previous_agent: string;
  triggered_by: string;
  from_agent: string;
  required_capabilities: string[] | null;
}

/**
 * Lazy health monitor (v2.0 beta).
 *
 * Scans for `accepted` tasks whose lease has expired beyond the grace period.
 * CAS-requeues them (to_agent=NULL, status=queued) and returns the list so
 * the caller can fire webhooks. Bounded by RELAY_HEALTH_SCAN_LIMIT (default 50).
 *
 * Disabled entirely if RELAY_HEALTH_DISABLED=1 (emergency off-switch).
 *
 * This function is designed to be called lazily from get_messages / get_tasks
 * / post_task_auto — the work per call is O(stale tasks) capped at the scan
 * limit, and the cheap count query short-circuits when nothing is stale.
 */
export function runHealthMonitorTick(triggeredBy: string): HealthReassignment[] {
  if (process.env.RELAY_HEALTH_DISABLED === "1") return [];
  const db = getDb();

  const graceMinutes = parseInt(process.env.RELAY_HEALTH_REASSIGN_GRACE_MINUTES || "120", 10);
  const graceMs = Math.max(1, graceMinutes) * 60 * 1000;
  const threshold = new Date(Date.now() - graceMs).toISOString();

  // v2.0 beta.1 (Codex HIGH 1) + v2.0 final (#26) + v2.0.1 (Codex HIGH 2):
  // requeue only when
  //   (a) lease is stale AND
  //   (b) assignee is offline/stale OR unregistered AND
  //   (c) assignee is NOT in busy/away with an unexpired TTL
  // busy_expires_at < now → shield has lapsed, agent is no longer protected.
  const nowIsoForStatus = now();
  const staleCount = db.prepare(
    `SELECT COUNT(*) AS c
       FROM tasks t
      WHERE t.status = 'accepted'
        AND t.lease_renewed_at IS NOT NULL
        AND t.lease_renewed_at < ?
        AND (
          t.to_agent NOT IN (SELECT name FROM agents)
          OR t.to_agent IN (
            SELECT name FROM agents
             WHERE last_seen < ?
               AND (
                 -- v2.1.3 (I6): new exempt-from-requeue statuses are
                 -- working / blocked / waiting_user. Legacy 'busy' / 'away'
                 -- are kept for belt-and-suspenders (post-migration they
                 -- should not exist, but an older peer process on the same
                 -- DB could still write them).
                 agent_status NOT IN ('working','blocked','waiting_user','busy','away')
                 OR busy_expires_at IS NULL
                 OR busy_expires_at < ?
               )
          )
        )`
  ).get(threshold, threshold, nowIsoForStatus) as { c: number };
  if (staleCount.c === 0) return [];

  const scanLimit = parseInt(process.env.RELAY_HEALTH_SCAN_LIMIT || "50", 10);
  const stale = db.prepare(
    `SELECT t.id, t.to_agent, t.from_agent, t.lease_renewed_at, t.required_capabilities
       FROM tasks t
      WHERE t.status = 'accepted'
        AND t.lease_renewed_at IS NOT NULL
        AND t.lease_renewed_at < ?
        AND (
          t.to_agent NOT IN (SELECT name FROM agents)
          OR t.to_agent IN (
            SELECT name FROM agents
             WHERE last_seen < ?
               AND (
                 -- v2.1.3 (I6): new exempt-from-requeue statuses are
                 -- working / blocked / waiting_user. Legacy 'busy' / 'away'
                 -- are kept for belt-and-suspenders (post-migration they
                 -- should not exist, but an older peer process on the same
                 -- DB could still write them).
                 agent_status NOT IN ('working','blocked','waiting_user','busy','away')
                 OR busy_expires_at IS NULL
                 OR busy_expires_at < ?
               )
          )
        )
      ORDER BY t.lease_renewed_at ASC
      LIMIT ?`
  ).all(threshold, threshold, nowIsoForStatus, Math.max(1, Math.min(500, scanLimit))) as Array<{
    id: string; to_agent: string; from_agent: string; lease_renewed_at: string; required_capabilities: string | null;
  }>;

  const requeued: HealthReassignment[] = [];
  // CAS ensures we only requeue the exact row we inspected. Re-check agent
  // liveness AND agent_status/TTL inside the CAS as belt-and-suspenders — a
  // concurrent touchAgent can bump last_seen between SELECT and UPDATE, and
  // a concurrent set_status(busy) can add TTL shield. v2.0.1 (Codex HIGH 2):
  // the CAS now includes agent_status + busy_expires_at so a mid-flight
  // status flip doesn't get overwritten.
  const casRequeue = db.prepare(
    `UPDATE tasks SET to_agent = NULL, status = 'queued', updated_at = ?
      WHERE id = ?
        AND status = 'accepted'
        AND to_agent = ?
        AND lease_renewed_at = ?
        AND (
          to_agent NOT IN (SELECT name FROM agents)
          OR to_agent IN (
            SELECT name FROM agents
             WHERE last_seen < ?
               AND (
                 -- v2.1.3 (I6): new exempt-from-requeue statuses are
                 -- working / blocked / waiting_user. Legacy 'busy' / 'away'
                 -- are kept for belt-and-suspenders (post-migration they
                 -- should not exist, but an older peer process on the same
                 -- DB could still write them).
                 agent_status NOT IN ('working','blocked','waiting_user','busy','away')
                 OR busy_expires_at IS NULL
                 OR busy_expires_at < ?
               )
          )
        )`
  );

  for (const row of stale) {
    const result = casRequeue.run(now(), row.id, row.to_agent, row.lease_renewed_at, threshold, nowIsoForStatus);
    if (result.changes === 1) {
      log.debug(`[health] requeue task=${row.id} prev_agent=${row.to_agent} triggered_by=${triggeredBy}`);
      let reqCaps: string[] | null = null;
      if (row.required_capabilities) {
        try { reqCaps = JSON.parse(row.required_capabilities) as string[]; } catch { reqCaps = null; }
      }
      requeued.push({
        task_id: row.id,
        previous_agent: row.to_agent,
        triggered_by: triggeredBy,
        from_agent: row.from_agent,
        required_capabilities: reqCaps,
      });
    }
    // changes===0 means the assignee heartbeated between our SELECT and UPDATE — no requeue, correct outcome.
  }

  return requeued;
}

// --- Webhook operations ---

export function registerWebhook(
  url: string,
  event: string,
  filter?: string,
  secret?: string
): WebhookRecord {
  const db = getDb();
  const id = uuidv4();
  const timestamp = now();

  // v2.1 Phase 4p (Codex R1 HIGH #2): encrypt webhook HMAC secret at rest
  // via the same AES-256-GCM pipeline used for message content + task
  // description + audit params_json. When RELAY_ENCRYPTION_KEY is unset,
  // encryptContent is a plaintext pass-through (existing contract). The
  // boolean truthiness of `has_secret` in handlers stays correct either way.
  const storedSecret = secret ? encryptContent(secret) : null;
  db.prepare(
    "INSERT INTO webhook_subscriptions (id, url, event, filter, secret, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, url, event, filter ?? null, storedSecret, timestamp);

  return {
    id,
    url,
    event,
    filter: filter ?? null,
    secret: secret ?? null,
    created_at: timestamp,
  };
}

export function listWebhooks(): WebhookRecord[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM webhook_subscriptions ORDER BY created_at DESC").all() as WebhookRecord[];
  // v2.1 Phase 4p: decrypt secret at the db.ts boundary so every caller
  // gets plaintext regardless of at-rest state.
  return rows.map((r) => ({ ...r, secret: r.secret ? decryptContent(r.secret) : null }));
}

export function deleteWebhook(webhookId: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM webhook_subscriptions WHERE id = ?").run(webhookId);
  return result.changes > 0;
}

export function getWebhooksForEvent(event: string, fromAgent: string, toAgent: string): WebhookRecord[] {
  const db = getDb();
  const hooks = db.prepare(
    "SELECT * FROM webhook_subscriptions WHERE event = ? OR event = '*'"
  ).all(event) as WebhookRecord[];

  return hooks
    .filter((h) => {
      if (!h.filter) return true;
      return h.filter === fromAgent || h.filter === toAgent;
    })
    // v2.1 Phase 4p: decrypt secret before the row exits db.ts so HMAC
    // signing in src/webhooks.ts sees plaintext.
    .map((h) => ({ ...h, secret: h.secret ? decryptContent(h.secret) : null }));
}

/**
 * v2.1 Phase 4e (F-3a.5): redact error messages before persisting them to
 * webhook_delivery_log. The dashboard never renders this column today, but
 * the column exists, a future feature could expose it, and operators +
 * backups read raw DB rows. Redaction order is most-specific → least:
 *   1. Full URLs → <url>
 *   2. Absolute paths → <path>
 *   3. IPv4 literals → <ip>
 *   4. IPv6 literals → <ipv6>
 *   5. bcrypt hash prefix → <bcrypt>
 *   6. Long alnum/_=.- tokens (20–128 chars) → <token>
 * Token pattern is broad; it runs LAST so earlier patterns got a chance
 * to replace their substrings first. log.warn (stderr) always keeps the
 * full original so operators can still diagnose.
 */
export function redactErrorMessage(raw: string | null): string | null {
  if (raw === null) return null;
  let s = String(raw);
  s = s.replace(/https?:\/\/[^\s'"<>]+/g, "<url>");
  s = s.replace(/(?<![A-Za-z0-9_])\/[A-Za-z0-9_./-]+/g, "<path>");
  s = s.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "<ip>");
  s = s.replace(/\b(?:[0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F]{0,4}\b/g, "<ipv6>");
  s = s.replace(/\$2[aby]\$[^\s]+/g, "<bcrypt>");
  s = s.replace(/(?<![<>])[A-Za-z0-9_=.-]{20,128}/g, "<token>");
  return s;
}

export function logWebhookDelivery(
  webhookId: string,
  event: string,
  payload: string,
  statusCode: number | null,
  error: string | null
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO webhook_delivery_log (id, webhook_id, event, payload, status_code, error, attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(uuidv4(), webhookId, event, payload, statusCode, redactErrorMessage(error), now());
}

// --- v2.0 final: webhook retry with CAS ---

/**
 * Returned to the webhook-firing caller so the retry attempt can POST the
 * URL without a schema lookup. terminal_status distinguishes "still pending
 * retries" (NULL) from "delivered" / "failed".
 */
export interface WebhookRetryJob {
  log_id: string;
  webhook_id: string;
  url: string;
  secret: string | null;
  event: string;
  payload: string;
  retry_count: number;
}

/** Backoff ladder for retries (seconds). Three attempts then terminal. */
const WEBHOOK_RETRY_BACKOFF_SECONDS = [60, 300, 900];

/**
 * Record a failed initial delivery so it will be retried later. Call this
 * from the webhook dispatcher when the first POST fails.
 */
export function scheduleWebhookRetry(webhookId: string, event: string, payload: string, initialError: string): void {
  const db = getDb();
  const id = uuidv4();
  const nextAt = new Date(Date.now() + WEBHOOK_RETRY_BACKOFF_SECONDS[0] * 1000).toISOString();
  // v2.1 Phase 4e: redact before insert — see redactErrorMessage docstring.
  db.prepare(
    `INSERT INTO webhook_delivery_log
       (id, webhook_id, event, payload, status_code, error, attempted_at, retry_count, next_retry_at, terminal_status)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 1, ?, NULL)`
  ).run(id, webhookId, event, payload, redactErrorMessage(initialError), now(), nextAt);
}

/**
 * v2.1 Phase 4e: terminate a retry row immediately (skip backoff ladder).
 * Called on DNS-rebinding refusal — retry would just feed the attacker.
 */
export function terminateWebhookRetry(logId: string, reason: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE webhook_delivery_log SET terminal_status = 'failed', error = ?, claimed_at = NULL, claim_expires_at = NULL WHERE id = ?"
  ).run(redactErrorMessage(reason), logId);
}

/**
 * Record a successful terminal delivery — short-circuits further retries
 * of the same attempt row.
 */
export function markWebhookDelivered(logId: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE webhook_delivery_log SET terminal_status = 'delivered' WHERE id = ?"
  ).run(logId);
}

/**
 * Pull and claim retry jobs whose `next_retry_at` has matured. CAS-protected
 * per row — two callers cannot claim the same job.
 *
 * v2.0.1 (Codex HIGH 3): crash-safe claim via a 60-second lease. Replaces
 * the previous "next_retry_at = NULL" claim marker which stranded rows
 * forever if the owning process crashed between claim and outcome.
 *
 * Claim eligibility:
 *   - terminal_status IS NULL (not delivered or permanently failed)
 *   - retry_count > 0 (there was an initial failure)
 *   - next_retry_at <= now (time to attempt)
 *   - AND (claimed_at IS NULL OR claim_expires_at < now) — unclaimed OR
 *     previous claim expired (crashed owner)
 *
 * Bounded by RELAY_WEBHOOK_RETRY_BATCH_SIZE (default 10) per call.
 * Lease duration: RELAY_WEBHOOK_CLAIM_LEASE_SECONDS (default 60).
 */
export function claimDueWebhookRetries(): WebhookRetryJob[] {
  const db = getDb();
  const batch = parseInt(process.env.RELAY_WEBHOOK_RETRY_BATCH_SIZE || "10", 10);
  const limit = Math.max(1, Math.min(100, batch));
  const leaseSeconds = parseInt(process.env.RELAY_WEBHOOK_CLAIM_LEASE_SECONDS || "60", 10);
  const leaseMs = Math.max(10, Math.min(600, leaseSeconds)) * 1000;

  const nowIso = now();
  const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();

  const candidates = db.prepare(
    `SELECT l.id AS log_id, l.webhook_id, l.event, l.payload, l.retry_count,
            s.url, s.secret
       FROM webhook_delivery_log l
       JOIN webhook_subscriptions s ON s.id = l.webhook_id
      WHERE l.terminal_status IS NULL
        AND l.retry_count > 0
        AND l.next_retry_at IS NOT NULL
        AND l.next_retry_at <= ?
        AND (l.claimed_at IS NULL OR l.claim_expires_at IS NULL OR l.claim_expires_at < ?)
      ORDER BY l.next_retry_at ASC
      LIMIT ?`
  ).all(nowIso, nowIso, limit) as Array<WebhookRetryJob & { log_id: string }>;

  // CAS: claim each row by stamping claimed_at + claim_expires_at. If
  // changes=0, another caller beat us (or the lease was refreshed between
  // the SELECT and this UPDATE).
  const casClaim = db.prepare(
    `UPDATE webhook_delivery_log
        SET claimed_at = ?, claim_expires_at = ?
      WHERE id = ?
        AND terminal_status IS NULL
        AND next_retry_at IS NOT NULL
        AND next_retry_at <= ?
        AND (claimed_at IS NULL OR claim_expires_at IS NULL OR claim_expires_at < ?)`
  );

  const claimed: WebhookRetryJob[] = [];
  for (const c of candidates) {
    const r = casClaim.run(nowIso, leaseExpiresAt, c.log_id, nowIso, nowIso);
    if (r.changes === 1) {
      // v2.1 Phase 4p: decrypt secret before handing the job to retryOne
      // so HMAC signing sees plaintext regardless of at-rest encryption.
      const jobWithPlaintextSecret: WebhookRetryJob = {
        ...c,
        secret: c.secret ? decryptContent(c.secret) : null,
      };
      claimed.push(jobWithPlaintextSecret);
    }
  }
  return claimed;
}

/**
 * Resolve the outcome of a retry attempt. Success → terminal delivered.
 * Failure with attempts remaining → schedule next backoff. Failure at max →
 * terminal failed.
 */
export function recordWebhookRetryOutcome(logId: string, succeeded: boolean, statusCode: number | null, error: string | null): void {
  const db = getDb();
  // v2.0.1: always clear the claim lease when recording an outcome.
  // v2.1 Phase 4e: redact error before persisting.
  if (succeeded) {
    db.prepare(
      "UPDATE webhook_delivery_log SET status_code = ?, error = NULL, terminal_status = 'delivered', claimed_at = NULL, claim_expires_at = NULL WHERE id = ?"
    ).run(statusCode, logId);
    return;
  }
  const redacted = redactErrorMessage(error);
  const row = db.prepare(
    "SELECT retry_count FROM webhook_delivery_log WHERE id = ?"
  ).get(logId) as { retry_count: number } | undefined;
  if (!row) return;
  const nextCount = row.retry_count + 1;
  if (nextCount > WEBHOOK_RETRY_BACKOFF_SECONDS.length) {
    db.prepare(
      "UPDATE webhook_delivery_log SET status_code = ?, error = ?, terminal_status = 'failed', retry_count = ?, claimed_at = NULL, claim_expires_at = NULL WHERE id = ?"
    ).run(statusCode, redacted, nextCount - 1, logId);
    return;
  }
  const delay = WEBHOOK_RETRY_BACKOFF_SECONDS[nextCount - 1];
  const nextAt = new Date(Date.now() + delay * 1000).toISOString();
  db.prepare(
    "UPDATE webhook_delivery_log SET status_code = ?, error = ?, retry_count = ?, next_retry_at = ?, claimed_at = NULL, claim_expires_at = NULL WHERE id = ?"
  ).run(statusCode, redacted, nextCount, nextAt, logId);
}

// --- Channel operations (v2.0) ---

export interface ChannelRecord {
  id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: string;
}

export interface ChannelMessageRecord {
  id: string;
  channel_id: string;
  from_agent: string;
  content: string;
  priority: string;
  created_at: string;
}

export function createChannel(name: string, description: string | null, createdBy: string): ChannelRecord {
  const db = getDb();
  const id = uuidv4();
  const timestamp = now();
  const existing = db.prepare("SELECT id FROM channels WHERE name = ?").get(name);
  if (existing) throw new Error(`Channel "${name}" already exists.`);
  db.prepare(
    "INSERT INTO channels (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, name, description, createdBy, timestamp);
  // Creator auto-joins
  db.prepare(
    "INSERT INTO channel_members (channel_id, agent_name, joined_at) VALUES (?, ?, ?)"
  ).run(id, createdBy, timestamp);
  return { id, name, description, created_by: createdBy, created_at: timestamp };
}

export function joinChannel(channelName: string, agentName: string): { joined: boolean; channel_id: string } {
  const db = getDb();
  const channel = db.prepare("SELECT id FROM channels WHERE name = ?").get(channelName) as { id: string } | undefined;
  if (!channel) throw new Error(`Channel "${channelName}" does not exist.`);
  const existing = db.prepare(
    "SELECT 1 FROM channel_members WHERE channel_id = ? AND agent_name = ?"
  ).get(channel.id, agentName);
  if (existing) return { joined: false, channel_id: channel.id };
  db.prepare(
    "INSERT INTO channel_members (channel_id, agent_name, joined_at) VALUES (?, ?, ?)"
  ).run(channel.id, agentName, now());
  return { joined: true, channel_id: channel.id };
}

export function leaveChannel(channelName: string, agentName: string): { left: boolean } {
  const db = getDb();
  const channel = db.prepare("SELECT id FROM channels WHERE name = ?").get(channelName) as { id: string } | undefined;
  if (!channel) throw new Error(`Channel "${channelName}" does not exist.`);
  const result = db.prepare(
    "DELETE FROM channel_members WHERE channel_id = ? AND agent_name = ?"
  ).run(channel.id, agentName);
  return { left: result.changes > 0 };
}

export function postToChannel(
  channelName: string,
  fromAgent: string,
  content: string,
  priority: string
): ChannelMessageRecord {
  const db = getDb();
  const channel = db.prepare("SELECT id FROM channels WHERE name = ?").get(channelName) as { id: string } | undefined;
  if (!channel) throw new Error(`Channel "${channelName}" does not exist.`);
  const member = db.prepare(
    "SELECT 1 FROM channel_members WHERE channel_id = ? AND agent_name = ?"
  ).get(channel.id, fromAgent);
  if (!member) throw new Error(`Agent "${fromAgent}" is not a member of channel "${channelName}". Join first.`);
  const id = uuidv4();
  const timestamp = now();
  db.prepare(
    "INSERT INTO channel_messages (id, channel_id, from_agent, content, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, channel.id, fromAgent, encryptContent(content), priority, timestamp);
  return { id, channel_id: channel.id, from_agent: fromAgent, content, priority, created_at: timestamp };
}

export function getChannelMessages(
  channelName: string,
  agentName: string,
  limit: number,
  since?: string
): ChannelMessageRecord[] {
  const db = getDb();
  const channel = db.prepare("SELECT id FROM channels WHERE name = ?").get(channelName) as { id: string } | undefined;
  if (!channel) throw new Error(`Channel "${channelName}" does not exist.`);
  const membership = db.prepare(
    "SELECT joined_at FROM channel_members WHERE channel_id = ? AND agent_name = ?"
  ).get(channel.id, agentName) as { joined_at: string } | undefined;
  if (!membership) throw new Error(`Agent "${agentName}" is not a member of channel "${channelName}".`);
  const floor = since && since > membership.joined_at ? since : membership.joined_at;
  const rows = db.prepare(
    `SELECT * FROM channel_messages WHERE channel_id = ? AND created_at >= ?
     ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
              created_at DESC LIMIT ?`
  ).all(channel.id, floor, limit) as ChannelMessageRecord[];
  return rows.map((r) => ({ ...r, content: decryptContent(r.content) || r.content }));
}

export function listChannels(): ChannelRecord[] {
  const db = getDb();
  return db.prepare("SELECT * FROM channels ORDER BY created_at DESC").all() as ChannelRecord[];
}
