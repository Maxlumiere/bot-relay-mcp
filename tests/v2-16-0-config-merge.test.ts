// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.16.0 (gate 9) — config-merge helper unit tests.
 *
 * The installer's idempotence + "preserve unrelated user config" guarantee
 * lives here. These drive the REAL merge functions `relay init` uses.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  readJsonSafe,
  atomicWriteJson,
  jsonEqual,
  reconcileRelayConfig,
  upsertMcpServer,
  upsertSessionStartHook,
} from "../src/cli/config-merge.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "v2160-merge-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readJsonSafe", () => {
  it("returns null for missing, malformed, and non-object; parses valid objects", () => {
    expect(readJsonSafe(path.join(dir, "nope.json"))).toBeNull();
    fs.writeFileSync(path.join(dir, "bad.json"), "{ not json");
    expect(readJsonSafe(path.join(dir, "bad.json"))).toBeNull();
    fs.writeFileSync(path.join(dir, "arr.json"), "[1,2,3]");
    expect(readJsonSafe(path.join(dir, "arr.json"))).toBeNull(); // top-level array not a config object
    fs.writeFileSync(path.join(dir, "ok.json"), JSON.stringify({ a: 1 }));
    expect(readJsonSafe(path.join(dir, "ok.json"))).toEqual({ a: 1 });
  });
});

describe("atomicWriteJson", () => {
  it("writes pretty JSON, backs up an existing file to .bak, and applies mode", () => {
    const f = path.join(dir, "c.json");
    atomicWriteJson(f, { first: true });
    expect(readJsonSafe(f)).toEqual({ first: true });
    expect(fs.existsSync(`${f}.bak`)).toBe(false); // no prior file → no backup

    atomicWriteJson(f, { second: true });
    expect(readJsonSafe(f)).toEqual({ second: true });
    expect(readJsonSafe(`${f}.bak`)).toEqual({ first: true }); // prior contents backed up

    if (process.platform !== "win32") {
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    }
  });
});

describe("jsonEqual", () => {
  it("is order-insensitive on keys and deep on arrays/objects", () => {
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEqual({ a: [1, { x: 1 }] }, { a: [1, { x: 1 }] })).toBe(true);
    expect(jsonEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false); // arrays are ordered
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe("reconcileRelayConfig — preserve secret/instance/edits, add missing defaults", () => {
  const defaults = { transport: "http", http_port: 3777, http_secret: "NEW", instance_id: null, profile: "solo" };

  it("preserves an existing http_secret + instance_id + user edits; adds only missing keys", () => {
    const existing = { http_secret: "KEEP-ME", instance_id: "abc", http_port: 9999, custom: "userval" };
    const { root, changed } = reconcileRelayConfig(existing, defaults);
    expect(root.http_secret).toBe("KEEP-ME"); // never regenerated
    expect(root.instance_id).toBe("abc"); // preserved
    expect(root.http_port).toBe(9999); // user override preserved
    expect(root.custom).toBe("userval"); // unrelated user key preserved
    expect(root.transport).toBe("http"); // missing default added
    expect(root.profile).toBe("solo"); // missing default added
    expect(changed).toBe(true); // added transport/profile
  });

  it("is a NO-OP on a second run (all defaults already present)", () => {
    const first = reconcileRelayConfig(null, defaults).root;
    const second = reconcileRelayConfig(first, defaults);
    expect(second.changed).toBe(false);
    expect(second.root).toEqual(first);
  });
});

describe("upsertMcpServer — add ours, preserve others, idempotent", () => {
  const entry = { type: "stdio", command: "node", args: ["/abs/dist/index.js"] };

  it("adds bot-relay while preserving unrelated servers; no-op on identical re-run", () => {
    const existing = { mcpServers: { "other-server": { type: "stdio", command: "x" } }, topLevel: "keep" };
    const first = upsertMcpServer(existing, "bot-relay", entry);
    expect(first.changed).toBe(true);
    const servers = first.root.mcpServers as Record<string, unknown>;
    expect(servers["other-server"]).toEqual({ type: "stdio", command: "x" }); // unrelated preserved
    expect(servers["bot-relay"]).toEqual(entry);
    expect(first.root.topLevel).toBe("keep"); // unrelated top-level preserved

    const second = upsertMcpServer(first.root, "bot-relay", entry);
    expect(second.changed).toBe(false); // idempotent
  });

  it("updates our entry when the dist path changes (but stays a no-op otherwise)", () => {
    const first = upsertMcpServer(null, "bot-relay", entry).root;
    const moved = { ...entry, args: ["/new/dist/index.js"] };
    const res = upsertMcpServer(first, "bot-relay", moved);
    expect(res.changed).toBe(true);
    expect((res.root.mcpServers as Record<string, unknown>)["bot-relay"]).toEqual(moved);
  });
});

describe("upsertSessionStartHook — dedup by command, preserve unrelated hooks", () => {
  const spec = { matcher: "startup|resume", command: "/abs/hooks/check-relay.sh", timeout: 10 };

  it("adds our hook while preserving other events AND other SessionStart groups", () => {
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "/other/pre.sh" }] }],
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "/user/own.sh" }] }],
      },
    };
    const { root, changed } = upsertSessionStartHook(existing, spec);
    expect(changed).toBe(true);
    const hooks = root.hooks as Record<string, unknown[]>;
    expect(hooks.PreToolUse).toEqual(existing.hooks.PreToolUse); // other event untouched
    const ss = hooks.SessionStart;
    expect(ss.length).toBe(2); // user's own group + ours
    expect(ss[0]).toEqual(existing.hooks.SessionStart[0]); // user's group preserved
    const ours = ss[1] as { hooks: { command: string }[] };
    expect(ours.hooks[0].command).toBe(spec.command);
  });

  it("is a NO-OP on a second run — dedup by command path, never a duplicate", () => {
    const first = upsertSessionStartHook(null, spec).root;
    const second = upsertSessionStartHook(first, spec);
    expect(second.changed).toBe(false);
    const ss = (second.root.hooks as Record<string, unknown[]>).SessionStart;
    expect(ss.length).toBe(1); // still one — no duplicate
  });

  it("does NOT clobber an operator's hand-tweaked entry for the same command", () => {
    // Operator has our command but with a custom matcher + timeout.
    const existing = {
      hooks: {
        SessionStart: [
          { matcher: "startup", hooks: [{ type: "command", command: spec.command, timeout: 30 }] },
        ],
      },
    };
    const { root, changed } = upsertSessionStartHook(existing, spec);
    expect(changed).toBe(false); // recognized by command → left alone
    const ss = (root.hooks as Record<string, unknown[]>).SessionStart as { matcher: string; hooks: { timeout: number }[] }[];
    expect(ss.length).toBe(1);
    expect(ss[0].matcher).toBe("startup"); // operator's matcher preserved
    expect(ss[0].hooks[0].timeout).toBe(30); // operator's timeout preserved
  });
});
