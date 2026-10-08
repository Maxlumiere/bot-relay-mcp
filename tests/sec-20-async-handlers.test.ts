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
 * Structure: the dispatcher keeps its reviewed form; every async dispatched handler is classified by binding (file +
 * export) and body-hashed; one that writes after an await must call the BOUND recheckAuthorization, fail closed, with
 * no await between it and the write (including inside the write's own arguments).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import type { Server as HttpServer } from "http";
import ts from "typescript-legacy";
import { resolveBinding, srcProgram, virtualProgram } from "./_helpers/ts-binding.js";

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

const RECHECK = "src/authorization-scope.ts:recheckAuthorization";

/**
 * The reviewed async handlers, keyed by what the dispatcher BINDS (`<declaring file>:<export>`, Codex #316 R1 #5: a
 * name alone let an import be redirected to another module while the pin inspected the old one).
 *   writesAfterAwait: the BOUND write callees after the first await ([] = none).
 *   bodySha256: the BODY-HASH TRIPWIRE (architect 83293704, the bounded stand-in for a full effect inventory, Codex
 *   #316 R1 #6, which stays a stated residual until ADR-0050's effect manifest / withAuthority): any edit to a reviewed
 *   handler turns this pin RED until a human re-reviews it and updates the hash.
 */
const ASYNC_HANDLERS: Record<string, { writesAfterAwait: string[]; bodySha256: string; why: string }> = {
  "src/tools/webhooks.ts:handleRegisterWebhook": {
    writesAfterAwait: ["src/db.ts:registerWebhook"],
    bodySha256: "82b50a6897c24f2ba161daa7db2c728c2aa9bd3f63c766e24da81606a968fe2d",
    why: "awaits the URL validation (DNS), then writes the subscription",
  },
  "src/tools/spawn.ts:handleSpawnAgent": {
    writesAfterAwait: ["src/spawn/dispatcher.ts:spawnAgent"],
    bodySha256: "38a3be05aa27b47b7337cffd77152d6d2374fc15274be280927190b3858f0091",
    why: "awaits the token-vault write, then launches the child (its row was written before any await)",
  },
  "src/tools/status.ts:handleHealthCheck": {
    writesAfterAwait: [],
    bodySha256: "17d14b83091e08c9145a55c7def62e538d1a13cc7e4b01b2671c2cb6503e3166",
    why: "a no-auth tool: its optional token diagnostic goes through authorizeAgentToken + revalidate (status.ts checkToken)",
  },
};

/** The dispatcher's reviewed refusal for an unknown tool, whitespace-collapsed. Any change is re-reviewed here. */
const REVIEWED_DEFAULT = `default: return { content: [ { type: "text" as const, text: JSON.stringify({ error: \`Unknown tool: \${name}\` }), }, ], isError: true, };`;
const collapse = (t: string) => t.replace(/\s+/g, " ").trim();
const sha256 = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

/**
 * Codex #315 R2 N4 + #316 R1 #4: the inventory is what the DISPATCHER binds, and the dispatcher must keep its REVIEWED
 * form, so nothing can run between the dispatcher's own authorization and a handler unseen:
 *   - `dispatch`'s body is the switch and nothing else (an `await pause()` before it is refused);
 *   - every case is exactly ONE `return <handler>(<nothing> | <X>Schema.parse(args))`: no other statement, no await,
 *     no other call in the arguments;
 *   - the default keeps its reviewed refusal (REVIEWED_DEFAULT).
 * Each handler is resolved by binding (file + export), and the checker says whether it returns a Promise.
 */
export function dispatchedHandlers(program: ts.Program, rel: (f: string) => string): { promising: Array<{ tool: string; key: string; decl: ts.Declaration }>; unclassified: string[] } {
  const checker = program.getTypeChecker();
  const promising: Array<{ tool: string; key: string; decl: ts.Declaration }> = [];
  const unclassified: string[] = [];
  const server = program.getSourceFiles().find((f) => rel(f.fileName) === "src/server.ts");
  if (!server) return { promising, unclassified: ["src/server.ts not in the program"] };
  let body: ts.Block | undefined;
  const find = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "dispatch" && n.body) body = n.body;
    ts.forEachChild(n, find);
  };
  find(server);
  if (!body) return { promising, unclassified: ["the dispatch function was not found"] };
  if (body.statements.length !== 1 || !ts.isSwitchStatement(body.statements[0])) {
    return { promising, unclassified: [`dispatch's body is not the reviewed switch-only form (${body.statements.length} statement(s))`] };
  }
  const sw = body.statements[0];
  let defaults = 0;
  for (const clause of sw.caseBlock.clauses) {
    if (ts.isDefaultClause(clause)) {
      defaults++;
      if (collapse(clause.getText()) !== collapse(REVIEWED_DEFAULT)) unclassified.push("default: not the reviewed refusal");
      continue;
    }
    const tool = ts.isStringLiteralLike(clause.expression) ? clause.expression.text : clause.expression.getText();
    const only = clause.statements.length === 1 ? clause.statements[0] : undefined;
    const call = only && ts.isReturnStatement(only) ? only.expression : undefined;
    if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) {
      unclassified.push(`${tool}: not exactly one plain \`return handler(...)\``);
      continue;
    }
    const arg = call.arguments[0];
    const argOk =
      call.arguments.length === 0 ||
      (call.arguments.length === 1 &&
        ts.isCallExpression(arg) &&
        ts.isPropertyAccessExpression(arg.expression) &&
        ts.isIdentifier(arg.expression.expression) &&
        /Schema$/.test(arg.expression.expression.text) &&
        arg.expression.name.text === "parse" &&
        arg.arguments.length === 1 &&
        ts.isIdentifier(arg.arguments[0]) &&
        arg.arguments[0].text === "args");
    if (!argOk) {
      unclassified.push(`${tool}: the handler's argument is not \`<X>Schema.parse(args)\` (an await or another call in it is unreviewed)`);
      continue;
    }
    const b = resolveBinding(checker, call.expression, rel);
    if (!b) {
      unclassified.push(`${tool}: ${call.expression.text} does not resolve`);
      continue;
    }
    const sig = checker.getResolvedSignature(call);
    const rt = sig ? checker.getReturnTypeOfSignature(sig) : undefined;
    const isPromise = !!rt && (checker.getPromisedTypeOfPromise(rt) !== undefined || /^Promise</.test(checker.typeToString(rt)));
    if (isPromise) promising.push({ tool, key: b.key, decl: b.decl });
  }
  if (defaults !== 1) unclassified.push(`the switch has ${defaults} default clause(s), not 1`);
  return { promising, unclassified };
}

/**
 * In the handler `decl` (the declaration the dispatcher binds), every BOUND write callee called after an await sits in
 * a statement IMMEDIATELY preceded by `if (!R.ok) <return …>` and, before it, `const R = recheckAuthorization();` with
 * recheckAuthorization BOUND to src/authorization-scope.ts (Codex #316 R1 #5: a same-named local is no recheck).
 * Codex #316 R1 #7: a write is post-await when an await starts anywhere before the call ENDS (its own arguments
 * included), and the write's statement must hold no await at all (a suspension between the recheck and the write).
 * A syntactic form, not a dominance analysis (stated).
 */
export function recheckGuards(program: ts.Program, rel: (f: string) => string, decl: ts.Declaration, writes: string[]): string[] {
  const checker = program.getTypeChecker();
  if (!ts.isFunctionDeclaration(decl) || !decl.body || !decl.name) return [`${rel(decl.getSourceFile().fileName)}: not a function declaration with a body`];
  const fn = decl;
  const fnName = decl.name.text;
  const bound = (id: ts.Node): string | null => (ts.isIdentifier(id) ? (resolveBinding(checker, id, rel)?.key ?? null) : null);
  const awaits: number[] = [];
  const writeCalls: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (n !== fn && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n))) return; // a nested body is not this one's
    if (ts.isAwaitExpression(n)) awaits.push(n.getStart());
    if (ts.isCallExpression(n)) {
      const k = bound(n.expression);
      if (k && writes.includes(k)) writeCalls.push(n);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  const firstAwait = awaits.length ? Math.min(...awaits) : Infinity;
  const problems: string[] = [];
  const returnsOnly = (st: ts.Statement): boolean => ts.isReturnStatement(st) || (ts.isBlock(st) && st.statements.length > 0 && ts.isReturnStatement(st.statements[st.statements.length - 1]));
  const holdsAwait = (n: ts.Node): boolean => {
    let found = false;
    const v = (m: ts.Node): void => {
      if (found) return;
      if (m !== n && (ts.isFunctionDeclaration(m) || ts.isArrowFunction(m) || ts.isFunctionExpression(m))) return;
      if (ts.isAwaitExpression(m) || ts.isYieldExpression(m)) found = true;
      else ts.forEachChild(m, v);
    };
    v(n);
    return found;
  };
  for (const w of writeCalls) {
    if (firstAwait > w.getEnd()) continue; // no await before or inside it: the dispatcher's own check covers it
    const callee = (w.expression as ts.Identifier).text;
    let stmt: ts.Node = w;
    while (stmt.parent && !ts.isBlock(stmt.parent) && !ts.isSourceFile(stmt.parent)) stmt = stmt.parent;
    const block = stmt.parent as ts.Block;
    const idx = block.statements.indexOf(stmt as ts.Statement);
    const guard = block.statements[idx - 1];
    const declSt = block.statements[idx - 2];
    let name: string | null = null;
    if (declSt && ts.isVariableStatement(declSt) && declSt.declarationList.declarations.length === 1) {
      const d = declSt.declarationList.declarations[0];
      if (ts.isIdentifier(d.name) && d.initializer && ts.isCallExpression(d.initializer) && d.initializer.arguments.length === 0 && bound(d.initializer.expression) === RECHECK) name = d.name.text;
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
    if (!failsClosed) problems.push(`${fnName}: ${callee}() after an await is not immediately preceded by \`const R = recheckAuthorization(); if (!R.ok) return …;\` (recheckAuthorization bound to ${RECHECK})`);
    else if (holdsAwait(stmt)) problems.push(`${fnName}: ${callee}()'s statement suspends (an await) between the recheck and the write`);
  }
  if (writes.length && writeCalls.length === 0) problems.push(`${fnName}: none of ${writes.join(", ")} found (stale classification)`);
  return problems;
}

describe("STRUCTURE: every Promise-returning dispatched handler is classified, and rechecks (fail-closed) before a post-await write", () => {
  const program = srcProgram();
  const rel = (f: string) => path.relative(REPO, f).split(path.sep).join("/");
  const inv = dispatchedHandlers(program, rel);
  it("the dispatcher keeps its reviewed form, and every case is a plain `return handler(...)` (nothing unclassified)", () => {
    expect(inv.unclassified).toEqual([]);
  });
  it("precondition: the inventory sees the dispatcher's handlers (it is not blind)", () => {
    expect(inv.promising.map((h) => h.key)).toEqual(expect.arrayContaining(["src/tools/webhooks.ts:handleRegisterWebhook", "src/tools/spawn.ts:handleSpawnAgent"]));
  });
  it("the Promise-returning handlers are EXACTLY the classified ones (by file AND export)", () => {
    expect([...new Set(inv.promising.map((h) => h.key))].sort()).toEqual(Object.keys(ASYNC_HANDLERS).sort());
  });
  for (const [key, c] of Object.entries(ASYNC_HANDLERS)) {
    const h = () => inv.promising.find((p) => p.key === key);
    it(`${key}: every post-await write is preceded by the fail-closed recheck (${c.why})`, () => {
      expect(h(), `${key} is not in the dispatcher's inventory`).toBeDefined();
      expect(recheckGuards(program, rel, h()!.decl, c.writesAfterAwait)).toEqual([]);
    });
    it(`${key}: BODY-HASH TRIPWIRE (a new write cannot land unseen: re-review the handler, then update its hash)`, () => {
      expect(h(), `${key} is not in the dispatcher's inventory`).toBeDefined();
      expect(sha256(h()!.decl.getText()), `re-review handler ${key}, then update its bodySha256`).toBe(c.bodySha256);
    });
  }

  /** A virtual handler module against the real-shaped recheck and write modules. */
  const guards = (body: string, extra: Record<string, string> = {}) => {
    const files = {
      "src/authorization-scope.ts": "export function recheckAuthorization() { return { ok: true as boolean }; }",
      "src/w.ts": "export function write(..._a: unknown[]) {}\nexport async function a() {}\nexport async function b() { return 1; }\nexport function no() { return 0; }\nexport function log() {}",
      "src/h.ts": `import { recheckAuthorization } from "./authorization-scope.js";\nimport { write, a, b, no, log } from "./w.js";\n${body}`,
      ...extra,
    };
    const prog = virtualProgram(files);
    const vrel = (f: string) => path.relative("/virtual", f).split(path.sep).join("/");
    const sf = prog.getSourceFiles().find((f) => vrel(f.fileName) === "src/h.ts")!;
    const decl = sf.statements.find((st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === "h")!;
    return recheckGuards(prog, vrel, decl, ["src/w.ts:write"]);
  };
  it("the checker (both legs): the fail-closed form passes; no recheck, an IGNORED recheck, a CONDITIONAL recheck, or an await in between fail", () => {
    const good = `export async function h() { await a(); const r = recheckAuthorization(); if (!r.ok) return no(); write(); }`;
    const goodBlock = `export async function h() { await a(); const r = recheckAuthorization(); if (!r.ok) { log(); return no(); } write(); }`;
    const none = `export async function h() { await a(); write(); }`;
    const ignored = `export async function h() { await a(); recheckAuthorization(); write(); }`;
    const conditional = `export async function h(c: boolean) { await a(); if (c) { const r = recheckAuthorization(); if (!r.ok) return no(); } write(); }`;
    const gap = `export async function h() { await a(); const r = recheckAuthorization(); if (!r.ok) return no(); await b(); write(); }`;
    const before = `export async function h() { write(); await a(); }`;
    expect(guards(good)).toEqual([]);
    expect(guards(goodBlock)).toEqual([]);
    for (const bad of [none, ignored, conditional, gap]) expect(guards(bad).length, bad).toBe(1);
    expect(guards(before)).toEqual([]);
  });
  it("Codex #316 R1 #7: an await INSIDE the write's arguments fails, after a recheck or with no earlier await at all", () => {
    expect(guards(`export async function h() { await a(); const r = recheckAuthorization(); if (!r.ok) return no(); write(await b()); }`)).toEqual([
      "h: write()'s statement suspends (an await) between the recheck and the write",
    ]);
    expect(guards(`export async function h() { write(await b()); }`).length).toBe(1);
  });
  it("Codex #316 R1 #5: a same-named LOCAL recheckAuthorization is no recheck (bound, not spelled)", () => {
    const spoof = `function recheckAuthorization2() { return { ok: true }; }\nexport async function h() { await a(); const r = recheckAuthorization2(); if (!r.ok) return no(); write(); }`;
    expect(guards(spoof).length).toBe(1);
    const local = `export async function h() { const recheckAuthorization = () => ({ ok: true }); await a(); const r = recheckAuthorization(); if (!r.ok) return no(); write(); }`;
    expect(guards(local).length).toBe(1);
  });

  /** A virtual dispatcher: `switchBody` replaces the reviewed switch, `pre` goes before it. */
  const dispatcherOf = (cases: string, opts: { pre?: string; dflt?: string; extra?: Record<string, string>; from?: string } = {}) => {
    const files = {
      "src/server.ts": `import { handleAsync } from "${opts.from ?? "./h.js"}";\nimport { pause, ASchema } from "./u.js";\nexport function createServer() { async function dispatch(name: string, args: any): Promise<any> { ${opts.pre ?? ""} switch (name) { ${cases} ${opts.dflt ?? REVIEWED_DEFAULT} } } return dispatch; }`,
      "src/h.ts": `export async function handleAsync(_a?: unknown) { return 1; }`,
      "src/u.ts": `export async function pause() {}\nexport const ASchema = { parse: (a: unknown) => a };`,
      ...opts.extra,
    };
    return dispatchedHandlers(virtualProgram(files), (f) => path.relative("/virtual", f).split(path.sep).join("/"));
  };
  it("Codex #316 R1 #4 (both legs): the reviewed dispatcher passes; an await before the switch, an extra statement in a case, an await or another call in a handler's argument, and a changed default each fail", () => {
    const good = dispatcherOf(`case "t": return handleAsync(ASchema.parse(args));`);
    expect(good.unclassified).toEqual([]);
    expect(good.promising.map((p) => p.key)).toEqual(["src/h.ts:handleAsync"]);
    expect(dispatcherOf(`case "t": return handleAsync(ASchema.parse(args));`, { pre: "await pause();" }).unclassified.length).toBe(1);
    expect(dispatcherOf(`case "t": await pause(); return handleAsync(ASchema.parse(args));`).unclassified.length).toBe(1);
    expect(dispatcherOf(`case "t": return handleAsync(await pause());`).unclassified.length).toBe(1);
    expect(dispatcherOf(`case "t": return handleAsync(ASchema.parse(pause()));`).unclassified.length).toBe(1);
    expect(dispatcherOf(`case "t": return handleAsync(ASchema.parse(args));`, { dflt: `default: return { content: [], isError: false };` }).unclassified.length).toBe(1);
  });
  it("Codex #316 R1 #5: an import REDIRECTED to another module exporting the same name is a different handler (file + export)", () => {
    const v = dispatcherOf(`case "t": return handleAsync(ASchema.parse(args));`, { from: "./other.js", extra: { "src/other.ts": `export async function handleAsync(_a?: unknown) { return 2; }` } });
    expect(v.promising.map((p) => p.key)).toEqual(["src/other.ts:handleAsync"]);
  });
  it("Codex #315 R2 N4: a SYNC handler returning `pre().then(write)` is inventoried as Promise-returning (so it must be classified)", () => {
    const files = {
      "src/server.ts": `import { handleSync } from "./s.js";\nimport { ASchema } from "./u.js";\nexport function createServer() { async function dispatch(name: string, args: any): Promise<any> { switch (name) { case "t": return handleSync(ASchema.parse(args)); ${REVIEWED_DEFAULT} } } return dispatch; }`,
      "src/s.ts": `async function pre(): Promise<void> {}\nfunction write(): void {}\nexport function handleSync(_a: unknown) { return pre().then(() => write()); }`,
      "src/u.ts": `export const ASchema = { parse: (a: unknown) => a };`,
    };
    const inv2 = dispatchedHandlers(virtualProgram(files), (f) => path.relative("/virtual", f).split(path.sep).join("/"));
    expect(inv2.unclassified).toEqual([]);
    expect(inv2.promising.map((h) => h.key)).toEqual(["src/s.ts:handleSync"]);
  });
});
