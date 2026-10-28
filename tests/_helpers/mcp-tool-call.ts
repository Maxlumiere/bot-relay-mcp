// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The outcome of one `tools/call` POSTed to /mcp, checked against a CONTRACT that includes the HTTP status, whichever
 * way the transport framed it: a plain `application/json` body (the one-shot path since ADR-0005 #3, v2.22.0) or an SSE
 * stream.
 *
 * - DEFAULT (a success is expected): the status must be 2xx, and the result a non-error tool result. Returns the
 *   tool's own JSON (the parsed `result.content[0].text`).
 * - `expect` (a REFUSAL is expected): the status must be EXACTLY `expect.status`, and the refusal must have the exact
 *   SHAPE named: a tool error (`result.isError === true` whose JSON has `error_code === expect.toolErrorCode`), or a
 *   JSON-RPC error envelope (`error.code === expect.rpcErrorCode`). Returns the tool's JSON, or the JSON-RPC error. A
 *   success, another status or another shape REJECTS.
 * - SSE is read as EVENTS (blank-line separated; an event's `data:` lines joined with "\n"), and EXACTLY ONE JSON-RPC
 *   response whose `id` matches the request's is used: a notification or another response is never the answer.
 * - Every rejection names the tool, the HTTP status, the content type and the body's head; never a bare TypeError.
 *
 * The relay's refusals, MEASURED (one call each against a daemon, 28 Oct): a missing registration secret, a missing or
 * wrong agent token, an unauthenticated broadcast and an unknown tool all answer HTTP 200 with a tool error
 * (MINT_SECRET_REQUIRED or AUTH_FAILED); an unknown method answers HTTP 200 with JSON-RPC error -32601. Pinned against a
 * real daemon in tests/mcp-tool-call.test.ts.
 */
export interface ToolRefusal {
  /** The exact HTTP status the refusal arrives with. */
  status: number;
  /** A tool error: the `error_code` its JSON carries. */
  toolErrorCode?: string;
  /** A JSON-RPC error envelope: its `error.code`. */
  rpcErrorCode?: number;
}

export interface ToolCallOptions {
  /** The tool called, for the error text. */
  tool: string;
  /** The request's JSON-RPC id (default 1). */
  id?: number | string;
  /** The refusal expected, with its status and shape (exactly one of toolErrorCode / rpcErrorCode). */
  expect?: ToolRefusal;
}

type Envelope = { id?: unknown; result?: unknown; error?: unknown };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The `data` payload of every SSE event in `raw` (the event's data lines joined with "\n"). */
function sseEventData(raw: string): string[] {
  const out: string[] = [];
  let data: string[] = [];
  const flush = () => {
    if (data.length) out.push(data.join("\n"));
    data = [];
  };
  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    if (line === "") flush();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  flush();
  return out;
}

export async function toolCallResult(res: Response, opts: ToolCallOptions): Promise<any> {
  const { tool, id = 1, expect } = opts;
  if (expect && (expect.toolErrorCode === undefined) === (expect.rpcErrorCode === undefined)) {
    throw new Error(`toolCallResult(${tool}): an expected refusal names exactly one shape (toolErrorCode or rpcErrorCode)`);
  }
  const raw = await res.text();
  const where = () => `tools/call ${tool}: HTTP ${res.status}, content-type ${res.headers.get("content-type") ?? "none"}, body ${JSON.stringify(raw.slice(0, 300))}`;
  const fail = (why: string): never => {
    throw new Error(`${why} (${where()})`);
  };

  // The STATUS is part of the contract, checked before the body.
  if (expect) {
    if (res.status !== expect.status) fail(`expected the refusal at HTTP ${expect.status}, got ${res.status}`);
  } else if (res.status < 200 || res.status > 299) {
    fail(`expected a 2xx status, got ${res.status}`);
  }

  const isSse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
  let message: unknown;
  if (isSse) {
    const responses: unknown[] = [];
    for (const data of sseEventData(raw)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue; // not a JSON-RPC message (a comment or keep-alive payload)
      }
      if (isObject(parsed) && parsed.id === id) responses.push(parsed);
    }
    if (responses.length !== 1) fail(`expected exactly one JSON-RPC response with id ${JSON.stringify(id)} in the event stream, found ${responses.length}`);
    message = responses[0];
  } else {
    try {
      message = JSON.parse(raw);
    } catch {
      fail("the response holds no JSON-RPC message");
    }
  }

  if (!isObject(message)) fail(`the JSON-RPC envelope is not an object (${message === null ? "null" : Array.isArray(message) ? "an array" : typeof message})`);
  const envelope = message as Envelope;
  if (envelope.id !== id) fail(`the JSON-RPC response's id is ${JSON.stringify(envelope.id)}, not the request's ${JSON.stringify(id)}`);

  if (expect?.rpcErrorCode !== undefined) {
    if (!isObject(envelope.error)) fail(`expected JSON-RPC error ${expect.rpcErrorCode}, got no JSON-RPC error`);
    const code = (envelope.error as { code?: unknown }).code;
    if (code !== expect.rpcErrorCode) fail(`expected JSON-RPC error ${expect.rpcErrorCode}, got ${JSON.stringify(envelope.error)}`);
    return envelope.error;
  }
  if (envelope.error !== undefined) fail(`JSON-RPC error ${JSON.stringify(envelope.error)}`);
  if (!isObject(envelope.result)) fail("the JSON-RPC response has no result object");
  const result = envelope.result as { isError?: unknown; content?: unknown };
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = isObject(first) ? first.text : undefined;
  if (typeof text !== "string") fail("no result.content[0].text");
  const toolError = result.isError === true;
  if (toolError && !expect) fail(`the tool returned an error: ${String(text).slice(0, 300)}`);
  if (!toolError && expect) fail(`expected the tool to refuse with ${expect.toolErrorCode}, but it succeeded`);
  let json: unknown;
  try {
    json = JSON.parse(text as string);
  } catch {
    fail("the tool's text is not JSON");
  }
  if (expect) {
    const code = isObject(json) ? json.error_code : undefined;
    if (code !== expect.toolErrorCode) fail(`expected the tool error ${expect.toolErrorCode}, got ${JSON.stringify(code)}`);
  }
  return json;
}
