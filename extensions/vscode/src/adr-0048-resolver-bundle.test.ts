// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// ADR-0048 PR D — the bundle-input ALLOWLIST. Tether bundles the relay's ONE
// instance resolver instead of a copy of it. That is only safe while the bundle
// pulls in the resolver and nothing else of the relay: no logger (the extension
// host must never write relay logs), no DB layer, no native module. This reads
// the esbuild metafile (what actually went into out/extension.js) and fails on
// any other input from the relay's src/.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const META = path.join(EXT_ROOT, "out", "extension.meta.json");

/** The ONLY relay sources the bundle may contain (paths relative to extensions/vscode). */
const ALLOWED_RELAY_INPUTS = ["../../src/approved-roots.ts", "../../src/resolve-instance.ts"];

describe("ADR-0048 PR D — the Tether bundle carries the relay's resolver and nothing else of the relay", () => {
  const meta = JSON.parse(fs.readFileSync(META, "utf-8")) as { inputs: Record<string, unknown> };
  const inputs = Object.keys(meta.inputs);
  const relayInputs = inputs.filter((p) => !p.startsWith("src/") && !p.includes("node_modules/")).sort();

  it("the relay inputs are EXACTLY the resolver module and the approved-roots predicate", () => {
    expect(relayInputs).toEqual(ALLOWED_RELAY_INPUTS);
  });
  it("no logger, DB layer, SQLite driver or native module was pulled in", () => {
    const forbidden = inputs.filter((p) => /(^|\/)(logger|db|sqlite-compat)\.ts$|better-sqlite3|sql\.js|\.node$/.test(p));
    expect(forbidden).toEqual([]);
  });
});
