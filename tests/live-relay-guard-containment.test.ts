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
 * The instrument: a recording `curl` first on PATH (the hook resolves curl by PATH) that records each invocation's URL
 * and the MCP tool its body calls (the tool NAME only, never an argument value), then exits 7 ("could not connect")
 * without connecting. Node children of the hook get a BLOCKER preload that refuses every socket connect and records
 * its target (net's normalized [options, cb] unwrapped; IPv6 hosts kept). The log is parsed STRICTLY: an unparseable
 * record fails the test, never reads as "no target". Nothing in this file ever connects to 3777 (the live relay holds
 * it on an operator's machine).
 *
 * The hook dials only once it resolves a relay instance (ADR-0048), so each arm's HOME holds one: a sandbox DB the
 * product itself creates (dist/db.js), the shape of an account HOME. The two arms differ ONLY in the tripwire: the child
 * env is { PATH, a name, that HOME } with NO port, i.e. the port falls back to its default.
 *   THE CLAIM: under the tripwire (the ordinary spawn), the register_agent STIMULUS itself reaches curl at the repaired
 *              port (curl http://127.0.0.1:1/mcp, tool register_agent), and nothing targets :3777. A run that only
 *              probed /health, or never registered, fails it (THE CONTROL).
 *   THE TWIN (the RED with the tripwire removed): the same child spawned PAST the tripwire (raw spawn) sends
 *              register_agent to http://127.0.0.1:3777/mcp: the default-port path is real, and the claim is not vacuous.
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

/** One recorded connection attempt: curl (its URL, and the MCP tool its body calls: the NAME only, never arguments) or node. */
type Rec = { via: "curl" | "node"; host: string; port: number; path?: string; tool?: string };
/**
 * Parse the instrument's log STRICTLY: `curl <url> tool=<name|->` or `node {"host":…,"port":…}`. Anything else (a
 * record the instrument could not form, a port that is not an integer) THROWS: a dropped record is never "no target".
 */
export function parseRecords(lines: string[]): Rec[] {
  return lines.map((l) => {
    const c = /^curl (https?:\/\/\S+) tool=([A-Za-z0-9_]+|-)$/.exec(l);
    if (c) {
      const u = new URL(c[1]);
      const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
      return { via: "curl" as const, host: u.hostname.replace(/^\[|\]$/g, ""), port, path: u.pathname, ...(c[2] === "-" ? {} : { tool: c[2] }) };
    }
    const n = /^node (\{.*\})$/.exec(l);
    if (n) {
      const o = JSON.parse(n[1]) as { host: unknown; port: unknown };
      if (Number.isInteger(o.port) && typeof o.host === "string") return { via: "node" as const, host: o.host, port: o.port as number };
    }
    throw new Error(`containment instrument: an unparseable record ${JSON.stringify(l)}: never dropped`);
  });
}
const DEFAULT_PORT = 3777;
/**
 * THE CLAIM, as one assertion (the live arm and the control both run it): no attempt on the DEFAULT port, AND the
 * register_agent stimulus itself reached curl, at the tripwire's repaired port 1 (a run that only probed /health, or
 * never registered, proves nothing about the register path).
 */
export function assertContainedRegistration(records: Rec[]): void {
  const shown = JSON.stringify(records);
  if (records.some((r) => r.port === DEFAULT_PORT)) throw new Error(`a target on the DEFAULT port ${DEFAULT_PORT}: ${shown}`);
  if (!records.some((r) => r.via === "curl" && r.host === "127.0.0.1" && r.port === 1 && r.path === "/mcp" && r.tool === "register_agent")) {
    throw new Error(`the register_agent stimulus never reached curl at the repaired port (curl http://127.0.0.1:1/mcp tool=register_agent): ${shown}`);
  }
}

/** A recording instrument: a fake curl and a node blocker preload, both writing into `dir`/log. Nothing connects. */
function instrument(name: string) {
  const dir = path.join(ROOT, name);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(dir, "log");
  fs.writeFileSync(log, "");
  // curl: one record per invocation, its URL and the MCP tool its body calls (the tool NAME only), then exit 7.
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!/bin/sh
url=""; tool=""
for a in "$@"; do
  case "$a" in
    http://*|https://*) url="$a" ;;
    *'"method":"tools/call"'*) tool=$(printf '%s' "$a" | sed -n 's/.*"params":{"name":"\\([A-Za-z0-9_]*\\)".*/\\1/p') ;;
  esac
done
[ -n "$url" ] && printf 'curl %s tool=%s\\n' "$url" "\${tool:--}" >> '${log}'
exit 7
`,
    { mode: 0o755 },
  );
  // node: every socket connect is refused and recorded; net.connect hands over its normalized [options, cb].
  const blocker = path.join(dir, "blocker.cjs");
  fs.writeFileSync(
    blocker,
    `const net = require("net"); const fs = require("fs");
     const orig = net.Socket.prototype.connect;
     net.Socket.prototype.connect = function (...a) {
       let o = Array.isArray(a[0]) ? a[0][0] : a[0];
       if (o === null || typeof o !== "object") o = { port: a[0], host: typeof a[1] === "string" ? a[1] : undefined };
       if (o.path !== undefined && o.port === undefined) return orig.apply(this, a); // a unix socket
       fs.appendFileSync(${JSON.stringify(log)}, "node " + JSON.stringify({ host: o.host === undefined ? "localhost" : o.host, port: Number(o.port) }) + "\\n");
       throw new Error("blocked by the containment test");
     };`,
  );
  const lines = () => fs.readFileSync(log, "utf-8").split("\n").filter(Boolean);
  return { bin, blocker, log, lines, records: () => parseRecords(lines()) };
}

describe.skipIf(process.platform === "win32")("CONTAINMENT (black-box): an env-{} child running the real SessionStart hook never targets the default port under the tripwire", () => {
  it("THE CLAIM: under the tripwire, the hook's register_agent reaches curl at the repaired port 1 (/mcp, tool register_agent), and NOTHING targets :3777", () => {
    const ins = instrument("claim");
    const home = homeWithInstance("claim");
    spawnSync("bash", [HOOK], { input: STDIN, encoding: "utf-8", timeout: 60_000, env: { PATH: `${ins.bin}:${NODE_DIR}:/usr/bin:/bin`, RELAY_AGENT_NAME: "fx-contain", HOME: home, NODE_OPTIONS: `--require ${ins.blocker}` } });
    assertContainedRegistration(ins.records());
  }, 90_000);

  it("THE TWIN, the tripwire REMOVED: the same hook spawned PAST the tripwire (raw spawn; a sandbox HOME only) sends register_agent to :3777 (the default-port path is real; the claim is not vacuous)", async () => {
    const ins = instrument("twin");
    const home = homeWithInstance("twin");
    await new Promise<number | null>((resolve) => {
      const c = spawnNestedRun("bash", [HOOK], { env: { PATH: `${ins.bin}:${NODE_DIR}:/usr/bin:/bin`, RELAY_AGENT_NAME: "fx-contain", HOME: home, NODE_OPTIONS: `--require ${ins.blocker}` }, stdio: ["pipe", "ignore", "ignore"] });
      c.stdin!.end(STDIN);
      c.on("close", resolve);
    });
    expect(ins.lines(), `without the tripwire register_agent goes to the DEFAULT port (recorded: ${JSON.stringify(ins.lines())})`).toContain("curl http://127.0.0.1:3777/mcp tool=register_agent");
  }, 90_000);

  it("THE CONTROL: a registration-skipped, health-only run (one probe of /health at port 1, no register_agent) FAILS the claim; so does any :3777 target", () => {
    expect(() => assertContainedRegistration(parseRecords(["curl http://127.0.0.1:1/health tool=-"]))).toThrow(/the register_agent stimulus never reached curl/);
    expect(() => assertContainedRegistration(parseRecords(["curl http://127.0.0.1:1/mcp tool=register_agent", 'node {"host":"127.0.0.1","port":3777}']))).toThrow(/DEFAULT port/);
    expect(() => assertContainedRegistration(parseRecords(["curl http://127.0.0.1:1/mcp tool=register_agent"]))).not.toThrow();
  });

  it("THE NODE RECORDER: a connect through net's NORMALIZED [options, cb] shape, and an IPv6 endpoint, are recorded (never dropped); an unparseable record FAILS", () => {
    const ins = instrument("node-shapes");
    const code = `const net = require("net"); for (const [port, host] of [[4321, "127.0.0.1"], [4322, "::1"]]) { try { net.connect({ port, host }); } catch {} } try { net.createConnection(4323); } catch {}`;
    const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf-8", env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: `--require ${ins.blocker}` } });
    expect(r.status, r.stderr).toBe(0);
    expect(ins.records().map((x) => [x.host, x.port])).toEqual([["127.0.0.1", 4321], ["::1", 4322], ["localhost", 4323]]);
    expect(() => parseRecords(["node ?:undefined"])).toThrow(/unparseable record/);
    expect(() => parseRecords(['node {"host":"127.0.0.1","port":null}'])).toThrow(/unparseable record/);
    expect(parseRecords(["curl http://[::1]:3777/mcp tool=register_agent"])[0]).toEqual({ via: "curl", host: "::1", port: 3777, path: "/mcp", tool: "register_agent" });
  });
});
