// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 slice 2b-i, the static half of "a native process never fs-opens a DB-family file" (ruling 7657ad36,
 * e6e1b44e Q3). Closing ANY descriptor to a file drops every POSIX lock the process holds on it, so an fs open of the
 * relay DB (or its -wal / -shm / -journal) in a process holding a native SQLite connection to it releases that
 * connection's locks, and another process can then checkpoint and delete the WAL under it (MEASURED in #380).
 *
 * Every reference in src/ to an fs function that opens a FILE descriptor on a path is a SITE (directory openers are out
 * of scope: closing a directory's descriptor releases no lock on a file), keyed by
 * (module, enclosing top-level function, call kind) with its COUNT pinned (tests/_helpers/fs-open-sites.ts). Each
 * key is listed below with the SOURCE of its path. A new or moved site fails until it is listed.
 * - "DB" sites open a DB-family file. They are allowed only where no native connection to that file can be held:
 *   the wasm driver (sql.js holds no fcntl locks, and a native open of a file a writable wasm connection holds is
 *   refused), the one unheld header read (db-header.ts, run only when this process holds no native handle on the
 *   file), staged copies, and restore's swap (run after closeDb() and the in-process handle count is 0).
 * - Every other site names a source that is not derived from the DB path (a config, a keyring, a log constant...).
 * The runtime complement (tests/_setup/no-fs-on-held-db.ts) fails any test in which a process holding a native
 * handle opens a DB-family path through fs.
 */
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { srcProgram, virtualProgram } from "./_helpers/ts-binding.js";
import { fsOpenSites, siteCounts } from "./_helpers/fs-open-sites.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (f: string) => path.relative(REPO, f).split(path.sep).join("/");

type Entry = { n: number; db?: true; source: string };
/** key → how many sites, whether they open a DB-family file, and the SOURCE of the path. */
const INVENTORY: Record<string, Entry> = {
  // --- DB-family sites (allowed only where no native handle on the file can be held) ---
  "src/db-header.ts::readHeaderBytes::openSync": { n: 1, db: true, source: "the DB path, read ONLY when this process holds no native handle on it (source 3 of the header; source 1 is the held connection's PRAGMA)" },
  "src/sqlite-compat.ts::createWasmDb::readFileSync": { n: 1, db: true, source: "the DB path, loaded by the wasm driver under its wasm claim (recorded before its first await, so a native open meanwhile is refused; re-checked synchronously before the read)" },
  "src/sqlite-compat.ts::persistWrite::writeFileSync": { n: 1, db: true, source: "the DB path, the wasm driver's write-back (a native open of a file a writable wasm connection holds is refused)" },
  "src/sqlite-compat.ts::openReadOnlyUnchecked::readFileSync": { n: 1, db: true, source: "a staged DB (backup/restore staging) or an export source, read by the wasm driver (refused when this process holds a native handle on it)" },
  "src/sqlite-compat.ts::openExportSource::readFileSync": { n: 1, db: true, source: "the export source, read by the wasm driver (refused when this process holds a native handle on it)" },
  "src/sqlite-compat.ts::fileSha256::readFileSync": { n: 1, db: true, source: "the wasm cold export's source (its torn-read hash): under the export's wasm claim (a native open meanwhile is refused) and a synchronous re-check right before it" },
  "src/sqlite-compat.ts::snapshotToFile::writeFileSync": { n: 1, db: true, source: "the snapshot's destination in a fresh staging directory (never the live DB)" },
  "src/backup.ts::importRelayState::copyFileSync": { n: 2, db: true, source: "the staged archive DB onto `<live DB>.new`, then (Windows fallback) onto the live DB: after closeDb() and only when this process holds no native handle on it" },
  "src/backup-archive.ts::gunzipToFile::openSync": { n: 1, db: true, source: "the archive path a restore is given: refused when it is a member of the live DB's family, or of ANY DB this process holds natively (identity)" },
  "src/backup-archive.ts::gunzipToFile::createReadStream": { n: 1, db: true, source: "the same archive path (after the same refusal)" },
  // --- staging and archives (not the DB family) ---
  "src/backup-archive.ts::gunzipToFile::createWriteStream": { n: 1, source: "a new file in the private staging directory" },
  "src/backup-archive.ts::extractBackupTar::openSync": { n: 2, source: "the decompressed tar in staging, and new member files in the staging directory" },
  "src/backup.ts::exportRelayState::createReadStream": { n: 1, source: "the plain tar the export just built in staging" },
  "src/backup.ts::exportRelayState::createWriteStream": { n: 1, source: "the archive destination (wx: never an existing file; refused when it names a DB-family file)" },
  "src/backup.ts::exportRelayState::readFileSync": { n: 1, source: "the instance config.json (getConfigPath())" },
  "src/backup.ts::exportRelayState::writeFileSync": { n: 2, source: "config.json and manifest.json in staging" },
  "src/backup.ts::importRelayState::readFileSync": { n: 1, source: "manifest.json in staging" },
  // --- config, keys, tokens, instance metadata ---
  "src/config.ts::loadConfig::readFileSync": { n: 1, source: "config.json (getConfigPath())" },
  "src/config.ts::readConfigFileKeys::readFileSync": { n: 1, source: "config.json (getConfigPath())" },
  "src/config.ts::readInstanceSqliteDriver::openSync": { n: 1, source: "config.json (getConfigPath()), one non-blocking descriptor" },
  "src/config.ts::readInstanceSqliteDriver::readFileSync": { n: 1, source: "the same descriptor" },
  "src/encryption.ts::loadKeyring::readFileSync": { n: 1, source: "RELAY_ENCRYPTION_KEYRING_PATH" },
  "src/token-lookup.ts::persistedKey::readFileSync": { n: 1, source: "persistedSecretPath() (the token-lookup key file)" },
  "src/token-lookup.ts::persistedKey::writeFileSync": { n: 1, source: "persistedSecretPath()" },
  "src/token-store.ts::<module>::readFile": { n: 1, source: "the token vault file for an agent (pathFor)" },
  "src/token-store.ts::<module>::readFileSync": { n: 1, source: "the token vault file for an agent (pathFor)" },
  "src/token-store.ts::<module>::writeFile": { n: 1, source: "a temp file beside the token vault file" },
  "src/mint-secret.ts::ensureMintSecret::openSync": { n: 1, source: "a temp file beside the mint secret" },
  "src/mint-secret.ts::readMintSecret::openSync": { n: 1, source: "the mint secret file" },
  "src/mint-secret.ts::readMintSecret::readFileSync": { n: 1, source: "the same descriptor" },
  "src/mint-secret.ts::tightenMintSecretMode::openSync": { n: 1, source: "the mint secret file" },
  "src/instance.ts::acquireInstanceLock::openSync": { n: 1, source: "the instance's daemon pid file" },
  "src/instance.ts::acquireInstanceLock::readFileSync": { n: 2, source: "the instance's daemon pid file" },
  "src/instance.ts::createInstance::readFileSync": { n: 1, source: "the instance's metadata file" },
  "src/instance.ts::createInstance::writeFileSync": { n: 1, source: "the instance's metadata file" },
  "src/instance.ts::readInstance::readFileSync": { n: 1, source: "the instance's metadata file" },
  "src/instance.ts::setActiveInstance::writeFileSync": { n: 1, source: "the active-instance link file" },
  "src/resolve-instance.ts::resolveInstance::readFileSync": { n: 1, source: "the active-instance marker file" },
  // --- CLI ---
  "src/cli/config-merge.ts::atomicWriteJson::copyFileSync": { n: 1, source: "a client config JSON (e.g. ~/.claude.json) and its .bak" },
  "src/cli/config-merge.ts::atomicWriteJson::writeFileSync": { n: 1, source: "a temp file beside that client config" },
  "src/cli/config-merge.ts::readJsonSafe::readFileSync": { n: 1, source: "a client config JSON" },
  "src/cli/doctor.ts::checkConfig::readFileSync": { n: 1, source: "config.json" },
  "src/cli/doctor.ts::checkHooks::readFileSync": { n: 1, source: "a client settings/hook file" },
  "src/cli/doctor.ts::checkMcpServerPath::readFileSync": { n: 1, source: "~/.claude.json" },
  "src/cli/doctor.ts::checkDiskSpace::rejected": { n: 1, source: "`fs as any` for statfsSync (no descriptor on any file): reviewed, no opener reached through it" },
  "src/cli/init.ts::realDaemonDeps::writeFileSync": { n: 1, source: "a temp file beside the daemon's launchd plist" },
  "src/cli/pair.ts::secretFromArgs::readFileSync": { n: 1, source: "--secret-file (an operator-given file)" },
  "src/cli/pair.ts::writePrivateConfig::openSync": { n: 1, source: "the pairing config file (wx)" },
  "src/cli/watch.ts::watchMarkerDir::watch": { n: 1, source: "the marker directory (a directory watch)" },
  // --- doorbell, watch, markers, logs ---
  "src/doorbell-heartbeat.ts::readHeartbeat::openSync": { n: 1, source: "the doorbell heartbeat file in its state dir" },
  "src/doorbell-heartbeat.ts::readHeartbeat::readFileSync": { n: 1, source: "the same descriptor" },
  "src/doorbell-lock.ts::acquireInstanceLock::openSync": { n: 1, source: "the doorbell's own lock DB file (doorbell.lock.db, never the relay DB)" },
  "src/doorbell-lock.ts::readHolderInfo::openSync": { n: 1, source: "the doorbell lock's holder sidecar" },
  "src/doorbell-lock.ts::readHolderInfo::readFileSync": { n: 1, source: "the same descriptor" },
  "src/doorbell-lock.ts::writeHolderSidecar::openSync": { n: 1, source: "a temp file beside the holder sidecar" },
  "src/doorbell-log.ts::<module>::openSync": { n: 1, source: "the doorbell log file" },
  "src/doorbell-log.ts::compactLog::openSync": { n: 1, source: "a temp file beside the doorbell log" },
  "src/doorbell-log.ts::openLog::openSync": { n: 2, source: "the doorbell log file, and its state directory (O_DIRECTORY)" },
  "src/doorbell-log.ts::openLog::readFileSync": { n: 1, source: "the doorbell log's descriptor" },
  "src/doorbell-log.ts::readLogState::openSync": { n: 1, source: "the doorbell log file" },
  "src/doorbell-log.ts::readLogState::readFileSync": { n: 1, source: "the same descriptor" },
  "src/doorbell-log.ts::replaceStateFile::openSync": { n: 1, source: "a temp state file in the doorbell state dir" },
  "src/watch-wake.ts::advanceGen::openSync": { n: 1, source: "a generation file in the watch state dir" },
  "src/watch-wake.ts::readJson::openSync": { n: 1, source: "a watch state JSON file" },
  "src/watch-wake.ts::readJson::readFileSync": { n: 1, source: "the same descriptor" },
  "src/watch-wake.ts::writeJsonAtomic::openSync": { n: 1, source: "a temp file in the watch state dir" },
  "src/filesystem-marker.ts::touchMarker::openSync": { n: 1, source: "an agent's marker file in the marker directory" },
  "src/wake-coverage-status.ts::readWakeCoverageStatus::readFileSync": { n: 1, source: "the wake-coverage status file" },
  "src/wake-coverage-status.ts::writeWakeCoverageStatus::writeFileSync": { n: 1, source: "a temp file beside the wake-coverage status file" },
  "src/transport/traffic-recorder.ts::recordCall::openSync": { n: 1, source: "the traffic-recorder log (an env-given path)" },
  // --- install, build and system files ---
  "src/build-id.ts::computeCodeId::readFileSync": { n: 2, source: "the install's package.json and its dist files" },
  "src/build-id.ts::observeOnce::readFileSync": { n: 1, source: "the install's build stamp" },
  "src/deps-snapshot.ts::computeDepsId::readFileSync": { n: 2, source: "the deps record file and the installed dependency files" },
  "src/fleet-verdicts.ts::<module>::readFileSync": { n: 1, source: "an install's package.json" },
  "src/fleet-verdicts.ts::readInstalled::readFileSync": { n: 1, source: "an install's dist/build-info.js" },
  "src/version.ts::readVersion::readFileSync": { n: 1, source: "the package's package.json" },
  "src/fleet-system.ts::<module>::readFileSync": { n: 1, source: "/proc/<pid>/cmdline" },
  "src/deploy-gate.ts::defaultGateDeps::readFileSync": { n: 1, source: "/proc/<pid>/environ" },
  "src/liveness.ts::readMachineIdFile::readFileSync": { n: 1, source: "/etc/machine-id" },
  "src/fs-perms.ts::windowsAllowSids::readFileSync": { n: 1, source: "a temp SDDL file in os.tmpdir()" },
  "src/fs-perms.ts::windowsOwnerSddlToken::writeFileSync": { n: 1, source: "a probe file in a temp directory" },
};

/** What a program's sites disagree with the inventory on: unlisted keys, changed counts, stale entries. */
function inventoryDiff(counts: Record<string, number>, inv: Record<string, Entry>): string[] {
  const out: string[] = [];
  for (const [k, n] of Object.entries(counts)) {
    if (!inv[k]) out.push(`UNLISTED ${k} (${n} site${n === 1 ? "" : "s"}): name the SOURCE of its path`);
    else if (inv[k].n !== n) out.push(`COUNT ${k}: ${n} site(s), the inventory says ${inv[k].n}`);
  }
  for (const k of Object.keys(inv)) if (!(k in counts)) out.push(`STALE ${k}: no such site any more`);
  return out;
}

describe("INV-DB-01 2b-i: every fs open of a path in src/ is inventoried, with its source", () => {
  it("the inventory matches src/ exactly (a new or moved site fails until it is listed)", () => {
    const sites = fsOpenSites(srcProgram(), rel, (f) => f.startsWith("src/"));
    expect(inventoryDiff(siteCounts(sites), INVENTORY)).toEqual([]);
  }, 120_000);

  it("every reason names a source, and no non-DB reason is a value derived from the DB path", () => {
    for (const [k, e] of Object.entries(INVENTORY)) {
      expect(e.source.length, k).toBeGreaterThan(8);
      if (!e.db) expect(e.source, k).not.toMatch(/\bdbPath\b|getDbPath|the (live )?DB\b/);
    }
  });

  describe("the scanner catches the forms the repo does not contain (virtual fixtures)", () => {
    // node's fs, declared at the paths @types/node uses, so the scanner's binding keys are the real ones.
    const NODE_FS = {
      "node_modules/@types/node/fs.d.ts": `declare module "fs" {
        export interface Stats { size: number }
        export function readFileSync(p: unknown, o?: unknown): any;
        export function openSync(p: unknown, f?: unknown): number;
        export function readSync(fd: number, b: unknown, o: number, l: number, p: number): number;
        export function statSync(p: unknown): Stats;
        export function existsSync(p: unknown): boolean;
        export function createReadStream(p: unknown): unknown;
        export * as promises from "fs/promises";
      }
      declare module "node:fs" { export * from "fs"; }`,
      "node_modules/@types/node/fs/promises.d.ts": `declare module "fs/promises" { export function readFile(p: unknown): Promise<unknown>; export function open(p: unknown, f?: unknown): Promise<unknown>; }`,
      "globals.d.ts": "declare var Buffer: { alloc(n: number): unknown }; interface ImportMeta { url: string }",
    };
    const virtualRel = (f: string) => f.replace(/\\/g, "/").replace(/^(?:[A-Za-z]:)?\/virtual\//, "");
    const scan = (files: Record<string, string>) =>
      siteCounts(fsOpenSites(virtualProgram({ ...NODE_FS, ...files }), virtualRel, (f) => f.startsWith("src/")));
    it.each([
      ["a planted fs.readFileSync(dbPath)", `import * as fs from "fs";\nexport function leak(dbPath: string) { return fs.readFileSync(dbPath); }`, "src/m.ts::leak::readFileSync"],
      ["a renamed named import", `import { readFileSync as r } from "node:fs";\nexport function leak(p: string) { return r(p); }`, "src/m.ts::leak::readFileSync"],
      ["a namespace import", `import * as f from "fs";\nexport function leak(p: string) { return f.openSync(p, "r"); }`, "src/m.ts::leak::openSync"],
      ["fs.promises", `import * as fs from "fs";\nexport async function leak(p: string) { return fs.promises.open(p, "r"); }`, "src/m.ts::leak::open"],
      ["fs/promises", `import { readFile } from "fs/promises";\nexport async function leak(p: string) { return readFile(p); }`, "src/m.ts::leak::readFile"],
      ["a stream", `import { createReadStream } from "fs";\nexport function leak(p: string) { return createReadStream(p); }`, "src/m.ts::leak::createReadStream"],
      ["an opener passed as a value", `import { readFileSync } from "fs";\nexport function leak(p: string, f = readFileSync) { return f(p); }`, "src/m.ts::leak::readFileSync (reference)"],
      ["a destructured namespace", `import * as fs from "fs";\nexport function leak(p: string) { const { openSync } = fs; return openSync(p, "r"); }`, "src/m.ts::leak::rejected"],
      ["computed member access", `import * as fs from "fs";\nexport function leak(p: string) { return (fs as any)["readFileSync"](p); }`, "src/m.ts::leak::rejected"],
      ["require", `declare function createRequire(u: string): (m: string) => any;\nexport function leak(p: string) { return createRequire(import.meta.url)("fs").readFileSync(p); }`, "src/m.ts::leak::rejected"],
    ] as const)("%s → an UNLISTED site", (_label, code, key) => {
      const counts = scan({ "src/m.ts": code });
      expect(counts[key], JSON.stringify(counts)).toBeGreaterThan(0);
      expect(inventoryDiff(counts, INVENTORY).some((d) => d.startsWith(`UNLISTED ${key}`))).toBe(true);
    });

    it("type positions and fd-only calls are not sites (no false alarm)", () => {
      const counts = scan({
        "src/m.ts": `import * as fs from "fs";\nexport function ok(fd: number, s: fs.Stats): number { fs.statSync("/x"); fs.existsSync("/x"); return fs.readSync(fd, Buffer.alloc(1), 0, 1, 0) + s.size; }`,
      });
      expect(counts).toEqual({});
    });
  });
});
