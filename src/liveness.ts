// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.13.0 — presence liveness.
 *
 * The relay couldn't tell ALIVE-AND-IDLE from CLOSED: an open terminal that is
 * just waiting stops bumping `last_seen` (observation isn't liveness, v1.3), so
 * the age-based presence derivations promoted it to offline/closed even though
 * its process was alive. This module adds a *positive* liveness signal by
 * probing the AGENT PROCESS specifically.
 *
 * Why the agent process, not the PID chain: the Tether handshake stores
 * `host_shell_pids`, an ANCESTRY chain (hook shell → … → agent → controlling
 * shell → terminal). Probing "any PID in the chain" is wrong — the shell /
 * terminal ANCESTORS outlive the agent, so a dead agent would read alive while
 * its terminal stays open. We instead identify the agent's OWN process (the
 * claude/codex CLI) by walking the relay stdio server's ancestry once at
 * startup and matching the agent binary; that PID dies exactly when the agent
 * exits or crashes. A start-time token guards against PID reuse.
 *
 * Two host-scoping rules keep this safe:
 *   1. A PID is only probed when the agent's `host_id` (OS machine GUID)
 *      matches THIS relay's own GUID — a PID is meaningless (and could
 *      false-match an unrelated process) across hosts.
 *   2. The GUID is computed with the exact same OS source + extraction the
 *      SessionStart hook and the Tether extension use, so values compare
 *      byte-for-byte.
 *
 * Universal capture POINT, accurate identification: the ancestry walk runs in
 * the stdio MCP server startup, which EVERY stdio agent spawns as a child — so
 * the capture mechanism is agent-agnostic. The agent CLI is then IDENTIFIED by
 * an argv match covering claude + codex out of the box, EXTENSIBLE via
 * RELAY_AGENT_PROCESS_PATTERN for other CLIs. An agent whose argv doesn't match
 * (and isn't configured) simply gets no positive liveness signal → it falls
 * back to age-based presence (safe, byte-identical to pre-v2.13). Managed/script
 * agents bypass identification entirely by self-reporting their PID on register.
 * Pure parse functions are separated from the impure command runner so
 * extraction is unit-testable.
 */
import { execFileSync } from "node:child_process";
import { log } from "./logger.js";
import { profileProcessPatternSource } from "./agent-cli-profiles.js";

export type HostPlatform = "darwin" | "linux" | "win32" | string;

/** macOS: IOPlatformUUID from `ioreg -rd1 -c IOPlatformExpertDevice`. */
export function parseDarwinMachineGuid(ioregStdout: string): string | null {
  const m = ioregStdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/** Linux: /etc/machine-id is a single line of 32 hex chars. */
export function parseLinuxMachineId(raw: string): string | null {
  const id = raw.trim();
  return /^[0-9a-fA-F]{32}$/.test(id) ? id : null;
}

/** Windows: MachineGuid from `reg query HKLM\…\Cryptography /v MachineGuid`. */
export function parseWindowsMachineGuid(regStdout: string): string | null {
  const m = regStdout.match(/MachineGuid\s+REG_SZ\s+([^\s]+)/i);
  return m ? m[1] : null;
}

/** Injectable command runner — returns stdout, or "" on any failure. */
export type CommandRunner = (cmd: string, args: string[]) => string;

const defaultRunner: CommandRunner = (cmd, args) => {
  try {
    // v2.14.1 — force LC_ALL=C so `ps -o lstart=` yields a DETERMINISTIC,
    // locale-independent start-time. The agent_pid_start token is written by
    // the SessionStart hook (user shell) and re-read here at probe time under
    // launchd; without a pinned locale the two could format the same start
    // time differently → a live agent's token wouldn't match → it would read
    // DEAD. The other commands here (ioreg/cat/reg) are locale-insensitive, so
    // pinning C is safe for all.
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    });
  } catch {
    return "";
  }
};

/**
 * Compute this host's stable OS machine GUID. Returns null on unsupported
 * platforms or extraction failure (caller then treats every agent as
 * cross-host → no PID probe → age-based fallback, the safe default).
 */
export function machineGuid(
  platform: HostPlatform = process.platform,
  run: CommandRunner = defaultRunner,
): string | null {
  try {
    if (platform === "darwin") {
      return parseDarwinMachineGuid(run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]));
    }
    if (platform === "linux") {
      return parseLinuxMachineId(run("cat", ["/etc/machine-id"]));
    }
    if (platform === "win32") {
      return parseWindowsMachineGuid(
        run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]),
      );
    }
    return null;
  } catch {
    return null;
  }
}

let _ownHostId: string | null | undefined;

/**
 * This relay's own machine GUID, computed once and memoized. `null` when it
 * can't be determined — callers MUST treat null as "can't host-scope" and skip
 * the PID probe.
 */
export function getOwnHostId(): string | null {
  if (_ownHostId === undefined) {
    _ownHostId = machineGuid();
    if (_ownHostId === null) {
      log.debug("[liveness] own host_id unavailable — PID-liveness probe disabled (cross-host fallback only)");
    }
  }
  return _ownHostId;
}

/** Test-only: reset the memoized own-host-id so tests can re-derive it. */
export function _resetOwnHostIdForTests(value?: string | null): void {
  _ownHostId = value === undefined ? undefined : value;
}

/** Injectable kill probe (process.kill semantics: throws on dead/forbidden). */
export type KillProbe = (pid: number, signal: 0) => void;

/**
 * Is `pid` a live process on THIS host? Uses the signal-0 probe:
 *   - success            → alive
 *   - EPERM (cross-user) → alive (process exists, just not ours)
 *   - ESRCH / anything   → dead
 * Mirrors the probe in src/instance.ts. Non-positive / non-integer pids → dead.
 */
export function isPidAlive(pid: number, kill: KillProbe = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// --- Agent-process identification (ancestry walk + binary match) ---

export interface ProcEntry {
  pid: number;
  ppid: number;
  /** The process's start time, as an opaque stable token (PID-reuse guard). */
  startedAt: string;
  /** The full command line (argv0 + args) — used for the runtime-script check + self-exclude. */
  command: string;
  /**
   * The executable's `comm` (basename source), captured separately because on
   * macOS it can itself contain spaces (full exec path) and so can't share a
   * line with the greedy `command` field. Optional: hand-built test tables and
   * the parse-from-`command` path leave it unset → we fall back to argv[0].
   */
  comm?: string;
}

export interface AgentProcess {
  pid: number;
  startedAt: string;
}

/**
 * Default agent matcher — an EXACT-basename test, NOT a full-command-line regex.
 * The matcher is applied to a process's IDENTITY (the executable basename, or —
 * for a runtime-hosted CLI like `node …/claude` — the script basename), never
 * the raw `ps command=` string. This is load-bearing: a substring/argv match
 * against the full command false-hits any process whose PATH contains "claude"
 * or "codex" (e.g. a checkout under `…/Claude AI/…`), stamping a non-agent
 * ancestor as the agent — so presence would read a dead agent alive while that
 * ancestor lives. See processIdentityIsAgent for how identity is derived.
 *
 * Scope is honest: covers claude + codex out of the box. An unrecognized CLI
 * falls back to age-based presence (safe). Operators extend coverage via
 * RELAY_AGENT_PROCESS_PATTERN (an alternation of BASENAMES, e.g. "aider|goose").
 */
// Derived from the agent-cli-profile registry (src/agent-cli-profiles.ts) — the
// single source of truth for supported CLIs. Adding a profile widens this pattern
// automatically; no hardcoded `claude|codex` here.
export const DEFAULT_AGENT_PATTERN = new RegExp(`^(${profileProcessPatternSource()})$`, "i");

/** Runtimes that host an agent CLI as a script — for these, the SCRIPT basename is the identity. */
const RUNTIME_BASENAMES = /^(node|nodejs|bun|deno|python|python[23](\.\d+)?|ruby)$/i;

/**
 * Resolve the agent matcher, broadened by RELAY_AGENT_PROCESS_PATTERN when set
 * (an alternation of executable/script BASENAMES, e.g. "aider|goose|my-cli").
 * Anchored to a whole basename (^…$) so it can never match a mid-path segment.
 * Invalid regexes are ignored (→ default only) so a bad env var can't crash the
 * startup walk.
 */
export function resolveAgentPattern(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): RegExp {
  const extra = env.RELAY_AGENT_PROCESS_PATTERN?.trim();
  if (!extra) return DEFAULT_AGENT_PATTERN;
  try {
    return new RegExp(`^(${profileProcessPatternSource()}|${extra})$`, "i");
  } catch {
    return DEFAULT_AGENT_PATTERN;
  }
}

/** basename of a path, tolerant of both POSIX and Windows separators + trailing slashes. */
function pathBasename(p: string): string {
  const cleaned = p.replace(/[/\\]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** Script file extensions that mark a runtime's argv[1] as a COMPLETE script token. */
const SCRIPT_EXT = /\.(js|cjs|mjs|ts|cts|mts|tsx|jsx|py|rb|sh|bash|pl|php|lua)$/i;

/**
 * For a runtime-hosted CLI (`node …/claude`), extract the SCRIPT basename — the
 * identity — from argv[1]. This is a SECURITY ANCHOR: a process wrongly judged
 * to be the agent reads a dead agent alive, which is strictly worse than
 * missing a live one (a miss just falls back to age-based presence). So the
 * rule is CONSERVATIVE — only ARGV[1] can ever be the script, never a later
 * token, because a later token is an ARGUMENT (path-valued or not) and
 * arguments must never control identity:
 *
 *   1. argv[1] carries a known script extension → it is the complete script;
 *      use its basename verbatim and IGNORE all following tokens (they are args).
 *      `node /tmp/runner.js /tmp/codex` → "runner.js" (NOT "codex").
 *   2. argv[1] has no extension AND the next positional token is path-like
 *      (has a separator) → argv[1] is likely a FRAGMENT of a space-containing
 *      path, so the true script is AMBIGUOUS → decline (null → age-based).
 *      `node /x/Claude AI/not-agent.js` → null (NOT "Claude").
 *   3. argv[1] has no extension and no path-like positional follower → it is an
 *      unambiguous bare script; use its basename.
 *      `node /usr/local/bin/claude` → "claude"; `node /a/b/codex serve` → "codex".
 *
 * Options (leading `-…`) are skipped/ignored; they never make argv[1] ambiguous.
 */
function scriptBasenameForRuntime(command: string): string | null {
  const parts = command.trim().split(/\s+/);
  let i = 1;
  while (i < parts.length && parts[i].startsWith("-")) i++; // skip runtime flags
  if (i >= parts.length) return null; // runtime with no script
  const first = parts[i];
  // (1) complete script token → its basename; args after it are irrelevant.
  if (SCRIPT_EXT.test(first)) return pathBasename(first);
  // (2) ambiguous: a path-like POSITIONAL arg follows a no-extension argv[1] —
  // could be a spaced-path fragment or a path-valued arg. Either way, decline.
  for (let j = i + 1; j < parts.length; j++) {
    if (parts[j].startsWith("-")) break; // an option ends the ambiguity window
    if (parts[j].includes("/") || parts[j].includes("\\")) return null;
    break; // a bare non-path token (subcommand like "serve") → argv[1] is complete
  }
  // (3) unambiguous bare script token.
  return pathBasename(first);
}

/**
 * True iff a process is an agent CLI, judged by IDENTITY (basenames) not the
 * full command string. Order: (1) executable basename — `comm` when available,
 * else argv[0] — matched exactly; (2) if the executable is a known runtime, the
 * hosted SCRIPT basename matched exactly. Never regex-tests the raw command, so
 * a "claude"/"codex" substring in a directory path cannot false-match. Exported
 * for the adversarial regression tests.
 */
export function processIdentityIsAgent(
  command: string,
  comm: string | undefined,
  agentBasename: RegExp = DEFAULT_AGENT_PATTERN,
): boolean {
  const argv0 = command.trim().split(/\s+/)[0] ?? "";
  const execBase = pathBasename(comm && comm.trim() ? comm.trim() : argv0);
  if (agentBasename.test(execBase)) return true;
  if (RUNTIME_BASENAMES.test(execBase)) {
    const script = scriptBasenameForRuntime(command);
    if (script && agentBasename.test(script)) return true;
  }
  return false;
}

/**
 * Parse `ps -axo pid=,ppid=,lstart=,command=` output into a pid→entry map.
 * `lstart` is a fixed-width human date (the process start clock time) — stable
 * for the life of the process, so it serves as the reuse-guard token. Pure.
 */
export function parseProcessTable(psStdout: string): Map<number, ProcEntry> {
  const table = new Map<number, ProcEntry>();
  for (const line of psStdout.split("\n")) {
    // pid ppid <lstart: 5 whitespace-separated fields> command...
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    table.set(pid, { pid, ppid, startedAt: m[3].trim(), command: m[4].trim() });
  }
  return table;
}

function buildProcessTable(run: CommandRunner): Map<number, ProcEntry> {
  // POSIX only here (macOS/Linux). Windows capture is a documented follow-on
  // (the daemon there falls back to age-based, same as cross-host).
  const table = parseProcessTable(run("ps", ["-axo", "pid=,ppid=,lstart=,command="]));
  // Second pass: capture `comm` (the executable basename source) in its OWN ps
  // call — comm can contain spaces on macOS (full exec path), so it can't share
  // a line with the greedy `command` field. `pid=,comm=` puts comm last, so
  // "pid rest-is-comm" parses unambiguously even when comm has spaces.
  for (const line of run("ps", ["-axo", "pid=,comm="]).split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const entry = table.get(Number(m[1]));
    if (entry) entry.comm = m[2].trim();
  }
  return table;
}

/**
 * Walk the ancestry of `selfPid` (the relay stdio server) toward init and
 * return the first ancestor whose argv matches the agent binary — i.e. the
 * agent's own CLI process. Excludes any process whose argv matches
 * `selfExcludePattern` (the relay entrypoint) so we never bind to ourselves.
 * Returns null when no agent ancestor is found (caller → age-based fallback).
 */
export function findAgentProcess(
  selfPid: number,
  table: Map<number, ProcEntry>,
  agentPattern: RegExp = DEFAULT_AGENT_PATTERN,
  // The relay's own stdio server is excluded by its ENTRYPOINT (dist/index.js),
  // NOT the repo path — agents legitimately launch from a checkout whose path
  // contains "bot-relay" (the old `|bot-relay` alternative over-excluded them).
  selfExcludePattern = /dist[/\\]index\.js/i,
): AgentProcess | null {
  let cur = table.get(selfPid);
  let depth = 0;
  while (cur && cur.ppid > 1 && depth < 64) {
    const parent = table.get(cur.ppid);
    if (!parent) break;
    if (
      !selfExcludePattern.test(parent.command) &&
      processIdentityIsAgent(parent.command, parent.comm, agentPattern)
    ) {
      return { pid: parent.pid, startedAt: parent.startedAt };
    }
    cur = parent;
    depth++;
  }
  return null;
}

/**
 * Identify the agent process that spawned THIS relay stdio server. One `ps`
 * at startup (zero-token, no loop). Returns null if no agent ancestor matched
 * → the agent simply gets no positive liveness signal (age-based fallback).
 */
export function detectAgentProcess(
  selfPid: number = process.pid,
  run: CommandRunner = defaultRunner,
  agentPattern: RegExp = resolveAgentPattern(),
): AgentProcess | null {
  try {
    return findAgentProcess(selfPid, buildProcessTable(run), agentPattern);
  } catch {
    return null;
  }
}

/** Read a live PID's start-time token (reuse guard). Null if unreadable. */
export function processStartedAt(pid: number, run: CommandRunner = defaultRunner): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const out = run("ps", ["-o", "lstart=", "-p", String(pid)]).trim();
  return out.length > 0 ? out : null;
}

/**
 * Is the recorded agent process still the SAME live process? Alive iff the PID
 * is live AND (when both start-times are readable) they match — a reused PID
 * (new process, different start-time) reads dead.
 *
 * EXPLICIT TRADEOFF (intentional): if the current start-time can't be read
 * (`ps` restricted/failed, or no token was recorded), we fall back to
 * PID-liveness ALONE. This deliberately errs toward NOT falsely closing a live
 * agent at the cost of a weaker reuse guard. The exposure is narrow: a reused
 * PID only false-reads-alive when (a) the original agent's row wasn't cleared
 * on close — close clears the anchor (HIGH #1) — AND (b) the OS recycled that
 * exact PID within the ~120s alive window AND (c) ps can't read the new
 * process's start-time. We accept this for the relay-side foundation; the
 * cross-host heartbeat follow-on removes the PID dependency entirely.
 */
export function isAgentProcessAlive(
  pid: number,
  expectedStartedAt: string | null | undefined,
  run: CommandRunner = defaultRunner,
  kill: KillProbe = process.kill,
): boolean {
  if (!isPidAlive(pid, kill)) return false;
  if (!expectedStartedAt) return true; // no recorded token → PID-liveness only
  const current = processStartedAt(pid, run);
  if (current === null) return true; // can't validate → trust PID-liveness
  return current === expectedStartedAt;
}

// --- v2.19.0 liveness cascade fallback (Sentinel/liveness-derivation) ---
// The verdict used to anchor ONLY on the agent's own pid, so an agent with no
// registered agent_pid (or a stale one) read `unknown` → surfaced as the
// age-based "offline" lie even while its process was trivially alive. This adds
// one ALIVE-only fallback (it can confirm alive; its absence never proves dead),
// host-scoped by the caller (host_id must equal this relay's own GUID) and
// cache-bounded.
//
// NOTE: host_shell_pids is DELIBERATELY not probed as a fallback — see the
// verdict cascade in db.ts. The Tether ancestry chain includes the terminal/
// shell, which OUTLIVE the agent, so "any host_shell_pid alive" would false-read
// a crashed agent alive (the v2.13.0 §3 contract). The argv scan below finds the
// agent's OWN process instead, without that false-alive.

/**
 * Last-resort ALIVE probe: does a live process on THIS host advertise
 * `RELAY_AGENT_NAME="<name>"` in its argv? (The launch path that fixed Codex
 * cold-start puts the name in the command line.) Implemented as a LITERAL
 * both-side-anchored substring search of `ps` command lines — NOT a `pgrep -f`
 * regex — so:
 *   - the surrounding quotes anchor both sides: agent "foo" cannot match a live
 *     "foobar" / "foo-x" process (the needle `RELAY_AGENT_NAME="foo"` is not a
 *     substring of `RELAY_AGENT_NAME="foobar"`);
 *   - a literal `includes` has ZERO regex/shell-injection surface (a name with a
 *     `.` or other metachar can't widen the match). Names are allowlisted on
 *     register; we re-validate here belt-and-suspenders and bail on a bad name.
 * Matches ARGV only (ps `command=`), never the environment, so this is exactly
 * the argv-advertised case. Cost is one `ps` — the caller gates it behind the
 * liveness probe cache and only reaches it when the pid probes miss.
 */
export function agentProcessAdvertised(name: string, run: CommandRunner = defaultRunner): boolean {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) return false; // belt-and-suspenders
  const needle = `RELAY_AGENT_NAME="${name}"`;
  const out = run("ps", ["-axo", "command="]);
  if (!out) return false;
  return out.split("\n").some((line) => line.includes(needle));
}
