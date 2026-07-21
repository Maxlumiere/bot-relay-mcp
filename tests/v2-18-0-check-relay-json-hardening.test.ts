// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.18.0 — check-relay.sh JSON-hardening fast-follow (the 2 latent bugs left in
 * the CLAUDE hook when the same fixes landed in the Codex hook):
 *
 *   FIX 1 (title): a hostile RELAY_TERMINAL_TITLE (quote / backslash / newline)
 *     was raw-interpolated into the register_agent JSON → malformed payload →
 *     the WHOLE register (and mail delivery) failed. Now the title is validated
 *     against the server allowlist and DROPPED if it doesn't match.
 *
 *   FIX 2 (caps): the caps→JSON awk used `next` (skips the whole record, so a
 *     later invalid token dropped the closing `]`) + an index-based separator
 *     (`[,"x"]`). An EMPTY token — from a double/leading/trailing comma, which
 *     passes the whole-string allowlist — triggered malformed JSON → register
 *     failed. Now: `continue` + a COUNT-based separator → always valid JSON.
 *
 * Both are proven END-TO-END: the adversarial input runs against a real daemon;
 * with the OLD code the register JSON is malformed and the agent NEVER registers
 * (count 0); with the fix the agent registers with the sanitized value.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "child_process";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_HOOK = path.join(REPO_ROOT, "hooks", "check-relay.sh");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`daemon at :${port} not healthy in ${timeoutMs}ms`);
}

function sql(dbPath: string, query: string): string {
  const r = spawnSync("sqlite3", [dbPath, query], { encoding: "utf-8", timeout: 5000 });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

interface Harness {
  port: number;
  root: string;
  dbPath: string;
  daemon: ReturnType<typeof spawn>;
}

let h: Harness;

beforeAll(async () => {
  expect(fs.existsSync(DIST_INDEX), "dist/index.js missing — run npm run build first").toBe(true);
  const port = await getFreePort();
  const root = path.join(os.tmpdir(), `v2-18-0-checkrelay-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "agents"), { recursive: true, mode: 0o700 });
  const dbPath = path.join(root, "relay.db");
  const daemon = spawn("node", [DIST_INDEX], {
    env: {
      ...process.env,
      RELAY_TRANSPORT: "http",
      RELAY_HTTP_PORT: String(port),
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HOME: root,
      RELAY_DB_PATH: dbPath,
      RELAY_CONFIG_PATH: path.join(root, "config.json"),
      RELAY_AGENT_TOKEN: "",
      RELAY_AGENT_NAME: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth(port, 6000);
  h = { port, root, dbPath, daemon };
}, 20_000);

afterAll(() => {
  try {
    h?.daemon.kill("SIGKILL");
  } catch {
    /* */
  }
  try {
    if (h) fs.rmSync(h.root, { recursive: true, force: true });
  } catch {
    /* */
  }
});

/** Run check-relay.sh (first register, daemon mints the token). */
function runHook(name: string, opts: { caps?: string; title?: string } = {}): void {
  const env: Record<string, string> = {
    HOME: h.root,
    PATH: process.env.PATH || "/usr/bin:/bin",
    RELAY_HOME: h.root,
    RELAY_AGENT_NAME: name,
    RELAY_AGENT_ROLE: "auditor",
    RELAY_AGENT_CAPABILITIES: opts.caps ?? "",
    RELAY_DB_PATH: h.dbPath,
    RELAY_HTTP_HOST: "127.0.0.1",
    RELAY_HTTP_PORT: String(h.port),
  };
  if (opts.title !== undefined) env.RELAY_TERMINAL_TITLE = opts.title;
  spawnSync("bash", [CLAUDE_HOOK], { encoding: "utf-8", timeout: 12_000, env, input: "" });
}

const registered = (name: string): boolean =>
  sql(h.dbPath, `SELECT COUNT(*) FROM agents WHERE name='${name}';`) === "1";

describe("v2.18.0 — check-relay.sh JSON hardening (end-to-end vs a real daemon)", () => {
  it("FIX 1: a hostile title still REGISTERS the agent, with the title DROPPED", () => {
    runHook("cr-hostile-title", { title: 'evil","injected":"x' });
    expect(registered("cr-hostile-title"), "hostile title malformed the register JSON").toBe(true);
    expect(sql(h.dbPath, `SELECT IFNULL(terminal_title_ref,'') FROM agents WHERE name='cr-hostile-title';`)).toBe("");
  });

  it("FIX 1: a newline-bearing title still registers, title dropped", () => {
    runHook("cr-nl-title", { title: "line1\nline2" });
    expect(registered("cr-nl-title")).toBe(true);
    expect(sql(h.dbPath, `SELECT IFNULL(terminal_title_ref,'') FROM agents WHERE name='cr-nl-title';`)).toBe("");
  });

  it("FIX 2: an EMPTY token (double comma) → valid caps JSON, agent registers", () => {
    // "a,,b" passes the whole-string allowlist but the middle empty token failed
    // the per-token filter; the old `next` dropped the closing `]`.
    runHook("cr-dbl-comma", { caps: "alpha,,beta" });
    expect(registered("cr-dbl-comma"), "empty token malformed the caps JSON").toBe(true);
    expect(JSON.parse(sql(h.dbPath, `SELECT capabilities FROM agents WHERE name='cr-dbl-comma';`))).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("FIX 2: a LEADING comma (empty first token) → valid caps, agent registers", () => {
    runHook("cr-lead-comma", { caps: ",solo" });
    expect(registered("cr-lead-comma")).toBe(true);
    expect(JSON.parse(sql(h.dbPath, `SELECT capabilities FROM agents WHERE name='cr-lead-comma';`))).toEqual(["solo"]);
  });

  it("regression: a normal title + caps still register intact", () => {
    runHook("cr-normal", { title: "my agent 1", caps: "build,test" });
    expect(registered("cr-normal")).toBe(true);
    expect(sql(h.dbPath, `SELECT terminal_title_ref FROM agents WHERE name='cr-normal';`)).toBe("my agent 1");
    expect(JSON.parse(sql(h.dbPath, `SELECT capabilities FROM agents WHERE name='cr-normal';`))).toEqual([
      "build",
      "test",
    ]);
  });
});
