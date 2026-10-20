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
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { systemBinary, type SystemBinaryName } from "./system-binary.js";
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

/**
 * The process START TOKEN, the PID-reuse guard, has ONE spelling:
 * `TZ=UTC LC_ALL=C ps -o lstart= -p PID`, trimmed, plus the literal suffix
 * START_TOKEN_UTC_SUFFIX (" UTC"). `lstart` is a wall-clock date,
 * so BOTH variables are pinned: LC_ALL=C fixes the format (v2.14.1), TZ=UTC fixes
 * the clock. Without the TZ pin, a writer and a reader with different TZ values
 * (a user shell, launchd, a connector) read the same live process differently,
 * and it reads DEAD. The token is compared as a string, never parsed as a date.
 * The bash twin is relay_pid_start in hooks/_vault-helpers.sh; the conformance
 * guard (tests/start-token-utc.test.ts) pins them byte-identical.
 *
 * The SUFFIX is the token's provenance (architect ruling on #296, Codex R1 #1).
 * A bare lstart cannot say which zone printed it: on a UTC-4 host, a pid reused
 * exactly 4 hours later has a local-time lstart equal to the first process's UTC
 * one. So readers DISPATCH on the suffix: a suffixed token is compared ONLY with
 * the UTC producer's suffixed output, an unsuffixed one ONLY with the legacy form.
 * A cross-form match is impossible by construction.
 *
 * "legacy" = the form written before the TZ pin: unsuffixed, LC_ALL=C with the
 * WRITER's TZ, which a default shell leaves unset (/etc/localtime). Readers
 * recompute it with TZ REMOVED, never with their own inherited TZ, and accept it
 * during the transition. KNOWN LIMIT: a writer that ran with an explicit TZ stored a form
 * this cannot recompute; that anchor reads dead until it is restamped (the
 * PostToolUse self-heal, or a window restart). Delete the legacy form once
 * `relay doctor` counts zero live rows in it.
 */
export type StartTokenForm = "utc" | "legacy";

/** The provenance suffix of a UTC start token. The bash twin (RELAY_START_TOKEN_UTC_SUFFIX) is pinned to it by test. */
export const START_TOKEN_UTC_SUFFIX = " UTC";

/**
 * The shape of a RAW start token: `ps -o lstart=` under LC_ALL=C (startTokenEnv), e.g.
 * "Thu Oct  1 07:37:33 2026" (the day is space-padded). INV-LIVE-01 (Codex R1 P2): only this shape is a
 * token. Anything else a runner prints (a "-", a warning, a truncated line) is UNREADABLE: accepted, it
 * would be "a different start", which reads as a different process, which reads as gone.
 */
export const RAW_START_TOKEN_RE = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ 1-3][0-9] [0-2][0-9]:[0-5][0-9]:[0-6][0-9] [0-9]{4}$/;

/** Does this stored token carry the UTC provenance suffix? */
export function isUtcStartToken(token: string): boolean {
  return token.endsWith(START_TOKEN_UTC_SUFFIX);
}

export function startTokenEnv(base: NodeJS.ProcessEnv, form: StartTokenForm = "utc"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, LC_ALL: "C" };
  if (form === "utc") env.TZ = "UTC";
  else delete env.TZ;
  return env;
}

/**
 * Injectable command runner — returns stdout, or "" on any failure. `opts`
 * selects the start-token form; a runner that ignores it reads one form only.
 */
export type CommandRunner = (cmd: string, args: string[], opts?: { startTokenForm?: StartTokenForm }) => string;

/**
 * The tools this module runs: a CLOSED set, each by its trusted ABSOLUTE path (SEC-22, src/system-binary.ts), never
 * through PATH. Any other command is refused (""), so nothing can run through this runner by name (Codex #336 R1 P1:
 * `reg` once hid under a POSIX allowlist entry). The Linux machine id is READ (/etc/machine-id), not a subprocess.
 */
const RUNNER_TOOLS = new Set<SystemBinaryName>(["ps", "ioreg", "reg"]);

const runSystemTool = (cmd: SystemBinaryName, args: string[], opts?: { startTokenForm?: StartTokenForm }): string =>
  // Every command runs under the start-token environment, so `ps -o lstart=` (here and in the process table) is the
  // ONE spelling above. ioreg and reg read neither the locale nor the clock.
  execFileSync(systemBinary(cmd), args, {
    encoding: "utf8",
    timeout: 2000,
    stdio: ["ignore", "pipe", "ignore"],
    env: startTokenEnv(process.env, opts?.startTokenForm ?? "utc"),
    windowsHide: true,
    shell: false,
  });

const defaultRunner: CommandRunner = (cmd, args, opts) => {
  try {
    // A tool of the closed set by its trusted path (a SystemBinaryError, like any failure, reads as "": the callers'
    // safe default); anything else is refused.
    return RUNNER_TOOLS.has(cmd as SystemBinaryName) ? runSystemTool(cmd as SystemBinaryName, args, opts) : "";
  } catch {
    return "";
  }
};

/**
 * Compute this host's stable OS machine GUID. Returns null on unsupported
 * platforms or extraction failure (caller then treats every agent as
 * cross-host → no PID probe → age-based fallback, the safe default).
 */
/** /etc/machine-id's text, or "" when it cannot be read (the parser then answers null: the safe default). */
function readMachineIdFile(): string {
  try {
    return fs.readFileSync("/etc/machine-id", "utf-8");
  } catch {
    return "";
  }
}

export function machineGuid(
  platform: HostPlatform = process.platform,
  run: CommandRunner = defaultRunner,
): string | null {
  try {
    if (platform === "darwin") {
      return parseDarwinMachineGuid(run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]));
    }
    if (platform === "linux") {
      // READ, never a subprocess (SEC-22: a planted `cat` first on PATH once decided this host's id).
      return parseLinuxMachineId(readMachineIdFile());
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
 * THE kernel probe for one pid on THIS host (INV-LIVE-01 D1, architect ruling a98ec836): the signal-0
 * probe, tri-state. There is deliberately no boolean form: "anything but EPERM = dead" let an
 * unexpected errno authorize a purge, a teardown or a release.
 *   - alive:   success, or EPERM (it exists; another user's);
 *   - gone:    ESRCH, ONLY: the one answer that may authorize death, deletion or release;
 *   - unknown: any other error (Node's Windows emulation, a future errno), or not a process id. Never
 *              dead: every death-authorizing caller treats it as NO ACTION.
 * A non-positive or non-integer pid is never signalled (kill(0) and kill(-n) probe process GROUPS).
 */
export type PidState = "alive" | "gone" | "unknown";
export function probePid(pid: number, kill: KillProbe = process.kill): PidState {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    kill(pid, 0);
    return "alive";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "gone" : code === "EPERM" ? "alive" : "unknown";
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
 * A process snapshot, and how many of its rows could NOT be read (Codex R2 N3 on #324). A dropped row's
 * pid is missing from the map, so a non-zero `dropped` means the snapshot is INCOMPLETE: a consumer that
 * judges the whole fleet (the deploy check) must not treat what is left as everything.
 */
export type ProcessTable = Map<number, ProcEntry> & { dropped: number };

/**
 * Parse `ps -axo pid=,ppid=,lstart=,command=` output into a pid→entry map.
 * `lstart` is a fixed-width human date (the process start clock time) — stable
 * for the life of the process, so it serves as the reuse-guard token. Pure.
 * A non-empty line that is not a row, or a row whose start is not a token, is DROPPED and COUNTED
 * (INV-LIVE-01): its pid is then missing, which an ancestry walk reports as cannot_judge and a fleet
 * judgement reports as an incomplete snapshot, never as "no such process".
 */
export function parseProcessTable(psStdout: string): ProcessTable {
  const table = Object.assign(new Map<number, ProcEntry>(), { dropped: 0 });
  for (const line of psStdout.split("\n")) {
    if (line.trim().length === 0) continue;
    // pid ppid <lstart: 5 whitespace-separated fields> command...
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
    const pid = m ? Number(m[1]) : NaN;
    if (!m || !RAW_START_TOKEN_RE.test(m[3]) || !Number.isInteger(pid) || pid <= 0) {
      table.dropped++;
      continue;
    }
    table.set(pid, { pid, ppid: Number(m[2]), startedAt: m[3].trim(), command: m[4].trim() });
  }
  return table;
}

export function buildProcessTable(run: CommandRunner = defaultRunner): ProcessTable {
  // POSIX only here (macOS/Linux). Windows capture is a documented follow-on
  // (the daemon there falls back to age-based, same as cross-host).
  const table = parseProcessTable(run("ps", ["-axo", "pid=,ppid=,lstart=,command="], { startTokenForm: "utc" }));
  // The runner printed lstart in UTC: each entry's token is the UTC form, so it
  // carries the suffix exactly as processStartedAt's does.
  for (const entry of table.values()) entry.startedAt += START_TOKEN_UTC_SUFFIX;
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

/**
 * What a read of a process's start token found (INV-LIVE-01, architect ruling 476e65f1). UNREADABLE IS
 * NOT GONE: `ps` times out (a SIGSTOP or a sleep mid-read counts against its 2 s timeout), fails or
 * prints nothing for a process that still runs, and none of that says the process ended.
 *   - start: the token, read now.
 *   - gone: the KERNEL says no such process (`kill(pid, 0)` → ESRCH), probed before `ps` is trusted and
 *     again after an empty read. Never inferred from `ps`.
 *   - unreadable: anything else (the pid exists, or the kernel could not say, and `ps` gave no token).
 * Whether a readable start is the SAME process as an anchor is the caller's comparison (a different
 * start = a different process: also a kernel fact). There is deliberately no null form: every caller
 * must say what it does with each kind.
 */
export type ProcessStart = { kind: "start"; start: string } | { kind: "gone" } | { kind: "unreadable"; why: string };

/**
 * Read a process's start token (reuse guard). The ONE TS producer: every writer, reader and the deploy
 * gate read the token here.
 */
export function processStartedAt(
  pid: number,
  run: CommandRunner = defaultRunner,
  form: StartTokenForm = "utc",
  kill: KillProbe = process.kill,
): ProcessStart {
  // Never signal 0 or a negative pid: kill(0) and kill(-n) probe process GROUPS, not this process.
  if (!Number.isInteger(pid) || pid <= 0) return { kind: "unreadable", why: `not a process id: ${String(pid)}` };
  if (probePid(pid, kill) === "gone") return { kind: "gone" };
  const out = run("ps", ["-o", "lstart=", "-p", String(pid)], { startTokenForm: form }).trim();
  if (RAW_START_TOKEN_RE.test(out)) return { kind: "start", start: form === "utc" ? out + START_TOKEN_UTC_SUFFIX : out };
  if (out.length > 0) return { kind: "unreadable", why: `ps printed no start time for pid ${pid} (unexpected output: ${JSON.stringify(out.slice(0, 40))})` };
  // No token: the read failed, or the process ended between the probe and the read. Only the kernel decides which.
  if (probePid(pid, kill) === "gone") return { kind: "gone" };
  return { kind: "unreadable", why: `ps gave no start time for pid ${pid}, which still exists (timed out, failed or not permitted)` };
}

/** The token when one was read, else null: for IDENTITY and DISPLAY fields only (a sidecar, a record), never a liveness decision. */
export function startOrNull(r: ProcessStart): string | null {
  return r.kind === "start" ? r.start : null;
}

/**
 * Is the process anchored at (pid, start) still running? `same` = the same process; `gone` = the kernel
 * says so (ESRCH), or the pid now holds a DIFFERENT process (another start); `unknown` = its start
 * cannot be read now. A caller that would EXIT, take over or purge acts only on `gone`.
 */
export type AnchorState = "same" | "gone" | "unknown";
export function anchorState(r: ProcessStart, anchorStart: string): AnchorState {
  if (r.kind === "gone") return "gone";
  if (r.kind === "unreadable") return "unknown";
  return r.start === anchorStart ? "same" : "gone";
}

/**
 * What a binder read for a window's start in the LEGACY form: the token, or that
 * the read failed. A failed read is "cannot judge", never "no legacy row"
 * (migrateLegacyBindingAnchor refuses to bind beside a pre-UTC row on it).
 */
export type LegacyStartProbe = { start: string } | { unreadable: true };

export function readLegacyStartProbe(pid: number, run: CommandRunner = defaultRunner, kill: KillProbe = process.kill): LegacyStartProbe {
  const r = processStartedAt(pid, run, "legacy", kill);
  return r.kind === "start" ? { start: r.start } : { unreadable: true };
}

export type StartTokenObservation = "utc" | "legacy" | "mismatch" | "unreadable";

/**
 * Does this stored token name this live pid, and in which form? DISPATCHED on the
 * suffix (one `ps` either way): a suffixed token is compared only with the UTC
 * producer, an unsuffixed one only with the legacy form. "unreadable" = the one
 * read it needs failed.
 */
export function observeStartTokenForm(
  pid: number,
  stored: string,
  run: CommandRunner = defaultRunner,
  kill: KillProbe = process.kill,
): StartTokenObservation {
  const form: StartTokenForm = isUtcStartToken(stored) ? "utc" : "legacy";
  const current = processStartedAt(pid, run, form, kill);
  // A gone process is no longer the stored one: "mismatch" (callers probe the pid first, so it is rare).
  if (current.kind === "gone") return "mismatch";
  if (current.kind === "unreadable") return "unreadable";
  return current.start === stored ? form : "mismatch";
}

/**
 * Is the recorded agent process still the SAME live process? "alive" iff the PID
 * is live AND (when both start-times are readable) they match, in the UTC form or
 * the legacy one (see startTokenEnv); "dead" iff the kernel says the pid is gone
 * (ESRCH) or a readable start differs (a reused PID); "unknown" iff the kernel
 * probe itself could not say (INV-LIVE-01 D1: never dead on an unexpected errno).
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
export type AgentProcessState = "alive" | "dead" | "unknown";
export function agentProcessState(
  pid: number,
  expectedStartedAt: string | null | undefined,
  run: CommandRunner = defaultRunner,
  kill: KillProbe = process.kill,
): AgentProcessState {
  const k = probePid(pid, kill);
  if (k === "gone") return "dead";
  if (k === "unknown") return "unknown";
  if (!expectedStartedAt) return "alive"; // no recorded token → PID-liveness only
  // Either form matching is the same process (the legacy form during the
  // transition); "unreadable" → can't validate → trust PID-liveness.
  return observeStartTokenForm(pid, expectedStartedAt, run, kill) === "mismatch" ? "dead" : "alive";
}

export type AnchorVerdict = "alive" | "dead" | "unverifiable";

/**
 * ADR-0012 (Fork B) — ANCHOR-ONLY liveness verdict. The SHARED canonical rule for
 * the dead-anchor diagnostic (hooks/check-relay.sh) AND the `relay release-binding`
 * gate: exactly the brief's "stored agent PID/start anchor + host_id, probed
 * same-host". The bash `relay_anchor_liveness` mirrors this 1:1 (pinned by the
 * conformance test) so the diagnostic and the remedy can never disagree.
 *
 * DELIBERATELY NOT `computeLivenessVerdict`: that OR's in an argv scan
 * (`agentProcessAdvertised`) which reads a resummon'd argv-advertised agent (e.g.
 * a codex process whose argv carries RELAY_AGENT_NAME) "alive" DESPITE a dead
 * anchor — masking the stale binding and deadlocking the remedy (the bash
 * anchor-only probe would say dead, computeLivenessVerdict would say alive). That
 * argv fallback is correct for the dashboard PRESENCE surface, wrong for a
 * wakeability/eligibility decision. This function reuses the SAME narrow-dead
 * primitive (`agentProcessState`) — no new rule — minus the argv fallback.
 *
 *   - cross-host / no own-host GUID → "unverifiable" (never guess across the
 *     federation boundary);
 *   - no probe-able anchor (agent_pid absent / non-positive) → "unverifiable";
 *   - same-host + anchor → `agentProcessState` (pid gone (ESRCH) or start-time
 *     MISMATCH → dead; pid live + start matched/unreadable → alive; the kernel
 *     probe unable to say → "unverifiable", never dead: INV-LIVE-01 D1).
 */
export function anchorLivenessVerdict(
  row: { host_id?: string | null; agent_pid?: number | null; agent_pid_start?: string | null },
  ownHostId: string | null = getOwnHostId(),
  run: CommandRunner = defaultRunner,
  kill: KillProbe = process.kill,
): AnchorVerdict {
  if (!ownHostId || !row.host_id || row.host_id !== ownHostId) return "unverifiable";
  const pid = row.agent_pid;
  if (!(typeof pid === "number" && pid > 0)) return "unverifiable";
  const st = agentProcessState(pid, row.agent_pid_start ?? null, run, kill);
  return st === "unknown" ? "unverifiable" : st;
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
