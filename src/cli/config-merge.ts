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
import crypto from "crypto";

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
