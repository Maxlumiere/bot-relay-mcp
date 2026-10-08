// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-20 (Codex #315 R1 P1): a handler that AWAITS before it writes re-derives its caller after the await
 * (src/authorization-scope.ts recheckAuthorization), because the dispatcher's own check ran before the await.
 *
 * Behaviour, through the REAL dispatcher (an in-process daemon, so each call carries its verdict):
 *   - register_webhook: the caller is revoked DURING the URL validation (its DNS lookup) -> refused, no webhook;
 *   - spawn_agent: the spawner is revoked DURING the token-vault write -> refused, the child's row and vault entry
 *     are gone, and the launcher is NEVER called (an injected launcher: no real terminal, ever);
 *   - the twins: the same calls with no revoke still register / launch.
 * Structure: every async dispatched handler is classified; one that writes after an await must call
 * recheckAuthorization with no await between it and the write.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import type { Server as HttpServer } from "http";
import ts from "typescript-legacy";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sec20-async-")));
process.env.RELAY_DB_PATH = path.join(ROOT, "relay.db");
process.env.RELAY_HOME = ROOT;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;

// The injected launcher: spawn_agent's ONLY path to a real terminal. Never a real one in this file.
const launcher = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../src/spawn/dispatcher.js", () => ({
  spawnAgent: (input: { name: string }) => {
    launcher.calls.push(input.name);
    return { ok: true, platform: "test", driver: "injected", command: "none" };
  },
}));

const db = await import("../src/db.js");
const { defaultTokenStore } = await import("../src/token-store.js");
const dnsPromises = (await import("dns")).promises;
const { mintHeaders } = await import("./_helpers/mint.js");

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let server: HttpServer;
let port: number;

beforeAll(async () => {
  const { startHttpServer } = await import("../src/transport/http.js");
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 80));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

async function call(tool: string, args: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const text = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  }).then((r) => r.text());
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  const outer = JSON.parse(line ? line.slice(5) : text);
  return JSON.parse(outer.result.content[0].text);
}
async function register(name: string, caps: string[]): Promise<string> {
  const r = await call("register_agent", { name, role: "worker", capabilities: caps }, mintHeaders(process.env.RELAY_DB_PATH));
  expect(typeof r.agent_token, JSON.stringify(r)).toBe("string");
  return r.agent_token as string;
}
const webhookCount = () => (db.getDb().prepare("SELECT COUNT(*) AS n FROM webhook_subscriptions").get() as { n: number }).n;

describe("register_webhook: a revoke DURING the URL validation (its DNS lookup) is honoured", () => {
  it("HARM: the caller is revoked while its URL resolves -> refused AUTH_FAILED, NO webhook", async () => {
    const tok = await register("wh-revoked", ["webhooks"]);
    const before = webhookCount();
    const real = dnsPromises.lookup.bind(dnsPromises);
    let fired = false;
    vi.spyOn(dnsPromises, "lookup").mockImplementation((async () => {
      fired = true;
      db.revokeAgentToken("wh-revoked", { issueRecovery: false });
      return [{ address: "93.184.215.14", family: 4 }];
    }) as unknown as typeof real);
    const r = await call("register_webhook", { url: "https://hooks.example.test/x", event: "*", agent_name: "wh-revoked", agent_token: tok });
    expect(fired, "precondition: the revoke landed during the lookup").toBe(true);
    expect([r.success, r.error_code]).toEqual([false, "AUTH_FAILED"]);
    expect(webhookCount()).toBe(before);
  });
  it("TWIN: no revoke -> the webhook is registered", async () => {
    const tok = await register("wh-active", ["webhooks"]);
    const before = webhookCount();
    vi.spyOn(dnsPromises, "lookup").mockImplementation((async () => [{ address: "93.184.215.14", family: 4 }]) as unknown as typeof dnsPromises.lookup);
    const r = await call("register_webhook", { url: "https://hooks.example.test/y", event: "*", agent_name: "wh-active", agent_token: tok });
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(webhookCount()).toBe(before + 1);
  });
});

describe("spawn_agent: a revoke DURING the token-vault write never launches the child", () => {
  it("HARM: the spawner is revoked while the child's token is written -> refused, child row + vault entry gone, launcher NEVER called", async () => {
    const tok = await register("sp-revoked", ["spawn"]);
    const store = defaultTokenStore();
    const realWrite = store.write.bind(store);
    vi.spyOn(store, "write").mockImplementation(async (name: string, token: string) => {
      db.revokeAgentToken("sp-revoked", { issueRecovery: false });
      return realWrite(name, token);
    });
    launcher.calls.length = 0;
    const r = await call("spawn_agent", { name: "sp-child-1", role: "builder", capabilities: [], agent_name: "sp-revoked", agent_token: tok });
    expect([r.success, r.error_code, r.rolled_back]).toEqual([false, "AUTH_FAILED", true]);
    expect(launcher.calls).toEqual([]);
    expect(db.getAgentAuthData("sp-child-1")).toBeNull();
    expect(await store.read("sp-child-1")).toBeNull();
  });
  it("TWIN: no revoke -> the child is registered and launched once", async () => {
    const tok = await register("sp-active", ["spawn"]);
    launcher.calls.length = 0;
    const r = await call("spawn_agent", { name: "sp-child-2", role: "builder", capabilities: [], agent_name: "sp-active", agent_token: tok });
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(launcher.calls).toEqual(["sp-child-2"]);
    expect(db.getAgentAuthData("sp-child-2")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
// STRUCTURE: every async dispatched handler is classified.

/** handler -> the calls it makes that WRITE (or launch) after an await; [] = none after its first await. */
const ASYNC_HANDLERS: Record<string, { file: string; writesAfterAwait: string[]; why: string }> = {
  handleRegisterWebhook: { file: "src/tools/webhooks.ts", writesAfterAwait: ["registerWebhook"], why: "awaits the URL validation (DNS), then writes the subscription" },
  handleSpawnAgent: { file: "src/tools/spawn.ts", writesAfterAwait: ["spawnAgent"], why: "awaits the token-vault write, then launches the child (its row was written before any await)" },
  handleHealthCheck: { file: "src/tools/status.ts", writesAfterAwait: [], why: "a no-auth tool: its optional token diagnostic goes through authorizeAgentToken + revalidate (status.ts checkToken)" },
};

function asyncHandlersIn(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  sf.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name && /^handle[A-Z]/.test(n.name.text) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) out.push(n.name.text);
  });
  return out;
}

/** In `fnName`, every call to a write callee is preceded by recheckAuthorization() with NO await in between. */
export function recheckGuards(text: string, fnName: string, writes: string[]): string[] {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let fn: ts.FunctionDeclaration | undefined;
  sf.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === fnName) fn = n;
  });
  if (!fn) return [`${fnName} not found`];
  const events: Array<{ pos: number; kind: "await" | "recheck" | "write"; name?: string }> = [];
  const visit = (n: ts.Node): void => {
    if (ts.isAwaitExpression(n)) events.push({ pos: n.getStart(), kind: "await" });
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      if (n.expression.text === "recheckAuthorization") events.push({ pos: n.getStart(), kind: "recheck" });
      if (writes.includes(n.expression.text)) events.push({ pos: n.getStart(), kind: "write", name: n.expression.text });
    }
    // a nested function's awaits are not this body's (its own call site is what matters)
    if (n !== fn && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n))) return;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  events.sort((a, b) => a.pos - b.pos);
  const problems: string[] = [];
  let sawAwait = false;
  let recheckedSinceAwait = false;
  for (const e of events) {
    if (e.kind === "await") {
      sawAwait = true;
      recheckedSinceAwait = false;
    } else if (e.kind === "recheck") recheckedSinceAwait = true;
    else if (sawAwait && !recheckedSinceAwait) problems.push(`${fnName}: ${e.name}() after an await with no recheckAuthorization() since it`);
  }
  if (writes.length && !events.some((e) => e.kind === "write")) problems.push(`${fnName}: none of ${writes.join(", ")} found (stale classification)`);
  return problems;
}

describe("STRUCTURE: every async dispatched handler is classified, and rechecks before a post-await write", () => {
  const files = fs.readdirSync(path.join(REPO, "src", "tools")).filter((f) => f.endsWith(".ts")).map((f) => `src/tools/${f}`);
  it("the async handlers in src/tools are EXACTLY the classified ones", () => {
    const found = files.flatMap((f) => asyncHandlersIn(f, fs.readFileSync(path.join(REPO, f), "utf-8"))).sort();
    expect(found).toEqual(Object.keys(ASYNC_HANDLERS).sort());
  });
  for (const [fnName, c] of Object.entries(ASYNC_HANDLERS)) {
    it(`${fnName}: every post-await write is preceded by recheckAuthorization() (${c.why})`, () => {
      expect(recheckGuards(fs.readFileSync(path.join(REPO, c.file), "utf-8"), fnName, c.writesAfterAwait)).toEqual([]);
    });
  }
  it("the checker (both legs): a write after an await with no recheck fails; with a recheck it passes; an await between recheck and write fails", () => {
    const bad = `export async function h() { await a(); write(); }`;
    const good = `export async function h() { await a(); recheckAuthorization(); write(); }`;
    const gap = `export async function h() { await a(); recheckAuthorization(); await b(); write(); }`;
    const before = `export async function h() { write(); await a(); }`;
    expect(recheckGuards(bad, "h", ["write"]).length).toBe(1);
    expect(recheckGuards(good, "h", ["write"])).toEqual([]);
    expect(recheckGuards(gap, "h", ["write"]).length).toBe(1);
    expect(recheckGuards(before, "h", ["write"])).toEqual([]);
  });
});
