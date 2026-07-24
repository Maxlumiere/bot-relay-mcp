// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * 2026-07-24 — SessionStart hook dedupe by SEMANTIC path identity + fossil
 * repair/prune. The raw `===` dedupe could neither recognize a broken
 * `Claude%20AI` twin of the working hook nor remove it, and appended one new
 * entry per checkout that ever ran init (observed six deep). Relay entries are
 * a singleton now: variant spellings repaired in place, stale locations pruned,
 * operator hooks untouchable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  normalizeHookCommand,
  isRelayHookCommand,
  upsertSessionStartHook,
} from "../src/cli/config-merge.js";
import { installHook } from "../src/cli/init.js";

// A real on-disk layout mirroring the machine that motivated this: an install
// under a directory WITH A SPACE, plus a no-space symlink alias to it.
let base: string;
let realHook: string; // literal-space path — what post-#125 init computes
let linkHook: string; // via symlink alias
let encodedHook: string; // %20 fossil — what pre-#125 init wrote

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "hook-dedupe-"));
  const spacedDir = path.join(base, "Claude AI", "bot-relay-mcp", "hooks");
  fs.mkdirSync(spacedDir, { recursive: true });
  realHook = path.join(spacedDir, "check-relay.sh");
  fs.writeFileSync(realHook, "#!/bin/sh\n");
  fs.symlinkSync(path.join(base, "Claude AI"), path.join(base, "alias"));
  linkHook = path.join(base, "alias", "bot-relay-mcp", "hooks", "check-relay.sh");
  encodedHook = realHook.replace("Claude AI", "Claude%20AI");
});
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("normalizeHookCommand — semantic path identity", () => {
  it("strips one layer of surrounding shell quotes", () => {
    expect(normalizeHookCommand(`'${realHook}'`)).toBe(normalizeHookCommand(realHook));
    expect(normalizeHookCommand(`"${realHook}"`)).toBe(normalizeHookCommand(realHook));
  });

  it("percent-decodes the %20 fossil onto the literal-space path", () => {
    expect(normalizeHookCommand(encodedHook)).toBe(normalizeHookCommand(realHook));
  });

  it("resolves a symlink alias onto the real path", () => {
    expect(normalizeHookCommand(linkHook)).toBe(normalizeHookCommand(realHook));
  });

  it("keeps a path with an invalid % sequence as-is instead of throwing", () => {
    expect(() => normalizeHookCommand("/tmp/100%valid/check-relay.sh")).not.toThrow();
  });
});

describe("isRelayHookCommand", () => {
  it("matches our script in any spelling, not the operator's hooks", () => {
    expect(isRelayHookCommand(realHook)).toBe(true);
    expect(isRelayHookCommand(`'${realHook}'`)).toBe(true);
    expect(isRelayHookCommand(encodedHook)).toBe(true);
    expect(isRelayHookCommand("/user/own-hook.sh")).toBe(false);
    expect(isRelayHookCommand("/user/check-relay.sh.bak")).toBe(false);
  });
});

describe("upsertSessionStartHook — repair and prune", () => {
  const spec = { matcher: "startup|resume", command: "", timeout: 10 };
  beforeAll(() => {
    spec.command = realHook;
  });

  it("repairs a %20 fossil in place (same script, broken spelling)", () => {
    const existing = {
      hooks: {
        SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: encodedHook, timeout: 10 }] }],
      },
    };
    const { root, changed, repaired, pruned } = upsertSessionStartHook(existing, spec);
    expect(changed).toBe(true);
    expect(repaired).toEqual([encodedHook]);
    expect(pruned).toEqual([]);
    const ss = (root.hooks as Record<string, unknown[]>).SessionStart as {
      hooks: { command: string; timeout: number }[];
    }[];
    expect(ss.length).toBe(1);
    expect(ss[0].hooks[0].command).toBe(realHook);
    expect(ss[0].hooks[0].timeout).toBe(10); // rest of the entry preserved
  });

  it("collapses the observed six-stack to a singleton: repair the fossil twin, prune dead checkouts, keep operator hooks", () => {
    const existing = {
      hooks: {
        SessionStart: [
          { matcher: "startup|resume", hooks: [{ type: "command", command: `'${realHook}'`, timeout: 10 }] },
          { matcher: "startup|resume", hooks: [{ type: "command", command: "/private/tmp/pr116-audit-f6d835d/hooks/check-relay.sh" }] },
          { matcher: "startup|resume", hooks: [{ type: "command", command: "/private/tmp/sentinel-audit-81b5707/hooks/check-relay.sh" }] },
          { matcher: "startup", hooks: [{ type: "command", command: "/user/own.sh" }] },
          { matcher: "startup|resume", hooks: [{ type: "command", command: encodedHook, timeout: 10 }] },
        ],
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "/user/pre.sh" }] }],
      },
    };
    const { root, changed, repaired, pruned } = upsertSessionStartHook(existing, spec);
    expect(changed).toBe(true);
    expect(repaired).toEqual([`'${realHook}'`]); // first semantic match wins the repair
    expect(pruned).toEqual([
      "/private/tmp/pr116-audit-f6d835d/hooks/check-relay.sh",
      "/private/tmp/sentinel-audit-81b5707/hooks/check-relay.sh",
      encodedHook,
    ]);
    const hooks = root.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    const ss = hooks.SessionStart as { hooks: { command: string }[] }[];
    expect(ss.length).toBe(2); // singleton relay entry + operator's group
    expect(ss[0].hooks[0].command).toBe(realHook);
    expect(ss[1].hooks[0].command).toBe("/user/own.sh");
  });

  it("prunes a dead relay entry whose checkout no longer exists", () => {
    const dead = "/private/tmp/review-pr119-r2/hooks/check-relay.sh";
    const existing = {
      hooks: {
        SessionStart: [
          { matcher: "startup|resume", hooks: [{ type: "command", command: realHook, timeout: 10 }] },
          { matcher: "startup|resume", hooks: [{ type: "command", command: dead }] },
        ],
      },
    };
    const { root, changed, pruned } = upsertSessionStartHook(existing, spec);
    expect(changed).toBe(true);
    expect(pruned).toEqual([dead]);
    const ss = (root.hooks as Record<string, unknown[]>).SessionStart;
    expect(ss.length).toBe(1);
  });

  it("stays a strict no-op once canonical (idempotence after repair)", () => {
    const messy = {
      hooks: {
        SessionStart: [
          { matcher: "startup|resume", hooks: [{ type: "command", command: encodedHook, timeout: 10 }] },
          { matcher: "startup|resume", hooks: [{ type: "command", command: "/private/tmp/gone/hooks/check-relay.sh" }] },
        ],
      },
    };
    const first = upsertSessionStartHook(messy, spec);
    const second = upsertSessionStartHook(first.root, spec);
    expect(second.changed).toBe(false);
    expect(second.repaired).toEqual([]);
    expect(second.pruned).toEqual([]);
    expect(second.root).toEqual(first.root);
  });

  it("installHook shell-quotes a spaced path — a bare `.../Claude AI/...` command word-splits and dies at every SessionStart", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-install-"));
    const settings = path.join(tmp, "settings.json");
    const r = installHook(realHook, settings); // realHook contains a space
    expect(r.changed).toBe(true);
    const written = JSON.parse(fs.readFileSync(settings, "utf-8")) as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    expect(written.hooks.SessionStart[0].hooks[0].command).toBe(`'${realHook}'`);
    const r2 = installHook(realHook, settings);
    expect(r2.changed).toBe(false); // idempotent once canonical
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("installHook repairs a broken bare-space entry to the quoted canonical", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hook-install-"));
    const settings = path.join(tmp, "settings.json");
    fs.writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: "startup|resume", hooks: [{ type: "command", command: realHook, timeout: 10 }] },
          ],
        },
      }),
    );
    const r = installHook(realHook, settings);
    expect(r.repaired).toEqual([realHook]);
    const written = JSON.parse(fs.readFileSync(settings, "utf-8")) as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    expect(written.hooks.SessionStart[0].hooks[0].command).toBe(`'${realHook}'`);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("never touches a mixed group's operator entries when pruning a relay one from it", () => {
    const existing = {
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              { type: "command", command: "/user/own.sh" },
              { type: "command", command: "/private/tmp/gone/hooks/check-relay.sh" },
            ],
          },
          { matcher: "startup|resume", hooks: [{ type: "command", command: realHook, timeout: 10 }] },
        ],
      },
    };
    const { root, pruned } = upsertSessionStartHook(existing, spec);
    expect(pruned).toEqual(["/private/tmp/gone/hooks/check-relay.sh"]);
    const ss = (root.hooks as Record<string, unknown[]>).SessionStart as {
      matcher: string;
      hooks: { command: string }[];
    }[];
    expect(ss.length).toBe(2);
    expect(ss[0].hooks.map((h) => h.command)).toEqual(["/user/own.sh"]);
    expect(ss[1].hooks[0].command).toBe(realHook);
  });
});
