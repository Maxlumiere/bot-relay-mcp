// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * tests/_helpers/mcp-tool-call.ts, toolCallResult: the parser the --full files (load-smoke, chaos) read every
 * `tools/call` with. Unit level, no daemon: each row builds the HTTP response a transport could send.
 */
import { describe, it, expect } from "vitest";
import { toolCallResult } from "./_helpers/mcp-tool-call.js";

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

  it("TWIN: a tool error the caller EXPECTS resolves to its JSON; a success where an error was expected REJECTS", async () => {
    const refused = toolResult({ success: false, error: "no" }, { isError: true });
    await expect(toolCallResult(reply(refused, JSON_CT), { tool: "broadcast", expectError: true })).resolves.toEqual({ success: false, error: "no" });
    await expect(toolCallResult(reply(toolResult({ success: true }), JSON_CT), { tool: "broadcast", expectError: true })).rejects.toThrow(
      /expected the tool to refuse \(isError\), but it succeeded \(tools\/call broadcast:/,
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
  ])("RED: %s REJECTS with the contextual error (tool, status, content type, body), never a bare TypeError", async (_label, body, why) => {
    const p = toolCallResult(reply(body, JSON_CT, 401), { tool: "register_agent" });
    await expect(p).rejects.toThrow(why);
    await expect(toolCallResult(reply(body, JSON_CT, 401), { tool: "register_agent" })).rejects.toThrow(/\(tools\/call register_agent: HTTP 401, content-type application\/json, body /);
  });

  it.each([
    ["no response with the request's id", sse(data(notification), data(toolResult({ success: true }, {}, 2))), /found 0/],
    ["two responses with the request's id", sse(data(toolResult({ n: 1 })), data(toolResult({ n: 2 }))), /found 2/],
  ])("RED: an SSE stream with %s REJECTS (exactly one is the answer)", async (_label, body, why) => {
    await expect(toolCallResult(reply(body, SSE_CT), { tool: "send_message" })).rejects.toThrow(why);
  });
});
