// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.3.0 PID-handshake — host-identity parser contract (all 3 platforms, H4).
// Real T-ACC runs on POSIX (Maxime's Mac); Windows parsers are unit-verified
// against documented `wmic` / `reg query` output shapes here — we have no
// Windows host, so this is the honest Windows coverage (parser-verified, not
// runtime-tested). The alias-launch ancestry tree is the load-bearing case:
// the controlling shell PID (= VS Code Terminal.processId) must appear in the
// chain even though `claude` is several levels below it.

import { describe, it, expect } from "vitest";
import {
  parsePosixProcessTable,
  parseWindowsProcessTable,
  walkAncestry,
  parseDarwinMachineGuid,
  parseLinuxMachineId,
  parseWindowsMachineGuid,
  machineGuid,
  ancestryChain,
  type CommandRunner,
} from "./host-identity.js";

// The exact tree probed live on Maxime's Electron host (the v0.3 spike):
//   claude 55566 → zsh 55479 (controlling shell) → Code Helper 55465 → Code 55447 → launchd 1
const ALIAS_PS = `
  55566  55479
  55479  55465
  55465  55447
  55447      1
  80420  55566
  99999  12345
`;

describe("parsePosixProcessTable + walkAncestry", () => {
  it("builds the table and walks the alias-launch chain to (but not past) launchd", () => {
    const table = parsePosixProcessTable(ALIAS_PS);
    const chain = walkAncestry(55566, table);
    // The controlling shell 55479 is in the chain — that's what Tether
    // intersects against Terminal.processId.
    expect(chain).toEqual([55566, 55479, 55465, 55447]);
    expect(chain).toContain(55479);
  });

  it("a transient per-command subshell still reaches the controlling shell", () => {
    // 80420 (a Bash-tool subshell) → 55566 (claude) → 55479 (shell) → …
    const chain = walkAncestry(80420, parsePosixProcessTable(ALIAS_PS));
    expect(chain).toEqual([80420, 55566, 55479, 55465, 55447]);
  });

  it("skips junk lines and tolerates ragged whitespace", () => {
    const table = parsePosixProcessTable("PID PPID\n  10   1\ngarbage\n\n  20   10\n");
    expect(table.get(10)).toBe(1);
    expect(table.get(20)).toBe(10);
    expect(walkAncestry(20, table)).toEqual([20, 10]); // stops at ppid=1
  });

  it("walkAncestry is cycle-safe and depth-bounded", () => {
    const cyclic = new Map<number, number>([
      [5, 6],
      [6, 5],
    ]);
    const chain = walkAncestry(5, cyclic);
    expect(chain).toEqual([5, 6]); // visits each once, then the cycle stops it
    expect(walkAncestry(5, cyclic, 1)).toEqual([5]); // maxDepth respected
  });

  it("returns just [startPid] when the parent is unknown", () => {
    expect(walkAncestry(42, new Map())).toEqual([42]);
  });
});

describe("parseWindowsProcessTable + walkAncestry (Windows, parser-verified)", () => {
  // `wmic process get ProcessId,ParentProcessId /format:csv` shape.
  const WMIC_CSV = [
    "Node,ParentProcessId,ProcessId",
    "DESKTOP,5479,5566", // claude under the shell
    "DESKTOP,5465,5479", // shell under the terminal host
    "DESKTOP,1,5465", // terminal host under init
    "",
  ].join("\r\n");

  it("parses the CSV columns by name and walks the chain", () => {
    const table = parseWindowsProcessTable(WMIC_CSV);
    expect(table.get(5566)).toBe(5479);
    expect(walkAncestry(5566, table)).toEqual([5566, 5479, 5465]); // stops at ppid=1
  });

  it("returns an empty table when the header is missing", () => {
    expect(parseWindowsProcessTable("garbage\nno header").size).toBe(0);
  });
});

describe("machine GUID parsers (all 3 platforms)", () => {
  it("macOS: extracts IOPlatformUUID from ioreg output", () => {
    const ioreg = `
    +-o Root  <class IORegistryEntry>
      "IOPlatformUUID" = "564D4B3F-1A2B-3C4D-5E6F-7A8B9C0D1E2F"
      "IOPlatformSerialNumber" = "C02XYZ"
    `;
    expect(parseDarwinMachineGuid(ioreg)).toBe("564D4B3F-1A2B-3C4D-5E6F-7A8B9C0D1E2F");
    expect(parseDarwinMachineGuid("no uuid here")).toBeNull();
  });

  it("Linux: validates /etc/machine-id (32 hex), rejects malformed", () => {
    expect(parseLinuxMachineId("0123456789abcdef0123456789abcdef\n")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    expect(parseLinuxMachineId("too-short")).toBeNull();
    expect(parseLinuxMachineId("")).toBeNull();
  });

  it("Windows: extracts MachineGuid from reg query output", () => {
    const reg = [
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography",
      "    MachineGuid    REG_SZ    a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "",
    ].join("\r\n");
    expect(parseWindowsMachineGuid(reg)).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(parseWindowsMachineGuid("no guid")).toBeNull();
  });
});

describe("resolvers compose command + parser per platform", () => {
  it("machineGuid runs the right command per platform and parses it", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const darwinRun: CommandRunner = (cmd, args) => {
      calls.push({ cmd, args });
      return `"IOPlatformUUID" = "GUID-MAC"`;
    };
    expect(machineGuid("darwin", darwinRun)).toBe("GUID-MAC");
    expect(calls[0].cmd).toBe("ioreg");

    expect(machineGuid("linux", () => "0123456789abcdef0123456789abcdef")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    expect(
      machineGuid("win32", () => "    MachineGuid    REG_SZ    GUID-WIN"),
    ).toBe("GUID-WIN");
  });

  it("machineGuid returns null (never throws) when the command fails", () => {
    const boom: CommandRunner = () => {
      throw new Error("command not found");
    };
    expect(machineGuid("darwin", boom)).toBeNull();
  });

  it("ancestryChain composes ps → table → walk on POSIX", () => {
    const chain = ancestryChain(55566, "darwin", () => ALIAS_PS);
    expect(chain).toEqual([55566, 55479, 55465, 55447]);
  });

  it("ancestryChain returns [] (never throws) when the command fails", () => {
    expect(
      ancestryChain(1, "linux", () => {
        throw new Error("ps unavailable");
      }),
    ).toEqual([]);
  });
});
