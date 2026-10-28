// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The tool result of one `tools/call` POSTed to /mcp, whichever way the transport framed it: a plain `application/json`
 * body (the one-shot path since ADR-0005 #3, v2.22.0) or an SSE stream. Returns the tool's own JSON (the parsed
 * `result.content[0].text`), as the callers' assertions expect.
 *
 * - SSE is read as EVENTS (blank-line separated; an event's `data:` lines joined with "\n"), and the JSON-RPC
 *   RESPONSE whose `id` matches the request's is the one used: a notification or another response in the same stream
 *   is skipped, never taken for the answer.
 * - A TOOL ERROR (`result.isError === true`) REJECTS, unless the caller says it expects one (`expectError`); a call
 *   that expected an error and got a success rejects too.
 * - Anything else that is not a JSON-RPC result (no parseable message, a non-object, a JSON-RPC error, no
 *   `content[0].text`, a tool text that is not JSON) THROWS, naming the tool, the HTTP status, the content type and the
 *   body's head: a broken call names itself, never `undefined.slice`.
 */
export interface ToolCallOptions {
  /** The tool called, for the error text. */
  tool: string;
  /** The request's JSON-RPC id (default 1). */
  id?: number | string;
  /** The caller expects the tool to refuse (`isError: true`): resolve with its JSON, and reject a success. */
  expectError?: boolean;
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
  const { tool, id = 1, expectError = false } = opts;
  const raw = await res.text();
  const where = () => `tools/call ${tool}: HTTP ${res.status}, content-type ${res.headers.get("content-type") ?? "none"}, body ${JSON.stringify(raw.slice(0, 300))}`;
  const fail = (why: string): never => {
    throw new Error(`${why} (${where()})`);
  };

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
  if (envelope.error !== undefined) fail(`JSON-RPC error ${JSON.stringify(envelope.error)}`);
  if (!isObject(envelope.result)) fail("the JSON-RPC response has no result object");
  const result = envelope.result as { isError?: unknown; content?: unknown };
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = isObject(first) ? first.text : undefined;
  if (typeof text !== "string") fail("no result.content[0].text");
  const toolError = result.isError === true;
  if (toolError && !expectError) fail(`the tool returned an error: ${String(text).slice(0, 300)}`);
  if (!toolError && expectError) fail("expected the tool to refuse (isError), but it succeeded");
  try {
    return JSON.parse(text as string);
  } catch {
    return fail("the tool's text is not JSON");
  }
}
