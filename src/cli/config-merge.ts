// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.16.0 (gate 9) — structural, atomic, idempotent config-merge helpers for
 * the one-command installer (`relay init`).
 *
 * The installer must RECONCILE the operator's existing Claude Code config
 * (`~/.claude.json` mcpServers + `~/.claude/settings.json` hooks) and the relay
 * config — never string-splice, never clobber unrelated entries, and be a
 * strict NO-OP on a second run. These helpers parse → merge structurally by
 * SEMANTIC identity (mcpServer NAME; hook COMMAND path) → write atomically
 * (tmp + rename) with a `.bak` of the prior file.
 *
 * TOKEN-BLIND: nothing here reads, writes, mints, or rotates a token — merging
 * JSON config only. The installer's token-safety-by-construction depends on it.
 *
 * VSCode-free + relay-free by design (only `fs`/`path`) so the unit tests drive
 * the real shipped merge logic without a daemon or DB.
 */
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

/**
 * SHIPPING-DEFECT guard (2026-07-23): under a test harness, REFUSE to write a
 * home-derived user-scope config file when the matching sandbox redirect is
 * NOT set. `tests/v2-3-0-profiles.test.ts` ran the real installer without
 * redirecting the home dir, so every `npm test` — any contributor's, any
 * audit worktree's — silently rewrote the REAL `~/.claude.json` +
 * `~/.claude/settings.json` to point at whichever checkout ran the suite (an
 * unmerged /private/tmp audit build, or a percent-encoded path that doesn't
 * exist). Same class as the launchd install Steph flagged (#116 /
 * RELAY_SKIP_DAEMON) — that fix covered one symptom of the pattern; this
 * covers the pattern at the only JSON-write chokepoint.
 *
 * Why the guard keys on TARGET==homedir-derived AND redirect-var ABSENT: a
 * subprocess test that sandboxes HOME itself (v2-1-cli-tooling,
 * fresh-install-smoke, …) is indistinguishable FROM INSIDE from a real home —
 * os.homedir() IS the sandbox there. The presence of RELAY_CLAUDE_HOME /
 * RELAY_CONFIG_PATH is the one signal that says "this environment was
 * sandboxed on purpose"; its ABSENCE while writing a home-derived config is
 * exactly the forgotten-redirect defect. The suite-wide tripwire
 * (tests/global-user-config-tripwire.ts) backstops everything this can't see.
 * THROW, not skip: a silently-skipped write would let a test certify an
 * install that never happened.
 */
export function assertNotRealUserConfigWrite(filePath: string): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") return;
  const resolved = path.resolve(filePath);
  const home = os.homedir();
  const guarded: Array<{ real: string; redirect: string }> = [
    { real: path.join(home, ".claude.json"), redirect: "RELAY_CLAUDE_HOME" },
    { real: path.join(home, ".claude", "settings.json"), redirect: "RELAY_CLAUDE_HOME" },
    { real: path.join(home, ".bot-relay", "config.json"), redirect: "RELAY_CONFIG_PATH" },
  ];
  for (const { real, redirect } of guarded) {
    if (path.resolve(real) === resolved && !process.env[redirect]) {
      throw new Error(
        `[config-guard] refusing to write the REAL user config ${resolved} from inside a test harness ` +
          `(${redirect} is not set). Tests must sandbox user-scope writes: set RELAY_CLAUDE_HOME and ` +
          `RELAY_CONFIG_PATH to a temp dir.`,
      );
    }
  }
}

/** Parse a JSON file. Returns null on missing OR malformed (never throws) so a
 *  hand-corrupted user file degrades to "treat as empty + back it up" rather
 *  than crashing the installer. */
export function readJsonSafe(filePath: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null; // missing
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null; // malformed
  }
}

/**
 * Atomically write `obj` as pretty JSON to `filePath`. Backs up any existing
 * file to `<file>.bak` first (best-effort), writes to a temp sibling, then
 * renames over the target (atomic on POSIX). `mode` sets file perms.
 */
export function atomicWriteJson(
  filePath: string,
  obj: unknown,
  mode = 0o600,
): void {
  assertNotRealUserConfigWrite(filePath);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, `${filePath}.bak`);
    } catch {
      /* best-effort backup — never block the write */
    }
  }
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode });
    fs.renameSync(tmp, filePath);
    try {
      fs.chmodSync(filePath, mode);
    } catch {
      /* Windows / EPERM */
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Structural deep-equality for JSON-ish values (order-insensitive on object
 *  keys), used to make merges a true no-op when the target already matches. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length || !ak.every((k, i) => k === bk[i])) return false;
    return ak.every((k) => jsonEqual(ao[k], bo[k]));
  }
  return false;
}

export interface MergeResult {
  /** The merged root object (a NEW object; inputs are not mutated). */
  root: Record<string, unknown>;
  /** True if the merge changed anything (false → a no-op second run). */
  changed: boolean;
}

/**
 * Reconcile the relay config: PRESERVE every existing key (operator edits +
 * `http_secret` + `instance_id` all win), and ADD any default key that is
 * missing. Never regenerates a secret, never overwrites a user value. A second
 * run with the same defaults is a no-op.
 *
 * (Shallow-by-top-level: the relay config is flat except `tool_visibility`,
 * which is preserved wholesale when present — we never reshape a user's block.)
 */
export function reconcileRelayConfig(
  existing: Record<string, unknown> | null,
  defaults: Record<string, unknown>,
): MergeResult {
  const base = existing ?? {};
  const root: Record<string, unknown> = { ...base };
  let changed = existing === null;
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in root)) {
      root[k] = v;
      changed = true;
    }
  }
  return { root, changed };
}

/**
 * Upsert an mcpServers entry by NAME. Preserves all other servers. Overwrites
 * OUR OWN named entry only when it structurally differs (so a path change
 * updates, but an identical re-run is a no-op).
 */
export function upsertMcpServer(
  root: Record<string, unknown> | null,
  name: string,
  entry: Record<string, unknown>,
): MergeResult {
  const out: Record<string, unknown> = { ...(root ?? {}) };
  const servers: Record<string, unknown> = {
    ...((out.mcpServers as Record<string, unknown> | undefined) ?? {}),
  };
  const changed = !jsonEqual(servers[name], entry);
  if (changed) servers[name] = entry;
  out.mcpServers = servers;
  // `changed` also true if the file had no mcpServers key at all AND we added
  // ours; jsonEqual(undefined, entry) is false so that's already covered.
  return { root: out, changed };
}

export interface SessionStartHookSpec {
  /** e.g. "startup|resume" */
  matcher: string;
  /** absolute path invoked, e.g. "/abs/hooks/check-relay.sh" */
  command: string;
  /** seconds */
  timeout?: number;
}

/**
 * Upsert a SessionStart hook, deduped by SEMANTIC identity = the command path.
 * Preserves every other hook event AND every other SessionStart matcher-group
 * (unrelated hooks the operator already has). If a SessionStart entry already
 * invokes `command`, it is a no-op (no duplicate) — even if the matcher/timeout
 * were hand-tweaked, we do NOT clobber the operator's version.
 *
 * Claude Code settings hook shape:
 *   { hooks: { SessionStart: [ { matcher, hooks: [ { type:"command", command, timeout } ] } ] } }
 */
export function upsertSessionStartHook(
  root: Record<string, unknown> | null,
  spec: SessionStartHookSpec,
): MergeResult {
  const out: Record<string, unknown> = { ...(root ?? {}) };
  const hooks: Record<string, unknown> = {
    ...((out.hooks as Record<string, unknown> | undefined) ?? {}),
  };
  const sessionStart: unknown[] = Array.isArray(hooks.SessionStart)
    ? [...(hooks.SessionStart as unknown[])]
    : [];

  // Dedup by command path across ALL existing SessionStart groups.
  const alreadyPresent = sessionStart.some((group) => {
    const inner = (group as { hooks?: unknown[] })?.hooks;
    return (
      Array.isArray(inner) &&
      inner.some((h) => (h as { command?: string })?.command === spec.command)
    );
  });
  if (alreadyPresent) {
    // Preserve the operator's existing entry verbatim — no clobber, no dup.
    out.hooks = { ...hooks, SessionStart: sessionStart };
    return { root: out, changed: false };
  }

  sessionStart.push({
    matcher: spec.matcher,
    hooks: [
      {
        type: "command",
        command: spec.command,
        ...(spec.timeout !== undefined ? { timeout: spec.timeout } : {}),
      },
    ],
  });
  out.hooks = { ...hooks, SessionStart: sessionStart };
  return { root: out, changed: true };
}
