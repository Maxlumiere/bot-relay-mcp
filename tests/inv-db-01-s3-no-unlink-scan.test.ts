// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 slice 3, never-unlink (the slice-3 ruling): relay code never unlinks a DB-family file (the DB, its
 * -wal, -shm, -journal). A refusal leaves the file and names it. Restore REQUIRES the side files to be absent at its
 * swap instead of deleting them: a stale WAL left beside a replaced DB is REPLAYED onto it by the next open (MEASURED
 * 6 Nov: 51 pre-restore rows instead of the archive's 1, integrity_check ok).
 *
 * Every call in the DB modules to an fs function that removes a path is a SITE, keyed by (module, enclosing top-level
 * function, api) AND its exact call text. Each is listed with what it removes; a new, moved or changed remove fails
 * until it is listed, and no listed remove may name a DB-family path.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { srcProgram, virtualProgram } from "./_helpers/ts-binding.js";
import { fsOpenSites, REMOVERS } from "./_helpers/fs-open-sites.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (f: string) => path.relative(REPO, f).split(path.sep).join("/");
const DB_MODULES = ["src/backup.ts", "src/db-owner-lock.ts", "src/sqlite-compat.ts", "src/db.ts", "src/db-header.ts", "src/cli/_instance-db.ts"];

/** `<key> <call text>` → what it removes (never a DB-family file). */
const ALLOWED: Record<string, string> = {
  "src/backup.ts::takeSnapshot::rmSync fs.rmSync(snapshotDbPath, { force: true })": "a torn snapshot COPY in the staging directory (never the live DB)",
  "src/backup.ts::exportRelayState::rmSync fs.rmSync(stagingDir, { recursive: true, force: true })": "the export's own staging directory under $TMPDIR",
  "src/backup.ts::importRelayState::rmSync fs.rmSync(plainTar, { force: true })": "the decompressed archive in the staging directory",
  "src/backup.ts::importRelayState::rmSync fs.rmSync(newPath, { force: true })": "this restore's own staged `.new` copy, when a final check or the swap's rename refuses (not a DB-family name; the Windows copy-over fallback and its unlink are gone, slice 4)",
  "src/backup.ts::importRelayState::rmSync fs.rmSync(stagingDir, { recursive: true, force: true })": "the restore's own staging directory under $TMPDIR",
  "src/db-owner-lock.ts::materializeDb::rmSync fs.rmSync(tmp, { force: true })": "the materialize temp NAME (.<base>.<pid>.<hex>.new); after a link the DB keeps its own name",
  "src/db-owner-lock.ts::removeOwnMaterializeLinks::unlinkSync fs.unlinkSync(p)": "a second NAME of the DB left by a killed materialize (the reserved .<base>.<pid>.<hex>.new pattern, same dev+ino): the DB's own name and data stay",
  "src/sqlite-compat.ts::ownerPersist::rmSync fs.rmSync(tmp, { force: true })": "the owner's persist temp file (never renamed into place on this path)",
};

function sitesOf(program: ReturnType<typeof srcProgram>, inFile: (f: string) => boolean, relOf: (f: string) => string = rel): string[] {
  return fsOpenSites(program, relOf, inFile, REMOVERS)
    .map((s) => `${s.key} ${s.text}`)
    .sort();
}
const diff = (found: string[]) => [
  ...found.filter((k) => !(k in ALLOWED)).map((k) => `UNLISTED remove: ${k}`),
  ...Object.keys(ALLOWED).filter((k) => !found.includes(k)).map((k) => `STALE entry: ${k}`),
];

describe("INV-DB-01 slice 3: no relay code unlinks a DB-family file", () => {
  it("every remove in the DB modules is listed, with what it removes (none is the DB or a side file)", () => {
    const found = sitesOf(srcProgram(), (f) => DB_MODULES.includes(f));
    expect(diff(found)).toEqual([]);
  }, 120_000);

  it("no listed reason is a DB-family file", () => {
    for (const [k, why] of Object.entries(ALLOWED)) expect(why, k).not.toMatch(/^(the )?(live )?(DB|db|-wal|-shm|-journal|side file)/);
  });

  describe("the scan catches the removes the repo must not contain (virtual fixtures)", () => {
    // node's fs, declared at the paths @types/node uses, so the scanner's binding keys are the real ones.
    const NODE_FS = {
      "node_modules/@types/node/fs.d.ts": `declare module "fs" {
        export function unlinkSync(p: unknown): void;
        export function rmSync(p: unknown, o?: unknown): void;
        export * as promises from "fs/promises";
      }
      declare module "node:fs" { export * from "fs"; }`,
      "node_modules/@types/node/fs/promises.d.ts": `declare module "fs/promises" { export function unlink(p: unknown): Promise<void>; export function rm(p: unknown, o?: unknown): Promise<void>; }`,
    };
    const virtualRel = (f: string) => f.replace(/\\/g, "/").replace(/^(?:[A-Za-z]:)?\/virtual\//, "");
    it.each([
      ["a side-file unlink", `import * as fs from "fs";\nexport function swap(dbPath: string) { for (const s of ["-wal", "-shm"]) fs.unlinkSync(dbPath + s); }`],
      ["an unlink of the DB itself", `import { unlinkSync } from "node:fs";\nexport function drop(dbPath: string) { unlinkSync(dbPath); }`],
      ["an rm through fs.promises", `import * as fs from "fs";\nexport async function drop(p: string) { await fs.promises.rm(p, { force: true }); }`],
      ["an unlink from fs/promises", `import { unlink } from "fs/promises";\nexport async function drop(p: string) { await unlink(p); }`],
      ["a renamed import", `import { rmSync as gone } from "fs";\nexport function drop(p: string) { gone(p); }`],
    ] as const)("%s → an UNLISTED remove", (_label, code) => {
      const found = sitesOf(virtualProgram({ ...NODE_FS, "src/backup.ts": code }), (f) => f === "src/backup.ts", virtualRel);
      expect(found.length, "the scan saw the remove").toBeGreaterThan(0);
      expect(diff(found).some((d) => d.startsWith("UNLISTED remove: src/backup.ts::"))).toBe(true);
    });

    it("R1: a site's text is pinned IN FULL: two calls that differ only after 100 characters are two different sites", () => {
      const long = "a".repeat(110);
      const one = sitesOf(virtualProgram({ ...NODE_FS, "src/backup.ts": `import * as fs from "fs";\nexport function drop(${long}x: string) { fs.rmSync(${long}x); }` }), (f) => f === "src/backup.ts", virtualRel);
      const two = sitesOf(virtualProgram({ ...NODE_FS, "src/backup.ts": `import * as fs from "fs";\nexport function drop(${long}y: string) { fs.rmSync(${long}y); }` }), (f) => f === "src/backup.ts", virtualRel);
      expect(one.length).toBe(1);
      expect(one[0]).toContain(`fs.rmSync(${long}x)`);
      expect(one[0]).not.toBe(two[0]);
    });
  });
});

/**
 * The side-file absence rule's stated limit (the slice-3 ruling): a PERSIST/TRUNCATE rollback journal or a persistent WAL
 * leaves side files after a healthy close, so the rule would refuse. The relay itself never selects one: src sets
 * journal_mode only to WAL (and, later, DELETE in convert-journal), and never persist_wal or journal_size_limit.
 */
describe("INV-DB-01 slice 3: src never selects a journal mode that leaves side files after a clean close", () => {
  const SRC = path.join(REPO, "src");
  const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));
  const MODE = /journal_mode\s*=\s*['"]?([A-Za-z]+)/gi;
  const PERSIST = /persist_wal|journal_size_limit|PERSIST_WAL/i;
  const scan = (text: string) => ({ modes: [...text.matchAll(MODE)].map((m) => m[1]!.toUpperCase()), persist: PERSIST.test(text) });
  it("every journal_mode src sets is WAL or DELETE, and no persist_wal / journal_size_limit", () => {
    const hits: string[] = [];
    let modes = 0;
    for (const f of files(SRC)) {
      const r = scan(fs.readFileSync(f, "utf-8"));
      modes += r.modes.length;
      for (const m of r.modes) if (m !== "WAL" && m !== "DELETE") hits.push(`${path.relative(REPO, f)}: journal_mode=${m}`);
      if (r.persist) hits.push(`${path.relative(REPO, f)}: persist_wal / journal_size_limit`);
    }
    expect(modes, "the scan sees the relay's own journal_mode = WAL").toBeGreaterThan(0);
    expect(hits).toEqual([]);
  });
  it.each([
    ["PERSIST", `db.pragma("journal_mode = PERSIST");`],
    ["TRUNCATE", `db.pragma('journal_mode=truncate')`],
    ["persist_wal", `db.fileControl(SQLITE_FCNTL_PERSIST_WAL, 1)`],
    ["journal_size_limit", `db.pragma("journal_size_limit = 0")`],
  ] as const)("planted %s is caught", (_label, text) => {
    const r = scan(text);
    expect(r.persist || r.modes.some((m) => m !== "WAL" && m !== "DELETE")).toBe(true);
  });
});

