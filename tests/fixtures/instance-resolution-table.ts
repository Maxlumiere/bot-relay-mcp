// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0048 PR D — the loader for the SHARED resolver state table
 * (instance-resolution-table.json). The relay's test and Tether's test both use
 * it, so a row means the same thing on both sides: the same temporary layout,
 * the same environment, the same expectation.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

export type LayoutOp = { mkdir: string } | { file: string; content: string } | { symlink: string; to: string };
export interface ResolutionRow {
  name: string;
  platform: "posix" | "all";
  containment: "strict" | "n/a";
  layout: LayoutOp[];
  env: Record<string, string>;
  expect: { kind: "flat" | "instance" | "explicit-db"; db: string; exists: boolean } | { kind: "error"; reason: string };
}
export interface ResolutionTable {
  about: string;
  win32: string;
  rows: ResolutionRow[];
}

export function loadResolutionTable(): ResolutionTable {
  return JSON.parse(fs.readFileSync(path.join(HERE, "instance-resolution-table.json"), "utf-8")) as ResolutionTable;
}

/** A directory OUTSIDE every approved root (the repo's gitignored cache; never under /tmp or the row's home). */
export function outsideDir(tag: string): string {
  const d = path.join(REPO_ROOT, "node_modules", ".cache", `resolution-table-${tag}-${process.pid}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Does this row run on the current platform? (Windows rows are explicitly unsupported: see the table's `win32`.) */
export function rowApplies(row: ResolutionRow): boolean {
  if (process.platform === "win32") return false;
  return row.platform === "all" || row.platform === "posix";
}

/** Build the row's layout under `home` and return its environment (placeholders filled, HOME set). */
export function applyRow(row: ResolutionRow, home: string, outside: string): Record<string, string> {
  const fill = (s: string) => s.split("${HOME}").join(home).split("${OUTSIDE}").join(outside);
  for (const op of row.layout) {
    if ("mkdir" in op) fs.mkdirSync(path.join(home, op.mkdir), { recursive: true });
    else if ("file" in op) {
      fs.mkdirSync(path.dirname(path.join(home, op.file)), { recursive: true });
      fs.writeFileSync(path.join(home, op.file), op.content);
    } else {
      fs.mkdirSync(path.dirname(path.join(home, op.symlink)), { recursive: true });
      fs.symlinkSync(fill(op.to), path.join(home, op.symlink));
    }
  }
  const env: Record<string, string> = { HOME: home };
  for (const [k, v] of Object.entries(row.env)) env[k] = fill(v);
  return env;
}

/** The expected DB path for a path-bearing row. */
export function expectedDb(row: ResolutionRow, home: string): string | null {
  return row.expect.kind === "error" ? null : row.expect.db.split("${HOME}").join(home);
}
