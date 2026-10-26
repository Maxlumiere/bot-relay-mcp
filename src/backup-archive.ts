// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * RESTORE reads a backup archive IN-PROCESS: ONE parser that both decides what the archive holds and extracts it
 * (SEC-22; ruled 26 Oct inside the 21 Oct clause "restore accepts ONLY the expected regular-file members"). No tar
 * subprocess runs on restore: a check in one parser followed by extraction in another (tar) is a parser differential
 * (a pax `path=` record renames the next member for tar; a ustar `prefix` lengthens it; GNU tar execs a filter for a
 * compressed member), and tar would obey whatever the check missed.
 *
 * WHAT LANDS: only relay.db, manifest.json and config.json, each written as a FRESH file (O_EXCL, 0600) in the
 * caller's private staging directory. Nothing else is ever written.
 *
 * WHAT IS SKIPPED (never extracted, never parsed for meaning, and REPORTED): what macOS tar has always added to every
 * backup made from files carrying an extended attribute (MEASURED 26 Oct: com.apple.provenance on every node-written
 * file), namely
 *   - an AppleDouble `._<expected name>` regular member, at most once per expected name, at most 64 KiB;
 *   - a pax extended header (typeflag `x`) whose records use ONLY the closed key set (mtime, atime, ctime,
 *     SCHILY.xattr.*, LIBARCHIVE.xattr.*), immediately followed by an expected member. Its records are parsed only to
 *     check their keys; their values are ignored.
 *
 * WHAT IS REFUSED (an ArchiveRefused naming why, before the caller writes anything outside staging): not gzip; more
 * than MAX_DECOMPRESSED_BYTES decompressed (a gzip bomb stops there); a header whose checksum does not match; a magic
 * other than POSIX ustar ("ustar\0" "00") or GNU ("ustar  \0"); any typeflag other than a regular file or the pax
 * header above (links, directories, devices, FIFOs, GNU long names L/K, global pax `g`, sparse files ...); a non-empty
 * POSIX ustar prefix; any other name; a duplicate; a member over its size cap; a size field that is neither octal nor
 * positive base-256; a pax record outside the closed set (path, linkpath, size ...) or malformed; a truncated archive;
 * an archive without its two end-of-archive zero blocks; and any non-zero byte after them (zero bytes there are the
 * tar record padding, skipped).
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { pipeline } from "stream/promises";
import { Transform } from "stream";

export const EXPECTED_MEMBERS = ["relay.db", "manifest.json", "config.json"] as const;
export type ExpectedMember = (typeof EXPECTED_MEMBERS)[number];

/**
 * The decompressed-size cap: 4 GiB. Its source: about 20 times the largest live relay DB MEASURED (179 MB, 26 Oct),
 * and below ustar's 8 GiB octal member limit. A larger archive is refused with this number in the message.
 */
export const MAX_DECOMPRESSED_BYTES = 4 * 1024 ** 3;
/** Per-member caps. relay.db is bounded by the archive cap; the JSON files are small by construction. */
export const MAX_MEMBER_BYTES: Readonly<Record<ExpectedMember, number>> = { "relay.db": MAX_DECOMPRESSED_BYTES, "manifest.json": 1024 ** 2, "config.json": 1024 ** 2 };
/** The cap for a skipped member (an AppleDouble file or a pax header): MEASURED 163 and 136 bytes on macOS. */
export const MAX_SKIPPED_BYTES = 64 * 1024;

const PAX_KEYS = new Set(["mtime", "atime", "ctime"]);
const PAX_KEY_PREFIXES = ["SCHILY.xattr.", "LIBARCHIVE.xattr."];

export class ArchiveRefused extends Error {
  constructor(message: string) {
    super(`backup archive refused: ${message}`);
    this.name = "ArchiveRefused";
  }
}

/**
 * Decompress `src` (gzip) into `dest` (a new file), refusing past `cap` decompressed bytes. Streams: the archive is
 * never held in memory. Returns the decompressed size.
 */
export async function gunzipToFile(src: string, dest: string, cap: number = MAX_DECOMPRESSED_BYTES): Promise<number> {
  const fd = fs.openSync(src, "r");
  try {
    const magic = Buffer.alloc(2);
    if (fs.readSync(fd, magic, 0, 2, 0) !== 2 || magic[0] !== 0x1f || magic[1] !== 0x8b) throw new ArchiveRefused("not a gzip archive");
  } finally {
    fs.closeSync(fd);
  }
  let total = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      total += chunk.length;
      if (total > cap) return done(new ArchiveRefused(`more than ${cap} bytes decompressed (the cap: MAX_DECOMPRESSED_BYTES)`));
      done(null, chunk);
    },
  });
  try {
    await pipeline(fs.createReadStream(src), zlib.createGunzip(), counter, fs.createWriteStream(dest, { flags: "wx", mode: 0o600 }));
  } catch (err) {
    if (err instanceof ArchiveRefused) throw err;
    throw new ArchiveRefused(`not a readable gzip stream (${(err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message})`);
  }
  return total;
}

/** A parsed member header. */
interface Header {
  name: string;
  typeflag: string;
  size: number;
}

function parseSize(field: Buffer, at: number): number {
  if (field[0] & 0x80) {
    if (field[0] === 0xff) throw new ArchiveRefused(`member at ${at}: a negative base-256 size`);
    let v = BigInt(field[0] & 0x7f);
    for (let i = 1; i < field.length; i++) v = (v << 8n) | BigInt(field[i]);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ArchiveRefused(`member at ${at}: a base-256 size too large`);
    return Number(v);
  }
  const text = field.toString("latin1").replace(/[\0 ]+$/, "").replace(/^ +/, "");
  if (!/^[0-7]*$/.test(text)) throw new ArchiveRefused(`member at ${at}: a size field that is not octal (${JSON.stringify(text)})`);
  return text === "" ? 0 : parseInt(text, 8);
}

function parseHeader(h: Buffer, at: number): Header {
  // The checksum: the header's bytes summed with the checksum field read as spaces; unsigned (POSIX) or signed (old tars).
  const storedText = h.subarray(148, 156).toString("latin1").replace(/[\0 ]+$/, "").replace(/^ +/, "");
  if (!/^[0-7]+$/.test(storedText)) throw new ArchiveRefused(`member at ${at}: a malformed header checksum`);
  const stored = parseInt(storedText, 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < 512; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : h[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  if (stored !== unsigned && stored !== signed) throw new ArchiveRefused(`member at ${at}: the header checksum does not match`);
  const magic = h.subarray(257, 265).toString("latin1");
  const posix = magic === "ustar\u000000";
  const gnu = magic === "ustar  \u0000";
  if (!posix && !gnu) throw new ArchiveRefused(`member at ${at}: not a ustar header (magic ${JSON.stringify(magic)})`);
  if (posix && h.subarray(345, 500).some((b) => b !== 0)) throw new ArchiveRefused(`member at ${at}: a ustar name prefix (only the three flat member names are accepted)`);
  const nul = h.indexOf(0, 0);
  const name = h.subarray(0, nul >= 0 && nul < 100 ? nul : 100).toString("latin1");
  const typeflag = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
  return { name, typeflag, size: parseSize(h.subarray(124, 136), at) };
}

/** Check a pax extended header's records: every key in the closed set, every record well-formed. Values are ignored. */
function checkPaxRecords(body: Buffer, at: number): void {
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    const lenText = sp > i ? body.subarray(i, sp).toString("latin1") : "";
    if (!/^[1-9][0-9]*$/.test(lenText)) throw new ArchiveRefused(`pax header at ${at}: a malformed record length`);
    const len = parseInt(lenText, 10);
    const end = i + len;
    if (end > body.length || body[end - 1] !== 0x0a) throw new ArchiveRefused(`pax header at ${at}: a malformed record`);
    const record = body.subarray(sp + 1, end - 1);
    const eq = record.indexOf(0x3d);
    if (eq <= 0) throw new ArchiveRefused(`pax header at ${at}: a record without a key`);
    const key = record.subarray(0, eq).toString("utf-8");
    if (!PAX_KEYS.has(key) && !PAX_KEY_PREFIXES.some((p) => key.startsWith(p) && key.length > p.length)) {
      throw new ArchiveRefused(`pax header at ${at}: the key ${JSON.stringify(key)} is not accepted (only mtime, atime, ctime and xattr keys)`);
    }
    i = end;
  }
}

function readExactly(fd: number, length: number, position: number, what: string): Buffer {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position + got);
    if (n === 0) throw new ArchiveRefused(`truncated (${what})`);
    got += n;
  }
  return buf;
}

export interface ExtractResult {
  /** The expected members written to the output directory. */
  extracted: ExpectedMember[];
  /** What was skipped, by name ("._relay.db", "pax header for relay.db"), in archive order. */
  skipped: string[];
}

/**
 * Parse the PLAIN (decompressed) tar at `tarPath` and write its expected members into `outDir` (a private directory
 * the caller created). Throws ArchiveRefused on anything outside the contract above; a refusal can leave partial
 * files in `outDir`, which the caller removes with it.
 */
export function extractBackupTar(tarPath: string, outDir: string): ExtractResult {
  const fd = fs.openSync(tarPath, "r");
  const extracted: ExpectedMember[] = [];
  const skipped: string[] = [];
  const appleDoubleSeen = new Set<string>();
  try {
    const total = fs.fstatSync(fd).size;
    let at = 0;
    let paxPending = false;
    for (;;) {
      if (at + 512 > total) throw new ArchiveRefused(at === total ? "truncated (no end-of-archive marker)" : "truncated (a partial header)");
      const h = readExactly(fd, 512, at, "a header");
      if (h.every((b) => b === 0)) {
        if (paxPending) throw new ArchiveRefused(`a pax header at the end of the archive, with no member after it`);
        if (at + 1024 > total || !readExactly(fd, 512, at + 512, "the end-of-archive marker").every((b) => b === 0)) {
          throw new ArchiveRefused("truncated (only one of the two end-of-archive zero blocks)");
        }
        // Everything after the two zero blocks must be zero: the tar record padding.
        const chunk = Buffer.alloc(64 * 1024);
        for (let pos = at + 1024; pos < total; ) {
          const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, total - pos), pos);
          if (n === 0) break;
          if (chunk.subarray(0, n).some((b) => b !== 0)) throw new ArchiveRefused("data after the end-of-archive marker");
          pos += n;
        }
        return { extracted, skipped };
      }
      const hdr = parseHeader(h, at);
      const dataAt = at + 512;
      const next = dataAt + Math.ceil(hdr.size / 512) * 512;
      if (dataAt + hdr.size > total) throw new ArchiveRefused(`truncated (the data of ${JSON.stringify(hdr.name)})`);

      if (hdr.typeflag === "x") {
        if (paxPending) throw new ArchiveRefused(`member at ${at}: two pax headers in a row`);
        if (hdr.size > MAX_SKIPPED_BYTES) throw new ArchiveRefused(`pax header at ${at}: larger than ${MAX_SKIPPED_BYTES} bytes`);
        checkPaxRecords(readExactly(fd, hdr.size, dataAt, "a pax header"), at);
        paxPending = true;
        at = next;
        continue;
      }
      if (hdr.typeflag !== "0") throw new ArchiveRefused(`member ${JSON.stringify(hdr.name)} at ${at}: typeflag ${JSON.stringify(hdr.typeflag)} is not a regular file`);

      const appleDoubleOf = hdr.name.startsWith("._") ? hdr.name.slice(2) : null;
      if (appleDoubleOf !== null && (EXPECTED_MEMBERS as readonly string[]).includes(appleDoubleOf)) {
        if (paxPending) throw new ArchiveRefused(`member at ${at}: a pax header before an AppleDouble member`);
        if (appleDoubleSeen.has(hdr.name)) throw new ArchiveRefused(`member ${JSON.stringify(hdr.name)} at ${at}: a duplicate`);
        if (hdr.size > MAX_SKIPPED_BYTES) throw new ArchiveRefused(`member ${JSON.stringify(hdr.name)} at ${at}: larger than ${MAX_SKIPPED_BYTES} bytes`);
        appleDoubleSeen.add(hdr.name);
        skipped.push(hdr.name);
        at = next;
        continue;
      }
      if (!(EXPECTED_MEMBERS as readonly string[]).includes(hdr.name)) throw new ArchiveRefused(`member ${JSON.stringify(hdr.name)} at ${at}: not one of ${EXPECTED_MEMBERS.join(", ")}`);
      const name = hdr.name as ExpectedMember;
      if (extracted.includes(name)) throw new ArchiveRefused(`member ${JSON.stringify(name)} at ${at}: a duplicate`);
      if (hdr.size > MAX_MEMBER_BYTES[name]) throw new ArchiveRefused(`member ${JSON.stringify(name)} at ${at}: larger than its ${MAX_MEMBER_BYTES[name]}-byte cap`);
      if (paxPending) skipped.push(`pax header for ${name}`);
      paxPending = false;

      const out = fs.openSync(path.join(outDir, name), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      try {
        const buf = Buffer.alloc(1024 * 1024);
        for (let done = 0; done < hdr.size; ) {
          const want = Math.min(buf.length, hdr.size - done);
          const n = fs.readSync(fd, buf, 0, want, dataAt + done);
          if (n === 0) throw new ArchiveRefused(`truncated (the data of ${JSON.stringify(name)})`);
          fs.writeSync(out, buf, 0, n);
          done += n;
        }
      } finally {
        fs.closeSync(out);
      }
      extracted.push(name);
      at = next;
    }
  } finally {
    fs.closeSync(fd);
  }
}
