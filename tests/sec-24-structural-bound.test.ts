// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-24: no HTTP request body reaches any schema validator (the relay's or the MCP SDK's) with an array over
 * MAX_ARRAY (1000) elements or nesting deeper than MAX_DEPTH (64). Enforced before auth.
 *
 * - PURE: the walk's bounds both ways, and a 200,000-deep body is refused without a stack overflow (the walk is
 *   iterative).
 * - BLACK-BOX, in a CHILD process running the built daemon (dist), so its peak RSS is its own:
 *   - a 1 MB body holding a 500,000-element array, sent to /mcp and to a REST route, unauthenticated AND
 *     authenticated, gets the named 400 (BODY_STRUCTURE_LIMIT);
 *   - the child's peak RSS stays within 2x a control child that served only legitimate requests;
 *   - THE TWIN: a legitimate resolve_messages with 100 ids passes the bound;
 * - THE SDK'S OWN BODY READ: given parsedBody undefined, the MCP SDK reads the raw request stream itself (its own
 *   4 MiB limit) and parses it, which would bypass express.json's limit AND this bound. The relay therefore never
 *   hands it undefined on a POST (sdkParsedBody: null instead). Pinned three ways: the SDK's contract (undefined →
 *   the stream is read; null → a clean JSON-RPC 400, the stream untouched), sdkParsedBody itself, and every
 *   handleRequest call site in http.ts. No Content-Type that the SDK accepts but express.json skips was found
 *   (12 malformed headers tried, 24 Oct), so this is defense in depth, not a reproduced bypass.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { structuralViolation, MAX_ARRAY, MAX_DEPTH } from "../src/structural-bound.js";
import { sdkParsedBody } from "../src/transport/http.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sec24-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const nested = (depth: number) => JSON.parse("[".repeat(depth) + "]".repeat(depth));

describe("SEC-24, pure: the walk", () => {
  it("bounds both ways: arrays of exactly MAX_ARRAY pass and MAX_ARRAY + 1 fail; MAX_DEPTH levels pass and one more fails", () => {
    expect(MAX_ARRAY).toBe(1000);
    expect(MAX_DEPTH).toBe(64);
    expect(structuralViolation({ a: Array(MAX_ARRAY).fill(1) })).toBeNull();
    expect(structuralViolation({ a: Array(MAX_ARRAY + 1).fill(1) })).toMatch(/an array of 1001 elements/);
    expect(structuralViolation({ a: { b: [Array(MAX_ARRAY + 1).fill("x")] } }), "found when nested").toMatch(/1001 elements/);
    expect(structuralViolation(nested(MAX_DEPTH))).toBeNull();
    expect(structuralViolation(nested(MAX_DEPTH + 1))).toMatch(/nesting deeper than 64/);
    expect(structuralViolation([{ a: [{ b: 1 }] }])).toBeNull();
    for (const scalar of [null, undefined, 1, "s", true]) expect(structuralViolation(scalar)).toBeNull();
  });

  it("a 200,000-deep body is refused, never a stack overflow (the walk is iterative)", () => {
    expect(() => structuralViolation(nested(200_000))).not.toThrow();
    expect(structuralViolation(nested(200_000))).toMatch(/nesting deeper than 64/);
  });
});

/** The child: the built daemon on an ephemeral port, the requests, then its own peak RSS, as one JSON line. */
const CHILD = `
const http = await import(${JSON.stringify(path.join(REPO, "dist", "transport", "http.js"))});
const mode = process.env.SEC24_MODE;
const server = http.startHttpServer(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = "http://127.0.0.1:" + server.address().port;
const fs = await import("fs"); const path = await import("path");
const secret = fs.readFileSync(path.join(path.dirname(process.env.RELAY_DB_PATH), "secrets", "mint.secret"), "utf-8").trim();
const MCP = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const call = async (url, headers, body) => { const r = await fetch(base + url, { method: "POST", headers, body }); return { status: r.status, text: await r.text() }; };
const rpc = (name, args, id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const sse = (t) => { const d = t.split("\\n").find((l) => l.startsWith("data:")); return JSON.parse(d ? d.slice(5) : t); };
const reg = sse((await call("/mcp", { ...MCP, "X-Relay-Secret": secret }, rpc("register_agent", { name: "fx-sec24", role: "r", capabilities: [] }, 1))).text);
const token = JSON.parse(reg.result.content[0].text).agent_token;
const out = { token: !!token };
if (mode === "hostile") {
  const huge = "[" + Array(500000).fill("1").join(",") + "]";
  // Unauthenticated: a register_agent (the HTTP path a stranger can call). Authenticated: resolve_messages, whose schema
  // REACHES the array (500,000 non-string ids): without the bound this is the validator's exhaustion path, so the RSS
  // bar is not vacuous (a register_agent body is refused by the registration gate before its schema runs).
  const hugeMcp = '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"register_agent","arguments":{"name":"fx-x","role":"r","capabilities":' + huge + "}}}";
  const hugeMcpAuth = '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"resolve_messages","arguments":{"agent_name":"fx-sec24","agent_token":' + JSON.stringify(token) + ',"message_ids":' + huge + "}}}";
  const hugeRest = '{"to":"fx-sec24","content":"x","ids":' + huge + "}";
  out.bytes = Math.max(hugeMcp.length, hugeMcpAuth.length);
  out.mcpUnauth = await call("/mcp", MCP, hugeMcp);
  out.mcpAuth = await call("/mcp", { ...MCP, "X-Agent-Token": token }, hugeMcpAuth);
  out.restUnauth = await call("/api/send-message", { "Content-Type": "application/json" }, hugeRest);
  out.restAuth = await call("/api/send-message", { "Content-Type": "application/json", "X-Agent-Token": token }, hugeRest);
}
// THE TWIN (both modes): a legitimate resolve_messages of 100 REAL messages addressed to fx-sec24.
const peerReg = sse((await call("/mcp", { ...MCP, "X-Relay-Secret": secret }, rpc("register_agent", { name: "fx-sec24-peer", role: "r", capabilities: [] }, 3))).text);
const peer = JSON.parse(peerReg.result.content[0].text).agent_token;
for (let i = 0; i < 100; i++) await call("/mcp", { ...MCP, "X-Agent-Token": peer }, rpc("send_message", { from: "fx-sec24-peer", to: "fx-sec24", content: "m" + i }, 100 + i));
const inbox = JSON.parse(sse((await call("/mcp", { ...MCP, "X-Agent-Token": token }, rpc("get_messages", { agent_name: "fx-sec24", limit: 100, peek: true }, 4))).text).result.content[0].text);
const ids = (inbox.messages ?? []).map((m) => m.id);
out.twinIds = ids.length;
out.twin = await call("/mcp", { ...MCP, "X-Agent-Token": token }, rpc("resolve_messages", { agent_name: "fx-sec24", message_ids: ids }, 2));
{ const r = JSON.parse(sse(out.twin.text).result.content[0].text); out.twinResult = { success: r.success, resolved_count: r.resolved_count, error: r.error }; }
out.maxRssKB = process.resourceUsage().maxRSS;
for (const k of Object.keys(out)) if (out[k] && typeof out[k].text === "string") out[k].text = out[k].text.slice(0, 400);
process.stdout.write("SEC24 " + JSON.stringify(out) + "\\n");
server.close(); process.exit(0);
`;

function runChild(mode: "hostile" | "control"): Promise<Record<string, any>> {
  const dir = fs.mkdtempSync(path.join(ROOT, `${mode}-`));
  fs.mkdirSync(path.join(dir, "home"), { recursive: true });
  return new Promise((resolve, reject) => {
    // From a FILE, never `--input-type=module -e`: the daemon's bcrypt pool is an eval Worker, which inherits that
    // flag, parses as ESM and fails every token verify (MEASURED 24 Oct; a production daemon runs a file).
    const file = path.join(dir, "child.mjs");
    fs.writeFileSync(file, CHILD);
    const c = spawn(process.execPath, [file], {
      env: { PATH: process.env.PATH ?? "", HOME: path.join(dir, "home"), RELAY_DB_PATH: path.join(dir, "relay.db"), SEC24_MODE: mode, RELAY_LOG_LEVEL: "error" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let so = "", se = "";
    c.stdout.on("data", (d) => (so += d));
    c.stderr.on("data", (d) => (se += d));
    const t = setTimeout(() => c.kill("SIGKILL"), 90_000);
    c.on("close", (code) => {
      clearTimeout(t);
      const line = so.split("\n").find((l) => l.startsWith("SEC24 "));
      if (!line) return reject(new Error(`child (${mode}) exit ${code}, no result line.\nstdout: ${so.slice(-2000)}\nstderr: ${se.slice(-2000)}`));
      resolve(JSON.parse(line.slice(6)));
    });
  });
}

describe("SEC-24, black-box: the built daemon in a child process", () => {
  it("a 1 MB body with a 500,000-element array gets the named 400 on /mcp and a REST route, unauthenticated and authenticated; peak RSS within 2x the control; the twin passes", async () => {
    const control = await runChild("control");
    const hostile = await runChild("hostile");
    // Peak RSS: process.resourceUsage().maxRSS is in kilobytes.
    const ratio = hostile.maxRssKB / control.maxRssKB;
    const measured = `SEC-24 peak RSS: hostile ${(hostile.maxRssKB / 1024).toFixed(1)} MB, control ${(control.maxRssKB / 1024).toFixed(1)} MB, ratio ${ratio.toFixed(2)}; hostile statuses ${["mcpUnauth", "mcpAuth", "restUnauth", "restAuth"].map((k) => `${k}=${hostile[k]?.status}`).join(" ")}`;
    if (process.env.SEC24_REPORT) {
      // the numbers and the responses, for a report
      fs.appendFileSync(process.env.SEC24_REPORT, measured + "\n" + JSON.stringify({ mcpAuth: hostile.mcpAuth?.text?.slice(0, 300), hostileTwin: hostile.twin.text.slice(0, 300), controlTwin: control.twin.text.slice(0, 300) }) + "\n");
    }
    expect(hostile.token, "the child registered (the authenticated cases are real)").toBe(true);
    expect(hostile.bytes, "the hostile body is under the 1 MB HTTP limit (else express.json, not SEC-24, refuses it)").toBeLessThan(1024 * 1024);
    for (const k of ["mcpUnauth", "mcpAuth", "restUnauth", "restAuth"]) {
      expect(hostile[k].status, `${k}: ${hostile[k].text}`).toBe(400);
      expect(JSON.parse(hostile[k].text).error_code, k).toBe("BODY_STRUCTURE_LIMIT");
    }
    expect(ratio, measured).toBeLessThanOrEqual(2);
    // THE TWIN, in both children: 100 ids pass the bound (a tool result, never the SEC-24 400).
    for (const [name, r] of [["control", control], ["hostile", hostile]] as const) {
      expect(r.twinIds, `${name}: 100 real messages were in fx-sec24's inbox`).toBe(100);
      expect(r.twin.status, `${name} twin: ${r.twin.text}`).toBe(200);
      const result = r.twinResult;
      expect(result.success, `${name} twin: ${JSON.stringify(result)}`).toBe(true);
      expect(result.resolved_count, `${name} twin resolved all 100: ${JSON.stringify(result)}`).toBe(100);
    }

  }, 200_000);
});

describe("SEC-24: the MCP SDK never reads the request stream itself", () => {
  async function sdkReads(parsedBody: unknown): Promise<{ status: number; read: boolean; text: string }> {
    const { WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const t = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const s = new Server({ name: "sec24", version: "1" }, { capabilities: { tools: {} } });
    await s.connect(t);
    const req = new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const res = await t.handleRequest(req, parsedBody === undefined ? {} : { parsedBody });
    const out = { status: res.status, read: req.bodyUsed, text: await res.text() };
    await s.close();
    return out;
  }

  it("THE SDK'S CONTRACT: parsedBody undefined → it reads the stream itself; null → a clean JSON-RPC 400, the stream untouched", async () => {
    expect((await sdkReads(undefined)).read, "undefined: the SDK read the raw stream (the bypass)").toBe(true);
    const n = await sdkReads(null);
    expect(n.read, "null: the stream was never read").toBe(false);
    expect(n.status).toBe(400);
    const body = JSON.parse(n.text);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32700);
  });

  it("sdkParsedBody never returns undefined: an unparsed body becomes null; a parsed one is passed through", () => {
    expect(sdkParsedBody({ body: undefined })).toBeNull();
    const parsed = { jsonrpc: "2.0" };
    expect(sdkParsedBody({ body: parsed })).toBe(parsed);
  });

  it("every POST handleRequest call in http.ts passes sdkParsedBody(req); only the bodiless GET/DELETE path passes undefined", () => {
    const src = fs.readFileSync(path.join(REPO, "src", "transport", "http.ts"), "utf-8");
    const calls = [...src.matchAll(/\.handleRequest\(([^;]*)\);/g)].map((m) => m[1].replace(/\s+/g, " "));
    expect(calls.length, "the handleRequest call sites found").toBe(3);
    for (const c of calls) expect(c, c).toMatch(/^req, res, (sdkParsedBody\(req\)|expectsBody \? sdkParsedBody\(req\) : undefined)$/);
  });
});
