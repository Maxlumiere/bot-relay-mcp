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
 * SHIPPING-DEFECT guard (2026-07-23): under a test harness, UNCONDITIONALLY
 * refuse to write the real account's user-scope config files.
 * `tests/v2-3-0-profiles.test.ts` ran the real installer without redirecting
 * the home dir, so every `npm test` — any contributor's, any audit
 * worktree's — silently rewrote the REAL `~/.claude.json` +
 * `~/.claude/settings.json` to point at whichever checkout ran the suite (an
 * unmerged /private/tmp audit build, or a percent-encoded path that doesn't
 * exist). Same class as the launchd install Steph flagged (#116 /
 * RELAY_SKIP_DAEMON) — that fix covered one symptom of the pattern; this
 * covers the pattern at the only JSON-write chokepoint.
 *
 * The basis is the SYSTEM ACCOUNT home (os.userInfo().homedir — read from the
 * account database, immune to a sandboxed $HOME), not os.homedir(). codex
 * #125 audit: a first version keyed on env-var PRESENCE, on the claim that a
 * HOME-sandboxed subprocess cannot tell the real home apart from inside —
 * false: userInfo() can. Presence-keying was bypassable by pointing the
 * redirect AT the real home; account-home keying refuses the real paths no
 * matter what the environment claims, while true sandboxes (a temp HOME or a
 * temp RELAY_CLAUDE_HOME) resolve to different paths and pass untouched.
 * Fallback to os.homedir() only if userInfo() throws (no account entry —
 * containers with unmapped uids), documented and strictly-less-strict there.
 * The suite-wide tripwire (tests/global-user-config-tripwire.ts) backstops
 * anything this can't see. THROW, not skip: a silently-skipped write would
 * let a test certify an install that never happened.
 */
let accountHomeOverride: string | null = null;
/** Test-only (pattern: db.ts _resetAuditPurgeCounterForTests): lets the guard's
 *  own negative controls exercise the FULL chokepoint against a temp "account
 *  home" — a broken guard then writes a temp file, never the real config. */
export function _setAccountHomeForTests(p: string | null): void {
  accountHomeOverride = p;
}

function accountHome(): string {
  if (accountHomeOverride) return accountHomeOverride;
  try {
    const h = os.userInfo().homedir;
    if (h) return h;
  } catch {
    /* unmapped uid (some containers) — fall through */
  }
  return os.homedir();
}

/**
 * Canonicalize a path that may not exist yet: realpath the deepest EXISTING
 * ancestor (following symlinks), then re-append the non-existent tail.
 * codex #125 blocker 2: lexical path.resolve equality is symlink-bypassable —
 * `alias -> home` makes `alias/.claude.json` land in `home/.claude.json`
 * while resolving unequal. Canonicalizing BOTH sides closes that.
 */
function canonicalize(p: string): string {
  let base = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(base);
      return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
    } catch {
      const parent = path.dirname(base);
      if (parent === base) return path.resolve(p); // nothing on the path exists
      tail.push(path.basename(base));
      base = parent;
    }
  }
}

export function assertNotRealUserConfigWrite(filePath: string): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") return;
  const resolved = canonicalize(filePath);
  const home = accountHome();
  const guarded = [
    path.join(home, ".claude.json"),
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".bot-relay", "config.json"),
  ];
  if (guarded.some((real) => canonicalize(real) === resolved)) {
    throw new Error(
      `[config-guard] refusing to write the REAL user config ${resolved} from inside a test harness. ` +
        `This is the account's actual config (os.userInfo().homedir) — no environment variable makes ` +
        `writing it safe in a test. Sandbox user-scope writes: point RELAY_CLAUDE_HOME / RELAY_CONFIG_PATH ` +
        `(or the subprocess HOME) at a temp dir.`,
    );
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

/**
 * Is `command` the relay's SessionStart hook (`hooks/check-relay.sh`)? The
 * DETECTION / exact-match predicate — used where a false positive is expensive
 * (the installer's dedup; the tripwire's precise-watch set). NOT the only relay-
 * hook predicate; see "three predicates, three certainties" below.
 *
 * WHAT IT GUARANTEES — and what it does NOT (codex flagged three rounds of
 * over-claim on this one function; state the limit first). It is PRECISE FOR THE
 * FORMS WE EMIT: quoteForHookCommand only ever produces a single-quoted path, and
 * this owns exactly those + the legacy bare no-space path, and rejects the shapes
 * we never emit (`echo …`, unquoted `$()`/`;`, double-quoted, unquoted-whitespace).
 * It is NOT a general "is this really a relay invocation" oracle: the single-quote
 * branch owns ANY `'…/hooks/check-relay.sh'` BY SHAPE, so it DELIBERATELY
 * OVER-OWNS some foreign quoted paths — e.g. `'/foreign/hooks/check-relay.sh'` and
 * `'/bin/bash /x/hooks/check-relay.sh'` (which reads as one literal path token, not
 * a bash call). That over-ownership is WATCH-ONLY: its worst case is a false
 * tripwire ALARM (the accepted direction), never a destructive migration write
 * (migration uses exact-literal match, not this). We accept it because
 * disambiguating a single-quoted string's INTENT is undecidable and the cost is
 * only an alarm.
 *
 * THE RULE (two forms — init now emits only the first):
 *   - SINGLE-QUOTED `'…'`: inside single quotes every byte is literal, so it is ONE
 *     token — own by SHAPE, no metachar check: inner starts "/" and ends
 *     "/hooks/check-relay.sh". This is quoteForHookCommand's canonical output, incl.
 *     roots with `$`, `'`, backticks, `;` (all literal + safe inside `'…'`).
 *   - OTHERWISE (unquoted / double-quoted): must be a BARE SAFE absolute path —
 *     starts "/", ends the tail, NO shell metachar (|;&$<>`"CR LF), NO whitespace.
 * REJECTED: `echo /foreign/…`, `/bin/bash /foreign/…`, `/bin/bash foreign/…`,
 * wrong parent, .bak/dir suffix, bare basename, an UNQUOTED `$()`/`;` path
 * (metachar), a DOUBLE-quoted command (we never emit one — double quotes don't
 * stop expansion), an unquoted SPACED path (undecidable — see below). ACCEPTED:
 * init's single-quoted canonical (any root), a legacy raw NO-SPACE path, a
 * `%20`-fossil path.
 *
 * L4 AT THE HELPER LEVEL (ADR-0015 — codex #139 v4). quoteForHookCommand began as
 * a DISPLAY helper (quote only on whitespace). It was moved onto the install path,
 * where its output is EXECUTED as shell — a no-whitespace `$()`/apostrophe root
 * shipped RAW = command injection. A signal is authorization-grade only if its
 * CONTRACT says so; a quoting fn is security-grade only if its contract says it
 * handles shell metacharacters. Re-derive the contract when you move a helper onto
 * a new consequence — do not assume the name still fits. Fixed by ALWAYS
 * single-quoting; the classifier's single-quote branch reflects that canonical.
 *
 * WHY UNQUOTED-WITH-WHITESPACE IS NOT OWNED — the load-bearing decision.
 * `/a b/c` is EITHER the single path "/a b/c" OR the two tokens "/a" and "b/c",
 * and nothing in the string settles it without quoting or the filesystem. So a
 * real spaced install root (`/Users/x/Claude AI/…/check-relay.sh`) is
 * SYNTACTICALLY INDISTINGUISHABLE from an interpreter + relative script
 * (`/bin/bash foreign/…/check-relay.sh`). That is not a parser gap; it is a
 * property of the input. Standing rule: NO IRREVERSIBLE ACTION ON AN UNDECIDABLE
 * PREDICATE — quarantine it or make a caller assert it. So we DON'T own it here;
 * the operator makes it decidable by running `relay init`, which quotes it.
 *
 * THREE PREDICATES, THREE CERTAINTIES (ADR-0015, generalizes L2/L3 — the level of
 * certainty required scales with the CONSEQUENCE of a false positive):
 *   - DETECTION / exact-match (this fn) → drives dedup + precise watch → must be
 *     PRECISE, uniformly conservative on the undecidable class.
 *   - WATCH (tripwire ambiguous-legacy marker) → drives only an ALARM → may be
 *     BROADER; its worst case is a false alarm, so it may cover the undecidable
 *     class — but its message must NOT overstate ownership (see the tripwire).
 *   - MIGRATION (installHook) → drives a DESTRUCTIVE write → uses NO predicate at
 *     all: EXACT LITERAL match against the string THIS install root would have
 *     written. A heuristic authorizing a destructive write is the #128 defect.
 *
 * NOTE — installHook's migration does NOT call this predicate; it exact-matches
 * the literal string this root would have written. Detect and migrate ask
 * different questions with different failure costs; they are deliberately not one
 * shared predicate (the earlier "L4 single source" framing was withdrawn).
 */
export function isRelayCheckHookCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const s = command.trim();
  // init's canonical form is SINGLE-quoted (quoteForHookCommand). Inside `'…'`
  // every byte is LITERAL, so the command is ONE token and the inner is a bare
  // path — own it by SHAPE, with NO metacharacter check: a `$`/`;`/backtick inside
  // single quotes is literal and safe, and IS exactly what we now emit for a root
  // that contains one (e.g. `/tmp/O'Hare/…`, `/x/$(id)/…`). We own the canonical
  // string; the region watches it verbatim.
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    const inner = s.slice(1, -1);
    return inner.startsWith("/") && inner.endsWith("/hooks/check-relay.sh");
  }
  // Otherwise it must be a BARE, unquoted, SAFE absolute path — the legacy
  // no-space raw form. A shell metacharacter means a command LINE, not a path;
  // unquoted whitespace is UNDECIDABLE (`/a b/c` is one path or two tokens; a
  // spaced install root is indistinguishable from `/bin/bash foreign/…`) → not
  // owned (the tripwire WATCHES that shape separately, watch-only). `"` is in the
  // metachar set deliberately: we NEVER emit a double-quoted command (double
  // quotes do NOT stop `$()`/backtick expansion), so a double-quoted string is not
  // our canonical and is conservatively not owned.
  if (!s.startsWith("/")) return false; // not `echo <x>` / a relative call
  if (!s.endsWith("/hooks/check-relay.sh")) return false; // exact tail
  if (/[|;&$<>`"\r\n]/.test(s)) return false;
  if (/\s/.test(s)) return false;
  return true;
}

/**
 * Quote a hook-command PATH for embedding in a JSON "command" field. Claude Code
 * runs that string AS SHELL, and `relay init` writes it to the user's real
 * settings.json — so this is a SECURITY writer, not a display helper.
 *
 * ALWAYS SINGLE-QUOTE (codex #139 v4 P1). An earlier "quote only if it has
 * whitespace" was fit for emitting display text; on the shell-executed install
 * path it was a command-injection surface — a NO-whitespace root like
 * `/tmp/O'Hare/…` (unbalanced quote → broken hook) or `/x/$(id)/…` (bash runs
 * `id`) shipped RAW. Single-quoting is uniform and TOTAL: inside `'…'` every byte
 * is literal — `$ ` backtick `; & | > < * ? "` `\` space, apostrophes — nothing
 * expands. The only escape needed is the embedded single-quote, closed-reopened
 * as `'\''` (POSIX). No metacharacter blacklist — a blacklist is the wrong shape
 * for a quoting function; unconditional quoting is the defensible one.
 *
 * REFUSES a newline/CR-bearing path: no safe SINGLE-LINE shell command exists for
 * it (and both watch predicates reject control chars, so it would be unwatchable).
 * The one shared impl — `relay init` (installHook) and `relay generate-hooks` both
 * call it — so every emitted hook command is the canonical, precisely-ownable
 * single-quoted form.
 */
export function quoteForHookCommand(p: string): string {
  if (!canQuoteForHookCommand(p)) {
    throw new Error(
      `[config] refusing to write a hook command for a path containing a newline/CR: ${JSON.stringify(p)} — ` +
        `no safe single-line shell command exists for it. Reinstall from a path without control characters.`,
    );
  }
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Would `quoteForHookCommand(p)` succeed? The PREFLIGHT predicate — a single
 * source with quoteForHookCommand's throw condition, so init can validate BEFORE
 * it writes anything (a refusal must not be a partial commit — codex #139 v6 P1).
 * Only a newline/CR-bearing path is unquotable; every other byte single-quotes.
 */
export function canQuoteForHookCommand(p: string): boolean {
  return !/[\r\n]/.test(p);
}

/**
 * DETERMINISTIC migration of a SessionStart hook command — EXACT LITERAL match,
 * NO classifier, NO resemblance. If any SessionStart hook's command is EXACTLY
 * `rawCommand` (the unquoted string a prior `installHook` wrote for THIS install
 * root) and `rawCommand !== canonicalCommand` (i.e. the root has spaces and the
 * raw form needs quoting), rewrite exactly that string to `canonicalCommand`.
 *
 * WHY EXACT-MATCH AND NOT isRelayCheckHookCommand: this drives a DESTRUCTIVE write
 * (it replaces an entry). A heuristic authorizing a destructive write is the #128
 * defect — a fuzzy predicate is fuzzy at the edges and the edges are where an
 * operator's own config lives. The installer KNOWS the exact string it would have
 * written, so it needs no predicate. Any shape it does not recognize byte-for-byte
 * (a different root, a `%20` path from elsewhere) is LEFT ALONE — the tripwire
 * surfaces those loudly; migrating them would be guessing.
 */
export function migrateRawHookCommand(
  root: Record<string, unknown> | null,
  rawCommand: string,
  canonicalCommand: string,
): MergeResult {
  const out: Record<string, unknown> = { ...(root ?? {}) };
  if (rawCommand === canonicalCommand) return { root: out, changed: false }; // no-op (no-space install)
  const hooks: Record<string, unknown> = { ...((out.hooks as Record<string, unknown> | undefined) ?? {}) };
  if (!Array.isArray(hooks.SessionStart)) return { root: out, changed: false };
  let changed = false;
  const sessionStart = (hooks.SessionStart as unknown[]).map((group) => {
    const inner = (group as { hooks?: unknown[] })?.hooks;
    if (!Array.isArray(inner)) return group;
    const newInner = inner.map((h) => {
      if ((h as { command?: unknown })?.command === rawCommand) {
        changed = true;
        return { ...(h as Record<string, unknown>), command: canonicalCommand };
      }
      return h;
    });
    return { ...(group as Record<string, unknown>), hooks: newInner };
  });
  if (!changed) return { root: out, changed: false };
  out.hooks = { ...hooks, SessionStart: sessionStart };
  return { root: out, changed: true };
}
