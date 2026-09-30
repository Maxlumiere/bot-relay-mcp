#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0047 — stamp a build: the last step of `npm run build`, after tsc.
 *
 *   node scripts/write-build-info.mjs [INSTALL_DIR]   (default: this repo)
 *
 * Writes dist/build-info.js as EXACTLY renderStamp({ build_id, commit, dirty,
 * built_at }) (dist/build-id.js, the same code a render-time check uses), where
 * build_id is the CODE ID of INSTALL_DIR: package.json and dist/**, the stamp
 * entering as a constant. The dependencies are not stamped: each process
 * computes their id at load (src/loaded-build.ts), because a registry install
 * resolves them after this build.
 *
 * The placeholder's source map (tsc emitted it) and any leftover from an older
 * stamping scheme are removed first, so they are not hashed. The stamp is written
 * to a temp file and renamed: a reader never sees half a stamp. Git is only asked
 * for the human fields; outside a checkout they are null.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// The compiled code of THIS repo's build (tsc ran just before).
import { computeCodeId, renderStamp } from "../dist/build-id.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const install = path.resolve(process.argv[2] ?? path.join(HERE, ".."));
const dist = path.join(install, "dist");

fs.rmSync(path.join(dist, "build-info.js.map"), { force: true });
fs.rmSync(path.join(dist, ".build-lock"), { force: true });

const id = computeCodeId(install);
if (!id.ok) {
  process.stderr.write(`write-build-info: cannot hash ${install}: ${id.reason}\n`);
  process.exit(1);
}

const git = (...args) => {
  const r = spawnSync("git", args, { cwd: install, encoding: "utf-8" });
  return r.status === 0 ? r.stdout : null;
};
const head = git("rev-parse", "HEAD");
const commit = head && /^[0-9a-f]{40}$/.test(head.trim()) ? head.trim() : null;
const status = commit ? git("status", "--porcelain") : null;
const info = { build_id: id.id, commit, dirty: status === null ? null : status.trim() !== "", built_at: new Date().toISOString() };

const target = path.join(dist, "build-info.js");
const tmp = path.join(install, `.build-info.${process.pid}.tmp`);
fs.writeFileSync(tmp, renderStamp(info));
fs.renameSync(tmp, target);
process.stdout.write(`build-info: ${id.id.slice(0, 12)} (${commit ? commit.slice(0, 7) : "no commit"}${info.dirty ? "+dirty" : ""})\n`);
