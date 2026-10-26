// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-22: RESTORE reads a backup archive IN-PROCESS (src/backup-archive.ts): ONE parser decides and extracts, and no
 * tar runs on restore. Only relay.db, manifest.json and config.json ever land. What macOS tar always added (an
 * AppleDouble `._<name>`, a pax header with xattr / time keys) is SKIPPED and reported; anything else is REFUSED.
 *
 * Each refused form is a crafted archive (tests/_helpers/ustar.ts), and each refusal leaves nothing but expected
 * names in the output dir. The known-good twins: a plain 3-member ustar archive, a GNU-magic one, the EXACT 9-member
 * legacy macOS archive (tests/fixtures/backup, sha256 pinned), an archive the runner's own tar makes with the
 * pre-SEC-22 invocation (`tar -czf`: GNU tar on Linux, bsdtar on macOS, System32 tar.exe on Windows, each MEASURED on
 * its CI job), and a full export -> restore round trip, whose export must hold exactly the 3 plain members.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { craftTar, paxBody, gzip, type CraftedMember } from "./_helpers/ustar.js";

const { gunzipToFile, extractBackupTar, ArchiveRefused, MAX_SKIPPED_BYTES } = await import("../src/backup-archive.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "backup");
const WIN = process.platform === "win32";
const EXPECTED = ["relay.db", "manifest.json", "config.json"];
const DB = Buffer.from("SQLite format 3\0" + "x".repeat(600));
const MANIFEST = JSON.stringify({ schema_version: 1, archive_format_version: 1 });

let tmp: string;
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "backup-archive-")));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** Write a plain tar, extract it into a fresh dir; return the result or the refusal message, and what the dir holds. */
function run(tar: Buffer): { result?: ReturnType<typeof extractBackupTar>; refused?: string; other?: string; files: string[] } {
  const dir = path.join(tmp, `case-${++n}`);
  fs.mkdirSync(dir);
  const tarPath = path.join(tmp, `case-${n}.tar`);
  fs.writeFileSync(tarPath, tar);
  try {
    const result = extractBackupTar(tarPath, dir);
    return { result, files: fs.readdirSync(dir).sort() };
  } catch (err) {
    const files = fs.readdirSync(dir).sort();
    if (err instanceof ArchiveRefused) return { refused: err.message, files };
    return { other: `${(err as Error)?.name}: ${(err as Error)?.message}`, files };
  }
}
const three = (extra: Partial<CraftedMember> = {}): CraftedMember[] => [
  { name: "relay.db", data: DB, ...extra },
  { name: "manifest.json", data: MANIFEST },
  { name: "config.json", data: "{}" },
];

describe("known-good: what a real backup holds is restored, byte for byte", () => {
  it("a plain 3-member POSIX ustar archive (what the new export writes)", () => {
    const r = run(craftTar(three()));
    expect(r.refused ?? r.other).toBeUndefined();
    expect(r.result).toEqual({ extracted: EXPECTED, skipped: [] });
    expect(fs.readFileSync(path.join(tmp, `case-${n}`, "relay.db"))).toEqual(DB);
  });
  it("GNU magic (GNU tar's default on Linux)", () => {
    expect(run(craftTar(three().map((m) => ({ ...m, magic: "gnu" as const })))).result?.extracted).toEqual(EXPECTED);
  });
  it("a positive base-256 size field is parsed", () => {
    const field = Buffer.alloc(12);
    field[0] = 0x80;
    field.writeUInt32BE(DB.length, 8);
    expect(run(craftTar(three({ sizeField: field }))).result?.extracted).toEqual(EXPECTED);
  });
  it("zero record padding after the two end-of-archive blocks is skipped", () => {
    expect(run(craftTar(three(), { trailing: Buffer.alloc(8192) })).result?.extracted).toEqual(EXPECTED);
  });
  it("the EXACT legacy 9-member macOS backup (fixture, sha256 pinned): 3 extracted, 6 skipped and REPORTED", async () => {
    const fixture = path.join(FIXTURES, "legacy-macos-9-member.tar.gz");
    expect(crypto.createHash("sha256").update(fs.readFileSync(fixture)).digest("hex")).toBe("a227285001bc79cb935b9806dde3939a5d27d24a61a3d13ea312766579472afd");
    const plain = path.join(tmp, "legacy.tar");
    await gunzipToFile(fixture, plain);
    const dir = path.join(tmp, "legacy");
    fs.mkdirSync(dir);
    expect(extractBackupTar(plain, dir)).toEqual({
      extracted: EXPECTED,
      skipped: ["._relay.db", "pax header for relay.db", "._manifest.json", "pax header for manifest.json", "._config.json", "pax header for config.json"],
    });
    expect(fs.readdirSync(dir).sort()).toEqual([...EXPECTED].sort());
  });
  it("the GNU-magic fixture (sha256 pinned)", async () => {
    const fixture = path.join(FIXTURES, "gnu-magic-3-member.tar.gz");
    expect(crypto.createHash("sha256").update(fs.readFileSync(fixture)).digest("hex")).toBe("a2f0cd44e3b9f609175bc32bc22ed4fcfdea19747a492b17593eb1ff618991e1");
    const plain = path.join(tmp, "gnu.tar");
    await gunzipToFile(fixture, plain);
    const dir = path.join(tmp, "gnu");
    fs.mkdirSync(dir);
    expect(extractBackupTar(plain, dir)).toEqual({ extracted: EXPECTED, skipped: [] });
  });
  it("an archive THIS runner's tar makes with the pre-SEC-22 invocation (`tar -czf`): GNU tar / bsdtar / System32 tar.exe, MEASURED per CI OS", async () => {
    const stage = path.join(tmp, "own-tar-stage");
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, "relay.db"), DB);
    fs.writeFileSync(path.join(stage, "manifest.json"), MANIFEST);
    fs.writeFileSync(path.join(stage, "config.json"), "{}");
    const tarExe = WIN ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    const archive = path.join(tmp, "own-tar.tar.gz");
    const made = spawnSync(tarExe, ["-czf", archive, "relay.db", "manifest.json", "config.json"], { cwd: stage, encoding: "utf-8" });
    expect(made.status, made.stderr).toBe(0);
    const version = spawnSync(tarExe, ["--version"], { encoding: "utf-8" }).stdout.split("\n")[0];
    const plain = path.join(tmp, "own-tar.tar");
    await gunzipToFile(archive, plain);
    const dir = path.join(tmp, "own-tar");
    fs.mkdirSync(dir);
    const r = extractBackupTar(plain, dir);
    console.error(`[backup-archive] ${process.platform}: ${version}: extracted ${r.extracted.join(",")}; skipped ${JSON.stringify(r.skipped)}`);
    expect(r.extracted).toEqual(EXPECTED);
  });
});

describe("REFUSED: every member that is not one of the three regular files", () => {
  it.each([
    ["a symlink named relay.db", three({ typeflag: "2", linkname: "/etc/hosts", data: "" })],
    ["a hard link named relay.db", three({ typeflag: "1", linkname: "manifest.json", data: "" })],
    ["a directory", [{ name: "relay.db", typeflag: "5", data: "" }, ...three().slice(1)]],
    ["a character device", [{ name: "relay.db", typeflag: "3", data: "" }, ...three().slice(1)]],
    ["a FIFO", [{ name: "relay.db", typeflag: "6", data: "" }, ...three().slice(1)]],
    ["a GNU long name (L)", [{ name: "././@LongLink", typeflag: "L", data: "relay.db\0", magic: "gnu" }, ...three()]],
    ["a global pax header (g)", [{ name: "pax_global_header", typeflag: "g", data: paxBody({ comment: "x" }) }, ...three()]],
    ["a traversal name", [{ name: "../relay.db", data: DB }, ...three().slice(1)]],
    ["an absolute name", [{ name: "/relay.db", data: DB }, ...three().slice(1)]],
    ["a ./ name", [{ name: "./relay.db", data: DB }, ...three().slice(1)]],
    ["an unexpected file", [...three(), { name: "evil.sh", data: "#!/bin/sh" }]],
    ["a POSIX ustar prefix", three({ prefix: "../../etc" })],
    ["a duplicate relay.db", [...three(), { name: "relay.db", data: DB }]],
    ["an AppleDouble member of an unexpected name", [{ name: "._evil", data: "x" }, ...three()]],
    ["an AppleDouble member twice", [{ name: "._relay.db", data: "x" }, { name: "._relay.db", data: "x" }, ...three()]],
    ["an AppleDouble member over its cap", [{ name: "._relay.db", data: Buffer.alloc(MAX_SKIPPED_BYTES + 1) }, ...three()]],
    ["a manifest.json over its 1 MiB cap", [three()[0], { name: "manifest.json", data: Buffer.alloc(1024 ** 2 + 1) }, three()[2]]],
    ["a v7 header (no ustar magic)", three({ magic: "none" })],
  ] as Array<[string, CraftedMember[]]>)("%s", (_label, members) => {
    const r = run(craftTar(members));
    expect(r.other).toBeUndefined();
    expect(r.refused).toMatch(/^backup archive refused: /);
    expect(r.files.every((f) => EXPECTED.includes(f))).toBe(true); // nothing but the expected names ever lands
  });
});

describe("REFUSED: a pax header outside its narrow skip", () => {
  const pax = (records: Record<string, string>): CraftedMember => ({ name: "PaxHeader/relay.db", typeflag: "x", data: paxBody(records) });
  it.each([
    ["a path record (would rename the next member)", [pax({ path: "../../x" }), ...three()]],
    ["a linkpath record", [pax({ linkpath: "/etc/hosts" }), ...three()]],
    ["a size record (would change the data's length)", [pax({ size: "1" }), ...three()]],
    ["a key outside the closed set", [pax({ "GNU.sparse.map": "0,1" }), ...three()]],
    ["a bare xattr prefix with no name", [pax({ "SCHILY.xattr.": "x" }), ...three()]],
    ["a malformed record length", [{ name: "PaxHeader/relay.db", typeflag: "x", data: "9 mtime=1\n" }, ...three()]],
    ["two pax headers in a row", [pax({ mtime: "1" }), pax({ mtime: "1" }), ...three()]],
    ["a pax header before an AppleDouble member", [pax({ mtime: "1" }), { name: "._relay.db", data: "x" }, ...three()]],
    ["a pax header over its cap", [{ name: "PaxHeader/relay.db", typeflag: "x", data: paxBody({ mtime: "1".repeat(MAX_SKIPPED_BYTES) }) }, ...three()]],
  ] as Array<[string, CraftedMember[]]>)("%s", (_label, members) => {
    const r = run(craftTar(members));
    expect(r.other).toBeUndefined();
    expect(r.refused).toMatch(/^backup archive refused: /);
    expect(r.files.every((f) => EXPECTED.includes(f))).toBe(true);
  });
  it("a pax header at the end, with no member after it", () => {
    expect(run(craftTar([...three(), pax({ mtime: "1" })])).refused).toMatch(/no member after it/);
  });
  it("known-good twin: the closed-set keys (mtime, atime, ctime, SCHILY.xattr.*, LIBARCHIVE.xattr.*) are skipped and reported", () => {
    const r = run(craftTar([pax({ mtime: "1.5", atime: "1", ctime: "1", "SCHILY.xattr.com.apple.provenance": "x", "LIBARCHIVE.xattr.com.apple.provenance": "eA" }), ...three()]));
    expect(r.result).toEqual({ extracted: EXPECTED, skipped: ["pax header for relay.db"] });
  });
});

describe("REFUSED: a header or a layout that is not a well-formed tar", () => {
  const archive = () => craftTar(three());
  it("a header checksum that does not match", () => expect(run(craftTar(three({ checksumDelta: 1 }))).refused).toMatch(/checksum does not match/));
  it("a size field that is neither octal nor base-256", () => expect(run(craftTar(three({ sizeField: Buffer.from("99999999999\0", "latin1") }))).refused).toMatch(/not octal/));
  it("a negative base-256 size", () => {
    const field = Buffer.alloc(12, 0xff);
    expect(run(craftTar(three({ sizeField: field }))).refused).toMatch(/negative base-256/);
  });
  it("non-zero data after the end-of-archive marker", () => expect(run(craftTar(three(), { trailing: Buffer.from("smuggled") })).refused).toMatch(/after the end-of-archive marker/));
  it("only one end-of-archive zero block", () => expect(run(craftTar(three(), { zeroBlocks: 1 })).refused).toMatch(/only one of the two/));
  it("no end-of-archive marker at all", () => expect(run(craftTar(three(), { zeroBlocks: 0 })).refused).toMatch(/no end-of-archive marker/));
  it("a partial header", () => expect(run(archive().subarray(0, 512 * 2 + 100)).refused).toMatch(/truncated/));
  it("a member's data cut short", () => expect(run(archive().subarray(0, 512 + 100)).refused).toMatch(/truncated/));
});

describe("the decompression bound: gunzipToFile", () => {
  it("a gzip bomb is refused at the cap, before staging fills (cap injected: 1 MiB; the default is MAX_DECOMPRESSED_BYTES)", async () => {
    const bomb = path.join(tmp, "bomb.gz");
    fs.writeFileSync(bomb, zlib.gzipSync(Buffer.alloc(8 * 1024 ** 2)));
    const dest = path.join(tmp, "bomb.tar");
    await expect(gunzipToFile(bomb, dest, 1024 ** 2)).rejects.toThrow(/more than 1048576 bytes decompressed/);
    expect(fs.existsSync(dest) ? fs.statSync(dest).size : 0).toBeLessThanOrEqual(1024 ** 2);
  });
  it("known-good twin: the same stream under a cap it fits in", async () => {
    const src = path.join(tmp, "fits.gz");
    fs.writeFileSync(src, zlib.gzipSync(Buffer.alloc(512 * 1024)));
    expect(await gunzipToFile(src, path.join(tmp, "fits.tar"), 1024 ** 2)).toBe(512 * 1024);
  });
  it("not gzip at all (a plain tar, or anything else) is refused", async () => {
    const src = path.join(tmp, "plain.tar.gz");
    fs.writeFileSync(src, craftTar(three()));
    await expect(gunzipToFile(src, path.join(tmp, "plain.out"))).rejects.toThrow(/not a gzip archive/);
  });
  it("a corrupt gzip stream is refused", async () => {
    const src = path.join(tmp, "corrupt.gz");
    fs.writeFileSync(src, gzip(craftTar(three())).subarray(0, 40));
    await expect(gunzipToFile(src, path.join(tmp, "corrupt.out"))).rejects.toThrow(/not a readable gzip stream/);
  });
});

// ---- end to end: export -> restore, and a crafted archive refused before ANY write outside staging ----------------

const ROOT = path.join(os.tmpdir(), `backup-archive-e2e-${process.pid}`);
const DB_PATH = path.join(ROOT, "relay.db");
describe("end to end (importRelayState / exportRelayState)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(async () => {
    saved = { RELAY_DB_PATH: process.env.RELAY_DB_PATH, RELAY_CONFIG_PATH: process.env.RELAY_CONFIG_PATH, RELAY_HTTP_PORT: process.env.RELAY_HTTP_PORT };
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true });
    process.env.RELAY_DB_PATH = DB_PATH;
    process.env.RELAY_CONFIG_PATH = path.join(ROOT, "config.json");
    process.env.RELAY_HTTP_PORT = "1";
    const { closeDb } = await import("../src/db.js");
    closeDb();
  });
  afterEach(async () => {
    const { closeDb } = await import("../src/db.js");
    closeDb();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it("the export holds EXACTLY the 3 plain ustar members (no pax, no AppleDouble: MEASURED per CI OS), and restores", async () => {
    const { registerAgent } = await import("../src/db.js");
    registerAgent("alpha", "r", []);
    fs.writeFileSync(path.join(ROOT, "config.json"), "{}");
    const { exportRelayState, importRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState(); // the default destination: <db dir>/backups
    const plain = path.join(ROOT, "out.tar");
    await gunzipToFile(exp.archive_path, plain);
    const dir = path.join(ROOT, "out");
    fs.mkdirSync(dir);
    expect(extractBackupTar(plain, dir)).toEqual({ extracted: EXPECTED, skipped: [] });
    const imp = await importRelayState(exp.archive_path, { force: true });
    expect(imp.restored).toBe(true);
    expect(imp.skipped_members).toEqual([]);
  });

  it("a crafted archive (a symlink named relay.db) is refused BEFORE the safety backup: no pre-restore archive, the live DB unchanged", async () => {
    const { registerAgent, closeDb } = await import("../src/db.js");
    registerAgent("alpha", "r", []);
    closeDb();
    const before = fs.readFileSync(DB_PATH);
    const crafted = path.join(ROOT, "crafted.tar.gz");
    fs.writeFileSync(crafted, gzip(craftTar(three({ typeflag: "2", linkname: DB_PATH, data: "" }))));
    const { importRelayState } = await import("../src/backup.js");
    await expect(importRelayState(crafted, { force: true })).rejects.toThrow(/backup archive refused/);
    const backups = path.join(ROOT, "backups");
    expect(fs.existsSync(backups) ? fs.readdirSync(backups).filter((f) => f.startsWith("pre-restore-")) : []).toEqual([]);
    expect(fs.readFileSync(DB_PATH)).toEqual(before);
  });
});
