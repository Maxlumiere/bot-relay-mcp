// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * STATIC SCAN: no test file and no hook names the OPERATOR's real paths. The private HOME
 * (tests/_setup/operator-tripwire.ts) removes the DEFAULT route to the operator's relay, but
 * not a HARDCODED one: a bash child running `sqlite3 /Users/<operator>/.bot-relay/...` would
 * read the live DB with nothing in its env to refuse. So this fails on any file under tests/
 * or hooks/ that contains:
 *   - the real home of the account running the suite (raw and realpath'd); on CI, the runner's;
 *   - the id of any instance under the operator's real relay root (read at run time).
 * Both are computed when the scan runs, so the scan names THIS machine's operator. It does NOT
 * flag fake paths in fixtures (`/Users/x/...`, a fake-fs `/home/alice/.bot-relay`) or
 * `$HOME/.bot-relay`, which resolves under the private HOME at run time.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { RAW_FS } from "./_setup/operator-tripwire-preload.mjs";
import { tripwireView } from "./_setup/operator-tripwire.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEXT = /\.(ts|mts|cts|js|mjs|cjs|sh|bash|json|jsonc|md|txt|ya?ml|plist|toml|env)$/i;

/** The strings that name this machine's operator: its real home, and its live instance ids. */
export function operatorNeedles(realHome: string, relayRoots: string[]): string[] {
  const needles = new Set<string>([realHome]);
  try {
    needles.add(fs.realpathSync.native(realHome));
  } catch {
    /* no realpath: the raw one stands */
  }
  for (const root of relayRoots) {
    try {
      for (const id of RAW_FS.readdirSync(path.join(root, "instances"))) if (id.length >= 8) needles.add(id);
    } catch {
      /* no instances under this root */
    }
  }
  return [...needles].filter((n) => n.length >= 8);
}

/** Every line that contains a needle, the needle not running on into a longer name. */
export function scanForNeedles(dirs: string[], needles: string[]): Array<{ file: string; line: number; needle: string }> {
  const hits: Array<{ file: string; line: number; needle: string }> = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== ".git") walk(full);
      } else if (e.isFile() && TEXT.test(e.name)) {
        const lines = fs.readFileSync(full, "utf-8").split("\n");
        lines.forEach((text, i) => {
          for (const n of needles) {
            let at = text.indexOf(n);
            while (at !== -1) {
              const next = text[at + n.length] ?? "";
              if (!/[A-Za-z0-9._-]/.test(next)) {
                hits.push({ file: full, line: i + 1, needle: n });
                break;
              }
              at = text.indexOf(n, at + 1);
            }
          }
        });
      }
    }
  };
  for (const d of dirs) walk(d);
  return hits;
}

describe("the scanner (synthetic files)", () => {
  it("finds a planted operator home and a planted live instance id; ignores a longer name, a fake path and $HOME", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-scan-"));
    try {
      const home = "/Users/opsuser";
      const id = "0f0e0d0c-1111-4222-8333-444455556666";
      fs.writeFileSync(path.join(dir, "a.test.ts"), `const p = "${home}/.bot-relay/relay.db";\n`);
      fs.writeFileSync(path.join(dir, "b.sh"), `sqlite3 "$HOME/.bot-relay/instances/${id}/relay.db"\n`);
      fs.writeFileSync(path.join(dir, "c.json"), `{"x": "${home}x/notes", "y": "/Users/x/.bot-relay", "z": "$HOME/.bot-relay"}\n`);
      fs.writeFileSync(path.join(dir, "d.bin"), `${home}/.bot-relay`); // not a scanned type
      const hits = scanForNeedles([dir], [home, id]).map((h) => `${path.basename(h.file)}:${h.line}:${h.needle}`);
      expect(hits.sort()).toEqual([`a.test.ts:1:${home}`, `b.sh:1:${id}`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the needles (what names THIS operator)", () => {
  it("are the real home and EVERY instance id under each relay root", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "op-needles-")));
    try {
      const home = path.join(dir, "home-of-operator");
      const root = path.join(home, ".bot-relay");
      const ids = ["11111111-2222-4333-8444-555555555555", "my-named-instance"];
      for (const id of ids) fs.mkdirSync(path.join(root, "instances", id), { recursive: true });
      expect(operatorNeedles(home, [root]).sort()).toEqual([home, ...ids].sort());
      expect(operatorNeedles(home, [path.join(dir, "no-such-root")])).toEqual([home]); // no instances: the home alone
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tests/ and hooks/ name no operator path", () => {
  it("no file contains this machine's real home or a live instance id", () => {
    const { realHome, roots } = tripwireView();
    const needles = operatorNeedles(realHome, roots);
    expect(needles.length).toBeGreaterThan(0); // precondition: at least the real home is searched for
    const hits = scanForNeedles([path.join(REPO, "tests"), path.join(REPO, "hooks")], needles);
    expect(hits.map((h) => `${path.relative(REPO, h.file)}:${h.line} names ${h.needle}`)).toEqual([]);
  });
});
