// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR-D: registering a NEW agent name over HTTP requires the instance's registration secret
 * (architect rulings 3414e98a, f885e674, dfa29648, efb48600, 64131354).
 *
 * The HARM (MEASURED on main before this PR): any local process with no credential could POST register_agent
 * for a fresh name to the loopback daemon and receive a token: an injection channel and a name-squatting
 * vector (the live DB holds a "probe" row minted exactly that way).
 */
import { describe, it, expect, beforeEach, afterAll, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import type { Server as HttpServer } from "http";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr-d-")));
process.env.RELAY_DB_PATH = path.join(ROOT, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_ALLOW_OPEN_MINT;

const db = await import("../src/db.js");
const { _resetAuthThrottleForTests, THROTTLE_BURST } = await import("../src/auth-throttle.js");
const { _resetAuthRejectionAuditForTests } = await import("../src/auth-rejection-audit.js");
const { decryptContent } = await import("../src/encryption.js");
const { checkMintGate, prepareMintSecret, mintSecretHome } = await import("../src/mint-gate.js");
const { mintSecretPath, readMintSecret, ensureMintSecret } = await import("../src/mint-secret.js");

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const SECRETS = path.join(ROOT, "secrets");
function reset(): void {
  db.closeDb();
  for (const f of ["relay.db", "relay.db-wal", "relay.db-shm", "token-lookup.key"]) fs.rmSync(path.join(ROOT, f), { force: true });
  fs.rmSync(SECRETS, { recursive: true, force: true });
  delete process.env.RELAY_ALLOW_OPEN_MINT;
  delete process.env.RELAY_HTTP_SECRET;
  _resetAuthThrottleForTests();
  _resetAuthRejectionAuditForTests();
  db.getDb();
}
beforeEach(reset);
afterEach(() => {
  delete process.env.RELAY_ALLOW_OPEN_MINT;
  delete process.env.RELAY_HTTP_SECRET;
});

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

async function withDaemon(fn: (port: number) => Promise<void>, host = "127.0.0.1"): Promise<void> {
  const { startHttpServer } = await import("../src/transport/http.js");
  const server: HttpServer = startHttpServer(0, host);
  await new Promise((r) => setTimeout(r, 80));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** One register_agent call over HTTP. `headers` carries X-Relay-Secret / Authorization / X-Agent-Token. */
async function register(port: number, name: string, headers: Record<string, string> = {}): Promise<{ isError: boolean; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "register_agent", arguments: { name, role: "worker", capabilities: [] } } }),
  });
  const text = await r.text();
  const json = JSON.parse(text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text);
  return { isError: json.result?.isError === true, body: JSON.parse(json.result.content[0].text) };
}
const secretNow = () => readMintSecret(ROOT)!;

describe("the gate: a NEW name over HTTP needs the registration secret", () => {
  it("HARM: no secret → refused, MINT_SECRET_REQUIRED, and NO row is created", async () => {
    await withDaemon(async (port) => {
      const r = await register(port, "squatter");
      expect(r.isError).toBe(true);
      expect(r.body.error_code).toBe("MINT_SECRET_REQUIRED");
      expect(r.body.error).not.toContain(secretNow()); // the refusal never echoes the secret
    });
    expect(db.getAgentAuthData("squatter")).toBeNull();
  });

  it("a WRONG secret → refused the same way", async () => {
    await withDaemon(async (port) => {
      const r = await register(port, "squatter", { "X-Relay-Secret": crypto.randomBytes(32).toString("base64url") });
      expect(r.body.error_code).toBe("MINT_SECRET_REQUIRED");
    });
    expect(db.getAgentAuthData("squatter")).toBeNull();
  });

  it("the RIGHT secret, as X-Relay-Secret or as Authorization: Bearer → registered, with a token", async () => {
    await withDaemon(async (port) => {
      const a = await register(port, "via-header", { "X-Relay-Secret": secretNow() });
      const b = await register(port, "via-bearer", { Authorization: `Bearer ${secretNow()}` });
      expect([a.isError, b.isError]).toEqual([false, false]);
      expect(typeof a.body.agent_token).toBe("string");
    });
    expect(db.getAgentAuthData("via-header")).not.toBeNull();
    expect(db.getAgentAuthData("via-bearer")).not.toBeNull();
  });

  it("an EXISTING agent re-registers with its own token and NO secret (Q1: token calls unchanged)", async () => {
    const token = db.registerAgent("existing", "worker", []).plaintext_token!;
    db.getDb().prepare("UPDATE agents SET session_id = NULL WHERE name = ?").run("existing"); // offline: the live-session collision guard is not under test here
    await withDaemon(async (port) => {
      const r = await register(port, "existing", { "X-Agent-Token": token });
      expect(r.isError, JSON.stringify(r.body)).toBe(false);
    });
  });

  it("stdio is out of scope (Q6): the gate passes a stdio caller without a secret", () => {
    expect(checkMintGate("stdio", undefined)).toEqual({ ok: true, mode: "stdio" });
  });

  it("the gate is SYNCHRONOUS (64131354 point 2): no await can sit between it and the write", () => {
    expect(checkMintGate.constructor.name).toBe("Function");
    expect(checkMintGate("http", undefined)).not.toBeInstanceOf(Promise);
  });
});

describe("fail closed, audited, throttled", () => {
  it("a secret DELETED after start → every new-name register refused (unavailable), /health says so", async () => {
    await withDaemon(async (port) => {
      fs.rmSync(mintSecretPath(ROOT));
      const r = await register(port, "after-delete", { "X-Relay-Secret": "x".repeat(43) });
      expect(r.body.error_code).toBe("MINT_SECRET_REQUIRED");
      const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      expect(health.mint).toBe("unavailable");
    });
    expect(db.getAgentAuthData("after-delete")).toBeNull();
  });

  it("a symlink planted at the secret's path is never followed (fail closed)", async () => {
    await withDaemon(async (port) => {
      const target = path.join(ROOT, "planted");
      fs.writeFileSync(target, "p".repeat(43));
      fs.rmSync(mintSecretPath(ROOT));
      fs.symlinkSync(target, mintSecretPath(ROOT));
      const r = await register(port, "via-link", { "X-Relay-Secret": "p".repeat(43) });
      expect(r.body.error_code).toBe("MINT_SECRET_REQUIRED");
    });
    expect(db.getAgentAuthData("via-link")).toBeNull();
  });

  it("refusals are AUDITED (Q11): one bounded auth_rejection row, reason mint_secret_missing, agent_name NULL", async () => {
    await withDaemon(async (port) => {
      for (let i = 0; i < 3; i++) await register(port, `nope-${i}`);
    });
    const rows = db.getDb().prepare("SELECT agent_name, error, params_json FROM audit_log WHERE tool = 'auth_rejection'").all() as Array<{ agent_name: string | null; error: string; params_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_name).toBeNull();
    expect(rows[0].error).toBe("mint_secret_missing");
    expect(JSON.parse(decryptContent(rows[0].params_json)!).count).toBe(3);
  });

  it("refusals spend the SOURCE's mint budget (Q11), keyed by source not name: fresh names do not evade it", async () => {
    await withDaemon(async (port) => {
      const codes: string[] = [];
      for (let i = 0; i < THROTTLE_BURST + 2; i++) codes.push((await register(port, `fresh-${i}`)).body.error_code);
      expect(codes.slice(0, THROTTLE_BURST)).toEqual(Array(THROTTLE_BURST).fill("MINT_SECRET_REQUIRED"));
      expect(codes.slice(THROTTLE_BURST)).toEqual(["RATE_LIMITED", "RATE_LIMITED"]);
      // the right secret is never throttled: only refusals spend
      expect((await register(port, "legit", { "X-Relay-Secret": secretNow() })).isError).toBe(false);
    });
  });
});

describe("the daemon's start (Q4, Q5, Q8)", () => {
  it("auto-mints at start: 0600 in a 0700 dir, announced once, /health mint: secret", async () => {
    const said: string[] = [];
    expect(prepareMintSecret(true, null, { info: (m) => said.push(m), warn: () => {}, error: () => {} })).toBe("secret");
    expect(prepareMintSecret(true, null, { info: (m) => said.push(m), warn: () => {}, error: () => {} })).toBe("secret");
    expect(said).toHaveLength(1);
    expect(said[0]).not.toContain(secretNow());
    if (process.platform !== "win32") {
      expect(fs.statSync(SECRETS).mode & 0o777).toBe(0o700);
      expect(fs.statSync(mintSecretPath(ROOT)).mode & 0o777).toBe(0o600);
    }
    await withDaemon(async (port) => {
      expect((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).mint).toBe("secret");
    });
  });

  it("an existing secret is never replaced; a widened mode is tightened", () => {
    ensureMintSecret(ROOT);
    const before = secretNow();
    if (process.platform !== "win32") fs.chmodSync(mintSecretPath(ROOT), 0o644);
    prepareMintSecret(true, null, quiet);
    expect(secretNow()).toBe(before);
    if (process.platform !== "win32") expect(fs.statSync(mintSecretPath(ROOT)).mode & 0o777).toBe(0o600);
  });

  it("Q8 UPGRADE: a legacy http_secret SEEDS the secret, so a remote client sending it can still register a new name", async () => {
    const legacy = crypto.randomBytes(32).toString("base64url");
    process.env.RELAY_HTTP_SECRET = legacy;
    await withDaemon(async (port) => {
      expect(secretNow()).toBe(legacy);
      const r = await register(port, "remote-client", { "X-Relay-Secret": legacy });
      expect(r.isError, JSON.stringify(r.body)).toBe(false);
    });
  });

  it("a legacy http_secret that DIFFERS from an existing secret is a loud warning, and the file wins", () => {
    ensureMintSecret(ROOT);
    const warned: string[] = [];
    prepareMintSecret(true, crypto.randomBytes(32).toString("base64url"), { info: () => {}, warn: (m) => warned.push(m), error: () => {} });
    expect(warned.join("\n")).toMatch(/DIFFERS/);
  });

  it("Q5: RELAY_ALLOW_OPEN_MINT=1 on loopback → open-dev, loud, and a new name registers without a secret", async () => {
    process.env.RELAY_ALLOW_OPEN_MINT = "1";
    const warned: string[] = [];
    expect(prepareMintSecret(true, null, { info: () => {}, warn: (m) => warned.push(m), error: () => {} })).toBe("open-dev");
    expect(warned.join("\n")).toMatch(/OPEN MINT/);
    await withDaemon(async (port) => {
      expect((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).mint).toBe("open-dev");
      expect((await register(port, "dev-name")).isError).toBe(false);
    });
  });

  it("Q5: RELAY_ALLOW_OPEN_MINT=1 on a NON-loopback bind → the daemon refuses to start", () => {
    process.env.RELAY_ALLOW_OPEN_MINT = "1";
    expect(() => prepareMintSecret(false, null, quiet)).toThrow(/Refusing to start/);
  });

  it("the secret lives beside the DB it guards", () => {
    expect(mintSecretHome()).toBe(ROOT);
  });
});

describe("the secret file under concurrency", () => {
  it("8 processes racing the FIRST start, 5 rounds: none crashes, all read ONE secret, no temp file left (MEASURED before: 30/30 rounds crashed)", async () => {
    const dir = fs.mkdtempSync(path.join(ROOT, "race-"));
    const mod = path.resolve("src/mint-secret.ts");
    const child = `const { ensureMintSecret, readMintSecret } = await import(${JSON.stringify(mod)}); const go = Number(process.argv[1]); while (Date.now() < go) {} try { ensureMintSecret(${JSON.stringify(dir)}); console.log("OK " + readMintSecret(${JSON.stringify(dir)})); } catch (e) { console.log("ERR " + e.message); }`;
    const runOne = (go: string) =>
      new Promise<string>((resolve) => {
        const p = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", child, go], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        p.stdout.on("data", (d: Buffer) => (out += d));
        p.on("close", () => resolve(out.trim()));
      });
    for (let round = 0; round < 5; round++) {
      fs.rmSync(path.join(dir, "secrets"), { recursive: true, force: true });
      const go = String(Date.now() + 600);
      const outs = await Promise.all(Array.from({ length: 8 }, () => runOne(go)));
      expect(outs.filter((o) => !o.startsWith("OK ")), `round ${round}: ${outs.join("\n")}`).toEqual([]);
      expect(new Set(outs).size, `round ${round}`).toBe(1);
      expect(fs.readdirSync(path.join(dir, "secrets")), `round ${round}`).toEqual(["mint.secret"]);
    }
  }, 60_000);
});

describe("the hooks send the secret without exposing it (Q2)", () => {
  it("relay_mint_secret_curl_config | curl -K -: the server receives X-Relay-Secret, and NO process's argv ever holds the secret", async () => {
    const { createServer } = await import("http");
    ensureMintSecret(ROOT);
    const secret = secretNow();
    let received: string | undefined;
    const srv = createServer((req, res) => {
      received = req.headers["x-relay-secret"] as string | undefined;
      setTimeout(() => res.end("{}"), 400); // hold the request open so the sampler sees curl alive
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    const helpers = path.resolve("hooks/_vault-helpers.sh");
    const script = `. ${JSON.stringify(helpers)}; RELAY_RES_LOADED=1; RELAY_RES_KIND=instance; RELAY_RES_DB_PATH=${JSON.stringify(path.join(ROOT, "relay.db"))}; { relay_mint_secret_curl_config || true; } | curl -s -m 5 -K - -X POST http://127.0.0.1:${port}/mcp -d '{}' >/dev/null`;
    let sampled = 0;
    let leaked = "";
    let done = false;
    const sampler = (async () => {
      while (!done) {
        const out = await new Promise<string>((resolve) => {
          const p = spawn("ps", ["-axww", "-o", "args="], { stdio: ["ignore", "pipe", "ignore"] });
          let o = "";
          p.stdout.on("data", (d: Buffer) => (o += d));
          p.on("close", () => resolve(o));
        });
        sampled++;
        if (out.includes(secret)) leaked = out.split("\n").filter((l) => l.includes(secret)).join("\n");
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    // ASYNC: the server and the sampler live on THIS loop (a spawnSync would block both: MEASURED, curl timed out).
    const child = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const p = spawn("bash", ["-c", script], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      p.stderr.on("data", (d: Buffer) => (stderr += d));
      p.on("close", (status) => resolve({ status, stderr }));
    });
    done = true;
    await sampler;
    await new Promise<void>((r) => srv.close(() => r()));
    expect(child.status, child.stderr).toBe(0);
    expect(received, "the server received the secret as X-Relay-Secret").toBe(secret);
    expect(sampled, "the ps sampler ran while curl was alive").toBeGreaterThan(3);
    expect(leaked, "no argv held the secret").toBe("");
  }, 30_000);

  it("a symlinked or malformed secret file sends NOTHING (the server then refuses, loudly)", () => {
    const helpers = path.resolve("hooks/_vault-helpers.sh");
    const run = () =>
      spawnSync("bash", ["-c", `. ${JSON.stringify(helpers)}; RELAY_RES_LOADED=1; RELAY_RES_KIND=instance; RELAY_RES_DB_PATH=${JSON.stringify(path.join(ROOT, "relay.db"))}; relay_mint_secret_curl_config; echo "rc=$?"`], { encoding: "utf8" }).stdout.trim();
    fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ROOT, "elsewhere"), "e".repeat(43));
    fs.symlinkSync(path.join(ROOT, "elsewhere"), mintSecretPath(ROOT));
    expect(run()).toBe("rc=1");
    fs.rmSync(mintSecretPath(ROOT));
    fs.writeFileSync(mintSecretPath(ROOT), 'short"\n');
    expect(run()).toBe("rc=1");
    fs.writeFileSync(mintSecretPath(ROOT), `${"a".repeat(40)}"\nheader = "X-Evil: 1"\n`);
    expect(run()).toBe("rc=1");
  });
});

describe("a SessionStart hook that runs TWICE in one window (architect 3f041f24)", () => {
  const regAs = async (port: number, name: string, token: string | undefined, pid: number, start: string, extra: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { "X-Agent-Token": token } : {}), ...extra },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "register_agent", arguments: { name, role: "worker", capabilities: [], agent_pid: pid, agent_pid_start: start, host_id: "host-A" } } }),
    });
    const text = await r.text();
    const json = JSON.parse(text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text);
    return { isError: json.result?.isError === true, body: JSON.parse(json.result.content[0].text) };
  };

  it("HARM: run 2 of the SAME window (same token, same agent_pid + start) is NOT a collision: success, reported as a refresh", async () => {
    await withDaemon(async (port) => {
      const first = await regAs(port, "twice", undefined, 4242, "start-1", { "X-Relay-Secret": secretNow() });
      expect(first.isError, JSON.stringify(first.body)).toBe(false);
      const token = first.body.agent_token as string;
      const second = await regAs(port, "twice", token, 4242, "start-1");
      expect(second.isError, JSON.stringify(second.body)).toBe(false);
      expect(second.body.refreshed).toBe(true);
    });
  });

  it("a DIFFERENT window (another pid, or the same pid with another start time) is still refused as a collision", async () => {
    await withDaemon(async (port) => {
      const first = await regAs(port, "held", undefined, 5000, "s-1", { "X-Relay-Secret": secretNow() });
      const token = first.body.agent_token as string;
      expect((await regAs(port, "held", token, 5001, "s-1")).body.error_code).toBe("NAME_COLLISION_ACTIVE");
      expect((await regAs(port, "held", token, 5000, "s-2")).body.error_code).toBe("NAME_COLLISION_ACTIVE"); // a recycled pid
    });
  });
});

/**
 * Architect fd2f6b9f Q-A: the gate is defined by the HARM, "an unauthenticated caller receives a token". Every
 * register path that ISSUES a token is enumerated here (db.ts generateToken sites, by what they do): each one
 * either needs the registration secret over HTTP, or carries a credential bound to the row.
 */
describe("every register path that ISSUES a token, by the harm predicate (Q-A)", () => {
  const call = async (port: number, args: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "register_agent", arguments: { role: "worker", capabilities: [], ...args } } }),
    });
    const text = await r.text();
    const json = JSON.parse(text.startsWith("event:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text);
    return { isError: json.result?.isError === true, body: JSON.parse(json.result.content[0].text) };
  };
  const makeLegacy = (name: string) => {
    db.registerAgent(name, "worker", []);
    db.getDb().prepare("UPDATE agents SET token_hash = NULL, token_lookup = NULL, session_id = NULL, auth_state = 'legacy_bootstrap' WHERE name = ?").run(name);
  };

  it("HARM: a pre-v1.7 (legacy_bootstrap) row taken over with NO credential over HTTP → refused, no token, the row stays legacy", async () => {
    makeLegacy("old-agent");
    await withDaemon(async (port) => {
      const r = await call(port, { name: "old-agent" });
      expect(r.body.error_code).toBe("MINT_SECRET_REQUIRED");
      expect(r.body.error).toMatch(/pre-v1\.7/);
      expect(r.body.agent_token).toBeUndefined();
    });
    expect(db.getAgentAuthData("old-agent")!.auth_state).toBe("legacy_bootstrap");
  });

  it("the same legacy row WITH the registration secret → migrated, with a token", async () => {
    makeLegacy("old-agent2");
    await withDaemon(async (port) => {
      const r = await call(port, { name: "old-agent2" }, { "X-Relay-Secret": secretNow() });
      expect(r.isError, JSON.stringify(r.body)).toBe(false);
      expect(typeof r.body.agent_token).toBe("string");
    });
    expect(db.getAgentAuthData("old-agent2")!.auth_state).toBe("active");
  });

  it("recovery_pending + its RECOVERY TOKEN (a credential bound to the row) → token issued with NO registration secret", async () => {
    db.registerAgent("recovering", "worker", []);
    const { recoveryToken } = db.revokeAgentToken("recovering", { issueRecovery: true });
    await withDaemon(async (port) => {
      const r = await call(port, { name: "recovering", recovery_token: recoveryToken });
      expect(r.isError, JSON.stringify(r.body)).toBe(false);
      expect(typeof r.body.agent_token).toBe("string");
    });
  });

  it("recovery_pending WITHOUT its recovery token → refused, no token (the bound credential is what authorizes it)", async () => {
    db.registerAgent("recovering2", "worker", []);
    db.revokeAgentToken("recovering2", { issueRecovery: true });
    await withDaemon(async (port) => {
      const r = await call(port, { name: "recovering2" }, { "X-Relay-Secret": secretNow() });
      expect(r.isError).toBe(true);
      expect(r.body.agent_token).toBeUndefined();
    });
  });

  it("an 'active' row with NO token hash (data-integrity fault) never reaches the defensive mint unauthenticated: fails closed", async () => {
    db.registerAgent("broken", "worker", []);
    db.getDb().prepare("UPDATE agents SET token_hash = NULL, token_lookup = NULL, session_id = NULL WHERE name = ?").run("broken");
    await withDaemon(async (port) => {
      const r = await call(port, { name: "broken" }, { "X-Relay-Secret": secretNow() });
      expect(r.isError).toBe(true);
      expect(r.body.agent_token).toBeUndefined();
    });
  });

  it("the stdio path is out of scope (Q6): a legacy row migrates over stdio without the secret", () => {
    expect(checkMintGate("stdio", undefined).ok).toBe(true);
  });
});
