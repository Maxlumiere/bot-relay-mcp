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
 * 1. dist/.build-lock  = the sha256 of INSTALL_DIR/package-lock.json ("none" when
 *    there is none), so the lock is part of the content that is hashed;
 * 2. dist/build-info.js = { build_id: the content hash of dist/ (dist/build-id.js,
 *    the same code a render-time check recomputes with), commit, dirty, built_at }.
 *
 * The stamp replaces the placeholder tsc emitted (and its now-meaningless source
 * map). It is written to a temp file and renamed, so a reader never sees half a
 * stamp. Git is only asked for the human fields; outside a checkout they are null.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// The compiled hasher of THIS repo's build (tsc ran just before): the same code a
// render-time check recomputes with.
import { computeBuildId, lockDigest } from "../dist/build-id.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const install = path.resolve(process.argv[2] ?? path.join(HERE, ".."));
const dist = path.join(install, "dist");

fs.writeFileSync(path.join(dist, ".build-lock"), `${lockDigest(install) ?? "none"}\n`);
fs.rmSync(path.join(dist, "build-info.js.map"), { force: true });

const id = computeBuildId(dist);
if (!id.ok) {
  process.stderr.write(`write-build-info: cannot hash ${dist}: ${id.reason}\n`);
  process.exit(1);
}

const git = (...args) => {
  const r = spawnSync("git", args, { cwd: install, encoding: "utf-8" });
  return r.status === 0 ? r.stdout : null;
};
const head = git("rev-parse", "HEAD");
const commit = head && /^[0-9a-f]{40}$/.test(head.trim()) ? head.trim() : null;
const status = commit ? git("status", "--porcelain") : null;
const info = { build_id: id.build_id, commit, dirty: status === null ? null : status.trim() !== "", built_at: new Date().toISOString() };

const target = path.join(dist, "build-info.js");
const tmp = `${target}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `export const BUILD_INFO = Object.freeze(${JSON.stringify(info)});\n`);
fs.renameSync(tmp, target);
process.stdout.write(`build-info: ${id.build_id.slice(0, 12)} (${commit ? commit.slice(0, 7) : "no commit"}${info.dirty ? "+dirty" : ""})\n`);
