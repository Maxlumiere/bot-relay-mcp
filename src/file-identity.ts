// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * FILE IDENTITY, exact (#418 verify): (dev, ino) as BigInts, from a `{ bigint: true }` stat. Node's numeric ino is a
 * double, and a real inode or NTFS file id can exceed 2^53 (e.g. 1152921500312607377, pinned in
 * tests/adr-0048-deploy-gate.test.ts), so two different files can round to the same number: every identity compare in
 * src/ goes through here (tests/file-identity-bigint.test.ts refuses a numeric `.ino` read structurally).
 */
import type fs from "fs";

export interface FileIdentity {
  dev: bigint;
  ino: bigint;
}
export const fileIdentityOf = (st: fs.BigIntStats): FileIdentity => ({ dev: st.dev, ino: st.ino });
export const sameFileIdentity = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino;
export const fileIdentityKey = (s: FileIdentity): string => `${s.dev}:${s.ino}`;
