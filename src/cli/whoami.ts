// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay whoami [--agent NAME] [--json]`: which agent does your token belong to? READ-ONLY: the CLI counterpart of the
 * `whoami` MCP tool, for a session whose MCP transport is down.
 *
 * The token IS the identity: RELAY_AGENT_TOKEN, else the vault token of --agent (default $RELAY_AGENT_NAME), validated
 * locally first (src/cli/agent-token.ts). A LOCAL relay is reached only through its owner door; a REMOTE one with its
 * own credentials over /mcp. STREAM DISCIPLINE: --json prints the closed identity envelope (no token, no secret: the
 * tool's closed type); otherwise stdout is ONLY the agent name, the human line on stderr. --agent NAME that the token
 * does not belong to exits 1 with nothing on stdout. Never registers, never mints.
 */
interface Args {
  agent: string | null;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { agent: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--agent") {
      const v = argv[++i];
      if (!v) throw new Error("--agent requires an agent name");
      out.agent = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function usage(requested = false): void {
  (requested ? process.stdout : process.stderr).write(
    "Usage: relay whoami [--agent NAME] [--json]\n\n" +
      "Ask the relay which agent your token belongs to (read-only; the CLI form of the whoami tool).\n\n" +
      "  --agent NAME   Whose vault token to present (default: $RELAY_AGENT_NAME); with RELAY_AGENT_TOKEN set,\n" +
      "                 the answer must be this agent or the verb exits 1.\n" +
      "  --json         The identity envelope (agent_name, role, capabilities, instance_id, db_path, host_id,\n" +
      "                 build) on stdout. Without it, stdout is ONLY the agent name.\n" +
      "  --help         Show this message.\n\n" +
      "Token: $RELAY_AGENT_TOKEN → the per-instance vault (validated locally first). A local relay is reached\n" +
      "only through its owner door. Exit 2 on a local refusal (nothing sent), 1 when the relay refuses.\n",
  );
}

export async function run(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`relay whoami: ${err instanceof Error ? err.message : String(err)}\n\n`);
    usage();
    return 1;
  }
  if (args.help) {
    usage(true);
    return 0;
  }
  const agent = args.agent || process.env.RELAY_AGENT_NAME || null;
  if (!agent && !process.env.RELAY_AGENT_TOKEN) {
    process.stderr.write("relay whoami: no identity — pass --agent NAME, set RELAY_AGENT_NAME, or set RELAY_AGENT_TOKEN\n");
    return 1;
  }

  let host = "127.0.0.1";
  let port = 3777;
  try {
    const { loadConfig } = await import("../config.js");
    const cfg = loadConfig();
    host = cfg.http_host || host;
    port = cfg.http_port || port;
  } catch {
    host = process.env.RELAY_HTTP_HOST || host;
    port = process.env.RELAY_HTTP_PORT ? parseInt(process.env.RELAY_HTTP_PORT, 10) : port;
  }
  const { routeFor, unresolvedMessage, localTool, toolJson, remotePost, remoteSecret, mcpResultOf } = await import("./relay-client.js");
  const route = await routeFor(host, port);
  if (route.kind === "unresolved") {
    process.stderr.write(`relay whoami: ${unresolvedMessage(route)}\n`);
    return 2;
  }
  const { resolveCliAgentToken } = await import("./agent-token.js");
  // With only RELAY_AGENT_TOKEN set (no name), the token alone is presented; the vault is never read without a name.
  const resolved = agent ? await resolveCliAgentToken("whoami", agent, route) : { token: process.env.RELAY_AGENT_TOKEN as string };
  if ("code" in resolved) return resolved.code;

  let envelope: Record<string, unknown> | null;
  try {
    if (route.kind === "remote") {
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Agent-Token": resolved.token };
      const secret = await remoteSecret(route.host, route.port, "http");
      if (secret) headers["Authorization"] = `Bearer ${secret}`;
      const r = await remotePost(route, "/mcp", headers, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }));
      const result = mcpResultOf(r.text);
      envelope = result ? toolJson(result) : null;
    } else {
      envelope = toolJson(await localTool("whoami", {}, { agentToken: resolved.token }, agent ? { agentName: agent } : {}));
    }
  } catch (err) {
    process.stderr.write(`relay whoami: could not reach the daemon at ${host}:${port} — is it running? (${err instanceof Error ? err.message : String(err)})\n`);
    return 2;
  }
  if (envelope === null) {
    process.stderr.write("relay whoami: the relay returned an unparseable tool result\n");
    return 1;
  }
  if (envelope.success !== true || typeof envelope.agent_name !== "string") {
    process.stderr.write(`relay whoami: ${typeof envelope.error === "string" ? envelope.error : "the relay refused"}\n`);
    return 1;
  }
  if (args.agent && envelope.agent_name !== args.agent) {
    process.stderr.write(`relay whoami: the token belongs to "${envelope.agent_name}", not "${args.agent}"\n`);
    return 1;
  }
  if (args.json) {
    process.stdout.write(JSON.stringify(envelope) + "\n");
    return 0;
  }
  process.stderr.write(`✓ this token is agent "${envelope.agent_name}" (instance ${String(envelope.instance_id ?? "-")})\n`);
  process.stdout.write(`${envelope.agent_name}\n`);
  return 0;
}
