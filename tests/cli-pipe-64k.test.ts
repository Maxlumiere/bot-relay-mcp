// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * bin/relay delivers a subcommand's WHOLE stdout through a pipe (it used to stop at 65,536 bytes).
 *
 * The injury: bin/relay ended every subcommand with process.exit(code). On a pipe, Node writes stdout
 * asynchronously (macOS measured; POSIX pipes generally): the first write fills the kernel pipe buffer (64 KiB) and
 * the rest is queued in the process, so process.exit() drops it. `relay list-instances --json | wc -c` measured
 * 65536 while the same command redirected to a file wrote 327955 bytes. The consumer receives truncated JSON —
 * or, worse, a truncated list that still parses line by line — and nothing says so.
 *
 * Every row compares a PIPED run with the same command redirected to a FILE (a file write is synchronous) and
 * requires byte equality, through two subcommands with different data sources (the filesystem, the DB). The pipe's
 * reader starts late (`sleep` before `cat`), so the writer always meets a full pipe buffer, whatever the OS.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { initializeDb, closeDb, registerAgent, sendMessage } from "../src/db.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");
const PIPE_BUFFER = 65_536;

let home: string;
let dbPath: string;
let savedDbPath: string | undefined;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pipe-64k-"));
  // Source 1, the filesystem: 1200 provisioned instances for `relay list-instances --json` (~320 KB).
  const inst = path.join(home, ".bot-relay", "instances");
  fs.mkdirSync(inst, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 1200; i++) {
    const id = `inst-${String(i).padStart(4, "0")}`;
    fs.mkdirSync(path.join(inst, id));
    fs.writeFileSync(
      path.join(inst, id, "instance.json"),
      JSON.stringify({ instance_id: id, created_at: "2026-11-23T00:00:00.000Z", hostname: "h", daemon_version_first_seen: "t", label: `label-${id}-padding-padding-padding` }),
    );
  }
  // One is selected, so the resolution is not ambiguous (list-instances exits 1 on an ambiguous one).
  fs.writeFileSync(path.join(home, ".bot-relay", "active-instance"), "inst-0000\n");
  // Source 2, the DB: 1500 pending messages for one agent, for `relay pending AGENT --json` (metadata only).
  savedDbPath = process.env.RELAY_DB_PATH;
  dbPath = path.join(home, "explicit", "relay.db");
  process.env.RELAY_DB_PATH = dbPath;
  await initializeDb();
  registerAgent("pipe-from", "role", []);
  registerAgent("pipe-to", "role", []);
  for (let i = 0; i < 1500; i++) sendMessage("pipe-from", "pipe-to", `m${i}`, "normal");
  closeDb();
}, 120_000);

afterAll(() => {
  if (savedDbPath === undefined) delete process.env.RELAY_DB_PATH;
  else process.env.RELAY_DB_PATH = savedDbPath;
  fs.rmSync(home, { recursive: true, force: true });
});

/** Run `relay ARGS` twice: stdout to a FILE, and stdout through a PIPE whose reader starts late. */
function fileVsPipe(args: string[], env: Record<string, string>): { file: Buffer; piped: Buffer; status: number | null; stderr: string } {
  const out = fs.mkdtempSync(path.join(home, "out-"));
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = `${q(process.execPath)} ${q(RELAY_BIN)} ${args.map(q).join(" ")}`;
  const baseEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), ...env };
  const toFile = spawnSync("sh", ["-c", `${cmd} > ${q(path.join(out, "file"))}`], { env: baseEnv, encoding: "utf-8", timeout: 60_000 });
  expect(toFile.status, toFile.stderr).toBe(0);
  // `set -o pipefail` is not POSIX sh: the writer's status is captured through a file instead.
  const piped = spawnSync(
    "sh",
    ["-c", `{ ${cmd}; echo $? > ${q(path.join(out, "status"))}; } | { sleep 1; cat > ${q(path.join(out, "piped"))}; }`],
    { env: baseEnv, encoding: "utf-8", timeout: 60_000 },
  );
  return {
    file: fs.readFileSync(path.join(out, "file")),
    piped: fs.readFileSync(path.join(out, "piped")),
    status: Number(fs.readFileSync(path.join(out, "status"), "utf-8").trim()),
    stderr: piped.stderr,
  };
}

describe("bin/relay: a PIPED subcommand's stdout is complete (not cut at 64 KiB), on Linux and macOS", () => {
  it("relay list-instances --json (filesystem source): piped bytes == file bytes, and both exceed the pipe buffer", () => {
    const r = fileVsPipe(["list-instances", "--json"], {});
    expect(r.file.length, "the fixture must exceed one pipe buffer, or the row proves nothing").toBeGreaterThan(4 * PIPE_BUFFER);
    expect(r.status, r.stderr).toBe(0);
    expect(r.piped.length, "piped output was cut").toBe(r.file.length);
    expect(r.piped.equals(r.file)).toBe(true);
    expect((JSON.parse(r.piped.toString("utf-8")) as { instances: unknown[] }).instances.length).toBe(1200);
  });

  it("relay pending AGENT --json (DB source): piped bytes == file bytes, and both exceed the pipe buffer", () => {
    const r = fileVsPipe(["pending", "pipe-to", "--json"], { RELAY_DB_PATH: dbPath });
    expect(r.file.length, "the fixture must exceed one pipe buffer, or the row proves nothing").toBeGreaterThan(2 * PIPE_BUFFER);
    expect(r.status, r.stderr).toBe(0);
    expect(r.piped.length, "piped output was cut").toBe(r.file.length);
    expect(r.piped.equals(r.file)).toBe(true);
    JSON.parse(r.piped.toString("utf-8"));
  });

  it("relay help through a pipe: exit 0, the usage on stdout, NOTHING on stderr (an exit path that falls through would add an error)", () => {
    const r = fileVsPipe(["help"], {});
    expect(r.status, r.stderr).toBe(0);
    expect(r.piped.toString("utf-8")).toContain("Usage: relay <subcommand>");
    expect(r.piped.equals(r.file)).toBe(true);
    expect(r.stderr).toBe("");
  });

  it("a reader that leaves early (head -c 10, EPIPE) does not hang the exit", () => {
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const t0 = Date.now();
    const r = spawnSync("sh", ["-c", `${q(process.execPath)} ${q(RELAY_BIN)} list-instances --json | head -c 10`], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir() },
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect((r.error as NodeJS.ErrnoException | undefined)?.code, "the pipeline finished by itself").toBeUndefined();
    expect(r.stdout.length).toBe(10);
    expect(Date.now() - t0).toBeLessThan(30_000);
  });

  it("the exit status still reaches the shell through the pipe (an error subcommand exits non-zero)", () => {
    const r = fileVsPipeStatusOnly(["pending", "no-such-agent-db", "--json", "--db-path", path.join(home, "absent", "relay.db")]);
    expect(r).not.toBe(0);
  });
});

/**
 * The exit helper itself, in a child that keeps a handle OPEN (a timer), as a subcommand may: without the helper's
 * own process.exit the child would never exit, and without its EPIPE branch a reader that left would hang it.
 */
describe("bin/_exit-after-flush.mjs: drains, then exits with the code, even with an open handle", () => {
  const HELPER = path.join(REPO_ROOT, "bin", "_exit-after-flush.mjs");
  function writer(): string {
    const p = path.join(home, `writer-${process.hrtime.bigint()}.mjs`);
    fs.writeFileSync(
      p,
      `import { exitAfterFlush } from ${JSON.stringify(pathToFileURL(HELPER).href)};\n` +
        `setInterval(() => {}, 1000);\n` +
        `process.stdout.write("x".repeat(300000));\n` +
        `exitAfterFlush(3);\n`,
    );
    return p;
  }
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

  it("a late reader receives all 300000 bytes, and the writer exits 3 (its own code, not 0, not a hang)", () => {
    const out = fs.mkdtempSync(path.join(home, "h-"));
    const r = spawnSync(
      "sh",
      ["-c", `{ ${q(process.execPath)} ${q(writer())}; echo $? > ${q(path.join(out, "status"))}; } | { sleep 1; cat > ${q(path.join(out, "piped"))}; }`],
      { encoding: "utf-8", timeout: 30_000 },
    );
    expect((r.error as NodeJS.ErrnoException | undefined)?.code, "the pipeline finished by itself").toBeUndefined();
    expect(fs.statSync(path.join(out, "piped")).size).toBe(300000);
    expect(fs.readFileSync(path.join(out, "status"), "utf-8").trim()).toBe("3");
  });

  it("a reader that leaves early (EPIPE) does not hang the writer: it exits 3 by itself", () => {
    const out = fs.mkdtempSync(path.join(home, "h-"));
    const r = spawnSync(
      "sh",
      ["-c", `{ ${q(process.execPath)} ${q(writer())}; echo $? > ${q(path.join(out, "status"))}; } | head -c 10 > /dev/null`],
      { encoding: "utf-8", timeout: 30_000 },
    );
    expect((r.error as NodeJS.ErrnoException | undefined)?.code, "the writer exited by itself after EPIPE").toBeUndefined();
    expect(fs.readFileSync(path.join(out, "status"), "utf-8").trim()).toBe("3");
  });
});

/** The writer's exit status through a pipe, for a subcommand that fails. */
function fileVsPipeStatusOnly(args: string[]): number {
  const out = fs.mkdtempSync(path.join(home, "st-"));
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = `${q(process.execPath)} ${q(RELAY_BIN)} ${args.map(q).join(" ")}`;
  spawnSync("sh", ["-c", `{ ${cmd} 2>/dev/null; echo $? > ${q(path.join(out, "status"))}; } | cat > /dev/null`], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir() },
    timeout: 60_000,
  });
  return Number(fs.readFileSync(path.join(out, "status"), "utf-8").trim());
}
