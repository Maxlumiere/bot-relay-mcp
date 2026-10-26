// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The INSTALLED package, driven from outside: its own daemon (`dist/index.js`), its own CLI (`bin/relay`), in a
 * sandboxed HOME per test. Nothing here imports the source tree's code: the release suite checks what ships.
 *
 * The sandbox DB is read through the INSTALLED package's own better-sqlite3 (read-only), so the check runs on every
 * OS without a sqlite3 binary.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { inject } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ReleaseInstall } from "./global-setup.js";
import { sandboxEnv } from "../_helpers/sandbox-env.js";

declare module "vitest" {
  interface TaskMeta {
    /**
     * The OBSERVATION MARK: a HARM sets it only after its stimulus returned a well-formed response, immediately before
     * its harm assertion (never in setup or a helper). The known-bad control counts a harm as SEEN only with it; a harm
     * that fails without it is a fixture fault (scripts/release-invariants.mjs).
     */
    stimulus_returned?: boolean;
  }
}

export function installed(): ReleaseInstall {
  const r = inject("release");
  if (!r) throw new Error("release suite: no installed package (collected in list-only mode, or the global setup did not run)");
  return r;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export interface Sandbox {
  home: string;
  relayHome: string;
  dbPath: string;
  configPath: string;
  /** The env every process of this sandbox gets: its own HOME and relay paths, nothing of the operator's. */
  env: NodeJS.ProcessEnv;
  /** The relay resolves and creates its own paths under HOME (nothing pre-created, no config file written). */
  defaultPaths: boolean;
}

/**
 * A fresh sandboxed HOME (and relay home) under this run's scratch dir. `defaultPaths`: the relay resolves its OWN
 * instance under HOME (no RELAY_HOME / RELAY_DB_PATH / RELAY_CONFIG_PATH, and the relay home is NOT pre-created), the
 * shipped default; `dbPath` is then unknown until found (findDbFiles).
 */
export function sandbox(label: string, opts: { defaultPaths?: boolean } = {}): Sandbox {
  const { work } = installed();
  const home = fs.mkdtempSync(path.join(work, `sb-${label}-`));
  const relayHome = path.join(home, ".bot-relay");
  if (!opts.defaultPaths) fs.mkdirSync(relayHome, { recursive: true, mode: 0o700 });
  const dbPath = path.join(relayHome, "relay.db");
  const configPath = path.join(relayHome, "config.json");
  // The FULL parent env minus every relay and test-runner variable and NODE_OPTIONS, every HOME spelling pointed at the
  // sandbox (tests/_helpers/sandbox-env.ts). (Windows' unreadable SID in CI was NOT the env: it persisted with the full
  // env, and was the by-name whoami, SEC-22.) The operator tripwire still decorates each child it starts.
  const env = sandboxEnv(home);
  if (!opts.defaultPaths) Object.assign(env, { RELAY_HOME: relayHome, RELAY_DB_PATH: dbPath, RELAY_CONFIG_PATH: configPath });
  return { home, relayHome, dbPath, configPath, env, defaultPaths: opts.defaultPaths === true };
}

export interface HttpDaemon {
  port: number;
  baseUrl: string;
  child: ChildProcess;
  stderr: () => string;
  /** One MCP tools/call over POST /mcp; returns the tool's parsed JSON result. */
  rpc: (tool: string, args: Record<string, unknown>, headers?: Record<string, string>) => Promise<Record<string, unknown>>;
  /** The daemon's registration secret as a header ({} when the daemon created none). */
  mintHeaders: () => Record<string, string>;
  stop: () => Promise<void>;
}

/**
 * Start the INSTALLED daemon over HTTP on a free loopback port, in `sb`. Resolves once /health answers (exempt from the
 * HTTP transport secret). `httpSecret` sets that secret (RELAY_HTTP_SECRET), so authMiddleware is live; `rpc` sends no
 * credential, so a test with a secret makes its own requests.
 */
export async function startHttpDaemon(sb: Sandbox, opts: { httpSecret?: string } = {}): Promise<HttpDaemon> {
  const { pkg } = installed();
  const port = await freePort();
  const dashboardSecret = crypto.randomBytes(24).toString("hex");
  // A default-paths sandbox gets its settings from the env only: writing a config file would create the relay home
  // ourselves (and its mode would be ours, not the relay's).
  if (!sb.defaultPaths) {
    fs.writeFileSync(sb.configPath, JSON.stringify({ transport: "http", http_port: port, http_host: "127.0.0.1", dashboard_secret: dashboardSecret }), { mode: 0o600 });
  }
  const child = spawn(process.execPath, [path.join(pkg, "dist", "index.js")], {
    env: { ...sb.env, RELAY_TRANSPORT: "http", RELAY_HTTP_PORT: String(port), RELAY_HTTP_HOST: "127.0.0.1", RELAY_DASHBOARD_SECRET: dashboardSecret, ...(opts.httpSecret ? { RELAY_HTTP_SECRET: opts.httpSecret } : {}) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr?.on("data", (d) => (err += d));
  const baseUrl = `http://127.0.0.1:${port}`;
  sb.env.RELAY_HTTP_PORT = String(port); // the CLI of this sandbox talks to THIS daemon (never a default port)
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`installed daemon did not come up (exit ${child.exitCode}): ${err.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const rpc: HttpDaemon["rpc"] = async (tool, args, headers = {}) => {
    const r = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    });
    const text = await r.text();
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    const outer = JSON.parse(line ? line.slice(5) : text) as { result?: { content?: Array<{ text?: string }> }; error?: unknown };
    const inner = outer.result?.content?.[0]?.text;
    return inner ? (JSON.parse(inner) as Record<string, unknown>) : { rpc_error: outer.error ?? text };
  };
  const secretFile = path.join(sb.relayHome, "secrets", "mint.secret");
  const mintHeaders = (): Record<string, string> => (fs.existsSync(secretFile) ? { "X-Relay-Secret": fs.readFileSync(secretFile, "utf-8").trim() } : {});
  const stop = async () => {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000).unref?.();
    });
  };
  return { port, baseUrl, child, stderr: () => err, rpc, mintHeaders, stop };
}

/** One tools/call to the INSTALLED daemon over STDIO (a fresh process for the call, as an MCP client starts it). */
export async function stdioCall(sb: Sandbox, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { pkg } = installed();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pkg, "dist", "index.js")],
    env: { ...(sb.env as Record<string, string>), RELAY_TRANSPORT: "stdio" },
    stderr: "pipe",
  });
  const client = new Client({ name: "release-suite", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const res = (await client.callTool({ name: tool, arguments: args })) as { content?: Array<{ text?: string }> };
    const text = res.content?.[0]?.text;
    return text ? (JSON.parse(text) as Record<string, unknown>) : { raw: res };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Run the INSTALLED `relay` CLI in `sb`. */
export function relayCli(sb: Sandbox, args: string[], extraEnv: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const { pkg } = installed();
  const r = spawnSync(process.execPath, [path.join(pkg, "bin", "relay"), ...args], { encoding: "utf-8", env: { ...sb.env, ...extraEnv }, timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Read the sandbox DB, read-only, through the INSTALLED package's own better-sqlite3. */
export function dbQuery<T = Record<string, unknown>>(sb: Sandbox, sql: string, ...params: unknown[]): T[] {
  const { pkg } = installed();
  const Database = createRequire(path.join(pkg, "package.json"))("better-sqlite3") as new (f: string, o: { readonly: boolean; fileMustExist: boolean }) => {
    prepare: (s: string) => { all: (...p: unknown[]) => T[] };
    close: () => void;
  };
  const db = new Database(sb.dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

/**
 * Windows only, for a failure message: run the relay's own SID lookup (`whoami /user /fo csv /nh` by its absolute
 * %SystemRoot%\System32 path, as src/fs-perms.ts windowsUserSid does through systemBinary since SEC-22) from a node
 * child started EXACTLY as the daemon is (this sandbox's env, through the same wrapped spawn, so the same tripwire
 * preload), and say what came back. "" elsewhere.
 */
export function windowsSidProbe(sb: Sandbox): string {
  if (process.platform !== "win32") return "";
  const code = "const r=require('child_process').spawnSync(require('path').win32.join(process.env.SystemRoot||'','System32','whoami.exe'),['/user','/fo','csv','/nh'],{encoding:'utf-8',windowsHide:true});" +
    "process.stdout.write(JSON.stringify({status:r.status,signal:r.signal,error:r.error&&r.error.message,stdout:r.stdout,stderr:r.stderr,path:process.env.PATH||process.env.Path,keys:Object.keys(process.env).filter(k=>/^(path|systemroot|comspec|pathext)$/i.test(k))}))";
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf-8", env: sb.env, timeout: 30_000 });
  return ` [windows SID probe from a daemon-like child: exit ${r.status}; ${(r.stdout || "").slice(0, 1200)}; stderr ${(r.stderr || "").slice(0, 400)}]`;
}

