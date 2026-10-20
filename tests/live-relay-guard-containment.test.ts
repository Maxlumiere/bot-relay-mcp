// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * CONTAINMENT, black-box (ruling on the guard false positive, A(b)): an env-{} test child running the REAL relay
 * SessionStart hook never targets the DEFAULT port (3777) under the operator tripwire. This is what the live relay's
 * "probe" bursts were (register_agent over HTTP to the default port, an actor-less refusal each, 23 Jul - 7 Oct; cause
 * ASSUMED to be local suite runs). It establishes "cannot recur from the suite AS NOW BUILT"; it does NOT explain why
 * those bursts stopped on 7 Oct.
 *
 * The instrument: a recording `curl` first on PATH (the hook resolves curl by PATH) that writes each URL it is given
 * and exits 7 ("could not connect") without connecting. Node children of the hook get a BLOCKER preload that refuses
 * every socket connect and records its target. Nothing in this file ever connects to 3777 (the live relay holds it on
 * an operator's machine).
 *
 * The hook dials only once it resolves a relay instance (ADR-0048), so each arm's HOME holds one: a sandbox DB the
 * product itself creates (dist/db.js), the shape of an account HOME. The two arms differ ONLY in the tripwire: the child
 * env is { PATH, a name, that HOME } with NO port, i.e. the port falls back to its default.
 *   THE CLAIM: under the tripwire (the ordinary spawn), the hook targets no URL on :3777 (the missing port is repaired
 *              to 1), and it did reach its HTTP calls (some URL was recorded: the instrument saw the path).
 *   THE TWIN (the RED with the tripwire removed): the same child spawned PAST the tripwire (raw spawn) targets
 *              http://127.0.0.1:3777/mcp: the default-port path is real, and the claim above is not vacuous.
 * The other containment layer, an env-{} child's HOME repaired to the run's private (instance-less) home, is pinned by
 * tests/operator-tripwire.test.ts ("a child built FROM SCRATCH (env {}) gets the private HOME ... port 1").
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { spawnNestedRun } from "./_setup/operator-tripwire.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(REPO, "hooks", "check-relay.sh");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-contain-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const NODE_DIR = path.dirname(process.execPath);
const DIST_DB = path.join(REPO, "dist", "db.js");
/** A sandbox HOME holding a relay instance (the flat layout), created by the product itself. */
function homeWithInstance(name: string): string {
  const home = path.join(ROOT, `${name}-home`);
  fs.mkdirSync(path.join(home, ".bot-relay"), { recursive: true });
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(DIST_DB)}); m.getDb(); m.closeDb();`], {
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", HOME: home, RELAY_DB_PATH: path.join(home, ".bot-relay", "relay.db") },
  });
  expect(r.status, `the sandbox instance was created (${r.stderr})`).toBe(0);
  return home;
}
const STDIN = JSON.stringify({ session_id: "contain-1", hook_event_name: "SessionStart", source: "startup" });

/** A recording instrument: a fake curl and a node blocker preload, both writing into `dir`/log. */
function instrument(name: string) {
  const dir = path.join(ROOT, name);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, "log");
  fs.writeFileSync(log, "");
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/sh\nfor a in "$@"; do case "$a" in http://*|https://*) printf 'curl %s\\n' "$a" >> '${log}';; esac; done\nexit 7\n`, { mode: 0o755 });
  const blocker = path.join(dir, "blocker.cjs");
  fs.writeFileSync(
    blocker,
    `const net = require("net"); const fs = require("fs");
     const refuse = (port, host) => { fs.appendFileSync(${JSON.stringify(log)}, "node " + (host || "?") + ":" + port + "\\n"); throw new Error("blocked by the containment test"); };
     const orig = net.Socket.prototype.connect;
     net.Socket.prototype.connect = function (...a) { const o = typeof a[0] === "object" && a[0] !== null ? a[0] : { port: a[0], host: a[1] }; if (o.path) return orig.apply(this, a); return refuse(o.port, o.host); };`,
  );
  const targets = () => fs.readFileSync(log, "utf-8").split("\n").filter(Boolean);
  const ports = () =>
    targets()
      .map((l) => (/^curl (\w+):\/\/[^/:]+:(\d+)/.exec(l)?.[2] ?? /^node [^:]*:(\d+)/.exec(l)?.[1] ?? null))
      .filter((p): p is string => p !== null);
  return { bin, blocker, targets, ports };
}

describe.skipIf(process.platform === "win32")("CONTAINMENT (black-box): an env-{} child running the real SessionStart hook never targets the default port under the tripwire", () => {
  it("THE CLAIM: under the tripwire, the hook in an env-{} child targets NO :3777 URL, and it did reach its HTTP calls", () => {
    const ins = instrument("claim");
    const home = homeWithInstance("claim");
    spawnSync("bash", [HOOK], { input: STDIN, encoding: "utf-8", timeout: 60_000, env: { PATH: `${ins.bin}:${NODE_DIR}:/usr/bin:/bin`, RELAY_AGENT_NAME: "fx-contain", HOME: home, NODE_OPTIONS: `--require ${ins.blocker}` } });
    expect(ins.targets().length, `precondition: the hook reached its HTTP calls (recorded: ${JSON.stringify(ins.targets())})`).toBeGreaterThan(0);
    expect(ins.ports(), `no target on the DEFAULT port (recorded: ${JSON.stringify(ins.targets())})`).not.toContain("3777");
    expect(ins.ports(), `the missing port was repaired to the tripwire's 1 (recorded: ${JSON.stringify(ins.targets())})`).toContain("1");
  }, 90_000);

  it("THE TWIN, the tripwire REMOVED: the same hook spawned PAST the tripwire (raw spawn; a sandbox HOME only) targets :3777 (the default-port path is real; the claim is not vacuous)", async () => {
    const ins = instrument("twin");
    const home = homeWithInstance("twin");
    await new Promise<number | null>((resolve) => {
      const c = spawnNestedRun("bash", [HOOK], { env: { PATH: `${ins.bin}:${NODE_DIR}:/usr/bin:/bin`, RELAY_AGENT_NAME: "fx-contain", HOME: home, NODE_OPTIONS: `--require ${ins.blocker}` }, stdio: ["pipe", "ignore", "ignore"] });
      c.stdin!.end(STDIN);
      c.on("close", resolve);
    });
    expect(ins.targets(), `without the tripwire the default port IS targeted (recorded: ${JSON.stringify(ins.targets())})`).toContain("curl http://127.0.0.1:3777/mcp");
  }, 90_000);
});
