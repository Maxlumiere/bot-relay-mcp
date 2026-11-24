// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Item 0b, CASE-FOLD (scoped in the #442 review rounds): the instance-layout test compares the explicit DB path with
 * the instances root COMPONENT BY COMPONENT, the basename included, case-folding only when the file system is
 * DETECTED case-insensitive (undetectable → folded: that only refuses more). On such a file system:
 *   (i)   <home>/.bot-relay/instances/<stale>/RELAY.DB          (the basename in the wrong case)
 *   (ii)  <home>/.bot-relay/INSTANCES/<stale>/relay.db, with instances/ ABSENT (a missing component in the wrong case)
 *   (iii) <home>/.bot-relay/INSTANCES/<stale>/relay.db, with instances/ present (the original row)
 * are each the instance layout, so an unprovisioned one is refused and nothing is created. The pure rows run on any
 * file system through the explicit case-insensitivity seam.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveInstance, createInstance } from "../src/instance.js";
import { initializeDb, closeDb } from "../src/db.js";
import { instanceDirOfDbPath, fsIsCaseInsensitiveAt } from "../src/resolve-instance.js";

const ENV_KEYS = ["HOME", "RELAY_HOME", "RELAY_INSTANCE_ID", "RELAY_DB_PATH", "RELAY_CONFIG_PATH", "RELAY_CLAUDE_HOME"] as const;
let home: string;
let saved: Record<string, string | undefined>;
const relayRoot = () => path.join(home, ".bot-relay");
const instancesRoot = () => path.join(relayRoot(), "instances");

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-0b-casefold-")));
  process.env.HOME = home;
});
afterEach(() => {
  try {
    closeDb();
  } catch {
    /* nothing open */
  }
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("the layout test, pure (the case-insensitivity seam): component by component, the basename included", () => {
  it("case-INSENSITIVE: a wrong-case basename, a wrong-case tail under an absent instances/, and a wrong-case root component are the layout", () => {
    fs.mkdirSync(relayRoot(), { recursive: true }); // instances/ absent
    const ci = { caseInsensitive: true };
    expect(instanceDirOfDbPath(path.join(instancesRoot(), "stale", "RELAY.DB"), instancesRoot(), ci)).toBe(path.join(instancesRoot(), "stale"));
    expect(instanceDirOfDbPath(path.join(relayRoot(), "INSTANCES", "stale", "relay.db"), instancesRoot(), ci)).toBe(path.join(relayRoot(), "INSTANCES", "stale"));
    expect(instanceDirOfDbPath(path.join(relayRoot(), "Instances", "stale", "Relay.Db"), instancesRoot(), ci)).not.toBeNull();
  });
  it("case-SENSITIVE: the same wrong-case paths are NOT the layout (they name other files there); the exact path is", () => {
    fs.mkdirSync(relayRoot(), { recursive: true });
    const cs = { caseInsensitive: false };
    expect(instanceDirOfDbPath(path.join(instancesRoot(), "stale", "RELAY.DB"), instancesRoot(), cs)).toBeNull();
    expect(instanceDirOfDbPath(path.join(relayRoot(), "INSTANCES", "stale", "relay.db"), instancesRoot(), cs)).toBeNull();
    expect(instanceDirOfDbPath(path.join(instancesRoot(), "stale", "relay.db"), instancesRoot(), cs)).toBe(path.join(instancesRoot(), "stale"));
  });
  it("never the layout on any file system: another basename, a deeper path, a sibling root", () => {
    for (const caseInsensitive of [true, false]) {
      expect(instanceDirOfDbPath(path.join(instancesRoot(), "stale", "other.db"), instancesRoot(), { caseInsensitive })).toBeNull();
      expect(instanceDirOfDbPath(path.join(instancesRoot(), "stale", "deeper", "relay.db"), instancesRoot(), { caseInsensitive })).toBeNull();
      expect(instanceDirOfDbPath(path.join(relayRoot(), "instances-old", "stale", "relay.db"), instancesRoot(), { caseInsensitive })).toBeNull();
      // a parent SHORTER than the root (the relay home itself, a prefix of instances/) is not the layout either
      expect(instanceDirOfDbPath(path.join(relayRoot(), "stale", "relay.db"), instancesRoot(), { caseInsensitive })).toBeNull();
    }
  });
});

const CASE_INSENSITIVE = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "relay-0b-ci-probe-"));
  try {
    fs.writeFileSync(path.join(d, "probe"), "");
    return fs.existsSync(path.join(d, "PROBE"));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
})();

describe("the detection (fsIsCaseInsensitiveAt) agrees with the file system", () => {
  it("it reads the temp file system's real behaviour", () => {
    expect(fsIsCaseInsensitiveAt(home)).toBe(CASE_INSENSITIVE);
  });
});

describe.skipIf(!CASE_INSENSITIVE)("on THIS case-insensitive file system: each wrong-case path is refused and creates nothing", () => {
  const refuses = async (dbPath: string, stale: string) => {
    process.env.RELAY_DB_PATH = dbPath;
    expect(resolveInstance()).toMatchObject({ kind: "error", unprovisioned: true });
    await expect(initializeDb()).rejects.toThrow(new RegExp(`instance "${stale}"`, "i"));
    expect(fs.existsSync(path.join(instancesRoot(), stale)), "nothing created under any case").toBe(false);
  };
  it("(i) the basename in the wrong case: instances/<stale>/RELAY.DB", async () => {
    createInstance("realinst", "t");
    await refuses(path.join(instancesRoot(), "stale", "RELAY.DB"), "stale");
  });
  it("(ii) a wrong-case tail with instances/ ABSENT: INSTANCES/<stale>/relay.db", async () => {
    fs.mkdirSync(relayRoot(), { recursive: true });
    await refuses(path.join(relayRoot(), "INSTANCES", "stale", "relay.db"), "stale");
    expect(fs.existsSync(instancesRoot()), "instances/ not created either").toBe(false);
  });
  it("(iii) the original row: INSTANCES/<stale>/relay.db with instances/ present", async () => {
    createInstance("realinst", "t");
    await refuses(path.join(relayRoot(), "INSTANCES", "stale", "relay.db"), "stale");
  });
});
