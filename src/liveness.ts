// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.13.0 — presence liveness.
 *
 * The relay cannot tell ALIVE-AND-IDLE from CLOSED: an open terminal that is
 * just waiting stops bumping `last_seen` (observation isn't liveness, v1.3),
 * so the age-based presence derivations promote it to offline/closed even
 * though its process is alive. This module adds a *positive* liveness signal:
 * on the SAME host, probe the agent's recorded shell-PID chain — if any PID is
 * alive, the terminal is open regardless of idle time.
 *
 * Two host-scoping rules keep this safe:
 *   1. PIDs are only probed when the agent's `host_id` (OS machine GUID)
 *      matches THIS relay's own GUID — a PID is meaningless (and could
 *      false-match an unrelated local process) across hosts.
 *   2. The GUID is computed with the exact same OS source + extraction the
 *      SessionStart hook (hooks/check-relay.sh) and the Tether extension use,
 *      so the values compare byte-for-byte.
 *
 * Pure parse functions are separated from the impure command runner so the
 * extraction is unit-testable without spawning processes.
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
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
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
 * can't be determined (unsupported platform / extraction failure) — callers
 * MUST treat null as "can't host-scope" and skip the PID probe.
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
 * Mirrors the probe in src/instance.ts. Non-positive / non-integer pids are
 * treated as dead.
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

/** True if ANY pid in the chain is alive — a single live ancestor means the
 *  terminal is still open. Empty / null → false. */
export function isAnyPidAlive(pids: number[] | null | undefined, kill: KillProbe = process.kill): boolean {
  if (!pids || pids.length === 0) return false;
  return pids.some((p) => isPidAlive(p, kill));
}
