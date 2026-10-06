// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Run NESTED by tests/operator-tripwire.test.ts, under the real base config, tripwire and run guard.
 * Every "HARM" test does something the tripwire must refuse, and SWALLOWS the error: each must still
 * FAIL (afterEach), and the run must fail at teardown. Every "control" must pass. The outer test reads
 * the per-test verdicts from the JSON reporter.
 *
 * The operator stand-ins, made operator by being this run's AMBIENT config (the base treats the shell's
 * as the operator's): TRIPWIRE_FIXTURE_PORT is the ambient RELAY_HTTP_PORT (a canary the outer test
 * counts connections on), and TRIPWIRE_SYNTH_ROOT the ambient RELAY_HOME (a synthetic relay root with a
 * relay.db in it). TRIPWIRE_SYNTH_ALIAS is a symlink to that root. TRIPWIRE_PLAIN_PORT is NOT operator.
 */
import { it, expect } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PORT = Number(process.env.TRIPWIRE_FIXTURE_PORT);
const PLAIN = Number(process.env.TRIPWIRE_PLAIN_PORT);
const ROOT = String(process.env.TRIPWIRE_SYNTH_ROOT);
const ALIAS = String(process.env.TRIPWIRE_SYNTH_ALIAS);
const swallow = async (f: () => unknown) => {
  try {
    await f();
  } catch {
    /* the harm case: a test that swallows the refusal */
  }
};
const get = (host: string, port: number) =>
  new Promise<void>((resolve, reject) => {
    try {
      http.get({ host, port, path: "/" }, (r) => (r.resume(), r.on("end", () => resolve()))).on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
const swapCase = (s: string) => s.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
function caseInsensitive(p: string): boolean {
  try {
    return fs.statSync(swapCase(p)).ino === fs.statSync(p).ino;
  } catch {
    return false;
  }
}

it("control: a NON-operator port is reached", async () => {
  await get("127.0.0.1", PLAIN);
});
it("control: reading outside every operator root works; metadata on the root is not flagged", () => {
  const f = path.join(process.env.HOME!, "plain.txt");
  fs.writeFileSync(f, "x");
  expect(fs.readFileSync(f, "utf-8")).toBe("x");
  expect(fs.existsSync(path.join(ROOT, "relay.db"))).toBe(true);
  expect(fs.statSync(ROOT).isDirectory()).toBe(true);
});

it("HARM http: http.get to an operator port, swallowed", async () => {
  await swallow(() => get("127.0.0.1", PORT));
});
it("HARM fetch: fetch to localhost:<operator port>, swallowed", async () => {
  await swallow(() => fetch(`http://localhost:${PORT}/health`));
});
it("HARM mapped-hex: net.connect to ::ffff:7f00:1 (127.0.0.1 in hex), swallowed", async () => {
  await swallow(
    () =>
      new Promise<void>((resolve, reject) => {
        const s = net.connect({ host: "::ffff:7f00:1", port: PORT });
        s.on("connect", () => (s.destroy(), resolve()));
        s.on("error", reject);
      }),
  );
});
it("HARM lookup: a hostname whose lookup returns 127.0.0.1, swallowed", async () => {
  await swallow(
    () =>
      new Promise<void>((resolve, reject) => {
        const s = net.connect({ host: "relay.example.invalid", port: PORT, lookup: (_h, opts, cb) => ((opts as { all?: boolean })?.all ? (cb as (e: null, a: unknown) => void)(null, [{ address: "127.0.0.1", family: 4 }]) : (cb as (e: null, a: string, f: number) => void)(null, "127.0.0.1", 4)) });
        s.on("connect", () => (s.destroy(), resolve()));
        s.on("error", reject);
      }),
  );
});
it("HARM fs-direct: readFileSync of the operator root's relay.db, swallowed", async () => {
  await swallow(() => fs.readFileSync(path.join(ROOT, "relay.db")));
});
it("HARM fs-alias: the same file through a SYMLINK alias of the root, swallowed", async () => {
  await swallow(() => fs.readFileSync(path.join(ALIAS, "relay.db")));
});
it.skipIf(!caseInsensitive(ROOT))("HARM fs-case: the same file with its path case-swapped (case-insensitive volume), swallowed", async () => {
  await swallow(() => fs.readFileSync(swapCase(path.join(ROOT, "relay.db"))));
});
it("HARM child-net: a node child built with env {} fetches the operator port; the spawn's throw is swallowed", async () => {
  await swallow(() => spawnSync(process.execPath, ["-e", `fetch("http://127.0.0.1:${PORT}/").catch(()=>{})`], { encoding: "utf-8", env: {}, timeout: 15_000 }));
});
it("HARM child-frozen: a preloaded child DELETES its RELAY_TEST_OPERATOR_ROOTS, then reads the root (the snapshot is frozen); swallowed", async () => {
  const code = `delete process.env.RELAY_TEST_OPERATOR_ROOTS; try { require("fs").readFileSync(${JSON.stringify(path.join(ROOT, "relay.db"))}) } catch {}`;
  await swallow(() => spawnSync(process.execPath, ["-e", code], { encoding: "utf-8", timeout: 15_000 }));
});
it("HARM child-home: a child whose HOME IS the operator root is refused before it starts; swallowed", async () => {
  const marker = path.join(process.env.HOME!, `never-${process.pid}`);
  await swallow(() => spawnSync("/bin/sh", ["-c", `touch ${marker}`], { env: { PATH: "/usr/bin:/bin", HOME: ROOT } }));
  expect(fs.existsSync(marker)).toBe(false);
});
it("HARM child-home-alias: HOME inside the root through its symlink alias; swallowed", async () => {
  await swallow(() => spawnSync("/bin/sh", ["-c", "true"], { env: { PATH: "/usr/bin:/bin", HOME: path.join(ALIAS, "sub") } }));
});
it("HARM record-lost: the violation cannot be written (directory read-only): fails CLOSED", async () => {
  const dir = String(process.env.RELAY_TEST_TRIPWIRE_DIR);
  fs.chmodSync(dir, 0o500);
  try {
    await swallow(() => fs.readFileSync(path.join(ROOT, "relay.db")));
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});
