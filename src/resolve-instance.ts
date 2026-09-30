// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0048 — the ONE instance resolver, as a PURE module.
 *
 * Every caller that needs "which relay DB" uses resolveInstance(): the daemon,
 * the CLI, the hooks (through `relay where`), and Tether, which BUNDLES this
 * module instead of keeping a copy of it (ADR-0048 PR D). So this file, and the
 * approved-roots predicate it uses, must stay free of side effects and heavy
 * imports: no logger, no DB, no native module (a test on Tether's bundle
 * metafile holds that). The environment is a PARAMETER (default process.env), so
 * a caller can resolve for a foreign environment in-process (Tether's injected
 * env, the deploy gate, tests) without touching process.env.
 *
 * It reports FACTS; callers own POLICY. A CLOSED result:
 *   - explicit-db : --db-path (opts.dbPath) or RELAY_DB_PATH;
 *   - instance    : RELAY_INSTANCE_ID, or the active-instance marker (read ONCE);
 *   - flat        : the legacy <root>/relay.db, ONLY on a POSITIVE absence of any
 *                   instance: the marker is ENOENT AND instances/ is ENOENT, empty,
 *                   or holds no directories (or RELAY_ALLOW_LEGACY_FALLBACK=1 over
 *                   the ambiguous state, which then carries a `warning`);
 *   - error       : ANY other fault (EIO, EACCES, ELOOP, ENOTDIR, an unreadable,
 *                   empty or malformed marker, the ambiguous state, containment).
 * A fault NEVER yields flat. Every path-bearing kind carries `exists` (a POSITIVE
 * fact from the containment walk) and `containment`: "strict" where the POSIX
 * ownership rule applies, "roots-only" where there is no uid to check (Windows:
 * the approved roots and the real-path walk still apply; the label says so
 * instead of passing silently).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkContainment, type ContainmentModel } from "./approved-roots.js";

/**
 * The resolver's revision: a content hash of this module and
 * src/approved-roots.ts (this line excluded). Tether bundles this module, so the
 * relay (`/health`, `relay where --json`) and Tether each report the revision
 * they run, and a mismatch is VISIBLE instead of a silent divergence. A test
 * recomputes the hash: change either file and it tells you the new value.
 */
export const RESOLVER_REVISION = "3cb651cae813";

/** The instance layout, written HERE only (a tripwire test holds that). */
export const ACTIVE_INSTANCE_MARKER = "active-instance";
export const INSTANCES_DIRNAME = "instances";
export const DB_FILENAME = "relay.db";

export const INSTANCE_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * EVERY environment variable resolveInstance() reads, directly or through the
 * approved roots (the home directory is HOME, or USERPROFILE on Windows for a
 * foreign env). The deploy gate (src/deploy-gate.ts) hands the NEW resolver
 * exactly these keys from the running daemon's environment and prints no other.
 * A contract test holds this list equal to the env reads in this module and
 * src/approved-roots.ts. (RELAY_CONFIG_PATH moves the config file, not the DB.)
 */
export const RESOLVER_ENV_KEYS = ["HOME", "RELAY_HOME", "RELAY_DB_PATH", "RELAY_INSTANCE_ID", "RELAY_ALLOW_LEGACY_FALLBACK", "USERPROFILE"] as const;

/** The environment the resolver reads. */
export type ResolverEnv = Readonly<Record<string, string | undefined>>;

/**
 * The home directory for `env`. For process.env it is exactly os.homedir() (the
 * behaviour every existing caller had). For a FOREIGN env it is what a process
 * with that env would get: HOME (USERPROFILE on Windows), else the account's
 * directory-service home.
 */
export function homeFor(env: ResolverEnv): string {
  if (env === process.env) return os.homedir();
  const fromEnv = process.platform === "win32" ? env.USERPROFILE : env.HOME;
  return fromEnv || os.userInfo().homedir;
}

/** The relay home for `env`: RELAY_HOME, else <home>/.bot-relay. */
export function relayRootFor(env: ResolverEnv): string {
  if (env.RELAY_HOME) return env.RELAY_HOME;
  return path.join(homeFor(env), ".bot-relay");
}

/** The instances directory for `env`. */
export function instancesRootFor(env: ResolverEnv): string {
  return path.join(relayRootFor(env), INSTANCES_DIRNAME);
}

/**
 * Why `id` is not a usable instance id under `instancesRoot`, or null when it is.
 * The charset alone admits "." and "..", which path.join collapses onto
 * instances/ itself or onto the relay home (whose relay.db is the FLAT DB, then
 * mislabeled an instance), so they are refused by name, and the joined directory
 * must be a DIRECT child of instances/.
 */
export function instanceIdFault(id: string, instancesRoot: string): string | null {
  if (!INSTANCE_ID_RE.test(id)) return `it must match ${INSTANCE_ID_RE}`;
  if (id === "." || id === "..") return `"${id}" is a path step, not a name`;
  if (path.dirname(path.resolve(instancesRoot, id)) !== path.resolve(instancesRoot)) {
    return "it does not name a direct child of the instances directory";
  }
  return null;
}

export type ResolvedInstance =
  | { kind: "explicit-db"; dbPath: string; exists: boolean; containment: ContainmentModel; basis: "RELAY_DB_PATH" | "--db-path" }
  | { kind: "instance"; id: string; dbPath: string; exists: boolean; containment: ContainmentModel; basis: "RELAY_INSTANCE_ID" | "active-instance" }
  | { kind: "flat"; dbPath: string; exists: boolean; containment: ContainmentModel; warning?: string }
  | { kind: "error"; reason: string; ambiguous?: boolean };

export interface ResolveOptions {
  /** An explicit DB path (`--db-path`): wins over everything. */
  dbPath?: string;
  /** Ignore RELAY_DB_PATH (the instance part alone, for the config path). */
  ignoreDbPathEnv?: boolean;
  /** The environment to resolve for (default process.env). Never mutated. */
  env?: ResolverEnv;
}

export function resolveInstance(opts: ResolveOptions = {}): ResolvedInstance {
  const env = opts.env ?? process.env;
  const home = homeFor(env);
  const failed = (reason: string): ResolvedInstance => ({ kind: "error", reason });
  const code = (err: unknown) => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
  type Placed = { abs: string; exists: boolean; containment: ContainmentModel };
  const placed = (dbPath: string, make: (p: Placed) => ResolvedInstance): ResolvedInstance => {
    const c = checkContainment(dbPath, { home });
    return c.ok ? make({ abs: c.absPath, exists: c.exists, containment: c.containment }) : failed(c.reason);
  };

  if (opts.dbPath) {
    return placed(opts.dbPath, (p) => ({ kind: "explicit-db", dbPath: p.abs, exists: p.exists, containment: p.containment, basis: "--db-path" }));
  }
  if (!opts.ignoreDbPathEnv && env.RELAY_DB_PATH) {
    return placed(env.RELAY_DB_PATH, (p) => ({ kind: "explicit-db", dbPath: p.abs, exists: p.exists, containment: p.containment, basis: "RELAY_DB_PATH" }));
  }
  const root = relayRootFor(env);
  const instDir = path.join(root, INSTANCES_DIRNAME);
  const envId = env.RELAY_INSTANCE_ID;
  if (envId) {
    const idFault = instanceIdFault(envId, instDir);
    if (idFault) return failed(`RELAY_INSTANCE_ID "${envId}" is invalid: ${idFault}`);
    return placed(path.join(instDir, envId, DB_FILENAME), (p) => ({
      kind: "instance", id: envId, dbPath: p.abs, exists: p.exists, containment: p.containment, basis: "RELAY_INSTANCE_ID",
    }));
  }

  const flat = (warning?: string): ResolvedInstance =>
    placed(path.join(root, DB_FILENAME), (p) =>
      warning
        ? { kind: "flat", dbPath: p.abs, exists: p.exists, containment: p.containment, warning }
        : { kind: "flat", dbPath: p.abs, exists: p.exists, containment: p.containment },
    );

  // The relay home: absent (ENOENT) is a positive absence of everything.
  try {
    fs.lstatSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return flat();
    return failed(`cannot inspect the relay home ${root} (${code(err)})`);
  }

  // The marker, read ONCE.
  const marker = path.join(root, ACTIVE_INSTANCE_MARKER);
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
    const idFault = instanceIdFault(id, instDir);
    if (idFault) return failed(`${marker} names an invalid instance id "${id}": ${idFault}`);
    return placed(path.join(instDir, id, DB_FILENAME), (p) => ({
      kind: "instance", id, dbPath: p.abs, exists: p.exists, containment: p.containment, basis: "active-instance",
    }));
  }

  // No marker: flat only if no instance directory exists.
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
      if (env.RELAY_ALLOW_LEGACY_FALLBACK === "1") {
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
      return r.warning
        ? { kind: r.kind, db_path: r.dbPath, exists: r.exists, containment: r.containment, warning: r.warning }
        : { kind: r.kind, db_path: r.dbPath, exists: r.exists, containment: r.containment };
    case "instance":
      return { kind: r.kind, id: r.id, db_path: r.dbPath, exists: r.exists, containment: r.containment, basis: r.basis };
    case "explicit-db":
      return { kind: r.kind, db_path: r.dbPath, exists: r.exists, containment: r.containment, basis: r.basis };
  }
}
