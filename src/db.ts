// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import os from "os";
import { getOwnHostId, isAgentProcessAlive } from "./liveness.js";
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
import { touchMarker } from "./filesystem-marker.js";
import { resolveInstanceDbPath } from "./instance.js";
import { emitInboxChanged } from "./inbox-events.js";
import { validateSchemaDocument, validateResult, type SchemaCheck } from "./task-schema-validator.js";

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
  // v2.4.0 Part E — per-instance isolation. RELAY_DB_PATH still wins
  // (explicit operator override); otherwise fall back to the per-
  // instance path if multi-instance mode is active, then the legacy
  // flat layout. Single-instance operators with existing setups see
  // identical behavior to v2.3.x.
  let raw: string;
  if (process.env.RELAY_DB_PATH) {
    raw = process.env.RELAY_DB_PATH;
  } else {
    raw = resolveInstanceDbPath();
  }
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

/**
 * v2.13.0 — presence liveness. A `last_alive` confirmation counts as "the
 * terminal is open right now" only while it is fresh; past this window it is
 * treated as no signal (the agent falls back to age-based derivation). Default
 * 120s (≈ a probe-on-read cadence with headroom); tunable via
 * RELAY_AGENT_ALIVE_WINDOW_SEC. The probe cache window suppresses re-probing
 * the same agent on rapid successive reads — within it, a fresh `last_alive`
 * is trusted without re-running process.kill.
 */
function getAliveWindowMs(): number {
  const raw = process.env.RELAY_AGENT_ALIVE_WINDOW_SEC;
  const n = raw ? parseInt(raw, 10) : 120;
  const sec = Number.isFinite(n) && n > 0 ? n : 120;
  return sec * 1000;
}
const LIVENESS_PROBE_CACHE_MS = 5_000;

/** True when `lastAlive` is a recent positive liveness confirmation. NULL /
 *  unparseable / future-dated-beyond-window / older than the window → false. */
function isAliveFresh(lastAlive: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!lastAlive) return false;
  const t = Date.parse(lastAlive);
  if (!Number.isFinite(t)) return false;
  const age = nowMs - t;
  return age >= 0 && age < getAliveWindowMs();
}
/**
 * v2.2.2 B3 — abandoned threshold. Agents that have been offline (no
 * re-register, no set_status refresh) for longer than this get
 * surfaced as `agent_status: "abandoned"` in snapshots. The raw DB
 * row is left alone — operators prune via `relay purge-agents`.
 * Overridable via RELAY_AGENT_ABANDON_DAYS (integer days).
 */
function getAgentAbandonMinutes(): number {
  const raw = process.env.RELAY_AGENT_ABANDON_DAYS;
  const n = raw ? parseInt(raw, 10) : 7;
  const days = Number.isFinite(n) && n > 0 ? n : 7;
  return days * 24 * 60;
}

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
 * v2.13.0 — TERMINAL lifecycle states. An agent in one of these "was gone"
 * states is NOT available. They are the states a re-registration RESETS
 * (re-register = a fresh session = the agent is back), and the states the
 * `alive` boolean treats as not-awake.
 */
const TERMINAL_AGENT_STATES = new Set(["offline", "closed", "abandoned", "stale"]);
/** Active declared states — the agent is present + available. */
const ACTIVE_AGENT_STATES = new Set(["idle", "working", "blocked", "waiting_user"]);

/**
 * v2.13.0 — the stored agent_status a successful EXISTING-ROW re-registration
 * should carry forward. A re-register starts a fresh session, so a TERMINAL
 * state (offline/closed/abandoned/stale) from a prior session is reset to
 * 'idle' — the agent is back and available (fixes the resume-stuck-offline
 * bug, incl. the next valid registration after a force token rotation). Active
 * declared states (idle/working/blocked/waiting_user) reflect current intent
 * and are PRESERVED across the rotation (the agent re-declares via set_status
 * if its mode changed). This is the single discriminator that lets
 * deriveAgentStatus treat a stored 'offline' as an unambiguous CURRENT-session
 * declaration.
 */
function statusAfterReregister(storedRaw: string | null | undefined): string {
  const s = normalizeStoredAgentStatus(storedRaw);
  if (ACTIVE_AGENT_STATES.has(s)) return s;
  return "idle"; // terminal states + anything unknown → fresh idle
}

/**
 * Derive the observed agent_status. CANONICAL PRECEDENCE (single source of
 * truth; the table-driven test in tests/v2-13-0-presence-liveness.test.ts
 * exercises every cell). Inputs: the STORED declared state (which a re-register
 * has already normalized — `statusAfterReregister` resets a prior-session
 * terminal state to idle, so a stored 'offline'/'closed' here means a
 * CURRENT-session declaration, never carried-over staleness), the last_seen
 * age, and the positive-liveness signal (`lastAlive`).
 *
 * Precedence, top wins:
 *   1. stored 'offline' (current-session declaration: set_status / force-rotation)
 *      → 'offline'  [→ 'abandoned' only past the abandon window, dashboard hygiene].
 *      Liveness does NOT override an explicit "unavailable" — a live process
 *      doesn't un-declare intent.
 *   2. fresh liveness (process confirmed alive now) → the declared ACTIVE state
 *      (idle default). Overrides age-derived stale/offline/abandoned AND a
 *      current-session 'closed' that somehow still has a live anchor.
 *   3. no liveness → the v2.1.3 age + stored-terminal chain (unchanged):
 *      abandoned > stored 'abandoned' > stored 'closed' > age-offline >
 *      stored 'stale' > age-stale > active.
 *
 * With no `lastAlive` (NULL), rules 1+3 are exactly the pre-v2.13 behavior —
 * byte-identical for every agent without a liveness signal.
 */
export function deriveAgentStatus(
  storedRaw: string | null | undefined,
  lastSeen: string,
  lastAlive: string | null | undefined = null,
): AgentWithStatus["agent_status"] {
  const stored = normalizeStoredAgentStatus(storedRaw);
  const minutes = (Date.now() - new Date(lastSeen).getTime()) / 60_000;
  const abandonMinutes = getAgentAbandonMinutes();
  const aliveFresh = isAliveFresh(lastAlive);

  // 1. Explicit current-session 'offline' DECLARATION — wins over liveness.
  if (stored === "offline") {
    return minutes >= abandonMinutes ? "abandoned" : "offline";
  }

  // 2. Positive liveness — the agent's process is confirmed up.
  if (aliveFresh) {
    return ACTIVE_AGENT_STATES.has(stored) ? (stored as AgentWithStatus["agent_status"]) : "idle";
  }

  // 3. No liveness → age + stored-terminal chain (v2.1.3 behavior, unchanged).
  if (minutes >= abandonMinutes) return "abandoned";
  if (stored === "abandoned") return "abandoned";
  if (stored === "closed") return "closed";
  if (minutes >= AGENT_STATUS_OFFLINE_MINUTES) return "offline";
  if (stored === "stale") return minutes >= AGENT_STATUS_OFFLINE_MINUTES ? "offline" : "stale";
  if (minutes >= AGENT_STATUS_STALE_MINUTES) return "stale";
  if (ACTIVE_AGENT_STATES.has(stored)) return stored as AgentWithStatus["agent_status"];
  return "idle";
}

/** Parse the stored host_shell_pids JSON column → number[] | null. Tolerates
 *  null + malformed JSON (both → null) so one bad row can't crash discover_agents. */
function parseHostShellPids(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((n) => typeof n === "number")) {
      return parsed as number[];
    }
    return null;
  } catch {
    return null;
  }
}

function toAgentWithStatus(row: AgentRecord): AgentWithStatus {
  const derivedAgentStatus = deriveAgentStatus(row.agent_status, row.last_seen, row.last_alive);
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    capabilities: JSON.parse(row.capabilities) as string[],
    last_seen: row.last_seen,
    created_at: row.created_at,
    status: computeStatus(row.last_seen),
    has_token: !!row.token_hash,
    agent_status: derivedAgentStatus,
    // v2.13.0 — positive-liveness surface. `last_alive` is the ISO timestamp
    // of the most recent confirmation; `alive` is the trustworthy "awake +
    // available right now?" answer. It requires a fresh confirmation AND that
    // the surfaced status is an active state — so an agent that DECLARED itself
    // offline (or is closed/abandoned) reads alive=false even if its process
    // happens to still be up, keeping `alive` consistent with `agent_status`.
    last_alive: row.last_alive ?? null,
    alive: isAliveFresh(row.last_alive) && ACTIVE_AGENT_STATES.has(derivedAgentStatus),
    description: row.description ?? null,
    session_id: row.session_id ?? null,
    terminal_title_ref: row.terminal_title_ref ?? null,
    // Tether v0.3 PID-handshake: parse the stored JSON chain → number[] (null +
    // malformed both surface as null, never throw).
    host_shell_pids: parseHostShellPids(row.host_shell_pids),
    host_id: row.host_id ?? null,
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
  migrateSchemaToV2_9(_db);
  migrateSchemaToV2_10(_db);
  migrateSchemaToV2_11(_db);
  migrateSchemaToV2_12(_db);
  migrateSchemaToV2_13(_db);
  migrateSchemaToV2_14(_db);
  migrateSchemaToV2_15(_db);
  migrateSchemaToV2_16(_db);
  seedBuiltinTaskSchemas(_db);
  finalizeSchemaVersion(_db);
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
  migrateSchemaToV2_9(_db);
  migrateSchemaToV2_10(_db);
  migrateSchemaToV2_11(_db);
  migrateSchemaToV2_12(_db);
  migrateSchemaToV2_13(_db);
  migrateSchemaToV2_14(_db);
  migrateSchemaToV2_15(_db);
  migrateSchemaToV2_16(_db);
  seedBuiltinTaskSchemas(_db);
  finalizeSchemaVersion(_db);
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
export const CURRENT_SCHEMA_VERSION = 18;

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
 * v2.7 Tether Phase 3 R1 — advance the recorded schema_info.version to
 * `target` if it is currently behind. Idempotent + safe to call multiple
 * times. Returns the prior version if a bump occurred, or null if no
 * advance was needed.
 *
 * Why this exists: initSchema uses `INSERT OR IGNORE` to populate the
 * single schema_info row. On a FRESH DB the inserted row carries
 * CURRENT_SCHEMA_VERSION, which is correct. But on an EXISTING DB that
 * was initialized under a prior code version, the row already has an
 * older version and the IGNORE clause leaves it untouched — so every
 * subsequent migrateSchemaToV2_X function runs (idempotently, via
 * CREATE TABLE IF NOT EXISTS + ALTER ... ADD COLUMN-with-existence-
 * guard), structurally bringing the DB up to current shape, but the
 * recorded `schema_info.version` field stays at the old number forever.
 *
 * Codex caught this in Phase 3 R1 audit on a live v11 DB whose
 * inbox_events table existed (v12 content) but whose version row still
 * said 11. The bug was latent in every prior bump (v10→v11, v9→v10, …)
 * but only surfaced now because `relay doctor` started comparing the
 * stored version against CURRENT_SCHEMA_VERSION verbatim.
 *
 * Walk-analogous: every prior migration had this same bug. The fix
 * here is structural — one helper, called from both init chains AND
 * each applyMigration case, so the pattern is correct for v12→v13,
 * v13→v14, and all future bumps without needing per-case code.
 */
function advanceSchemaVersionIfBehind(db: CompatDatabase, target: number): number | null {
  const row = db
    .prepare("SELECT version FROM schema_info WHERE id = 1")
    .get() as { version: number } | undefined;
  if (!row) return null;
  if (row.version >= target) return null;
  const prior = row.version;
  db.prepare("UPDATE schema_info SET version = ?, last_migrated_at = ? WHERE id = 1")
    .run(target, now());
  log.info(
    `[schema] advanced schema_info.version ${prior} → ${target} (post-migration sync; ` +
    `idempotent additive migrations had already brought DB structure to v${target})`
  );
  return prior;
}

/**
 * Hook point for backup/restore's schema-version dispatcher. Each
 * registered (from, to) pair acknowledges a known migration AND syncs
 * schema_info.version to `to` so the recorded version doesn't drift
 * behind the actual DB shape after a restore round-trip. Throws for
 * unregistered pairs so callers see a clear actionable error rather
 * than a silent no-op.
 *
 * Init-time mutations are applied via the migrateSchemaToV2_X
 * functions, which run unconditionally at startup. applyMigration is
 * NOT on the init path; it is invoked by src/backup.ts during restore.
 * The same advance helper runs at the end of the init chain
 * ({@link finalizeSchemaVersion}) so neither path leaves
 * schema_info.version stale.
 */
export function applyMigration(from: number, to: number): void {
  // v2.1 Phase 4b.1 v2 + Phase 4p + … Phase 7q + v2.7 Tether Phase 3:
  // schema_version migrations 1→2 through 11→12 are applied via the
  // migrateSchemaToV1_7 / migrateSchemaToV2_X functions which run
  // unconditionally at init under additive-idempotent guards. The
  // mutation already happened at init; this hook ALSO syncs the
  // stored version field via advanceSchemaVersionIfBehind so a
  // backup→restore round-trip cannot leave a structurally-current
  // DB with a stale recorded version (Codex R1 finding).
  const registeredPairs: Array<[number, number]> = [
    [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7],
    [7, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13],
    [13, 14],
    [14, 15],
    [15, 16],
    [16, 17],
    [17, 18],
  ];
  for (const [f, t] of registeredPairs) {
    if (from === f && to === t) {
      advanceSchemaVersionIfBehind(getDb(), to);
      return;
    }
  }
  throw new Error(
    `no migration registered for schema_version ${from}→${to}. ` +
    `Register a handler in src/db.ts applyMigration and update CURRENT_SCHEMA_VERSION.`
  );
}

/**
 * Init-chain finalizer — runs at the END of both initializeDb and getDb
 * chains, after every migrateSchemaToV2_X has executed. Sole job:
 * advance schema_info.version to CURRENT_SCHEMA_VERSION if it is
 * currently behind. See {@link advanceSchemaVersionIfBehind} for the
 * full rationale.
 */
function finalizeSchemaVersion(db: CompatDatabase): void {
  advanceSchemaVersionIfBehind(db, CURRENT_SCHEMA_VERSION);
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
 *      monotonic next_seq counter. Phase 4s in v2.2 will assign seq
 *      on FIRST OBSERVATION (recipient's get_messages drain) and
 *      surface it via `peek_inbox_version`. Table is empty in v2.1.0.
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

/**
 * v2.3.0 Part C.1 — Phase 4s ambient-wake mailbox model (Codex Q9 locked
 * 2026-04-19).
 *
 * Pre-v2.3.0, migrateSchemaToV2_4 seeded empty `mailbox` + `agent_cursor`
 * namespace-reserved tables with placeholder column shapes. v2.3.0 wires
 * them up + extends the schema:
 *
 * Additions to `mailbox`:
 *   - agent_name TEXT — the owning agent. One mailbox row per agent.
 *   - created_at TEXT — ISO timestamp. First-seen marker for ops review.
 *
 * Additions to `agent_cursor`:
 *   - agent_name TEXT — the owning agent.
 *   - updated_at TEXT — ISO timestamp.
 *
 * Additions to `messages`:
 *   - seq INTEGER — assigned on FIRST OBSERVATION (the recipient's
 *     get_messages drain path at :3181-3199 runs UPDATE messages SET
 *     seq = ... WHERE seq IS NULL via an atomic increment of
 *     mailbox.next_seq). NULL for messages that haven't been observed
 *     by their recipient yet. NOT assigned on send and NOT on delivery.
 *   - epoch TEXT — snapshotted from mailbox.epoch on first observation
 *     (same code path). Lets a recipient detect a backup/restore by
 *     comparing its cached cursor epoch vs the messages it just
 *     received.
 *
 * Epoch is TEXT (UUID) per the locked ambient-wake design. Epoch rotates on `relay
 * backup` + `relay restore` so restored DBs don't silently over-filter
 * cursors that were recorded against the pre-backup seq space.
 *
 * Additive + idempotent. Existing pre-v2.3.0 messages stay seq=NULL +
 * epoch=NULL — they get assigned the first time their recipient reads
 * them via the v2.3.0 getMessages first-observation assignment path
 * (see :3181-3199).
 */
function migrateSchemaToV2_9(db: CompatDatabase): void {
  // mailbox — add agent_name + created_at columns if missing.
  const mailboxCols = db
    .prepare("PRAGMA table_info(mailbox)")
    .all() as Array<{ name: string }>;
  if (!mailboxCols.some((c) => c.name === "agent_name")) {
    db.exec("ALTER TABLE mailbox ADD COLUMN agent_name TEXT");
  }
  if (!mailboxCols.some((c) => c.name === "created_at")) {
    db.exec("ALTER TABLE mailbox ADD COLUMN created_at TEXT");
  }
  // Unique index on agent_name so one mailbox per agent. Defensive
  // because the Phase 7q stub didn't enforce this.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_mailbox_agent_name ON mailbox(agent_name)");

  // agent_cursor — add agent_name + updated_at columns if missing.
  const cursorCols = db
    .prepare("PRAGMA table_info(agent_cursor)")
    .all() as Array<{ name: string }>;
  if (!cursorCols.some((c) => c.name === "agent_name")) {
    db.exec("ALTER TABLE agent_cursor ADD COLUMN agent_name TEXT");
  }
  if (!cursorCols.some((c) => c.name === "updated_at")) {
    db.exec("ALTER TABLE agent_cursor ADD COLUMN updated_at TEXT");
  }

  // messages — add seq + epoch columns. Populated on first observation
  // by getMessages (the drain path at :3181-3199 — NOT at send, NOT at
  // delivery); a NULL seq means "not yet observed by recipient".
  const messageCols = db
    .prepare("PRAGMA table_info(messages)")
    .all() as Array<{ name: string }>;
  if (!messageCols.some((c) => c.name === "seq")) {
    db.exec("ALTER TABLE messages ADD COLUMN seq INTEGER");
  }
  if (!messageCols.some((c) => c.name === "epoch")) {
    db.exec("ALTER TABLE messages ADD COLUMN epoch TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_to_seq ON messages(to_agent, seq)");
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

/**
 * v2.7 / Tether Phase 3 — durable outbox table for cross-process inbox
 * notifications.
 *
 * THE PROBLEM: pre-Phase-3 the daemon's MCP subscription fan-out used an
 * in-process EventEmitter (`src/inbox-events.ts:bus`). When a stdio MCP
 * server (different process) wrote a message to the SAME shared
 * `~/.bot-relay/instances/<uuid>/relay.db`, the HTTP daemon's process
 * never observed the in-memory event — its bus is module-local. Result:
 * the Tether VS Code smoke saw extension `connected + subscribed` but
 * never received `notifications/resources/updated` for messages
 * originating in other processes (the common operator shape).
 *
 * THE FIX: every emitInboxChanged producer now ALSO INSERTs a row into
 * `inbox_events`. The HTTP daemon polls this table on a 100ms (default)
 * cadence; new rows trigger `sendResourceUpdated` to subscribers in the
 * daemon's local mcp-subscriptions registry. The in-process bus stays
 * for the same-process fast path (Q-HTTP-1 + every existing subscription
 * test keeps passing without modification); the daemon's broadcaster
 * dedups by event id so same-process traffic isn't double-fired.
 *
 * Schema notes:
 *   - `id` is autoincrement primary key — monotonic across all writers
 *     because SQLite serializes writes at the file lock. The poller's
 *     cursor is just `MAX(id) seen`. New rows have id > cursor by
 *     construction.
 *   - `reason` CHECK matches the InboxChangedEvent enum at
 *     `src/inbox-events.ts`. Stay in sync — drift here means the daemon
 *     rejects valid events at INSERT time, surfacing as a write failure
 *     in the producer.
 *   - `source_pid` is a debugging aid — lets `[broadcast-trace]` log
 *     lines correlate which process wrote which event when multiple
 *     stdio servers are active alongside the HTTP daemon.
 *   - Indexes: `idx_inbox_events_id_after` for the poller's tail
 *     (`id > ? ORDER BY id`); `idx_inbox_events_agent_id` for any future
 *     query that wants per-agent history.
 *
 * Migration is additive; existing databases get the table on next init.
 * No data backfill needed — pre-existing messages don't trigger a
 * synthetic event (they're already in subscribers' inboxes; the outbox
 * is for FUTURE writes only).
 */
function migrateSchemaToV2_10(db: CompatDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('message_received', 'message_read', 'broadcast_received')),
      created_at TEXT NOT NULL,
      source_pid INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_events_id_after ON inbox_events(id);
    CREATE INDEX IF NOT EXISTS idx_inbox_events_agent_id ON inbox_events(agent_name, id);
  `);
}

/**
 * v2.8 dashboard-state-machine — agent state machine signal/dispatch columns
 * (schema v12 → v13, locked during the v2.8 dashboard state-machine design review).
 *
 * Three new NULL-default columns on `agents` to support the 5-state
 * `deriveDashboardState` derivation:
 *
 *   - `signal_received_at INTEGER NULL` — epoch ms when the agent's stdio
 *     process caught SIGHUP / SIGINT / SIGTERM. NULL until a signal fires.
 *     Populated by `installAutoUnregister` at src/transport/stdio.ts so the
 *     `closed` state can be derived without a wall-clock heuristic on
 *     last_seen.
 *   - `signal_kind TEXT NULL` — one of 'SIGHUP' / 'SIGINT' / 'SIGTERM' for
 *     dashboard visibility into which path closed the terminal. iTerm2
 *     tab-close sends SIGHUP; ctrl-C sends SIGINT; OS shutdown sends
 *     SIGTERM. Operator-meaningful distinction surfaced in v2.9 UI.
 *   - `last_dispatched_at INTEGER NULL` — epoch ms of the most recent
 *     dispatch-relevant event (high-priority message received, task
 *     posted to this agent). Powers the `stale` derivation by answering
 *     "was this agent given something to do recently?" — agents that
 *     went quiet without recent dispatch are `waiting`, not `stale`.
 *
 * All three columns are NULL on existing rows; their absence cleanly
 * routes through the v2.7 fallback path in `deriveDashboardState`
 * (no signal → no `closed` derivation; no dispatch → no `stale`
 * promotion).
 *
 * Additive + idempotent — runs on every init, but ALTER TABLE ADD COLUMN
 * is guarded by PRAGMA table_info inspection so re-runs are no-ops.
 */
function migrateSchemaToV2_11(db: CompatDatabase): void {
  const agentCols = db
    .prepare("PRAGMA table_info(agents)")
    .all() as Array<{ name: string }>;
  if (!agentCols.some((c) => c.name === "signal_received_at")) {
    db.exec("ALTER TABLE agents ADD COLUMN signal_received_at INTEGER");
  }
  if (!agentCols.some((c) => c.name === "signal_kind")) {
    db.exec("ALTER TABLE agents ADD COLUMN signal_kind TEXT");
  }
  if (!agentCols.some((c) => c.name === "last_dispatched_at")) {
    db.exec("ALTER TABLE agents ADD COLUMN last_dispatched_at INTEGER");
  }
}

/**
 * v2.10 — capability-routed messaging (FYI/coordination lane). schema v13 → v14.
 *
 * One additive, NULL-default column on `messages`:
 *   - `routed_capability TEXT NULL` — NULL on every point-to-point
 *     send_message / broadcast row (the action lane). Set to the single
 *     capability tag when a row was fanned out via post_to_capability
 *     (the FYI lane). Makes the action-vs-FYI line machine-enforceable +
 *     lets get_messages(lane=...) drain the two lanes separately, so an
 *     action-required completion report is never lost in FYI noise.
 *
 * Additive + idempotent — guarded by PRAGMA table_info so re-runs no-op.
 * NULL on every existing row = zero data migration.
 */
function migrateSchemaToV2_12(db: CompatDatabase): void {
  const msgCols = db
    .prepare("PRAGMA table_info(messages)")
    .all() as Array<{ name: string }>;
  if (!msgCols.some((c) => c.name === "routed_capability")) {
    db.exec("ALTER TABLE messages ADD COLUMN routed_capability TEXT");
  }
}

/**
 * v2.10 — schema-gated task completion (safety). schema v14 → v15.
 *
 * Additive, idempotent:
 *   - new `task_schemas` table: reusable, immutable JSON Schema documents
 *     (id = name-as-version, e.g. "ship_pong_v1"). A registered schema is
 *     compiled by ajv, so registration is authz-restricted at the tool layer
 *     and the document is meta-validated BEFORE compile (see
 *     src/task-schema-validator.ts).
 *   - new nullable `tasks.schema_id` column: NULL = un-gated (completes
 *     exactly as today — the opt-in / backward-compat flag). Non-NULL gates
 *     the accepted→completed transition on the stored schema.
 *
 * PRAGMA-guarded ALTER so re-runs no-op; NULL on every existing task row =
 * zero data migration.
 */
function migrateSchemaToV2_13(db: CompatDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_schemas (
      id          TEXT PRIMARY KEY,
      json_schema TEXT NOT NULL,
      created_by  TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
  `);
  const taskCols = db
    .prepare("PRAGMA table_info(tasks)")
    .all() as Array<{ name: string }>;
  if (!taskCols.some((c) => c.name === "schema_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN schema_id TEXT");
  }
}

/**
 * Tether v0.3 PID-handshake — schema v15 → v16.
 *
 * Two new nullable TEXT columns on `agents`:
 *   - `host_shell_pids` — JSON-stringified number[] (the agent's process-
 *     ancestry PID chain). Mutable on re-register (OVERWRITES, never appends).
 *     NULL on legacy rows / agents that don't report it. Parsed to number[] at
 *     read time by toAgentWithStatus.
 *   - `host_id` — stable OS machine GUID (macOS IOPlatformUUID / Linux
 *     /etc/machine-id / Windows MachineGuid). Host-scopes the PID match so
 *     equal PIDs on different hosts can't false-match (federation-safe).
 *     Immutable after first registration (same rule as `managed`). NULL on
 *     legacy rows.
 *
 * Additive + idempotent — PRAGMA-guarded so re-runs no-op; NULL on every
 * existing row = zero data migration.
 */
function migrateSchemaToV2_14(db: CompatDatabase): void {
  const agentCols = db
    .prepare("PRAGMA table_info(agents)")
    .all() as Array<{ name: string }>;
  if (!agentCols.some((c) => c.name === "host_shell_pids")) {
    db.exec("ALTER TABLE agents ADD COLUMN host_shell_pids TEXT");
  }
  if (!agentCols.some((c) => c.name === "host_id")) {
    db.exec("ALTER TABLE agents ADD COLUMN host_id TEXT");
  }
}

/**
 * v2.12.0 — pending-vs-history. schema v16 → v17.
 *
 * One additive, NULL-default column on `messages`:
 *   - `resolved_at TEXT NULL` — ISO timestamp set when the recipient
 *     permanently RESOLVES (acks) a message; NULL = unresolved. This is a
 *     SESSION-INDEPENDENT plane, orthogonal to the existing session-scoped
 *     read plane (`status` / `read_by_session`): "read" is a per-session
 *     observation, "resolved" is a permanent "handled, archive it."
 *
 * Why: the pending read model is session-scoped on purpose (a fresh
 * terminal re-sees previously-read mail so handovers never drop unfinished
 * work — v2.0 final #6). The side effect is that ALREADY-HANDLED mail also
 * re-floods every new session. The `pending` filter gains `AND resolved_at
 * IS NULL`, so resolved items leave the action queue permanently while
 * unfinished work still re-surfaces across sessions.
 *
 * Additive + idempotent — PRAGMA-guarded so re-runs no-op. NULL on every
 * existing row = zero data migration; every currently-pending row stays
 * pending until an agent opts into resolving (ack / resolve_messages).
 */
function migrateSchemaToV2_15(db: CompatDatabase): void {
  const msgCols = db
    .prepare("PRAGMA table_info(messages)")
    .all() as Array<{ name: string }>;
  if (!msgCols.some((c) => c.name === "resolved_at")) {
    db.exec("ALTER TABLE messages ADD COLUMN resolved_at TEXT");
  }
}

/**
 * v2.13.0 — presence liveness. schema v17 → v18.
 *
 * Three additive, NULL-default columns on `agents`:
 *   - `last_alive TEXT NULL` — ISO timestamp of the most recent POSITIVE
 *     liveness confirmation (a same-host probe found the agent's own process
 *     alive; future: a Tether heartbeat). Distinct from `last_seen` (activity)
 *     and `last_dispatched_at`. A fresh `last_alive` proves the agent is open
 *     even while idle, so the presence derivations stop misreading an
 *     alive-and-idle agent as offline/closed.
 *   - `agent_pid INTEGER NULL` — the agent's OWN process id (the claude/codex
 *     CLI), identified by the stdio server's ancestry walk (or self-reported
 *     by managed/script agents on register). This is the process we probe —
 *     NOT the host_shell_pids ancestry chain, whose shell/terminal ancestors
 *     outlive the agent. Dies exactly when the agent exits/crashes.
 *   - `agent_pid_start TEXT NULL` — the agent process's start-time token, a
 *     PID-reuse guard: a recycled PID (new process, different start-time)
 *     reads dead.
 *
 * Additive + idempotent — PRAGMA-guarded so re-runs no-op. NULL on every
 * existing row = zero data migration; with no liveness signal the agent
 * derives exactly as today (pure age-based) until a probe populates it.
 */
function migrateSchemaToV2_16(db: CompatDatabase): void {
  const agentCols = db
    .prepare("PRAGMA table_info(agents)")
    .all() as Array<{ name: string }>;
  if (!agentCols.some((c) => c.name === "last_alive")) {
    db.exec("ALTER TABLE agents ADD COLUMN last_alive TEXT");
  }
  if (!agentCols.some((c) => c.name === "agent_pid")) {
    db.exec("ALTER TABLE agents ADD COLUMN agent_pid INTEGER");
  }
  if (!agentCols.some((c) => c.name === "agent_pid_start")) {
    db.exec("ALTER TABLE agents ADD COLUMN agent_pid_start TEXT");
  }
}

function purgeOldRecords(db: CompatDatabase): void {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare("DELETE FROM messages WHERE created_at < ?").run(sevenDaysAgo);
  db.prepare("DELETE FROM tasks WHERE status IN ('completed', 'rejected', 'cancelled') AND updated_at < ?").run(thirtyDaysAgo);
  db.prepare("DELETE FROM webhook_delivery_log WHERE attempted_at < ?").run(sevenDaysAgo);
  // v2.7 / Tether Phase 3 — outbox cleanup. Match the messages purge
  // window by default (7 days). Configurable via RELAY_OUTBOX_RETENTION_DAYS
  // for operators who want a longer audit trail; set to 0 to disable.
  const outboxRetentionDays = (() => {
    const raw = process.env.RELAY_OUTBOX_RETENTION_DAYS;
    if (raw === undefined || raw === "") return 7;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 7;
  })();
  if (outboxRetentionDays > 0) {
    const outboxCutoff = new Date(Date.now() - outboxRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("DELETE FROM inbox_events WHERE created_at < ?").run(outboxCutoff);
  }
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
    // v2.13.0 — positive-liveness timestamp (same-host PID probe / heartbeat).
    // Non-auth-state field, same single-site writer as the rest.
    last_alive?: string;
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
 * v2.13.0 — record the agent's OWN process as its liveness anchor. Called by
 * the stdio MCP server at startup (it walks its ancestry to find the agent
 * CLI) and by register_agent self-report (managed/script agents). Sets
 * agent_pid + agent_pid_start, and fills host_id with the relay's own machine
 * GUID iff currently NULL (so the same-host probe can match; never overwrites
 * a host_id the handshake already set). Clears any stale negative-probe verdict
 * so a freshly-relaunched agent isn't briefly dead-cached. No-op (false) if the
 * row doesn't exist yet. Sanctioned single-site agents mutation (lives in db.ts).
 */
export function setAgentLivenessAnchor(
  name: string,
  pid: number,
  startedAt: string | null,
): boolean {
  if (!name || !Number.isInteger(pid) || pid <= 0) return false;
  const db = getDb();
  const ownHost = getOwnHostId();
  const r = db
    .prepare(
      "UPDATE agents SET agent_pid = ?, agent_pid_start = ?, host_id = COALESCE(host_id, ?) WHERE name = ?",
    )
    .run(pid, startedAt, ownHost, name);
  if (r.changes > 0) _negativeProbeCache.delete(name);
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
    // v2.13.0 — clear the liveness anchor in the SAME CAS so a same-host probe
    // can't restamp last_alive and mask this offline transition.
    "UPDATE agents SET session_id = NULL, agent_status = 'offline', busy_expires_at = NULL, " +
    "last_alive = NULL, agent_pid = NULL, agent_pid_start = NULL " +
    "WHERE name = ? AND session_id = ?"
  ).run(name, expectedSessionId);
  if (r.changes === 1) _negativeProbeCache.delete(name);
  return { changed: r.changes === 1 };
}

/**
 * v2.2.2 BUG2 — sanctioned closed-session transition for a stdio
 * terminal that is shutting down *intentionally* (SIGINT / SIGTERM).
 *
 * Supersedes the `markAgentOffline` call previously used by
 * `performAutoUnregister`. Same CAS predicate (`name = ? AND
 * session_id = ?`) — a concurrent terminal that rotated session_id
 * between our SIGINT capture and this call wins the race. Difference:
 * sets `agent_status = 'closed'` instead of `'offline'` so dashboards
 * can distinguish retired-by-intent terminals from
 * offline-but-might-return. Preserved fields are identical (token_hash,
 * auth_state, capabilities, last_seen, …).
 *
 * Auto-promotion to `abandoned` still fires at RELAY_AGENT_ABANDON_DAYS
 * via deriveAgentStatus (age-based), so closed terminals don't linger
 * visible forever — they follow the same retirement arc as offline.
 */
export function closeAgentSession(
  name: string,
  expectedSessionId: string,
  /**
   * v2.8 — optional signal kind that triggered this close. Mirrors
   * into the new `signal_received_at` + `signal_kind` columns the
   * v2.8 state machine reads. Stays NULL for non-signal close paths
   * (e.g. explicit unregister via MCP tool), which keeps the legacy
   * `agent_status='closed'` semantics intact while the v2.8
   * `deriveDashboardState` derivation routes through
   * `signalReceivedAt` for signal-triggered closes specifically.
   */
  signalKind: "SIGHUP" | "SIGINT" | "SIGTERM" | null = null,
): { changed: boolean } {
  const db = getDb();
  // Conditional UPDATE so non-signal callers preserve the legacy
  // behavior: signal_received_at + signal_kind stay NULL unless this
  // call carries one. Two SQL forms are cheaper to maintain than a
  // dynamic builder + safer than a single COALESCE form that could
  // smuggle a NULL through and clear an already-set signal stamp.
  // v2.13.0 — clear the liveness anchor (last_alive + agent_pid + start) in the
  // SAME CAS as the close so a same-host probe can't restamp last_alive and
  // mask the close. Applies to both SQL forms.
  if (signalKind === null) {
    const r = db.prepare(
      "UPDATE agents SET session_id = NULL, agent_status = 'closed', busy_expires_at = NULL, " +
      "last_alive = NULL, agent_pid = NULL, agent_pid_start = NULL " +
      "WHERE name = ? AND session_id = ?"
    ).run(name, expectedSessionId);
    if (r.changes === 1) _negativeProbeCache.delete(name);
    return { changed: r.changes === 1 };
  }
  const nowMs = Date.now();
  const r = db.prepare(
    "UPDATE agents SET session_id = NULL, agent_status = 'closed', busy_expires_at = NULL, " +
    "signal_received_at = ?, signal_kind = ?, " +
    "last_alive = NULL, agent_pid = NULL, agent_pid_start = NULL " +
    "WHERE name = ? AND session_id = ?"
  ).run(nowMs, signalKind, name, expectedSessionId);
  if (r.changes === 1) _negativeProbeCache.delete(name);
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
 * v2.6.0 — sanctioned operator-side mint of an agent token.
 *
 * Backs `relay mint-token <name>`. Two paths:
 *
 *   - First mint (no existing row): INSERT a fresh agent row with role,
 *     capabilities, and an optional description. Defaults match the CLI:
 *     `role` and `capabilities` are caller-supplied (CLI passes its own
 *     defaults). agent_status='idle' (matches registerAgent first-mint).
 *
 *   - Force rotate (existing row + options.force=true): rotate token only.
 *     Caps are PRESERVED (caps are immutable after first registration); role is
 *     also preserved so a force-rotate cannot quietly relabel an agent.
 *     session_id is CLEARED and agent_status set to 'offline' so the next
 *     time the agent process authenticates, the dashboard accurately
 *     reflects the rotation: the prior session is invalid, and a fresh
 *     env-token bootstrap must occur out-of-band before the agent can
 *     reach the relay again. Auth-state side fields
 *     (previous_token_hash / rotation_grace_expires_at /
 *     recovery_token_hash / revoked_at) are zeroed because mint-token is
 *     defined as a clean reset, not a graceful rotation: any in-flight
 *     state on the auth machine is invalidated.
 *
 *   - Existing row WITHOUT --force: throws so the caller can surface the
 *     destructive nature of the operation. The CLI maps this to a clean
 *     stderr error pointing at --force.
 *
 * Mirrors registerAgent's INSERT shape exactly (same 13 columns) so a
 * minted-but-never-registered row is indistinguishable from a registered
 * row at the auth layer. The agent process can then authenticate via
 * RELAY_AGENT_TOKEN env without ever calling register_agent — which is
 * the whole point: it sidesteps the LLM-client safety monitors that
 * pattern-match register-then-use sequences as credential handoff.
 */
export function mintAgentToken(
  name: string,
  role: string,
  capabilities: string[],
  options: {
    description?: string | null;
    force?: boolean;
  } = {}
): { agent: AgentWithStatus; plaintext_token: string; created: boolean } {
  const db = getDb();
  const timestamp = now();
  const existing = db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as
    | AgentRecord
    | undefined;

  const plaintext_token = generateToken();
  const token_hash = hashToken(plaintext_token);

  if (!existing) {
    const id = uuidv4();
    const session_id = uuidv4();
    const description = options.description ?? null;
    const capsJson = JSON.stringify(capabilities);
    const tx = db.transaction(() => {
      db.prepare(
        "INSERT INTO agents (id, name, role, capabilities, last_seen, created_at, token_hash, session_id, session_started_at, description, agent_status, managed, terminal_title_ref) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', 0, NULL)"
      ).run(id, name, role, capsJson, timestamp, timestamp, token_hash, session_id, timestamp, description);
      const insertCap = db.prepare(
        "INSERT OR IGNORE INTO agent_capabilities (agent_name, capability) VALUES (?, ?)"
      );
      for (const cap of capabilities) {
        if (cap) insertCap.run(name, cap);
      }
    });
    tx();

    const fresh = db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as AgentRecord;
    return {
      agent: toAgentWithStatus(fresh),
      plaintext_token,
      created: true,
    };
  }

  if (!options.force) {
    throw new Error(
      `Agent "${name}" already exists. Pass --force to mint a new token (rotates + invalidates the existing token, clears session, sets status=offline).`
    );
  }

  // Force-rotate: token-only. Caps + role preserved (immutability + safety).
  // Description is preserved when not supplied; if explicitly supplied (even
  // null) the caller is updating it. CLI doesn't expose --description on the
  // rotate path in v2.6.0 to keep the surface tight; future-add via this hook.
  const newDescription =
    options.description !== undefined ? options.description : existing.description ?? null;
  const tx = db.transaction(() => {
    const r = db.prepare(
      "UPDATE agents SET last_seen = ?, token_hash = ?, session_id = NULL, " +
        "agent_status = 'offline', auth_state = 'active', " +
        "previous_token_hash = NULL, rotation_grace_expires_at = NULL, " +
        "recovery_token_hash = NULL, revoked_at = NULL, " +
        "description = ? " +
        "WHERE name = ?"
    ).run(timestamp, token_hash, newDescription, name);
    if (r.changes !== 1) {
      throw new Error(
        `mintAgentToken UPDATE failed for "${name}": no rows affected (concurrent unregister?).`
      );
    }
  });
  tx();

  const updated = db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as AgentRecord;
  return {
    agent: toAgentWithStatus(updated),
    plaintext_token,
    created: false,
  };
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
    /** Tether v0.3 PID-handshake: agent process-ancestry PID chain. On re-register, OVERWRITES the stored chain when provided; preserved when omitted. */
    host_shell_pids?: number[];
    /** Tether v0.3 PID-handshake: OS machine GUID. v2.11.0 GAP 1: session-refreshable on an authenticated re-register (provided→overwrite, omitted→preserve), mirroring host_shell_pids. Captured on first registration; the token-holder may refresh it on relaunch (e.g. to populate an empty host_id or after a machine move). */
    host_id?: string;
  } = {}
): { agent: AgentWithStatus; plaintext_token: string | null; auto_assigned: QueuedAssignment[] } {
  const db = getDb();
  const timestamp = now();
  const capsJson = JSON.stringify(capabilities);
  // v2.0 final (#6): rotate session_id on EVERY register_agent call. A new
  // terminal = a new session = previously-read messages reappear. This is
  // the fix for the bug where a prior session's terminal had already
  // marked an audit message as read.
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
    // Tether v0.3 PID-handshake (H3): re-register OVERWRITES host_shell_pids
    // when the caller re-reports it; preserves the stored chain when omitted (a
    // re-register that doesn't re-report PIDs must not wipe the binding).
    // v2.11.0 GAP 1: host_id is now session-refreshable too (was immutable).
    // Same provided→overwrite / omitted→preserve semantics. The re-register
    // path is auth-gated by enforceAuth (server.ts) — an active row can only
    // be re-registered by the token-holder — so a host_id refresh is the
    // OWNER declaring its current machine GUID, never a cross-agent overwrite.
    // This closes the empty-host_id case (long-lived agent rows created
    // before the handshake, or via the SKIP_REGISTER-then-relaunch path) where
    // an immutable host_id could never be populated on relaunch.
    const newHostShellPids =
      options.host_shell_pids !== undefined
        ? JSON.stringify(options.host_shell_pids)
        : existing.host_shell_pids ?? null;
    const newHostId =
      options.host_id !== undefined
        ? options.host_id
        : existing.host_id ?? null;
    // v2.13.0 — a fresh session resets a TERMINAL lifecycle state (offline/
    // closed/abandoned/stale) to idle so a genuinely RESUMED agent (relaunch,
    // or the next valid registration after a force token rotation) comes back
    // available instead of staying stuck offline. Active states are preserved.
    const newAgentStatus = statusAfterReregister(existing.agent_status);
    const r = db.prepare(
      "UPDATE agents SET role = ?, last_seen = ?, token_hash = ?, session_id = ?, session_started_at = ?, description = ?, " +
      "terminal_title_ref = ?, host_shell_pids = ?, host_id = ?, agent_status = ?, " +
      "auth_state = ?, recovery_token_hash = ?, revoked_at = ? " +
      "WHERE name = ? AND auth_state = ? AND token_hash IS ? AND recovery_token_hash IS ?"
    ).run(
      role, timestamp, newHash, session_id, timestamp, newDescription,
      newTitleRef, newHostShellPids, newHostId, newAgentStatus,
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
      host_shell_pids: newHostShellPids,
      host_id: newHostId,
      agent_status: newAgentStatus,
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
    // Tether v0.3 PID-handshake: capture the PID chain (JSON) + machine GUID on
    // first registration. v2.11.0 GAP 1: host_id is also refreshable on a later
    // authenticated re-register (see the UPDATE branch above) — no longer
    // insert-only.
    const hostShellPidsJson =
      options.host_shell_pids !== undefined ? JSON.stringify(options.host_shell_pids) : null;
    const hostId = options.host_id ?? null;
    db.prepare(
      // v2.1.3 (I6): default agent_status is now 'idle' (was 'online').
      // v2.1.6: session_started_at = timestamp for first-register anchor.
      // v2.2.0: terminal_title_ref captured on first register (may be null).
      // schema v16: host_shell_pids (JSON) + host_id captured on first register.
      "INSERT INTO agents (id, name, role, capabilities, last_seen, created_at, token_hash, session_id, session_started_at, description, agent_status, managed, terminal_title_ref, host_shell_pids, host_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?)"
    ).run(id, name, role, capsJson, timestamp, timestamp, token_hash, session_id, timestamp, description, managed, titleRef, hostShellPidsJson, hostId);

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
/**
 * v2.8 dashboard-state-machine — roles that count as "dispatch-relevant"
 * recipients for the `last_dispatched_at` stamp.
 *
 * Per the v2.8 dashboard state-machine design:
 *   "set by send_message when message has priority='high' OR recipient
 *    is a builder role"
 *
 * The set is intentionally tight: roles that represent agents whose
 * "I was given work" signal is operationally meaningful for the
 * dashboard's `stale` derivation (i.e. they're expected to be doing
 * work in response to messages/tasks, not just observing).
 *
 * If you need to extend the set, update CHANGELOG.md to document the
 * new role + the rationale before merging. The state machine reads
 * `last_dispatched_at` to discriminate `stale` (was working, went
 * quiet, recently dispatched) from `waiting` (just idle), so adding
 * roles widens the `stale` surface.
 */
export const DISPATCH_RELEVANT_ROLES: ReadonlySet<string> = new Set([
  "builder",
  "auditor",
  "researcher",
  "reviewer",
  "recon",
]);

/**
 * v2.8 dashboard-state-machine — stamp `agents.last_dispatched_at` on the
 * recipient row when the dispatch event qualifies. Called from
 * `sendMessage`, `postTask`, `postTaskAuto` after the message/task
 * commit so the row only gets stamped when the dispatch actually
 * landed.
 *
 * Stamping rule (mirrors brief at `:43`):
 *   - priority === 'high' (or 'critical')  → STAMP
 *   - recipient role in DISPATCH_RELEVANT_ROLES → STAMP
 *   - otherwise → NO-OP
 *
 * Best-effort: if the recipient row doesn't exist (rare race after
 * unregister) or the role lookup throws, the stamp is silently
 * skipped. The dispatch itself already committed; missing the
 * dashboard breadcrumb is non-fatal to the messaging contract.
 */
export function markRecipientDispatched(
  recipientName: string,
  priority: string | null,
): void {
  if (!recipientName || recipientName === "system") return;
  const db = getDb();
  try {
    const row = db
      .prepare("SELECT role FROM agents WHERE name = ?")
      .get(recipientName) as { role: string } | undefined;
    if (!row) return;
    const p = (priority ?? "").toLowerCase();
    const highPriority = p === "high" || p === "critical";
    const dispatchRole = DISPATCH_RELEVANT_ROLES.has(row.role);
    if (!highPriority && !dispatchRole) return;
    db.prepare("UPDATE agents SET last_dispatched_at = ? WHERE name = ?").run(
      Date.now(),
      recipientName,
    );
  } catch {
    // best-effort — never break the dispatch commit path
  }
}

/**
 * v2.8 dashboard-state-machine — bulk-fetch the registered agents in
 * the shape the decay broadcaster's `BroadcasterAgentSnapshot[]` needs.
 *
 * Pre-filters pending message counts by `created_at < now - pendingWindowMs`
 * per the brief's contract — only messages older than the pending window
 * count toward the `pending` derivation (fresh mail isn't "pending,
 * operator should look"; it's "active, agent is processing").
 *
 * `agent_state_machine.ts:207-212` explicitly says callers must do
 * this pre-filter BEFORE passing `pendingCount` to `deriveDashboardState`.
 *
 * Single SQL round-trip: agents JOIN messages (filtered by age). For
 * typical N < 20 registered agents this is fast.
 */
export function getDashboardAgentSnapshots(
  pendingWindowMs: number,
  nowMs: number = Date.now(),
): Array<{
  name: string;
  inputs: {
    lastSeen: string | null;
    signalReceivedAt: number | null;
    signalKind: string | null;
    unregisteredAt: number | null;
    pendingCount: number;
    lastDispatchedAt: number | null;
    lastAlive: string | null;
  };
}> {
  const db = getDb();
  const cutoffIso = new Date(nowMs - pendingWindowMs).toISOString();
  const rows = db
    .prepare(
      `SELECT
         a.name,
         a.last_seen,
         a.signal_received_at,
         a.signal_kind,
         a.last_dispatched_at,
         a.host_id,
         a.agent_pid,
         a.agent_pid_start,
         a.last_alive,
         (SELECT COUNT(*) FROM messages m
           WHERE m.to_agent = a.name
             AND m.status = 'pending'
             AND m.created_at < ?) AS pending_count_old
       FROM agents a`,
    )
    .all(cutoffIso) as Array<{
    name: string;
    last_seen: string | null;
    signal_received_at: number | null;
    signal_kind: string | null;
    last_dispatched_at: number | null;
    host_id: string | null;
    agent_pid: number | null;
    agent_pid_start: string | null;
    last_alive: string | null;
    pending_count_old: number | bigint;
  }>;
  // v2.13.0 — refresh positive liveness so the dashboard reflects alive-and-
  // idle agents too (mutates row.last_alive in place). Same host-scoped,
  // cache-gated probe getAgents() uses.
  refreshLivenessForRows(rows);
  return rows.map((r) => ({
    name: r.name,
    inputs: {
      lastSeen: r.last_seen,
      signalReceivedAt: r.signal_received_at,
      signalKind: r.signal_kind,
      // Production rows that completed unregister have been DELETEd
      // from the agents table (src/db.ts:2475-2492), so observed rows
      // never carry an `unregisteredAt`. The state machine field stays
      // useful for test fixtures.
      unregisteredAt: null,
      pendingCount: Number(r.pending_count_old),
      lastDispatchedAt: r.last_dispatched_at,
      lastAlive: r.last_alive,
    },
  }));
}

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
  /** v2.13.0 — agents confirmed alive RIGHT NOW (fresh same-host PID probe /
   *  heartbeat). The trustworthy "how many are actually awake?" count, vs the
   *  raw agent_count which includes idle/closed/abandoned rows. */
  agent_count_alive: number;
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
  // v2.13.0 — alive count routes through getAgents() so it reflects the same
  // positive-liveness probe discover_agents uses (not a stale age-based guess).
  const agentCountAlive = getAgents().filter((a) => a.alive).length;
  return {
    status: "ok",
    agent_count: agentCount,
    agent_count_alive: agentCountAlive,
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

/**
 * v2.13.0 — negative-probe cache. A dead agent has no fresh `last_alive` to
 * cache against, so without this every presence read would re-probe it (an
 * extra `ps`/kill per dead same-host row, every getAgents/health/standup).
 * Keyed by agent name → the wall-clock ms of the last dead verdict; within the
 * cache window we skip the re-probe. In-memory (process-local): a stale entry
 * at worst delays a fresh alive verdict by the cache window, never a wrong one.
 */
const _negativeProbeCache = new Map<string, number>();

/** Test-only: count of ACTUAL liveness probes (cache-miss isAgentProcessAlive
 *  calls), so tests can assert the positive/negative caches suppress re-probes. */
let _livenessProbeCount = 0;

/** Test-only: clear the negative-probe cache + reset the probe counter. */
export function _resetLivenessProbeCacheForTests(): void {
  _negativeProbeCache.clear();
  _livenessProbeCount = 0;
}

/** Test-only: read the probe counter. */
export function _getLivenessProbeCountForTests(): number {
  return _livenessProbeCount;
}

/**
 * v2.13.0 — lazy presence-liveness refresh. For each row that is (a) on THIS
 * host (host_id matches the relay's own GUID) and (b) has a recorded
 * `agent_pid` (the agent's OWN process — claude/codex — NOT the host_shell_pids
 * ancestry chain, whose shell/terminal ancestors outlive the agent), probe
 * that process. On a live hit, stamp `last_alive = now()` (mutating `row` in
 * place so the immediate map() sees it + persisting via the sanctioned writer).
 *
 * Skipped (→ unchanged age-based derivation): cross-host agents, agents with no
 * recorded agent_pid, agents whose `last_alive` is fresh within the cache
 * window (positive cache), and agents recently confirmed dead (negative cache).
 *
 * Cheap: gated by host match + both caches, a steady-state read does near-zero
 * probes.
 */
function refreshLivenessForRows(
  rows: Array<{
    name: string;
    host_id?: string | null;
    agent_pid?: number | null;
    agent_pid_start?: string | null;
    last_alive?: string | null;
  }>,
): void {
  const ownHost = getOwnHostId();
  if (!ownHost) return; // can't host-scope → never probe (cross-host fallback)
  const nowMs = Date.now();
  const ts = new Date(nowMs).toISOString();
  for (const row of rows) {
    if (!row.host_id || row.host_id !== ownHost) continue; // cross-host
    if (typeof row.agent_pid !== "number" || row.agent_pid <= 0) continue; // no anchor
    // Positive cache — a recent live confirmation is trusted as-is.
    if (row.last_alive) {
      const age = nowMs - Date.parse(row.last_alive);
      if (Number.isFinite(age) && age >= 0 && age < LIVENESS_PROBE_CACHE_MS) continue;
    }
    // Negative cache — recently-confirmed-dead rows aren't re-probed in-window.
    const deadAt = _negativeProbeCache.get(row.name);
    if (deadAt !== undefined && nowMs - deadAt < LIVENESS_PROBE_CACHE_MS) continue;

    _livenessProbeCount++;
    if (isAgentProcessAlive(row.agent_pid, row.agent_pid_start ?? null)) {
      row.last_alive = ts; // in-place so the subsequent map() reflects it
      _negativeProbeCache.delete(row.name);
      updateAgentMetadata(row.name, { last_alive: ts });
    } else {
      // Dead → record the verdict so we don't re-probe every read; leave
      // last_alive untouched so the age-based derivation applies.
      _negativeProbeCache.set(row.name, nowMs);
    }
  }
}

export function getAgents(role?: string): AgentWithStatus[] {
  const db = getDb();
  let rows: AgentRecord[];

  if (role) {
    rows = db.prepare("SELECT * FROM agents WHERE role = ? ORDER BY last_seen DESC").all(role) as AgentRecord[];
  } else {
    rows = db.prepare("SELECT * FROM agents ORDER BY last_seen DESC").all() as AgentRecord[];
  }

  // v2.13.0 — refresh positive liveness before deriving status so an alive-
  // and-idle agent reads alive, not offline/closed.
  refreshLivenessForRows(rows);
  return rows.map(toAgentWithStatus);
}

/**
 * v2.4.1 — per-agent inbox rollup for the dashboard.
 *
 * Single GROUP BY over agents LEFT JOIN messages so every registered agent
 * appears in the result, including those with zero mail (pending_count=0,
 * unread_count=0, last_message_at=null). Used by snapshotApi to decorate
 * agents[] without a second round-trip per row.
 *
 * Semantics:
 *   - pending_count — messages still in status='pending' (not yet drained
 *     by a get_messages call that flipped them to 'read').
 *   - unread_count  — messages whose seq is still NULL. Mirrors the
 *     peek_inbox_version v2.3 signal: seq is assigned the moment a
 *     recipient observes the message, so seq IS NULL is the authoritative
 *     "never-observed" count regardless of later status transitions.
 *   - last_message_at — ISO of MAX(created_at) across any status; NULL
 *     when the agent has no inbox history.
 */
export function getInboxSummary(): Array<{
  agent_name: string;
  pending_count: number;
  unread_count: number;
  last_message_at: string | null;
}> {
  const db = getDb();
  const rows = db
    .prepare(
      // LEFT JOIN surfaces agents with zero mail. Guard every CASE on
      // m.id IS NOT NULL so no-match rows (where every m.* is NULL) are
      // NOT miscounted as unread — SQL NULL IS NULL evaluates true, which
      // would inflate unread_count by 1 per mail-less agent.
      `SELECT a.name AS agent_name,
              COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND m.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count,
              COALESCE(SUM(CASE WHEN m.id IS NOT NULL AND m.seq IS NULL        THEN 1 ELSE 0 END), 0) AS unread_count,
              MAX(m.created_at) AS last_message_at
         FROM agents a
         LEFT JOIN messages m ON m.to_agent = a.name
        GROUP BY a.name`,
    )
    .all() as Array<{
      agent_name: string;
      pending_count: number;
      unread_count: number;
      last_message_at: string | null;
    }>;
  return rows.map((r) => ({
    agent_name: r.agent_name,
    pending_count: Number(r.pending_count) || 0,
    unread_count: Number(r.unread_count) || 0,
    last_message_at: r.last_message_at ?? null,
  }));
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
    // v2.7 / Tether Phase 3 — atomic message + outbox event in one tx so
    // the cross-process tail (src/outbox-tail.ts in the HTTP daemon) sees
    // a row iff the message commits, and never sees a row whose message
    // was rolled back. Outbox rowid is read after run() and threaded into
    // the in-process bus emit so same-process subscribers can dedup
    // against the daemon-side tail dispatch.
    let outboxId = 0;
    const tx = db.transaction(() => {
      db.prepare(
        "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
      ).run(id, from, to, encContent, priority, timestamp);
      const r = db.prepare(
        "INSERT INTO inbox_events (agent_name, reason, created_at, source_pid) VALUES (?, ?, ?, ?)"
      ).run(to, "message_received", timestamp, process.pid);
      outboxId = Number(r.lastInsertRowid);
    });
    tx();
    // v2.5.0 Tether Phase 1 — Part S — fan out an inbox-changed event so
    // MCP subscribers on relay://inbox/<to> get a notifications/resources/
    // updated push without polling. (Same-process fast path; cross-process
    // path is the outbox tail in the HTTP daemon.)
    emitInboxChanged({ agent_name: to, reason: "message_received", id: outboxId });
    // v2.8 — stamp recipient's last_dispatched_at when the dispatch is
    // priority='high'/'critical' OR recipient role is in
    // DISPATCH_RELEVANT_ROLES. Best-effort: never throws into the
    // sendMessage path. See markRecipientDispatched for the rule.
    markRecipientDispatched(to, priority);
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

  // v2.7 / Tether Phase 3 — atomic message + outbox event. See system
  // sender path above for rationale.
  let outboxId = 0;
  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
    ).run(id, from, to, encContent, priority, timestamp);
    const r = db.prepare(
      "INSERT INTO inbox_events (agent_name, reason, created_at, source_pid) VALUES (?, ?, ?, ?)"
    ).run(to, "message_received", timestamp, process.pid);
    outboxId = Number(r.lastInsertRowid);
  });
  tx();

  // v2.3.0 Part C.4 — touch the filesystem marker for the recipient so
  // ambient-wake clients watching the marker path get a low-latency
  // wake signal. Off by default (RELAY_FILESYSTEM_MARKERS=1 to enable).
  // Never throws — pure hint.
  try {
    touchMarker(to);
  } catch {
    /* marker is best-effort */
  }

  // v2.5.0 Tether Phase 1 — Part S — MCP subscription fan-out for
  // relay://inbox/<to>. Emit AFTER the SQL commit + marker touch so
  // a subscriber that immediately re-fetches the resource sees the
  // freshly-inserted row.
  emitInboxChanged({ agent_name: to, reason: "message_received", id: outboxId });

  // v2.8 — stamp recipient's last_dispatched_at when qualified. See
  // the system-sender branch above for the rule. Mirrored both sides
  // so a `system → builder` priority='high' DM stamps correctly
  // alongside a `user-to-user` send.
  markRecipientDispatched(to, priority);

  return { id, from_agent: from, to_agent: to, content, priority, status: "pending", created_at: timestamp };
}

/**
 * v2.3.0 Part C.1/C.2 — sanctioned mailbox helper.
 *
 * Idempotent upsert of the mailbox row for the given agent. Returns the
 * full mailbox record. Epoch is a fresh UUID at first creation; rotates
 * only on explicit `rotateMailboxEpoch` (called from backup/restore).
 * Transaction-safe — the INSERT OR IGNORE + follow-up SELECT is the
 * stable pattern across better-sqlite3 + WAL.
 */
export function getOrCreateMailbox(
  agentName: string,
): { mailbox_id: string; agent_name: string; epoch: string; next_seq: number } {
  const db = getDb();
  const existing = db
    .prepare("SELECT mailbox_id, agent_name, epoch, next_seq FROM mailbox WHERE agent_name = ?")
    .get(agentName) as
    | { mailbox_id: string; agent_name: string; epoch: string; next_seq: number }
    | undefined;
  if (existing) return existing;
  const mailboxId = uuidv4();
  const epoch = uuidv4();
  const createdAt = now();
  db.prepare(
    "INSERT OR IGNORE INTO mailbox (mailbox_id, agent_name, epoch, next_seq, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(mailboxId, agentName, epoch, 0, createdAt);
  // Re-read in case of race (another caller won the IGNORE).
  return db
    .prepare("SELECT mailbox_id, agent_name, epoch, next_seq FROM mailbox WHERE agent_name = ?")
    .get(agentName) as { mailbox_id: string; agent_name: string; epoch: string; next_seq: number };
}

/**
 * v2.3.0 Part C — peek helper backing the `peek_inbox_version` MCP tool.
 * Pure observation — no mutation. Returns the current mailbox shape +
 * an observed count of messages addressed to the agent.
 */
export function peekMailboxVersion(agentName: string): {
  mailbox_id: string;
  epoch: string;
  last_seq: number;
  total_messages_count: number;
  total_unread_count: number;
} {
  const db = getDb();
  const m = getOrCreateMailbox(agentName);
  const count = (db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE to_agent = ?")
    .get(agentName) as { c: number }).c;
  // v2.3.0 Codex HIGH #2 patch — total_unread_count is the field clients
  // watch for new-mail detection. `last_seq` only advances when the
  // recipient CALLS get_messages (seq is assigned on first observation
  // inside the get_messages drain path at :3181-3199 — NOT on send,
  // NOT on delivery), so last_seq is stale for pre-first-observation
  // new mail. `seq IS NULL` is the authoritative "not-yet-observed"
  // signal + bumps on every sendMessage.
  const unread = (db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE to_agent = ? AND seq IS NULL")
    .get(agentName) as { c: number }).c;
  return {
    mailbox_id: m.mailbox_id,
    epoch: m.epoch,
    last_seq: m.next_seq,
    total_messages_count: count,
    total_unread_count: unread,
  };
}

/**
 * v2.3.0 Part C — rotate the mailbox epoch for a specific agent. Called
 * from backup/restore so restored DBs get a fresh epoch even if the
 * underlying seq counter was reset by the archive. Clients whose cached
 * cursor epoch doesn't match on next peek reset their local last_seen
 * to 0 and drain from scratch.
 */
export function rotateMailboxEpoch(agentName: string): string {
  const db = getDb();
  const fresh = uuidv4();
  db.prepare("UPDATE mailbox SET epoch = ? WHERE agent_name = ?").run(fresh, agentName);
  return fresh;
}

/**
 * v2.3.0 Part C — rotate EVERY mailbox epoch. Used by restoreFromBackup
 * to invalidate every client's cursor in one pass rather than waiting
 * for per-agent peek calls.
 */
export function rotateAllMailboxEpochs(): number {
  const db = getDb();
  const rows = db.prepare("SELECT agent_name FROM mailbox WHERE agent_name IS NOT NULL").all() as { agent_name: string }[];
  for (const r of rows) rotateMailboxEpoch(r.agent_name);
  return rows.length;
}

export function getMessages(
  agentName: string,
  status: string,
  limit: number,
  peek = false,
  sinceIso: string | null = null,
  lane: "all" | "direct" | "capability" = "all",
  // v2.12.0 — pending-vs-history. When true, also permanently RESOLVE the
  // returned messages (set resolved_at) in the SAME transaction as the
  // read-mark, so the next poll — even from a fresh session — never re-floods
  // with already-handled mail. Default false ⇒ byte-identical to prior
  // behavior. Ignored on peek (observation only) and on read/all/history/
  // resolved reads (those never mark, so they never resolve).
  ack = false,
): MessageRecord[] {
  const db = getDb();
  // No touchAgent here — observation is not liveness (v1.3 presence fix)

  // v2.0 final (#6): session-aware read receipts. Look up the caller's
  // current session_id so we can filter + mark per-session.
  const agentRow = db.prepare("SELECT session_id FROM agents WHERE name = ?").get(agentName) as { session_id: string | null } | undefined;
  const currentSession = agentRow?.session_id ?? null;

  let rows: MessageRecord[];

  const priorityOrder = `ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END, created_at DESC LIMIT ?`;
  // v2.7.0 external-review-flagged P1 fix — `since` filter MUST run in SQL BEFORE
  // the mark-as-read mutation below, otherwise messages older than the
  // bound get marked read silently and never resurface to this session.
  // Pre-v2.7.0 the filter ran in JS (src/tools/messaging.ts filterBySince,
  // since removed) AFTER getMessages had already mutated read_by_session —
  // silent data loss. Mirror getMessagesSummary's pattern at
  // src/db.ts:3037: same `AND created_at >= ?` clause stitched into each
  // branch.
  const sinceClause = sinceIso ? "AND created_at >= ?" : "";
  // v2.10 — lane filter. Fixed clauses (no param binding, no injection
  // surface) so an orchestrator can drain the action lane (direct,
  // routed_capability IS NULL) separately from the FYI lane (capability,
  // routed_capability IS NOT NULL). Default 'all' preserves prior behavior.
  const laneClause =
    lane === "direct"
      ? "AND routed_capability IS NULL"
      : lane === "capability"
        ? "AND routed_capability IS NOT NULL"
        : "";

  if (status === "all" || status === "history") {
    // "all" / "history" (alias) = the full durable record, incl. resolved
    // mail. The on-demand HISTORY plane for cross-session handover pulls.
    const params: unknown[] = [agentName];
    if (sinceIso) params.push(sinceIso);
    params.push(limit);
    rows = db.prepare(
      `SELECT * FROM messages WHERE to_agent = ? ${sinceClause} ${laneClause} ${priorityOrder}`
    ).all(...params) as MessageRecord[];
  } else if (status === "resolved") {
    // v2.12.0 — only messages the recipient has permanently resolved
    // (acked). "show me what I've already handled." Session-independent.
    const params: unknown[] = [agentName];
    if (sinceIso) params.push(sinceIso);
    params.push(limit);
    rows = db.prepare(
      `SELECT * FROM messages WHERE to_agent = ?
         AND resolved_at IS NOT NULL
         ${sinceClause}
         ${laneClause}
         ${priorityOrder}`
    ).all(...params) as MessageRecord[];
  } else if (status === "read") {
    // "read" = this session has already observed these messages.
    const params: unknown[] = [agentName, currentSession ?? ""];
    if (sinceIso) params.push(sinceIso);
    params.push(limit);
    rows = db.prepare(
      `SELECT * FROM messages WHERE to_agent = ?
         AND read_by_session IS NOT NULL
         AND read_by_session = ?
         ${sinceClause}
         ${laneClause}
         ${priorityOrder}`
    ).all(...params) as MessageRecord[];
  } else {
    // "pending" = (never read, OR read by a different session) AND not yet
    // resolved. The session-scoped clause re-surfaces a prior session's
    // UNFINISHED work to a fresh terminal (handovers don't drop mail, v2.0
    // final #6); the v2.12.0 `resolved_at IS NULL` clause keeps ALREADY-
    // HANDLED mail out of the action queue permanently, killing the
    // cross-session re-flood for resolved items without touching the
    // session-scoped read semantics.
    const params: unknown[] = [agentName, currentSession ?? ""];
    if (sinceIso) params.push(sinceIso);
    params.push(limit);
    rows = db.prepare(
      `SELECT * FROM messages WHERE to_agent = ?
         AND (read_by_session IS NULL OR read_by_session != ?)
         AND resolved_at IS NULL
         ${sinceClause}
         ${laneClause}
         ${priorityOrder}`
    ).all(...params) as MessageRecord[];
  }

  // Mark messages as read by THIS session. The old binary `status` column
  // remains populated for back-compat readers but is no longer authoritative.
  //
  // v2.2.2 BUG1 — when `peek=true`, skip the mark-as-read UPDATE so
  // repeated `status='pending'` polls by the same session return the
  // same messages. Necessary for orchestrator-polling use cases where
  // one session surveys its own inbox without consuming it. Default
  // stays `peek=false` so consume-once semantics are preserved for
  // single-shot workers (v2.0 final #6).
  let drainedRows = 0;
  let outboxId = 0;
  if (!peek && rows.length > 0 && currentSession && status !== "read") {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    // v2.12.0 — resolve-on-ack. Only the PENDING drain path resolves: it is
    // the "drain my queue, I've handled all of these" call. Browsing history
    // (status all/history/resolved) must NOT resolve even with ack=true — a
    // caller paging the full record shouldn't accidentally empty its action
    // queue. lane is orthogonal (pending + lane='capability' + ack still
    // resolves the FYI rows it drained).
    const doResolve = ack && status === "pending";
    const resolvedAt = now();
    // v2.7 / Tether Phase 3a — drain UPDATE + outbox INSERT in one tx so
    // the cross-process tail in the HTTP daemon (src/outbox-tail.ts) sees
    // exactly one row per actual pending→read transition. lastInsertRowid
    // is threaded into emitInboxChanged for in-process dedup against the
    // tail (mcp-subscriptions tracks highest broadcast id per URI).
    //
    // v2.12.0 — when ack, the session-independent resolve UPDATE rides the
    // SAME tx as the per-session read-mark so they commit atomically (the
    // returned set is resolved iff it is marked read — never half). The
    // `resolved_at IS NULL` guard makes it idempotent under concurrent
    // racing drains; the tx is promoted to BEGIN IMMEDIATE below so two
    // ack drains serialize at tx start (same pattern as the seq tx) and
    // neither double-counts nor drops.
    const tx = db.transaction(() => {
      const r = db.prepare(
        `UPDATE messages SET status = 'read', read_by_session = ? WHERE id IN (${placeholders})`
      ).run(currentSession, ...ids);
      drainedRows = r.changes;
      if (doResolve) {
        db.prepare(
          `UPDATE messages SET resolved_at = ? WHERE id IN (${placeholders}) AND resolved_at IS NULL`
        ).run(resolvedAt, ...ids);
      }
      if (drainedRows > 0) {
        const ins = db.prepare(
          "INSERT INTO inbox_events (agent_name, reason, created_at, source_pid) VALUES (?, ?, ?, ?)"
        ).run(agentName, "message_read", now(), process.pid);
        outboxId = Number(ins.lastInsertRowid);
      }
    });
    // BEGIN IMMEDIATE via better-sqlite3's .immediate() modifier so
    // cross-process concurrent drains serialize at tx START. Fall back to
    // the default mode on drivers that don't expose it (the wasm driver is
    // single-connection so cross-process races don't apply).
    const immediateCaller = (tx as unknown as { immediate?: () => void }).immediate;
    if (typeof immediateCaller === "function") {
      (tx as unknown as { immediate: () => void }).immediate();
    } else {
      tx();
    }
  }
  // v2.5.0 Tether Phase 1 — Part S — fire the inbox-changed event when
  // pending → read, so subscribers see the unread count drop in real time.
  // Skipped on peek (no mutation) and skipped when zero rows transitioned
  // (e.g. status='all' / 'read' filters never mark anything new).
  if (drainedRows > 0) {
    emitInboxChanged({ agent_name: agentName, reason: "message_read", id: outboxId });
  }

  // v2.3.0 Part C.2 — first-observation seq assignment. Per Codex Q9 lock:
  // mailbox seq is assigned when the RECIPIENT first observes a message,
  // not when it was created (and not at delivery — observation is the
  // event). Over-fetched rows (e.g. status='read' or since filters that
  // haven't been applied yet) get their seq stamped here too — the
  // point is "seq reflects the order the recipient saw
  // them", which is stable regardless of how they filter later.
  //
  // v2.3.0 Codex HIGH #1 patch — atomic seq assignment:
  //   1. BEGIN IMMEDIATE (via better-sqlite3's .immediate() modifier)
  //      serializes cross-process concurrent readers at the SQLite file
  //      lock — no two processes can both think next_seq=N and stamp
  //      different rows with the same N.
  //   2. Mailbox.next_seq is READ INSIDE the tx so every tx sees the
  //      latest committed counter, not a pre-tx snapshot.
  //   3. `next` advances ONLY on successful UPDATE (r.changes === 1).
  //      Rows already stamped by a concurrent reader no-op here and we
  //      skip — their seq stays the one the other reader assigned.
  //   4. Mailbox.next_seq persists the actual claim count, not the
  //      candidate count.
  // Together these guarantee per-recipient seq uniqueness + strict
  // monotonicity under cross-process concurrent reads.
  const unseqIds = rows.filter((r) => r.seq == null).map((r) => r.id);
  if (unseqIds.length > 0) {
    // Ensure the mailbox row exists. INSERT OR IGNORE is idempotent +
    // safe outside the immediate tx — concurrent callers converge on
    // the same row id via the UNIQUE INDEX on agent_name.
    getOrCreateMailbox(agentName);
    const claimedByMe: Map<string, { seq: number; epoch: string }> = new Map();
    const assignTx = db.transaction(() => {
      const mailbox = db
        .prepare("SELECT mailbox_id, epoch, next_seq FROM mailbox WHERE agent_name = ?")
        .get(agentName) as { mailbox_id: string; epoch: string; next_seq: number } | undefined;
      if (!mailbox) return;
      let next = mailbox.next_seq;
      const upd = db.prepare(
        "UPDATE messages SET seq = ?, epoch = ? WHERE id = ? AND seq IS NULL",
      );
      for (const id of unseqIds) {
        const candidateSeq = next + 1;
        const r = upd.run(candidateSeq, mailbox.epoch, id);
        if (r.changes === 1) {
          next = candidateSeq;
          claimedByMe.set(id, { seq: candidateSeq, epoch: mailbox.epoch });
        }
        // r.changes === 0 → another concurrent reader already stamped
        // this row. Skip without advancing next — that row's seq is
        // authoritative (the other reader's assigned value).
      }
      if (next !== mailbox.next_seq) {
        db.prepare("UPDATE mailbox SET next_seq = ? WHERE mailbox_id = ?").run(
          next,
          mailbox.mailbox_id,
        );
      }
    });
    // Use BEGIN IMMEDIATE via better-sqlite3's .immediate() modifier so
    // cross-process concurrent readers serialize at tx START, not at
    // the first write. Fall back to the default mode on drivers that
    // don't expose .immediate() (the wasm driver is single-connection
    // so cross-process races don't apply).
    const immediateCaller = (assignTx as unknown as { immediate?: () => void }).immediate;
    if (typeof immediateCaller === "function") {
      (assignTx as unknown as { immediate: () => void }).immediate();
    } else {
      assignTx();
    }
    // Hydrate the rows we claimed with the freshly-assigned seq/epoch.
    // For rows another reader claimed, fetch their committed values via
    // a targeted SELECT so the caller still sees consistent seqs.
    const unclaimedByMe = unseqIds.filter((id) => !claimedByMe.has(id));
    if (unclaimedByMe.length > 0) {
      const refresh = db.prepare(
        `SELECT id, seq, epoch FROM messages WHERE id IN (${unclaimedByMe.map(() => "?").join(",")})`,
      );
      const fresh = refresh.all(...unclaimedByMe) as { id: string; seq: number; epoch: string }[];
      for (const r of fresh) claimedByMe.set(r.id, { seq: r.seq, epoch: r.epoch });
    }
    for (const r of rows) {
      const hit = claimedByMe.get(r.id);
      if (hit) {
        r.seq = hit.seq;
        r.epoch = hit.epoch;
      }
    }
  }

  // v1.7: decrypt content field on read (safe-no-op for plaintext rows)
  return rows.map((r) => ({ ...r, content: decryptContent(r.content) ?? r.content }));
}

/**
 * v2.12.0 — pending-vs-history. Permanently RESOLVE (ack) the named messages
 * for `agentName`, so they leave the cross-session pending queue for good.
 * Backs the `resolve_messages` tool and the partial-handling path ("I handled
 * these, not those") that `get_messages(ack=true)` (resolve-the-whole-drain)
 * does not cover.
 *
 * Recipient-scoped: only rows WHERE `to_agent = agentName` are touched, so a
 * caller can never resolve another agent's mail even if it passes foreign ids
 * (defense-in-depth — the dispatcher already binds the caller's token to
 * `agent_name`). Idempotent: the `resolved_at IS NULL` guard means re-resolving
 * an already-resolved id is a no-op, and unknown / non-owned ids are silently
 * skipped (reported via the count). Resolving does NOT mark a message read —
 * read is a separate per-session plane.
 *
 * Returns `{ resolved_ids, resolved_count, requested_count }` so the caller can
 * see exactly which of the requested ids it actually owned + flipped.
 */
export function resolveMessages(
  agentName: string,
  messageIds: string[],
): { resolved_ids: string[]; resolved_count: number; requested_count: number } {
  const db = getDb();
  const requested = Array.from(new Set(messageIds));
  if (requested.length === 0) {
    return { resolved_ids: [], resolved_count: 0, requested_count: 0 };
  }
  const placeholders = requested.map(() => "?").join(",");
  const resolvedAt = now();
  // Single immediate tx: SELECT the owned-and-unresolved ids, then flip them.
  // The SELECT is scoped by to_agent so the returned id list reflects only
  // what THIS recipient actually resolved (not foreign/unknown ids).
  let resolvedIds: string[] = [];
  const tx = db.transaction(() => {
    const owned = db
      .prepare(
        `SELECT id FROM messages WHERE id IN (${placeholders}) AND to_agent = ? AND resolved_at IS NULL`,
      )
      .all(...requested, agentName) as { id: string }[];
    resolvedIds = owned.map((r) => r.id);
    if (resolvedIds.length > 0) {
      db.prepare(
        `UPDATE messages SET resolved_at = ? WHERE id IN (${placeholders}) AND to_agent = ? AND resolved_at IS NULL`,
      ).run(resolvedAt, ...requested, agentName);
    }
  });
  const immediateCaller = (tx as unknown as { immediate?: () => void }).immediate;
  if (typeof immediateCaller === "function") {
    (tx as unknown as { immediate: () => void }).immediate();
  } else {
    tx();
  }
  return {
    resolved_ids: resolvedIds,
    resolved_count: resolvedIds.length,
    requested_count: requested.length,
  };
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
  if (status === "all" || status === "history") {
    // "all" / "history" (alias) — full durable record incl. resolved mail.
    sql = `SELECT * FROM messages WHERE to_agent = ? ${sinceClause} ${priorityOrder}`;
    if (sinceIso) params.push(sinceIso);
  } else if (status === "resolved") {
    // v2.12.0 — only permanently-resolved (acked) mail.
    sql = `SELECT * FROM messages WHERE to_agent = ?
       AND resolved_at IS NOT NULL
       ${sinceClause}
       ${priorityOrder}`;
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
    // "pending" — (never read OR read by a different session) AND not yet
    // resolved. v2.12.0: the `resolved_at IS NULL` clause mirrors getMessages
    // so the cheap preview and the mutating drain agree on the pending set
    // (an already-resolved item never shows as pending in either path).
    sql = `SELECT * FROM messages WHERE to_agent = ?
       AND (read_by_session IS NULL OR read_by_session != ?)
       AND resolved_at IS NULL
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

/**
 * v2.2.2 B3 — list agents whose last_seen is older than the given
 * ISO-timestamp cutoff. Used by `relay purge-agents` to gather
 * deletion candidates before asking for operator confirmation.
 */
export function listAgentsOlderThan(cutoffIso: string): AgentRecord[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM agents WHERE last_seen < ? ORDER BY last_seen ASC"
    )
    .all(cutoffIso) as AgentRecord[];
}

/**
 * v2.2.2 B3 — delete a single agent row if (and only if) its
 * last_seen is still older than the cutoff. Returns true when the
 * DELETE landed, false when the row moved (operator came back, race)
 * or was already gone. Sanctioned-helper home for raw `DELETE FROM
 * agents` so `relay purge-agents` passes the drift-grep guard.
 */
export function deleteAgentIfAbandoned(name: string, cutoffIso: string): boolean {
  const db = getDb();
  const r = db
    .prepare("DELETE FROM agents WHERE name = ? AND last_seen < ?")
    .run(name, cutoffIso);
  return r.changes > 0;
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
  // v2.7 / Tether Phase 3a — per-recipient outbox row so the cross-process
  // tail in the HTTP daemon wakes every subscriber on each individual
  // relay://inbox/<x> URI. INSERTs live inside the same tx as the message
  // INSERTs so a partial-failure abort leaves NO orphaned outbox rows
  // (and inversely no committed messages without their outbox notifications).
  const outboxInsert = db.prepare(
    "INSERT INTO inbox_events (agent_name, reason, created_at, source_pid) VALUES (?, ?, ?, ?)"
  );
  const outboxIds: number[] = [];

  // v1.7: encrypt once, reuse for all recipients (each gets their own row but
  // the IV is regenerated per encryptContent call so... actually re-encrypt
  // per-row so each row has its own IV. Slightly slower, no IV reuse risk.)
  const tx = db.transaction(() => {
    for (const agent of recipients) {
      const id = uuidv4();
      insert.run(id, from, agent.name, encryptContent(content), timestamp);
      const r = outboxInsert.run(agent.name, "broadcast_received", timestamp, process.pid);
      outboxIds.push(Number(r.lastInsertRowid));
      sentTo.push(agent.name);
      messageIds.push(id);
    }
  });

  tx();

  // v2.5.0 Tether Phase 1 — Part S — fan out one inbox-changed event per
  // recipient so MCP subscribers on each individual relay://inbox/<x> URI
  // get woken. Emitted AFTER the tx commits so a re-fetch of the resource
  // sees the newly-inserted rows. v2.7 Tether Phase 3a threads each
  // recipient's outbox row id so the in-process bus and the cross-process
  // tail can dedup in mcp-subscriptions.
  for (let i = 0; i < sentTo.length; i++) {
    emitInboxChanged({
      agent_name: sentTo[i],
      reason: "broadcast_received",
      id: outboxIds[i],
    });
  }

  return { sent_to: sentTo, message_ids: messageIds };
}

/**
 * v2.10 — capability-routed messaging. Find every registered agent whose
 * declared capability set includes `capability` (exact-string match against
 * the agent_capabilities index — same matching contract as post_task_auto).
 * Optionally excludes the sender. Returns owner agent names (possibly empty).
 *
 * The FYI/coordination-lane analogue of post_task_auto's candidate lookup,
 * with two deliberate differences: (1) it matches a SINGLE capability tag
 * (membership), not an ALL-OF set; (2) it returns ALL owners for fan-out, not
 * the single least-loaded pick — an FYI should reach every agent that owns
 * the domain, not just one.
 */
export function findCapabilityOwners(
  capability: string,
  excludeSender: string | null = null,
): string[] {
  const db = getDb();
  const rows = excludeSender
    ? db
        .prepare(
          "SELECT agent_name FROM agent_capabilities WHERE capability = ? AND agent_name != ? ORDER BY agent_name",
        )
        .all(capability, excludeSender)
    : db
        .prepare(
          "SELECT agent_name FROM agent_capabilities WHERE capability = ? ORDER BY agent_name",
        )
        .all(capability);
  return (rows as Array<{ agent_name: string }>).map((r) => r.agent_name);
}

/**
 * v2.10 — capability-routed messaging fan-out (principle #1: capability
 * routing over named routing). Routes one FYI/coordination message to the
 * CURRENT owner(s) of `capability` by inserting one `messages` row per owner,
 * stamped with `routed_capability` so the recipient + dashboards distinguish
 * the FYI lane from point-to-point completion reports (the action lane). Recipients
 * drain via the normal get_messages path — no new read surface.
 *
 * No-owner case (design ruling #2): if nobody currently owns the capability,
 * insert NOTHING and return routed_to:[] — FYI is fire-and-forget to current
 * owners, NOT queued-until-owner (that would be task semantics).
 *
 * Mirrors broadcastMessage's per-recipient transaction + outbox-event +
 * inbox-changed fan-out so MCP subscribers + the cross-process tail wake.
 */
export function postToCapability(
  from: string,
  capability: string,
  content: string,
  priority: string,
  excludeSelf = true,
): { routed_to: string[]; message_ids: string[] } {
  const db = getDb();
  touchAgent(from);

  const owners = findCapabilityOwners(capability, excludeSelf ? from : null);

  const routedTo: string[] = [];
  const messageIds: string[] = [];
  if (owners.length === 0) {
    // No current owner — fire-and-forget means nothing is stored. The caller
    // sees routed_to:[] and decides what to do.
    return { routed_to: routedTo, message_ids: messageIds };
  }

  const timestamp = now();
  const insert = db.prepare(
    "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at, routed_capability) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
  );
  const outboxInsert = db.prepare(
    "INSERT INTO inbox_events (agent_name, reason, created_at, source_pid) VALUES (?, ?, ?, ?)",
  );
  const outboxIds: number[] = [];

  const tx = db.transaction(() => {
    for (const owner of owners) {
      const id = uuidv4();
      // Re-encrypt per row so each row gets its own IV (mirrors broadcast).
      insert.run(id, from, owner, encryptContent(content), priority, timestamp, capability);
      const r = outboxInsert.run(owner, "message_received", timestamp, process.pid);
      outboxIds.push(Number(r.lastInsertRowid));
      routedTo.push(owner);
      messageIds.push(id);
    }
  });
  tx();

  for (let i = 0; i < routedTo.length; i++) {
    emitInboxChanged({
      agent_name: routedTo[i],
      reason: "message_received",
      id: outboxIds[i],
    });
  }

  return { routed_to: routedTo, message_ids: messageIds };
}

// --- v2.10 Task schema operations (schema-gated completion) ---

export type SchemaGatingMode = "enforce" | "warn" | "off";

/**
 * Read the global schema-gating kill-switch. Default 'warn' (shadow): validate
 * + log violations but ALLOW completion, so a brand-new gate can't wrongly
 * reject legit completions during rollout. 'enforce' rejects; 'off' skips.
 * An invalid value falls back to the safe 'warn'.
 */
export function getSchemaGatingMode(): SchemaGatingMode {
  const raw = (process.env.RELAY_SCHEMA_GATING ?? "warn").toLowerCase();
  return raw === "enforce" || raw === "warn" || raw === "off" ? raw : "warn";
}

export interface TaskSchemaRecord {
  id: string;
  json_schema: string;
  /** Parsed JSON Schema document. */
  schemaDoc: Record<string, unknown>;
  created_by: string;
  created_at: string;
}

/** Thrown when a candidate schema document fails meta-validation at register. */
export class SchemaDocumentInvalidError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(`Invalid JSON Schema document: ${errors.join("; ")}`);
    this.name = "SchemaDocumentInvalidError";
    this.errors = errors;
  }
}

/** Thrown when registering an id that already exists (schemas are immutable). */
export class SchemaAlreadyExistsError extends Error {
  constructor(id: string) {
    super(`Task schema "${id}" already exists — schemas are immutable; register a new version id.`);
    this.name = "SchemaAlreadyExistsError";
  }
}

/** Thrown when a schema-gated task is completed with a non-conforming result. */
export class ResultSchemaViolationError extends Error {
  schemaId: string;
  errors: string[];
  constructor(schemaId: string, errors: string[]) {
    super(`Task result does not conform to schema "${schemaId}": ${errors.join("; ")}`);
    this.name = "ResultSchemaViolationError";
    this.schemaId = schemaId;
    this.errors = errors;
  }
}

/**
 * v2.10 — built-in task schemas, auto-registered on init (INSERT OR IGNORE so
 * operator-registered overrides are never clobbered and re-runs no-op). Field
 * sets are grounded in the team's actual completion-report / audit-verdict / merge
 * shapes; `required` carries the PROOF fields an agent cannot fake-complete
 * without. additionalProperties:true keeps them forward-compatible.
 */
const BUILTIN_TASK_SCHEMAS: Record<string, Record<string, unknown>> = {
  ship_pong_v1: {
    type: "object",
    properties: {
      ci_status: { type: "string", enum: ["green"] },
      tests_passed: { type: "integer", minimum: 0 },
      summary: { type: "string", minLength: 1 },
      pr_number: { type: "integer" },
      head_sha: { type: "string", minLength: 7 },
    },
    required: ["ci_status", "tests_passed", "summary"],
    additionalProperties: true,
  },
  audit_verdict_v1: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["SHIP", "PATCH_THEN_SHIP", "BLOCK"] },
      summary: { type: "string", minLength: 1 },
      findings: { type: "array" },
    },
    required: ["verdict", "summary"],
    additionalProperties: true,
  },
  merge_ready_v1: {
    type: "object",
    properties: {
      ci_green: { type: "boolean" },
      audit_ship: { type: "boolean" },
      head_sha: { type: "string", minLength: 7 },
      summary: { type: "string", minLength: 1 },
    },
    required: ["ci_green", "audit_ship", "head_sha"],
    additionalProperties: true,
  },
};

/** Auto-register the built-in schemas. Idempotent; never clobbers overrides. */
export function seedBuiltinTaskSchemas(db: CompatDatabase): void {
  const ts = now();
  const ins = db.prepare(
    "INSERT OR IGNORE INTO task_schemas (id, json_schema, created_by, created_at) VALUES (?, ?, 'system', ?)",
  );
  for (const [id, doc] of Object.entries(BUILTIN_TASK_SCHEMAS)) {
    ins.run(id, JSON.stringify(doc), ts);
  }
}

/**
 * Register a reusable, IMMUTABLE task schema. The document is meta-validated
 * (validateSchemaDocument) BEFORE it is ever compiled by ajv — ajv code-gens
 * from the schema, so an unvetted document is an attack surface. Re-registering
 * an existing id is refused (immutability) — bump the version id instead.
 */
export function registerTaskSchema(id: string, schemaDoc: unknown, createdBy: string): TaskSchemaRecord {
  const check = validateSchemaDocument(schemaDoc);
  if (!check.valid) throw new SchemaDocumentInvalidError(check.errors);
  const db = getDb();
  if (db.prepare("SELECT id FROM task_schemas WHERE id = ?").get(id)) {
    throw new SchemaAlreadyExistsError(id);
  }
  const json = JSON.stringify(schemaDoc);
  const ts = now();
  db.prepare("INSERT INTO task_schemas (id, json_schema, created_by, created_at) VALUES (?, ?, ?, ?)").run(
    id, json, createdBy, ts,
  );
  return { id, json_schema: json, schemaDoc: schemaDoc as Record<string, unknown>, created_by: createdBy, created_at: ts };
}

/** Fetch a registered task schema by id (parsed doc included), or null. */
export function getTaskSchema(id: string): TaskSchemaRecord | null {
  const db = getDb();
  const row = db
    .prepare("SELECT id, json_schema, created_by, created_at FROM task_schemas WHERE id = ?")
    .get(id) as { id: string; json_schema: string; created_by: string; created_at: string } | undefined;
  if (!row) return null;
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(row.json_schema); } catch { doc = {}; }
  return { ...row, schemaDoc: doc };
}

/**
 * Validate a task `result` against the task's registered schema. A gated result
 * MUST be a non-empty string that parses as JSON and conforms; a missing schema
 * row fails CLOSED (invalid).
 */
export function checkResultAgainstTaskSchema(schemaId: string, result: string | undefined): SchemaCheck {
  const row = getTaskSchema(schemaId);
  if (!row) return { valid: false, errors: [`schema "${schemaId}" not found`] };
  if (result == null || result === "") {
    return { valid: false, errors: ["result is required and must be a JSON object conforming to the schema"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return { valid: false, errors: ["result is not valid JSON (a schema-gated task requires a JSON result)"] };
  }
  return validateResult(schemaId, row.schemaDoc, parsed);
}

// --- Task operations ---

export function postTask(
  from: string,
  to: string,
  title: string,
  description: string,
  priority: string,
  schemaId?: string
): TaskRecord {
  const db = getDb();
  touchAgent(from);

  // v2.10 — a requester may gate this task's completion on a registered schema.
  // The id must reference an existing task_schema (fail-closed if unknown).
  if (schemaId != null && !getTaskSchema(schemaId)) {
    throw new Error(`Unknown task schema "${schemaId}" — register it first via register_task_schema.`);
  }

  const id = uuidv4();
  const timestamp = now();
  const encDescription = encryptContent(description); // v1.7: encrypt at rest

  db.prepare(
    "INSERT INTO tasks (id, from_agent, to_agent, title, description, priority, status, result, created_at, updated_at, schema_id) VALUES (?, ?, ?, ?, ?, ?, 'posted', NULL, ?, ?, ?)"
  ).run(id, from, to, title, encDescription, priority, timestamp, timestamp, schemaId ?? null);

  // v2.8 — a task post IS a dispatch event per CHANGELOG.md:31 ("was
  // given work to do recently"). Stamp the recipient's
  // last_dispatched_at on the same rules as sendMessage (priority +
  // role allowlist). Best-effort.
  markRecipientDispatched(to, priority);

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
    schema_id: schemaId ?? null,
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
 * 2026-04-21 during v2.2.0 validation (scoped agent names
 * prevent duplicate-name shared-inbox drain races).
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

  // v2.10 — schema-gated completion. A task with a non-NULL schema_id must
  // produce a result that parses as JSON and conforms to the registered schema
  // BEFORE the accepted→completed CAS UPDATE. Applies only to `complete`;
  // un-gated tasks (schema_id NULL) and all other actions are untouched.
  // RELAY_SCHEMA_GATING: enforce (reject) | warn (log + allow, default) | off.
  if (action === "complete" && task.schema_id) {
    const mode = getSchemaGatingMode();
    if (mode !== "off") {
      const check = checkResultAgainstTaskSchema(task.schema_id, result);
      if (!check.valid) {
        if (mode === "enforce") {
          throw new ResultSchemaViolationError(task.schema_id, check.errors);
        }
        log.warn(
          `[schema-gate] WARN task ${taskId}: result does not conform to schema ` +
          `"${task.schema_id}" (${check.errors.join("; ")}) — allowed because ` +
          `RELAY_SCHEMA_GATING=warn; set =enforce to block.`,
        );
      }
    }
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

    // v2.8 — task auto-routing IS a dispatch event. Stamp the routed
    // recipient's last_dispatched_at on the same rules as sendMessage.
    markRecipientDispatched(pick.name, priority);

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
      // v2.8 R3 — deferred queued-task pickup IS a dispatch event,
      // same contract as the immediate postTaskAuto route at :3823.
      // Without this, agents.last_dispatched_at stays NULL for
      // queued-then-picked-up tasks and the state machine derives
      // them as `waiting` instead of `stale` after the quiet window.
      markRecipientDispatched(agentName, row.priority);
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
