// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 S1 completion — the WIDENED SessionStart matcher (§8 S1 scope, F9, E4).
 *
 * `/clear` mints a NEW conversation id in the same window (MEASURED 15 Sep, E3/E4).
 * With the installed `startup|resume` matcher the hook never fires on it, so the
 * binding keeps the PRE-clear id and a restart line resumes the WRONG conversation
 * (ADR-0040 Q1: "load-bearing"). E4 MEASURED that `startup|resume|clear|compact|fork`
 * fires on all five sources.
 *
 * Three things are pinned here:
 *   1. The registry (the one source every installer reads) carries the widened
 *      matcher, and `relay init` installs it on a fresh settings file.
 *   2. EXISTING installs are widened too. The upsert is a deliberate no-op when the
 *      relay hook is already present ("never clobber the operator's version"), so a
 *      default change alone would reach no existing machine. The migration is
 *      EXACT-LITERAL like migrateRawHookCommand: only the relay's own entry, only
 *      when its matcher is exactly a previous default. A hand-edited matcher is left
 *      alone and init says so loudly, because staying narrow means /clear is missed.
 *      A group SHARED with a foreign hook is split, never widened for the foreign one.
 *   3. Row 8, "identity carries": clear and compact are the SAME window and the SAME
 *      process, so the hook must not re-register. Re-registering rotates session_id
 *      and re-pends mail this session already read; on an auto-compact after two
 *      idle minutes the old gate (last_seen < 120s) would do exactly that.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { getFreePort } from "./_helpers/port.js";

const WIDE = "startup|resume|clear|compact|fork";
const OLD = "startup|resume";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ROOT = path.join(os.tmpdir(), `bot-relay-s1c-matcher-${process.pid}`);
const SETTINGS = path.join(TEST_ROOT, "settings.json");
// A spaced root, like Maxime's real one ("LLMs/Claude AI"), so the canonical form is quoted.
const HOOK_SCRIPT = path.join(TEST_ROOT, "Claude AI", "bot-relay-mcp", "hooks", "check-relay.sh");

type Group = { matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> };

function writeSettings(obj: unknown): void {
  fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2));
}

function readGroups(): Group[] {
  const j = JSON.parse(fs.readFileSync(SETTINGS, "utf-8")) as { hooks?: { SessionStart?: Group[] } };
  return j.hooks?.SessionStart ?? [];
}

async function canonical(): Promise<string> {
  const { quoteForHookCommand } = await import("../src/cli/config-merge.js");
  return quoteForHookCommand(HOOK_SCRIPT);
}

/** Every group that runs the relay hook, with its matcher. */
async function relayGroups(): Promise<Group[]> {
  const c = await canonical();
  return readGroups().filter((g) => g.hooks?.some((h) => h.command === c));
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(HOOK_SCRIPT), { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("S1 completion — the registry and a fresh install carry the widened matcher", () => {
  it("the Claude profile's SessionStart matcher is the E4-measured five", async () => {
    const { getAgentCliProfile } = await import("../src/agent-cli-profiles.js");
    const ss = getAgentCliProfile("claude").hookInstall.events.find((e) => e.event === "SessionStart");
    expect(ss?.matcher).toBe(WIDE);
  });

  it("Codex is NOT widened: its SessionStart sources were never measured", async () => {
    const { getAgentCliProfile } = await import("../src/agent-cli-profiles.js");
    const ss = getAgentCliProfile("codex").hookInstall.events.find((e) => e.event === "SessionStart");
    expect(ss?.matcher).toBe(OLD);
  });

  it("relay init on a fresh settings file installs the widened matcher", async () => {
    const { installHook } = await import("../src/cli/init.js");
    const r = installHook(HOOK_SCRIPT, SETTINGS);
    expect(r.changed).toBe(true);
    const groups = await relayGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].matcher).toBe(WIDE);
  });
});

describe("S1 completion — existing installs are widened, exact-literal", () => {
  it("the relay's own entry at exactly the old default is widened IN PLACE: one group, timeout kept", async () => {
    const c = await canonical();
    writeSettings({ hooks: { SessionStart: [{ matcher: OLD, hooks: [{ type: "command", command: c, timeout: 10 }] }] } });
    const { installHook } = await import("../src/cli/init.js");
    const r = installHook(HOOK_SCRIPT, SETTINGS);
    expect(r.changed).toBe(true);
    const groups = readGroups();
    expect(groups, "no duplicate group: the hook must not run twice on startup").toHaveLength(1);
    expect(groups[0].matcher).toBe(WIDE);
    expect(groups[0].hooks).toEqual([{ type: "command", command: c, timeout: 10 }]);
  });

  it("a RAW legacy command at the old default is both quoted and widened", async () => {
    writeSettings({
      hooks: { SessionStart: [{ matcher: OLD, hooks: [{ type: "command", command: HOOK_SCRIPT, timeout: 10 }] }] },
    });
    const { installHook } = await import("../src/cli/init.js");
    installHook(HOOK_SCRIPT, SETTINGS);
    const groups = await relayGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].matcher).toBe(WIDE);
    expect(readGroups()).toHaveLength(1);
  });

  it("a group SHARED with a foreign hook is split: the foreign hook keeps the old matcher", async () => {
    const c = await canonical();
    const foreign = { type: "command", command: "/opt/other/on-start.sh", timeout: 3 };
    writeSettings({
      hooks: { SessionStart: [{ matcher: OLD, hooks: [foreign, { type: "command", command: c, timeout: 10 }] }] },
    });
    const { installHook } = await import("../src/cli/init.js");
    installHook(HOOK_SCRIPT, SETTINGS);
    const groups = readGroups();
    const foreignGroups = groups.filter((g) => g.hooks?.some((h) => h.command === foreign.command));
    expect(foreignGroups).toHaveLength(1);
    expect(foreignGroups[0].matcher, "widening must never change when a foreign hook fires").toBe(OLD);
    expect(foreignGroups[0].hooks).toEqual([foreign]);
    const ours = await relayGroups();
    expect(ours).toHaveLength(1);
    expect(ours[0].matcher).toBe(WIDE);
    expect(ours[0].hooks).toEqual([{ type: "command", command: c, timeout: 10 }]);
  });

  it("a HAND-EDITED matcher is left alone, and init says so loudly (narrow means /clear is missed)", async () => {
    const c = await canonical();
    writeSettings({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: c, timeout: 10 }] }] } });
    const { installHook } = await import("../src/cli/init.js");
    const r = installHook(HOOK_SCRIPT, SETTINGS);
    expect(r.changed).toBe(false);
    expect(readGroups()[0].matcher).toBe("startup");
    expect(r.note, "a silent skip here is a silent staleness").toMatch(/clear/);
    expect(r.note).toContain(WIDE);
  });

  it("the other relay hook events and foreign SessionStart groups are untouched", async () => {
    const c = await canonical();
    const other = { matcher: "startup", hooks: [{ type: "command", command: "/opt/x.sh" }] };
    const post = [{ matcher: "*", hooks: [{ type: "command", command: "/opt/post.sh" }] }];
    writeSettings({
      hooks: { SessionStart: [other, { matcher: OLD, hooks: [{ type: "command", command: c, timeout: 10 }] }], PostToolUse: post },
    });
    const { installHook } = await import("../src/cli/init.js");
    installHook(HOOK_SCRIPT, SETTINGS);
    const j = JSON.parse(fs.readFileSync(SETTINGS, "utf-8"));
    expect(j.hooks.PostToolUse).toEqual(post);
    expect(j.hooks.SessionStart[0]).toEqual(other);
  });

  it("a second run is a no-op (idempotent)", async () => {
    const c = await canonical();
    writeSettings({ hooks: { SessionStart: [{ matcher: OLD, hooks: [{ type: "command", command: c, timeout: 10 }] }] } });
    const { installHook } = await import("../src/cli/init.js");
    installHook(HOOK_SCRIPT, SETTINGS);
    const before = fs.readFileSync(SETTINGS, "utf-8");
    const r = installHook(HOOK_SCRIPT, SETTINGS);
    expect(r.changed).toBe(false);
    expect(r.note).toBeUndefined();
    expect(fs.readFileSync(SETTINGS, "utf-8")).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Row 8 — the hook does not re-register on a same-window re-fire
// ─────────────────────────────────────────────────────────────────────────────

const HOOK_ROOT = path.join(os.tmpdir(), `bot-relay-s1c-hook-${process.pid}`);
const FAKE_REPO = path.join(HOOK_ROOT, "bot-relay-mcp");
const HOOK = path.join(FAKE_REPO, "hooks", "check-relay.sh");
const HOOK_DB = path.join(HOOK_ROOT, "relay.db");

/** A stub daemon that answers everything and RECORDS which tools were called. */
async function stubDaemon(): Promise<{ port: number; calls: string[]; close: () => Promise<void> }> {
  const port = await getFreePort();
  const calls: string[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const name = (JSON.parse(body) as { params?: { name?: string } }).params?.name;
        if (name) calls.push(name);
      } catch {
        /* GET /health etc. */
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{}" }] }, status: "ok" }));
    });
  });
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", () => r()));
  return { port, calls, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** Async, so the in-process stub can answer while the hook runs. */
function runHook(port: number, source: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [HOOK], {
      env: {
        HOME: HOOK_ROOT,
        PATH: process.env.PATH || "/usr/bin:/bin",
        RELAY_DB_PATH: HOOK_DB,
        RELAY_AGENT_NAME: "s1c-matcher",
        RELAY_AGENT_ROLE: "builder",
        RELAY_AGENT_CAPABILITIES: "",
        RELAY_AGENT_TOKEN: "",
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HTTP_PORT: String(port),
        CLAUDE_PID: String(process.pid),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", () => resolve({ stdout, stderr }));
    child.stdin.end(
      JSON.stringify({
        session_id: "cccccccc-1111-2222-3333-dddddddddddd",
        transcript_path: `${HOOK_ROOT}/t.jsonl`,
        cwd: HOOK_ROOT,
        hook_event_name: "SessionStart",
        source,
      }),
    );
  });
}

describe("S1 completion, row 8 — clear and compact carry the identity: no re-register", () => {
  beforeEach(async () => {
    fs.rmSync(HOOK_ROOT, { recursive: true, force: true });
    fs.mkdirSync(HOOK_ROOT, { recursive: true, mode: 0o700 });
    fs.cpSync(path.join(REPO_ROOT, "hooks"), path.join(FAKE_REPO, "hooks"), { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, "bin"), path.join(FAKE_REPO, "bin"), "dir");
    fs.symlinkSync(path.join(REPO_ROOT, "dist"), path.join(FAKE_REPO, "dist"), "dir");
    fs.writeFileSync(
      path.join(HOOK_ROOT, ".claude.json"),
      JSON.stringify({ mcpServers: { "bot-relay": { type: "stdio", command: "node", args: [path.join(REPO_ROOT, "dist", "index.js")] } } }),
    );
    const { closeDb, getDb } = await import("../src/db.js");
    closeDb();
    process.env.RELAY_DB_PATH = HOOK_DB;
    getDb();
    closeDb();
  });

  afterEach(() => {
    fs.rmSync(HOOK_ROOT, { recursive: true, force: true });
  });

  it("CONTROL: startup with no live row DOES register (proves the harness sees register_agent)", async () => {
    const d = await stubDaemon();
    try {
      const r = await runHook(d.port, "startup");
      expect(d.calls, r.stdout + r.stderr).toContain("register_agent");
    } finally {
      await d.close();
    }
  }, 30_000);

  it.each(["compact", "clear"])("%s does NOT register: same window, same process, identity carries", async (source) => {
    const d = await stubDaemon();
    try {
      const r = await runHook(d.port, source);
      expect(d.calls, r.stdout + r.stderr).not.toContain("register_agent");
    } finally {
      await d.close();
    }
  }, 30_000);

  it("resume still registers (a resumed conversation may be in a NEW window)", async () => {
    const d = await stubDaemon();
    try {
      const r = await runHook(d.port, "resume");
      expect(d.calls, r.stdout + r.stderr).toContain("register_agent");
    } finally {
      await d.close();
    }
  }, 30_000);
});
