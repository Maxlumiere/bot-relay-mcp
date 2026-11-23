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
import { spawn, spawnSync } from "node:child_process";
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

  it("relay pending AGENT --json (DB source): the piped answer is complete (1500 messages, equal to the file run once age_seconds is pinned), past two pipe buffers", () => {
    const r = fileVsPipe(["pending", "pipe-to", "--json"], { RELAY_DB_PATH: dbPath });
    expect(r.file.length, "the fixture must exceed one pipe buffer, or the row proves nothing").toBeGreaterThan(2 * PIPE_BUFFER);
    expect(r.status, r.stderr).toBe(0);
    expect(r.piped.length, "piped output was cut").toBeGreaterThan(2 * PIPE_BUFFER);
    // Not byte equality: each message carries age_seconds, which moves between the two runs (CI measured it: equal
    // lengths, different bytes). Both answers parse, and are equal once the clock field is pinned.
    type Pending = { count: number; messages: Array<{ age_seconds: number }> };
    const pin = (b: Buffer): Pending => {
      const j = JSON.parse(b.toString("utf-8")) as Pending;
      for (const m of j.messages) m.age_seconds = 0;
      return j;
    };
    const piped = pin(r.piped);
    expect(piped.count).toBe(1500);
    expect(piped.messages.length, "every message reached the reader").toBe(1500);
    expect(piped).toEqual(pin(r.file));
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
describe("the exit helper (src/exit-after-flush.ts, loaded from dist/): drains, then exits with the code, even with an open handle", () => {
  const HELPER = path.join(REPO_ROOT, "dist", "exit-after-flush.js");
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

/**
 * #443 R1 (Codex P2-1/P2-2, ruling 90188964): the signal exit of `relay watch` uses the SAME helper, BOUNDED; and a
 * stdout EPIPE while stderr is still queued neither crashes nor loses stderr or the exit code.
 */
describe("the signal exit drains, BOUNDED; EPIPE on stdout with stderr pending (#443 R1)", () => {
  const DIST_EXIT = path.join(REPO_ROOT, "dist", "exit-after-flush.js");
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  function child(body: string): string {
    const p = path.join(home, `child-${process.hrtime.bigint()}.mjs`);
    fs.writeFileSync(p, `import { exitAfterFlush, installSignalExit, markTerminatingOnSignals } from ${JSON.stringify(pathToFileURL(DIST_EXIT).href)};\nsetInterval(() => {}, 1000);\n${body}\n`);
    return p;
  }

  it("(a) 300000 bytes queued on stdout, then SIGTERM: a late reader gets every byte; exit 0", () => {
    const out = fs.mkdtempSync(path.join(home, "sa-"));
    const c = child(`installSignalExit(() => {});\nprocess.stdout.write("x".repeat(300000));\nprocess.kill(process.pid, "SIGTERM");`);
    const r = spawnSync("sh", ["-c", `{ ${q(process.execPath)} ${q(c)}; echo $? > ${q(path.join(out, "status"))}; } | { sleep 1; cat > ${q(path.join(out, "piped"))}; }`], { encoding: "utf-8", timeout: 30_000 });
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBeUndefined();
    expect(fs.statSync(path.join(out, "piped")).size, "every queued byte reached the reader").toBe(300000);
    expect(fs.readFileSync(path.join(out, "status"), "utf-8").trim()).toBe("0");
  });

  it("(b) a reader that NEVER reads, then SIGTERM: the process exits within the bound, with one stderr line", () => {
    const out = fs.mkdtempSync(path.join(home, "sb-"));
    const c = child(`installSignalExit(() => {}, 500);\nprocess.stdout.write("x".repeat(300000));\nprocess.kill(process.pid, "SIGTERM");`);
    const t0 = Date.now();
    const r = spawnSync("sh", ["-c", `{ ${q(process.execPath)} ${q(c)} 2> ${q(path.join(out, "err"))}; echo $? > ${q(path.join(out, "status"))}; } | sleep 4`], { encoding: "utf-8", timeout: 30_000 });
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBeUndefined();
    // The writer's exit is what is bounded; the pipeline ends when `sleep 4` does. The status file is written as soon as
    // the writer exits, so its mtime measures the writer.
    const exitedAfter = fs.statSync(path.join(out, "status")).mtimeMs - t0;
    expect(exitedAfter, "the writer exited near the 500 ms bound, not when the reader went away").toBeLessThan(3000);
    expect(fs.readFileSync(path.join(out, "status"), "utf-8").trim()).toBe("0");
    expect(fs.readFileSync(path.join(out, "err"), "utf-8")).toContain("output still queued after 500 ms");
  }, 20_000);

  it("the watch's signal bound is short (a hung watch keeps its lock and blocks the next arm)", async () => {
    const { SIGNAL_DRAIN_BOUND_MS } = await import("../src/exit-after-flush.js");
    expect(SIGNAL_DRAIN_BOUND_MS).toBeGreaterThan(0);
    expect(SIGNAL_DRAIN_BOUND_MS).toBeLessThanOrEqual(5000);
  });

  it("stdout EPIPE (reader gone) while 300000 bytes of STDERR are still queued: stderr is delivered whole, the exit code (3) survives, no crash", () => {
    const out = fs.mkdtempSync(path.join(home, "se-"));
    const c = child(`process.stdout.write("o".repeat(300000));\nprocess.stderr.write("e".repeat(300000));\nexitAfterFlush(3);`);
    const r = spawnSync("bash", ["-c", `{ ${q(process.execPath)} ${q(c)} 2> >(sleep 1; cat > ${q(path.join(out, "err"))}); echo $? > ${q(path.join(out, "status"))}; } | head -c 10 > /dev/null; sleep 2`], { encoding: "utf-8", timeout: 30_000 });
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBeUndefined();
    expect(fs.readFileSync(path.join(out, "status"), "utf-8").trim(), "the exit code survived the stdout EPIPE").toBe("3");
    const err = fs.readFileSync(path.join(out, "err"), "utf-8");
    expect(err).not.toMatch(/Unhandled 'error' event|EPIPE/);
    expect(err.length, "stderr drained in full after stdout's reader left").toBe(300000);
  });

  it("the real relay watch still exits promptly on SIGTERM (0), and its wake line reaches the reader", async () => {
    const r = await new Promise<{ code: number | null; out: string; ms: number }>((resolve) => {
      const w = spawn(process.execPath, [RELAY_BIN, "watch", "pipe-to", "--json"], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), RELAY_DB_PATH: dbPath, RELAY_HTTP_PORT: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let t0 = 0;
      w.stdout.on("data", (d) => {
        out += d;
        if (!t0 && out.includes('"event":"wake"')) {
          t0 = Date.now();
          w.kill("SIGTERM");
        }
      });
      const guard = setTimeout(() => w.kill("SIGKILL"), 25_000);
      w.on("exit", (code) => {
        clearTimeout(guard);
        resolve({ code, out, ms: t0 ? Date.now() - t0 : -1 });
      });
    });
    expect(r.out).toContain('"event":"wake"');
    expect(r.code).toBe(0);
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.ms, "exited within the signal bound").toBeLessThan(5000);
  }, 30_000);

  // --- #443 R2 delta (ruling c07c9674) ---
  // --until-wake's exit, modelled EXACTLY as it runs: the terminating marker, a `once` phase handler that settles, then
  // bin/relay's UNBOUNDED exitAfterFlush(code) after runUntilWake returns. (The real --until-wake did not reach a
  // listening phase in a sandbox within 9 s, MEASURED; its setup-time behaviour is the last row below.)
  const untilWakeModel = `markTerminatingOnSignals();\nprocess.stdout.write("x".repeat(300000));\nprocess.once("SIGTERM", () => setImmediate(() => exitAfterFlush(0)));\nprocess.kill(process.pid, "SIGTERM");`;

  it("P2-a: the --until-wake exit path (marker + phase handler + an UNBOUNDED exitAfterFlush) is bounded once a signal arrived: a never-reading reader cannot hang it", () => {
    const out = fs.mkdtempSync(path.join(home, "ua-"));
    const t0 = Date.now();
    const r = spawnSync("sh", ["-c", `{ ${q(process.execPath)} ${q(child(untilWakeModel))} 2> ${q(path.join(out, "err"))}; echo $? > ${q(path.join(out, "status"))}; } | sleep 6`], { encoding: "utf-8", timeout: 30_000 });
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBeUndefined();
    const exitedAfter = fs.statSync(path.join(out, "status")).mtimeMs - t0;
    expect(exitedAfter, "bounded by SIGNAL_DRAIN_BOUND_MS (2000), not by the reader").toBeLessThan(4500);
    expect(fs.readFileSync(path.join(out, "status"), "utf-8").trim()).toBe("0");
  }, 20_000);

  it("P2-a: TWO SIGTERMs on that path exit with code 0, not by a signal (the second is absorbed)", () => {
    const out = fs.mkdtempSync(path.join(home, "ub-"));
    const twice = untilWakeModel.replace('process.kill(process.pid, "SIGTERM");', 'process.kill(process.pid, "SIGTERM");\nsetTimeout(() => process.kill(process.pid, "SIGTERM"), 50);');
    const r = spawnSync("sh", ["-c", `{ ${q(process.execPath)} ${q(child(twice))}; echo $? > ${q(path.join(out, "status"))}; } | sleep 4`], { encoding: "utf-8", timeout: 30_000 });
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBeUndefined();
    expect(fs.readFileSync(path.join(out, "status"), "utf-8").trim(), "exit 0 (143 would be death by SIGTERM)").toBe("0");
  }, 20_000);

  it("P2-b: a THROWING stop() still exits 0 (one stderr line); a double signal runs stop() ONCE", () => {
    const out = fs.mkdtempSync(path.join(home, "uc-"));
    const count = path.join(out, "count");
    // 300000 bytes queued behind a LATE reader: the drain lasts ~1 s, so the second signal lands DURING it.
    const body = `import fs from "node:fs";\ninstallSignalExit(() => { fs.appendFileSync(${JSON.stringify(count)}, "x"); throw new Error("boom"); });\nprocess.stdout.write("x".repeat(300000));\nprocess.kill(process.pid, "SIGTERM");\nsetTimeout(() => process.kill(process.pid, "SIGTERM"), 200);`;
    const r = spawnSync("sh", ["-c", `{ ${q(process.execPath)} ${q(child(body))} 2> ${q(path.join(out, "err"))}; echo $? > ${q(path.join(out, "status"))}; } | { sleep 1; cat > /dev/null; }`], { encoding: "utf-8", timeout: 30_000 });
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBeUndefined();
    expect(fs.readFileSync(path.join(out, "status"), "utf-8").trim()).toBe("0");
    expect(fs.readFileSync(count, "utf-8"), "stop() ran exactly once").toBe("x");
    expect(fs.readFileSync(path.join(out, "err"), "utf-8")).toContain("cleanup failed (boom)");
  });

  it("REGRESSION GUARD: a SIGTERM while the REAL relay watch --until-wake is still setting up (nothing listening yet) still terminates it by the signal, as on main", async () => {
    const r = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>((resolve) => {
      const w = spawn(process.execPath, [RELAY_BIN, "watch", "pipe-to", "--until-wake"], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), RELAY_DB_PATH: dbPath, RELAY_HTTP_PORT: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let t0 = 0;
      setTimeout(() => {
        t0 = Date.now();
        w.kill("SIGTERM");
      }, 1500);
      const guard = setTimeout(() => w.kill("SIGKILL"), 20_000);
      w.on("exit", (code, signal) => {
        clearTimeout(guard);
        resolve({ code, signal, ms: Date.now() - t0 });
      });
    });
    expect(r.signal, "terminated by SIGTERM (a swallowed signal would leave it running until the SIGKILL guard)").toBe("SIGTERM");
    expect(r.ms).toBeLessThan(3000);
  }, 30_000);

  it("P2-c: bin/relay with a missing build says so in one line and exits 1 (nothing written before it)", () => {
    const tree = fs.mkdtempSync(path.join(home, "nobuild-"));
    fs.mkdirSync(path.join(tree, "bin"));
    fs.mkdirSync(path.join(tree, "dist"));
    fs.copyFileSync(RELAY_BIN, path.join(tree, "bin", "relay"));
    fs.writeFileSync(path.join(tree, "package.json"), JSON.stringify({ type: "module" }));
    const r = spawnSync(process.execPath, [path.join(tree, "bin", "relay"), "help"], { encoding: "utf-8", timeout: 30_000 });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.trim()).toBe("relay: build missing or out of date (dist/exit-after-flush.js); run npm run build");
  });
});

