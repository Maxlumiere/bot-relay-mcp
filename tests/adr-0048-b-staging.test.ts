// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0048 PR B (Codex #288 R2 #1, #2).
 *   #1 the SHARED ROOT itself must be owned by root (or you) before its
 *      world-writable mode is exempted: a foreign owner of /tmp could rename or
 *      remove your entries despite the sticky bit.
 *   #2 backup/restore STAGING lives under os.tmpdir() ($TMPDIR, anywhere). Its
 *      ancestry must be PRIVATE (ssh StrictModes, on every traversed component:
 *      owned by you or root; a sticky directory may be world-writable only when
 *      root or you own it; anything else not group/other-writable), and the raw
 *      read-only open of a staged DB (sqlite-compat openReadOnly) re-checks it
 *      after opening. With TMPDIR in a world-writable, non-sticky directory,
 *      another user could swap the extracted DB before restore copies it live.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UID = typeof process.getuid === "function" ? process.getuid() : -1;
const IS_ROOT = UID === 0;
const SHARED_DIR = fs.realpathSync(fs.mkdtempSync("/tmp/adr0048t-"));
const SHARED_ROOT = fs.realpathSync("/tmp");
fs.mkdirSync(path.join(REPO_ROOT, "node_modules", ".cache"), { recursive: true });
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(REPO_ROOT, "node_modules", ".cache", "adr0048t-")));
// A team TMPDIR: world-writable and NOT sticky (the Codex scenario).
const TEAM = path.join(SHARED_DIR, "team");
fs.mkdirSync(TEAM);
fs.chmodSync(TEAM, 0o777);
// A private TMPDIR (the twin).
const PRIVATE_TMP = path.join(SHARED_DIR, "mine");
fs.mkdirSync(PRIVATE_TMP, { mode: 0o700 });

const ENV = ["HOME", "TMPDIR", "RELAY_DB_PATH", "RELAY_INSTANCE_ID", "RELAY_HTTP_PORT", "RELAY_CONFIG_PATH", "RELAY_WAKE_COVERAGE_STATUS_PATH"] as const;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  delete process.env.RELAY_INSTANCE_ID;
  process.env.HOME = HOME;
  process.env.RELAY_DB_PATH = path.join(HOME, "relay.db");
  process.env.RELAY_HTTP_PORT = "1";
  process.env.RELAY_CONFIG_PATH = path.join(HOME, "config.json");
  process.env.RELAY_WAKE_COVERAGE_STATUS_PATH = path.join(HOME, "wc.json");
  (await import("../src/db.js")).closeDb();
});
afterEach(async () => {
  vi.restoreAllMocks();
  (await import("../src/db.js")).closeDb();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterAll(() => {
  fs.rmSync(SHARED_DIR, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe.skipIf(UID < 0)("Codex #288 R2 #1 — the shared root's OWN owner is checked before its mode is exempted", () => {
  it("/tmp (real) owned by another uid → refused (injected lstat)", async () => {
    const real = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      const st = (real as (...a: unknown[]) => fs.Stats)(p, ...rest);
      return String(p) === SHARED_ROOT ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: UID + 1 }) : st;
    }) as never);
    const { checkContainment } = await import("../src/approved-roots.js");
    const c = checkContainment(path.join(SHARED_DIR, "relay.db"));
    expect(c.ok, JSON.stringify(c)).toBe(false);
    if (!c.ok) expect(c.reason).toMatch(new RegExp(`${SHARED_ROOT}.*owned by uid`));
  });
});

describe.skipIf(UID < 0 || IS_ROOT)("Codex #288 R2 #2 — staging is private, and the raw read-only open re-checks it", () => {
  async function seededArchive(): Promise<string> {
    process.env.TMPDIR = PRIVATE_TMP;
    const db = await import("../src/db.js");
    await db.initializeDb();
    db.registerAgent("s-agent", "r", []);
    const { exportRelayState } = await import("../src/backup.js");
    const r = await exportRelayState({ destinationPath: path.join(HOME, `a-${Date.now()}.tar.gz`) });
    db.closeDb();
    return r.archive_path;
  }
  it("openReadOnly refuses a DB under a world-writable, NON-sticky directory (post-open re-check)", async () => {
    const p = path.join(TEAM, "staged.db");
    const Better = (await import("better-sqlite3")).default;
    new Better(p).close();
    const { openReadOnly } = await import("../src/sqlite-compat.js");
    await expect(openReadOnly(p, "native")).rejects.toThrow(/group- or other-writable/);
  });
  it("restore with TMPDIR in a world-writable, NON-sticky directory → REFUSED before anything is copied live", async () => {
    const archive = await seededArchive();
    const live = path.join(HOME, "relay.db");
    const before = fs.readFileSync(live);
    process.env.TMPDIR = TEAM;
    const { importRelayState } = await import("../src/backup.js");
    // Refused UP FRONT (the staging assert), before the archive is even extracted
    // there; the post-open re-check in openReadOnly is only the backstop.
    await expect(importRelayState(archive, { force: true })).rejects.toThrow(/the staging directory .* is not private: .*group- or other-writable/);
    expect(fs.readFileSync(live).equals(before), "the live DB was not touched").toBe(true);
  });
  it("a FRESH restore (no live DB, so no safety backup first) with that TMPDIR → the IMPORT staging is refused, nothing created live", async () => {
    const archive = await seededArchive();
    const fresh = path.join(HOME, "fresh", "relay.db");
    process.env.RELAY_DB_PATH = fresh;
    process.env.TMPDIR = TEAM;
    const { importRelayState } = await import("../src/backup.js");
    await expect(importRelayState(archive, { force: true })).rejects.toThrow(/the staging directory .*relay-import-.* is not private/);
    expect(fs.existsSync(fresh), "no DB was restored").toBe(false);
  });
  it("export with the same TMPDIR → refused too (its staging is the same kind)", async () => {
    process.env.TMPDIR = TEAM;
    const db = await import("../src/db.js");
    await db.initializeDb();
    const { exportRelayState } = await import("../src/backup.js");
    await expect(exportRelayState({ destinationPath: path.join(HOME, "x.tar.gz") })).rejects.toThrow(/the staging directory .* is not private: .*group- or other-writable/);
  });
  it("TWIN: a PRIVATE TMPDIR → restore works", async () => {
    const archive = await seededArchive();
    process.env.TMPDIR = PRIVATE_TMP;
    const { importRelayState } = await import("../src/backup.js");
    const r = await importRelayState(archive, { force: true });
    expect(r).toMatchObject({ restored: true });
  });
});
