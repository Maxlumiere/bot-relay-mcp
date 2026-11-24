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
export const RESOLVER_REVISION = "df958454f1b1";

/** The instance layout, written HERE only (a tripwire test holds that). */
export const ACTIVE_INSTANCE_MARKER = "active-instance";
export const INSTANCES_DIRNAME = "instances";
export const DB_FILENAME = "relay.db";
/** The provisioning record `relay init --instance-id` / `--multi-instance` writes (src/instance.ts createInstance). */
export const INSTANCE_METADATA_FILENAME = "instance.json";

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
  | { kind: "error"; reason: string; ambiguous?: boolean; code?: string; unprovisioned?: boolean };

/**
 * instance.json's content when it parses as a JSON OBJECT, else null (absent, unreadable, a directory, corrupt, or a
 * non-object). The ONE reader of the provisioning record: src/instance.ts readInstance (`relay use-instance`,
 * `relay list-instances`) and isProvisionedInstance below both use it, so "this instance exists" has one meaning.
 */
export function readInstanceMetadataFile(instanceDirPath: string): Record<string, unknown> | null {
  const file = path.join(instanceDirPath, INSTANCE_METADATA_FILENAME);
  let fd: number | null = null;
  try {
    // Never through a link (item 0b): O_NOFOLLOW where the platform has it; elsewhere (Windows) a link is refused
    // by lstat first. A link at the record's name is not a provisioning record.
    const noFollow = fs.constants.O_NOFOLLOW;
    if (noFollow === undefined && fs.lstatSync(file).isSymbolicLink()) return null;
    // #449 R1 P2: the record's ANCESTORS are real directories too (the instance dir and its parent, instances/): a
    // STATIC link there (instances/<id> → elsewhere) would otherwise lend another tree's record. No race is needed
    // for that one, so it is refused outright.
    for (const d of [instanceDirPath, path.dirname(instanceDirPath)]) {
      const st = fs.lstatSync(d);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    }
    // O_NONBLOCK: a FIFO at the record's name would otherwise block the open before the isFile check refuses it.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (noFollow ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    if (!fs.fstatSync(fd).isFile()) return null;
    const v: unknown = JSON.parse(fs.readFileSync(fd, "utf-8"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* a close failure leaves nothing to undo */
      }
    }
  }
}

/**
 * Whether an instance directory is PROVISIONED: its instance.json is a valid record (readInstanceMetadataFile; the
 * explicit provisioning path writes it), or its relay.db already exists (a legacy instance with data, from before
 * instance.json; opening an existing DB creates nothing). A bare directory is NOT a provisioning: other code creates
 * instance directories as a side effect.
 */
export function isProvisionedInstance(instanceDirPath: string, dbExists: boolean): boolean {
  // Ruling 3fc05540: a linked instances/ or instances/<id> is never an instance, whatever it holds (a DB too).
  if (linkedInstanceComponent(instanceDirPath) !== null) return false;
  return dbExists || readInstanceMetadataFile(instanceDirPath) !== null;
}

/**
 * The instance directory a DB path names (`<instances root>/<id>/relay.db`), or null for any other layout. Compared
 * lexically AND on real paths (the instances root may not exist yet, or be reached through a link). The ONE layout
 * test: the resolver's explicit branches and the open's re-check (src/db.ts via src/instance.ts) both use it.
 */
export function instanceDirOfDbPath(dbPath: string, instancesRoot: string, opts: { caseInsensitive?: boolean } = {}): string | null {
  const dir = path.dirname(dbPath);
  const parent = path.dirname(dir);
  // The fast path: the exact spelling.
  if (path.basename(dbPath) === DB_FILENAME && path.resolve(parent) === path.resolve(instancesRoot)) return dir;
  // COMPONENT BY COMPONENT (item 0b): each side canonicalised (the nearest EXISTING ancestor through realpath.native,
  // which returns the on-disk case; the missing tail re-appended in the caller's spelling), then compared per
  // component, the basename included, case-FOLDED only when the file system is case-insensitive (detected at the
  // instances root's nearest existing ancestor; undetectable reads as insensitive: a wider layout only refuses more).
  const nearestReal = (q: string): string | null => {
    let cur = path.resolve(q);
    const tail: string[] = [];
    for (;;) {
      try {
        return path.join(fs.realpathSync.native(cur), ...tail);
      } catch {
        const up = path.dirname(cur);
        if (up === cur) return null;
        tail.unshift(path.basename(cur));
        cur = up;
      }
    }
  };
  const rp = nearestReal(parent);
  const rr = nearestReal(instancesRoot);
  if (rp === null || rr === null) return null;
  const fold = opts.caseInsensitive ?? fsIsCaseInsensitiveAt(instancesRoot);
  const same = (a: string, b: string): boolean => (fold ? caseFold(a) === caseFold(b) : a === b);
  if (!same(path.basename(dbPath), DB_FILENAME)) return null;
  const pa = rp.split(path.sep);
  const pb = rr.split(path.sep);
  return pa.length === pb.length && pa.every((c, i) => same(c, pb[i]!)) ? dir : null;
}

/** The fold for a case-insensitive file system's names (APFS / NTFS: Unicode case-insensitive). */
const caseFold = (s: string): string => s.normalize("NFC").toUpperCase().toLowerCase();

/**
 * Is the file system at `p` case-INSENSITIVE? Detected, read-only: on the nearest existing path, find a component
 * with a cased letter and stat its case-swapped spelling; the SAME file (dev + ino) means insensitive, absent or
 * another file means sensitive. No cased component anywhere (undetectable) reads as insensitive (fail closed: the
 * layout test then refuses more, never less).
 */
export function fsIsCaseInsensitiveAt(p: string, lstat: (q: string) => { dev: bigint; ino: bigint } = (q) => fs.lstatSync(q, { bigint: true })): boolean {
  let cur = path.resolve(p);
  for (;;) {
    try {
      fs.lstatSync(cur);
      break;
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return true;
      cur = up;
    }
  }
  const real = (() => {
    try {
      return fs.realpathSync.native(cur);
    } catch {
      return cur;
    }
  })();
  // #449 R1 P2: only a component on the TARGET's own file system says anything about it (a mount root, or a climb
  // across a mount boundary, would measure the parent's): another device is skipped; none left → undetectable → fold.
  let targetDev: bigint;
  try {
    targetDev = lstat(real).dev;
  } catch {
    return true;
  }
  const parts = real.split(path.sep);
  for (let i = parts.length - 1; i >= 0; i--) {
    const c = parts[i]!;
    const swapped = [...c].map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join("");
    if (swapped === c) continue; // no cased letter in this component
    const here = parts.slice(0, i + 1).join(path.sep);
    const altHere = [...parts.slice(0, i), swapped].join(path.sep);
    try {
      const a = lstat(here);
      if (a.dev !== targetDev) continue; // another file system: says nothing about the target's
      const b = lstat(altHere);
      return a.dev === b.dev && a.ino === b.ino;
    } catch {
      return false; // the swapped spelling does not exist: case-sensitive
    }
  }
  return true;
}

/**
 * Ruling 3fc05540: below the trust root (the relay home, which MAY be a link) every component is real, for read AND
 * write; a linked instances/ or instances/<id> is NOT an instance. Which one is a link, by its relative name, or null.
 */
export function linkedInstanceComponent(instanceDirPath: string): string | null {
  const id = path.basename(instanceDirPath);
  for (const [p, name] of [[path.dirname(instanceDirPath), "instances/"], [instanceDirPath, `instances/${id}`]] as const) {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) return name;
    } catch {
      /* absent: not a link */
    }
  }
  return null;
}

/** The refusal for a selected instance that was never provisioned: the id, what named it, how to create or select one. */
export function unprovisionedReason(id: string, namedBy: string, instanceDirPath: string, select: string): string {
  // A LINK below the relay home gets its own refusal (never "does not exist"), with the supported way to move storage.
  const linked = linkedInstanceComponent(instanceDirPath);
  if (linked !== null) {
    return (
      `relay: the instance directory ${linked} is a symbolic link, which is not allowed below the relay home. To keep the ` +
      `relay on other storage, move or link the WHOLE relay home (RELAY_HOME / ~/.bot-relay) instead.`
    );
  }
  return (
    `instance "${id}" (named by ${namedBy}) does not exist: ${instanceDirPath} holds no ${INSTANCE_METADATA_FILENAME} and no ` +
    `${DB_FILENAME}. Opening it would CREATE an empty relay that looks connected while its peers use another instance, ` +
    `so nothing was created. Create it with \`relay init --instance-id ${id}\`, or ${select} (\`relay list-instances\` lists them).`
  );
}

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
  // `code`: the errno of the resolver's OWN failed syscall, when that is the fault (INV-DB-01 slice 3: the native-open
  // predicate classifies a caller-config fault by it, never by the reason's text). Never serialized.
  const failed = (reason: string, errno?: unknown): ResolvedInstance =>
    typeof errno === "string" ? { kind: "error", reason, code: errno } : { kind: "error", reason };
  const code = (err: unknown) => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
  type Placed = { abs: string; exists: boolean; containment: ContainmentModel };
  const placed = (dbPath: string, make: (p: Placed) => ResolvedInstance): ResolvedInstance => {
    const c = checkContainment(dbPath, { home });
    return c.ok ? make({ abs: c.absPath, exists: c.exists, containment: c.containment }) : failed(c.reason);
  };

  // An explicit path INSIDE instances/ names that instance (Codex #442 R2 P2-1): unprovisioned, it is the same error
  // as a stale selection. Outside the layout, an explicit path is the operator's file, created as before.
  const explicit = (raw: string, basis: "RELAY_DB_PATH" | "--db-path", select: string): ResolvedInstance =>
    placed(raw, (p) => {
      const inDir = instanceDirOfDbPath(p.abs, instancesRootFor(env));
      if (inDir !== null && !isProvisionedInstance(inDir, p.exists)) {
        return { kind: "error", unprovisioned: true, reason: unprovisionedReason(path.basename(inDir), basis, inDir, select) };
      }
      return { kind: "explicit-db", dbPath: p.abs, exists: p.exists, containment: p.containment, basis };
    });
  if (opts.dbPath) return explicit(opts.dbPath, "--db-path", "pass the --db-path of an existing instance's DB");
  if (!opts.ignoreDbPathEnv && env.RELAY_DB_PATH) {
    return explicit(env.RELAY_DB_PATH, "RELAY_DB_PATH", "point RELAY_DB_PATH at an existing instance's DB, or unset it");
  }
  const root = relayRootFor(env);
  const instDir = path.join(root, INSTANCES_DIRNAME);
  const envId = env.RELAY_INSTANCE_ID;
  // A SELECTED instance (env or marker) must be provisioned: a stale or mistyped id is an error, never a path a
  // caller would create. Every consumer (open, pin, `relay where`, the hooks, the credential writers, Tether) then
  // refuses it the way it refuses any other fault.
  const selected = (id: string, namedBy: string, select: string, basis: "RELAY_INSTANCE_ID" | "active-instance"): ResolvedInstance =>
    placed(path.join(instDir, id, DB_FILENAME), (p) =>
      isProvisionedInstance(path.dirname(p.abs), p.exists)
        ? { kind: "instance", id, dbPath: p.abs, exists: p.exists, containment: p.containment, basis }
        : { kind: "error", unprovisioned: true, reason: unprovisionedReason(id, namedBy, path.dirname(p.abs), select) },
    );
  if (envId) {
    const idFault = instanceIdFault(envId, instDir);
    if (idFault) return failed(`RELAY_INSTANCE_ID "${envId}" is invalid: ${idFault}`);
    return selected(envId, "RELAY_INSTANCE_ID", "set RELAY_INSTANCE_ID to an existing instance, or unset it", "RELAY_INSTANCE_ID");
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
    return failed(`cannot inspect the relay home ${root} (${code(err)})`, (err as NodeJS.ErrnoException).code);
  }

  // The marker, read ONCE.
  const marker = path.join(root, ACTIVE_INSTANCE_MARKER);
  let markerStat: fs.Stats | null = null;
  try {
    markerStat = fs.lstatSync(marker);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return failed(`cannot inspect ${marker} (${code(err)})`, (err as NodeJS.ErrnoException).code);
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
    return selected(id, `the active-instance marker ${marker}`, "switch to an existing instance with `relay use-instance <id>`", "active-instance");
  }

  // No marker: flat only if no instance directory exists.
  let instStat: fs.Stats | null = null;
  try {
    instStat = fs.lstatSync(instDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return failed(`cannot inspect ${instDir} (${code(err)})`, (err as NodeJS.ErrnoException).code);
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
      return r.ambiguous
        ? { kind: r.kind, reason: r.reason, ambiguous: true }
        : r.unprovisioned
          ? { kind: r.kind, reason: r.reason, unprovisioned: true }
          : { kind: r.kind, reason: r.reason };
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
