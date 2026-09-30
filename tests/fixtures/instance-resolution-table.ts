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
import { checkContainment, type WalkSystem } from "../../src/approved-roots.js";

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
export interface PlacementRow {
  name: string;
  flavour: "win32" | "posix";
  fs: Record<string, "dir" | "file" | { link: string }>;
  input: string;
  expect: { realPath: string; exists: boolean } | { error: string };
}
export interface ResolutionTable {
  about: string;
  win32: string;
  placement_sim: { about: string; rows: PlacementRow[] };
  rows: ResolutionRow[];
}

export function loadResolutionTable(): ResolutionTable {
  return JSON.parse(fs.readFileSync(path.join(HERE, "instance-resolution-table.json"), "utf-8")) as ResolutionTable;
}

/**
 * A directory OUTSIDE every approved root, VERIFIED so: the containment check
 * itself must refuse a DB under it as "outside the approved roots". (A directory
 * inside the checkout is not enough: a checkout under /tmp puts it INSIDE the
 * roots.) It is never created; the rows only point into it (a DB path, a dangling
 * link's target). `candidates` is for the test of this choice.
 */
export function outsideDir(tag: string, candidates?: string[]): string {
  const tried = candidates ?? [
    path.join(path.parse(REPO_ROOT).root, `relay-fixture-outside-${tag}-${process.pid}`),
    path.join(path.parse(REPO_ROOT).root, "var", "empty", `relay-fixture-outside-${tag}-${process.pid}`),
  ];
  for (const d of tried) {
    if (fs.existsSync(d)) continue;
    const c = checkContainment(path.join(d, "relay.db"));
    if (!c.ok && c.reason.includes("outside the approved roots")) return d;
  }
  throw new Error(`no directory verified outside the approved roots (tried: ${tried.join(", ")})`);
}

/** The in-memory file system a placement_sim row describes, as the walk's WalkSystem. */
export function simulatedWalk(row: PlacementRow): WalkSystem {
  const P = row.flavour === "win32" ? path.win32 : path.posix;
  const absent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  const entry = (p: string) => {
    const e = row.fs[p];
    if (e === undefined) throw absent(p);
    return e;
  };
  return {
    path: P,
    lstat: (p) => {
      const e = entry(p);
      return { isSymbolicLink: () => typeof e === "object", uid: 0, mode: 0o40755 } as unknown as fs.Stats;
    },
    readlink: (p) => {
      const e = entry(p);
      if (typeof e !== "object") throw Object.assign(new Error(`EINVAL: ${p}`), { code: "EINVAL" });
      return e.link;
    },
    realpath: (p) => {
      entry(p);
      return p;
    },
  };
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
