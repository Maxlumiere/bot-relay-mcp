// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The tool result of one `tools/call` POSTed to /mcp, whichever way the transport framed it: a plain `application/json`
 * body (the one-shot path since ADR-0005 #3, v2.22.0) or an SSE stream (`data:` lines). A body that holds no JSON-RPC
 * result THROWS, naming the HTTP status, the content type and the body's head: a broken call names itself, never
 * `undefined.slice`.
 *
 * Returns the tool's own JSON (the parsed `result.content[0].text`), as the callers' assertions expect.
 */
export async function toolCallResult(res: Response): Promise<any> {
  const raw = await res.text();
  const describe = () => `HTTP ${res.status}, content-type ${res.headers.get("content-type") ?? "none"}, body ${JSON.stringify(raw.slice(0, 300))}`;
  const dataLines = raw.split("\n").filter((l) => l.startsWith("data:"));
  let message: { result?: { content?: Array<{ text?: string }> }; error?: unknown };
  try {
    message = JSON.parse(dataLines.length ? dataLines[dataLines.length - 1].slice(5).trim() : raw);
  } catch {
    throw new Error(`tools/call: the response holds no JSON-RPC message (${describe()})`);
  }
  if (message.error !== undefined) throw new Error(`tools/call: JSON-RPC error ${JSON.stringify(message.error)} (${describe()})`);
  const text = message.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error(`tools/call: no result.content[0].text (${describe()})`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`tools/call: the tool's text is not JSON (${describe()})`);
  }
}
