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
  /** The command line (argv) — used to match the agent binary. */
  command: string;
}

export interface AgentProcess {
  pid: number;
  startedAt: string;
}

/**
 * Default agent-binary matcher. The agent CLI's argv contains its name
 * (claude/codex). Deliberately argv-based (not comm) because the CLIs commonly
 * run under a generic runtime (`node …/claude`, `node …/codex`). Case-
 * insensitive, word-ish boundary so the name anywhere in argv matches but a
 * random substring (e.g. a path component) is unlikely to collide. The relay's
 * own process (argv contains the relay entrypoint) is excluded by the caller.
 *
 * Scope is honest: this covers claude + codex out of the box. It is NOT
 * "any MCP client" — an unrecognized agent CLI falls back to age-based presence
 * (safe). Operators running other CLIs extend coverage via the
 * RELAY_AGENT_PROCESS_PATTERN env var (an alternation merged in below).
 */
export const DEFAULT_AGENT_PATTERN = /(^|[^a-z0-9])(claude|codex)([^a-z0-9]|$)/i;

/**
 * Resolve the agent-binary matcher, broadened by RELAY_AGENT_PROCESS_PATTERN
 * when set (a regex source string, e.g. "aider|goose|my-agent-cli"). Invalid
 * regexes are ignored (→ default only) so a bad env var can never crash the
 * startup walk. The custom alternation is OR'd with the claude/codex default.
 */
export function resolveAgentPattern(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): RegExp {
  const extra = env.RELAY_AGENT_PROCESS_PATTERN?.trim();
  if (!extra) return DEFAULT_AGENT_PATTERN;
  try {
    return new RegExp(`(^|[^a-z0-9])(claude|codex|${extra})([^a-z0-9]|$)`, "i");
  } catch {
    return DEFAULT_AGENT_PATTERN;
  }
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
  return parseProcessTable(run("ps", ["-axo", "pid=,ppid=,lstart=,command="]));
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
  selfExcludePattern = /dist[/\\]index\.js|bot-relay/i,
): AgentProcess | null {
  let cur = table.get(selfPid);
  let depth = 0;
  while (cur && cur.ppid > 1 && depth < 64) {
    const parent = table.get(cur.ppid);
    if (!parent) break;
    if (agentPattern.test(parent.command) && !selfExcludePattern.test(parent.command)) {
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
