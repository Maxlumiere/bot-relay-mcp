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
/** EVERY file is scanned (Codex #305 R1 P2 #14: an extension allowlist skipped .sql and extensionless
 * scripts); only a file with a NUL byte in its first 8 KiB is skipped, as binary. */
function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}
/** A needle starts and ends at a path boundary: not inside a longer name on either side. */
const NAME_CHAR = /[A-Za-z0-9._~-]/;

/** The strings that name this machine's operator: its real home, and its live instance ids. */
export function operatorNeedles(realHome: string, relayRoots: string[]): string[] {
  const needles = new Set<string>([realHome]);
  try {
    needles.add(fs.realpathSync.native(realHome));
  } catch {
    /* no realpath: the raw one stands */
  }
  // The home is a needle at ANY length: the root account's home is 5 characters, and the boundary check
  // on both sides keeps it from matching a longer name that contains it.
  for (const root of relayRoots) {
    try {
      // An instance id is a bare name, so a short one would match ordinary words: ids under 8 are skipped.
      for (const id of RAW_FS.readdirSync(path.join(root, "instances"))) if (id.length >= 8) needles.add(id);
    } catch {
      /* no instances under this root */
    }
  }
  return [...needles].filter((n) => n.length > 1); // never "/" (the home of a sandboxed account)
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
      } else if (e.isFile()) {
        const buf = fs.readFileSync(full);
        if (isBinary(buf)) continue;
        const lines = buf.toString("utf-8").split("\n");
        lines.forEach((text, i) => {
          for (const n of needles) {
            let at = text.indexOf(n);
            while (at !== -1) {
              const before = at > 0 ? text[at - 1] : "";
              const next = text[at + n.length] ?? "";
              if (!NAME_CHAR.test(before) && !NAME_CHAR.test(next)) {
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
      fs.writeFileSync(path.join(dir, "e.sql"), `ATTACH '${home}/.bot-relay/relay.db' AS live;\n`);
      fs.writeFileSync(path.join(dir, "f-extensionless"), `#!/bin/sh\nsqlite3 ${home}/.bot-relay/relay.db .dump\n`);
      fs.writeFileSync(path.join(dir, "g.bin"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`${home}/.bot-relay`)])); // binary: skipped
      fs.writeFileSync(path.join(dir, "h.ts"), `const p = "/data${home}/x"; const q = "x${id}";\n`); // inside a longer name: not a hit
      const hits = scanForNeedles([dir], [home, id]).map((h) => `${path.basename(h.file)}:${h.line}:${h.needle}`);
      expect(hits.sort()).toEqual([`a.test.ts:1:${home}`, `b.sh:1:${id}`, `e.sql:1:${home}`, `f-extensionless:2:${home}`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a SHORT home (the root account's, a container running as root) is a needle, and matches only at a path boundary", () => {
    // Built, never spelled: on a runner whose home IS this path, a literal here would be a hit in this file.
    const R = `/${"ro"}ot`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-scan-root-"));
    try {
      expect(operatorNeedles(R, [path.join(dir, "missing")])).toEqual([R]);
      fs.writeFileSync(path.join(dir, "a.sh"), `cat ${R}/.bot-relay/config.json\n`);
      fs.writeFileSync(path.join(dir, "b.sh"), `ls ${R}fs /srv${R} /home/x${R}\n`);
      fs.writeFileSync(path.join(dir, "c.ts"), `const u = "file://${R}/.bot-relay";\n`);
      const hits = scanForNeedles([dir], [R]).map((h) => `${path.basename(h.file)}:${h.line}`);
      expect(hits.sort()).toEqual(["a.sh:1", "c.ts:1"]);
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
