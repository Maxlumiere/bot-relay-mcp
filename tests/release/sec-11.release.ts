// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-11 (security/invariants.json): the security suite itself never touches the real HOME. Every process this suite
 * starts runs with a sandbox HOME under the run's scratch dir. The operator's relay config is hashed by the global
 * setup (the main process) before the run and checked after it: a change FAILS the run. A test worker never reads it
 * (the operator tripwire, loaded first by every config, refuses that read: seen while building this file).
 */
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { installed, sandbox, relayCli } from "./_installed.js";

const inside = (p: string, root: string) => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

describe("SEC-11: the suite never touches the real HOME", () => {
  it("SEC-11.T1 every installed process this suite starts runs in a sandbox HOME, never the account's", () => {
    const sb = sandbox("s11");
    expect(inside(sb.home, installed().work), "the sandbox is under this run's scratch dir").toBe(true);
    expect(sb.home).not.toBe(os.userInfo().homedir);
    expect(sb.env.HOME).toBe(sb.home);
    expect(sb.env.USERPROFILE).toBe(sb.home);
    const r = relayCli(sb, ["help"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
