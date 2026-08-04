// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Packaged-doc reference guard (Steph review, #116 codex patch).
 *
 * Removing `architecture.md` from `package.json` `files[]` left a DANGLING
 * pointer: the still-shipped `docs/transport-architecture.md` "Related docs"
 * list referenced `architecture.md`, which an `npm install` consumer no longer
 * receives — the link goes nowhere in the published tarball.
 *
 * This guard fails CI whenever a PACKAGED doc references a repo doc that is
 * NOT itself packaged. It scans every shipped `.md` (per `files[]`) EXCEPT
 * `CHANGELOG.md` — a changelog legitimately names files that were later
 * removed, as history (victra: historical CHANGELOG mentions stay as-is).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES: string[] = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).files;

/** A repo-relative path ships if it equals a files[] entry or sits under a dir entry. */
function isPackaged(rel: string): boolean {
  const norm = rel.replace(/^\.\//, "").replace(/^\/+/, "");
  return FILES.some((f) => norm === f || norm.startsWith(f + "/"));
}

/** Every shipped .md file (recursively), minus CHANGELOG.md (history is exempt). */
function shippedMarkdown(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(abs)) walk(path.posix.join(rel, e));
    } else if (rel.endsWith(".md") && rel !== "CHANGELOG.md" && isPackaged(rel)) {
      out.push(rel);
    }
  };
  for (const f of FILES) walk(f);
  return out;
}

/**
 * Extract every `.md` reference that is a real clickable POINTER — a markdown
 * link `[text](x.md)`. Backtick prose mentions (`` `CLAUDE.md` `` = "paste into
 * your own CLAUDE.md") are deliberately excluded: they name a file
 * conceptually, they aren't a dead pointer an npm consumer would click.
 */
function mdRefs(content: string): string[] {
  const refs = new Set<string>();
  // (a) markdown links [text](x.md)
  for (const m of content.matchAll(/\]\(([^)]+?\.md)(?:#[^)]*)?\)/g)) refs.add(m[1]);
  // (b) "Related docs"/"See also" list-item pointers — a list item that LEADS
  //     with a backtick'd .md, e.g. "- `architecture.md` — full spec" (the exact
  //     shape of the removed-from-package dangling pointer this guard regresses).
  //     Inline conceptual backticks ("paste into `CLAUDE.md`") are NOT list-leading
  //     and stay excluded.
  for (const m of content.matchAll(/^\s*[-*]\s+`([\w./-]+?\.md)`/gm)) refs.add(m[1]);
  return [...refs];
}

describe("packaged-doc reference guard", () => {
  it("no shipped doc points at a repo doc that is excluded from the npm package", () => {
    const violations: string[] = [];
    for (const doc of shippedMarkdown()) {
      const content = fs.readFileSync(path.join(ROOT, doc), "utf-8");
      for (const ref of mdRefs(content)) {
        if (/^https?:\/\//.test(ref)) continue; // external URL — not a tarball file
        // Resolve against the doc's own dir, then against repo root (the repo
        // mixes both conventions). Only a ref that names a REAL repo file counts.
        const candidates = [
          path.posix.normalize(path.posix.join(path.posix.dirname(doc), ref.replace(/^\.\//, ""))),
          ref.replace(/^\.\//, ""),
        ];
        const hit = candidates.find((c) => !c.startsWith("..") && fs.existsSync(path.join(ROOT, c)));
        if (hit && !isPackaged(hit)) {
          violations.push(`${doc} → "${ref}" (repo file ${hit} is NOT in package.json files[])`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `${violations.length} shipped doc(s) reference a repo file excluded from the npm package ` +
          `(an npm consumer gets a dead pointer). Either package the target (add to files[]) or ` +
          `drop/rewrite the reference:\n  ` + violations.join("\n  "),
      );
    }
  });
});
