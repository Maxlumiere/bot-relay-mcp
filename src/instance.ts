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
import { checkContainment } from "./approved-roots.js";

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

export function botRelayRoot(): string {
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

const INSTANCE_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * EVERY environment variable resolveInstance() reads, directly or through the
 * approved roots (os.homedir() is HOME). The deploy gate (src/deploy-gate.ts)
 * hands the NEW resolver exactly these keys from the running daemon's
 * environment and prints no other. A contract test holds this list equal to the
 * env reads in src/instance.ts + src/approved-roots.ts, so a new read cannot be
 * missed by the gate. (RELAY_CONFIG_PATH moves the config file, not the DB.)
 */
export const RESOLVER_ENV_KEYS = ["HOME", "RELAY_HOME", "RELAY_DB_PATH", "RELAY_INSTANCE_ID", "RELAY_ALLOW_LEGACY_FALLBACK"] as const;

/**
 * Why `id` is not a usable instance id, or null when it is. The charset alone
 * admits "." and "..", which path.join collapses onto instances/ itself or onto
 * the relay home (whose relay.db is the FLAT DB, then mislabeled an instance), so
 * they are refused by name, and the joined directory must be a DIRECT child of
 * instances/.
 */
function instanceIdFault(id: string): string | null {
  if (!INSTANCE_ID_RE.test(id)) return `it must match ${INSTANCE_ID_RE}`;
  if (id === "." || id === "..") return `"${id}" is a path step, not a name`;
  if (path.dirname(path.resolve(instancesRoot(), id)) !== path.resolve(instancesRoot())) {
    return "it does not name a direct child of the instances directory";
  }
  return null;
}

/**
 * ADR-0048 — the ONE instance resolver. Every caller uses it; it reports FACTS and
 * callers own POLICY. A CLOSED result:
 *   - explicit-db : --db-path (opts.dbPath) or RELAY_DB_PATH;
 *   - instance    : RELAY_INSTANCE_ID, or the active-instance marker (read ONCE);
 *   - flat        : the legacy <root>/relay.db, ONLY on a POSITIVE absence of any
 *                   instance: the marker is ENOENT AND instances/ is ENOENT, empty,
 *                   or holds no directories (or RELAY_ALLOW_LEGACY_FALLBACK=1 over
 *                   the ambiguous state, which then carries a `warning`);
 *   - error       : ANY other fault (EIO, EACCES, ELOOP, ENOTDIR, an unreadable,
 *                   empty or malformed marker, the ambiguous state, containment).
 * A fault NEVER yields flat: "the path chosen by failure" is the silent-wrong-DB
 * class (nine days of invisible message loss). Every path-bearing kind carries
 * `exists`, a POSITIVE fact from the containment walk (src/approved-roots.ts).
 */
export type ResolvedInstance =
  | { kind: "explicit-db"; dbPath: string; exists: boolean; basis: "RELAY_DB_PATH" | "--db-path" }
  | { kind: "instance"; id: string; dbPath: string; exists: boolean; basis: "RELAY_INSTANCE_ID" | "active-instance" }
  | { kind: "flat"; dbPath: string; exists: boolean; warning?: string }
  | { kind: "error"; reason: string; ambiguous?: boolean };

export function resolveInstance(opts: { dbPath?: string; ignoreDbPathEnv?: boolean } = {}): ResolvedInstance {
  const failed = (reason: string): ResolvedInstance => ({ kind: "error", reason });
  const code = (err: unknown) => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
  const placed = (dbPath: string, make: (abs: string, exists: boolean) => ResolvedInstance): ResolvedInstance => {
    const c = checkContainment(dbPath);
    return c.ok ? make(c.absPath, c.exists) : failed(c.reason);
  };

  if (opts.dbPath) {
    return placed(opts.dbPath, (p, e) => ({ kind: "explicit-db", dbPath: p, exists: e, basis: "--db-path" }));
  }
  if (!opts.ignoreDbPathEnv && process.env.RELAY_DB_PATH) {
    return placed(process.env.RELAY_DB_PATH, (p, e) => ({ kind: "explicit-db", dbPath: p, exists: e, basis: "RELAY_DB_PATH" }));
  }
  const envId = process.env.RELAY_INSTANCE_ID;
  if (envId) {
    const idFault = instanceIdFault(envId);
    if (idFault) return failed(`RELAY_INSTANCE_ID "${envId}" is invalid: ${idFault}`);
    return placed(path.join(instancesRoot(), envId, "relay.db"), (p, e) => ({
      kind: "instance", id: envId, dbPath: p, exists: e, basis: "RELAY_INSTANCE_ID",
    }));
  }

  const root = botRelayRoot();
  const flat = (warning?: string): ResolvedInstance =>
    placed(path.join(root, "relay.db"), (p, e) => (warning ? { kind: "flat", dbPath: p, exists: e, warning } : { kind: "flat", dbPath: p, exists: e }));

  // The relay home: absent (ENOENT) is a positive absence of everything.
  try {
    fs.lstatSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return flat();
    return failed(`cannot inspect the relay home ${root} (${code(err)})`);
  }

  // The marker, read ONCE.
  const marker = path.join(root, "active-instance");
  let markerStat: fs.Stats | null = null;
  try {
    markerStat = fs.lstatSync(marker);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return failed(`cannot inspect ${marker} (${code(err)})`);
  }
  if (markerStat) {
    let id: string;
    try {
      if (markerStat.isSymbolicLink()) id = path.basename(fs.readlinkSync(marker));
      else if (markerStat.isFile()) id = fs.readFileSync(marker, "utf-8").trim();
      else return failed(`${marker} is neither a file nor a symlink`);
    } catch (err) {
      return failed(`cannot read ${marker} (${code(err)})`);
    }
    if (!id) return failed(`${marker} is empty`);
    const idFault = instanceIdFault(id);
    if (idFault) return failed(`${marker} names an invalid instance id "${id}": ${idFault}`);
    return placed(path.join(instancesRoot(), id, "relay.db"), (p, e) => ({
      kind: "instance", id, dbPath: p, exists: e, basis: "active-instance",
    }));
  }

  // No marker: flat only if no instance directory exists.
  const instDir = instancesRoot();
  let instStat: fs.Stats | null = null;
  try {
    instStat = fs.lstatSync(instDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return failed(`cannot inspect ${instDir} (${code(err)})`);
  }
  // instances/ present but NOT a directory (or a symlink to one) is corruption,
  // not a positive absence: it never yields flat.
  if (instStat && !instStat.isDirectory() && !instStat.isSymbolicLink()) {
    return failed(`${instDir} exists but is not a directory`);
  }
  if (instStat) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(instDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      return failed(`cannot list ${instDir} (${code(err)})`);
    }
    if (dirs.length) {
      if (process.env.RELAY_ALLOW_LEGACY_FALLBACK === "1") {
        return flat(`instances exist (${dirs.join(", ")}) but none is selected; using the flat DB because RELAY_ALLOW_LEGACY_FALLBACK=1`);
      }
      return {
        kind: "error",
        ambiguous: true,
        reason:
          `instance resolution is ambiguous: ${instDir} holds instances (${dirs.join(", ")}) but none is selected ` +
          `(set RELAY_INSTANCE_ID, or run \`relay use-instance <id>\`)`,
      };
    }
  }
  return flat();
}

/** The resolution as JSON (snake_case), ONE serializer for `relay where` and `relay pending`. */
export function serializeResolution(r: ResolvedInstance): Record<string, unknown> {
  switch (r.kind) {
    case "error":
      return r.ambiguous ? { kind: r.kind, reason: r.reason, ambiguous: true } : { kind: r.kind, reason: r.reason };
    case "flat":
      return r.warning ? { kind: r.kind, db_path: r.dbPath, exists: r.exists, warning: r.warning } : { kind: r.kind, db_path: r.dbPath, exists: r.exists };
    case "instance":
      return { kind: r.kind, id: r.id, db_path: r.dbPath, exists: r.exists, basis: r.basis };
    case "explicit-db":
      return { kind: r.kind, db_path: r.dbPath, exists: r.exists, basis: r.basis };
  }
}

/** The DB path, or a thrown Error naming the fault. Never the flat DB by accident. */
function strictDbPath(r: ResolvedInstance): string {
  if (r.kind === "error") throw new Error(r.reason);
  return r.dbPath;
}

/**
 * The instance part alone (RELAY_DB_PATH ignored), for the instance id and the
 * config path. An explicit RELAY_DB_PATH is a deliberate override, so the
 * AMBIGUOUS state under it is tolerated here (no instance: null), exactly as
 * before; every other fault throws.
 */
function instancePart(): { id: string | null; dir: string | null } {
  const r = resolveInstance({ ignoreDbPathEnv: true });
  if (r.kind === "error") {
    if (r.ambiguous && process.env.RELAY_DB_PATH) return { id: null, dir: null };
    throw new Error(r.reason);
  }
  if (r.kind === "instance") return { id: r.id, dir: path.dirname(r.dbPath) };
  return { id: null, dir: null };
}

/**
 * The active instance id (RELAY_INSTANCE_ID, else the marker), or null for the
 * flat layout. STRICT since ADR-0048: a fault THROWS; it used to return null,
 * which silently meant the flat DB.
 */
export function resolveActiveInstanceId(): string | null {
  return instancePart().id;
}

/**
 * Compute the per-instance directory. Returns null in single-instance
 * mode so callers can short-circuit to the legacy flat layout.
 */
export function instanceDir(instanceId: string | null): string | null {
  if (!instanceId) return null;
  // instance_id is operator-supplied; sanitize to prevent traversal.
  const idFault = instanceIdFault(instanceId);
  if (idFault) throw new Error(`invalid instance_id "${instanceId}": ${idFault}`);
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
  // STRICT since ADR-0048: through the ONE resolver; a fault throws.
  return strictDbPath(resolveInstance());
}

/** What this process actually resolved to, for assertion + announcement. */
export interface InstanceResolution {
  instanceId: string | null;
  dbPath: string;
  /** This MACHINE is set up for multi-instance (env, active link, or instances/ dirs). */
  multiInstance: boolean;
  /** The dangerous state: machine is multi-instance, yet WE resolved to the flat legacy DB. */
  legacyFallback: boolean;
  /** Set when RELAY_DB_PATH overrode everything — an explicit operator choice, never a fault. */
  explicitDbPathOverride: boolean;
  /** ADR-0048: the closed result every field above is derived from. */
  resolution: ResolvedInstance;
}

/** Describe — never throws. Safe for diagnostics (`relay doctor`, health output). */
export function describeInstanceResolution(): InstanceResolution {
  const resolution = resolveInstance();
  const ambiguous = resolution.kind === "error" && resolution.ambiguous === true;
  return {
    instanceId: resolution.kind === "instance" ? resolution.id : null,
    // On an error, the path the flat layout WOULD use (for the refusal message).
    dbPath: resolution.kind === "error" ? path.join(botRelayRoot(), "relay.db") : resolution.dbPath,
    multiInstance: isMultiInstanceMode(),
    legacyFallback: ambiguous || (resolution.kind === "flat" && resolution.warning !== undefined),
    explicitDbPathOverride: Boolean(process.env.RELAY_DB_PATH),
    resolution,
  };
}

/**
 * REFUSE TO RUN MUTE — startup assertion.
 *
 * The injury this prevents is NOT "wrong path". A wrong path is loud: the
 * process fails to start and somebody notices. The injury is a QUIET REDIRECT
 * TO A DIFFERENT DATABASE — the process starts perfectly, registers, reports
 * healthy, and reads an empty mailbox forever, because it resolved to the flat
 * legacy `~/.bot-relay/relay.db` on a machine whose real data lives under
 * `~/.bot-relay/instances/<id>/`. Every symptom of that looks like "quiet
 * inbox". It cost this project nine days of invisible message loss.
 *
 * The check is the CONTRADICTION, not a missing env var:
 *   isMultiInstanceMode() === true  AND  resolveActiveInstanceId() === null
 * i.e. this machine is demonstrably set up for instances, yet THIS process
 * found none. Keying on the contradiction is what makes the assertion safe for
 * legitimate single-instance users — they have no instances/ dir and no active
 * link, so `multiInstance` is false and this never fires for them. A blanket
 * "RELAY_INSTANCE_ID is required" would break every legacy and fresh install.
 *
 * Escape hatch: RELAY_ALLOW_LEGACY_FALLBACK=1 downgrades the refusal to a
 * shouted warning, for an operator who genuinely means to run against the flat
 * DB while instances exist. It warns rather than going silent, because silence
 * is the thing being fixed.
 */
export function assertInstanceResolution(
  emit: (msg: string) => void,
): InstanceResolution {
  const res = describeInstanceResolution();
  const r = res.resolution;

  // ADR-0048: REFUSE on EVERY error kind (containment included), never start on a
  // guessed DB. The ambiguous state keeps its detailed message below.
  if (r.kind === "error" && !r.ambiguous) {
    throw new Error(
      "bot-relay: REFUSING TO START — instance resolution failed:\n" +
        `  ${r.reason}\n` +
        "  A relay started on a guessed DB looks healthy and reads the WRONG mailbox.\n" +
        "  Fix the cause above, then start again (`relay doctor` prints this same result).",
    );
  }

  if (res.legacyFallback) {
    let available: string[] = [];
    try {
      available = fs
        .readdirSync(instancesRoot(), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch { /* best-effort — the message is still actionable without it */ }

    const detail =
      "bot-relay: REFUSING TO START — instance resolution is ambiguous.\n" +
      "  This machine is configured for MULTI-INSTANCE mode, but this process\n" +
      "  resolved NO instance and would have silently used the legacy flat DB:\n" +
      `    would use : ${res.dbPath}\n` +
      `    instances : ${available.length ? available.join(", ") : "(present but unreadable)"}\n` +
      "  Starting anyway would give you a process that looks healthy and reads an\n" +
      "  EMPTY mailbox — silent message loss, not a visible failure.\n" +
      "  Fix with EITHER:\n" +
      "    * set RELAY_INSTANCE_ID=<id> in this process's environment, or\n" +
      "    * run `relay use-instance <id>` to set ~/.bot-relay/active-instance\n" +
      "  Override (warns, does not fail): RELAY_ALLOW_LEGACY_FALLBACK=1";

    if (r.kind === "flat" && r.warning) {
      // The resolver honoured RELAY_ALLOW_LEGACY_FALLBACK=1: loud, never silent.
      emit(detail.replace("REFUSING TO START", "WARNING (override active)"));
      return res;
    }
    throw new Error(detail);
  }

  // Always ANNOUNCE what we landed on. The nine-day failure was survivable at
  // every single moment except one: nobody could see which DB an agent was on.
  emit(
    "[bot-relay] instance=" +
      (res.instanceId ?? "(legacy single-instance)") +
      " db=" + res.dbPath +
      (res.explicitDbPathOverride ? " (RELAY_DB_PATH override)" : ""),
  );
  return res;
}

/**
 * v2.4.0 Codex HIGH #2 patch — resolve the effective config path for
 * the active instance. Mirrors `resolveInstanceDbPath` exactly so DB
 * + config always live together (no split-brain where DB nests but
 * config stays flat). `RELAY_CONFIG_PATH` wins if set.
 */
export function resolveInstanceConfigPath(): string {
  if (process.env.RELAY_CONFIG_PATH) return process.env.RELAY_CONFIG_PATH;
  // STRICT since ADR-0048: the same resolution as the DB; a fault throws.
  const { dir } = instancePart();
  return path.join(dir ?? botRelayRoot(), "config.json");
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
