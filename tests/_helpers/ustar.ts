// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A tiny tar WRITER for crafted archives in tests: each member's header fields can be set to what a hostile or
 * unusual archive holds (a typeflag, a magic, a prefix, a raw size field, a wrong checksum). Never used by src/.
 */
import zlib from "zlib";

export interface CraftedMember {
  name: string;
  data?: Buffer | string;
  /** Default "0" (a regular file). */
  typeflag?: string;
  /** Default POSIX ustar ("ustar\0" + "00"). */
  magic?: "posix" | "gnu" | "none";
  /** The ustar prefix field (offset 345). */
  prefix?: string;
  linkname?: string;
  /** A raw 12-byte size field, replacing the octal one (e.g. base-256, or garbage). */
  sizeField?: Buffer;
  /** Added to the computed checksum (a non-zero value makes it wrong). */
  checksumDelta?: number;
}

function put(h: Buffer, at: number, len: number, s: string): void {
  h.write(s.slice(0, len), at, "latin1");
}

export function ustarHeader(m: CraftedMember, size: number): Buffer {
  const h = Buffer.alloc(512);
  put(h, 0, 100, m.name);
  put(h, 100, 8, "0000600\0");
  put(h, 108, 8, "0000000\0");
  put(h, 116, 8, "0000000\0");
  if (m.sizeField) m.sizeField.copy(h, 124, 0, 12);
  else put(h, 124, 12, size.toString(8).padStart(11, "0") + "\0");
  put(h, 136, 12, "15047000000\0");
  h.write(m.typeflag ?? "0", 156, "latin1");
  if (m.linkname) put(h, 157, 100, m.linkname);
  const magic = m.magic ?? "posix";
  if (magic === "posix") put(h, 257, 8, "ustar\u000000");
  if (magic === "gnu") put(h, 257, 8, "ustar  \u0000");
  if (m.prefix) put(h, 345, 155, m.prefix);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  put(h, 148, 8, (sum + (m.checksumDelta ?? 0)).toString(8).padStart(6, "0") + "\0 ");
  return h;
}

/** A plain tar: each member's header and data (padded to 512), then `zeroBlocks` zero blocks, then `trailing`. */
export function craftTar(members: CraftedMember[], opts: { zeroBlocks?: number; trailing?: Buffer } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const m of members) {
    const data = Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data ?? "", "utf-8");
    parts.push(ustarHeader(m, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(512 * (opts.zeroBlocks ?? 2)));
  if (opts.trailing) parts.push(opts.trailing);
  return Buffer.concat(parts);
}

/** A pax extended-header body from records. */
export function paxBody(records: Record<string, string>): Buffer {
  let out = "";
  for (const [k, v] of Object.entries(records)) {
    const tail = ` ${k}=${v}\n`;
    let len = tail.length + 1;
    while (String(len).length + tail.length !== len) len = String(len).length + tail.length;
    out += `${len}${tail}`;
  }
  return Buffer.from(out, "utf-8");
}

export const gzip = (b: Buffer): Buffer => zlib.gzipSync(b);
