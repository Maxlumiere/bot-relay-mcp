// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 8 M7: the harness's ISOLATION check, read-only (no filesystem write: vitest.m7.config.ts evaluates it
 * at load, BEFORE any setup file or global setup creates a temp dir, and the test re-does it first).
 *
 * The real home comes from the passwd entry (os.userInfo().homedir), never $HOME; both sides are canonicalised
 * (the nearest existing ancestor through realpath.native, the missing tail re-appended). The temp root (TMPDIR /
 * os.tmpdir()) and any sandbox root must resolve OUTSIDE it. M7_TEST_EXTRA_HOME names one MORE home to stay outside
 * of (a test seam: it can only add a refusal, never remove one).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function canon(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
      cur = up;
    }
  }
}
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** The homes the harness must stay outside of: the passwd home, plus the test seam's extra one. */
export function protectedHomes(env = process.env) {
  const homes = [canon(os.userInfo().homedir)];
  if (env.M7_TEST_EXTRA_HOME) homes.push(canon(env.M7_TEST_EXTRA_HOME));
  return homes;
}

/** null when isolated; otherwise WHY not (a role, no path). */
export function isolationFault(env = process.env, roots = []) {
  const tmp = env.TMPDIR && env.TMPDIR !== "" ? env.TMPDIR : os.tmpdir();
  const homes = protectedHomes(env);
  for (const [role, p] of [["the temp root", tmp], ...roots]) {
    const c = canon(p);
    if (homes.some((h) => inside(c, h))) return `${role} resolves inside the real user's home`;
  }
  return null;
}
