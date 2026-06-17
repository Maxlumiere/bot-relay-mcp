// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.3.0 PID-handshake — host identity primitives (VSCode-free, unit-tested).
//
// Two jobs, both cross-platform (macOS / Linux / Windows — H4 ship requirement):
//   1. ANCESTRY: walk a process's parent chain (own PID → … → init) so an agent
//      can report `host_shell_pids`. The controlling shell PID (= the VS Code
//      Terminal.processId) is always somewhere in this chain regardless of how
//      the agent was launched (alias / manual / spawn), so Tether binds by
//      intersection without guessing which ancestor is "the shell".
//   2. MACHINE GUID: read the stable OS machine id so the agent's `host_id` and
//      Tether's host_id are computed IDENTICALLY from the SAME OS source — the
//      host-scoping boundary that stops equal PIDs on different hosts from
//      false-matching once the relay federates.
//
// The parsers are pure (string in → structured out) so each platform's shape is
// unit-tested without the OS. The thin impure resolvers (machineGuid /
// ancestryChain) compose a command + parser with an injectable runner.

export type HostPlatform = "darwin" | "linux" | "win32";

/** Runs an OS command and returns its stdout (throws/empty on failure → callers
 *  treat as "unavailable"). Injectable so resolvers are testable without exec. */
export type CommandRunner = (cmd: string, args: string[]) => string;

// ---------------------------------------------------------------------------
// Ancestry
// ---------------------------------------------------------------------------

/** Parse POSIX `ps -e -o pid=,ppid=` stdout → Map<pid, ppid>. Lines look like
 *  "  55566  55479" (leading pad, two ints). Junk lines are skipped. */
export function parsePosixProcessTable(stdout: string): Map<number, number> {
  const table = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    table.set(Number(m[1]), Number(m[2]));
  }
  return table;
}

/** Parse Windows `wmic process get ProcessId,ParentProcessId /format:csv` stdout
 *  → Map<pid, ppid>. CSV header is `Node,ParentProcessId,ProcessId`; rows are
 *  `HOSTNAME,<ppid>,<pid>`. Tolerant of CRLF + blank lines + header drift (finds
 *  the ProcessId / ParentProcessId columns by name). */
export function parseWindowsProcessTable(stdout: string): Map<number, number> {
  const table = new Map<number, number>();
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const header = lines.find((l) => /ProcessId/i.test(l) && /ParentProcessId/i.test(l));
  if (!header) return table;
  const cols = header.split(",").map((c) => c.trim());
  const pidIdx = cols.findIndex((c) => /^ProcessId$/i.test(c));
  const ppidIdx = cols.findIndex((c) => /^ParentProcessId$/i.test(c));
  if (pidIdx < 0 || ppidIdx < 0) return table;
  for (const line of lines) {
    if (line === header) continue;
    const parts = line.split(",").map((p) => p.trim());
    const pid = Number(parts[pidIdx]);
    const ppid = Number(parts[ppidIdx]);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid, ppid);
  }
  return table;
}

/** Walk pid → ppid → … from `startPid` toward the root, returning the chain
 *  [startPid, …ancestors]. Bounded by `maxDepth` and cycle-safe (a seen-set
 *  guards against a malformed table looping). Stops at 0/1 (init) or a missing
 *  parent. */
export function walkAncestry(
  startPid: number,
  table: Map<number, number>,
  maxDepth = 64,
): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  let pid = startPid;
  for (let i = 0; i < maxDepth; i++) {
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) break;
    seen.add(pid);
    chain.push(pid);
    const ppid = table.get(pid);
    if (ppid === undefined || ppid <= 1) {
      if (ppid !== undefined && ppid > 1) chain.push(ppid);
      break;
    }
    pid = ppid;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Machine GUID
// ---------------------------------------------------------------------------

/** macOS: extract IOPlatformUUID from `ioreg -rd1 -c IOPlatformExpertDevice`,
 *  whose relevant line is `"IOPlatformUUID" = "564D...-...."`. */
export function parseDarwinMachineGuid(ioregStdout: string): string | null {
  const m = ioregStdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/** Linux: /etc/machine-id is a single line of 32 lowercase hex chars. */
export function parseLinuxMachineId(contents: string): string | null {
  const id = contents.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return /^[0-9a-fA-F]{32}$/.test(id) ? id : null;
}

/** Windows: extract MachineGuid from
 *  `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid`, whose value
 *  line is `    MachineGuid    REG_SZ    <guid>`. */
export function parseWindowsMachineGuid(regStdout: string): string | null {
  const m = regStdout.match(/MachineGuid\s+REG_SZ\s+([^\s]+)/i);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Impure resolvers (compose command + parser; runner injectable for tests)
// ---------------------------------------------------------------------------

/** Resolve the stable machine GUID for `platform`, or null if unavailable.
 *  Identical source to the agent-side registration hook so the two host_ids
 *  agree. */
export function machineGuid(platform: HostPlatform, run: CommandRunner): string | null {
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

/** Resolve the process-ancestry chain for `startPid` on `platform`, or [] if
 *  unavailable. */
export function ancestryChain(
  startPid: number,
  platform: HostPlatform,
  run: CommandRunner,
): number[] {
  try {
    const table =
      platform === "win32"
        ? parseWindowsProcessTable(
            run("wmic", ["process", "get", "ProcessId,ParentProcessId", "/format:csv"]),
          )
        : parsePosixProcessTable(run("ps", ["-e", "-o", "pid=,ppid="]));
    return walkAncestry(startPid, table);
  } catch {
    return [];
  }
}
