// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-22, POSIX (the follow-up #336 named): the relay's security- and liveness-relevant tools run by an ABSOLUTE
 * trusted path on macOS and Linux too, never resolved through PATH. Windows is tests/sec-22-system-binaries.test.ts.
 *
 * THE DEFECT: `ps` (process identity: the start token that decides "the same process" before liveness and kill
 * decisions), `lsof` (who listens on the relay's port; a process's cwd), `sysctl` (the awake clock) and `cat` (this
 * host's machine id) ran BY NAME. A program found first on PATH decides what the relay believes: a planted `ps` can
 * forge a start token, a planted `lsof` a listener or a cwd.
 *
 * Here, each HARM plants a script first on PATH that prints a forged answer, proves the plant answers BY NAME (or the
 * harm proves nothing), and asserts the relay's reading is NOT the forged one. The TWIN is the real reading. Only the
 * Windows tools' validation lives in system-binary's own test; the source scan (the other file) proves every site.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const POSIX = process.platform === "darwin" || process.platform === "linux";
const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});

/** A scratch dir holding one executable `name` that prints `stdout` and exits 0, put FIRST on this process's PATH. */
function plant(name: string, stdout: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sec22-posix-${name}-`));
  const file = path.join(dir, name);
  // printf is a shell builtin: the plant must run nothing BY NAME itself (a planted `cat` that called cat would recurse).
  if (stdout.includes("'")) throw new Error("plant: no single quotes in the forged output");
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${savedPath ?? ""}`;
  return file;
}
/** Control: by name, this PATH runs the plant. */
const byName = (name: string, args: string[]) => execFileSync(name, args, { encoding: "utf-8" });

describe("SEC-22 (POSIX): a tool planted first on PATH does not decide what the relay believes", () => {
  it("HARM a planted ps printing a forged start time: processStartedAt reads the real one (TWIN: the real start)", async (ctx) => {
    if (!POSIX) ctx.skip("POSIX only");
    const { processStartedAt } = await import("../src/liveness.js");
    const real = processStartedAt(process.pid);
    expect(real.kind, `the real read: ${JSON.stringify(real)}`).toBe("start");
    const FORGED = "Mon Jan  1 00:00:00 2001";
    plant("ps", FORGED);
    expect(byName("ps", ["-o", "lstart=", "-p", String(process.pid)]).trim(), "control: the plant answers by name").toBe(FORGED);
    const read = processStartedAt(process.pid);
    expect(JSON.stringify(read)).not.toContain("2001");
    expect(read).toEqual(real);
  });

  it("HARM a planted cat printing a forged machine id: the Linux host id never comes from a subprocess", async (ctx) => {
    if (!POSIX) ctx.skip("POSIX only");
    const { machineGuid } = await import("../src/liveness.js");
    const FORGED = "deadbeefdeadbeefdeadbeefdeadbeef";
    plant("cat", FORGED);
    expect(byName("cat", ["/etc/machine-id"]).trim(), "control: the plant answers by name").toBe(FORGED);
    const id = machineGuid("linux");
    expect(id).not.toBe(FORGED);
    // TWIN: the real file, read directly (null where there is none, e.g. macOS).
    let want: string | null = null;
    try {
      const raw = fs.readFileSync("/etc/machine-id", "utf-8").trim();
      want = /^[0-9a-fA-F]{32}$/.test(raw) ? raw : null;
    } catch {
      want = null;
    }
    expect(id).toBe(want);
  });

  it("HARM a planted lsof printing a forged cwd: the fleet view reads the real cwd", async (ctx) => {
    if (!POSIX) ctx.skip("POSIX only");
    const { realSystemDeps } = await import("../src/fleet-system.js");
    const real = realSystemDeps.cwds([process.pid]).get(process.pid);
    expect(real, "precondition: the real lsof reads this process's cwd").toBeTruthy();
    plant("lsof", `p${process.pid}\nn/sec22/forged/cwd`);
    expect(byName("lsof", ["-a", "-d", "cwd", "-p", String(process.pid), "-Fpn"]), "control: the plant answers by name").toContain("/sec22/forged/cwd");
    const got = realSystemDeps.cwds([process.pid]).get(process.pid);
    expect(got).not.toBe("/sec22/forged/cwd");
    expect(got).toBe(real);
  });

  it("HARM a planted lsof printing a forged listener: the deploy gate reads the real listeners", async (ctx) => {
    if (!POSIX) ctx.skip("POSIX only");
    const { defaultGateDeps } = await import("../src/deploy-gate.js");
    const port = 1; // nothing listens on 1 as a user: the real answer is a positive "none"
    const real = defaultGateDeps().listenerPids(port);
    expect(real, "precondition: the real lsof answers").toEqual({ ok: true, pids: [] });
    plant("lsof", "424242");
    expect(byName("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).trim(), "control: the plant answers by name").toBe("424242");
    expect(defaultGateDeps().listenerPids(port)).toEqual(real);
  });

  it("HARM a planted sysctl printing a forged clock: the awake clock reads the real one (macOS)", async (ctx) => {
    if (process.platform !== "darwin") ctx.skip("the awake clock reads sysctl on macOS only (Linux: CLOCK_MONOTONIC)");
    const { awakeNowMs } = await import("../src/watch-wake.js");
    const real = awakeNowMs();
    expect(real, "precondition: the real awake clock reads").not.toBeNull();
    plant("sysctl", "1 4000000000000000\n1000"); // ticks = field 2 of line 1, frequency = line 2
    expect(byName("sysctl", ["-n", "kern.monotonicclock_usecs", "hw.tbfrequency"]), "control: the plant answers by name").toContain("4000000000000000");
    const got = awakeNowMs();
    expect(got).not.toBe(4_000_000_000_000_000);
    // The real clock moved on by a little, never by the forged amount.
    expect(Math.abs(got! - real!), `real ${real}, read ${got}`).toBeLessThan(60_000);
  });
});

describe("SEC-22 (POSIX): systemBinary resolves the macOS tools to their fixed system paths, trust-checked", () => {
  // A loop, not it.each: each test needs its own runtime skip (never a describe-level skipIf, which `vitest list` drops).
  for (const [name, want] of [
    ["ps", "/bin/ps"],
    ["ioreg", "/usr/sbin/ioreg"],
    ["sysctl", "/usr/sbin/sysctl"],
    ["launchctl", "/bin/launchctl"],
    ["plutil", "/usr/bin/plutil"],
    ["lsof", "/usr/sbin/lsof"],
    ["tar", "/usr/bin/tar"],
  ] as const) {
    it(`TWIN (macOS) ${name} → ${want}`, async (ctx) => {
      if (process.platform !== "darwin") ctx.skip("macOS paths");
      const { systemBinary } = await import("../src/system-binary.js");
      expect((systemBinary as (n: string) => string)(name)).toBe(want);
    });
  }

  it("HARM a file this user owns is NOT trusted (named error), however it is reached", async (ctx) => {
    if (!POSIX) ctx.skip("POSIX only");
    if (process.getuid?.() === 0) ctx.skip("running as root: every file is root-owned");
    const mod = (await import("../src/system-binary.js")) as Record<string, unknown>;
    const check = mod.assertTrustedSystemFile as ((p: string) => string) | undefined;
    expect(typeof check, "assertTrustedSystemFile is exported").toBe("function");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec22-trust-"));
    const mine = path.join(dir, "ps");
    fs.writeFileSync(mine, "#!/bin/sh\n", { mode: 0o755 });
    expect(() => check!(mine)).toThrow(/not owned by root/);
    // A symlink this user made, pointing at the REAL tool: the link's own directory is this user's, so it is refused.
    const link = path.join(dir, "ps-link");
    fs.symlinkSync("/bin/ps", link);
    expect(() => check!(link)).toThrow(/not owned by root/);
  });

  it("HARM a root-owned file that group/other can WRITE is not trusted (the mode, through an injected stat)", async (ctx) => {
    if (!POSIX) ctx.skip("POSIX only");
    const mod = (await import("../src/system-binary.js")) as Record<string, unknown>;
    const check = mod.assertTrustedSystemFile as ((p: string, f?: unknown) => string) | undefined;
    expect(typeof check, "assertTrustedSystemFile is exported").toBe("function");
    const stat = (mode: number, dir = false) => ({ uid: 0, mode, isFile: () => !dir, isDirectory: () => dir, isSymbolicLink: () => false });
    const fsApi = (fileMode: number, dirMode = 0o40755) => ({
      realpathSync: (p: string) => p,
      lstatSync: (p: string) => (p === "/usr/bin/x" ? stat(fileMode) : stat(dirMode, true)),
    });
    expect(check!("/usr/bin/x", fsApi(0o100755)), "TWIN: root-owned 0755 in root-owned 0755 dirs").toBe("/usr/bin/x");
    expect(check!("/usr/bin/x", fsApi(0o104755)), "TWIN: setuid root (macOS /bin/ps) is fine").toBe("/usr/bin/x");
    expect(() => check!("/usr/bin/x", fsApi(0o100775))).toThrow(/writable by group or other/);
    expect(() => check!("/usr/bin/x", fsApi(0o100757))).toThrow(/writable by group or other/);
    expect(() => check!("/usr/bin/x", fsApi(0o100755, 0o40777))).toThrow(/writable by group or other/);
  });

  // Codex #342 R1 P1-B (ruled 21 Oct): EVERY hop of a symlink chain is validated, and the path returned (and executed)
  // is the validated CANONICAL one, never the lexical candidate. A fake fs (a root-owned link or a sticky /tmp cannot be
  // planted by an unprivileged test), with readlink: the check must follow links itself to see each hop.
  describe("every symlink hop is validated; the canonical path is what is returned", () => {
    type Node = { kind: "dir" | "file" | "link"; uid?: number; mode?: number; target?: string };
    const fakeFs = (tree: Record<string, Node>) => {
      const st = (n: Node) => ({
        uid: n.uid ?? 0,
        mode: n.mode ?? (n.kind === "dir" ? 0o40755 : n.kind === "file" ? 0o100755 : 0o120777),
        dev: 1,
        ino: 1,
        isFile: () => n.kind === "file",
        isDirectory: () => n.kind === "dir",
        isSymbolicLink: () => n.kind === "link",
      });
      const enoent = (p: string) => Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
      const norm = (p: string) => (p.endsWith("/..") ? path.posix.dirname(p.slice(0, -3)) : p.endsWith("/.") ? p.slice(0, -2) || "/" : p);
      const resolve = (p: string, depth = 0): string => {
        // A naive full resolution, ONLY so that a check calling realpath sees the chain's end (as the old one did).
        if (depth > 40) throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
        const parts = p.split("/").filter(Boolean);
        let cur = "/";
        for (let i = 0; i < parts.length; i++) {
          const next = path.posix.join(cur, parts[i]);
          const n = tree[next];
          if (!n) throw enoent(next);
          if (n.kind === "link") {
            const t = n.target as string;
            return resolve(path.posix.join(t.startsWith("/") ? t : path.posix.join(cur, t), ...parts.slice(i + 1)), depth + 1);
          }
          cur = next;
        }
        return cur;
      };
      return {
        lstatSync: (p: string) => {
          const n = tree[norm(p)] ?? (norm(p) === "/" ? { kind: "dir" as const } : undefined);
          if (!n) throw enoent(p);
          return st(n);
        },
        readlinkSync: (p: string) => {
          const n = tree[p];
          if (!n || n.kind !== "link") throw Object.assign(new Error(`EINVAL ${p}`), { code: "EINVAL" });
          return n.target as string;
        },
        realpathSync: (p: string) => resolve(p),
        realpathNativeSync: (p: string) => resolve(p),
      };
    };
    const ROOT_DIRS: Record<string, Node> = { "/usr": { kind: "dir" }, "/usr/bin": { kind: "dir" }, "/opt": { kind: "dir" }, "/trusted": { kind: "dir" }, "/usr/lib": { kind: "dir" }, "/usr/lib/x": { kind: "dir" } };
    const check = async () => (await import("../src/system-binary.js")).assertTrustedSystemFile as (p: string, f?: unknown) => string;

    it("HARM (Codex's chain): /usr/bin/ps (root link) -> /opt/redirect/ps (a USER-owned link) -> /trusted/ps (a trusted file) is refused", async () => {
      const tree: Record<string, Node> = {
        ...ROOT_DIRS,
        "/opt/redirect": { kind: "dir" },
        "/usr/bin/ps": { kind: "link", target: "/opt/redirect/ps" },
        "/opt/redirect/ps": { kind: "link", uid: 501, target: "/trusted/ps" },
        "/trusted/ps": { kind: "file" },
      };
      const c = await check();
      expect(() => c("/usr/bin/ps", fakeFs(tree))).toThrow(/not owned by root \(\/opt\/redirect\/ps is owned by uid 501\)/);
    });
    it("HARM: an intermediate link whose OWN parent is writable by others (a sticky /tmp) is refused", async () => {
      const tree: Record<string, Node> = {
        ...ROOT_DIRS,
        "/tmp": { kind: "dir", mode: 0o41777 },
        "/usr/bin/ps": { kind: "link", target: "/tmp/ps" },
        "/tmp/ps": { kind: "link", target: "/trusted/ps" },
        "/trusted/ps": { kind: "file" },
      };
      const c = await check();
      expect(() => c("/usr/bin/ps", fakeFs(tree))).toThrow(/writable by group or other at \/tmp/);
    });
    it("COVERAGE (the old check caught this one too, through its realpath walk): a chain ending in a directory writable by others is refused", async () => {
      const tree: Record<string, Node> = {
        ...ROOT_DIRS,
        "/opt/bin": { kind: "dir", mode: 0o40777 },
        "/usr/bin/ps": { kind: "link", target: "/usr/lib/x/ps" },
        "/usr/lib/x/ps": { kind: "link", target: "../../../opt/bin/ps" },
        "/opt/bin/ps": { kind: "file" },
      };
      const c = await check();
      expect(() => c("/usr/bin/ps", fakeFs(tree))).toThrow(/writable by group or other at \/opt\/bin/);
    });
    it("TWIN: a legitimate root-owned chain is accepted, and the CANONICAL path (the chain's end) is returned, never the candidate", async () => {
      const tree: Record<string, Node> = {
        ...ROOT_DIRS,
        "/usr/bin/ps": { kind: "link", target: "../lib/x/ps" },
        "/usr/lib/x/ps": { kind: "link", target: "/trusted/ps" },
        "/trusted/ps": { kind: "file", mode: 0o104755 },
      };
      const c = await check();
      expect(c("/usr/bin/ps", fakeFs(tree))).toBe("/trusted/ps");
    });
    it("TWIN: \"missing\" still names the candidate itself", async () => {
      const c = await check();
      expect(() => c("/usr/bin/nope", fakeFs(ROOT_DIRS))).toThrow(/^\/usr\/bin\/nope: missing$/);
    });
  });
});
