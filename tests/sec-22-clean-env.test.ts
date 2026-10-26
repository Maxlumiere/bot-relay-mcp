// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-22 clause (ii): a system tool runs with the CLEAN-BASE env, never the caller's. The class: a trusted binary
 * resolving another program or options from the caller's env (GNU tar's -z runs `gzip` from PATH and reads
 * TAR_OPTIONS; LD_PRELOAD, GZIP, the user's locale reach the same way). And argv0 is the tool's name (a multi-call
 * binary such as BusyBox dispatches on it).
 *
 * child_process.spawnSync is MOCKED here, so what each wrapper hands it is captured exactly, on every OS, and no tool
 * runs. The tool is this OS's own (ps on POSIX, whoami on Windows), located for real by systemBinary. The black-box
 * twin (a planted gzip + TAR_OPTIONS sentinel that must never execute) is in the backup tests: Linux only (bsdtar on
 * macOS compresses in-process and ignores TAR_OPTIONS, so a macOS run of it would be vacuous).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = [];
vi.mock("child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("child_process")>();
  return {
    ...real,
    spawnSync: (file: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ file, args, opts });
      return { pid: 1, output: [], stdout: "Mon Oct 26 02:42:04 2026\n", stderr: "", status: 0, signal: null };
    },
  };
});

const { spawnSystem, execSystem, systemEnv, SystemBinaryError } = await import("../src/system-binary.js");
const { processStartedAt } = await import("../src/liveness.js");

const WIN = process.platform === "win32";
const TOOL = WIN ? ("whoami" as const) : ("ps" as const);
const TRUSTED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"; // the darwin system dirs and the Linux FHS list are the same four

/** Hostile caller env: every variable here must NOT reach a system tool. */
const HOSTILE = {
  TAR_OPTIONS: "--use-compress-program=/tmp/sentinel",
  GZIP: "-S .evil",
  LD_PRELOAD: "/tmp/evil.so",
  DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
  NODE_OPTIONS: "--require /tmp/evil.js",
  PSModulePath: "C:\\evil\\modules",
  TZ: "Pacific/Kiritimati",
  LANG: "tr_TR.UTF-8",
  RELAY_HOSTILE_MARKER: "1",
};
const saved: Record<string, string | undefined> = {};
let savedPath: string | undefined;
beforeEach(() => {
  calls.length = 0;
  for (const [k, v] of Object.entries(HOSTILE)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  savedPath = process.env.PATH;
  process.env.PATH = `/tmp/planted${WIN ? ";" : ":"}${savedPath ?? ""}`;
});
afterEach(() => {
  for (const k of Object.keys(HOSTILE)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  process.env.PATH = savedPath;
});

function expectCleanBase(env: Record<string, string>, extra: Record<string, string> = {}) {
  if (WIN) {
    expect(Object.keys(env).sort()).toEqual(["SystemRoot", ...Object.keys(extra)].sort());
  } else {
    expect(Object.keys(env).sort()).toEqual(["LC_ALL", "PATH", ...Object.keys(extra)].sort());
    expect(env.PATH).toBe(TRUSTED_PATH);
    expect(env.LC_ALL).toBe("C");
  }
  for (const [k, v] of Object.entries(extra)) expect(env[k]).toBe(v);
}

describe("SEC-22 (ii): a system tool runs with the clean-base env and argv0 = its name", () => {
  it("spawnSystem: none of the caller's env arrives (hostile PATH, TAR_OPTIONS, LD_PRELOAD, TZ, locale ...); argv0 and shell:false are set", () => {
    const r = spawnSystem(TOOL, ["-x"], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(calls).toHaveLength(1);
    const { opts } = calls[0];
    expectCleanBase(opts.env as Record<string, string>);
    expect(opts.argv0).toBe(TOOL);
    expect(opts.shell).toBe(false);
  });

  it("known-good twin: a variable the call site NAMES arrives, on top of the clean base", () => {
    spawnSystem(TOOL, [], { encoding: "utf-8", named: { RELAY_OWNER_PATH: "/x" } });
    expectCleanBase(calls[0].opts.env as Record<string, string>, { RELAY_OWNER_PATH: "/x" });
  });

  it("a named PATH or SystemRoot is refused before anything runs (the clean base owns them)", () => {
    for (const k of ["PATH", "Path", "SystemRoot", "SYSTEMROOT"]) {
      const r = spawnSystem(TOOL, [], { encoding: "utf-8", named: { [k]: "/tmp/planted" } });
      expect(r.status).toBeNull();
      expect(r.error).toBeInstanceOf(SystemBinaryError);
    }
    expect(calls).toHaveLength(0);
  });

  it("execSystem: the same clean base and argv0; a non-zero exit throws, as execFileSync does", () => {
    expect(execSystem(TOOL, [])).toContain("2026");
    expectCleanBase(calls[0].opts.env as Record<string, string>);
    expect(calls[0].opts.argv0).toBe(TOOL);
  });

  it("systemEnv on Windows: SystemRoot only, from the validated root (the seam, every OS)", () => {
    expect(systemEnv("whoami", {}, { SystemRoot: "C:\\Windows", PSModulePath: "C:\\evil", PATH: "C:\\evil" }, "win32")).toEqual({ SystemRoot: "C:\\Windows" });
    expect(() => systemEnv("whoami", {}, { SystemRoot: "Windows" }, "win32")).toThrow(SystemBinaryError);
  });

  it.skipIf(WIN)("liveness: a start token is read with TZ=UTC and LC_ALL=C on the clean base: never the caller's TZ or env", () => {
    processStartedAt(process.pid);
    const ps = calls.find((c) => c.args.includes("lstart="));
    expect(ps, "processStartedAt ran ps -o lstart=").toBeTruthy();
    expectCleanBase(ps!.opts.env as Record<string, string>, { TZ: "UTC" });
  });
});
