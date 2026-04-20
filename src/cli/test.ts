// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4h — `relay test` subcommand.
 *
 * Fresh-install self-check. Spawns an isolated relay HTTP server on a
 * throwaway port + DB path, runs a minimal agent-register → send_message →
 * receive round-trip, tears down. Prints PASS/FAIL. Under 2s.
 *
 * For the full 25-tool + CLI battery, use scripts/smoke-25-tools.sh (runs in the
 * pre-publish gate).
 */
import fs from "fs";
import path from "path";
import os from "os";

export async function run(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "Usage: relay test\n\n" +
        "Spawns an isolated relay + runs a minimal round-trip self-check.\n" +
        "Does NOT affect your live ~/.bot-relay/ — throwaway port + DB.\n"
    );
    return 0;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-selftest-"));
  const originalDbPath = process.env.RELAY_DB_PATH;
  const originalConfigPath = process.env.RELAY_CONFIG_PATH;
  const originalHttpSecret = process.env.RELAY_HTTP_SECRET;
  const originalAllowLegacy = process.env.RELAY_ALLOW_LEGACY;

  process.env.RELAY_DB_PATH = path.join(tmpDir, "relay.db");
  process.env.RELAY_CONFIG_PATH = path.join(tmpDir, "config.json");
  delete process.env.RELAY_HTTP_SECRET;
  delete process.env.RELAY_ALLOW_LEGACY;

  let server: any;
  let failed = false;
  const results: { step: string; ok: boolean; detail: string }[] = [];

  try {
    // Eager DB init — the HTTP handler's first tool call otherwise falls
    // through getDb()'s lazy createRequire path, which doesn't work under
    // ESM bins. This is the same pattern src/index.ts uses at daemon start.
    const { initializeDb } = await import("../db.js");
    await initializeDb();
    const { startHttpServer } = await import("../transport/http.js");
    server = startHttpServer(0, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 80));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    async function rpc(tool: string, args: any): Promise<any> {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
      });
      const text = await res.text();
      const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
      const rpcResp = dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(text);
      if (rpcResp.error) {
        throw new Error(`MCP error on ${tool}: ${rpcResp.error.message ?? JSON.stringify(rpcResp.error)}`);
      }
      if (!rpcResp.result?.content?.[0]?.text) {
        throw new Error(`unexpected MCP response for ${tool}: ${text.slice(0, 200)}`);
      }
      return JSON.parse(rpcResp.result.content[0].text);
    }

    // 1. /health probe
    const h = await fetch(`${baseUrl}/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
    if ((h as any).status === "ok") {
      results.push({ step: "health", ok: true, detail: `version=${(h as any).version} protocol_version=${(h as any).protocol_version}` });
    } else {
      results.push({ step: "health", ok: false, detail: JSON.stringify(h) });
      failed = true;
    }

    // 2. register two agents
    const a = await rpc("register_agent", { name: "selftest-a", role: "tester", capabilities: [] });
    if (a.success) results.push({ step: "register_agent a", ok: true, detail: "ok" });
    else { results.push({ step: "register_agent a", ok: false, detail: a.error ?? "?" }); failed = true; }
    const aTok = a.agent_token;

    const b = await rpc("register_agent", { name: "selftest-b", role: "tester", capabilities: [] });
    if (b.success) results.push({ step: "register_agent b", ok: true, detail: "ok" });
    else { results.push({ step: "register_agent b", ok: false, detail: b.error ?? "?" }); failed = true; }

    // 3. a → b send_message
    const send = await rpc("send_message", { from: "selftest-a", to: "selftest-b", content: "ping", agent_token: aTok });
    if (send.success) results.push({ step: "send_message", ok: true, detail: `id=${send.message_id?.slice(0, 8) ?? "?"}` });
    else { results.push({ step: "send_message", ok: false, detail: send.error ?? "?" }); failed = true; }

    // 4. b reads messages (it's a party so NOT_PARTY guard doesn't apply; get_messages is its own tool)
    const recv = await rpc("get_messages", { agent_name: "selftest-b", status: "pending", limit: 5, agent_token: b.agent_token });
    const messages = recv.messages ?? [];
    if (messages.some((m: any) => m.content === "ping")) {
      results.push({ step: "get_messages", ok: true, detail: `delivered: "${messages[0]?.content ?? "?"}"` });
    } else {
      results.push({ step: "get_messages", ok: false, detail: `inbox=${JSON.stringify(messages)}` });
      failed = true;
    }
  } catch (err) {
    results.push({ step: "harness", ok: false, detail: err instanceof Error ? err.message : String(err) });
    failed = true;
  } finally {
    try {
      server?.close();
    } catch {
      /* ignore */
    }
    try {
      const { closeDb } = await import("../db.js");
      closeDb();
    } catch {
      /* ignore */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalDbPath === undefined) delete process.env.RELAY_DB_PATH;
    else process.env.RELAY_DB_PATH = originalDbPath;
    if (originalConfigPath === undefined) delete process.env.RELAY_CONFIG_PATH;
    else process.env.RELAY_CONFIG_PATH = originalConfigPath;
    if (originalHttpSecret !== undefined) process.env.RELAY_HTTP_SECRET = originalHttpSecret;
    if (originalAllowLegacy !== undefined) process.env.RELAY_ALLOW_LEGACY = originalAllowLegacy;
  }

  process.stdout.write("=== relay test ===\n");
  for (const r of results) {
    process.stdout.write(`  ${r.ok ? "PASS" : "FAIL"}  ${r.step}: ${r.detail}\n`);
  }
  process.stdout.write(`\nResult: ${failed ? "FAIL" : "PASS"}\n`);
  return failed ? 1 : 0;
}
