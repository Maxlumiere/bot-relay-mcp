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
import { instanceDirOfDbPath } from "../src/resolve-instance.js";

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

const CASE_INSENSITIVE = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "relay-0b-ci-probe-"));
  try {
    fs.writeFileSync(path.join(d, "probe"), "");
    return fs.existsSync(path.join(d, "PROBE"));
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
})();

describe("the layout test ALWAYS folds case (ruling c998eaf6): no detection, the same answer on every file system", () => {
  it("a wrong-case basename, a wrong-case tail under an absent instances/, and a wrong-case root component are the layout (spelled under the root)", () => {
    fs.mkdirSync(relayRoot(), { recursive: true }); // instances/ absent: nothing on disk decides
    expect(instanceDirOfDbPath(path.join(instancesRoot(), "stale", "RELAY.DB"), instancesRoot())).toBe(path.join(instancesRoot(), "stale"));
    expect(instanceDirOfDbPath(path.join(relayRoot(), "INSTANCES", "stale", "relay.db"), instancesRoot())).toBe(path.join(instancesRoot(), "stale"));
    expect(instanceDirOfDbPath(path.join(relayRoot(), "Instances", "stale", "Relay.Db"), instancesRoot())).not.toBeNull();
  });
  it.skipIf(CASE_INSENSITIVE)("on a case-SENSITIVE file system with BOTH INSTANCES/ and instances/: INSTANCES/<id>/relay.db is still recognised (the stated cost: a loud refusal, never a silent second relay)", () => {
    fs.mkdirSync(path.join(relayRoot(), "INSTANCES", "other"), { recursive: true });
    fs.mkdirSync(instancesRoot(), { recursive: true });
    expect(instanceDirOfDbPath(path.join(relayRoot(), "INSTANCES", "other", "relay.db"), instancesRoot())).toBe(path.join(instancesRoot(), "other"));
  });
  it("never the layout: another basename, a deeper path, a sibling root, a parent shorter than the root", () => {
    expect(instanceDirOfDbPath(path.join(instancesRoot(), "stale", "other.db"), instancesRoot())).toBeNull();
    expect(instanceDirOfDbPath(path.join(instancesRoot(), "stale", "deeper", "relay.db"), instancesRoot())).toBeNull();
    expect(instanceDirOfDbPath(path.join(relayRoot(), "instances-old", "stale", "relay.db"), instancesRoot())).toBeNull();
    expect(instanceDirOfDbPath(path.join(relayRoot(), "stale", "relay.db"), instancesRoot())).toBeNull();
  });
});

describe("on EVERY file system (always folded): each wrong-case path is refused and creates nothing", () => {
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
