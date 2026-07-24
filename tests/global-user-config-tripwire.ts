// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SUITE-WIDE USER-CONFIG TRIPWIRE (2026-07-23 worktree-clobber fix, layer 3;
 * scoped to RELAY-OWNED state 2026-07-24).
 *
 * Snapshots the relay-owned parts of the operator's REAL user-scope config
 * before the test run and fails the run if any of them changed by the end.
 * This is the observation-level backstop behind the two by-construction guards
 * (the atomicWriteJson chokepoint and the RELAY_CLAUDE_HOME sandbox in the
 * init-exercising tests): those stop relay code from clobbering; this catches
 * ANY test writing relay config by ANY means — fs.writeFileSync, a shelled
 * subprocess, a dependency — including code that doesn't exist yet.
 *
 * Why it must FAIL the run rather than warn: the original root cause survived
 * nine days precisely because the clobber was silent and every suite run was
 * green. A guard that cannot fail is decoration.
 *
 * Why RELAY-OWNED KEYS, not whole-file hashes (2026-07-24): ~/.claude.json is
 * Claude Code's own live state file — a suite launched from inside a running
 * Claude Code session ALWAYS races its history/project writes, so a whole-file
 * hash cried wolf on every such run and the alarm stopped meaning anything
 * ("residual writer" hunts against a false positive). We watch exactly what
 * the relay owns: the `mcpServers["bot-relay"]` entry, every hook entry whose
 * command invokes the relay, and all of ~/.bot-relay/config.json (that file is
 * entirely ours). A whole-file wipe still trips it — the relay keys vanish.
 *
 * Basis is the SYSTEM ACCOUNT home (os.userInfo().homedir), matching the
 * chokepoint in src/cli/config-merge.ts — a sandboxed $HOME must not be able
 * to blind the tripwire to the real account's files.
 */
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

function accountHome(): string {
  try {
    const h = os.userInfo().homedir;
    if (h) return h;
  } catch {
    /* unmapped uid (some containers) — fall through */
  }
  return os.homedir();
}

export type ProtectedKind = "claude-json" | "claude-settings" | "relay-config";

function protectedFiles(): Array<{ file: string; kind: ProtectedKind }> {
  const home = accountHome();
  return [
    { file: path.join(home, ".claude.json"), kind: "claude-json" },
    { file: path.join(home, ".claude", "settings.json"), kind: "claude-settings" },
    { file: path.join(home, ".bot-relay", "config.json"), kind: "relay-config" },
  ];
}

/**
 * Reduce a config file's raw content to the relay-owned state we defend.
 * Exported for tests/user-config-tripwire-scope.test.ts. Deterministic string
 * out; unparseable content degrades to a whole-content hash (fail-closed: if
 * we cannot see inside the file, ANY change to it counts).
 */
export function extractRelayOwnedState(kind: ProtectedKind, raw: string): string {
  const hash = (): string => "sha256:" + crypto.createHash("sha256").update(raw).digest("hex");
  if (kind === "relay-config") return hash(); // entirely relay-owned
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "UNPARSEABLE:" + hash();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "NOT-AN-OBJECT:" + hash();
  }
  const root = parsed as Record<string, unknown>;
  if (kind === "claude-json") {
    const entry = (root.mcpServers as Record<string, unknown> | undefined)?.["bot-relay"];
    return entry === undefined ? "NO-RELAY-ENTRY" : JSON.stringify(entry);
  }
  // claude-settings: every hook entry, under ANY event, whose command invokes
  // the relay (check-relay.sh / bot-relay). Sorted for order-insensitivity.
  const owned: string[] = [];
  const hooks = root.hooks as Record<string, unknown> | undefined;
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const inner = (group as { hooks?: unknown[] })?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        const cmd = (h as { command?: string })?.command;
        if (typeof cmd === "string" && /check-relay\.sh|bot-relay/.test(cmd)) {
          owned.push(
            JSON.stringify({ event, matcher: (group as { matcher?: string }).matcher, hook: h }),
          );
        }
      }
    }
  }
  return owned.length ? owned.sort().join("\n") : "NO-RELAY-HOOKS";
}

function fingerprint(file: string, kind: ProtectedKind): string {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return "ABSENT"; // missing file is a state too — creating it is a change
  }
  return extractRelayOwnedState(kind, raw);
}

export default function setup(): () => void {
  const targets = protectedFiles();
  const before = new Map(targets.map(({ file, kind }) => [file, fingerprint(file, kind)]));
  return function teardown(): void {
    const changed = targets.filter(({ file, kind }) => fingerprint(file, kind) !== before.get(file));
    if (changed.length > 0) {
      // Structured before/after so a firing names WHAT moved, not just where —
      // the old file-list-only message left the writer unidentifiable.
      const detail = changed
        .map(({ file, kind }) => {
          const now = fingerprint(file, kind);
          return `--- ${file}\n  before: ${before.get(file)}\n  after:  ${now}`;
        })
        .join("\n");
      const msg =
        `[user-config-tripwire] the test run MODIFIED relay-owned state in real user config:\n${detail}\n` +
        `A test wrote outside its sandbox (the 2026-07-23 worktree-clobber class — see ` +
        `tests/user-config-write-guard.test.ts). Find the writer and give it RELAY_CLAUDE_HOME / ` +
        `RELAY_CONFIG_PATH sandboxes. If YOU ran relay init while the suite ran, re-run to confirm.`;
      // BOTH channels, deliberately: vitest logs a teardown throw as "error
      // during close" but still exits 0 (proven during NC2 on 2026-07-23), so
      // the throw alone is decoration. Setting process.exitCode here is what
      // actually fails `npm test` / CI; the throw keeps the loud red banner.
      process.exitCode = 1;
      throw new Error(msg);
    }
  };
}
