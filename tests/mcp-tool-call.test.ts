// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * tests/_helpers/mcp-tool-call.ts, toolCallResult: the parser the --full files (load-smoke, chaos) read every
 * `tools/call` with, against a contract that includes the HTTP status. The unit rows build the HTTP response a transport
 * could send; the last block PINS the relay's refusals as measured, against a real daemon.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { toolCallResult } from "./_helpers/mcp-tool-call.js";
import { spawnDaemon, tearDownDaemon, type DaemonHandle } from "./helpers/relay-http-harness.js";
import { mintHeaders } from "./_helpers/mint.js";

const JSON_CT = "application/json";
const SSE_CT = "text/event-stream";
const reply = (body: string, contentType: string, status = 200) => new Response(body, { status, headers: { "content-type": contentType } });
const toolResult = (payload: unknown, extra: Record<string, unknown> = {}, id: unknown = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }], ...extra } });
const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "progress" } });
const sse = (...events: string[]) => events.map((e) => `event: message\n${e}\n\n`).join("");
const data = (json: string) => `data: ${json}`;

describe("toolCallResult: a tool call's result, whatever the framing", () => {
  it("TWIN: a plain JSON body resolves to the tool's JSON", async () => {
    await expect(toolCallResult(reply(toolResult({ success: true, n: 1 }), JSON_CT), { tool: "send_message" })).resolves.toEqual({ success: true, n: 1 });
  });

  it("TWIN: an SSE stream whose LAST event is the response resolves to it (a notification before it is skipped)", async () => {
    const body = sse(data(notification), data(toolResult({ success: true, n: 2 })));
    await expect(toolCallResult(reply(body, SSE_CT), { tool: "send_message" })).resolves.toEqual({ success: true, n: 2 });
  });

  it("RED: an SSE stream with the response FIRST and a notification AFTER picks the response (matched by id, never the last event)", async () => {
    const body = sse(data(toolResult({ success: true, n: 3 })), data(notification));
    await expect(toolCallResult(reply(body, SSE_CT), { tool: "send_message" })).resolves.toEqual({ success: true, n: 3 });
  });

  it("RED: a multi-line `data:` event is joined into one message (SSE events, not lines)", async () => {
    const json = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ success: true, n: 4 }) }] } }, null, 2);
    const body = `event: message\n${json.split("\n").map((l) => `data: ${l}`).join("\n")}\n\n`;
    await expect(toolCallResult(reply(body, SSE_CT), { tool: "send_message" })).resolves.toEqual({ success: true, n: 4 });
  });

  it("an SSE stream with CRLF line endings parses the same", async () => {
    const body = sse(data(notification), data(toolResult({ success: true, n: 5 }))).replace(/\n/g, "\r\n");
    await expect(toolCallResult(reply(body, SSE_CT), { tool: "send_message" })).resolves.toEqual({ success: true, n: 5 });
  });

  it("RED: a TOOL ERROR (result.isError) REJECTS, naming the tool, the HTTP status and the error text", async () => {
    const body = toolResult({ success: false, error: "Agent \"x\" requires an agent_token." }, { isError: true });
    await expect(toolCallResult(reply(body, JSON_CT), { tool: "get_messages" })).rejects.toThrow(
      /the tool returned an error: .*requires an agent_token.*\(tools\/call get_messages: HTTP 200, content-type application\/json/,
    );
  });

  it("RED: a 500 carrying a VALID matching-id success result REJECTS (the default contract is 2xx)", async () => {
    await expect(toolCallResult(reply(toolResult({ success: true }), JSON_CT, 500), { tool: "send_message" })).rejects.toThrow(
      /expected a 2xx status, got 500 \(tools\/call send_message: HTTP 500/,
    );
  });

  // The relay's refusal as MEASURED: HTTP 200, a tool error whose JSON carries error_code (here AUTH_FAILED).
  const measuredRefusal = toolResult({ success: false, error: "Agent \"ghost\" is not registered.", error_code: "AUTH_FAILED", auth_error: true }, { isError: true });

  it("TWIN: the MEASURED refusal shape passes its exact contract (status 200, tool error AUTH_FAILED) and resolves to the tool's JSON", async () => {
    await expect(toolCallResult(reply(measuredRefusal, JSON_CT), { tool: "broadcast", expect: { status: 200, toolErrorCode: "AUTH_FAILED" } })).resolves.toMatchObject({
      success: false,
      error_code: "AUTH_FAILED",
    });
  });

  it.each([
    ["the expected 401 arrives as a 500", reply(measuredRefusal, JSON_CT, 500), { status: 401, toolErrorCode: "AUTH_FAILED" }, /expected the refusal at HTTP 401, got 500/],
    ["the right status with another tool error code", reply(measuredRefusal, JSON_CT), { status: 200, toolErrorCode: "MINT_SECRET_REQUIRED" }, /expected the tool error MINT_SECRET_REQUIRED, got "AUTH_FAILED"/],
    ["a SUCCESS where a refusal was expected", reply(toolResult({ success: true }), JSON_CT), { status: 200, toolErrorCode: "AUTH_FAILED" }, /expected the tool to refuse with AUTH_FAILED, but it succeeded/],
    ["a JSON-RPC error where a tool error was expected", reply(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }), JSON_CT), { status: 200, toolErrorCode: "AUTH_FAILED" }, /JSON-RPC error .*Method not found/],
    ["a tool error where a JSON-RPC error was expected", reply(measuredRefusal, JSON_CT), { status: 200, rpcErrorCode: -32601 }, /expected JSON-RPC error -32601, got no JSON-RPC error/],
    ["another JSON-RPC error code", reply(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } }), JSON_CT), { status: 200, rpcErrorCode: -32601 }, /expected JSON-RPC error -32601, got .*-32602/],
  ])("RED: an expected refusal REJECTS when %s", async (_label, res, refusal, why) => {
    await expect(toolCallResult(res, { tool: "broadcast", expect: refusal })).rejects.toThrow(why);
  });

  it("TWIN: an expected JSON-RPC error envelope (the measured unknown-method shape) resolves to the error", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });
    await expect(toolCallResult(reply(body, JSON_CT), { tool: "x", expect: { status: 200, rpcErrorCode: -32601 } })).resolves.toMatchObject({ code: -32601 });
  });

  it("an expected refusal must name exactly ONE shape", async () => {
    await expect(toolCallResult(reply(measuredRefusal, JSON_CT), { tool: "broadcast", expect: { status: 200 } })).rejects.toThrow(/names exactly one shape/);
    await expect(toolCallResult(reply(measuredRefusal, JSON_CT), { tool: "broadcast", expect: { status: 200, toolErrorCode: "AUTH_FAILED", rpcErrorCode: -32601 } })).rejects.toThrow(
      /names exactly one shape/,
    );
  });

  it.each([
    ["null", "null", /the JSON-RPC envelope is not an object \(null\)/],
    ["an array", "[]", /the JSON-RPC envelope is not an object \(an array\)/],
    ["a number", "7", /the JSON-RPC envelope is not an object \(number\)/],
    ["not JSON", "<html>oops</html>", /the response holds no JSON-RPC message/],
    ["a JSON-RPC error", JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }), /JSON-RPC error .*Method not found/],
    ["another request's id", toolResult({ success: true }, {}, 2), /the JSON-RPC response's id is 2, not the request's 1/],
    ["no result object", JSON.stringify({ jsonrpc: "2.0", id: 1 }), /the JSON-RPC response has no result object/],
    ["no content text", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }), /no result\.content\[0\]\.text/],
    ["a tool text that is not JSON", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "plain words" }] } }), /the tool's text is not JSON/],
  ])("RED: %s at HTTP 200 REJECTS for its SHAPE, with the contextual error (tool, status, content type, body), never a bare TypeError", async (_label, body, why) => {
    // At 200 the status passes, so the rejection is the shape's (a non-2xx fixture would be rejected by its status first).
    await expect(toolCallResult(reply(body, JSON_CT), { tool: "register_agent" })).rejects.toThrow(why);
    await expect(toolCallResult(reply(body, JSON_CT), { tool: "register_agent" })).rejects.toThrow(/\(tools\/call register_agent: HTTP 200, content-type application\/json, body /);
  });

  it.each([
    ["no response with the request's id", sse(data(notification), data(toolResult({ success: true }, {}, 2))), /found 0/],
    ["two responses with the request's id", sse(data(toolResult({ n: 1 })), data(toolResult({ n: 2 }))), /found 2/],
  ])("RED: an SSE stream with %s REJECTS (exactly one is the answer)", async (_label, body, why) => {
    await expect(toolCallResult(reply(body, SSE_CT), { tool: "send_message" })).rejects.toThrow(why);
  });
});

describe.skipIf(process.platform === "win32")("the relay's refusals, PINNED against a real daemon (the shapes the --full files expect)", () => {
  let d: DaemonHandle;
  beforeAll(async () => {
    d = await spawnDaemon();
  }, 30_000);
  afterAll(async () => {
    if (d) await tearDownDaemon(d);
  });
  const post = (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}, method = "tools/call") =>
    fetch(`${d.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { name, arguments: args } }),
    });

  it("a registration with the secret SUCCEEDS at 2xx; without it: HTTP 200, tool error MINT_SECRET_REQUIRED", async () => {
    const ok = await toolCallResult(await post("register_agent", { name: "pin-a", role: "r", capabilities: [] }, mintHeaders(d.tmpDir)), { tool: "register_agent" });
    expect(ok.agent_token).toBeTruthy();
    await toolCallResult(await post("register_agent", { name: "pin-b", role: "r", capabilities: [] }), {
      tool: "register_agent",
      expect: { status: 200, toolErrorCode: "MINT_SECRET_REQUIRED" },
    });
  });

  it("an unauthenticated broadcast and an unauthenticated get_messages: HTTP 200, tool error AUTH_FAILED", async () => {
    await toolCallResult(await post("broadcast", { from: "pin-ghost", content: "x" }), { tool: "broadcast", expect: { status: 200, toolErrorCode: "AUTH_FAILED" } });
    await toolCallResult(await post("get_messages", { agent_name: "pin-a", status: "pending", limit: 1 }), {
      tool: "get_messages",
      expect: { status: 200, toolErrorCode: "AUTH_FAILED" },
    });
  });

  it("an unknown method: HTTP 200, JSON-RPC error -32601", async () => {
    await toolCallResult(await post("x", {}, {}, "no/such_method"), { tool: "no/such_method", expect: { status: 200, rpcErrorCode: -32601 } });
  });
});
