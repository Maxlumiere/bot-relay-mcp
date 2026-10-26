// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-22 POSIX, FAIL CLOSED (ruled 20 Oct): when a tool has no trusted system path (a non-FHS host: NixOS, Guix), the
 * relay never falls back to PATH, not even a trust-checked one (a root-installed GNU tool breaks the PARSE, as
 * Homebrew ps did). Here:
 *   - the error names the tool, EVERY candidate checked with why it was rejected, the host class, and SEC-22;
 *   - liveness: no `ps` → a start read is "unreadable", never "gone" (INV-LIVE-01: no signal, no cleanup);
 *   - `relay backup` (export AND restore) fails BEFORE it writes anything: no archive, no backups dir, no staging,
 *     and a restore leaves the live DB untouched.
 * The unresolvable tool is simulated by mocking systemBinary for a chosen set of names (`UNRESOLVABLE`); every other
 * tool resolves as in production. The two starters (spawnSystem, execSystem) call the module's OWN systemBinary,
 * which a mock of the export cannot reach, so they are wrapped too: for an unresolvable name each answers exactly as
 * the real one does when its systemBinary throws (spawnSystem: a failed run carrying the SystemBinaryError; execSystem:
 * that error thrown); every other name goes to the real one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const UNRESOLVABLE = new Set<string>();
vi.mock("../src/system-binary.js", async (importOriginal) => {
  const real = (await importOriginal()) as typeof import("../src/system-binary.js");
  return {
    ...real,
    systemBinary: (name: string, ...rest: unknown[]) => {
      if (UNRESOLVABLE.has(name)) throw unresolvable(name);
      return (real.systemBinary as (n: string, ...r: unknown[]) => string)(name, ...rest);
    },
    spawnSystem: (name: string, ...rest: unknown[]) => {
      if (UNRESOLVABLE.has(name)) {
        const error = unresolvable(name);
        return { pid: 0, output: [], stdout: "", stderr: error.message, status: null, signal: null, error };
      }
      return (real.spawnSystem as (n: string, ...r: unknown[]) => unknown)(name, ...rest);
    },
    execSystem: (name: string, ...rest: unknown[]) => {
      if (UNRESOLVABLE.has(name)) throw unresolvable(name);
      return (real.execSystem as (n: string, ...r: unknown[]) => unknown)(name, ...rest);
    },
  };
  function unresolvable(name: string) {
    return new real.SystemBinaryError(`cannot locate the system ${name}: (test) no trusted candidate`);
  }
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sec22-fail-closed-"));
process.env.RELAY_DB_PATH = path.join(ROOT, "db", "relay.db");
process.env.RELAY_CONFIG_PATH = path.join(ROOT, "db", "config.json");
// A PRIVATE tmp dir: the "no staging left" checks list it, so no other test's staging can race them.
process.env.TMPDIR = path.join(ROOT, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true, mode: 0o700 });
for (const k of ["RELAY_AGENT_TOKEN", "RELAY_AGENT_NAME", "RELAY_AGENT_ROLE", "RELAY_AGENT_CAPABILITIES", "RELAY_ALLOW_LEGACY"]) delete process.env[k];

beforeEach(() => UNRESOLVABLE.clear());
afterEach(async () => {
  UNRESOLVABLE.clear();
  (await import("../src/db.js")).closeDb();
});

/** Every entry under `dir` (any depth), or [] when it does not exist. */
const tree = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : []);
const stagings = (prefix: string) => {
  expect(os.tmpdir(), "the staging checks list THIS file's private tmp").toBe(process.env.TMPDIR);
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(prefix)).sort();
};

describe("SEC-22 POSIX: a tool with no trusted path FAILS CLOSED, loudly", () => {
  it("HARM a Linux host with no candidate (NixOS-style): the error names the tool, every candidate and why, the host class, and SEC-22", async () => {
    const { systemBinary, SystemBinaryError } = await vi.importActual<typeof import("../src/system-binary.js")>("../src/system-binary.js");
    const missing = { realpathSync: (p: string) => p, lstatSync: (p: string): never => { throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" }); } };
    let err: unknown;
    try {
      (systemBinary as (n: string, e: object, p: string, f: object) => string)("ps", {}, "linux", missing);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SystemBinaryError);
    const msg = (err as Error).message;
    expect(msg).toMatch(/\bps\b/);
    for (const c of ["/usr/bin/ps", "/bin/ps"]) expect(msg, `names the candidate ${c}`).toContain(`${c}: missing`);
    expect(msg).toMatch(/no FHS system binary: NixOS\/Guix-style host\?/);
    expect(msg).toContain("SEC-22");
  });

  it("HARM no trusted ps: a start read is UNREADABLE, never gone (INV-LIVE-01: no signal, no cleanup)", async (ctx) => {
    if (process.platform === "win32") ctx.skip("POSIX start reads");
    const { processStartedAt } = await import("../src/liveness.js");
    expect(processStartedAt(process.pid).kind, "TWIN: with ps resolvable, the real start").toBe("start");
    UNRESOLVABLE.add("ps");
    const r = processStartedAt(process.pid);
    expect(r.kind, JSON.stringify(r)).toBe("unreadable");
  });
});

describe("SEC-22 POSIX: `relay backup` with no trusted tar fails BEFORE it writes anything", () => {
  it("HARM export: refused with the named error; no archive, no backups dir, no staging left", async (ctx) => {
    if (process.platform === "win32") ctx.skip("POSIX tar (Windows tar is its own ticket)");
    const db = await import("../src/db.js");
    await db.initializeDb();
    db.registerAgent("alpha", "r", []);
    const backupsDir = path.join(ROOT, "db", "backups");
    fs.rmSync(backupsDir, { recursive: true, force: true });
    const dest = path.join(ROOT, "db", "out.tar.gz");
    const before = stagings("relay-export-");
    UNRESOLVABLE.add("tar");
    const { exportRelayState } = await import("../src/backup.js");
    await expect(exportRelayState({ destinationPath: dest })).rejects.toThrow(/cannot locate the system tar/);
    expect(fs.existsSync(dest), "no archive").toBe(false);
    expect(fs.existsSync(backupsDir), "no backups dir created").toBe(false);
    expect(stagings("relay-export-"), "no staging dir created or left").toEqual(before);
    // TWIN: with tar resolvable, the same export writes its archive.
    UNRESOLVABLE.clear();
    const ok = await exportRelayState({ destinationPath: dest });
    expect(fs.existsSync(ok.archive_path)).toBe(true);
  });

  it("HARM restore: refused with the named error before the safety backup, staging or the DB swap; the live DB is untouched", async (ctx) => {
    if (process.platform === "win32") ctx.skip("POSIX tar (Windows tar is its own ticket)");
    const db = await import("../src/db.js");
    await db.initializeDb();
    db.registerAgent("beta", "r", []);
    const { exportRelayState, importRelayState } = await import("../src/backup.js");
    const archive = (await exportRelayState({ destinationPath: path.join(ROOT, "db", "restore-src.tar.gz") })).archive_path;
    const backupsDir = path.join(ROOT, "db", "backups");
    const backupsBefore = tree(backupsDir);
    const dbBytes = fs.readFileSync(process.env.RELAY_DB_PATH!);
    const before = stagings("relay-import-");
    UNRESOLVABLE.add("tar");
    await expect(importRelayState(archive, { force: true })).rejects.toThrow(/cannot locate the system tar/);
    expect(tree(backupsDir), "no safety backup written").toEqual(backupsBefore);
    expect(stagings("relay-import-"), "no staging dir created or left").toEqual(before);
    expect(fs.readFileSync(process.env.RELAY_DB_PATH!).equals(dbBytes), "the live DB file is byte-identical").toBe(true);
    expect(db.getAgents().some((a) => a.name === "beta"), "the live connection still serves").toBe(true);
  });
});
