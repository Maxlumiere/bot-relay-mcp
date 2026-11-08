// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR 4: a LOCAL `relay send` / `relay resolve` reaches its relay only through the owner door
 * (src/cli/relay-client.ts localTool), never fetch. The in-process output-discipline rows test what the CLI does
 * with the tool's ENVELOPE (stdout/stderr, exit codes), so they keep their fake daemon: while a row has mocked
 * globalThis.fetch, this adapter hands the same JSON-RPC tools/call to it and returns its tool result. When fetch is
 * NOT mocked (a real-daemon row), the real door is used. The door itself is covered end-to-end in
 * tests/cli-door-clients.test.ts.
 *
 * Use: vi.mock("../src/cli/relay-client.js", async (orig) => (await import("./_helpers/door-via-fetch.js")).doorViaFetch(await orig()));
 */
import { vi } from "vitest";

type Client = typeof import("../../src/cli/relay-client.js");

export function doorViaFetch(real: Client): Client {
  const localTool: Client["localTool"] = async (name, args, creds, opts) => {
    if (!vi.isMockFunction(globalThis.fetch)) return real.localTool(name, args, creds, opts);
    let res: Response;
    try {
      res = await globalThis.fetch("http://door.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(creds.agentToken ? { "X-Agent-Token": creds.agentToken } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
    } catch (e) {
      throw new real.RelayClientError(e instanceof Error ? e.message : String(e));
    }
    const text = await res.text();
    // A JSON-RPC / SSE reply carries the tool result; a bare JSON body is the tool's own envelope.
    const result = real.mcpResultOf(text) ?? { content: [{ type: "text", text }] };
    return res.status >= 400 ? { ...result, isError: true } : result;
  };
  return { ...real, localTool };
}
