// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * RED STAND-IN (replaced by the fix commit): TODAY's restore behaviour behind the API the in-process reader will
 * have. Today restore runs `tar -xzf` into staging: tar decides what lands, nothing bounds the decompressed size, and
 * nothing is reported as skipped. No production code imports this module.
 */
import fs from "fs";
import zlib from "zlib";
import { pipeline } from "stream/promises";
import { spawnSystem } from "./system-binary.js";

export const EXPECTED_MEMBERS = ["relay.db", "manifest.json", "config.json"] as const;
export type ExpectedMember = (typeof EXPECTED_MEMBERS)[number];
export const MAX_DECOMPRESSED_BYTES = 4 * 1024 ** 3;
export const MAX_MEMBER_BYTES: Readonly<Record<ExpectedMember, number>> = { "relay.db": MAX_DECOMPRESSED_BYTES, "manifest.json": 1024 ** 2, "config.json": 1024 ** 2 };
export const MAX_SKIPPED_BYTES = 64 * 1024;

export class ArchiveRefused extends Error {
  constructor(message: string) {
    super(`backup archive refused: ${message}`);
    this.name = "ArchiveRefused";
  }
}

/** Today: no cap, no gzip check (tar -z decompressed whatever it was given). */
export async function gunzipToFile(src: string, dest: string, _cap: number = MAX_DECOMPRESSED_BYTES): Promise<number> {
  await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(dest, { flags: "wx", mode: 0o600 }));
  return fs.statSync(dest).size;
}

export interface ExtractResult {
  extracted: ExpectedMember[];
  skipped: string[];
}

/** Today: tar extracts whatever the archive holds into the directory. */
export function extractBackupTar(tarPath: string, outDir: string): ExtractResult {
  const r = spawnSystem("tar", ["-xf", tarPath, "-C", outDir], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`tar -xf failed (status=${r.status}): ${(r.stderr ?? "").trim()}`);
  const present = fs.readdirSync(outDir);
  return { extracted: EXPECTED_MEMBERS.filter((m) => present.includes(m)), skipped: [] };
}
