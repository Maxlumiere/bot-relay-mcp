// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The OPERATOR TRIPWIRE's own tests (tests/_setup/operator-tripwire.ts). Every test shows the
 * harm is REFUSED where it happens, and NEVER delivered: a canary listener stands in for the
 * operator's daemon (added as an operator port for the test), and it must see ZERO
 * connections. Each one first proves the harness is GREEN on a non-operator port (the same
 * call reaches its canary), so a red cannot be a broken harness.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import http from "http";
import net from "net";
import path from "path";
import { execFile, spawnSync } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { addOperatorPortForTest, drainTripwireViolations, tripwireView } from "./_setup/operator-tripwire.js";

const execFileP = promisify(execFile);

interface Canary { port: number; hits: () => number; close: () => Promise<void> }
async function canary(): Promise<Canary> {
  let hits = 0;
  const srv = http.createServer((_req, res) => res.end("ok"));
  srv.on("connection", () => hits++);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  return { port, hits: () => hits, close: () => new Promise((r) => srv.close(() => r())) };
}

const undo: Array<() => void> = [];
const servers: Canary[] = [];
afterEach(async () => {
  while (undo.length) undo.pop()!();
  await Promise.all(servers.splice(0).map((c) => c.close()));
});
async function operatorCanary(): Promise<Canary> {
  const c = await canary();
  servers.push(c);
  undo.push(addOperatorPortForTest(c.port));
  return c;
}
async function plainCanary(): Promise<Canary> {
  const c = await canary();
  servers.push(c);
  return c;
}
const get = (port: number) => new Promise<string>((resolve, reject) => {
  try {
    http.get({ host: "127.0.0.1", port, path: "/" }, (res) => { res.resume(); res.on("end", () => resolve("ok")); }).on("error", reject);
  } catch (err) {
    reject(err);
  }
});

describe("PORT: in this process", () => {
  it("control: a NON-operator port is reached", async () => {
    const c = await plainCanary();
    await expect(get(c.port)).resolves.toBe("ok");
    expect(c.hits()).toBe(1);
  });
  it("HARM: http to an operator port is REFUSED and never delivered; the refusal is recorded even when the caller swallows it", async () => {
    const c = await operatorCanary();
    let swallowed: unknown = null;
    try {
      await get(c.port);
    } catch (err) {
      swallowed = err; // a test that catches the error...
    }
    expect(String(swallowed)).toMatch(/OPERATOR_TRIPWIRE/);
    expect(c.hits()).toBe(0);
    expect(drainTripwireViolations()).toEqual([expect.stringMatching(new RegExp(`connect 127\\.0\\.0\\.1:${c.port}$`))]); // ...is still failed by the record
  });
  it("HARM: fetch to an operator port is refused and never delivered", async () => {
    const c = await operatorCanary();
    await expect(fetch(`http://localhost:${c.port}/health`)).rejects.toThrow();
    expect(c.hits()).toBe(0);
    expect(drainTripwireViolations()).toHaveLength(1);
  });
});

describe.skipIf(process.platform === "win32")("PORT: in a child, with an env the test built FROM SCRATCH", () => {
  it("control: curl and node reach a NON-operator port (async: a SYNC spawn would starve this process's canary)", async () => {
    const c = await plainCanary();
    const curl = await execFileP("curl", ["-s", "-m", "5", `http://127.0.0.1:${c.port}/`], { env: { PATH: process.env.PATH ?? "" } });
    expect(curl.stdout).toBe("ok");
    const node = await execFileP(process.execPath, ["-e", `fetch("http://127.0.0.1:${c.port}/").then(r=>r.text()).then(t=>process.stdout.write(t))`], { env: {}, timeout: 10_000 });
    expect(node.stdout).toBe("ok");
    expect(c.hits()).toBe(2);
  });
  it("HARM: a child's curl to an operator port is refused (never delivered) and the spawn THROWS at the test's line", async () => {
    const c = await operatorCanary();
    // -m 3: should the shim ever be missing, curl reaches this process's canary, which a SYNC spawn
    // starves; it must then fail by this assertion, not hang.
    expect(() => spawnSync("curl", ["-s", "-m", "3", `http://127.0.0.1:${c.port}/mcp`], { encoding: "utf-8", env: { PATH: process.env.PATH ?? "" } })).toThrow(/OPERATOR_TRIPWIRE \(child_process\.spawnSync\)[\s\S]*curl pid=\d+ url=http:\/\/127\.0\.0\.1:\d+\/mcp/);
    expect(c.hits()).toBe(0);
  });
  it("HARM: a node child's fetch to an operator port is refused and the spawn throws (env {}: no PATH, no NODE_OPTIONS of its own)", async () => {
    const c = await operatorCanary();
    expect(() => spawnSync(process.execPath, ["-e", `fetch("http://127.0.0.1:${c.port}/").catch(()=>{})`], { encoding: "utf-8", env: {} })).toThrow(/node pid=\d+ connect 127\.0\.0\.1:\d+/);
    expect(c.hits()).toBe(0);
  });
  it("a bash child's `curl` stays MISSING when its own PATH has none (the shim never adds a curl)", () => {
    const r = spawnSync("/bin/bash", ["-c", "command -v curl || echo none"], { encoding: "utf-8", env: { PATH: "/nonexistent-dir" } });
    expect(r.stdout.trim()).toBe("none");
  });
});

describe("INSTANCE: the operator's real relay root", () => {
  it("HARM: reading or writing under it THROWS in this process (resolving the live instance reads its marker)", () => {
    const [root] = tripwireView().roots;
    for (const f of [() => fs.readlinkSync(path.join(root, "active-instance")), () => fs.readFileSync(path.join(root, "config.json")), () => fs.writeFileSync(path.join(root, "x.tmp"), "x"), () => fs.readdirSync(root)]) {
      expect(f).toThrow(/OPERATOR_TRIPWIRE: fs\.\w+\(.*\) names the OPERATOR's live relay root/);
    }
    expect(drainTripwireViolations()).toHaveLength(4);
  });
  it("metadata-only calls are NOT flagged (the relay's own write guard canonicalizes the real path to refuse it)", () => {
    const [root] = tripwireView().roots;
    expect(() => [fs.existsSync(root), fs.existsSync(path.join(root, "config.json"))]).not.toThrow();
    expect(drainTripwireViolations()).toEqual([]);
  });
  it("HARM: a child env NAMING the operator's home or relay root is refused BEFORE the child starts", () => {
    const { realHome, roots } = tripwireView();
    const marker = path.join(tripwireView().privateHome, `never-${process.pid}`);
    for (const env of [{ HOME: realHome }, { HOME: "/tmp", RELAY_HOME: roots[0] }, { HOME: "/tmp", RELAY_DB_PATH: path.join(roots[0], "relay.db") }]) {
      expect(() => spawnSync("/bin/sh", ["-c", `touch ${marker}`], { env: { PATH: "/usr/bin:/bin", ...env } })).toThrow(/refused to spawn: .*names the OPERATOR's home or relay root/);
    }
    expect(fs.existsSync(marker)).toBe(false); // never started
  });
  it("a child env with NO HOME gets the private test HOME, never the passwd (operator) home", () => {
    const { realHome, privateHome } = tripwireView();
    const r = spawnSync("/bin/sh", ["-c", 'printf %s "$HOME"'], { encoding: "utf-8", env: { PATH: "/usr/bin:/bin" } });
    expect(r.stdout).toBe(privateHome);
    expect(r.stdout).not.toBe(realHome);
  });
  it("this process's HOME is the private one, and RELAY_HTTP_PORT is the safe default (1)", () => {
    expect(process.env.HOME).toBe(tripwireView().privateHome);
    expect(process.env.RELAY_HTTP_PORT).toBe("1");
  });
});

describe("a test that SWALLOWS a refusal is still failed (the afterEach check)", () => {
  it("a nested run of a fixture that catches a refused operator-port connect FAILS, naming the tripwire (and the shell's port IS an operator port)", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // never URL.pathname: it keeps %20
    const c = await plainCanary(); // an operator port ONLY for the nested run, as its ambient RELAY_HTTP_PORT
    const env = { ...process.env, RELAY_HTTP_PORT: String(c.port), TRIPWIRE_FIXTURE_PORT: String(c.port) };
    const r = await execFileP(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--config", path.join(root, "tests", "fixtures", "operator-tripwire", "vitest.config.ts")], { cwd: root, env, timeout: 60_000 }).then(
      (ok) => ({ code: 0, out: ok.stdout + ok.stderr }),
      (err: { code?: number; stdout?: string; stderr?: string; message?: string }) => ({ code: err.code ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}`, msg: err.message }),
    );
    expect(r.out, JSON.stringify(r).slice(0, 800)).toMatch(/swallow\.fixture\.ts/); // precondition: the fixture ran
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(new RegExp(`OPERATOR_TRIPWIRE \\(afterEach\\)[\\s\\S]*connect 127\\.0\\.0\\.1:${c.port}`));
    expect(c.hits()).toBe(0); // refused, never delivered
  }, 90_000);
});
