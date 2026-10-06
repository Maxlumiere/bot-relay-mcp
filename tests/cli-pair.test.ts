// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 7r — `relay pair <hub-url>` integration tests.
 *
 * Exercises the new CLI subcommand end-to-end against a live in-process
 * HTTP hub. Three canonical paths per spec §2.1:
 *
 *   (1) happy path  — no secret required → exit 0 + config snippet + token
 *   (2) unreachable — hub not running     → exit 1 + clear error on stderr
 *   (3) bad-secret  — hub 401-rejects     → exit 2 + no token emitted
 *
 * NOTE: pair.ts is a pure HTTP client. The hub IS the in-process server
 * this test starts. That means we MUST spawn the CLI as an async child
 * (not spawnSync) — spawnSync blocks the Node event loop, so the hub
 * cannot answer the child's curl and requests time out with status 000.
 * See tests/regression-plug-and-play.test.ts CANARY 6 for the same
 * discipline on the SessionStart hook.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import type { Server as HttpServer } from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-pair-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb } = await import("../src/db.js");

let server: HttpServer | null = null;
let baseUrl = "";

function resetRoot() {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
}

async function startHubWithEnv(extraEnv: Record<string, string | undefined>): Promise<{ url: string; port: number }> {
  // Apply env overrides + restart the server. startHttpServer reads the
  // config at call time via loadConfig, which reads process.env.
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 80));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  return { url: baseUrl, port };
}

function stopHub() {
  try { server?.close(); } catch { /* ignore */ }
  server = null;
  closeDb();
}

async function runPair(args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<{
  status: number;
  stdout: string;
  stderr: string;
}> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const child = spawn("node", [RELAY_BIN, "pair", ...args], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  const exitCode: number = await new Promise((resolve) => {
    const timeout = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(-1); }, 15_000);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code ?? -1);
    });
  });
  return { status: exitCode, stdout, stderr };
}

beforeEach(() => {
  resetRoot();
  // Ensure a clean env for every test — no bleed-through of secrets or tokens.
  delete process.env.RELAY_HTTP_SECRET;
  delete process.env.RELAY_AGENT_TOKEN;
  delete process.env.RELAY_ALLOW_LEGACY;
});

afterEach(() => {
  stopHub();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  delete process.env.RELAY_HTTP_SECRET;
  delete process.env.RELAY_AGENT_TOKEN;
});

const hubSecretFile = () => path.join(TEST_ROOT, "secrets", "mint.secret");
/** A fresh --output path (nothing there yet). */
const outFile = () => path.join(TEST_ROOT, "out", `pair-${Math.random().toString(36).slice(2)}.json`);
const readConfig = (f: string) => JSON.parse(fs.readFileSync(f, "utf-8"));
/** A file holding `value` (0600), as an operator would hand over the hub's secret. */
function secretFileWith(value: string): string {
  const f = path.join(TEST_ROOT, `handed-${Math.random().toString(36).slice(2)}.secret`);
  fs.writeFileSync(f, value + "\n", { mode: 0o600 });
  return f;
}

describe("v2.1 Phase 7r — relay pair CLI (PR-D: the hub's secret never rides argv)", () => {
  it("(1) PR-D: a hub with no http_secret STILL needs its registration secret: no secret → exit 2, an actionable refusal naming --secret-file, no token", async () => {
    const { url } = await startHubWithEnv({ RELAY_HTTP_SECRET: undefined });
    const out = outFile();
    const r = await runPair([url, "--name", "pair-test-agent", "--role", "tester", "--output", out, "--yes"]);
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(2);
    expect(fs.existsSync(out), "no config is written when no token was issued").toBe(false);
    expect(r.stderr).toMatch(/--secret-file/);
    expect(r.stderr).toMatch(/secrets\/mint\.secret/);
    expect(r.stderr).not.toContain(fs.readFileSync(hubSecretFile(), "utf-8").trim()); // never printed
    expect(r.stdout).not.toMatch(/--- MCP client config snippet ---/);
  });

  it("(1b) happy path: --secret-file holding the hub's secret → exit 0; the config (with X-Agent-Token) goes ONLY to --output (0600); stdout is redacted; the secret stays OUT of the config", async () => {
    const { url } = await startHubWithEnv({ RELAY_HTTP_SECRET: undefined });
    const hubSecret = fs.readFileSync(hubSecretFile(), "utf-8").trim();
    const out = outFile();
    const r = await runPair([url, "--name", "pair-test-agent", "--role", "tester", "--secret-file", secretFileWith(hubSecret), "--output", out, "--yes"]);
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/Hub reachable:/);
    expect(r.stdout).toMatch(/version:/);
    expect(r.stdout).toMatch(/protocol_version:/);
    const parsed = readConfig(out);
    if (process.platform !== "win32") expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    expect(parsed["bot-relay"].type).toBe("http");
    expect(parsed["bot-relay"].url).toBe(`${url}/mcp`);
    const token = parsed["bot-relay"].headers["X-Agent-Token"];
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(20);
    // The hub does not gate every call (no http_secret), so the secret is not written into the client config.
    expect(parsed["bot-relay"].headers["X-Relay-Secret"]).toBeUndefined();
    // Codex R1 #3: neither credential is printed, anywhere; stdout shows the SHAPE with the values pointing at the file.
    for (const stream of [r.stdout, r.stderr]) {
      expect(stream).not.toContain(token);
      expect(stream).not.toContain(hubSecret);
    }
    const redacted = JSON.parse(r.stdout.match(/--- MCP client config snippet \(redacted\) ---\n([\s\S]+?)\n--- end snippet ---/)![1]);
    expect(redacted["bot-relay"].headers["X-Agent-Token"]).toBe(`<in ${out}>`);
    expect(redacted["bot-relay"].url).toBe(`${url}/mcp`);
    expect(r.stdout).toMatch(/relay doctor --remote/);
  });

  it("(1c) Codex R1 #3: no --output → refused BEFORE any network call (no token is issued that could not be stored)", async () => {
    const r = await runPair(["http://127.0.0.1:59999", "--name", "no-output-test", "--yes"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--output PATH is required/);
    expect(r.stderr).not.toMatch(/cannot reach hub/);
  });

  it("(1d) Codex R1 #3: an EXISTING --output (a looser-mode file, or a symlink) is never overwritten or followed, and nothing is registered", async () => {
    const { url } = await startHubWithEnv({ RELAY_HTTP_SECRET: undefined });
    const hubSecret = fs.readFileSync(hubSecretFile(), "utf-8").trim();
    const existing = outFile();
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, "keep me\n", { mode: 0o644 });
    const r = await runPair([url, "--name", "exists-test", "--secret-file", secretFileWith(hubSecret), "--output", existing, "--yes"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    expect(fs.readFileSync(existing, "utf-8")).toBe("keep me\n");
    expect(r.stdout).not.toMatch(/Hub reachable/); // refused before the hub was contacted
    if (process.platform !== "win32") {
      const target = path.join(TEST_ROOT, "elsewhere.json");
      const link = outFile();
      fs.symlinkSync(target, link);
      const l = await runPair([url, "--name", "link-test", "--secret-file", secretFileWith(hubSecret), "--output", link, "--yes"]);
      expect(l.status).toBe(1);
      expect(fs.existsSync(target), "the symlink's target was never created").toBe(false);
    }
  });

  it("(2) hub unreachable: no daemon running → exit 1 + clear error on stderr", async () => {
    // Deliberately do NOT start a hub. 59999 is reserved for this test file.
    const r = await runPair(["http://127.0.0.1:59999", "--name", "unreachable-test", "--output", outFile(), "--yes"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/cannot reach hub|hub health probe/);
  });

  it("(3) bad secret: hub requires secret, caller's --secret-file holds a wrong one → exit 2 + no token emitted", async () => {
    const { url } = await startHubWithEnv({ RELAY_HTTP_SECRET: "the-correct-secret-is-32-chars!!!" });
    const out = outFile();
    const r = await runPair([url, "--name", "bad-secret-test", "--secret-file", secretFileWith("wrong-secret-is-at-least-32-chars"), "--output", out, "--yes"]);
    expect(r.status).toBe(2);
    expect(fs.existsSync(out)).toBe(false);
    expect(r.stderr).toMatch(/authentication|rejected|secret/i);
    expect(r.stdout).not.toMatch(/--- MCP client config snippet ---/);
  });

  it("(3b) Q8: a hub with a legacy http_secret (even one ending in '!!!') is paired with that secret; the config FILE carries it (the hub gates every call) and stdout NEVER does (Codex R1 #3)", async () => {
    const legacy = "the-correct-secret-is-32-chars!!!";
    const { url } = await startHubWithEnv({ RELAY_HTTP_SECRET: legacy });
    const out = outFile();
    const r = await runPair([url, "--name", "legacy-hub-test", "--secret-file", secretFileWith(legacy), "--output", out, "--yes"]);
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
    const parsed = readConfig(out);
    expect(parsed["bot-relay"].headers["X-Relay-Secret"]).toBe(legacy);
    for (const stream of [r.stdout, r.stderr]) {
      expect(stream).not.toContain(legacy);
      expect(stream).not.toContain(parsed["bot-relay"].headers["X-Agent-Token"]);
    }
    const redacted = JSON.parse(r.stdout.match(/--- MCP client config snippet \(redacted\) ---\n([\s\S]+?)\n--- end snippet ---/)![1]);
    expect(redacted["bot-relay"].headers["X-Relay-Secret"]).toBe(`<in ${out}>`);
  });

  it("(4) PR-D: --secret <value> is REFUSED before any network call (a secret in argv is visible to ps)", async () => {
    const r = await runPair(["http://127.0.0.1:59999", "--name", "argv-test", "--secret", "some-secret-value-that-is-32-chars-long", "--output", outFile(), "--yes"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--secret is no longer accepted/);
    expect(r.stderr).toMatch(/--secret-file/);
    expect(r.stderr).not.toMatch(/cannot reach hub/); // refused at argv parsing, before the hub is contacted
  });

  it("(5) PR-D Q2: pairing with --secret-file, no process's argv EVER holds the secret (ps sampler)", async () => {
    const { url } = await startHubWithEnv({ RELAY_HTTP_SECRET: undefined });
    const hubSecret = fs.readFileSync(hubSecretFile(), "utf-8").trim();
    let leaked = "";
    let sampled = 0;
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
        if (out.includes(hubSecret)) leaked = out.split("\n").filter((l) => l.includes(hubSecret)).join("\n");
        await new Promise((r) => setTimeout(r, 15));
      }
    })();
    // A proxy that holds each /mcp reply for 1 s keeps pair ALIVE long enough to be sampled (it otherwise
    // finishes in ~350 ms, about 2 ps samples: too few to prove anything).
    const { createServer } = await import("http");
    const proxy = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
      const upstream = await fetch(`${url}${req.url}`, { method: req.method, headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined });
      const body = await upstream.text();
      if (req.url?.startsWith("/mcp")) await new Promise((r) => setTimeout(r, 1000));
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      res.end(body);
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const out = outFile();
    const r = await runPair([proxyUrl, "--name", "ps-test", "--secret-file", secretFileWith(hubSecret), "--output", out, "--yes"]);
    done = true;
    await sampler;
    await new Promise<void>((res) => proxy.close(() => res()));
    expect(r.status, r.stderr).toBe(0);
    expect(sampled, "the sampler ran while pair was alive").toBeGreaterThan(3);
    expect(leaked, "no argv held the secret").toBe("");
    // Codex R1 #3: and no OUTPUT stream held either credential (the token exists only in the 0600 file).
    const token = readConfig(out)["bot-relay"].headers["X-Agent-Token"] as string;
    for (const stream of [r.stdout, r.stderr]) {
      expect(stream).not.toContain(hubSecret);
      expect(stream).not.toContain(token);
    }
  });
});
