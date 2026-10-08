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
import { srcProgram, virtualProgram } from "./_helpers/ts-binding.js";

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

/**
 * Codex #315 R2 N4: the inventory is what the DISPATCHER binds, not a naming convention. Every `case "<tool>":` of
 * the dispatch switch in src/server.ts must `return <handler>(...)`; each handler is resolved by binding, and the
 * checker says whether it returns a Promise (an `async function`, or a sync one returning `pre().then(write)`).
 * Every Promise-returning handler must be classified below. A case of any other shape fails as unclassified.
 */
export function dispatchedHandlers(program: ts.Program, rel: (f: string) => string): { promising: Array<{ tool: string; handler: string; file: string }>; unclassified: string[] } {
  const checker = program.getTypeChecker();
  const promising: Array<{ tool: string; handler: string; file: string }> = [];
  const unclassified: string[] = [];
  const server = program.getSourceFiles().find((f) => rel(f.fileName) === "src/server.ts");
  if (!server) return { promising, unclassified: ["src/server.ts not in the program"] };
  let sw: ts.SwitchStatement | undefined;
  const find = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "dispatch" && n.body) n.body.statements.forEach((st) => ts.isSwitchStatement(st) && (sw = st));
    ts.forEachChild(n, find);
  };
  find(server);
  if (!sw) return { promising, unclassified: ["the dispatch switch was not found"] };
  for (const clause of sw.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) continue;
    const tool = ts.isStringLiteralLike(clause.expression) ? clause.expression.text : clause.expression.getText();
    const ret = clause.statements.find(ts.isReturnStatement);
    let call = ret?.expression;
    if (call && ts.isAwaitExpression(call)) call = call.expression;
    if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) {
      unclassified.push(`${tool}: not a plain \`return handler(...)\``);
      continue;
    }
    let sym = checker.getSymbolAtLocation(call.expression);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const decl = sym?.declarations?.[0];
    if (!decl) {
      unclassified.push(`${tool}: ${call.expression.text} does not resolve`);
      continue;
    }
    const sig = checker.getResolvedSignature(call);
    const rt = sig ? checker.getReturnTypeOfSignature(sig) : undefined;
    const isPromise = !!rt && (checker.getPromisedTypeOfPromise(rt) !== undefined || /^Promise</.test(checker.typeToString(rt)));
    if (isPromise) promising.push({ tool, handler: sym!.name, file: rel(decl.getSourceFile().fileName) });
  }
  return { promising, unclassified };
}

/**
 * In `fnName`, every call to a write callee AFTER the first await sits in a statement IMMEDIATELY preceded by the
 * fail-closed form `if (!R.ok) <return …>` and, before it, `const R = recheckAuthorization();` (Codex #315 R2 N4:
 * a recheck merely encountered, ignored, or conditional is not protection). A syntactic form, not a dominance
 * analysis (stated).
 */
export function recheckGuards(text: string, fnName: string, writes: string[]): string[] {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let fn: ts.FunctionDeclaration | undefined;
  sf.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === fnName) fn = n;
  });
  if (!fn) return [`${fnName} not found`];
  const awaits: number[] = [];
  const writeCalls: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (n !== fn && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n))) return; // a nested body is not this one's
    if (ts.isAwaitExpression(n)) awaits.push(n.getStart());
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && writes.includes(n.expression.text)) writeCalls.push(n);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  const firstAwait = awaits.length ? Math.min(...awaits) : Infinity;
  const problems: string[] = [];
  const returnsOnly = (st: ts.Statement): boolean => ts.isReturnStatement(st) || (ts.isBlock(st) && st.statements.length > 0 && ts.isReturnStatement(st.statements[st.statements.length - 1]));
  for (const w of writeCalls) {
    if (w.getStart() < firstAwait) continue; // before any await: the dispatcher's own check covers it
    let stmt: ts.Node = w;
    while (stmt.parent && !ts.isBlock(stmt.parent) && !ts.isSourceFile(stmt.parent)) stmt = stmt.parent;
    const block = stmt.parent as ts.Block;
    const idx = block.statements.indexOf(stmt as ts.Statement);
    const guard = block.statements[idx - 1];
    const decl = block.statements[idx - 2];
    let name: string | null = null;
    if (decl && ts.isVariableStatement(decl) && decl.declarationList.declarations.length === 1) {
      const d = decl.declarationList.declarations[0];
      if (ts.isIdentifier(d.name) && d.initializer && ts.isCallExpression(d.initializer) && ts.isIdentifier(d.initializer.expression) && d.initializer.expression.text === "recheckAuthorization") name = d.name.text;
    }
    const failsClosed =
      !!name &&
      !!guard &&
      ts.isIfStatement(guard) &&
      !guard.elseStatement &&
      ts.isPrefixUnaryExpression(guard.expression) &&
      guard.expression.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isPropertyAccessExpression(guard.expression.operand) &&
      guard.expression.operand.name.text === "ok" &&
      ts.isIdentifier(guard.expression.operand.expression) &&
      guard.expression.operand.expression.text === name &&
      returnsOnly(guard.thenStatement);
    if (!failsClosed) problems.push(`${fnName}: ${(w.expression as ts.Identifier).text}() after an await is not immediately preceded by \`const R = recheckAuthorization(); if (!R.ok) return …;\``);
  }
  if (writes.length && writeCalls.length === 0) problems.push(`${fnName}: none of ${writes.join(", ")} found (stale classification)`);
  return problems;
}

describe("STRUCTURE: every Promise-returning dispatched handler is classified, and rechecks (fail-closed) before a post-await write", () => {
  const program = srcProgram();
  const rel = (f: string) => path.relative(REPO, f).split(path.sep).join("/");
  const inv = dispatchedHandlers(program, rel);
  it("every dispatch case is a plain `return handler(...)` (nothing unclassified)", () => {
    expect(inv.unclassified).toEqual([]);
  });
  it("precondition: the inventory sees the dispatcher's handlers (it is not blind)", () => {
    expect(inv.promising.map((h) => h.handler)).toEqual(expect.arrayContaining(["handleRegisterWebhook", "handleSpawnAgent"]));
  });
  it("the Promise-returning handlers are EXACTLY the classified ones", () => {
    expect([...new Set(inv.promising.map((h) => h.handler))].sort()).toEqual(Object.keys(ASYNC_HANDLERS).sort());
  });
  for (const [fnName, c] of Object.entries(ASYNC_HANDLERS)) {
    it(`${fnName}: every post-await write is preceded by the fail-closed recheck (${c.why})`, () => {
      expect(recheckGuards(fs.readFileSync(path.join(REPO, c.file), "utf-8"), fnName, c.writesAfterAwait)).toEqual([]);
    });
  }
  it("the checker (both legs): the fail-closed form passes; no recheck, an IGNORED recheck, a CONDITIONAL recheck, or an await in between fail", () => {
    const good = `export async function h() { await a(); const r = recheckAuthorization(); if (!r.ok) return no(); write(); }`;
    const goodBlock = `export async function h() { await a(); const r = recheckAuthorization(); if (!r.ok) { log(); return no(); } write(); }`;
    const none = `export async function h() { await a(); write(); }`;
    const ignored = `export async function h() { await a(); recheckAuthorization(); write(); }`;
    const conditional = `export async function h(c: boolean) { await a(); if (c) { const r = recheckAuthorization(); if (!r.ok) return no(); } write(); }`;
    const gap = `export async function h() { await a(); const r = recheckAuthorization(); if (!r.ok) return no(); await b(); write(); }`;
    const before = `export async function h() { write(); await a(); }`;
    expect(recheckGuards(good, "h", ["write"])).toEqual([]);
    expect(recheckGuards(goodBlock, "h", ["write"])).toEqual([]);
    for (const bad of [none, ignored, conditional, gap]) expect(recheckGuards(bad, "h", ["write"]).length, bad).toBe(1);
    expect(recheckGuards(before, "h", ["write"])).toEqual([]);
  });
  it("Codex #315 R2 N4: a SYNC handler returning `pre().then(write)` is inventoried as Promise-returning (so it must be classified)", () => {
    const files = {
      "src/server.ts": `import { handleSync } from "./h.js";\nexport function createServer() { async function dispatch(name: string, args: any): Promise<any> { switch (name) { case "t": return handleSync(args); } } return dispatch; }`,
      "src/h.ts": `async function pre(): Promise<void> {}\nfunction write(): void {}\nexport function handleSync(_a: unknown) { return pre().then(() => write()); }`,
    };
    const v = dispatchedHandlers(virtualProgram(files), (f) => path.relative("/virtual", f).split(path.sep).join("/"));
    expect(v.unclassified).toEqual([]);
    expect(v.promising.map((h) => h.handler)).toEqual(["handleSync"]);
  });
});
